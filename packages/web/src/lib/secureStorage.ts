/**
 * 本机密钥信封（d.36 · P0-5；d.58 起异步优先 + 启动预取缓存）。
 *
 * 桌面端把三把钥匙（模型 Key、MCP 请求头、E2E 设备身份等**低频键**）改成**就地信封**：
 * 密文仍写原键位，只是值变成 `{"__hemingEnc":"v1","data":"<base64>"}`；
 * 加解密在主进程 `safeStorage` 里完成，渲染层只经 preload 的桥传字节。
 *
 * ## d.58 的双轨口径（为什么不是纯异步）
 *
 * Electron 45 起 `safeStorage` 的**同步**三件套弃用、46 移除；但三个低频键在渲染层是
 * **模块初始化时同步读**（`store/llm.ts` 的 `loadProfiles()`、`lib/mcp/store.ts` 的
 * 默认存储、`e2eSession` 的 identity），消费方改造不在本轮范围。所以：
 *
 * - **异步优先**：`preload` 在页面脚本前用批量通道（`secret:bootstrap`）预取三个白名单键的
 *   明文进缓存；`hydrateSecureStorage()` 等预取完成后，读路径命中的是缓存（零 IPC）；
 * - **缓存只加速、不承担正确性**：缓存未命中时回退旧同步桥（Electron 45 可用）；
 *   纯异步环境下未命中则由异步补取填充（消费方需由启动门禁保证已 hydrate）；
 * - 写入：先更新缓存（保证「写后立即读」一致），再落盘——同步桥可用时照旧同步写，
 *   否则走异步加密队列（纯异步环境）。
 *
 * ## P0-5b P3 清理
 *
 * `cleanupPlaintextBackups()`：迁移期明文备份键保留一个完整版本后清理——
 * **幂等**（版本标记）、**清理前用新密文自解密校验**、**绝不删 `.__heming_undecryptable`**。
 *
 * 浏览器端（无桥）保持今天的明文形态：那个 origin 没有系统安全存储可用，
 * 明说比假装加密更诚实。
 */
import type { StorageLike } from "./memory/types.js";

export const ENVELOPE_MARK = "__hemingEnc";
export const ENVELOPE_VERSION = "v1";
/** 解不开的旧密文备份键后缀：内容为**原密文**，不重新加密。 */
export const UNDECRYPTABLE_BACKUP_SUFFIX = ".__heming_undecryptable";
/**
 * 迁移期明文备份键后缀（P0-5b Q3 拍板：保留一个完整版本、幂等、不二次备份，P3 清理）。
 * 在第一次把某键的**明文旧值**改写成信封/容器之前，把旧明文原样写到这个键上。
 */
export const PLAINTEXT_BACKUP_SUFFIX = ".__heming_plaintext_backup";

/**
 * 启动预取白名单：三个低频键（与 `packages/desktop/secret-store.js` 的
 * `BOOTSTRAP_ALLOWED_KEYS`、`preload.js` 的 `SECRET_BOOTSTRAP_KEYS` 保持一致）。
 * 批量解密通道在主进程侧只认这三个键——多一个都不行，这是能力边界。
 */
export const SECRET_BOOTSTRAP_KEYS = Object.freeze([
  "heming.llmConfigs",
  "heming.mcp.servers.v1",
  "heming.e2e.identity",
]);
const SECRET_BOOTSTRAP_SET = new Set(SECRET_BOOTSTRAP_KEYS);

/** 明文备份清理的版本标记键（幂等：同一版本只清理一次）。 */
export const BACKUP_CLEANUP_MARKER_KEY = "heming.secure.backupCleanup.v1";
/** 清理策略版本：改了清理判据就 +1，让老标记失效。 */
export const BACKUP_CLEANUP_VERSION = 1;
/** 单次清理最多扫多少个备份键（防止 localStorage 被别人塞满时卡住启动）。 */
export const BACKUP_CLEANUP_MAX_SCAN = 500;
/** 校验 msgCache 容器「新密文可解」时最多验多少条（其余按「不确定」保留备份）。 */
const CONTAINER_VERIFY_MAX = 200;

export interface SecretBridge {
  available: boolean;
  encrypt(plain: string): string | null;
  decrypt(cipherB64: string): string | null;
  /** 加解密口径（d.58）：`"async"` / `"sync"` / `null`。 */
  mode?: "async" | "sync" | null;
  /** 异步三件套是否可用。 */
  asyncAvailable?: boolean;
  /** 启动预取完成信号（永不 reject）。 */
  ready?: Promise<{ available: boolean; mode?: string | null; hydrated: boolean }>;
  /** 同步读预取缓存：命中返回明文（解不开为 null），未命中 undefined。 */
  cachedRead?: (key: string) => string | null | undefined;
  /** 写盘后刷新缓存。 */
  cacheSet?: (key: string, plain: string) => void;
  /** 失效缓存。 */
  cacheDelete?: (key: string) => void;
  /** 批量解密（白名单三键）。 */
  bootstrap?: (payload: {
    entries: Array<{ key: string; data: string }>;
  }) => Promise<{
    available: boolean;
    mode?: string | null;
    plaintexts: Array<{ key: string; value: string | null }>;
  }>;
  availableAsync?: () => Promise<boolean>;
  encryptAsync?: (plain: string) => Promise<string | null>;
  decryptAsync?: (cipherB64: string) => Promise<string | null>;
}

