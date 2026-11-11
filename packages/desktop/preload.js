"use strict";
const { contextBridge, ipcRenderer } = require("electron");

// sandbox 模式下 preload 不能 require 本地模块（只允许 electron 与少数内置模块），
// 所以版本号必须由主进程通过同步 IPC 提供；拿不到时退回占位值，界面仍可渲染。
function readAppVersion() {
  try {
    const value = ipcRenderer.sendSync("app:version");
    return typeof value === "string" && value ? value : "0.0.0";
  } catch {
    return "0.0.0";
  }
}

// BootWave 回调注册表：contextBridge 暴露的对象在 Electron 中被冻结，
// web 端无法直接注入属性，因此回调保存在 preload 隔离世界的闭包中。
let bootCallback = null;

// 启动信号缓冲：主进程在 did-finish-load 后立刻调用 __startBootWave，可能早于 React
// 挂载并注册回调（渲染进程首帧 vs. 网络加载完成的竞态）。若只是「发一次就忘」，
// 这次启动动画的声波段就永远不会播。故记住「信号已发」，等回调注册时立刻补发。
let bootStarted = false;

contextBridge.exposeInMainWorld("heming", {
  platform: process.platform,
  /** 内部：web 端注册 BootWave 启动回调；若信号已发过则立刻回调（补齐竞态）。 */
  __onBootReady: (cb) => {
    if (typeof cb !== "function") return; // 非函数参数直接忽略，避免调用时炸在 preload 里
    bootCallback = cb;
    if (bootStarted) cb();
  },
  /** 内部：主进程 did-finish-load 后调用，触发 BootWave；重复调用幂等（只置位 + 回调一次语义由 web 端保持）。 */
  __startBootWave: () => {
    bootStarted = true;
    if (typeof bootCallback === "function") bootCallback();
  }
  // harness 桥接 API 在 M（二期）扩展
});

// —— MCP stdio 传输桥（仅桌面端）——
// 渲染进程没有 child_process：所有 stdio MCP 调用都经这里转给主进程。
// 只暴露「按 serverId 发一条 JSON-RPC」这一件事，不暴露任意命令执行入口。
contextBridge.exposeInMainWorld("__mcp_stdio", {
  /**
   * @param {string} serverId 服务 id（主进程按它复用同一个子进程）
   * @param {{command: string, args?: string[]}} config 首次拉起进程用的启动信息
   * @param {string} method JSON-RPC 方法名
   * @param {unknown} params 参数
   */
  request: (serverId, config, method, params) =>
    ipcRenderer.invoke("mcp:stdio:request", { serverId, config, method, params }),
  /** 停止并回收某服务的子进程。 */
  stop: (serverId) => ipcRenderer.invoke("mcp:stdio:stop", serverId),
});

// —— 本机运行时探测（仅桌面端）——
// Registry 的本地包（npm/pypi）服务能不能装，取决于这台机器有没有 npx / uvx。
// 渲染层没有 fs，只能问主进程；浏览器端没有这个桥，前端据此把本地包一律标记为
// 「无法探测」而不是猜测。
contextBridge.exposeInMainWorld("__heming_runtime", {
  /** 返回 { platform, npm, pypi, note, ... }；只读探测，不执行任何命令。 */
  probe: () => ipcRenderer.invoke("runtime:probe"),
});

// —— 宿主加载式模块包（d.131）——
// 只读已安装模块清单（含 web 入口），供主窗口拼 app://heming/modules/<id>/<version>/files/web/... URL。
// 真正的文件读取在 app:// 协议层做「已安装 + 路径夹取」双重校验，这里不传任意路径。
contextBridge.exposeInMainWorld("__heming_modules", {
  webList: () => ipcRenderer.invoke("modules:web-list"),
});

// —— 版本号 ——
// 展示与更新比较都用 5 段版本（d.特性.破坏性.修订.构建），不在渲染层重复读 package.json。
contextBridge.exposeInMainWorld("__heming_version", readAppVersion());

