"use strict";

const path = require("node:path");
const {
  widgetUrl,
  isSameWidgetOrigin,
  widgetWindowOptions,
  widgetWindowSize,
  clampWidgetState,
  defaultWidgetPosition,
  normalizeScale,
  nextScale,
  draggedPosition,
  settleWidgetPosition,
  normalizeWidgetPage,
} = require("./plugin-window");
const { createPluginEngine } = require("./plugin-engine");
const { RENDERER_METHODS } = require("./infohub-bridge");
const { CARD_KEY, readOverrides, projectCard, collectCards, applyPatch } = require("./home-cards");

/**
 * 界面插件（desktopWidget）的宿主运行时：按清单规格建窗、托盘、穿透、拖拽、位置记忆，
 * 并把 `widget:*` 通道收口到「只认自己那个窗口」。
 *
 * 由 d.46 的 `pet-host.js` 泛化而来（d.98）：桌宠时代是把"桌宠"这一个窗口的生命周期
 * 写成一个闭包；现在同一套语义按**清单声明的规格**实例化，一个插件一个 runtime，
 * 共享一份 IPC 注册与显示器监听。行为约束逐条保留：
 * - 默认穿透（`forward:true`，否则渲染层收不到 mousemove，角色永远点不中）；
 * - 拖拽按**屏幕光标差**计算，位置没变不 setPosition（少一次透明层合成）；
 * - 拖拽期间拒绝切穿透、不落盘，抬起时补终值 + 吸附 + 钳制；
 * - 显示器变化按当前档位重算尺寸并保持右下角不动；
 * - 落盘防抖 400ms；隐藏时暂停渲染（backgroundThrottling 开关），显示时恢复。
 *
 * ★ 安全模型（规格 §6.1）：`widget:*` 全部按 `BrowserWindow.fromWebContents(event.sender)`
 *   反查 runtime，**查不到就拒绝**（fail-closed）。插件无法操作别的窗口、主窗、文件、密钥。
 * ★ d.124 B 路径：除 widget 窗口外，本文件还托管一个**页面视图**（`WebContentsView`，嵌在
 *   主窗内容区）。页面视图登记在 `pageInfo` 里供 IPC 按 sender 反查 info/settings/data/
 *   openPage/log；窗口几何/拖拽/穿透类通道对页面显式拒绝（页面没有独立窗口）。
 * ★ 依赖全部注入（BrowserWindow/WebContentsView/Tray/screen/ipcMain/store…），可以用假对象单测整条状态机。
 */

/** 拖拽落盘与 move 事件的防抖：拖拽时 move 是高频的，每次都写盘会拖慢手感。 */
const SAVE_DEBOUNCE_MS = 400;

/** chatConfig 缓存时长与主窗应答超时（规格 §3.4：向主窗请求一次并缓存 30s）。 */
const CHAT_CONFIG_TTL_MS = 30_000;
const CHAT_CONFIG_TIMEOUT_MS = 1_000;

const EVENT_KINDS = new Set(["notify", "theme", "tray"]);
const NOTIFY_TITLE_MAX = 80;
const NOTIFY_SUMMARY_MAX = 60;

/** 托盘「打开设置」落在设置区的哪个 tab（T3 按 settingsTab 落到「外观 · 桌面小组件」）。 */
const SETTINGS_TAB = "appearance";

/**
 * 宿主 → widget 的生命周期事件通道（d.108，规格 §5.4）。
 *
 * 与 `widget:event`（notify/theme/tray）分开：生命周期有自己的载荷形状
 * `{ event, version, from? }`，且权限门禁不同（`permissions.events` 含 `lifecycle`）。
 */
const LIFECYCLE_CHANNEL = "widget:lifecycle";

/** 窗口未建好前最多排队多少条生命周期事件（d.110：8 → 20；溢出丢最旧，避免投递过期状态）。 */
const MAX_PENDING_LIFECYCLE = 20;

/* ────────────────────── 插件页面视图（d.124 B 路径） ────────────────────── */

/**
 * 页面视图的 preload 标记参数：主进程建 `WebContentsView` 时传给 `widget-preload.js`。
 *
 * 页面视图复用同一份最小桥（info/settings/data/openPage…），但它**不是一个窗口**：
 * 拖拽/显隐/缩放/穿透这些窗口动作在页面里没有意义。preload 看到这个参数就把那些
 * 方法变成「明确的不支持错误」，插件作者能立刻知道这段代码只对浮窗有效。
 */
const PAGE_VIEW_FLAG = "--heming-page-view";
/** 页面视图允许占用的 contentView 最小尺寸（宽高各至少 1 DIP，否则 Chromium 不给合成）。 */
const PAGE_MIN_SIZE = 1;

/**
 * 页面意图 token（`pageMount({ intent })`）：首页卡快捷入口点进来时要落到哪个视角。
 *
 * ★ 只拼进 `#intent=<token>` 的 hash：不进 IPC 之外的通道、不跨插件 origin，
 *   widget origin 校验只看 origin/path（isSameWidgetOrigin 会剥掉 hash），
 *   插件页读 location.hash 自己解释——宿主不理解语义，插件加新意图不用改宿主。
 */
const PAGE_INTENT_RE = /^[a-z0-9][a-z0-9._-]{0,31}$/;

/** 归一化页面意图；不合法一律返回空串（退化成普通挂载，不给页面添噪音）。 */
function normalizePageIntent(value) {
  if (typeof value !== "string") return "";
  const intent = value.trim();
  return PAGE_INTENT_RE.test(intent) ? intent : "";
}

/* ────────────────────── 后台常驻页（沙箱 bundle 插件，contract §1/§5） ────────────────────── */

/**
 * 后台常驻页的 preload 标记参数。
 *
 * 与页面视图一样属于「没有独立窗口的渲染面」：拖拽/显隐/穿透在后台页里没有意义。
 * 用带值的 `--heming-widget-mode=background` 而不是再一个布尔 flag——以后若要区分
 * 「页面视图 / 后台页 / 其他宿主视图」，preload 不必再加参数。
 */
const BACKGROUND_FLAG = "--heming-widget-mode=background";

/**
 * 隐藏窗口的初始尺寸。
 *
 * 不用 0×0：部分平台的合成器会跳过零尺寸窗口（页面不渲染，定时器照跑但 DOM 布局
 * 全是 0，插件按尺寸算的逻辑会算错）。给一个正常桌面尺寸但 `show:false`，用户看不见。
 */
const BACKGROUND_WIDTH = 480;
const BACKGROUND_HEIGHT = 320;

/* ── 信息中枢 / 通知（contract §3） ── */
/** `widget:infohub-call` 的默认超时与上下限（与 `engineCall` 同一口径：60s / 30 分钟）。 */
const INFOHUB_TIMEOUT_DEFAULT = 60_000;
const INFOHUB_TIMEOUT_MAX = 30 * 60_000;
const INFOHUB_TIMEOUT_MIN = 1_000;

function text(value, max) {
  if (typeof value !== "string") return null;
  const trimmed = value.trim();
  if (!trimmed) return null;
  return trimmed.length > max ? `${trimmed.slice(0, max)}…` : trimmed;
}

/** 归一化跨进程事件（主窗 publish 与内部 push 共用；畸形一律丢弃）。 */
function normalizeEvent(raw) {
  if (!raw || typeof raw !== "object" || Array.isArray(raw)) return null;
  if (!EVENT_KINDS.has(raw.kind)) return null;
  if (raw.kind === "theme") {
    return { kind: "theme", theme: raw.theme === "dark" ? "dark" : "light" };
  }
  if (raw.kind === "tray") {
    const action = text(raw.action, 32);
    return action ? { kind: "tray", action } : null;
  }
  const title = text(raw.title, NOTIFY_TITLE_MAX);
  if (!title) return null;
  const event = { kind: "notify", title, summary: text(raw.summary, NOTIFY_SUMMARY_MAX) || "" };
  const route = normalizeWidgetPage(raw.route);
  if (route) event.route = route;
  const at = text(raw.at, 40);
  if (at) event.at = at;
  return event;
}

function normalizeChatConfig(raw) {
  const input = raw && typeof raw === "object" ? raw : {};
  // 审计 P0-1：**不下发 prompt**。widget CSP 曾含本机回环通配，智能体人设提示词一旦
  // 落到插件页就能被 POST 到本机任意端口；绑定只需要 id/name，人设由主进程持有。
  const agents = Array.isArray(input.agents)
    ? input.agents
        .filter((agent) => agent && typeof agent.id === "string" && agent.id)
        .slice(0, 50)
        .map((agent) => ({
          id: String(agent.id).slice(0, 64),
          name: text(agent.name, 64) || String(agent.id).slice(0, 64),
        }))
    : [];
  const bindingRaw = input.binding && typeof input.binding === "object" ? input.binding : {};
  const binding = { agentId: typeof bindingRaw.agentId === "string" && bindingRaw.agentId ? bindingRaw.agentId : null };
  // d.125：模型目录与「后台任务模型」随同一份应答下发。
  // 目录是用户**已经能用**的模型（magpie `/v1/models`），不含价格——别在宿主里猜「最便宜」。
  const models = Array.isArray(input.models)
    ? input.models
        .filter((model) => model && typeof model.id === "string" && model.id)
        .slice(0, 200)
        .map((model) => ({
          id: String(model.id).slice(0, 128),
          name: text(model.name, 128) || String(model.id).slice(0, 128),
        }))
    : [];
  const backgroundRaw = typeof input.backgroundModel === "string" ? input.backgroundModel.trim() : "";
  // 只认目录里还在的模型：下架后残留的 id 会让引擎发一个必然 404 的请求
  const backgroundModel = backgroundRaw && models.some((m) => m.id === backgroundRaw) ? backgroundRaw : null;
  return { agents, binding, models, backgroundModel };
}

/**
 * @param {object} deps
 * @param {object} deps.BrowserWindow electron.BrowserWindow
 * @param {object} deps.Tray electron.Tray
 * @param {object} deps.Menu electron.Menu
 * @param {object} deps.nativeImage electron.nativeImage
 * @param {object} deps.screen electron.screen
 * @param {object} deps.ipcMain electron.ipcMain
 * @param {object} [deps.WebContentsView] electron.WebContentsView（d.124 页面视图；注入便于单测）
 * @param {object} deps.app electron.app（托盘「退出」用）
 * @param {object} deps.store plugin-store 实例（读状态/设置、当前版本目录）
 * @param {string} deps.preloadPath widget-preload.js 绝对路径
 * @param {string} [deps.defaultTrayIconPath] 插件没声明托盘图标时的兜底图标
 * @param {() => any} deps.getMainWindow 主窗口（渠道互斥与「打开设置」用）
 * @param {() => string} [deps.appVersion]
 * @param {() => ("light"|"dark")} [deps.getTheme]
 * @param {() => Promise<{baseUrl: string|null, key: string}>} [deps.getGateway] 本机 magpie 反代
 * @param {(timeoutMs: number) => Promise<object|null>} [deps.requestChatConfig] 向主窗请求 agents/binding
 * @param {(payload: object) => void} [deps.openPage] 主进程 → 主窗跳转（widgets:open-page）
 * @param {(method: string, params: any, options: { timeoutMs: number }) => Promise<any>} [deps.infohubRequest]
 *   信息中枢请求（contract §3；main.js 注入 infohubBridge 调用，单测可替换）
 * @param {(payload: object) => { delivered: string }} [deps.notifyPlugin]
 *   插件通知投递（contract §3；main.js 注入 plugin-notify，单测可替换）
 * @param {(line: string) => void} [deps.log]
 * @param {(fn: Function, ms: number) => any} [deps.setTimeout]
 * @param {(timer: any) => void} [deps.clearTimeout]
 * @param {() => number} [deps.now]
 */