export interface SecureStorageStatus {
  /** 是否存在桌面桥（桌面端恒 true；浏览器 false）。 */
  desktop: boolean;
  /** 桌面桥是否报告系统安全存储可用。 */
  available: boolean;
  /** 加密失败或不可用而落成明文的键（降级是可见的，不是静默的）。 */
  plaintextKeys: string[];
  /** 解不开的信封键：密文仍在磁盘，只是本机解不了（另一台设备/另一个系统账户）。 */
  undecryptableKeys: string[];
  /** 旧密文曾解不开、已被原样备份的键（备份键 = 原键 + UNDECRYPTABLE_BACKUP_SUFFIX）。 */
  backedUpKeys: string[];
}

const plaintextKeys = new Set<string>();
const undecryptableKeys = new Set<string>();
const backedUpKeys = new Set<string>();

/** 启动预取 / hydrate 的状态（异步，永不 reject）。 */
export interface SecureHydration {
  /** hydrate 是否已跑完（跑完后缓存即热、P3 清理已尝试）。 */
  done: boolean;
  /** preload 预取是否真的注入了缓存（false = 只能走同步兜底/异步补取）。 */
  hydrated: boolean;
  /** 系统安全存储是否可用（以预取结果为准；无桥为 false）。 */
  available: boolean;
  /** 加解密口径：`"async"`（首选）/ `"sync"`（旧版兜底）/ `null`（不可用）。 */
  mode?: "async" | "sync" | null;
  /** P3 清理结果（未跑则为 undefined）。 */
  cleanup?: BackupCleanupResult;
}

let hydrationState: SecureHydration = { done: false, hydrated: false, available: false };
let hydrationPromise: Promise<SecureHydration> | null = null;
const hydratedSubscribers = new Set<(state: SecureHydration) => void>();
/** 异步补取中的键：同一键并发读只发一个 IPC。 */
const asyncFillInFlight = new Set<string>();
/** storage 事件监听只装一次。 */
let storageInvalidationInstalled = false;

function bridge(): SecretBridge | undefined {
  if (typeof window === "undefined") return undefined;
  const b = window.__heming_secrets;
  if (!b || typeof b.encrypt !== "function" || typeof b.decrypt !== "function") return undefined;
  return b;
}

/** 旧同步桥可用（Electron 45；46 起 `available` 会变 false）。 */
function canSyncCrypto(b: SecretBridge | undefined): boolean {
  return !!b && b.available === true && typeof b.encrypt === "function" && typeof b.decrypt === "function";
}

/** 异步桥可用（Electron 45+，且 preload 报告了异步能力）。 */
function canAsyncCrypto(b: SecretBridge | undefined): boolean {
  return (
    !!b &&
    b.asyncAvailable === true &&
    typeof b.encryptAsync === "function" &&
    typeof b.decryptAsync === "function"
  );
}

/** 安全存储是否可用：同步桥优先，其次「已 hydrate 且预取报告可用」。 */
function effectiveAvailable(b: SecretBridge | undefined = bridge()): boolean {
  if (!b) return false;
  if (b.available === true) return true;
  return hydrationState.done && hydrationState.available === true;
}

/** 后台异步补解密（纯异步环境缓存未命中时用）：失败才标「解不开」。 */
function scheduleAsyncFill(key: string, data: string): void {
  const b = bridge();
  if (!b || typeof b.decryptAsync !== "function") return;
  if (asyncFillInFlight.has(key)) return;
  asyncFillInFlight.add(key);
  void b
    .decryptAsync(data)
    .then((plain) => {
      asyncFillInFlight.delete(key);
      if (typeof plain !== "string") {
        undecryptableKeys.add(key);
        return;
      }
      b.cacheSet?.(key, plain);
      undecryptableKeys.delete(key);
      plaintextKeys.delete(key);
    })
    .catch(() => {
      asyncFillInFlight.delete(key);
      undecryptableKeys.add(key);
    });
}

/** 后台异步加密落盘（纯异步环境写路径）：失败退回明文，绝不丢配置。 */
async function writeEnvelopeAsync(
  key: string,
  value: string,
  base: StorageLike,
  b: SecretBridge,
): Promise<void> {
  try {
    const cipher = typeof b.encryptAsync === "function" ? await b.encryptAsync(value) : null;
    if (!cipher) {
      plaintextKeys.add(key);
      base.setItem(key, value);
      return;
    }
    base.setItem(key, envelopeOf(cipher));
    plaintextKeys.delete(key);
    undecryptableKeys.delete(key);
    b.cacheSet?.(key, value);
  } catch {
    // 配额/加密失败：明文兜底（比丢配置好），并如实标记未加密
    plaintextKeys.add(key);
    try {
      base.setItem(key, value);
    } catch {
      /* 明文也写不进：内存态由调用方保留 */
    }
  }
}

/**
 * 装 storage 事件监听：别的窗口改了这三个低频键（或它们的备份）→ 失效本窗口预取缓存，
 * 下一次读自动回退同步桥拿最新值。
 *
 * 为什么失效而不是异步刷新：同步读的调用方拿不到 await 的机会，
 * 「缓存里保留旧值」比「回退到每次都读盘」更容易让用户困惑（改完 Key 不生效）。
 */
