"use strict";

/**
 * 桌宠窗口的生命周期编排：创建/显示/隐藏、鼠标穿透、拖拽、缩放、托盘。
 *
 * 为什么单独成文件而不是堆在 main.js：
 * - main.js 已有 600+ 行，再加一百多行窗口编排会让「哪段是主窗口、哪段是桌宠」彻底看不清；
 * - 这里全部依赖靠注入（BrowserWindow / Tray / screen / ipcMain…），可以用假对象单测
 *   「显示隐藏状态机」「穿透取舍」「拖拽落盘」这些容易写错的分支。
 *
 * 几何计算与窗口参数仍在 pet-window.js（纯函数），本文件只做编排。
 */

const {
  clampPetState,
  petWindowOptions,
  petWindowSize,
  nextScale,
  normalizeScale,
  normalizePetPage,
  draggedPosition,
  defaultPetPosition,
  petUrl,
} = require("./pet-window");

/** 拖拽落盘与 move 事件的防抖：拖拽时 move 是高频的，每次都写盘会拖慢手感。 */
const SAVE_DEBOUNCE_MS = 400;

/**
 * @param {object} deps
 * @param {object} deps.BrowserWindow electron.BrowserWindow
 * @param {object} deps.Tray electron.Tray
 * @param {object} deps.Menu electron.Menu
 * @param {object} deps.nativeImage electron.nativeImage
 * @param {object} deps.screen electron.screen
 * @param {object} deps.ipcMain electron.ipcMain
 * @param {function} deps.readState (file) => unknown
 * @param {function} deps.writeState (file, state) => void
 * @param {string} deps.stateFile 状态文件绝对路径
 * @param {string} deps.preloadPath preload.js 绝对路径
 * @param {string} deps.trayIconPath 托盘图标绝对路径
 * @param {function} deps.resolveAppUrl () => string 主窗口加载地址
 * @param {function} deps.getMainWindow () => BrowserWindow|null
 * @param {function} [deps.isAllowedNavigation] (url) => boolean 导航白名单
 * @param {function} [deps.log]
 * @param {function} [deps.setTimeout]
 * @param {function} [deps.clearTimeout]
 */
