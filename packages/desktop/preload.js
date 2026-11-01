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

// —— 语音通话桥接（Task 5）——
// ICE 服务器列表：主进程拉取 /api/ice-servers 后注入，渲染层在建立 PeerConnection 前读取。
// 注意：contextBridge.exposeInMainWorld 暴露的属性只有 getter 没有 setter，
// executeJavaScript 直接赋值会静默失败，因此使用闭包变量 + setter/getter 函数。
let _iceServers = [];

contextBridge.exposeInMainWorld("__heming_ice_servers_get", () => _iceServers);

contextBridge.exposeInMainWorld("__heming_voice_call", {
  /** 窗口最小化事件订阅（主进程 voice-call:minimized → 渲染层回调）。返回取消订阅函数。 */
  onMinimize: (callback) => {
    const listener = (_event, ...args) => callback(...args);
    ipcRenderer.on("voice-call:minimized", listener);
    return () => ipcRenderer.removeListener("voice-call:minimized", listener);
  },
  /** 请求主进程发系统通知（来电/通话中场景，窗口最小化时仍可见；主进程一并闪烁任务栏）。 */
  notify: (title, body) => {
    ipcRenderer.send("voice-call:notify", title, body);
  },
  /** 注入 ICE 服务器列表（主进程调用，渲染层通过 __heming_ice_servers_get 读取）。 */
  setIceServers: (list) => {
    _iceServers = list;
  },
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

// —— 本机密钥信封桥（d.36）——
// 三个低频键（模型 Key、MCP 服务请求头、E2E 设备身份）在渲染层的读写经这里
// 交给主进程的 safeStorage 加解密。sendSync 会阻塞渲染进程，只用于这三个
// 「启动读一次 / 用户改配置写一次」的键；**绝不能用在高频路径（消息收发）上**。
// 浏览器端没有这个桥，web 侧据此保持明文并把状态如实写进设置区。
const secretsAvailable = (() => {
  try {
    return ipcRenderer.sendSync("secret:available") === true;
  } catch {
    return false; // 主进程尚未注册或通道异常：按不可用处理，不让 preload 挂掉
  }
})();

contextBridge.exposeInMainWorld("__heming_secrets", {
  available: secretsAvailable,
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

// —— 信息中枢 · InfoHub 本机桥（d.45）——
// 归档数据留在本机：主进程用 stdio 拉起 Python 桥，这里只转发白名单方法。
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
  /** 订阅采集/导出进度事件。返回取消订阅函数。 */
  onEvent: (callback) => {
    if (typeof callback !== "function") return () => {};
    const listener = (_event, payload) => callback(payload);
    ipcRenderer.on("infohub:event", listener);
    return () => ipcRenderer.removeListener("infohub:event", listener);
  },
});
