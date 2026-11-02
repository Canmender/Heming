"use strict";
/**
 * 本机密钥信封桥（d.36 · P0-5；d.58 起异步优先）。
 *
 * 职责：用 Electron `safeStorage`（Windows DPAPI / macOS 钥匙串 / 系统密钥环）
 * 给 web 端的低频键做加解密，典型是这三个：
 *   heming.llmConfigs / heming.mcp.servers.v1 / heming.e2e.identity
 *
 * 红线：只做加解密。**不引入任何网络能力**，也不写文件——密文由渲染层写回
 * 原 localStorage 键位（就地信封），主进程不保存第二份。
 * 测试会从源码的 require 列表结构性断言这一点。
 *
 * ## 为什么有异步与同步两套（d.58）
 *
 * Electron 45 起 `isEncryptionAvailable()` / `encryptString()` / `decryptString()`
 * 三个**同步**方法已标记弃用（上游随 Chromium 删掉同步 OSCrypt 后端），46 将移除；
 * 替代品是 `isAsyncEncryptionAvailable()` / `encryptStringAsync()` / `decryptStringAsync()`
 * （注意异步 decrypt 返回的是 `{result, shouldReEncrypt}` 对象，不是裸字符串——
 * 少解构一层会静默拿到 undefined）。
 *
 * 迁移策略是**异步优先 + 同步兜底，一层一层切**（d.58 起步，d.59 收口）：
 * - 新增异步通道 `secret:availableAsync` / `secret:encryptAsync` / `secret:decryptAsync`
 *   与**批量通道** `secret:bootstrap`（一次 IPC 处理多个键，启动预取用）；
 * - d.59 起**默认走异步**：渲染层写路径异步优先（失败才明文），E2E 热路径（chains/msgCache）
 *   走「批量解密预取 + 内存视图 + 异步落盘」；同步三件套只在
 *   「旧版 Electron / 没有异步 API」时兜底，Electron 45 上仍可回退；
 * - `secret:capabilities` 告诉渲染层这套 Electron 还有没有同步 API；
 * - d.59 新增通用批量通道 `secret:decryptMany` / `secret:encryptMany`：E2E 冷启动要一次解
 *   几十到几百条（chains 整值 / msgCache 逐条），逐条 IPC 会把启动拖垮。能力边界与单条异步
 *   API 相同（本来就能解任意密文），只是打包，不放大能力。
 *
 * 回退路径（Electron 46 前必须完成）：渲染层 `hydrateSecureStorage()` 接到应用启动
 * （`main.tsx` 一行）+ 三个消费 store 在 hydrate 后重新 setState。本轮把异步通路、
 * 预取缓存与清理逻辑做完，切换点留给下一次范围更大的改动（文档里写明了清单）。
 */

const ENVELOPE_VERSION = "v1";

/** 批量通道单次最多处理多少个键（启动预取固定 3 个；留一点余量但绝不无限）。 */
const BOOTSTRAP_MAX_ENTRIES = 8;
/** 通用批量加解密（E2E 热路径预取/异步落盘）单次最多多少条。 */
const BATCH_MAX_ITEMS = 256;
/** 单次批量操作的总字符上限（防止渲染层一次塞进几 MB 把主进程卡住）。 */
const BATCH_MAX_CHARS = 2 * 1024 * 1024;
/** 单个密文/明文长度上限：密钥与配置 JSON 远小于此，超限一律拒绝（不信任渲染层）。 */
const MAX_SECRET_CHARS = 512 * 1024;
/** 批量通道总长度上限。 */
const MAX_BOOTSTRAP_CHARS = 2 * 1024 * 1024;

/**
 * 批量通道的**键白名单**（Lead 定稿：只认三个固定低频键）。
 *
 * 为什么必须是白名单而不是「任何键」：批量解密是「把密文交给主进程换明文」的通道，
 * 一旦允许任意键，就等于给渲染层（及其上跑的模型输出）开了一个可枚举的解密 API——
 * 它可以把 localStorage 里任意信封塞进来试解。固定三个键让这个通道的能力**只有三个**。
 * 其它信封键（chains / msgCache 等）一律不走批量通道，由各自的热路径单独解密。
 */