function installStorageInvalidation(): void {
  if (storageInvalidationInstalled || typeof window === "undefined") return;
  storageInvalidationInstalled = true;
  try {
    window.addEventListener("storage", (event) => {
      const key = event.key;
      if (typeof key !== "string" || !key) return;
      if (!SECRET_BOOTSTRAP_SET.has(key) && !key.endsWith(PLAINTEXT_BACKUP_SUFFIX)) return;
      bridge()?.cacheDelete?.(key);
    });
  } catch {
    /* 极端环境没有 addEventListener：退化为「缓存不主动失效」 */
  }
}

export function hasSecureBridge(): boolean {
  return bridge() !== undefined;
}

export function secureStorageAvailable(): boolean {
  return effectiveAvailable();
}

/** 当前 hydrate 状态快照（供设置区/诊断用；不改变既有状态卡文案）。 */
export function secureHydrationSnapshot(): SecureHydration {
  return { ...hydrationState };
}

/** localStorage 安全适配：访问/写入本身都可能抛（配额、隐私模式）。 */
function browserStorage(): StorageLike {
  return {
    getItem: (k) => {
      try {
        return localStorage.getItem(k);
      } catch {
        return null;
      }
    },
    setItem: (k, v) => {
      localStorage.setItem(k, v); // 异常交给 secureGetItem/secureSetItem 处理
    },
    removeItem: (k) => {
      try {
        localStorage.removeItem(k);
      } catch {
        /* 同上 */
      }
    },
  };
}

type StoredShape =
  | { kind: "plain" }
  | { kind: "envelope"; data: string }
  | { kind: "bad-envelope" };

/**
 * 判定存的是明文还是信封。
 *
 * `__hemingEnc` 存在但版本不认识/数据不合法 → bad-envelope：**不能**当明文再包一层，
 * 否则会把「未来版本的信封」加密成「当前版本的密文」，等升级回来也解不开了。
 */
function parseStored(raw: string): StoredShape {
  if (!raw.startsWith("{")) return { kind: "plain" };
  let parsed: unknown;
  try {
    parsed = JSON.parse(raw);
  } catch {
    return { kind: "plain" };
  }
  if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) return { kind: "plain" };
  const record = parsed as Record<string, unknown>;
  if (!(ENVELOPE_MARK in record)) return { kind: "plain" };
  if (record[ENVELOPE_MARK] !== ENVELOPE_VERSION) return { kind: "bad-envelope" };
  if (typeof record.data !== "string" || !record.data) return { kind: "bad-envelope" };
  return { kind: "envelope", data: record.data };
}

function envelopeOf(cipherB64: string): string {
  return JSON.stringify({ [ENVELOPE_MARK]: ENVELOPE_VERSION, data: cipherB64 });
}

export function secureGetItem(key: string, base: StorageLike = browserStorage()): string | null {
  let raw: string | null;
  try {
    raw = base.getItem(key);
  } catch {
    return null;
  }
  if (raw === null) return null;

  const shape = parseStored(raw);
  if (shape.kind === "bad-envelope") {
    undecryptableKeys.add(key);
    return null;
  }
  if (shape.kind === "envelope") {
    const b = bridge();
    if (!b) {
      undecryptableKeys.add(key);
      return null;
    }
    /*
     * 读优先级（d.58）：
     * 1. **预取缓存**（同步、零 IPC）——日常路径；
     * 2. 旧同步桥（Electron 45 兜底）——缓存未命中时；
     * 3. 纯异步环境的异步补取——本次同步读拿不到值（返回 null），
     *    由启动门禁（`hydrateSecureStorage`）保证日常不会走到这一步。
     */
    const cached = b.cachedRead?.(key);
    if (cached === undefined) {
      if (canSyncCrypto(b)) {
        const plain = b.decrypt(shape.data);
        if (plain === null) {
          undecryptableKeys.add(key);
          return null;
        }
        b.cacheSet?.(key, plain);
        undecryptableKeys.delete(key);
        plaintextKeys.delete(key);
        return plain;
      }
      scheduleAsyncFill(key, shape.data);
      undecryptableKeys.add(key);
      return null;
    }
    if (cached === null) {
      undecryptableKeys.add(key);
      return null;
    }
    undecryptableKeys.delete(key);
    plaintextKeys.delete(key); // 成功读到密文 ⇒ 不再是明文键
    return cached;
  }

  // 明文（旧数据）：桌面可用时就地懒迁移；失败保留明文，绝不丢配置。
  const b = bridge();
  if (b && canSyncCrypto(b)) {
    const cipher = b.encrypt(raw);
    if (cipher) {
      try {
        base.setItem(key, envelopeOf(cipher));
        plaintextKeys.delete(key);
        undecryptableKeys.delete(key);
        b.cacheSet?.(key, raw);
      } catch {
        plaintextKeys.add(key);
      }
    } else {
      plaintextKeys.add(key);
    }
  } else if (b && canAsyncCrypto(b) && effectiveAvailable(b)) {
    // 纯异步环境：后台迁移，本次仍返回明文（与旧行为一致：不阻塞读）。
    plaintextKeys.add(key);
    void (async () => {
      try {
        const cipher = typeof b.encryptAsync === "function" ? await b.encryptAsync(raw) : null;
        if (!cipher) return;
        base.setItem(key, envelopeOf(cipher));
        plaintextKeys.delete(key);
        undecryptableKeys.delete(key);
        b.cacheSet?.(key, raw);
      } catch {
        /* 迁移失败：明文原样保留，下一轮再试 */
      }
    })();
  } else if (b) {
    // 只读的明文也要进清单，否则降级不可见：启动时只读的键在磁盘上是明文，
    // 状态卡若漏报就会让用户以为它已被加密。
    plaintextKeys.add(key);
  }
  return raw;
}