// —— 自动更新 ——
// 只有安装版有（开发态主进程不初始化）；渲染层据此判断要不要显示更新入口。
// 状态由主进程主动推送（update:state），所以订阅函数要在订阅瞬间也给一份当前值。
contextBridge.exposeInMainWorld("__heming_update", {
  /** 主动检查一次；返回最新状态。 */
  check: () => ipcRenderer.invoke("update:check"),
  /** 下载已发现的更新；返回最新状态。 */
  download: () => ipcRenderer.invoke("update:download"),
  /** 退出并安装（仅在已下载完成时有效）。 */
  install: () => ipcRenderer.invoke("update:install"),
  /** 读当前状态（不触发检查）。 */
  state: () => ipcRenderer.invoke("update:state"),
  /**
   * 订阅状态变化。返回取消订阅函数。
   * 回调签名与主进程推送的一致，便于设置区与启动提示条共用同一份渲染逻辑。
   */
  subscribe: (callback) => {
    const listener = (_event, state) => callback(state);
    ipcRenderer.on("update:state", listener);
    // 主进程在注册时会推一次当前状态；这里补一次初值，
    // 避免界面要等一次变化才显示版本信息。
    ipcRenderer.invoke("update:state").then(callback).catch(() => {});
    return () => ipcRenderer.removeListener("update:state", listener);
  },
});

// —— 个人知识库文件桥（卡帕西 LLM Wiki 标准）——
// wiki 必须是真实 markdown 文件，Obsidian 才能直接打开、任意 LLM 才能直接读写。
// 渲染层拿不到 fs，故经主进程转发；路径安全（夹在根目录内 + 白名单）由 wiki-fs.js 兜。
// 浏览器环境没有这个桥，前端据此降级到内存实现（见 lib/wiki/store.ts）。
contextBridge.exposeInMainWorld("__heming_wiki", {
  /** 根目录与是否已存在：界面上要告诉用户 wiki 放在哪。 */
  info: () => ipcRenderer.invoke("wiki:info"),
  /** 列出全部 .md 的相对路径。 */
  list: () => ipcRenderer.invoke("wiki:list"),
  /** 读一个文件；不存在返回 null。 */
  read: (rel) => ipcRenderer.invoke("wiki:read", rel),
  /** 写一个文件，返回 { path, bytes }。 */
  write: (rel, content) => ipcRenderer.invoke("wiki:write", rel, content),
  /** 删一个 .md 文件。 */
  remove: (rel) => ipcRenderer.invoke("wiki:remove", rel),
  /** 往 log.md 追加一条 `## [日期] 类型 | 标题`。 */
  log: (kind, title, extra) => ipcRenderer.invoke("wiki:log", kind, title, extra),
});

// —— 原生知识库（多库 vault）文件桥（d.114）——
// 与上面的 __heming_wiki 并存，互不影响：老 wiki 桥服务固定目录与既有 wiki 工具，
// vault 桥服务用户在系统对话框里自选的多个库（Obsidian 风格，任意目录/层级）。
//
// 主进程的结果统一是 `{ok:true, value}` 或 `{ok:false, code, message}`：这里把失败
// envelope 转成带 `code` 的 Error（message 已是中文），web 侧 `lib/vault/bridge.ts`
// 再归一化成 `VaultBridgeError`。渲染层拿到的失败因此是 structured rejection，
// 不会出现「Cannot read properties of undefined」这类主进程细节泄漏。
function unwrapVaultResult(result) {
  if (result && result.ok === true) return result.value;
  const code = result && typeof result.code === "string" ? result.code : "io-error";
  const message = result && typeof result.message === "string" ? result.message : "知识库操作失败";
  const error = new Error(message);
  error.name = "VaultBridgeError";
  error.code = code;
  throw error;
}