const BOOTSTRAP_ALLOWED_KEYS = Object.freeze([
  "heming.llmConfigs",
  "heming.mcp.servers.v1",
  "heming.e2e.identity",
]);
const BOOTSTRAP_ALLOWED_SET = new Set(BOOTSTRAP_ALLOWED_KEYS);

/** 取 safeStorage；测试可注入，避免纯 node 环境加载 electron。 */
function defaultSafeStorage() {
  try {
    return require("electron").safeStorage;
  } catch {
    return null;
  }
}

/** 是否存在异步三件套（Electron 45+）。 */
function hasAsyncApi(safeStorage) {
  return (
    !!safeStorage &&
    typeof safeStorage.isAsyncEncryptionAvailable === "function" &&
    typeof safeStorage.encryptStringAsync === "function" &&
    typeof safeStorage.decryptStringAsync === "function"
  );
}

/** 是否存在（已弃用的）同步三件套。 */
function hasSyncApi(safeStorage) {
  return (
    !!safeStorage &&
    typeof safeStorage.isEncryptionAvailable === "function" &&
    typeof safeStorage.encryptString === "function" &&
    typeof safeStorage.decryptString === "function"
  );
}

/**
 * 当前可用的加解密口径：`"async"`（首选）/ `"sync"`（旧版 Electron 兜底）/ `null`（不可用）。
 *
 * 注意：`"async"` 只说明**方法存在**，是否真的能加密由 `isAvailableAsync()` 回答
 * （Linux 无 keyring 等情况方法在但不可用）。
 */
function cryptoMode(safeStorage = defaultSafeStorage()) {
  if (hasAsyncApi(safeStorage)) return "async";
  if (hasSyncApi(safeStorage)) return "sync";
  return null;
}

/* ─────────────────────────── 同步三件套（已迁移；仅旧版 Electron 兜底） ─────────────────────────── */

/**
 * 同步可用性。
 *
 * ★ d.59 起：**默认走异步**；同步三件套只在「旧版 Electron / 没有异步 API」时兜底。
 * Electron 46 起这三件套会被上游移除，`hasSyncApi` 为 false，这里恒返回 false。
 */
function isAvailable(safeStorage = defaultSafeStorage()) {
  try {
    if (!hasSyncApi(safeStorage)) return false;
    return safeStorage.isEncryptionAvailable() === true;
  } catch {
    return false; // Linux 无 keyring / 系统策略禁用：降级为「不可用」，不抛
  }
}

/** 同步加密为 base64 密文；不可用或失败返回 null（调用方保留明文，绝不丢配置）。 */
function encrypt(plain, safeStorage = defaultSafeStorage()) {
  if (typeof plain !== "string" || !plain) return null;
  if (!isAvailable(safeStorage)) return null;
  try {
    return safeStorage.encryptString(plain).toString("base64");
  } catch {
    return null;
  }
}

/** 同步解密；不可用或失败返回 null。 */
function decrypt(cipherB64, safeStorage = defaultSafeStorage()) {
  if (typeof cipherB64 !== "string" || !cipherB64) return null;
  if (!isAvailable(safeStorage)) return null;
  try {
    const buf = Buffer.from(cipherB64, "base64");
    if (!buf.length) return null;
    return safeStorage.decryptString(buf);
  } catch {
    return null;
  }
}

/* ─────────────────────────── 异步三件套（首选） ─────────────────────────── */

/**
 * 异步可用性。
 *
 * 没有异步 API 的旧版 Electron 退回同步值（用 `Promise.resolve` 包装）：
 * 调用方永远拿到 Promise，不必根据版本分支。
 */
async function isAvailableAsync(safeStorage = defaultSafeStorage()) {
  if (hasAsyncApi(safeStorage)) {
    try {
      return (await safeStorage.isAsyncEncryptionAvailable()) === true;
    } catch {
      return false;
    }
  }
  return isAvailable(safeStorage);
}