function createPetHost(deps) {
  const {
    BrowserWindow,
    Tray,
    Menu,
    nativeImage,
    screen,
    ipcMain,
    stateFile,
    preloadPath,
    trayIconPath,
    resolveAppUrl,
    getMainWindow,
    isAllowedNavigation,
    log = () => {},
    setTimeout: setTimer = setTimeout,
    clearTimeout: clearTimer = clearTimeout,
  } = deps;

  const readState = deps.readState || (() => null);
  const writeState = deps.writeState || (() => {});

  /** @type {Electron.BrowserWindow|null} */
  let win = null;
  /** 反向事件推送（见下方 pushEvent 定义）。 */
  let pushEvent = () => false;
  /** @type {Electron.Tray|null} */
  let tray = null;

  /**
   * 持久化状态。`clickThrough` 是**用户意图**（托盘勾选），
   * 与渲染层上报的「此刻光标是否在角色上」（临时状态）是两件事，不能混存。
   */
  let state = { scale: 1.0, bounds: null, visible: false, clickThrough: true };

  /** 当前是否由渲染层判定为「可交互」（仅 clickThrough 生效时才有意义）。 */
  let interactive = false;
  /** 拖拽起点：屏幕光标 + 当时的窗口原点。 */
  let dragOrigin = null;
  let saveTimer = null;

  /* ────────────────────────── 状态读写 ────────────────────────── */

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

  function loadState() {
    const raw = readState(stateFile);
    state = clampPetState(raw, workAreas(), primaryArea());
    // clickThrough 不在 clampPetState 里（那是几何归一化），单独取：只认严格的 false
    state.clickThrough = !(raw && typeof raw === "object" && raw.clickThrough === false);
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
      writeState(stateFile, {
        scale: state.scale,
        bounds: state.bounds,
        visible: state.visible,
        clickThrough: state.clickThrough,
      });
    } catch (err) {
      log(`[pet] 状态落盘失败：${(err && err.message) || err}`);
    }
  }

  /* ────────────────────────── 穿透 ────────────────────────── */

  /**
   * 计算并应用鼠标穿透。
   *
   * 两种模式：
   * - `clickThrough === false`：窗口整体接收鼠标，不穿透（用户从托盘关掉穿透后）。
   * - `clickThrough === true`：默认穿透，只有渲染层说「光标在角色/气泡上」时才拦住鼠标。
   *
   * ★ 穿透状态下窗口必须传 `forward:true`，否则渲染层收不到 mousemove，
   *   就永远等不到「光标进入角色」那一次上报——表现为角色永远点不中。
   */
  function applyMouseIgnore() {
    if (!win || win.isDestroyed()) return;
    const shouldIgnore = state.clickThrough ? !interactive : false;
    try {
      win.setIgnoreMouseEvents(shouldIgnore, { forward: true });
    } catch (err) {
      // 个别平台不支持 forward 选项：退化成不带选项的调用，至少保证不挡住桌面
      log(`[pet] setIgnoreMouseEvents 带 forward 失败，退化：${(err && err.message) || err}`);
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
    state.clickThrough = next === true;
    if (!state.clickThrough) interactive = false;
    applyMouseIgnore();
    scheduleSave();
    refreshTrayMenu();
  }

  /* ────────────────────────── 窗口 ────────────────────────── */

  function currentBounds() {
    if (win && !win.isDestroyed()) {
      try {
        return win.getBounds();
      } catch {
        /* 落到下面的 state */
      }
    }
    return state.bounds || { ...defaultPetPosition(primaryArea(), petWindowSize(state.scale)), ...petWindowSize(state.scale) };
  }

  function createWindow() {
    if (win && !win.isDestroyed()) return win;

    const opts = petWindowOptions({
      bounds: state.bounds,
      scale: state.scale,
      preloadPath,
    });

    win = new BrowserWindow(opts);

    // ── 导航闸（③-4 安全复审）─────────────────────────────────────────
    // 桌宠窗口也挂了 preload，而 preload 暴露的是**整份主进程桥**（__mcp_stdio
    // 能拉起子进程、__heming_secrets 是解密预言机、__heming_files 能写文件）。
    // 桌宠页与主窗口同源，一旦这个 frame 被导航到远端页面，远端脚本就等于拿到了
    // 这些能力（且能读同源 localStorage）。所以桌宠窗口只允许停留在应用自己的页面，
    // window.open 一律拒绝——需要外链时走主窗口的既有「转系统浏览器」路径。
    // isAllowedNavigation 由 main.js 注入；没接线时按**拒绝**处理（fail-closed）。
    const navAllowed = typeof isAllowedNavigation === "function" ? isAllowedNavigation : () => false;
    const wc = win.webContents;
    if (wc && typeof wc.on === "function") {
      wc.on("will-navigate", (event, url) => {
        if (navAllowed(url)) return;
        log(`[pet] 拦截离开桌宠页面的导航：${url}`);
        event.preventDefault();
      });
    }
    if (wc && typeof wc.setWindowOpenHandler === "function") {
      wc.setWindowOpenHandler(({ url }) => {
        log(`[pet] 拦截桌宠窗口的新窗口请求：${url}`);
        return { action: "deny" };
      });
    }

    // 首次打开就穿透：不能让一个 300×420 的透明层凭空挡住桌面点击
    applyMouseIgnore();

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
    });

    win.loadURL(petUrl(resolveAppUrl()));
    return win;
  }

  function show(options) {
    const silent = !(options && options.silent === false);
    if (!win || win.isDestroyed()) createWindow();
    if (!win) return;
    state.visible = true;
    if (silent) {
      // 不抢焦点：用户可能正在别处打字，桌宠出现不该打断
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
    saveNow();
    refreshTrayMenu();
  }

  function toggle() {
    if (state.visible && win && !win.isDestroyed() && win.isVisible()) hide();
    else show();
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
  }

  /* ────────────────────────── 缩放 ────────────────────────── */

  /**
   * 设成某个绝对档位（设置区下拉用）。
   * 与 stepScale 分开：`setScale(1)` 是"设为 1.0 倍"，不是"放大一档"——
   * 把两件事塞进同一个数字参数，迟早出现"点放大结果没反应"（本来就在 1.0）。
   */
  function setScale(value) {
    const next = normalizeScale(value);
    if (next === state.scale) return state.scale;
    state.scale = next;
    if (win && !win.isDestroyed()) {
      const size = petWindowSize(next);
      const b = win.getBounds();
      // 从右下角缩放：保持窗口右下角不动，视觉上像"长大"而不是"跳位置"
      win.setBounds({
        x: b.x + (b.width - size.width),
        y: b.y + (b.height - size.height),
        width: size.width,
        height: size.height,
      });
    }
    scheduleSave();
    refreshTrayMenu();
    return state.scale;
  }

  /** 相对切一档（托盘「放大/缩小」用）。 */
  function stepScale(dir) {
    return setScale(nextScale(state.scale, dir));
  }

  /* ────────────────────────── 拖拽 ────────────────────────── */

  function beginDrag() {
    if (!win || win.isDestroyed()) return;
    const cursor = screen.getCursorScreenPoint();
    const b = win.getBounds();
    dragOrigin = { cursorX: cursor.x, cursorY: cursor.y, windowX: b.x, windowY: b.y };
  }

  function dragTo() {
    if (!dragOrigin || !win || win.isDestroyed()) return;
    const cursor = screen.getCursorScreenPoint();
    const pos = draggedPosition(dragOrigin, cursor);
    if (!pos) return;
    win.setPosition(pos.x, pos.y);
  }

  function endDrag() {
    if (!dragOrigin) return;
    dragOrigin = null;
    saveNow();
  }

  /* ────────────────────────── IPC ────────────────────────── */

  /**
   * 只接受**桌宠窗口自己**发来的请求。
   * 主窗口或其他窗口（含将来新增的）不该能操纵桌宠的穿透与位置——
   * 这与 notify-bridge 校验 conversationId 是同一个思路：跨进程边界不靠调用方自觉。
   */
  /** 只认主窗口发起的请求（桌宠与主窗口是两个渲染进程，来源必须分开判）。 */
  function fromMainWindow(event) {
    const main = getMainWindow && getMainWindow();
    if (!main || main.isDestroyed()) return false;
    try {
      return BrowserWindow.fromWebContents(event.sender) === main;
    } catch {
      return false;
    }
  }

  function fromPetWindow(event) {
    if (!win || win.isDestroyed()) return false;
    try {
      return BrowserWindow.fromWebContents(event.sender) === win;
    } catch {
      return false;
    }
  }

  function statePayload() {
    return {
      visible: state.visible,
      scale: state.scale,
      clickThrough: state.clickThrough,
      bounds: currentBounds(),
    };
  }

  /**
   * 主窗口此刻是否在前台（用户能不能看到它）。
   *
   * 渠道互斥的**权威判据**：主窗口在前台时，平台事件已经在通知中心里，
   * 桌宠不再开口（否则同一个事件会被说两遍）。渲染层也会用 `document.hasFocus()`
   * 做同样判断以省一次 IPC；这里再判一次是跨进程边界不信任调用方。
   */
  function mainWindowForeground() {
    const main = getMainWindow && getMainWindow();
    if (!main || main.isDestroyed()) return false;
    try {
      return main.isVisible() === true && main.isMinimized() !== true && main.isFocused() === true;
    } catch {
      return false;
    }
  }

  /** 桌宠此刻是否真的在桌面上（隐藏/未创建 → 事件直接丢弃，**错过不补发**）。 */
  function petVisible() {
    if (!win || win.isDestroyed()) return false;
    if (!state.visible) return false;
    try {
      return win.isVisible() === true;
    } catch {
      return false;
    }
  }

  /**
   * 主窗口发起的事件 → 桌宠（带 gating）。
   *
   * 返回判定结果字符串，便于测试与日志：
   * - `invalid`：载荷形状不对（连 kind 都没有），丢弃；
   * - `suppressed-foreground`：主窗口在前台 → 只走通知中心，桌宠不说话；
   * - `pet-hidden`：桌宠没显示 → 丢弃（不排队、不补发）；
   * - `delivered` / `failed`：转发结果。
   */
  function deliverEventFromMain(payload) {
    if (!payload || typeof payload !== "object" || typeof payload.kind !== "string") return "invalid";
    if (mainWindowForeground()) return "suppressed-foreground";
    if (!petVisible()) return "pet-hidden";
    return pushEvent(payload) ? "delivered" : "failed";
  }

  function registerIpc() {
    ipcMain.handle("pet:state", () => statePayload());
    ipcMain.handle("pet:set-scale", (event, payload) => {
      // 设置区（主窗口）也能调缩放，所以这里不强制 fromPetWindow。
      // 两种语义分开收：{dir:1} 相对切档；直接给数字 = 设为该档位。
      if (payload && typeof payload === "object" && payload.dir !== undefined) {
        return stepScale(payload.dir);
      }
      return setScale(payload);
    });

    ipcMain.on("pet:set-interactive", (event, value) => {
      if (!fromPetWindow(event)) return;
      setInteractive(value);
    });
    ipcMain.on("pet:drag-start", (event) => {
      if (!fromPetWindow(event)) return;
      beginDrag();
    });
    ipcMain.on("pet:drag-move", (event) => {
      if (!fromPetWindow(event)) return;
      dragTo();
    });
    ipcMain.on("pet:drag-end", (event) => {
      if (!fromPetWindow(event)) return;
      endDrag();
    });
    ipcMain.on("pet:hide", (event) => {
      if (!fromPetWindow(event)) return;
      hide();
    });

    ipcMain.on("pet:toggle", () => toggle());
    ipcMain.on("pet:show", () => show());
    // 穿透开关：设置区与托盘都要能改，所以不限制来源
    ipcMain.on("pet:set-click-through", (event, value) => setClickThrough(value === true));
    // 换模型后需要重新加载页面：模型地址是页面加载时读的，光显隐不会重新拉资源
    ipcMain.on("pet:reload", () => {
      if (win && !win.isDestroyed()) win.webContents.reload();
    });
    /**
     * 推送事件给桌宠（主进程 → 渲染进程）。
     *
     * 这是**唯一**的反向通道：任务收尾、日程临期、幕僚简报都走这一条，
     * 契约见 `packages/web/src/lib/petEvent.ts` 的 PetEventPayload。
     * 主进程内部可直接 pushEvent（不做 gating）；主窗口发起的走 `deliverEventFromMain`
     * （渠道互斥 + 桌宠隐藏时不补发）。
     */
    pushEvent = (payload) => {
      if (!win || win.isDestroyed()) return false;
      if (!payload || typeof payload !== "object" || typeof payload.kind !== "string") return false;
      try {
        win.webContents.send("pet:event", payload);
        return true;
      } catch {
        return false;
      }
    };

    // 主窗口也可以发起（例如「把这条简报交给桌宠说」）；只认主窗口与桌宠窗口。
    // ★ 主窗口发起时先过渠道互斥：前台时只走通知中心，桌宠隐藏时丢弃（错过不补发）。
    ipcMain.on("pet:emit", (event, payload) => {
      if (fromPetWindow(event)) {
        pushEvent(payload);
        return;
      }
      if (!fromMainWindow(event)) return;
      deliverEventFromMain(payload);
    });

    /**
     * 桌宠点气泡 → 主窗口直达对应页面。
     *
     * 复用既有通道名（不新增 IPC），载荷从「无参」升级为可选 page：
     * page 经白名单归一化后原样转给主窗口（**字符串**，与 preload 的
     * `onOpenSettings(cb: (page?: string) => void)` 口径一致）；旧调用/非法 page 转发 undefined，
     * 主窗口按「打开设置」处理。
     */
    ipcMain.on("pet:open-settings", (event, payload) => {
      if (!fromPetWindow(event)) return;
      const page = normalizePetPage(payload);
      const main = getMainWindow && getMainWindow();
      if (main && !main.isDestroyed()) {
        if (main.isMinimized()) main.restore();
        main.show();
        main.focus();
        main.webContents.send("pet:open-settings", page ?? undefined);
      }
    });
  }

  /* ────────────────────────── 托盘 ────────────────────────── */

  function trayTemplate() {
    const visible = state.visible && win && !win.isDestroyed() && win.isVisible();
    return [
      { label: visible ? "隐藏桌宠" : "显示桌宠", click: () => toggle() },
      { type: "separator" },
      {
        label: "鼠标穿透（不挡桌面点击）",
        type: "checkbox",
        checked: state.clickThrough,
        click: (item) => setClickThrough(item.checked),
      },
      { label: "放大一档", click: () => stepScale(1) },
      { label: "缩小一档", click: () => stepScale(-1) },
      { type: "separator" },
      {
        label: "打开和鸣主窗口",
        click: () => {
          const main = getMainWindow && getMainWindow();
          if (main && !main.isDestroyed()) {
            if (main.isMinimized()) main.restore();
            main.show();
            main.focus();
          }
        },
      },
      { type: "separator" },
      { label: "退出", click: () => deps.app && deps.app.quit() },
    ];
  }

  function refreshTrayMenu() {
    if (!tray) return;
    try {
      tray.setContextMenu(Menu.buildFromTemplate(trayTemplate()));
    } catch (err) {
      log(`[pet] 托盘菜单刷新失败：${(err && err.message) || err}`);
    }
  }

  function createTray() {
    if (tray) return tray;
    let image;
    try {
      image = nativeImage.createFromPath(trayIconPath);
    } catch {
      image = nativeImage.createEmpty();
    }
    tray = new Tray(image);
    tray.setToolTip("和鸣桌宠");
    refreshTrayMenu();
    // 左键点托盘 = 显隐（与菜单首项同一语义，少一次点击）
    tray.on("click", () => toggle());
    return tray;
  }

  /** 启动时按持久化状态决定是否直接出现（用户上次关掉的，不自动弹回来）。 */
  function start() {
    loadState();
    registerIpc();
    createTray();
    if (state.visible) show();
  }

  return {
    start,
    show,
    hide,
    toggle,
    destroy,
    setScale,
    stepScale,
    setClickThrough,
    setInteractive,
    /** 反向通道：向桌宠推送事件（主进程 → 渲染）。见上方 pushEvent 的说明。 */
    pushEvent: (payload) => pushEvent(payload),
    /** 主窗口发起的事件入口（带渠道互斥 / 隐藏丢弃）；返回判定字符串便于测试与诊断。 */
    deliverEventFromMain: (payload) => deliverEventFromMain(payload),
    refreshTrayMenu,
    get window() {
      return win;
    },
    get state() {
      return { ...state };
    },
    /** 测试用：直接读内部判定结果 */
    get isInteractive() {
      return interactive;
    },
    _internal: { createWindow, beginDrag, dragTo, endDrag, saveNow, loadState, applyMouseIgnore },
  };
}

module.exports = { createPetHost, SAVE_DEBOUNCE_MS };