contextBridge.exposeInMainWorld("__heming_vault", {
  /** 已登记的库列表。 */
  list: () => ipcRenderer.invoke("vault:list").then(unwrapVaultResult),
  /** 弹系统目录选择器新增一个库；用户取消返回 null。 */
  pick: () => ipcRenderer.invoke("vault:pick").then(unwrapVaultResult),
  /** 移除登记（不删磁盘文件）。 */
  remove: (vaultId) => ipcRenderer.invoke("vault:remove", vaultId).then(unwrapVaultResult),
  /** 改库展示名。 */
  rename: (vaultId, name) => ipcRenderer.invoke("vault:rename", vaultId, name).then(unwrapVaultResult),
  /** 目录树（懒加载：depth 默认 2，rel 为空表示库根）。 */
  tree: (vaultId, treeOptions) => ipcRenderer.invoke("vault:tree", vaultId, treeOptions).then(unwrapVaultResult),
  /** 读文本；不存在返回 null。 */
  read: (vaultId, rel) => ipcRenderer.invoke("vault:read", vaultId, rel).then(unwrapVaultResult),
  /** 读图片，主进程转 data URL。 */
  readBinary: (vaultId, rel) => ipcRenderer.invoke("vault:readBinary", vaultId, rel).then(unwrapVaultResult),
  /** 用户编辑通道：库内任意可写文本路径（expectMtime 防外部覆盖）。 */
  write: (vaultId, rel, text, writeOptions) =>
    ipcRenderer.invoke("vault:write", vaultId, rel, text, writeOptions).then(unwrapVaultResult),
  /** 智能体通道：仅 writeDirs 内，越界失败（outside-write-dirs）。 */
  apply: (request) => ipcRenderer.invoke("vault:apply", request).then(unwrapVaultResult),
  /** 新建文件（父目录自动创建）。 */
  create: (vaultId, rel, text) => ipcRenderer.invoke("vault:create", vaultId, rel, text).then(unwrapVaultResult),
  /** 新建目录（多级 mkdir -p；已存在视为成功，失败仍是带 code 的结构化 Error）。 */
  createDir: (vaultId, rel) => ipcRenderer.invoke("vault:createDir", vaultId, rel).then(unwrapVaultResult),
  /** 库内移动/改名。 */
  move: (vaultId, from, to) => ipcRenderer.invoke("vault:move", vaultId, from, to).then(unwrapVaultResult),
  /** 删除单个文件（不递归）。 */
  delete: (vaultId, rel) => ipcRenderer.invoke("vault:delete", vaultId, rel).then(unwrapVaultResult),
  /** 在系统资源管理器中定位。 */
  reveal: (vaultId, rel) => ipcRenderer.invoke("vault:reveal", vaultId, rel).then(unwrapVaultResult),
  /**
   * 订阅库变化（主进程已按 300ms 去抖）。返回取消订阅函数。
   * 回调收到库内相对路径数组；空数组表示「变化太多，请全量重建索引」。
   */
  watch: (vaultId, onChange) => {
    if (typeof onChange !== "function") return () => {};
    const listener = (_event, payload) => {
      if (!payload || payload.vaultId !== vaultId || !Array.isArray(payload.rels)) return;
      onChange(payload.rels);
    };
    ipcRenderer.on("vault:changed", listener);
    // 订阅是异步注册的：即便注册失败也不该在 preload 里抛未处理 rejection，
    // 真正的失败会由后续读树/读文件暴露出来。
    ipcRenderer.invoke("vault:watch", vaultId).catch(() => {});
    let active = true;
    return () => {
      if (!active) return;
      active = false;
      ipcRenderer.removeListener("vault:changed", listener);
      ipcRenderer.invoke("vault:unwatch", vaultId).catch(() => {});
    };
  },
});