/** 异步加密为 base64 密文；不可用或失败返回 null（绝不让调用方拿到半份密文）。 */
async function encryptAsync(plain, safeStorage = defaultSafeStorage()) {
  if (typeof plain !== "string" || !plain) return null;
  if (hasAsyncApi(safeStorage)) {
    try {
      if (!(await safeStorage.isAsyncEncryptionAvailable())) return null;
      return (await safeStorage.encryptStringAsync(plain)).toString("base64");
    } catch {
      return null;
    }
  }
  return encrypt(plain, safeStorage);
}

/** 异步解密；不可用或失败返回 null。★ 异步版返回 `{result}` 对象，必须解构。 */
async function decryptAsync(cipherB64, safeStorage = defaultSafeStorage()) {
  if (typeof cipherB64 !== "string" || !cipherB64) return null;
  if (hasAsyncApi(safeStorage)) {
    try {
      if (!(await safeStorage.isAsyncEncryptionAvailable())) return null;
      const buf = Buffer.from(cipherB64, "base64");
      if (!buf.length) return null;
      const decoded = await safeStorage.decryptStringAsync(buf);
      // 兼容两种返回形状：新版本是 {result}，防御性地允许未来变成裸字符串。
      const value = decoded && typeof decoded === "object" ? decoded.result : decoded;
      return typeof value === "string" ? value : null;
    } catch {
      return null;
    }
  }
  return decrypt(cipherB64, safeStorage);
}

/* ─────────────────────────── 通用批量通道（E2E 热路径） ─────────────────────────── */

/**
 * 批量解密（顺序敏感：返回值与入参同长同序，失败位置为 null）。
 *
 * 用途：E2E 的 chains / msgCache 是**整值信封/逐条密文**，冷启动一次要解几十到几百条；
 * 逐条 IPC 会把启动拖垮，所以给一条批量通道。能力边界与单条 `decryptAsync` 相同
 *（它本来就能解任意密文），这里只是打包，不放大能力。
 */
async function decryptMany(items, safeStorage = defaultSafeStorage()) {
  if (!Array.isArray(items)) return [];
  const normalized = items
    .slice(0, BATCH_MAX_ITEMS)
    .map((item) => (typeof item === "string" && item.length <= MAX_SECRET_CHARS ? item : null));
  const total = normalized.reduce((sum, item) => sum + (item ? item.length : 0), 0);
  if (total > BATCH_MAX_CHARS) return normalized.map(() => null);
  const out = [];
  for (const item of normalized) {
    out.push(item ? await decryptAsync(item, safeStorage) : null);
  }
  return out;
}

/** 批量加密（顺序敏感；失败位置为 null，调用方按 fail-open 保留明文）。 */
async function encryptMany(items, safeStorage = defaultSafeStorage()) {
  if (!Array.isArray(items)) return [];
  const normalized = items
    .slice(0, BATCH_MAX_ITEMS)
    .map((item) => (typeof item === "string" && item && item.length <= MAX_SECRET_CHARS ? item : null));
  const total = normalized.reduce((sum, item) => sum + (item ? item.length : 0), 0);
  if (total > BATCH_MAX_CHARS) return normalized.map(() => null);
  const out = [];
  for (const item of normalized) {
    out.push(item ? await encryptAsync(item, safeStorage) : null);
  }
  return out;
}

/* ─────────────────────────── 批量通道（启动预取） ─────────────────────────── */

/**
 * 校验一条批量条目；非法或键不在白名单返回 null。
 *
 * 白名单之外一律丢弃（不是报错重试）：渲染层传了不该传的键，说明调用方写错了，
 * 静默丢弃 + `plaintexts` 里不出现该键，比抛出更不容易把启动链拖垮；
 * 而「不返回任何密文/明文」本身已经保证了能力边界。
 */
function normalizeBootstrapEntry(raw) {
  if (!raw || typeof raw !== "object" || Array.isArray(raw)) return null;
  const key = typeof raw.key === "string" ? raw.key.trim() : "";
  const data = typeof raw.data === "string" ? raw.data : "";
  if (!key || key.length > 200) return null;
  if (!BOOTSTRAP_ALLOWED_SET.has(key)) return null; // 白名单之外一律拒绝
  if (!data || data.length > MAX_SECRET_CHARS) return null;
  return { key, data };
}

