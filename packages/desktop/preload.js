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

// —— 桌宠桥（d.46）——
// 桌宠是独立渲染进程：它自己画 Live2D、自己直连本机 LLM，主进程只负责
// 「窗口在哪、要不要挡鼠标、显示还是隐藏」。这里因此只暴露这三类动作，
// **不暴露任意窗口操作**（move/resize/setAlwaysOnTop 之类的通用入口）。
//
// ★ 坐标不上报：拖拽只发"按下/移动了/抬起"三个信号，位移由主进程按屏幕光标计算。
//   渲染层的 clientX 会随窗口移动而失真，拿它算位置一定跑偏。
contextBridge.exposeInMainWorld("__heming_pet", {
  /** 读当前状态 { visible, scale, clickThrough, bounds }。 */
  state: () => ipcRenderer.invoke("pet:state"),
  /**
   * 缩放。两种语义：
   *   setScale({ dir: 1 })  相对切一档（1 = 放大，-1 = 缩小）
   *   setScale(1.25)        设为该绝对档位
   */
  setScale: (payload) => ipcRenderer.invoke("pet:set-scale", payload),
  /** 上报「光标此刻是否在可交互区」。只在值变化时调用（mousemove 是高频事件）。 */
  setInteractive: (value) => {
    ipcRenderer.send("pet:set-interactive", value === true);
  },
  dragStart: () => ipcRenderer.send("pet:drag-start"),
  dragMove: () => ipcRenderer.send("pet:drag-move"),
  dragEnd: () => ipcRenderer.send("pet:drag-end"),
  /** 回到默认落位（工作区右下角，按当前缩放档位重新算）。 */
  resetPosition: () => ipcRenderer.send("pet:reset-position"),
  show: () => ipcRenderer.send("pet:show"),
  hide: () => ipcRenderer.send("pet:hide"),
  toggle: () => ipcRenderer.send("pet:toggle"),
  /** 鼠标穿透开关（设置区与托盘共用同一份状态）。 */
  setClickThrough: (value) => {
    ipcRenderer.send("pet:set-click-through", value === true);
  },
  /** 重新加载桌宠页面（换模型 / 换绑定智能体后让它重新读配置）。 */
  reload: () => ipcRenderer.send("pet:reload"),
  /**
   * 订阅主进程推来的事件（桌宠窗口用）。
   * 事件契约见 `packages/web/src/lib/petEvent.ts`；目前无生产者，是第三期的预留通道。
   */
  onEvent: (callback) => {
    if (typeof callback !== "function") return () => {};
    const listener = (_event, payload) => callback(payload);
    ipcRenderer.on("pet:event", listener);
    return () => ipcRenderer.removeListener("pet:event", listener);
  },
  /** 主动发起一条推送（主窗口用；主进程会校验来源）。 */
  emit: (payload) => ipcRenderer.send("pet:emit", payload),
  /**
   * 桌宠窗口请求把主窗口叫到前台并切到设置页（未配置模型时的出口）。
   * @param {string} [page] 桌宠直达页面，page 可选（不传 = 当前既有行为：设置页）。
   */
  openSettings: (page) => ipcRenderer.send("pet:open-settings", page),
  /** 主窗口侧订阅「桌宠要切换页面」。返回取消订阅函数。payload 为 `{ page?: string }` 或字符串（旧调用）。 */
  onOpenSettings: (callback) => {
    if (typeof callback !== "function") return () => {};
    const listener = (_event, payload) => callback(payload);
    ipcRenderer.on("pet:open-settings", listener);
    return () => ipcRenderer.removeListener("pet:open-settings", listener);
  },
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