function createWidgetHost(deps = {}) {
  const {
    BrowserWindow,
    Tray,
    Menu,
    nativeImage,
    screen,
    ipcMain,
    WebContentsView,
    app,
    store,
    preloadPath,
    defaultTrayIconPath,
    getMainWindow,
    appVersion = () => "",
    getTheme = () => "light",
    getGateway,
    requestChatConfig,
    openPage,
    // d.125：插件自带引擎（本机进程）。spawn 与内置解释器由 main.js 注入，便于单测替换。
    spawn,
    bundledPythonPath = null,
    getKbRoots,
    // contract §3：widget 桥的新语义由主进程注入。host 不直接依赖 infohub 实现与
    // 通知实现，单测可以替换这两条外部边界（也不必在 host 里 require Electron 的 Notification）。
    infohubRequest,
    notifyPlugin,
    log = () => {},
    setTimeout: setTimer = setTimeout,
    clearTimeout: clearTimer = clearTimeout,
    now = () => Date.now(),
  } = deps;

  if (!store) throw new Error("widget-host: 缺少 store");

  /** @type {Map<string, object>} key = `${pluginId}:${widgetId}` */
  const runtimes = new Map();
  let ipcRegistered = false;
  let displaysWatched = false;
  let theme = getTheme();
  let chatCache = null;

  /**
   * 当前挂载的**页面视图**（d.124 B 路径：界面插件自带的 HTML 页面）。
   *
   * 同一时刻只允许一个（产品上「每插件最多一个页面」，主窗同一时刻也只显示一页）；
   * `id/version/entry` 记下来供对账：插件停用/卸载/更新/页面入口变化 → 销毁视图。
   * 页面视图与 widget 窗口共用 `widget-preload.js` 桥，IPC 靠 sender 反查归属。
   */
  let pageInfo = null;

  /**
   * 后台常驻页的隐藏窗口（contract §1/§5）：一个插件最多一个，key = pluginId。
   *
   * 记录 `version/entry` 供对账：停用/卸载/版本或入口变化 → 销毁旧窗按新清单重建。
   * 窗口本身 `show:false` 且 `skipTaskbar`，用户看不见；它拿到的仍是同一份
   * `widget-preload.js` 桥（sender 反查归属，查不到就拒绝）。
   */
  const backgrounds = new Map();

  /**
   * 生命周期对账状态（d.108，规格 §5.4）。
   *
   * - `lifecycleKnown`：上一轮对账看到的每个插件状态（version/enabled/lifecycle 声明）；
   * - `lifecycleSeeded`：启动后第一轮只「补种」，启动前已装的插件不补发 installed；
   * - `pendingLifecycle`：窗口还没 did-finish-load 时先排队，加载完成再投递（不重放）；
   * - `retiring`：已发「最后一条」事件、销毁挪到下一 tick 的 runtime（让 IPC 出队）。
   */
  const lifecycleKnown = new Map();
  let lifecycleSeeded = false;
  const pendingLifecycle = new Map();
  const retiring = new Map();

  /* ───────────────────────── 公共小工具 ───────────────────────── */

  function workAreas() {
    try {
      return screen.getAllDisplays().map((d) => d.workArea);
    } catch {
      return [];
    }
  }

  function primaryArea() {
    try {
      return screen.getPrimaryDisplay().workArea;
    } catch {
      return { x: 0, y: 0, width: 1280, height: 800 };
    }
  }

  function mainWindowForeground() {
    const main = typeof getMainWindow === "function" ? getMainWindow() : null;
    if (!main || main.isDestroyed()) return false;
    try {
      return main.isVisible() === true && main.isMinimized() !== true && main.isFocused() === true;
    } catch {
      return false;
    }
  }

  function emitOpenPage(payload) {
    if (typeof openPage !== "function") return;
    try {
      openPage(payload);
    } catch (err) {
      log(`[widgets] 页面跳转失败：${(err && err.message) || err}`);
    }
  }

  /* ─────────────────────── chatConfig（主窗派生 + 缓存） ─────────────────────── */

  async function resolveGateway() {
    if (typeof getGateway !== "function") return { baseUrl: null, key: "local" };
    try {
      const gateway = await getGateway();
      const baseUrl = gateway && typeof gateway.baseUrl === "string" ? gateway.baseUrl : null;
      return { baseUrl, key: (gateway && typeof gateway.key === "string" && gateway.key) || "local" };
    } catch (err) {
      log(`[widgets] 网关信息不可用：${(err && err.message) || err}`);
      return { baseUrl: null, key: "local" };
    }
  }

  async function resolveChatExtras() {
    if (typeof requestChatConfig !== "function") return normalizeChatConfig(null);
    try {
      const result = await requestChatConfig(CHAT_CONFIG_TIMEOUT_MS);
      return normalizeChatConfig(result);
    } catch (err) {
      log(`[widgets] 主窗未提供 chatConfig：${(err && err.message) || err}`);
      return normalizeChatConfig(null);
    }
  }

  async function getChatConfig() {
    if (chatCache && now() - chatCache.at < CHAT_CONFIG_TTL_MS) return chatCache.value;
    const [gateway, extras] = await Promise.all([resolveGateway(), resolveChatExtras()]);
    const value = {
      gateway,
      agents: extras.agents,
      binding: extras.binding,
      models: extras.models,
      backgroundModel: extras.backgroundModel,
    };
    chatCache = { at: now(), value };
    return value;
  }

  /** 设置变更后立刻失效（用户改了绑定不必等 30s 缓存过期）。 */
  function invalidateChatConfig() {
    chatCache = null;
  }

  /* ─────────────────── 插件自带引擎（d.125，第一方 bundle 专用） ─────────────────── */

  /**
   * 引擎事件（`{event:"progress",…}`）只投给**该插件自己**的渲染面：页面视图与浮窗。
   * 别的插件收不到；没有引擎的插件也收不到（它们没有订阅通道）。
   */
  function sendEngineEvent(pluginId, payload) {
    let delivered = 0;
    if (pageInfo && pageInfo.id === pluginId && !pageInfo.closed) {
      try {
        pageInfo.webContents.send("widget:engine-event", payload);
        delivered += 1;
      } catch {
        /* 页面刚卸载 */
      }
    }
    for (const runtime of runtimes.values()) {
      if (runtime.pluginId !== pluginId) continue;
      const win = runtime.window;
      if (!win || win.isDestroyed()) continue;
      try {
        win.webContents.send("widget:engine-event", payload);
        delivered += 1;
      } catch {
        /* 窗口刚销毁 */
      }
    }
    return delivered;
  }

  const engineHost = createPluginEngine({
    spawn,
    bundledPythonPath,
    pluginDirFor: (id) => (typeof store.currentDir === "function" ? store.currentDir(id) : null),
    dataDirOf: (id) => store.dataDirOf(id),
    readSettings: (id) => store.readSettings(id),
    // 引擎拿到的网关/后台模型与页面 chatConfig 是同一份（缓存口径一致）
    getChatConfig,
    getKbRoots,
    appVersion: () => appVersion(),
    onEvent: (pluginId, payload) => sendEngineEvent(pluginId, payload),
    log,
    now,
    setTimeout: setTimer,
    clearTimeout: clearTimer,
  });

  /* ───────────────────────── 单个 widget 的运行时 ───────────────────────── */

  function createRuntime(record) {
    const pluginId = record.id;
    const spec = record.widget;
    const key = `${pluginId}:${spec.id}`;

    let win = null;
    let tray = null;
    let dragOrigin = null;
    let saveTimer = null;
    let interactive = false;
    /** 持久化状态：scale/bounds/visible + clickThrough（用户对「鼠标穿透」的意图）。 */
    let state = { scale: spec.defaultScale, bounds: null, visible: false, clickThrough: spec.clickThrough === "auto" };

    function loadState() {
      // store 已剥 BOM 并 JSON.parse；坏文件返回 null，clamp 会回落默认落位
      const raw = store.readState(pluginId);
      const clamped = clampWidgetState(spec, raw, workAreas(), primaryArea());
      state.scale = clamped.scale;
      state.bounds = clamped.bounds;
      state.visible = clamped.visible;
      if (spec.clickThrough === "auto") {
        // 只认严格的 false：缺字段/坏值一律当作「要穿透」（与 pet 时代同口径）
        state.clickThrough = !(raw && typeof raw === "object" && raw.clickThrough === false);
      } else {
        state.clickThrough = false;
      }
    }

    function scheduleSave() {
      if (saveTimer) clearTimer(saveTimer);
      saveTimer = setTimer(() => {
        saveTimer = null;
        saveNow();
      }, SAVE_DEBOUNCE_MS);
    }

    function saveNow() {
      if (win && !win.isDestroyed()) {
        try {
          state.bounds = win.getBounds();
        } catch {
          /* 窗口正在销毁：保留上一次的 bounds */
        }
      }
      try {
        store.writeState(pluginId, {
          scale: state.scale,
          bounds: state.bounds,
          visible: state.visible,
          clickThrough: state.clickThrough,
        });
      } catch (err) {
        log(`[widgets:${pluginId}] 状态落盘失败：${(err && err.message) || err}`);
      }
    }

    /* ── 穿透 ── */

    function applyMouseIgnore() {
      if (!win || win.isDestroyed()) return;
      const shouldIgnore = state.clickThrough ? !interactive : false;
      try {
        win.setIgnoreMouseEvents(shouldIgnore, { forward: true });
      } catch (err) {
        // 个别平台不支持 forward：退化成不带选项，至少保证不挡住桌面
        log(`[widgets:${pluginId}] setIgnoreMouseEvents 带 forward 失败，退化：${(err && err.message) || err}`);
        try {
          win.setIgnoreMouseEvents(shouldIgnore);
        } catch {
          /* 完全失败：留给托盘「关闭穿透」兜底 */
        }
      }
    }

    function setInteractive(next) {
      const want = next === true;
      if (want === interactive) return;
      interactive = want;
      applyMouseIgnore();
    }

    function setClickThrough(next) {
      // 规格 clickThrough:"none" 的窗口没有穿透这回事（托盘菜单也不会给这一项）
      if (spec.clickThrough !== "auto") return state.clickThrough;
      state.clickThrough = next === true;
      if (!state.clickThrough) interactive = false;
      applyMouseIgnore();
      scheduleSave();
      refreshTrayMenu();
      return state.clickThrough;
    }

    /* ── 窗口 ── */

    function currentBounds() {
      if (win && !win.isDestroyed()) {
        try {
          return win.getBounds();
        } catch {
          /* 落到下面的 state */
        }
      }
      return (
        state.bounds || {
          ...defaultWidgetPosition(spec, primaryArea(), widgetWindowSize(spec, state.scale)),
          ...widgetWindowSize(spec, state.scale),
        }
      );
    }

    function setPaused(paused) {
      // 隐藏窗不该白烧 rAF：Electron 的 backgroundThrottling 是可控开关（规格 §3.3）。
      // paused=true 表示「暂停渲染」→ 打开节流；显示时关掉节流（透明窗首帧不能卡）。
      if (!win || win.isDestroyed()) return;
      try {
        win.webContents.setBackgroundThrottling(paused === true);
      } catch {
        /* 测试替身/旧版本没有这个方法：忽略 */
      }
    }

    function createWindow() {
      if (win && !win.isDestroyed()) return win;

      const url = widgetUrl(pluginId, spec.entry);
      win = new BrowserWindow(widgetWindowOptions(spec, state, preloadPath));

      // ── 导航闸：widget 只能停留在**自己插件的 origin** 内 ──
      // 独立 scheme 已经让插件读不到主窗 localStorage；这里再挡一层 window.open/外链，
      // 免得插件页把自己导航到远端后把 preload 桥交给远端脚本（与 pet-host 同口径，fail-closed）。
      const wc = win.webContents;
      if (wc && typeof wc.on === "function") {
        wc.on("will-navigate", (event, target) => {
          if (isSameWidgetOrigin(target, pluginId)) return;
          log(`[widgets:${pluginId}] 拦截离开插件页面的导航：${target}`);
          event.preventDefault();
        });
      }
      if (wc && typeof wc.setWindowOpenHandler === "function") {
        wc.setWindowOpenHandler(({ url: target }) => {
          log(`[widgets:${pluginId}] 拦截插件窗口的新窗口请求：${target}`);
          return { action: "deny" };
        });
      }

      // 首次打开就穿透：不能让一块透明层凭空挡住桌面点击
      applyMouseIgnore();
      setPaused(!state.visible);

      win.on("move", () => {
        if (dragOrigin) return; // 拖拽期间不落盘，抬起时统一写
        scheduleSave();
      });
      win.on("closed", () => {
        win = null;
        interactive = false;
        refreshTrayMenu();
      });
      win.webContents.on("did-finish-load", () => {
        // 重载后渲染层的 interactive 状态归零，主进程也要对齐，否则会卡在"不穿透"
        interactive = false;
        applyMouseIgnore();
        // 生命周期事件：窗口没建好时排队，页面加载完成再投递（取走即清空 → 重载不重放）
        for (const payload of takeLifecycle(key)) {
          try {
            win.webContents.send(LIFECYCLE_CHANNEL, payload);
          } catch {
            /* 窗口刚被销毁：丢弃，不重放 */
          }
        }
      });

      if (url) win.loadURL(url);
      else log(`[widgets:${pluginId}] 入口非法，无法加载`);
      return win;
    }

    function show(options) {
      const silent = !(options && options.silent === false);
      if (!win || win.isDestroyed()) createWindow();
      if (!win) return;
      state.visible = true;
      setPaused(false);
      if (silent) {
        // 不抢焦点：用户可能正在别处打字，窗口出现不该打断
        win.showInactive();
      } else {
        win.show();
        win.focus();
      }
      scheduleSave();
      refreshTrayMenu();
    }

    function hide() {
      state.visible = false;
      if (win && !win.isDestroyed()) win.hide();
      setPaused(true);
      saveNow();
      refreshTrayMenu();
    }

    function toggle() {
      if (state.visible && win && !win.isDestroyed() && win.isVisible()) hide();
      else show();
    }

    function reload() {
      if (win && !win.isDestroyed()) win.webContents.reload();
    }

    function destroy() {
      if (saveTimer) {
        clearTimer(saveTimer);
        saveTimer = null;
      }
      if (win && !win.isDestroyed()) {
        saveNow();
        win.destroy();
      }
      win = null;
      if (tray) {
        tray.destroy();
        tray = null;
      }
      dragOrigin = null;
      interactive = false;
    }

    /* ── 显示器变化 ── */

    function handleDisplayChange() {
      if (!win || win.isDestroyed()) return;
      if (dragOrigin) return;
      let bounds = null;
      try {
        bounds = win.getBounds();
      } catch {
        return;
      }
      const size = widgetWindowSize(spec, state.scale);
      if (bounds.width === size.width && bounds.height === size.height) return;
      win.setBounds({
        x: bounds.x + (bounds.width - size.width),
        y: bounds.y + (bounds.height - size.height),
        width: size.width,
        height: size.height,
      });
      scheduleSave();
    }

    /* ── 缩放 ── */

    function resizeTo(next) {
      if (!win || win.isDestroyed()) return;
      const size = widgetWindowSize(spec, next);
      const b = win.getBounds();
      // 从右下角缩放：保持窗口右下角不动，视觉上像"长大"而不是"跳位置"
      win.setBounds({
        x: b.x + (b.width - size.width),
        y: b.y + (b.height - size.height),
        width: size.width,
        height: size.height,
      });
    }

    function setScale(payload) {
      const next =
        payload && typeof payload === "object" && payload.dir !== undefined
          ? nextScale(spec, state.scale, payload.dir)
          : normalizeScale(spec, payload);
      if (next === state.scale) return state.scale;
      state.scale = next;
      resizeTo(next);
      scheduleSave();
      refreshTrayMenu();
      return state.scale;
    }

    function stepScale(dir) {
      return setScale(nextScale(spec, state.scale, dir));
    }

    function resetPosition() {
      if (!win || win.isDestroyed()) return false;
      const size = widgetWindowSize(spec, state.scale);
      const target = defaultWidgetPosition(spec, primaryArea(), size);
      const moved = moveWindowTo(target);
      // 即便位置恰好没变也落一次盘：这条动作的语义是「把当前位置变成期望值」
      saveNow();
      return moved;
    }

    /* ── 拖拽 ── */

    /**
     * 把窗口移到目标位置，**位置没变就什么都不做**。
     *
     * ★ 透明置顶窗每调一次 setPosition，DWM 都要重新合成一次该窗口。渲染层已按 rAF
     *   合并上报，但仍会有"光标停住、脚本继续发移动"的帧；这些重复位置以前会照样调
     *   setPosition，等于让系统反复重合成同一块透明层，是拖动残影/边缘闪烁的来源之一。
     */
    function moveWindowTo(pos) {
      if (!pos || !win || win.isDestroyed()) return false;
      let bounds = null;
      try {
        bounds = win.getBounds();
      } catch {
        /* 窗口正在销毁：当作位置未知，照常设一次 */
      }
      if (bounds && bounds.x === pos.x && bounds.y === pos.y) return false;
      win.setPosition(pos.x, pos.y);
      return true;
    }

    function beginDrag() {
      if (!win || win.isDestroyed()) return;
      const cursor = screen.getCursorScreenPoint();
      const b = win.getBounds();
      dragOrigin = {
        cursorX: cursor.x,
        cursorY: cursor.y,
        windowX: b.x,
        windowY: b.y,
        lastX: cursor.x,
        lastY: cursor.y,
      };
    }

    function dragTo() {
      if (!dragOrigin || !win || win.isDestroyed()) return;
      const cursor = screen.getCursorScreenPoint();
      if (!cursor || !Number.isFinite(cursor.x) || !Number.isFinite(cursor.y)) return;
      // 光标没动就直接返回：拖拽期间仍会有「光标停住、脚本继续发移动」的帧，
      // 连 getBounds/setPosition 都不该做（每一次 setPosition 都是一次透明层合成）。
      if (cursor.x === dragOrigin.lastX && cursor.y === dragOrigin.lastY) return;
      dragOrigin.lastX = cursor.x;
      dragOrigin.lastY = cursor.y;
      const pos = draggedPosition(dragOrigin, cursor);
      if (!pos) return;
      moveWindowTo(pos);
    }

    function endDrag() {
      if (!dragOrigin) return;
      const origin = dragOrigin;
      // 先清起点：下面的 setPosition 会触发 move 事件，那不该再被当成"拖拽中"而跳过落盘
      dragOrigin = null;
      if (!win || win.isDestroyed()) {
        saveNow();
        return;
      }
      // 抬起补一次终值：渲染层最后一次 rAF 合并可能还没执行，按此刻光标的真实位置对齐
      const cursor = screen.getCursorScreenPoint();
      const pos = draggedPosition(origin, cursor);
      if (pos) {
        let bounds = null;
        try {
          bounds = win.getBounds();
        } catch {
          bounds = null;
        }
        const settled = settleWidgetPosition(
          spec,
          pos,
          {
            width: bounds ? bounds.width : widgetWindowSize(spec, state.scale).width,
            height: bounds ? bounds.height : widgetWindowSize(spec, state.scale).height,
          },
          workAreas(),
        );
        if (settled) moveWindowTo(settled);
      }
      saveNow();
    }

    /* ── 托盘 ── */

    function trayIconPath() {
      const base = typeof store.currentDir === "function" ? store.currentDir(pluginId) : null;
      const rel = spec.tray.icon || spec.icon;
      if (base && rel) return path.join(base, rel);
      return defaultTrayIconPath || null;
    }

    function trayTemplate() {
      const visible = state.visible && win && !win.isDestroyed() && win.isVisible();
      const items = [];
      for (const item of spec.tray.items) {
        if (item === "toggle") {
          items.push({ label: visible ? `隐藏${spec.name}` : `显示${spec.name}`, click: () => toggle() });
        } else if (item === "clickThrough" && spec.clickThrough === "auto") {
          items.push({
            label: "鼠标穿透（不挡桌面点击）",
            type: "checkbox",
            checked: state.clickThrough,
            click: (menuItem) => setClickThrough(menuItem.checked),
          });
        } else if (item === "resetPosition") {
          items.push({ label: "重置位置", click: () => resetPosition() });
        } else if (item === "scaleUp") {
          items.push({ label: "放大一档", click: () => stepScale(1) });
        } else if (item === "scaleDown") {
          items.push({ label: "缩小一档", click: () => stepScale(-1) });
        } else if (item === "settings") {
          items.push({
            label: "设置…",
            click: () => emitOpenPage({ page: "settings", settingsTab: SETTINGS_TAB, pluginId }),
          });
        }
      }
      if (items.length > 0) items.push({ type: "separator" });
      items.push({
        label: "打开和鸣主窗口",
        click: () => focusMainWindow(),
      });
      items.push({ type: "separator" });
      items.push({ label: "退出", click: () => app && app.quit && app.quit() });
      return items;
    }

    function refreshTrayMenu() {
      if (!tray) return;
      try {
        tray.setContextMenu(Menu.buildFromTemplate(trayTemplate()));
      } catch (err) {
        log(`[widgets:${pluginId}] 托盘菜单刷新失败：${(err && err.message) || err}`);
      }
    }

    function createTray() {
      if (tray) return tray;
      let image;
      try {
        const iconPath = trayIconPath();
        image = iconPath && nativeImage.createFromPath ? nativeImage.createFromPath(iconPath) : nativeImage.createEmpty();
      } catch {
        image = nativeImage.createEmpty();
      }
      tray = new Tray(image);
      tray.setToolTip(spec.name || pluginId);
      refreshTrayMenu();
      // 左键点托盘 = 显隐（与菜单首项同一语义，少一次点击）
      tray.on("click", () => toggle());
      return tray;
    }

    function focusMainWindow() {
      const main = typeof getMainWindow === "function" ? getMainWindow() : null;
      if (!main || main.isDestroyed()) return;
      try {
        if (main.isMinimized()) main.restore();
        main.show();
        main.focus();
      } catch {
        /* 窗口正在销毁 */
      }
    }

    function statePayload() {
      return { visible: state.visible, scale: state.scale, clickThrough: state.clickThrough };
    }

    return {
      key,
      pluginId,
      spec,
      record,
      get window() {
        return win;
      },
      get state() {
        return { ...state };
      },
      get isInteractive() {
        return interactive;
      },
      loadState,
      createTray,
      refreshTrayMenu,
      createWindow,
      show,
      hide,
      toggle,
      reload,
      destroy,
      setScale,
      stepScale,
      setClickThrough,
      setInteractive,
      resetPosition,
      handleDisplayChange,
      statePayload,
      saveNow,
      _internal: { beginDrag, dragTo, endDrag, applyMouseIgnore, setPaused, isDragging: () => dragOrigin !== null },
    };
  }

  /* ───────────────────────── 页面视图运行时（d.124 B 路径） ───────────────────────── */

  /**
   * 主窗内容区尺寸（DIP）。rect 的坐标系就是 `win.contentView`：左上角 (0,0)，
   * 单位 DIP（主窗 `zoomFactor` 恒为 1，见 main.js），所以这里直接拿 contentBounds 的宽高。
   */
  function pageContentSize(main) {
    try {
      const bounds = typeof main.getContentBounds === "function" ? main.getContentBounds() : main.getBounds();
      if (bounds && Number.isFinite(bounds.width) && Number.isFinite(bounds.height)) {
        const width = Math.round(bounds.width);
        const height = Math.round(bounds.height);
        if (width > 0 && height > 0) return { width, height };
      }
    } catch {
      /* 窗口正在销毁：没有可信的内容区尺寸 */
    }
    return null;
  }

  /**
   * 钳制页面视图 rect（规格 §5.3）：宽高 ≥1，越出内容区的部分裁掉。
   *
   * 渲染层上报的是 `getBoundingClientRect()`（DIP），窗口缩放/DPI 变化时可能短暂越界；
   * 一律在主进程收口，不让 WebContentsView 画到侧栏/标题栏上或负坐标处。
   */
  function clampPageRect(raw, main) {
    const input = raw && typeof raw === "object" && !Array.isArray(raw) ? raw : {};
    const round = (value, fallback) =>
      typeof value === "number" && Number.isFinite(value) ? Math.round(value) : fallback;
    let x = Math.max(0, round(input.x, 0));
    let y = Math.max(0, round(input.y, 0));
    let width = Math.max(PAGE_MIN_SIZE, round(input.width, PAGE_MIN_SIZE));
    let height = Math.max(PAGE_MIN_SIZE, round(input.height, PAGE_MIN_SIZE));
    const content = main ? pageContentSize(main) : null;
    if (content) {
      x = Math.min(x, content.width - PAGE_MIN_SIZE);
      y = Math.min(y, content.height - PAGE_MIN_SIZE);
      width = Math.min(width, content.width - x);
      height = Math.min(height, content.height - y);
    }
    return {
      x,
      y,
      width: Math.max(PAGE_MIN_SIZE, width),
      height: Math.max(PAGE_MIN_SIZE, height),
    };
  }

  /**
   * 页面视图的 webPreferences：与 widget 窗口**同级**的沙箱配置（规格 §2.2 / §5.1）。
   *
   * CSP 不在这里：`widget://` 的响应头由 main.js 的协议处理器按
   * `widgetCspHeaders(record.permissions)` 生成，页面与浮窗共用同一套网络白名单。
   */
  function pageWebPreferences() {
    return {
      preload: preloadPath,
      sandbox: true,
      contextIsolation: true,
      nodeIntegration: false,
      spellcheck: false,
      // preload 据此把「窗口几何类」API 变成明确的不支持（页面没有独立窗口）
      additionalArguments: [PAGE_VIEW_FLAG],
    };
  }

  /** 导航/开窗/下载守卫：页面只能在 `widget://<id>/` 内翻页，不能开新窗、不能下载。 */
  function attachPageGuards(info) {
    const wc = info.webContents;
    if (wc && typeof wc.on === "function") {
      const guardNavigation = (event, target) => {
        if (isSameWidgetOrigin(target, info.id)) return;
        log(`[widgets:${info.id}] 拦截插件页面离开自身 origin 的导航：${target}`);
        event.preventDefault();
      };
      wc.on("will-navigate", guardNavigation);
      wc.on("will-redirect", guardNavigation);
      wc.on("did-fail-load", (_event, code, description, url, isMainFrame) => {
        // 子资源失败不算页面失败（404 的图片不该被当成「页面坏了」）
        if (isMainFrame === false) return;
        log(`[widgets:${info.id}] 插件页面加载失败（${code} ${description}）：${url}`);
      });
    }
    if (wc && typeof wc.setWindowOpenHandler === "function") {
      wc.setWindowOpenHandler(({ url: target }) => {
        log(`[widgets:${info.id}] 拦截插件页面的新窗口请求：${target}`);
        return { action: "deny" };
      });
    }
    // will-download 是 session 级事件：按「发起下载的 webContents」过滤，别误伤同 session 的主窗。
    const session = wc && wc.session;
    if (session && typeof session.on === "function") {
      const onWillDownload = (event, item, sender) => {
        if (sender && sender !== wc) return;
        const target = item && typeof item.getURL === "function" ? item.getURL() : "";
        log(`[widgets:${info.id}] 拦截插件页面下载：${target}`);
        try {
          event.preventDefault();
        } catch {
          /* 事件对象异常：至少已记录 */
        }
      };
      try {
        session.on("will-download", onWillDownload);
        info.detachDownload = () => {
          try {
            session.removeListener("will-download", onWillDownload);
          } catch {
            /* session 已销毁 */
          }
        };
      } catch (err) {
        log(`[widgets:${info.id}] 页面下载守卫挂载失败：${(err && err.message) || err}`);
      }
    }
  }

  /**
   * 销毁当前页面视图（幂等）。顺序：先从 contentView 摘掉，再 close webContents。
   * 只 removeChildView 不 close 会留下一个没有宿主的渲染进程（内存/进程孤儿）。
   */
  function destroyPageView() {
    const info = pageInfo;
    pageInfo = null;
    if (!info) return false;
    info.closed = true;
    if (typeof info.detachDownload === "function") info.detachDownload();
    const main = typeof getMainWindow === "function" ? getMainWindow() : null;
    if (main && !main.isDestroyed() && main.contentView && typeof main.contentView.removeChildView === "function") {
      try {
        main.contentView.removeChildView(info.view);
      } catch (err) {
        log(`[widgets:${info.id}] 移除页面视图失败：${(err && err.message) || err}`);
      }
    }
    try {
      const wc = info.webContents;
      if (wc && typeof wc.close === "function") wc.close();
    } catch (err) {
      log(`[widgets:${info.id}] 关闭页面视图失败：${(err && err.message) || err}`);
    }
    return true;
  }

  /**
   * 挂载插件页面视图（`widgets:page-mount`）：
   * 「先销毁旧视图 → 找已装且启用的 bundle 记录 → 建 WebContentsView → 嵌进主窗内容区」。
   *
   * `payload.intent` 是首页卡快捷入口带来的目标视角：合法 token 会以
   * `#intent=<token>` 拼进入口地址，由插件页自己读 location.hash 解释
   * （宿主不理解语义）；不合法就当没带，不影响页面正常挂载。
   *
   * 返回 `{ ok:true }` 或 `{ ok:false, error }`（error 已是可直接展示的中文）；
   * 加载失败也会把刚建的视图销毁——失败不留一块白屏/空视图。
   */
  async function pageMount(payload) {
    const id =
      payload && typeof payload === "object" && typeof payload.id === "string" ? payload.id.trim() : "";
    if (!id) return { ok: false, error: "页面挂载失败：缺少插件 id" };
    const intent = normalizePageIntent(payload && payload.intent);

    const record = typeof store.get === "function" ? store.get(id) : null;
    if (!record) return { ok: false, error: `页面挂载失败：插件未安装（${id}）` };
    if (record.error) return { ok: false, error: `页面挂载失败：${record.error}` };
    if (record.enabled !== true) {
      return { ok: false, error: `页面挂载失败：插件「${record.name || id}」已停用，启用后才能显示页面` };
    }
    const spec = record.page;
    if (!spec || typeof spec !== "object") {
      return { ok: false, error: `页面挂载失败：插件「${record.name || id}」没有声明页面（contributions.page）` };
    }
    const main = typeof getMainWindow === "function" ? getMainWindow() : null;
    if (!main || main.isDestroyed()) return { ok: false, error: "页面挂载失败：主窗口不可用" };
    if (!main.contentView || typeof main.contentView.addChildView !== "function") {
      return { ok: false, error: "页面挂载失败：主窗口不支持内容视图" };
    }
    if (typeof WebContentsView !== "function") {
      return { ok: false, error: "页面挂载失败：当前 Electron 版本不支持 WebContentsView" };
    }
    // 再归一化一次入口：落盘清单可能被外部改过，不能假设 store 里的值一定合法
    const url = widgetUrl(id, spec.entry);
    if (!url) return { ok: false, error: `页面挂载失败：页面入口非法（${String(spec.entry)}）` };
    const targetUrl = intent ? `${url}#intent=${intent}` : url;

    const rect = clampPageRect(payload.rect, main);
    // 先销毁旧视图：切插件/重进页面/更新后重建都走同一入口，同一时刻只留一个页面视图
    destroyPageView();

    let view;
    try {
      view = new WebContentsView({ webPreferences: pageWebPreferences() });
    } catch (err) {
      return { ok: false, error: `页面挂载失败：无法创建页面视图（${(err && err.message) || err}）` };
    }

    const info = {
      id,
      version: record.version,
      entry: spec.entry,
      record,
      view,
      webContents: view.webContents,
      rect,
      intent,
      closed: false,
      detachDownload: null,
    };
    pageInfo = info;
    attachPageGuards(info);

    try {
      main.contentView.addChildView(view);
      if (typeof view.setBounds === "function") view.setBounds(rect);
    } catch (err) {
      destroyPageView();
      return { ok: false, error: `页面挂载失败：无法嵌入主窗（${(err && err.message) || err}）` };
    }

    try {
      await info.webContents.loadURL(targetUrl);
    } catch (err) {
      // 加载失败：只要还是当前视图就销毁，回错误让 web 显示错误态而不是白屏
      if (pageInfo === info) destroyPageView();
      return { ok: false, error: `页面加载失败：${(err && err.message) || err}` };
    }
    // 加载期间用户已经切页/卸载：不要谎报成功，也不要去动别人的新视图
    if (pageInfo !== info) return { ok: false, error: "页面已卸载（加载期间离开了页面）" };
    return { ok: true };
  }

  /** 更新页面视图边界（`widgets:page-bounds`，fire-and-forget；主进程自己钳制）。 */
  function pageBounds(payload) {
    const info = pageInfo;
    if (!info) return false;
    const main = typeof getMainWindow === "function" ? getMainWindow() : null;
    if (!main || main.isDestroyed()) {
      destroyPageView();
      return false;
    }
    const rect = clampPageRect(payload && payload.rect, main);
    try {
      info.view.setBounds(rect);
    } catch (err) {
      log(`[widgets:${info.id}] 更新页面视图边界失败：${(err && err.message) || err}`);
      return false;
    }
    info.rect = rect;
    return true;
  }

  /** 卸载页面视图（`widgets:page-unmount`，重复调用无害）。 */
  function pageUnmount() {
    return destroyPageView();
  }

  /**
   * 页面视图对账：插件停用/卸载/更新/页面入口变化 → 立即销毁（规格 §5.1 / §7）。
   * 由 `reconcile()` 每轮调用；返回是否真的销毁了视图。
   */
  function syncPageView() {
    const info = pageInfo;
    if (!info) return false;
    const record = typeof store.get === "function" ? store.get(info.id) : null;
    const page = record && record.page;
    const alive =
      record && record.enabled === true && !record.error && page && page.entry === info.entry;
    if (!alive || record.version !== info.version) {
      destroyPageView();
      return true;
    }
    return false;
  }

  /* ───────────────────────── 后台常驻页（contract §1/§5） ───────────────────────── */

  /**
   * 后台常驻页的 webPreferences。
   *
   * 与页面视图同级（sandbox + contextIsolation + 无 nodeIntegration），区别只有两点：
   * 1) 标记参数是 `--heming-widget-mode=background`，preload 据此把它当「没有独立窗口」处理；
   * 2) 关掉 `backgroundThrottling`——隐藏窗口默认会被 Chromium 降频，定时同步/轮询会漂移，
   *    而后台页存在的意义就是「按时跑」。
   */
  function backgroundWebPreferences() {
    return {
      preload: preloadPath,
      sandbox: true,
      contextIsolation: true,
      nodeIntegration: false,
      spellcheck: false,
      backgroundThrottling: false,
      additionalArguments: [BACKGROUND_FLAG],
    };
  }

  /** 销毁一个插件的后台隐藏窗（重复调用无害）。 */
  function destroyBackground(pluginId) {
    const info = backgrounds.get(pluginId);
    if (!info) return false;
    backgrounds.delete(pluginId);
    info.closed = true;
    if (typeof info.detachDownload === "function") {
      try {
        info.detachDownload();
      } catch {
        /* session 已销毁：忽略 */
      }
    }
    try {
      if (info.window && !info.window.isDestroyed()) info.window.destroy();
    } catch (err) {
      log(`[widgets:${pluginId}] 后台常驻页关闭失败：${(err && err.message) || err}`);
    }
    return true;
  }

  /** 退出时统一关闭所有后台隐藏窗（destroyAll 调用，避免退出时残留渲染进程）。 */
  function destroyAllBackgrounds() {
    for (const pluginId of [...backgrounds.keys()]) destroyBackground(pluginId);
  }

  /**
   * 给一个插件建后台隐藏窗并加载它的 `contributions.background.entry`。
   *
   * 与 widget 窗口不同：不建托盘、不读窗口状态、用户不可见；只提供一块常驻渲染面
   * （automations 的定时器、infohub 的后台同步都靠它）。入口非法/创建失败只记日志，
   * 不影响插件其余贡献（首页卡片、页面）可用。
   */
  function createBackgroundRuntime(record) {
    const background = record.background;
    if (!background || !background.entry) return null;
    if (typeof BrowserWindow !== "function") return null;
    const url = widgetUrl(record.id, background.entry);
    if (!url) {
      log(`[widgets:${record.id}] 后台页入口非法，已跳过：${String(background.entry)}`);
      return null;
    }
    let win;
    try {
      win = new BrowserWindow({
        show: false,
        width: BACKGROUND_WIDTH,
        height: BACKGROUND_HEIGHT,
        skipTaskbar: true,
        autoHideMenuBar: true,
        webPreferences: backgroundWebPreferences(),
      });
    } catch (err) {
      log(`[widgets:${record.id}] 后台常驻页创建失败：${(err && err.message) || err}`);
      return null;
    }
    const info = {
      id: record.id,
      version: record.version,
      entry: background.entry,
      record,
      window: win,
      webContents: win.webContents,
      closed: false,
      detachDownload: null,
    };
    // 同一套导航/下载闸：后台页也不能自己跳去外网或静默下载文件
    attachPageGuards(info);
    backgrounds.set(record.id, info);
    try {
      const pending = win.loadURL(url);
      if (pending && typeof pending.catch === "function") {
        pending.catch((err) => {
          info.loadError = (err && err.message) || String(err);
          log(`[widgets:${record.id}] 后台常驻页加载失败：${info.loadError}`);
        });
      }
    } catch (err) {
      info.loadError = (err && err.message) || String(err);
      log(`[widgets:${record.id}] 后台常驻页加载失败：${info.loadError}`);
    }
    win.on("closed", () => {
      info.closed = true;
      if (backgrounds.get(record.id) === info) backgrounds.delete(record.id);
      log(`[widgets:${record.id}] 后台常驻页已关闭`);
    });
    log(`[widgets] ${record.id} 后台常驻页已启动（${background.entry}）`);
    return info;
  }

  /**
   * 后台常驻页对账（contract §5）：`enabled`、文件完好、声明了 background 才该有窗口。
   *
   * 停用/卸载/版本或入口变化 → 销毁；缺的补建。失败只记日志：某个插件的后台页起不来，
   * 不该拖垮宿主其余插件的对账。
   */
  function syncBackgroundViews(records) {
    const desired = new Map();
    for (const record of Array.isArray(records) ? records : []) {
      if (!record || record.enabled !== true || record.error) continue;
      if (!record.background || !record.background.entry) continue;
      desired.set(record.id, record);
    }
    for (const [pluginId, info] of [...backgrounds.entries()]) {
      const next = desired.get(pluginId);
      const stale =
        !next || next.version !== info.version || next.background.entry !== info.entry;
      if (stale) destroyBackground(pluginId);
    }
    for (const [pluginId, record] of desired) {
      if (backgrounds.has(pluginId)) continue;
      createBackgroundRuntime(record);
    }
    return backgrounds.size;
  }

  /** 按 sender 反查后台常驻页（查不到 = 不是后台页；fail-closed）。 */
  function backgroundTargetForEvent(event) {
    const sender = event && event.sender;
    if (!sender) return null;
    for (const info of backgrounds.values()) {
      if (info.closed) continue;
      if (info.webContents !== sender) continue;
      return {
        isBackground: true,
        pluginId: info.id,
        record: info.record,
        webContents: info.webContents,
      };
    }
    return null;
  }

  /* ── 首页卡片 / 信息中枢 / 通知的宿主侧数据源（contract §3/§4） ── */

  /** 超时参数收口：非数字 → 默认 60s；夹在 1s..30min（与 engineCall 同口径）。 */
  function clampInfohubTimeout(value) {
    const ms = Number(value);
    if (!Number.isFinite(ms) || ms <= 0) return INFOHUB_TIMEOUT_DEFAULT;
    return Math.min(INFOHUB_TIMEOUT_MAX, Math.max(INFOHUB_TIMEOUT_MIN, Math.round(ms)));
  }

  /** 把一张合并后的卡片推给主窗（首页即时刷新）；主窗不在就跳过，下次拉列表自然是新值。 */
  function broadcastHomeCard(card) {
    const win = typeof getMainWindow === "function" ? getMainWindow() : null;
    if (!win) return false;
    try {
      if (typeof win.isDestroyed === "function" && win.isDestroyed()) return false;
    } catch {
      return false;
    }
    const wc = win.webContents;
    if (!wc || (typeof wc.isDestroyed === "function" && wc.isDestroyed())) return false;
    try {
      wc.send("plugin:homecard", card);
      return true;
    } catch (err) {
      log(`[widgets] 首页卡片广播失败：${(err && err.message) || err}`);
      return false;
    }
  }

  /**
   * 主窗 `plugins:homecards` 的数据源（contract §4）。
   *
   * 只返回「已安装 + enabled + 文件完好」的卡片；`text/detail/badge` 用 data 里的覆盖值，
   * 缺省回落到清单里的 `primary`——这样插件即使从没调过 homeCardSet 也有可读文案。
   */
  function homeCards() {
    return collectCards(store.list(), (pluginId, key) => store.readData(pluginId, key));
  }

  /** 按 sender 反查页面视图（查不到 = 不是页面视图；fail-closed）。 */
  function pageTargetForEvent(event) {
    const info = pageInfo;
    const sender = event && event.sender;
    if (!info || !sender || info.closed) return null;
    if (sender !== info.webContents) return null;
    return {
      isPage: true,
      pluginId: info.id,
      record: info.record,
      view: info.view,
      webContents: info.webContents,
    };
  }

  /** widget 运行时对应的 webContents（页面目标直接带 webContents）。 */
  function targetWebContents(target) {
    if (!target) return null;
    if (target.webContents) return target.webContents;
    const win = target.window;
    if (!win || win.isDestroyed()) return null;
    return win.webContents;
  }

  /**
   * 把一份最新设置推给该插件的所有渲染面（widget 窗口 + 页面视图）。
   * 主窗设置区改设置、插件页面自己 setSetting 都走这里，避免「一个界面热更新、另一个不更新」。
   */
  function notifySettings(pluginId, next) {
    let delivered = 0;
    for (const runtime of runtimes.values()) {
      if (runtime.pluginId !== pluginId) continue;
      const wc = targetWebContents(runtime);
      if (!wc) continue;
      try {
        wc.send("widget:settings", next);
        delivered += 1;
      } catch {
        /* 窗口刚销毁：丢弃 */
      }
    }
    if (pageInfo && pageInfo.id === pluginId) {
      try {
        pageInfo.webContents.send("widget:settings", next);
        delivered += 1;
      } catch {
        /* 页面刚卸载：丢弃 */
      }
    }
    const background = backgrounds.get(pluginId);
    if (background && !background.closed) {
      try {
        background.webContents.send("widget:settings", next);
        delivered += 1;
      } catch {
        /* 后台页刚关闭：丢弃 */
      }
    }
    return delivered;
  }

  /**
   * 页面视图**不支持**的 IPC：窗口几何/拖拽/穿透类。
   *
   * 这些通道在 widget 窗口上由 `withRuntime` 按 sender 反查后执行；页面视图虽然也登记
   * 了 sender 映射（info/settings/data 可用），但**没有独立窗口**，所以这里显式拒绝并
   * 留日志，而不是让调用静默地什么也没做。
   */
  function rejectPageWindowOp(event, channel) {
    const page = pageTargetForEvent(event);
    if (!page) {
      // 后台常驻页同样没有独立窗口：几何/拖拽/穿透一律拒绝（contract §5）
      const background = backgroundTargetForEvent(event);
      if (!background) return false;
      log(`[widgets:${background.pluginId}] 后台常驻页不支持窗口操作通道：${channel}`);
      return true;
    }
    log(`[widgets:${page.pluginId}] 页面视图不支持窗口操作通道：${channel}`);
    return true;
  }

  /* ───────────────────────── IPC（一次注册，按 sender 分发） ───────────────────────── */

  /** 反查：这个 event.sender 属于哪个 widget 窗口；查不到 = 拒绝（fail-closed）。 */
  function runtimeForEvent(event) {
    const sender = event && event.sender;
    if (!sender) return null;
    for (const runtime of runtimes.values()) {
      const win = runtime.window;
      if (!win || win.isDestroyed()) continue;
      try {
        if (BrowserWindow.fromWebContents(sender) === win) return runtime;
      } catch {
        /* 比较失败：当作不匹配 */
      }
    }
    return null;
  }

  function withRuntime(event, fn, denied) {
    const runtime = runtimeForEvent(event);
    if (!runtime) return denied;
    return fn(runtime);
  }

  /**
   * 同时接受 widget 窗口与页面视图的通道（info/settings/data/openPage/log…）。
   *
   * 页面视图登记在 `pageTargetForEvent` 里（不是 BrowserWindow），所以不能走
   * `runtimeForEvent`；两条路都查不到 = 拒绝（fail-closed，与 d.98 同一纪律）。
   */
  function withRuntimeOrPage(event, fn, denied) {
    const runtime = runtimeForEvent(event);
    if (runtime) return fn(runtime);
    const page = pageTargetForEvent(event);
    if (page) return fn(page);
    // 后台常驻页也是「没有独立窗口的渲染面」，data/infohub/notify/homeCardSet 都要认
    const background = backgroundTargetForEvent(event);
    if (background) return fn(background);
    return denied;
  }

  /** `{ key }` 载荷校验（get/delete 用）：形状不对给可读错误，invoke 侧 reject。 */
  function dataKeyOf(payload, channel) {
    if (!payload || typeof payload !== "object" || Array.isArray(payload)) {
      throw new Error(`${channel}：载荷必须是 { key }`);
    }
    if (typeof payload.key !== "string" || !payload.key) {
      throw new Error(`${channel}：缺少字符串 key`);
    }
    return payload.key;
  }

  /** `{ key, value }` 载荷校验（set 用）：`value: undefined` 也当错误，避免「静默存成 null」。 */
  function dataPayloadOf(payload, channel) {
    const key = dataKeyOf(payload, channel);
    if (!Object.prototype.hasOwnProperty.call(payload, "value")) {
      throw new Error(`${channel}：缺少 value（要存 null 请显式传 null）`);
    }
    return { key, value: payload.value };
  }

  function registerIpc() {
    if (ipcRegistered) return;
    ipcRegistered = true;

    /* ── 窗口几何 / 拖拽 / 穿透：widget 窗口专用；页面视图显式拒绝（不适用） ── */

    ipcMain.handle("widget:state", (event) => {
      // 页面视图没有独立窗口：状态读出来只能是 null（与「未运行」同形，语义上是 unsupported）
      if (pageTargetForEvent(event)) {
        rejectPageWindowOp(event, "widget:state");
        return null;
      }
      return withRuntime(event, (rt) => rt.statePayload(), null);
    });
    ipcMain.handle("widget:show", (event) => {
      if (rejectPageWindowOp(event, "widget:show")) {
        throw new Error("页面视图不支持窗口操作：widget:show（插件页面由宿主布局管理）");
      }
      return withRuntime(
        event,
        (rt) => {
          rt.show();
          return rt.statePayload();
        },
        null,
      );
    });
    ipcMain.on("widget:hide", (event) => {
      if (rejectPageWindowOp(event, "widget:hide")) return;
      withRuntime(event, (rt) => rt.hide(), undefined);
    });
    ipcMain.on("widget:toggle", (event) => {
      if (rejectPageWindowOp(event, "widget:toggle")) return;
      withRuntime(event, (rt) => rt.toggle(), undefined);
    });
    ipcMain.handle("widget:set-scale", (event, payload) => {
      if (rejectPageWindowOp(event, "widget:set-scale")) {
        throw new Error("页面视图不支持窗口操作：widget:set-scale（插件页面由宿主布局管理）");
      }
      return withRuntime(event, (rt) => ({ scale: rt.setScale(payload) }), null);
    });
    ipcMain.on("widget:set-interactive", (event, value) => {
      if (rejectPageWindowOp(event, "widget:set-interactive")) return;
      withRuntime(
        event,
        (rt) => {
          // 拖拽期间不接受穿透开关的切换：窗口正在连续移动，此时来回切 ignore-mouse
          // 会让鼠标事件在"透传/拦截"之间抖动，观感上是边缘闪烁。
          if (rt._internal.isDragging && rt._internal.isDragging()) return;
          rt.setInteractive(value === true);
        },
        undefined,
      );
    });
    ipcMain.on("widget:drag-start", (event) => {
      if (rejectPageWindowOp(event, "widget:drag-start")) return;
      withRuntime(event, (rt) => rt._internal.beginDrag(), undefined);
    });
    ipcMain.on("widget:drag-move", (event) => {
      if (rejectPageWindowOp(event, "widget:drag-move")) return;
      withRuntime(event, (rt) => rt._internal.dragTo(), undefined);
    });
    ipcMain.on("widget:drag-end", (event) => {
      if (rejectPageWindowOp(event, "widget:drag-end")) return;
      withRuntime(event, (rt) => rt._internal.endDrag(), undefined);
    });
    ipcMain.on("widget:reset-position", (event) => {
      if (rejectPageWindowOp(event, "widget:reset-position")) return;
      withRuntime(event, (rt) => rt.resetPosition(), undefined);
    });
    ipcMain.handle("widget:set-click-through", (event, value) => {
      if (rejectPageWindowOp(event, "widget:set-click-through")) {
        throw new Error("页面视图不支持窗口操作：widget:set-click-through（插件页面由宿主布局管理）");
      }
      return withRuntime(event, (rt) => rt.setClickThrough(value === true), false);
    });
    ipcMain.on("widget:reload", (event) => {
      // 页面视图重载自己：不是窗口几何操作，允许；浮窗仍走 runtime
      const page = pageTargetForEvent(event);
      if (page) {
        try {
          page.webContents.reload();
        } catch (err) {
          log(`[widgets:${page.pluginId}] 页面重载失败：${(err && err.message) || err}`);
        }
        return;
      }
      withRuntime(event, (rt) => rt.reload(), undefined);
    });
    ipcMain.handle("widget:settings-get", (event) =>
      withRuntimeOrPage(event, (rt) => store.readSettings(rt.pluginId), {}),
    );
    ipcMain.handle("widget:settings-set", (event, payload) =>
      withRuntimeOrPage(
        event,
        (rt) => {
          const key = payload && typeof payload === "object" ? payload.key : undefined;
          const value = payload && typeof payload === "object" ? payload.value : undefined;
          const patch = typeof key === "string" ? { [key]: value } : {};
          const next = store.patchSettings(rt.pluginId, patch);
          // 绑定/模型路径等设置变了：chatConfig 缓存立刻失效（不等 30s 过期）
          invalidateChatConfig();
          // 设置变更同时推给该插件所有窗口/页面视图（本轮各 1 个），渲染层据此热更新
          notifySettings(rt.pluginId, next);
          return next;
        },
        {},
      ),
    );
    ipcMain.handle("widget:info", (event) =>
      withRuntimeOrPage(
        event,
        (rt) => ({
          pluginId: rt.pluginId,
          pluginName: rt.record && rt.record.name ? rt.record.name : rt.pluginId,
          appVersion: appVersion(),
          theme,
        }),
        null,
      ),
    );
    /* ── 插件自有数据（`<userData>/plugins/<id>/data/`，按 sender 的 pluginId 隔离） ── */
    ipcMain.handle("widget:data-get", (event, payload) =>
      withRuntimeOrPage(
        event,
        (rt) => {
          const key = dataKeyOf(payload, "widget:data-get");
          return store.readData(rt.pluginId, key);
        },
        null,
      ),
    );
    ipcMain.handle("widget:data-set", (event, payload) =>
      withRuntimeOrPage(
        event,
        (rt) => {
          const { key, value } = dataPayloadOf(payload, "widget:data-set");
          // key 规则 / JSON 序列化 / 1MB 上限 / 写盘失败都由 store 抛可读错误 → invoke 侧 reject
          return store.writeData(rt.pluginId, key, value);
        },
        null,
      ),
    );
    ipcMain.handle("widget:data-delete", (event, payload) =>
      withRuntimeOrPage(
        event,
        (rt) => store.deleteData(rt.pluginId, dataKeyOf(payload, "widget:data-delete")),
        false,
      ),
    );
    ipcMain.handle("widget:data-keys", (event) =>
      withRuntimeOrPage(event, (rt) => store.listDataKeys(rt.pluginId), []),
    );
    ipcMain.handle("widget:data-dir", (event) =>
      withRuntimeOrPage(event, (rt) => ({ dir: store.dataDirOf(rt.pluginId) }), null),
    );
    ipcMain.on("widget:open-settings", (event) =>
      withRuntimeOrPage(
        event,
        (rt) => emitOpenPage({ page: "settings", settingsTab: SETTINGS_TAB, pluginId: rt.pluginId }),
        undefined,
      ),
    );
    ipcMain.on("widget:open-page", (event, payload) =>
      withRuntimeOrPage(
        event,
        (rt) => {
          const page = normalizeWidgetPage(payload);
          if (!page) {
            log(`[widgets:${rt.pluginId}] 丢弃未知页面跳转：${JSON.stringify(payload)}`);
            return;
          }
          emitOpenPage({ page, pluginId: rt.pluginId });
        },
        undefined,
      ),
    );
    ipcMain.handle("widget:chat-config", (event) =>
      withRuntimeOrPage(
        event,
        async (rt) => {
          // 审计 P0-1：对话上下文（网关地址 + 智能体列表）是**声明制**权限。
          // 未在清单 permissions.chat 显式打开的插件一律拿不到（默认关闭）。
          const permissions = (rt.record && rt.record.permissions) || {};
          if (permissions.chat !== true) {
            return {
              gateway: null,
              agents: [],
              binding: { agentId: null },
              models: [],
              backgroundModel: null,
              reason: "该插件未声明 permissions.chat，宿主不下发对话上下文与网关地址",
            };
          }
          const base = await getChatConfig();
          // 「绑哪个智能体」属于**插件设置**（主进程持有），不是主窗的全局绑定：
          // 主窗固定回 binding.agentId = null，由这里用 settings.agentId 覆盖。
          // 覆盖放在缓存之外——缓存的是环境（网关/agents），绑定是用户偏好，
          // 混进缓存会让用户改完设置后最多 30s 才生效。
          const settings = store.readSettings(rt.pluginId);
          const agentId = typeof settings.agentId === "string" && settings.agentId ? settings.agentId : null;
          return { ...base, binding: { agentId } };
        },
        null,
      ),
    );
    /* ── 插件自带引擎（d.125）：只认该插件自己的页面/窗口（sender 反查，fail-closed） ── */
    ipcMain.handle("widget:engine-status", (event) =>
      withRuntimeOrPage(event, (rt) => engineHost.status(rt.pluginId, rt.record), null),
    );
    ipcMain.handle("widget:engine-call", (event, payload) =>
      withRuntimeOrPage(
        event,
        (rt) => {
          const input = payload && typeof payload === "object" && !Array.isArray(payload) ? payload : {};
          const method = typeof input.method === "string" ? input.method.trim() : "";
          if (!method) throw new Error("engine-call：缺少 method");
          const params = input.params === undefined ? {} : input.params;
          let encoded = "";
          try {
            encoded = JSON.stringify(params);
          } catch {
            throw new Error("engine-call：params 不能序列化为 JSON");
          }
          if (encoded.length > 1024 * 1024) throw new Error("engine-call：params 超过 1MB");
          const timeoutMs = Number(input.timeoutMs);
          return engineHost.call(rt.record, method, params, { timeoutMs });
        },
        null,
      ),
    );
    ipcMain.on("widget:log", (event, line) =>
      withRuntimeOrPage(
        event,
        (rt) => {
          const message = typeof line === "string" ? line.slice(0, 500) : "";
          if (message) log(`[widgets:${rt.pluginId}] ${message}`);
        },
        undefined,
      ),
    );

    /* ── 沙箱 bundle 插件的三条新语义（contract §3） ──
       只认 widget 窗口 / 页面视图 / 后台常驻页的 webContents（withRuntimeOrPage 的 sender
       反查，查不到 fail-closed）。它们刻意不挂到主窗 secureIpc 上：主窗代码不能代替插件
       发信息中枢请求或发通知，插件身份必须由「哪个渲染面发起的」反查出来。 */
    ipcMain.handle("widget:infohub-call", (event, payload) =>
      withRuntimeOrPage(
        event,
        (rt) => {
          const permissions = (rt.record && rt.record.permissions) || {};
          if (permissions.infohub !== true) {
            throw new Error("缺少 permissions.infohub（该插件未声明信息中枢权限）");
          }
          if (typeof infohubRequest !== "function") throw new Error("信息中枢不可用");
          const input = payload && typeof payload === "object" && !Array.isArray(payload) ? payload : {};
          const method = typeof input.method === "string" ? input.method.trim() : "";
          if (!method || !RENDERER_METHODS.has(method)) {
            throw new Error(`信息中枢不支持的方法：${method || "(空)"}`);
          }
          return infohubRequest(method, input.params, {
            timeoutMs: clampInfohubTimeout(input.timeoutMs),
          });
        },
        null,
      ),
    );
    ipcMain.handle("widget:notify", (event, payload) =>
      withRuntimeOrPage(
        event,
        (rt) => {
          const permissions = (rt.record && rt.record.permissions) || {};
          if (permissions.notify !== true) {
            throw new Error("缺少 permissions.notify（该插件未声明通知权限）");
          }
          if (typeof notifyPlugin !== "function") throw new Error("通知通道不可用");
          const input = payload && typeof payload === "object" && !Array.isArray(payload) ? payload : {};
          const result = notifyPlugin({
            pluginId: rt.pluginId,
            title: input.title,
            body: input.body,
            level: input.level,
          });
          return { ok: true, delivered: (result && result.delivered) || "none" };
        },
        null,
      ),
    );
    ipcMain.handle("widget:homecard-set", (event, payload) =>
      withRuntimeOrPage(
        event,
        (rt) => {
          const input = payload && typeof payload === "object" && !Array.isArray(payload) ? payload : {};
          const cardId = typeof input.cardId === "string" ? input.cardId.trim() : "";
          if (!cardId) throw new Error("homecard-set：缺少 cardId");
          const cards = Array.isArray(rt.record.homeCards) ? rt.record.homeCards : [];
          const spec = cards.find((card) => card && card.id === cardId);
          if (!spec) throw new Error(`该插件未声明首页卡片：${cardId}`);
          const readData = (pluginId, key) => store.readData(pluginId, key);
          const overrides = readOverrides(readData, rt.pluginId);
          const patched = applyPatch(overrides, cardId, input.patch);
          if (!patched.ok) throw new Error(patched.error);
          // 只写 homecards.json（不落注册表）：卡片文案是运行期数据，卸载时随 data/ 清掉
          store.writeData(rt.pluginId, CARD_KEY, patched.next);
          const card = projectCard(rt.record, spec, patched.next[cardId]);
          broadcastHomeCard(card);
          return { ok: true, card };
        },
        null,
      ),
    );
  }

  /* ───────────────────────── 显示器监听（全局一份） ───────────────────────── */

  const DISPLAY_EVENTS = ["display-metrics-changed", "display-added", "display-removed"];

  function onDisplayChange() {
    for (const runtime of runtimes.values()) runtime.handleDisplayChange();
  }

  function watchDisplays() {
    if (displaysWatched) return;
    if (!screen || typeof screen.on !== "function") return;
    displaysWatched = true;
    for (const event of DISPLAY_EVENTS) screen.on(event, onDisplayChange);
  }

  function unwatchDisplays() {
    if (!displaysWatched) return;
    displaysWatched = false;
    if (screen && typeof screen.removeListener === "function") {
      for (const event of DISPLAY_EVENTS) screen.removeListener(event, onDisplayChange);
    }
  }

  /* ───────────────────── 生命周期事件（d.108，规格 §5.4） ───────────────────── */

  /** 从注册表记录里取「对账需要比较」的几件事（不保留整份记录，避免持有旧引用）。 */
  function lifecycleSnapshot(record) {
    const permissions = (record && record.permissions) || {};
    const events = Array.isArray(permissions.events) ? permissions.events : [];
    return {
      version: typeof record.version === "string" ? record.version : "",
      enabled: record.enabled === true,
      /** 只有清单声明了 `permissions.events: ["lifecycle"]` 才允许收生命周期事件。 */
      lifecycle: events.includes("lifecycle"),
      /** 用于清理「窗口还没建就卸载」时残留的排队事件。 */
      widgetId: record.widget && typeof record.widget.id === "string" ? record.widget.id : "",
    };
  }

  /** 统一载荷形状 `{ event, version, from? }`（`from` 只有 updated 带）。 */
  function lifecyclePayload(event, version, from) {
    const payload = { event, version: typeof version === "string" ? version : "" };
    if (typeof from === "string" && from) payload.from = from;
    return payload;
  }

  /** 窗口还没建好：先排队，等 did-finish-load 再发（窗口重建后不会重放）。 */
  function queueLifecycle(runtimeKey, payload) {
    const list = pendingLifecycle.get(runtimeKey) || [];
    if (list.length >= MAX_PENDING_LIFECYCLE) {
      // d.110：队列有上限（20）。窗口长期不加载时，最早的几条已经过时（例如 installed
      // 之后又更新了 20 次），丢掉最旧的能保证投递的是「最新状态」，且队列不会无限涨。
      const dropped = list.shift();
      log(
        `[widgets] 生命周期事件排队超过 ${MAX_PENDING_LIFECYCLE} 条（${runtimeKey}），丢弃最旧一条：${dropped && dropped.event}`,
      );
    }
    list.push(payload);
    pendingLifecycle.set(runtimeKey, list);
  }

  /** 取走并清空某插件排队中的事件（「取走」即保证只投递一次）。 */
  function takeLifecycle(runtimeKey) {
    const list = pendingLifecycle.get(runtimeKey) || [];
    pendingLifecycle.delete(runtimeKey);
    return list;
  }

  function pluginRuntime(pluginId) {
    return [...runtimes.values()].find((item) => item.pluginId === pluginId) || null;
  }

  /** 直接投递一条生命周期事件；窗口不在/刚销毁返回 false（丢弃，不重放）。 */
  function sendLifecycle(runtime, payload) {
    const win = runtime && runtime.window;
    if (!win || win.isDestroyed()) return false;
    try {
      win.webContents.send(LIFECYCLE_CHANNEL, payload);
      return true;
    } catch {
      return false;
    }
  }

  /**
   * 发最后一条事件后再销毁窗口（disabled / uninstalled）。
   *
   * 为什么不在同一 tick `destroy()`：`webContents.send` 只是把 IPC 排进渲染进程队列，
   * 紧接着销毁会把还没处理的消息一起带走，插件永远收不到「我要被停用/卸载了」。
   * 把销毁挪到下一 tick（`setTimer` 已注入，测试里是同步执行，不影响断言）。
   */
  function retireRuntime(runtime, payload) {
    if (!runtime || retiring.has(runtime.key)) return;
    const delivered = payload ? sendLifecycle(runtime, payload) : false;
    if (!delivered) {
      destroyRuntime(runtime);
      return;
    }
    let ran = false;
    const timer = setTimer(() => {
      ran = true;
      retiring.delete(runtime.key);
      // 状态在「销毁前一 tick」又被改回来（用户手速极快地重新启用/重装）→ 保留窗口
      const current = typeof store.get === "function" ? store.get(runtime.pluginId) : null;
      const stillGone = !current;
      const stillDisabled = !!current && current.enabled === false;
      if (!stillGone && !stillDisabled) return;
      if (runtimes.get(runtime.key) === runtime) destroyRuntime(runtime);
    }, 0);
    // 注入的 setTimeout 可能是同步执行（测试夹具）：跑过了就不要留下过期条目
    if (!ran) retiring.set(runtime.key, timer);
  }

  /* ───────────────────────── 生命周期：对账 ───────────────────────── */

  function destroyRuntime(runtime) {
    const timer = retiring.get(runtime.key);
    if (timer !== undefined) {
      clearTimer(timer);
      retiring.delete(runtime.key);
    }
    runtime.destroy();
    runtimes.delete(runtime.key);
  }

  /**
   * 卸载前置：先把「会占住插件目录」的运行面停干净，再由调用方删文件。
   *
   * Windows 不允许删除「正被某个进程当作当前工作目录」的目录（`fs.rmSync` 报
   * `EPERM: Permission denied`）。插件引擎 spawn 时工作目录就是插件安装目录
   * （plugin-engine.js 的 `cwd: target.dir`），所以必须**等引擎进程真正退出**再删，
   * 否则卸载会稳定失败并提示「卸载未完成…（可重试卸载）」。
   *
   * 页面视图与后台常驻页一并销毁：它们的渲染进程正从插件目录里读资源。
   * widget 窗口不在这里销毁——注册表记录删掉后由 `reconcile()` 走生命周期
   * （`uninstalled` 事件）再销毁，保留既有语义。
   */
  async function stopForUninstall(pluginId) {
    const id = String(pluginId);
    if (pageInfo && pageInfo.id === id) destroyPageView();
    destroyBackground(id);
    await engineHost.stop(id);
  }

  /**
   * 按注册表对账：只给「已启用 + 清单有 widget + 文件没坏」的插件建窗；
   * 版本变化就重建；停用/卸载就销毁（保留文件与设置由 store 负责）。
   *
   * d.108 起对账同时负责**生命周期事件**（规格 §5.4）：
   * - 首装 → `installed`（窗口建好、页面加载完成后投递）；
   * - 启用/停用 → `enabled` / `disabled`；
   * - 版本变化 → `updated`（载荷带 `from`，窗口已按新版本重建）；
   * - 从注册表消失 → `uninstalled`（销毁前最后一条，尽力投递）。
   * 只有清单 `permissions.events` 含 `lifecycle` 的插件才会收到；事件是**通知**，
   * 不改变任何权限，也不在窗口重建/宿主重启后重放。
   */
  function reconcile() {
    const records = store.list();
    const recordsById = new Map();
    for (const record of records) recordsById.set(record.id, record);

    /* ── 1) 卸载：上一轮认识、这一轮注册表里没有 → uninstalled（销毁前最后一次） ── */
    for (const [pluginId, snapshot] of [...lifecycleKnown.entries()]) {
      if (recordsById.has(pluginId)) continue;
      lifecycleKnown.delete(pluginId);
      // 即便窗口还没建（安装后一直没显示），也要清掉残留的排队事件，避免下次重装误投
      if (snapshot.widgetId) pendingLifecycle.delete(`${pluginId}:${snapshot.widgetId}`);
      const runtime = pluginRuntime(pluginId);
      if (!runtime) continue;
      retireRuntime(runtime, snapshot.lifecycle ? lifecyclePayload("uninstalled", snapshot.version) : null);
    }

    /* ── 2) 首装 / 启用 / 停用 / 版本更新 ── */
    for (const [pluginId, record] of recordsById) {
      const snapshot = lifecycleSnapshot(record);
      const previous = lifecycleKnown.get(pluginId);
      lifecycleKnown.set(pluginId, snapshot);
      // 启动后第一轮只补种：启动前已装好的插件不补发 installed（规格 §5.4）
      if (!lifecycleSeeded) continue;

      const widgetId = record.widget && record.widget.id;
      if (!widgetId) continue;
      const runtimeKey = `${pluginId}:${widgetId}`;

      if (!previous) {
        // 运行中新出现的插件 → 首装；窗口还没建，先排队等 did-finish-load
        if (snapshot.lifecycle) queueLifecycle(runtimeKey, lifecyclePayload("installed", snapshot.version));
        continue;
      }
      if (snapshot.version !== previous.version && snapshot.enabled && previous.enabled) {
        if (snapshot.lifecycle) queueLifecycle(runtimeKey, lifecyclePayload("updated", snapshot.version, previous.version));
      }
      if (!previous.enabled && snapshot.enabled) {
        if (snapshot.lifecycle) queueLifecycle(runtimeKey, lifecyclePayload("enabled", snapshot.version));
      }
      if (previous.enabled && !snapshot.enabled) {
        const runtime = pluginRuntime(pluginId);
        if (runtime) pendingLifecycle.delete(runtime.key);
        retireRuntime(
          runtime,
          runtime && previous.lifecycle ? lifecyclePayload("disabled", previous.version) : null,
        );
      }
    }
    lifecycleSeeded = true;

    /* ── 3) 建窗 / 重建（既有口径） ── */
    const desired = new Map();
    for (const record of records) {
      if (!record.enabled || record.error || !record.widget) continue;
      desired.set(`${record.id}:${record.widget.id}`, record);
    }
    for (const [key, runtime] of [...runtimes.entries()]) {
      if (retiring.has(key)) continue; // 已排队销毁（disabled/uninstalled），别重复处理
      const next = desired.get(key);
      if (!next || next.version !== runtime.record.version) destroyRuntime(runtime);
    }
    for (const [key, record] of desired) {
      if (runtimes.has(key)) continue;
      if (retiring.has(key)) continue;
      const runtime = createRuntime(record);
      runtimes.set(key, runtime);
      runtime.loadState();
      runtime.createTray();
      if (runtime.state.visible) runtime.show();
      log(`[widgets] ${record.id} 已就绪（${record.widget.id}@${record.version}）`);
    }
    // 页面视图对账放在最后：停用/卸载/版本更新/页面入口变化都在这里收口（不留孤儿视图）
    syncPageView();
    // 后台常驻页同一轮对账：与页面视图同为「无独立窗口的渲染面」，启停规则一致
    syncBackgroundViews(records);
    // 引擎对账：停用/卸载/版本变化/入口变化 → 回收进程。失败只记日志：
    // 引擎是插件的可选能力，回收异常不该让整个插件宿主起不来。
    engineHost.reconcile(records).catch((err) => {
      log(`[widgets] 引擎对账失败：${(err && err.message) || err}`);
    });
    return { count: runtimes.size };
  }

  function start() {
    registerIpc();
    watchDisplays();
    return reconcile();
  }

  function destroyAll() {
    // 页面视图先销毁：主窗关闭 / app.quit 都不该留下一个没有宿主的渲染进程
    destroyPageView();
    // 后台常驻页同理：宿主退出前必须显式关掉，否则留下无主的隐藏渲染进程
    destroyAllBackgrounds();
    for (const runtime of [...runtimes.values()]) destroyRuntime(runtime);
    pendingLifecycle.clear();
    unwatchDisplays();
    // 返回 Promise 交给 will-quit 的回收闸：子进程（Python 引擎）必须真的死掉再退出
    return engineHost.stopAll().catch((err) => {
      log(`[widgets] 引擎回收失败：${(err && err.message) || err}`);
    });
  }

  /** 主窗 `widgets:action` 的入口。 */
  function action(id, name) {
    const runtime = [...runtimes.values()].find((item) => item.pluginId === id);
    if (!runtime) return { ok: false, error: `插件未启用或未安装：${id}` };
    switch (name) {
      case "show":
        runtime.show();
        break;
      case "hide":
        runtime.hide();
        break;
      case "toggle":
        runtime.toggle();
        break;
      case "scaleUp":
        runtime.stepScale(1);
        break;
      case "scaleDown":
        runtime.stepScale(-1);
        break;
      case "toggleClickThrough":
        runtime.setClickThrough(!runtime.state.clickThrough);
        break;
      case "resetPosition":
        runtime.resetPosition();
        break;
      case "reload":
        runtime.reload();
        break;
      default:
        return { ok: false, error: `未知动作：${String(name)}` };
    }
    return { ok: true, state: runtime.statePayload() };
  }

  function stateOf(id) {
    const runtime = [...runtimes.values()].find((item) => item.pluginId === id);
    if (runtime) return runtime.statePayload();
    // 已安装但当前没起窗（停用/隐藏/文件坏了）：给一份「未运行」的稳定形状，
    // 免得主窗设置页为了显示一行状态还要判 null。
    const record = store.get(id);
    if (!record || !record.widget) return null;
    return { visible: false, scale: record.widget.defaultScale, clickThrough: false };
  }

  /**
   * 主窗发来的通知事件（`widgets:publish`）→ 声明了对应 `permissions.events` 的 widget。
   *
   * 渠道互斥（pet 时代的口径，保留）：主窗口在前台时只走通知中心，widget 不开口；
   * widget 隐藏时直接丢弃（错过不补发）。
   *
   * 审计 P1-5：`theme` / `tray` 不再是「无条件广播」——与 `notify` 一样必须由清单
   * `permissions.events` 显式声明，否则不投递（声明是约束，不是表单）。
   */
  function hasEventPermission(record, kind) {
    const permissions = (record && record.permissions) || {};
    return Array.isArray(permissions.events) && permissions.events.includes(kind);
  }

  function publish(raw) {
    const event = normalizeEvent(raw);
    if (!event) return "invalid";
    if (event.kind === "theme") {
      // 主题是宿主级状态：即使没有插件订阅也要记住（新窗口 info().theme 要正确）
      theme = event.theme;
      let delivered = 0;
      for (const runtime of runtimes.values()) {
        if (!hasEventPermission(runtime.record, "theme")) continue;
        const win = runtime.window;
        if (!win || win.isDestroyed()) continue;
        try {
          win.webContents.send("widget:event", event);
          delivered += 1;
        } catch {
          /* 窗口刚销毁：丢弃 */
        }
      }
      // d.124 §5.2：页面视图复用同一通道拿主题（不新增通道）；页面在显示中，直接投递。
      if (pageInfo && hasEventPermission(pageInfo.record, "theme")) {
        try {
          pageInfo.webContents.send("widget:event", event);
          delivered += 1;
        } catch {
          /* 页面刚卸载：丢弃 */
        }
      }
      return delivered > 0 ? "delivered" : "no-target";
    }
    if (event.kind === "tray") {
      let delivered = 0;
      for (const runtime of runtimes.values()) {
        if (!hasEventPermission(runtime.record, "tray")) continue;
        const win = runtime.window;
        if (!win || win.isDestroyed()) continue;
        try {
          win.webContents.send("widget:event", event);
          delivered += 1;
        } catch {
          /* 窗口刚销毁：丢弃 */
        }
      }
      return delivered > 0 ? "delivered" : "no-target";
    }
    if (mainWindowForeground()) return "suppressed-foreground";
    let delivered = 0;
    for (const runtime of runtimes.values()) {
      const permissions = (runtime.record && runtime.record.permissions) || {};
      if (!Array.isArray(permissions.events) || !permissions.events.includes("notify")) continue;
      if (!runtime.state.visible) continue;
      const win = runtime.window;
      if (!win || win.isDestroyed()) continue;
      try {
        win.webContents.send("widget:event", event);
        delivered += 1;
      } catch {
        /* 窗口刚销毁：丢弃 */
      }
    }
    return delivered > 0 ? "delivered" : "no-target";
  }

  return {
    start,
    reconcile,
    destroyAll,
    // 卸载前置：停引擎/页面视图/后台页，避免删目录时 EPERM（Windows 的 cwd 占用）
    stopForUninstall,
    publish,
    action,
    stateOf,
    // d.124 B 路径：插件自带页面视图（主窗经 secureIpc 的 widgets:page-* 调用）
    pageMount,
    pageBounds,
    pageUnmount,
    notifySettings,
    getChatConfig,
    invalidateChatConfig,
    runtimeFor: (id) => [...runtimes.values()].find((item) => item.pluginId === id) || null,
    get size() {
      return runtimes.size;
    },
    get pageCount() {
      return pageInfo ? 1 : 0;
    },
    // contract §4：主窗 `plugins:homecards` 的数据源；contract §5：后台隐藏窗数量（对账/诊断用）
    homeCards,
    get backgroundCount() {
      return backgrounds.size;
    },
    _internal: { registerIpc, normalizeEvent, normalizeChatConfig, setTheme: (next) => (theme = next) },
  };
}

module.exports = { createWidgetHost, normalizeEvent, normalizeChatConfig, SAVE_DEBOUNCE_MS, CHAT_CONFIG_TTL_MS, CHAT_CONFIG_TIMEOUT_MS };