/**
 * 批量解密（一次 IPC 处理多个键，启动预取用）。
 *
 * 返回 `{ available, plaintexts: [{ key, value }] }`：解不开的 `value` 为 null，
 * 由渲染层按「不可解」处理（不能当空字符串，也不能当成明文）。
 */
async function bootstrapSecrets(entries, safeStorage = defaultSafeStorage()) {
  const available = await isAvailableAsync(safeStorage);
  if (!available || !Array.isArray(entries)) {
    return { available, mode: cryptoMode(safeStorage), plaintexts: [] };
  }
  const normalized = entries
    .slice(0, BOOTSTRAP_MAX_ENTRIES)
    .map(normalizeBootstrapEntry)
    .filter(Boolean);
  const total = normalized.reduce((sum, entry) => sum + entry.data.length, 0);
  if (total > MAX_BOOTSTRAP_CHARS) return { available, mode: cryptoMode(safeStorage), plaintexts: [] };
  const plaintexts = [];
  for (const entry of normalized) {
    plaintexts.push({ key: entry.key, value: await decryptAsync(entry.data, safeStorage) });
  }
  return { available, mode: cryptoMode(safeStorage), plaintexts };
}

/** 注册 IPC：异步通道（默认）+ 批量通道 + 能力探测；同步通道仅旧版 Electron 兜底。 */
function registerSecretIpc(ipcMain, safeStorage = defaultSafeStorage()) {
  // —— 同步通道（已迁移：默认异步；仅「旧版 Electron / 无异步 API」兜底，46 起上游移除）——
  ipcMain.on("secret:available", (event) => {
    event.returnValue = isAvailable(safeStorage);
  });
  ipcMain.on("secret:encrypt", (event, plain) => {
    event.returnValue = encrypt(plain, safeStorage);
  });
  ipcMain.on("secret:decrypt", (event, cipherB64) => {
    event.returnValue = decrypt(cipherB64, safeStorage);
  });

  /** 能力探测（同步、无副作用）：preload 用它决定「预取缓存 + 同步兜底」还是「纯异步」。 */
  ipcMain.on("secret:capabilities", (event) => {
    event.returnValue = { mode: cryptoMode(safeStorage), sync: hasSyncApi(safeStorage), async: hasAsyncApi(safeStorage) };
  });

  // —— 异步通道（首选）——
  ipcMain.handle("secret:availableAsync", async () => isAvailableAsync(safeStorage));
  ipcMain.handle("secret:encryptAsync", async (_event, plain) => {
    if (typeof plain !== "string" || plain.length > MAX_SECRET_CHARS) return null;
    return encryptAsync(plain, safeStorage);
  });
  ipcMain.handle("secret:decryptAsync", async (_event, cipherB64) => {
    if (typeof cipherB64 !== "string" || cipherB64.length > MAX_SECRET_CHARS) return null;
    return decryptAsync(cipherB64, safeStorage);
  });
  /** 批量：启动预取三个低频键（一次 IPC 换三条解密）。 */
  ipcMain.handle("secret:bootstrap", async (_event, payload) => {
    const entries = payload && typeof payload === "object" ? payload.entries : undefined;
    return bootstrapSecrets(entries, safeStorage);
  });
  /** 通用批量：E2E 热路径（chains/msgCache 整值/逐条密文）的预取与异步落盘。 */
  ipcMain.handle("secret:decryptMany", async (_event, items) => decryptMany(items, safeStorage));
  ipcMain.handle("secret:encryptMany", async (_event, items) => encryptMany(items, safeStorage));
}

module.exports = {
  ENVELOPE_VERSION,
  BOOTSTRAP_ALLOWED_KEYS,
  cryptoMode,
  isAvailable,
  encrypt,
  decrypt,
  isAvailableAsync,
  encryptAsync,
  decryptAsync,
  decryptMany,
  encryptMany,
  bootstrapSecrets,
  registerSecretIpc,
  BOOTSTRAP_MAX_ENTRIES,
  BATCH_MAX_ITEMS,
  MAX_SECRET_CHARS,
};