// —— 图表导出桥 ——
// 把生成的图表写到 ~/Heming/charts，并可用系统默认程序打开。
// 浏览器端没有这个桥，渲染层会降级为「下载到浏览器默认目录」。
contextBridge.exposeInMainWorld("__heming_chart", {
  /** 导出图表 HTML；返回 { ok, path, name } 或 { ok:false, error }。 */
  export: (fileName, content) => ipcRenderer.invoke("chart:export", fileName, content),
  /** 列出已导出的图表。 */
  list: () => ipcRenderer.invoke("chart:list"),
  /** 用系统默认程序打开。 */
  open: (fileName) => ipcRenderer.invoke("chart:open", fileName),
});

// —— 记忆导出文件桥（d.35）——
// 把记忆导出 JSON 写到 ~/Heming/exports。只暴露「写一个 .json + 问目录」两件事，
// 路径白名单与目录固定由主进程 export-fs.js 兜；浏览器端没有这个桥，
// web 侧会回退为 Blob 下载（见 lib/export/file.ts）。
contextBridge.exposeInMainWorld("__heming_exports", {
  write: (fileName, content) => ipcRenderer.invoke("export:write", fileName, content),
  info: () => ipcRenderer.invoke("export:info"),
});

// —— 本机密钥信封桥（d.36 · P0-5；d.58 起异步优先）——
// 三个低频键（模型 Key、MCP 服务请求头、E2E 设备身份）在渲染层的读写经这里
// 交给主进程的 safeStorage 加解密。
//
// 为什么有两套 API（d.58）：
// - Electron 45 起 safeStorage 的**同步**三件套已弃用、46 将移除，替代品是异步三件套；
// - 但渲染层三个低频键是「模块初始化时同步读」，消费方改造不在本轮范围；
// - 所以：**异步优先 + 启动预取缓存 + 旧同步 API 兜底**。
//   页面脚本执行前先异步预取三个键的明文进本进程闭包缓存（一次批量 IPC），
//   渲染层读缓存（同步、零 IPC）；缓存未命中时回退旧的同步桥（45 可用）。
//   `ready` 让渲染层知道预取什么时候完成，`mode` 告诉它这套 Electron 还有没有同步 API。
//
// 缓存里是明文（与渲染层本来就能拿到的东西等价），但**只缓存这三个白名单键**：
// 批量通道在主进程侧也是同一份白名单（见 secret-store.js 的 BOOTSTRAP_ALLOWED_KEYS）。
const SECRET_BOOTSTRAP_KEYS = Object.freeze([
  "heming.llmConfigs",
  "heming.mcp.servers.v1",
  "heming.e2e.identity",
]);

/** 能力探测（同步、无副作用）：失败按「无可用 API」处理，不让 preload 挂掉。 */
const secretCapabilities = (() => {
  try {
    const value = ipcRenderer.sendSync("secret:capabilities");
    if (value && typeof value === "object") return value;
  } catch {
    /* 主进程尚未注册：按不可用处理 */
  }
  return { mode: null, sync: false, async: false };
})();

const secretsAvailable = (() => {
  try {
    return ipcRenderer.sendSync("secret:available") === true;
  } catch {
    return false; // 主进程尚未注册或通道异常：按不可用处理，不让 preload 挂掉
  }
})();

/** 预取缓存：键 → 明文（`null` = 密文解不开；键不存在 = 还没预取到）。 */
const secretCache = new Map();

/**
 * 启动预取：读 localStorage 里的信封 → 一次批量 IPC 换明文 → 填缓存。
 *
 * 失败 / 没有异步 API 时也 resolve（`hydrated:false`）：渲染层据此继续走同步兜底，
 * 绝不能让「预取没成功」把启动链挂住。
 */