/**
 * 覆盖「解不开的密文」之前先原样备份。
 *
 * 备份内容就是磁盘上的原始字符串（仍是密文），不重新加密——目标正是“换回原来的
 * 系统账户还能解开”。同一键只保留一份备份，内容相同不重写（幂等）。
 * 备份失败时保留 undecryptable 标记并继续写入：宁可状态多报一次，也不因备份失败卡死配置。
 */
function backupBeforeOverwrite(key: string, base: StorageLike): void {
  if (!undecryptableKeys.has(key)) return;
  let raw: string | null = null;
  try {
    raw = base.getItem(key);
  } catch {
    return;
  }
  if (!raw) return;
  const backupKey = key + UNDECRYPTABLE_BACKUP_SUFFIX;
  try {
    if (base.getItem(backupKey) !== raw) base.setItem(backupKey, raw);
  } catch {
    return; // 备份没成功：不动 undecryptable 标记
  }
  undecryptableKeys.delete(key);
  backedUpKeys.add(key);
}

export function secureSetItem(
  key: string,
  value: string,
  base: StorageLike = browserStorage(),
): void {
  backupBeforeOverwrite(key, base);
  const b = bridge();
  if (b && canSyncCrypto(b)) {
    const cipher = b.encrypt(value);
    if (cipher) {
      try {
        base.setItem(key, envelopeOf(cipher));
        plaintextKeys.delete(key);
        // 新值已覆盖旧信封，旧的「解不开」状态随之作废。
        undecryptableKeys.delete(key);
        // 写后立即读一致：同步桥写成功后刷新预取缓存。
        b.cacheSet?.(key, value);
        return;
      } catch {
        /* 配额：退回明文，至少这次会话的配置还在 */
      }
    }
    plaintextKeys.add(key);
  } else if (b && canAsyncCrypto(b) && effectiveAvailable(b)) {
    /*
     * 纯异步环境：先把新值写进缓存（本窗口「写后立即读」一致），再后台加密落盘。
     * 落盘失败退回明文（`writeEnvelopeAsync` 内部处理），绝不丢配置。
     */
    b.cacheSet?.(key, value);
    void writeEnvelopeAsync(key, value, base, b);
    return;
  } else if (b) {
    plaintextKeys.add(key); // 桌面桥在、系统安全存储不可用
  }
  try {
    base.setItem(key, value);
  } catch {
    // 明文也写不进去：至少不能谎报「已加密」
    plaintextKeys.add(key);
  }
}

export function secureRemoveItem(key: string, base: StorageLike = browserStorage()): void {
  plaintextKeys.delete(key);
  undecryptableKeys.delete(key);
  bridge()?.cacheDelete?.(key);
  base.removeItem(key);
}

// —— P0-5b：热路径键的 verified 写与详细读 ——

/** 原始桥（供热路径模块包装成自己的 encrypt/decrypt 能力；不可用时返回 undefined）。 */
export function secureBridge(): SecretBridge | undefined {
  return bridge();
}

/** 把某键记为「以明文落盘」（设置区「密钥存储」卡据此点名，Q1 要求的可见降级）。 */
export function markSecurePlaintext(key: string): void {
  plaintextKeys.add(key);
}

/** 把某键记为「密文仍在但本机解不开」（另一设备/另一系统账户/密文损坏）。 */
export function markSecureUndecryptable(key: string): void {
  undecryptableKeys.add(key);
}

/**
 * 原样备份某键的原始值到 `<key><suffix>`（幂等：备份键已存在就不覆盖，保留第一份）。
 *
 * @returns 备份键存在（本次写入或此前已写）为 true；写失败为 false——调用方据此
 *          决定「先备份、再迁移」，备份失败时**不覆盖旧值**（迁移非破坏性）。
 */
export function backupRawOnce(
  key: string,
  raw: string,
  suffix: string,
  base: StorageLike = browserStorage(),
): boolean {
  const backupKey = key + suffix;
  try {
    if (base.getItem(backupKey) !== null) return true;
    base.setItem(backupKey, raw);
    return true;
  } catch {
    return false;
  }
}

/** `readSecureValue` 的结果：四态，解不开与不存在严格区分（不能静默当空）。 */
export type SecureValueRead =
  | { kind: "absent" }
  | { kind: "plain"; raw: string }
  | { kind: "envelope"; value: string }
  | { kind: "unreadable"; reason: "bad-envelope" | "no-bridge" | "decrypt-failed" };

/**
 * 只读地读一个键（**不迁移、不写盘**），解不开时置 `undecryptableKeys`。
 *
 * 与 `secureGetItem` 的区别：读明文时不做懒迁移（热路径键要「先备份、再加密、再自校验」，
 * 迁移节奏由调用方控制），且解不开时返回**原因**而不是裸 null。
 */
