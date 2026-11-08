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
 * ★ 依赖全部注入（BrowserWindow/Tray/screen/ipcMain/store…），可以用假对象单测整条状态机。
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

/** 窗口未建好前最多排队多少条生命周期事件（窗口一直不打开时防止无限增长）。 */
const MAX_PENDING_LIFECYCLE = 8;

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
  const agents = Array.isArray(input.agents)
    ? input.agents
        .filter((agent) => agent && typeof agent.id === "string" && agent.id)
        .slice(0, 50)
        .map((agent) => ({
          id: String(agent.id).slice(0, 64),
          name: text(agent.name, 64) || String(agent.id).slice(0, 64),
          ...(typeof agent.prompt === "string" ? { prompt: agent.prompt.slice(0, 4000) } : {}),
        }))
    : [];
  const bindingRaw = input.binding && typeof input.binding === "object" ? input.binding : {};
  const binding = { agentId: typeof bindingRaw.agentId === "string" && bindingRaw.agentId ? bindingRaw.agentId : null };
  return { agents, binding };
}

/**
 * @param {object} deps
 * @param {object} deps.BrowserWindow electron.BrowserWindow
 * @param {object} deps.Tray electron.Tray
 * @param {object} deps.Menu electron.Menu
 * @param {object} deps.nativeImage electron.nativeImage
 * @param {object} deps.screen electron.screen
 * @param {object} deps.ipcMain electron.ipcMain
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
    const value = { gateway, agents: extras.agents, binding: extras.binding };
    chatCache = { at: now(), value };
    return value;
  }

  /** 设置变更后立刻失效（用户改了绑定不必等 30s 缓存过期）。 */
  function invalidateChatConfig() {
    chatCache = null;
  }

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

  function registerIpc() {
    if (ipcRegistered) return;
    ipcRegistered = true;

    ipcMain.handle("widget:state", (event) => withRuntime(event, (rt) => rt.statePayload(), null));
    ipcMain.handle("widget:show", (event) =>
      withRuntime(
        event,
        (rt) => {
          rt.show();
          return rt.statePayload();
        },
        null,
      ),
    );
    ipcMain.on("widget:hide", (event) => withRuntime(event, (rt) => rt.hide(), undefined));
    ipcMain.on("widget:toggle", (event) => withRuntime(event, (rt) => rt.toggle(), undefined));
    ipcMain.handle("widget:set-scale", (event, payload) =>
      withRuntime(event, (rt) => ({ scale: rt.setScale(payload) }), null),
    );
    ipcMain.on("widget:set-interactive", (event, value) =>
      withRuntime(
        event,
        (rt) => {
          // 拖拽期间不接受穿透开关的切换：窗口正在连续移动，此时来回切 ignore-mouse
          // 会让鼠标事件在"透传/拦截"之间抖动，观感上是边缘闪烁。
          if (rt._internal.isDragging && rt._internal.isDragging()) return;
          rt.setInteractive(value === true);
        },
        undefined,
      ),
    );
    ipcMain.on("widget:drag-start", (event) => withRuntime(event, (rt) => rt._internal.beginDrag(), undefined));
    ipcMain.on("widget:drag-move", (event) => withRuntime(event, (rt) => rt._internal.dragTo(), undefined));
    ipcMain.on("widget:drag-end", (event) => withRuntime(event, (rt) => rt._internal.endDrag(), undefined));
    ipcMain.on("widget:reset-position", (event) => withRuntime(event, (rt) => rt.resetPosition(), undefined));
    ipcMain.handle("widget:set-click-through", (event, value) =>
      withRuntime(event, (rt) => rt.setClickThrough(value === true), false),
    );
    ipcMain.on("widget:reload", (event) => withRuntime(event, (rt) => rt.reload(), undefined));
    ipcMain.handle("widget:settings-get", (event) => withRuntime(event, (rt) => store.readSettings(rt.pluginId), {}));
    ipcMain.handle("widget:settings-set", (event, payload) =>
      withRuntime(
        event,
        (rt) => {
          const key = payload && typeof payload === "object" ? payload.key : undefined;
          const value = payload && typeof payload === "object" ? payload.value : undefined;
          const patch = typeof key === "string" ? { [key]: value } : {};
          const next = store.patchSettings(rt.pluginId, patch);
          // 绑定/模型路径等设置变了：chatConfig 缓存立刻失效（不等 30s 过期）
          invalidateChatConfig();
          // 设置变更同时推给该插件所有窗口（本轮只有 1 个），渲染层据此热更新
          const win = rt.window;
          if (win && !win.isDestroyed()) win.webContents.send("widget:settings", next);
          return next;
        },
        {},
      ),
    );
    ipcMain.handle("widget:info", (event) =>
      withRuntime(
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
    ipcMain.on("widget:open-settings", (event) =>
      withRuntime(
        event,
        (rt) => emitOpenPage({ page: "settings", settingsTab: SETTINGS_TAB, pluginId: rt.pluginId }),
        undefined,
      ),
    );
    ipcMain.on("widget:open-page", (event, payload) =>
      withRuntime(
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
      withRuntime(
        event,
        async (rt) => {
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
    ipcMain.on("widget:log", (event, line) =>
      withRuntime(
        event,
        (rt) => {
          const message = typeof line === "string" ? line.slice(0, 500) : "";
          if (message) log(`[widgets:${rt.pluginId}] ${message}`);
        },
        undefined,
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
    if (list.length >= MAX_PENDING_LIFECYCLE) list.shift();
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
    return { count: runtimes.size };
  }

  function start() {
    registerIpc();
    watchDisplays();
    return reconcile();
  }

  function destroyAll() {
    for (const runtime of [...runtimes.values()]) destroyRuntime(runtime);
    pendingLifecycle.clear();
    unwatchDisplays();
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
   * 主窗发来的通知事件（`widgets:publish`）→ 声明了 `permissions.events` 含 notify 的 widget。
   *
   * 渠道互斥（pet 时代的口径，保留）：主窗口在前台时只走通知中心，widget 不开口；
   * widget 隐藏时直接丢弃（错过不补发）。
   */
  function publish(raw) {
    const event = normalizeEvent(raw);
    if (!event) return "invalid";
    if (event.kind === "theme") {
      theme = event.theme;
      for (const runtime of runtimes.values()) {
        const win = runtime.window;
        if (win && !win.isDestroyed()) win.webContents.send("widget:event", event);
      }
      return "delivered";
    }
    if (event.kind === "tray") {
      for (const runtime of runtimes.values()) {
        const win = runtime.window;
        if (win && !win.isDestroyed()) win.webContents.send("widget:event", event);
      }
      return "delivered";
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
    publish,
    action,
    stateOf,
    getChatConfig,
    invalidateChatConfig,
    runtimeFor: (id) => [...runtimes.values()].find((item) => item.pluginId === id) || null,
    get size() {
      return runtimes.size;
    },
    _internal: { registerIpc, normalizeEvent, normalizeChatConfig, setTheme: (next) => (theme = next) },
  };
}

module.exports = { createWidgetHost, normalizeEvent, normalizeChatConfig, SAVE_DEBOUNCE_MS, CHAT_CONFIG_TTL_MS, CHAT_CONFIG_TIMEOUT_MS };