const secretsReady = (async () => {
  const fallback = { available: secretsAvailable, mode: secretCapabilities.mode, hydrated: false };
  if (secretCapabilities.mode !== "async") return fallback;
  try {
    const entries = [];
    for (const key of SECRET_BOOTSTRAP_KEYS) {
      try {
        const raw = window.localStorage.getItem(key);
        if (!raw) continue;
        const parsed = JSON.parse(raw);
        // 只挑「信封」形态：明文/坏数据留给渲染层按既有逻辑处理（不在这里猜）。
        if (parsed && typeof parsed === "object" && typeof parsed.data === "string" && parsed.data) {
          entries.push({ key, data: parsed.data });
        }
      } catch {
        /* 单键坏数据不影响其它键预取 */
      }
    }
    if (entries.length === 0) return { ...fallback, hydrated: true };
    const result = await ipcRenderer.invoke("secret:bootstrap", { entries });
    const plaintexts = result && Array.isArray(result.plaintexts) ? result.plaintexts : [];
    for (const item of plaintexts) {
      if (!item || typeof item.key !== "string") continue;
      secretCache.set(item.key, typeof item.value === "string" ? item.value : null);
    }
    return {
      available: result && result.available === true,
      mode: (result && result.mode) || secretCapabilities.mode,
      hydrated: true,
    };
  } catch {
    return fallback;
  }
})();

contextBridge.exposeInMainWorld("__heming_secrets", {
  /** 主进程报告的加解密口径：`"async"`（首选）/ `"sync"`（旧版兜底）/ `null`（不可用）。 */
  mode: secretCapabilities.mode,
  /** 异步 API 是否可用（决定渲染层走缓存还是纯同步兜底）。 */
  asyncAvailable: secretCapabilities.async === true,
  /** 系统安全存储是否可用（同步探测，兼容既有渲染层）。 */
  available: secretsAvailable,
  /** 启动预取完成信号（永不 reject；`hydrated:false` 表示走同步兜底）。 */
  ready: secretsReady,
  /** 同步读预取缓存：命中返回明文（解不开为 null），未命中返回 undefined。 */
  cachedRead: (key) => {
    if (typeof key !== "string") return undefined;
    if (!secretCache.has(key)) return undefined;
    const value = secretCache.get(key);
    return typeof value === "string" ? value : null;
  },
  /** 渲染层写盘后同步刷新缓存（保证「写后立即读」在缓存路径上一致）。 */
  cacheSet: (key, plain) => {
    if (typeof key !== "string" || typeof plain !== "string") return;
    if (!SECRET_BOOTSTRAP_KEYS.includes(key)) return;
    secretCache.set(key, plain);
  },
  /** 其它窗口改了值（storage 事件）时失效缓存，下一次读回退同步桥拿最新值。 */
  cacheDelete: (key) => {
    if (typeof key === "string") secretCache.delete(key);
  },
  /** 批量解密（白名单三键；主进程侧再次校验白名单）。 */
  bootstrap: (payload) => ipcRenderer.invoke("secret:bootstrap", payload),
  /** 异步三件套（默认路径：d.59 起渲染层默认走异步，同步仅旧版兜底）。 */
  availableAsync: () => ipcRenderer.invoke("secret:availableAsync"),
  encryptAsync: (plain) => ipcRenderer.invoke("secret:encryptAsync", plain),
  decryptAsync: (cipherB64) => ipcRenderer.invoke("secret:decryptAsync", cipherB64),
  /** 通用批量（E2E 热路径：chains/msgCache 冷启动预取与异步落盘；顺序敏感、失败位为 null）。 */
  encryptManyAsync: (plains) => ipcRenderer.invoke("secret:encryptMany", plains),
  decryptManyAsync: (ciphers) => ipcRenderer.invoke("secret:decryptMany", ciphers),
  /** 旧同步 API（**已迁移**：仅「旧版 Electron / 无异步 API」时兜底；46 起上游移除）。 */
  encrypt: (plain) => {
    try {
      const out = ipcRenderer.sendSync("secret:encrypt", plain);
      return typeof out === "string" ? out : null;
    } catch {
      return null;
    }
  },
  decrypt: (cipherB64) => {
    try {
      const out = ipcRenderer.sendSync("secret:decrypt", cipherB64);
      return typeof out === "string" ? out : null;
    } catch {
      return null;
    }
  },
});