export function readSecureValue(key: string, base: StorageLike = browserStorage()): SecureValueRead {
  let raw: string | null;
  try {
    raw = base.getItem(key);
  } catch {
    return { kind: "absent" };
  }
  if (raw === null) return { kind: "absent" };

  const shape = parseStored(raw);
  if (shape.kind === "bad-envelope") {
    undecryptableKeys.add(key);
    return { kind: "unreadable", reason: "bad-envelope" };
  }
  if (shape.kind === "envelope") {
    const b = bridge();
    if (!b || b.available !== true) {
      undecryptableKeys.add(key);
      return { kind: "unreadable", reason: "no-bridge" };
    }
    const value = b.decrypt(shape.data);
    if (value === null) {
      undecryptableKeys.add(key);
      return { kind: "unreadable", reason: "decrypt-failed" };
    }
    undecryptableKeys.delete(key);
    plaintextKeys.delete(key);
    return { kind: "envelope", value };
  }
  return { kind: "plain", raw };
}

/** 加密 + 立刻解密比对（chains 自校验的核心；纯逻辑，可单测，不碰 localStorage）。 */
export function encryptVerified(
  plain: string,
  crypto: { encrypt(value: string): string | null; decrypt(cipherB64: string): string | null },
): { cipher: string | null; reason?: "encrypt-failed" | "verify-failed" } {
  let cipher: string | null = null;
  try {
    cipher = crypto.encrypt(plain);
  } catch {
    cipher = null;
  }
  if (!cipher) return { cipher: null, reason: "encrypt-failed" };
  let roundTrip: string | null = null;
  try {
    roundTrip = crypto.decrypt(cipher);
  } catch {
    roundTrip = null;
  }
  // 逐 byte 相等（比 deep-equal 更强）：写进去的东西必须与写之前完全一致。
  if (roundTrip !== plain) return { cipher: null, reason: "verify-failed" };
  return { cipher };
}

/** 加密失败/写盘失败时的落盘形态与原因（调用方据此写可诊断日志与状态标记）。 */
export type SecureWriteReason =
  | "no-bridge"
  | "unavailable"
  | "encrypt-failed"
  | "verify-failed"
  | "backup-failed"
  | "quota";
export interface SecureWriteResult {
  ok: boolean;
  form: "envelope" | "plaintext" | "none";
  reason?: SecureWriteReason;
}

/** 迁移期明文备份：仅当磁盘上是**明文**且备份键不存在时写一次（幂等、不二次备份）。 */
function backupPlaintextOnce(key: string, base: StorageLike): boolean {
  let raw: string | null;
  try {
    raw = base.getItem(key);
  } catch {
    return true; // 读不到就谈不上备份：交给后续写盘路径判定
  }
  if (raw === null || raw === "") return true;
  if (parseStored(raw).kind !== "plain") return true; // 已是信封：没有明文可备份
  return backupRawOnce(key, raw, PLAINTEXT_BACKUP_SUFFIX, base);
}

/**
 * 写一个键，**加密后立刻解密自校验，通过才落信封**（P0-5b chains 路径）。
 *
 * 顺序（非破坏性，需求 3）：
 * 1. 旧密文解不开 → 先原样备份（d.36 既有行为，幂等）；
 * 2. 磁盘上是明文旧值 → 先写 `<键>.__heming_plaintext_backup`（幂等，只保留第一份）；
 * 3. 加密 → 解密 → 与入参逐 byte 比对；
 * 4. 通过才写信封；**不通过绝不写坏密文**，退回明文新值（fail-open，Q1）并标记「未加密」；
 * 5. 写盘异常（配额）→ 先试明文兜底（明文比 base64 信封小，常能挤进去）；
 *    仍失败则**不动旧值**，返回 `ok:false`（内存态由调用方保留）。
 *
 * 为什么自校验失败时写「新明文值」而不是回退旧盘值：chains 是**单调推进**的状态，
 * 回退会让下一条消息复用已用过的 msgKey（比明文降级危险得多）。
 */
export function secureSetItemVerified(
  key: string,
  value: string,
  base: StorageLike = browserStorage(),
): SecureWriteResult {
  backupBeforeOverwrite(key, base); // 步骤 1：解不开的旧密文原样备份
  if (!backupPlaintextOnce(key, base)) {
    // 步骤 2 失败：旧明文一个字节都不动，等下一轮再迁（迁移可重试）。
    return { ok: false, form: "none", reason: "backup-failed" };
  }

  const b = bridge();
  if (b && b.available === true) {
    const checked = encryptVerified(value, b);
    if (checked.cipher) {
      try {
        base.setItem(key, envelopeOf(checked.cipher));
        plaintextKeys.delete(key);
        undecryptableKeys.delete(key);
        return { ok: true, form: "envelope" };
      } catch {
        // 信封写失败（配额）：明文更小，试一次兜底；写成了也如实标记「未加密」。
        plaintextKeys.add(key);
        try {
          base.setItem(key, value);
          return { ok: true, form: "plaintext", reason: "quota" };
        } catch {
          return { ok: false, form: "none", reason: "quota" };
        }
      }
    }
    // 步骤 4：加密失败或自校验失败 → 不写坏密文，fail-open 写明文新值。
    plaintextKeys.add(key);
    try {
      base.setItem(key, value);
      return { ok: true, form: "plaintext", reason: checked.reason };
    } catch {
      return { ok: false, form: "none", reason: "quota" };
    }
  }

  // 无桥（浏览器）/ 桥报告不可用：保持明文（与今天一致），桥在时点名「未加密」。
  if (b) plaintextKeys.add(key);
  try {
    base.setItem(key, value);
    return { ok: true, form: "plaintext", reason: b ? "unavailable" : "no-bridge" };
  } catch {
    return { ok: false, form: "none", reason: "quota" };
  }
}