// —— 工作流 HTTP 桥（d.87）——
// 渲染层的 fetch 受同源策略限制；工作流的「HTTP 请求」节点在桌面端改由主进程代发。
// 只暴露一个 request，入参是普通对象（方法/地址/头/字符串体），不含任何本地能力。
contextBridge.exposeInMainWorld("__heming_http", {
  available: true,
  request: (options) => ipcRenderer.invoke("workflow:http", options),
});

// —— 系统通知桥（d.39）——
// 消息提醒：窗口不在前台时由渲染层请求主进程弹系统通知；点击主进程聚焦窗口并回传会话 id。
contextBridge.exposeInMainWorld("__heming_notify", {
  message: (payload) => {
    ipcRenderer.send("notify:message", payload);
  },
  onOpen: (callback) => {
    // 非函数参数不注册监听，返回空取消函数：渲染层传错时不能炸在 preload 里。
    if (typeof callback !== "function") return () => {};
    const listener = (_event, conversationId) => callback(conversationId ?? null);
    ipcRenderer.on("notify:open", listener);
    return () => ipcRenderer.removeListener("notify:open", listener);
  },
});

// —— 界面插件桥（d.98：主窗专用，管理 widget 类插件的安装/启停/设置/动作）——
// 桌宠已从本体拆出去，成为第一个「界面插件」（desktopWidget）。本桥只给**主窗**用，
// 通道走 secureIpc + TRUSTED_CHANNELS（不是 widget 窗口那份最小桥）；
// widget 窗口自己的桥在 widget-preload.js，只有窗口动作与环境，没有安装权和文件能力。
//
// ★ 安装包字节从渲染层传进来（ArrayBuffer）：主进程按 expectedSha256 复核后才解包，
//   渲染层不碰 fs、不决定落盘位置。
contextBridge.exposeInMainWorld("__heming_widgets", {
  /** 已安装的界面插件记录（{id,name,version,enabled,widget,settings,installedAt,error?}）。 */
  list: () => ipcRenderer.invoke("widgets:list"),
  /** 打开文件框选一个 .tgz，只返回路径（不安装）。 */
  pickPackage: () => ipcRenderer.invoke("widgets:pickPackage"),
  /** 安装/升级：bytes 是 package.tgz 的 ArrayBuffer，expectedSha256 来自云端目录。 */
  install: (payload) => ipcRenderer.invoke("widgets:install", payload),
  /** 主进程自己开文件框选包并安装（渲染层不碰 fs）。 */
  installFromFile: () => ipcRenderer.invoke("widgets:installFromFile"),
  uninstall: (payload) => ipcRenderer.invoke("widgets:uninstall", payload),
  setEnabled: (payload) => ipcRenderer.invoke("widgets:setEnabled", payload),
  settingsGet: (payload) => ipcRenderer.invoke("widgets:settingsGet", payload),
  settingsSet: (payload) => ipcRenderer.invoke("widgets:settingsSet", payload),
  /** 窗口动作：show/hide/toggle/scaleUp/scaleDown/toggleClickThrough/resetPosition/reload。 */
  action: (payload) => ipcRenderer.invoke("widgets:action", payload),
  /** 运行时状态 { visible, scale, clickThrough }（未运行为 null）。 */
  state: (payload) => ipcRenderer.invoke("widgets:state", payload),
  /**
   * d.124：把界面插件的**页面视图**挂到主窗内容区（进入 `plugin:<id>` 页面时调用）。
   *
   * 主进程先销毁旧视图再按记录新建（同一时刻只有一个页面视图）；返回 `{ ok:false, error }`
   * 时 error 已是可直接展示的中文（未安装/停用/没有页面/加载失败）。旧版桌面端没有此方法，
   * 调用方用 `typeof bridge.pageMount === "function"` 判定并降级。
   */
  pageMount: (input) => ipcRenderer.invoke("widgets:page-mount", input),
  /**
   * 更新页面视图边界（窗口/布局变化时）。rect 是主窗内容区坐标（DIP），主进程自己钳制；
   * fire-and-forget：高频 resize 不该等一次 IPC 往返。
   */
  pageBounds: (input) => ipcRenderer.send("widgets:page-bounds", input),
  /** 移除并销毁当前页面视图（离开页面/切页时；重复调用无害）。 */
  pageUnmount: () => ipcRenderer.send("widgets:page-unmount"),
  /** 把通知中心的新条目脱敏后转发给声明了 permissions.events 含 notify 的 widget。 */
  publish: (payload) => ipcRenderer.send("widgets:publish", payload),
  /** 老 localStorage["heming.pet.v1"] 一次性并入 heming.pet 的设置（幂等）。 */
  migrateLegacy: (payload) => ipcRenderer.invoke("widgets:migrateLegacy", payload),
  /** 主进程要求主窗跳页（托盘「设置」/widget 气泡点击）。返回取消订阅函数。 */
  onOpenPage: (callback) => {
    if (typeof callback !== "function") return () => {};
    const listener = (_event, payload) => callback(payload);
    ipcRenderer.on("widgets:open-page", listener);
    return () => ipcRenderer.removeListener("widgets:open-page", listener);
  },
  /**
   * chatConfig 请求/应答（规格 §3.4）：主进程不知道 agents/binding，向主窗问一次并缓存 30s。
   * 返回取消订阅函数；主窗不接也能跑（主进程 1s 后降级为空列表）。
   */
  onChatConfigRequest: (callback) => {
    if (typeof callback !== "function") return () => {};
    const listener = (_event, payload) => callback(payload);
    ipcRenderer.on("widgets:chat-config-request", listener);
    return () => ipcRenderer.removeListener("widgets:chat-config-request", listener);
  },
  replyChatConfig: (requestId, config) =>
    ipcRenderer.invoke("widgets:chat-config-reply", { requestId, config }),
});

// —— 文件编辑桥（d.55 · file_patch）——
// 只暴露三件事：读一个文件、写一批变更、让用户选一个可写根目录。
// 路径判定（夹在根内、挡软链/硬链）、上限、tmp+rename 原子写全部由主进程
// file-fs.js 兜底；渲染层传进来的只有「根清单 + 目标绝对路径 + 内容」。
// 浏览器端没有这个桥，web 侧据此**不注入** file_patch / file_read（见 lib/fileEdit/bridge.ts）。
contextBridge.exposeInMainWorld("__heming_files", {
  /** 读一个文件；返回 { ok, content?, bytes?, code?, error? }。 */
  read: (payload) => ipcRenderer.invoke("file:read", payload),
  /** 批量写入/删除；返回 { ok, results?, written?, deleted?, error? }。 */
  write: (payload) => ipcRenderer.invoke("file:write", payload),
  /** 系统目录选择器；取消返回 null。 */
  pickRoot: () => ipcRenderer.invoke("file:pick-root"),
});

// —— 信息中枢 · InfoHub 本机桥（d.45）——
// 归档数据留在本机：主进程用 stdio 拉起 Python 桥，这里只转发白名单方法。
// ── 内置 magpie 网关（d.91）───────────────────────────────────────────────
// 模型统一由 magpie 提供：主进程托管 `magpie serve` 与带 CORS 的本机反代，
// 渲染层只拿 status / 启动停止 / 反代 baseUrl（不直接碰 3425 端口，避开 Origin 策略）。
contextBridge.exposeInMainWorld("__heming_magpie", {
  status: () => ipcRenderer.invoke("magpie:status"),
  start: () => ipcRenderer.invoke("magpie:start"),
  stop: () => ipcRenderer.invoke("magpie:stop"),
  gateway: () => ipcRenderer.invoke("magpie:gateway"),
  /** 模型页的管理命令（白名单由主进程校验）：返回 {ok, code, stdout, stderr, error}。 */
  cli: (args) => ipcRenderer.invoke("magpie:cli", Array.isArray(args) ? args : []),
  /** 交互式命令：输出按 magpie:cli:event 回流，输入经 cliInput 写入。 */
  cliStart: (args) => ipcRenderer.invoke("magpie:cli:start", Array.isArray(args) ? args : []),
  /** 交互式命令（立刻返回 runId，事件里带同一个 id）。 */
  cliBegin: (args) => ipcRenderer.invoke("magpie:cli:begin", Array.isArray(args) ? args : []),
  /** 备份目录与已有备份文件（应用自己的目录）。 */
  backupInfo: () => ipcRenderer.invoke("magpie:backup:info"),
  /** 选一个备份文件（系统文件选择器）。 */
  backupPick: () => ipcRenderer.invoke("magpie:backup:pick"),
  cliInput: (runId, text) => ipcRenderer.invoke("magpie:cli:input", String(runId), String(text ?? "")),
  cliKill: (runId) => ipcRenderer.invoke("magpie:cli:kill", String(runId)),
  /** 在真终端里跑（OAuth 登录/备份口令）。 */
  openTerminal: (args) => ipcRenderer.invoke("magpie:terminal", Array.isArray(args) ? args : []),
  /** 订阅内核命令输出；返回取消订阅函数。 */
  onCli: (callback) => {
    if (typeof callback !== "function") return () => {};
    const listener = (_event, payload) => callback(payload);
    ipcRenderer.on("magpie:cli:event", listener);
    return () => ipcRenderer.removeListener("magpie:cli:event", listener);
  },
});