/**
 * 只对 `secureKey` 加密的 StorageLike 适配器。
 *
 * 用于那些「一个存储里混着凭据与非凭据」的模块：MCP 注册表把服务配置（含请求头
 * token）和工具清单/启用状态放在同一份存储里，只加密前者，避免无谓的 IPC。
 */
export function secureStorageFor(
  secureKey: string,
  base: StorageLike = browserStorage(),
): StorageLike {
  return {
    getItem: (k) => (k === secureKey ? secureGetItem(k, base) : base.getItem(k)),
    setItem: (k, v) => (k === secureKey ? secureSetItem(k, v, base) : base.setItem(k, v)),
    removeItem: (k) => (k === secureKey ? secureRemoveItem(k, base) : base.removeItem(k)),
  };
}

export function secureStorageStatus(): SecureStorageStatus {
  const b = bridge();
  return {
    desktop: !!b,
    // 「可用」按**实际能否加解密**判定：纯异步环境下 `b.available`（同步探测）会是 false，
    // 但异步通路可用、用户看到的仍是「已加密」——用有效可用性才不会误报降级。
    available: effectiveAvailable(b),
    plaintextKeys: [...plaintextKeys].sort(),
    undecryptableKeys: [...undecryptableKeys].sort(),
    backedUpKeys: [...backedUpKeys].sort(),
  };
}

/** 测试隔离：清掉进程内状态（不动 localStorage；已注册的 hydrate 订阅保留）。 */
export function resetSecureStorageState(): void {
  plaintextKeys.clear();
  undecryptableKeys.clear();
  backedUpKeys.clear();
  asyncFillInFlight.clear();
  hydrationState = { done: false, hydrated: false, available: false };
  hydrationPromise = null;
}

/* ─────────────────────── d.58 · 启动 hydrate（预取缓存 + P3 清理） ─────────────────────── */

/** 等一个 Promise，超时按失败处理（绝不让启动链被一个卡住的 IPC 拖死）。 */
function withTimeout<T>(input: Promise<T>, timeoutMs: number): Promise<T> {
  return new Promise<T>((resolve, reject) => {
    const timer = setTimeout(() => reject(new Error("timeout")), Math.max(1, timeoutMs));
    input.then(
      (value) => {
        clearTimeout(timer);
        resolve(value);
      },
      (error) => {
        clearTimeout(timer);
        reject(error);
      },
    );
  });
}

/** 当前应用版本（5 段）；拿不到时给 `dev`（开发/测试环境每次都允许跑一次清理）。 */
function currentAppVersion(): string {
  try {
    const v = typeof window !== "undefined" ? window.__heming_version : undefined;
    return typeof v === "string" && v.trim() ? v.trim() : "0.0.0-dev";
  } catch {
    return "0.0.0-dev";
  }
}

/** 枚举 localStorage 键（失败按空处理——隐私模式下清不了就下次再清）。 */
function listLocalStorageKeys(): string[] {
  try {
    const out: string[] = [];
    for (let i = 0; i < localStorage.length; i += 1) {
      const key = localStorage.key(i);
      if (key) out.push(key);
    }
    return out;
  } catch {
    return [];
  }
}

/** 清理时对某条密文做「能不能解开」的验证（同步桥优先，其次异步）。 */
async function decryptForVerify(cipherB64: string): Promise<string | null> {
  const b = bridge();
  if (!b) return null;
  if (canSyncCrypto(b)) {
    try {
      return b.decrypt(cipherB64);
    } catch {
      return null;
    }
  }
  if (typeof b.decryptAsync === "function") {
    try {
      return await b.decryptAsync(cipherB64);
    } catch {
      return null;
    }
  }
  return null;
}

/** 与 `lib/e2e/cacheEnvelope.ts` 的 `MSG_CACHE_MARK` / `MSG_CACHE_VERSION` 保持一致。 */
const MSG_CACHE_MARK = "__hemingMsgCache";
const MSG_CACHE_VERSION = "v2";

/**
 * 校验 msgCache 的 v2 容器「新密文可解」：全部条目都是密文且每条都能解开才算通过。
 *
 * 不做循环 import：`cacheEnvelope.ts` 依赖本模块的常量，这里反向 import 会成环，
 * 所以两处标记常量各自声明、由本注释互相指向（值相同，改一处必须改两处）。
 */
async function verifyMsgCacheContainer(raw: string): Promise<{ ok: boolean; reason: string }> {
  let parsed: unknown;
  try {
    parsed = JSON.parse(raw);
  } catch {
    return { ok: false, reason: "bad-data" };
  }
  if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) {
    return { ok: false, reason: "bad-data" };
  }
  const record = parsed as Record<string, unknown>;
  if (record[MSG_CACHE_MARK] !== MSG_CACHE_VERSION) return { ok: false, reason: "foreign-container" };
  const items = record.items;
  if (!Array.isArray(items)) return { ok: false, reason: "bad-data" };
  if (items.length > CONTAINER_VERIFY_MAX) return { ok: false, reason: "too-many-entries" };
  for (const item of items) {
    if (!item || typeof item !== "object") return { ok: false, reason: "bad-data" };
    const entry = item as Record<string, unknown>;
    if (typeof entry.d === "string" && entry.d) {
      const plain = await decryptForVerify(entry.d);
      if (plain === null) return { ok: false, reason: "undecryptable" };
    } else if (entry.m !== undefined) {
      return { ok: false, reason: "still-plain" };
    } else {
      return { ok: false, reason: "bad-data" };
    }
  }
  return { ok: true, reason: "ok" };
}