// 浏览器端没有这个桥，页面据此显示「仅桌面端可用」，绝不回退到云端读归档。
contextBridge.exposeInMainWorld("__heming_infohub", {
  /** 静态信息：包目录、默认数据目录、内置解释器、当前进程状态。 */
  info: () => ipcRenderer.invoke("infohub:info"),
  /** 拉起（或复用）InfoHub 进程；config = { home?, python? }。 */
  start: (config) => ipcRenderer.invoke("infohub:start", config),
  /** 调一个白名单方法；未启动时自动拉起。config 用于切换数据目录/解释器。 */
  call: (method, params, config) => {
    const safe = config && typeof config === "object" ? config : {};
    return ipcRenderer.invoke("infohub:call", {
      method,
      params,
      home: safe.home,
      python: safe.python,
    });
  },
  /** 停止并回收进程（应用退出时主进程也会兜底）。 */
  stop: () => ipcRenderer.invoke("infohub:stop"),
  /** 选数据目录（用系统目录选择器，渲染层拿不到 fs）。 */
  pickHome: () => ipcRenderer.invoke("infohub:pick-home"),
  /** 选 Python 解释器（采集依赖通常只装在 InfoHub 的 venv 里）。 */
  pickPython: () => ipcRenderer.invoke("infohub:pick-python"),
  /** 引擎模块状态：是否已装、期望版本、模块源。 */
  engineInfo: () => ipcRenderer.invoke("infohub:engine-info"),
  /** 确保引擎装好（缺则下载官签名模块包；已装则直接返回）。 */
  ensureEngine: (version) =>
    ipcRenderer.invoke("infohub:engine-ensure", {
      version: typeof version === "string" ? version : undefined,
    }),
  /** 订阅引擎下载/安装进度。返回取消订阅函数。 */
  onEngine: (callback) => {
    if (typeof callback !== "function") return () => {};
    const listener = (_event, payload) => callback(payload);
    ipcRenderer.on("infohub:engine", listener);
    return () => ipcRenderer.removeListener("infohub:engine", listener);
  },
  /** 订阅采集/导出进度事件。返回取消订阅函数。 */
  onEvent: (callback) => {
    if (typeof callback !== "function") return () => {};
    const listener = (_event, payload) => callback(payload);
    ipcRenderer.on("infohub:event", listener);
    return () => ipcRenderer.removeListener("infohub:event", listener);
  },
});