/** 主键是否已经是「可解的新形态」：信封能自解密，或 msgCache 容器全部条目可解。 */
async function verifyNewForm(raw: string): Promise<{ ok: boolean; reason: string }> {
  const shape = parseStored(raw);
  if (shape.kind === "bad-envelope") return { ok: false, reason: "bad-envelope" };
  if (shape.kind === "plain") {
    // msgCache 容器不是 `__hemingEnc` 信封（parseStored 会当成明文），单独识别。
    if (raw.includes(`"${MSG_CACHE_MARK}"`)) return verifyMsgCacheContainer(raw);
    return { ok: false, reason: "still-plain" };
  }
  const plain = await decryptForVerify(shape.data);
  return plain === null ? { ok: false, reason: "undecryptable" } : { ok: true, reason: "ok" };
}

export type BackupCleanupSkipReason = "already-clean" | "no-bridge" | "unavailable";

/** P3 清理结果（设置区/诊断可据此说明「还留了哪些备份、为什么」）。 */
export interface BackupCleanupResult {
  /** 本次是否真的执行（同版本已清过 / 没有可用桥时为 false）。 */
  ran: boolean;
  /** 执行时的应用版本（版本标记的一部分）。 */
  version: string;
  /** 扫到的明文备份键数量。 */
  scanned: number;
  /** 被删掉的备份键（主键）。 */
  deleted: string[];
  /** 保留的备份键与原因（主键缺失/仍明文/新密文解不开…）。 */
  kept: Array<{ key: string; reason: string }>;
  reason?: BackupCleanupSkipReason;
}

function backupCleanupSkip(reason: BackupCleanupSkipReason, version: string): BackupCleanupResult {
  return { ran: false, version, scanned: 0, deleted: [], kept: [], reason };
}

/**
 * P0-5b P3：清理**迁移期明文备份键**（`<键>.__heming_plaintext_backup`）。
 *
 * 安全序（Lead 定稿，顺序不可调换）：
 * 1. 只处理明文备份后缀；`.__heming_undecryptable`（唯一可恢复的旧密文）**永不删**；
 * 2. 先看主键当前形态：缺失 → 保留（备份是唯一副本）；仍是明文 → 保留（还没迁完）；
 * 3. 是信封/容器 → **先自解密校验**，全部能解才删备份；解不开就保留；
 * 4. 幂等：用「应用版本 + 清理策略版本」标记，同一版本只跑一次（`force` 可强跑，测试用）；
 * 5. 无桥 / 安全存储不可用 → 不跑也不写标记（等下一次可用时再清）。
 *
 * @param opts.keys 测试注入的键清单；缺省枚举 localStorage（有数量上限）。
 */
export async function cleanupPlaintextBackups(opts?: {
  base?: StorageLike;
  version?: string;
  force?: boolean;
  keys?: string[];
}): Promise<BackupCleanupResult> {
  const base = opts?.base ?? browserStorage();
  const version = opts?.version ?? currentAppVersion();
  const b = bridge();
  if (!b) return backupCleanupSkip("no-bridge", version);
  if (!effectiveAvailable(b)) return backupCleanupSkip("unavailable", version);

  // 1) 幂等：同一版本只跑一次（标记读坏/策略版本变过 = 当作没跑过）
  if (!opts?.force) {
    try {
      const raw = base.getItem(BACKUP_CLEANUP_MARKER_KEY);
      if (raw) {
        const marker = JSON.parse(raw) as { v?: unknown; version?: unknown };
        if (marker && marker.v === BACKUP_CLEANUP_VERSION && marker.version === version) {
          return backupCleanupSkip("already-clean", version);
        }
      }
    } catch {
      /* 标记坏了：当作没跑过，这次跑一遍 */
    }
  }

  const allKeys = opts?.keys ?? listLocalStorageKeys();
  const backupKeys = allKeys
    .filter((key) => typeof key === "string" && key.endsWith(PLAINTEXT_BACKUP_SUFFIX))
    .slice(0, BACKUP_CLEANUP_MAX_SCAN);

  const deleted: string[] = [];
  const kept: Array<{ key: string; reason: string }> = [];
  for (const backupKey of backupKeys) {
    const mainKey = backupKey.slice(0, -PLAINTEXT_BACKUP_SUFFIX.length);
    let raw: string | null = null;
    try {
      raw = base.getItem(mainKey);
    } catch {
      kept.push({ key: mainKey, reason: "read-failed" });
      continue;
    }
    if (raw === null || raw === "") {
      kept.push({ key: mainKey, reason: "main-missing" });
      continue;
    }
    const verdict = await verifyNewForm(raw);
    if (!verdict.ok) {
      kept.push({ key: mainKey, reason: verdict.reason });
      continue;
    }
    try {
      base.removeItem(backupKey);
      deleted.push(mainKey);
    } catch {
      kept.push({ key: mainKey, reason: "remove-failed" });
    }
  }

  // 2) 写版本标记（只标记「跑过」，不标记「清干净了」——保留项下个版本再试）
  try {
    base.setItem(
      BACKUP_CLEANUP_MARKER_KEY,
      JSON.stringify({ v: BACKUP_CLEANUP_VERSION, version, at: new Date().toISOString(), deleted: deleted.length }),
    );
  } catch {
    /* 配额/隐私模式：标记写不进去只影响幂等，不影响本次清理结果 */
  }

  return { ran: true, version, scanned: backupKeys.length, deleted, kept };
}

/**
 * 主动补一次批量预取（旧 preload 没有 `ready` 时的兜底；新 preload 自带预取）。
 *
 * 只认白名单三键，且只挑信封形态——明文/坏数据留给 `secureGetItem` 的既有逻辑。
 */
async function bootstrapNow(b: SecretBridge): Promise<{ available: boolean; hydrated: boolean; mode?: string | null }> {
  if (typeof b.bootstrap !== "function" || typeof window === "undefined") {
    return { available: b.available === true, hydrated: false };
  }
  const entries: Array<{ key: string; data: string }> = [];
  for (const key of SECRET_BOOTSTRAP_KEYS) {
    try {
      const raw = localStorage.getItem(key);
      if (!raw) continue;
      const parsed = JSON.parse(raw) as { data?: unknown };
      if (parsed && typeof parsed.data === "string" && parsed.data) entries.push({ key, data: parsed.data });
    } catch {
      /* 单键坏数据不影响其它键 */
    }
  }
  if (entries.length === 0) return { available: b.available === true, hydrated: true };
  try {
    const result = await b.bootstrap({ entries });
    for (const item of result.plaintexts) {
      if (item && typeof item.key === "string") {
        if (typeof item.value === "string") b.cacheSet?.(item.key, item.value);
      }
    }
    return { available: result.available === true, hydrated: true, mode: result.mode ?? b.mode ?? null };
  } catch {
    return { available: b.available === true, hydrated: false };
  }
}

/**
 * 启动 hydrate：等 preload 的批量预取完成 → 装 storage 失效监听 → 跑一次 P3 清理。
 *
 * **必须由应用启动点 await 后再渲染**（`main.tsx`，Baseline 接线）：这样缓存即热，
 * 「缓存未命中回退同步桥」只是极端兜底，而不是日常路径；否则 Electron 46 一来
 * 三个低频键的首次同步读会全部落到兜底上，等于没迁。单飞、永不 reject。
 */
export function hydrateSecureStorage(opts?: {
  skipCleanup?: boolean;
  base?: StorageLike;
  timeoutMs?: number;
}): Promise<SecureHydration> {
  if (hydrationPromise) return hydrationPromise;
  hydrationPromise = (async () => {
    installStorageInvalidation();
    const b = bridge();
    const finish = (state: SecureHydration): SecureHydration => {
      hydrationState = state;
      for (const subscriber of hydratedSubscribers) {
        try {
          subscriber(state);
        } catch {
          /* 订阅者异常不能影响启动 */
        }
      }
      return state;
    };

    if (!b) return finish({ done: true, hydrated: false, available: false });

    let ready: { available: boolean; hydrated: boolean; mode?: string | null } | undefined;
    try {
      if (b.ready) {
        const value = await withTimeout(b.ready, opts?.timeoutMs ?? 3000);
        ready = {
          available: value && value.available === true,
          hydrated: value && value.hydrated === true,
          mode: value && typeof value.mode === "string" ? value.mode : (b.mode ?? null),
        };
      } else {
        ready = await bootstrapNow(b);
      }
      /*
       * preload 的预取可能因为「页面脚本执行得太快 / preload 读不到 localStorage」而报
       * `hydrated:false`；此处由渲染层自己补一次批量预取（渲染层一定能读 localStorage）。
       * 只补一次，失败就走兜底——不能让启动挂在重试上。
       */
      if (ready && !ready.hydrated && (ready.mode === "async" || b.mode === "async")) {
        const retried = await bootstrapNow(b);
        if (retried.hydrated) ready = { ...retried, available: retried.available || ready.available };
      }
    } catch {
      ready = undefined; // 预取超时/失败：走兜底，不让启动挂住
    }

    const rawMode = ready?.mode ?? b.mode;
    const mode: "async" | "sync" | null =
      rawMode === "async" || rawMode === "sync" ? rawMode : null;
    const state: SecureHydration = {
      done: true,
      hydrated: ready?.hydrated === true,
      available: ready ? ready.available === true : b.available === true,
      mode,
    };

    if (!opts?.skipCleanup) {
      try {
        state.cleanup = await cleanupPlaintextBackups(opts?.base ? { base: opts.base } : undefined);
      } catch {
        /* 清理失败不影响启动：备份多留一个版本而已 */
      }
    }
    return finish(state);
  })();
  return hydrationPromise;
}

/** 订阅 hydrate 完成（已完成后立即回调一次）。返回取消订阅函数。 */
export function onSecureHydrated(callback: (state: SecureHydration) => void): () => void {
  if (typeof callback !== "function") return () => {};
  if (hydrationState.done) {
    try {
      callback({ ...hydrationState });
    } catch {
      /* 同上 */
    }
    return () => {};
  }
  hydratedSubscribers.add(callback);
  return () => {
    hydratedSubscribers.delete(callback);
  };
}

/** hydrate 是否已完成（启动门禁的断言点）。 */
export function secureStorageHydrated(): boolean {
  return hydrationState.done;
}
