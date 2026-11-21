"use strict";
const test = require("node:test");
const assert = require("node:assert/strict");
const fs = require("node:fs");
const path = require("node:path");
const { createWidgetHost, normalizeEvent } = require("./plugin-host");
const { normalizeWidgetSpec, widgetWindowSize, defaultWidgetPosition } = require("./plugin-window");
// data API 的 key 规则/上限与真 store 同源：假 store 复用同一份校验，避免测试替身放宽口径。
const { assertDataKey, DATA_MAX_BYTES } = require("./plugin-store");

/* ────────────────────────────── 假对象 ────────────────────────────── */

const SPEC = normalizeWidgetSpec({
  id: "pet",
  name: "桌宠",
  entry: "files/index.html",
  width: 300,
  height: 420,
  scales: [0.6, 0.8, 1, 1.25, 1.5],
  transparent: true,
  alwaysOnTop: true,
  clickThrough: "auto",
  settings: { fields: [{ key: "bubble", type: "boolean", label: "气泡", default: true }] },
  tray: { items: ["toggle", "clickThrough", "resetPosition", "settings"] },
}).spec;

function makeFakeElectron() {
  const created = [];
  const createdViews = [];

  // 页面视图共用的假 session（will-download 是 session 级事件）。
  const sessionListeners = new Map();
  let nextViewLoadError = null;
  const fakeSession = {
    on: (event, fn) => {
      if (!sessionListeners.has(event)) sessionListeners.set(event, new Set());
      sessionListeners.get(event).add(fn);
    },
    removeListener: (event, fn) => {
      sessionListeners.get(event)?.delete(fn);
    },
    emit: (event, ...args) => {
      for (const fn of [...(sessionListeners.get(event) ?? [])]) fn(...args);
    },
    listenerCount: (event) => sessionListeners.get(event)?.size ?? 0,
  };

  /**
   * WebContentsView 替身（d.124 页面视图）：webContents 记录 URL/监听器/发送/close，
   * 视图本身记录 setBounds 调用；不模拟真实渲染。
   */
  class FakeWebContentsView {
    constructor(opts) {
      this.opts = opts;
      this.bounds = null;
      this.webContents = {
        _sent: [],
        _listeners: {},
        _openHandler: null,
        _url: null,
        _closed: false,
        _reloaded: 0,
        _loadError: nextViewLoadError,
        session: fakeSession,
        on: (ch, fn) => {
          this.webContents._listeners[ch] = fn;
        },
        setWindowOpenHandler: (fn) => {
          this.webContents._openHandler = fn;
        },
        send: (ch, payload) => this.webContents._sent.push({ ch, payload }),
        close: () => {
          this.webContents._closed = true;
        },
        loadURL: async (url) => {
          this.webContents._url = url;
          if (this.webContents._loadError) throw this.webContents._loadError;
        },
        reload: () => {
          this.webContents._reloaded += 1;
        },
      };
      createdViews.push(this);
      // 一次性的「下一次加载失败」注入：让 mount 的失败分支可测（真实环境是文件缺失/损坏）
      nextViewLoadError = null;
    }
    setBounds(rect) {
      this.bounds = { ...rect };
      this._setBoundsCalls = (this._setBoundsCalls || 0) + 1;
    }
    getBounds() {
      return this.bounds ? { ...this.bounds } : { x: 0, y: 0, width: 0, height: 0 };
    }
  }


  class FakeBrowserWindow {
    constructor(opts) {
      this.opts = opts;
      this._bounds = { x: opts.x, y: opts.y, width: opts.width, height: opts.height };
      this._visible = false;
      this._destroyed = false;
      this._ignoreMouse = null;
      this._setPositionCalls = 0;
      this._setBoundsCalls = 0;
      this._url = null;
      this._inactiveShown = false;
      this._throttling = undefined;
      this._reloaded = 0;
      this.webContents = {
        _sent: [],
        _listeners: {},
        _openHandler: null,
        on: (ch, fn) => {
          this.webContents._listeners[ch] = fn;
        },
        setWindowOpenHandler: (fn) => {
          this.webContents._openHandler = fn;
        },
        send: (ch, payload) => this.webContents._sent.push({ ch, payload }),
        setBackgroundThrottling: (value) => {
          this._throttling = value;
        },
        reload: () => {
          this._reloaded += 1;
        },
      };
      created.push(this);
    }
    isDestroyed() { return this._destroyed; }
    isVisible() { return this._visible && !this._destroyed; }
    isMinimized() { return false; }
    isFocused() { return this._focused === true; }
    getBounds() { return { ...this._bounds }; }
    setBounds(b) { this._setBoundsCalls += 1; this._bounds = { ...this._bounds, ...b }; }
    setPosition(x, y) { this._setPositionCalls += 1; this._bounds.x = x; this._bounds.y = y; }
    show() { this._visible = true; }
    showInactive() { this._visible = true; this._inactiveShown = true; }
    hide() { this._visible = false; }
    focus() { this._focused = true; }
    restore() {}
    destroy() { this._destroyed = true; this._visible = false; }
    setIgnoreMouseEvents(v, o) { this._ignoreMouse = { v, o }; }
    loadURL(url) { this._url = url; }
    on() {}
  }
  FakeBrowserWindow.fromWebContents = (wc) => created.find((w) => w.webContents === wc) || null;
  FakeBrowserWindow.getAllWindows = () => created;

  const handles = new Map();
  const ons = new Map();
  const ipcMain = {
    handle: (ch, fn) => handles.set(ch, fn),
    on: (ch, fn) => ons.set(ch, fn),
  };

  const trayMenus = [];
  class FakeTray {
    constructor(image) { this.image = image; FakeTray.last = this; }
    setToolTip() {}
    setContextMenu(menu) { trayMenus.push(menu); this.menu = menu; }
    on() {}
    destroy() { this.destroyed = true; }
  }

  let cursor = { x: 0, y: 0 };
  const displayListeners = new Map();
  const screen = {
    getAllDisplays: () => [{ workArea: { x: 0, y: 0, width: 1920, height: 1040 } }],
    getPrimaryDisplay: () => ({ workArea: { x: 0, y: 0, width: 1920, height: 1040 } }),
    getCursorScreenPoint: () => ({ ...cursor }),
    setCursor: (x, y) => { cursor = { x, y }; },
    on: (event, fn) => {
      if (!displayListeners.has(event)) displayListeners.set(event, new Set());
      displayListeners.get(event).add(fn);
    },
    removeListener: (event, fn) => {
      displayListeners.get(event)?.delete(fn);
    },
    emit: (event) => {
      for (const fn of displayListeners.get(event) ?? []) fn();
    },
    listenerCount: (event) => displayListeners.get(event)?.size ?? 0,
  };

  return {
    electron: {
      BrowserWindow: FakeBrowserWindow,
      WebContentsView: FakeWebContentsView,
      Tray: FakeTray,
      Menu: { buildFromTemplate: (template) => ({ template }) },
      nativeImage: { createFromPath: (p) => ({ path: p }), createEmpty: () => ({}) },
      screen,
      ipcMain,
    },
    created,
    createdViews,
    fakeSession,
    setNextViewLoadError: (error) => {
      nextViewLoadError = error || null;
    },
    handles,
    ons,
    trayMenus,
    screen,
    FakeTray,
    FakeBrowserWindow,
    FakeWebContentsView,
  };
}

function makeStore(overrides = {}) {
  const records = overrides.records || [
    {
      id: "heming.pet",
      name: "桌宠",
      version: "1.0.0",
      enabled: true,
      widget: SPEC,
      permissions: { events: ["notify"] },
      settings: { bubble: true },
      installedAt: "2026-11-07T00:00:00.000Z",
    },
  ];
  const state = new Map();
  const settings = new Map();
  // 假 data 目录：`<id>/data/<key>.json`，值按 JSON 文本存（模拟落盘后的类型收敛）
  const dataFiles = new Map();
  const dataPath = (id, key) => `${id}\u0000${key}`;
  return {
    _records: records,
    _state: state,
    _settings: settings,
    _data: dataFiles,
    list: () => records.map((record) => ({ ...record })),
    get: (id) => records.find((record) => record.id === id) || null,
    currentDir: (id) => (records.some((record) => record.id === id) ? `/plugins/${id}/1.0.0` : null),
    readState: (id) => state.get(id) ?? null,
    writeState: (id, value) => state.set(id, value),
    readSettings: (id) => settings.get(id) ?? (records.find((r) => r.id === id)?.settings ?? {}),
    patchSettings: (id, patch) => {
      const next = { ...(settings.get(id) ?? {}), ...patch };
      settings.set(id, next);
      return next;
    },
    dataDirOf: (id) => `/plugins/${id}/data`,
    readData: (id, key) => {
      assertDataKey(key);
      const text = dataFiles.get(dataPath(id, key));
      return text === undefined ? null : JSON.parse(text);
    },
    writeData: (id, key, value) => {
      assertDataKey(key);
      if (!records.some((record) => record.id === id)) throw new Error(`插件不存在：${id}`);
      const serialized = JSON.stringify(value, null, 2);
      if (serialized === undefined) throw new Error(`插件数据必须是可 JSON 序列化的值（${key}）`);
      const bytes = Buffer.byteLength(serialized, "utf8");
      if (bytes > DATA_MAX_BYTES) throw new Error(`插件数据超过单文件上限 1MB（${key}）：${bytes} 字节`);
      dataFiles.set(dataPath(id, key), serialized);
      return { key, bytes };
    },
    deleteData: (id, key) => {
      assertDataKey(key);
      return dataFiles.delete(dataPath(id, key));
    },
    listDataKeys: (id) => {
      const prefix = `${id}\u0000`;
      return [...dataFiles.keys()]
        .filter((entry) => entry.startsWith(prefix))
        .map((entry) => entry.slice(prefix.length))
        .sort();
    },
    setRecords: (next) => {
      records.length = 0;
      records.push(...next);
    },
  };
}

function makeHost(overrides = {}) {
  const fake = makeFakeElectron();
  const store = overrides.store || makeStore();
  const openedPages = [];
  const logs = [];
  const host = createWidgetHost({
    ...fake.electron,
    app: { quit() {} },
    store,
    preloadPath: "/tmp/widget-preload.js",
    defaultTrayIconPath: "/tmp/tray.png",
    getMainWindow: overrides.getMainWindow || (() => null),
    appVersion: () => "d.98.0",
    getTheme: () => "light",
    getGateway: overrides.getGateway || (async () => ({ baseUrl: "http://127.0.0.1:4242/v1", key: "local" })),
    requestChatConfig: overrides.requestChatConfig,
    // 引擎能力：默认给一个「不会被调用」的假解释器；要测引擎的用例自己注入 spawn
    spawn: overrides.spawn || (() => { throw new Error("测试未预期启动引擎"); }),
    bundledPythonPath: overrides.bundledPythonPath === undefined ? "/tmp/python" : overrides.bundledPythonPath,
    getKbRoots: overrides.getKbRoots,
    // contract §3：widget 桥的两条外部边界（默认不接；要测的用例自己注入）
    infohubRequest: overrides.infohubRequest,
    notifyPlugin: overrides.notifyPlugin,
    openPage: (payload) => openedPages.push(payload),
    log: (line) => logs.push(line),
    setTimeout: (fn) => { fn(); return 1; },
    clearTimeout: () => {},
    now: overrides.now,
  });
  lastHandles = fake.handles;
  lastOns = fake.ons;
  return { host, store, openedPages, logs, ...fake };
}

let lastHandles = new Map();
let lastOns = new Map();

/** 直接调主进程注册的 handler（模拟 IPC 到达）。 */
function invokeChannel(channel, event, ...args) {
  const fn = lastHandles.get(channel) || lastOns.get(channel);
  assert.ok(fn, `未注册通道：${channel}`);
  return fn(event, ...args);
}

/** 取已创建的那个 widget 窗口。 */
function onlyWindow(created) {
  assert.equal(created.length, 1, `应只创建一个窗口，实际 ${created.length}`);
  return created[0];
}

/* ── 生命周期事件（d.108）测试小工具 ── */

/** 声明了 lifecycle 权限的记录（默认启停/可见状态由用例覆盖）。 */
function lifecycleRecord(overrides = {}) {
  return {
    id: "heming.pet",
    name: "桌宠",
    version: "1.0.0",
    enabled: true,
    widget: SPEC,
    permissions: { events: ["notify", "lifecycle"] },
    settings: { bubble: true },
    installedAt: "2026-11-07T00:00:00.000Z",
    ...overrides,
  };
}

/** 一台只装了「声明 lifecycle」插件的 store。 */
function lifecycleStore() {
  const store = makeStore();
  store.setRecords([lifecycleRecord()]);
  return store;
}

/** 某窗口收到的生命周期事件载荷（按投递顺序）。 */
function lifecycleEvents(win) {
  return win.webContents._sent
    .filter((item) => item.ch === "widget:lifecycle")
    .map((item) => item.payload);
}

/** 触发页面加载完成（真实环境由 Electron 在 loadURL 完成后触发）。 */
function finishLoad(win) {
  const listener = win.webContents._listeners["did-finish-load"];
  assert.ok(listener, "窗口应注册 did-finish-load");
  listener();
}

/* ────────────────────────────── 启动与显隐 ────────────────────────────── */

test("启动：默认不自动显示（用户上次关掉的东西不该自己弹回来）", () => {
  const { host, created } = makeHost();
  host.start();
  assert.equal(created.length, 0);
  assert.equal(host.stateOf("heming.pet").visible, false);
});

test("启动：上次是显示状态则自动出现，且用 showInactive 不抢焦点", () => {
  const store = makeStore();
  store.writeState("heming.pet", { scale: 1, visible: true });
  const { host, created } = makeHost({ store });
  host.start();
  const win = onlyWindow(created);
  assert.equal(win._inactiveShown, true);
  assert.equal(host.stateOf("heming.pet").visible, true);
});

test("托盘在启动时就常驻（穿透模式下它是唯一可靠出口）", () => {
  const { host, FakeTray } = makeHost();
  host.start();
  assert.ok(FakeTray.last, "应创建托盘");
});

test("显隐切换：show → hide → toggle；隐藏时暂停渲染，显示时恢复", () => {
  const { host } = makeHost();
  host.start();
  assert.deepEqual(host.action("heming.pet", "show"), {
    ok: true,
    state: { visible: true, scale: 1, clickThrough: true },
  });
  const win = host.runtimeFor("heming.pet").window;
  assert.equal(win._throttling, false);
  host.action("heming.pet", "hide");
  assert.equal(win.isVisible(), false);
  assert.equal(win._throttling, true, "隐藏窗不该白烧 rAF");
  host.action("heming.pet", "toggle");
  assert.equal(win.isVisible(), true);
});

test("窗口被销毁后再 show 会重建；重建沿用已记忆的 bounds 与缩放", () => {
  const store = makeStore();
  store.writeState("heming.pet", { scale: 1.25, visible: true, bounds: { x: 10, y: 20, width: 300, height: 420 } });
  const { host, created } = makeHost({ store });
  host.start();
  const first = onlyWindow(created);
  first.destroy();
  host.action("heming.pet", "show");
  assert.equal(created.length, 2);
  const second = created[1];
  assert.equal(second.opts.x, 10);
  assert.equal(second.opts.y, 20);
  assert.equal(second.opts.width, 375);
});

test("窗口加载的是 widget:// 独立 origin 的清单入口（不是主应用页面）", () => {
  const { host, created } = makeHost();
  host.start();
  host.action("heming.pet", "show");
  assert.equal(onlyWindow(created)._url, "widget://heming.pet/files/index.html");
});

/* ────────────────────────────── 穿透 ────────────────────────────── */

test("默认穿透：创建后立刻 setIgnoreMouseEvents(true, forward)", () => {
  const { host, created } = makeHost();
  host.start();
  host.action("heming.pet", "show");
  assert.deepEqual(onlyWindow(created)._ignoreMouse, { v: true, o: { forward: true } });
});

test("穿透模式：光标进入角色 → 停止穿透；离开 → 恢复；重复上报不重复调用", () => {
  const { host, created } = makeHost();
  host.start();
  host.action("heming.pet", "show");
  const win = onlyWindow(created);
  // 通过 IPC 走一遍来源校验（sender = 该窗口）
  const event = { sender: win.webContents };
  win._ignoreMouse = null;
  invokeChannel("widget:set-interactive", event, true);
  assert.equal(win._ignoreMouse.v, false);
  win._ignoreMouse = null;
  invokeChannel("widget:set-interactive", event, true); // 重复上报同一值
  assert.equal(win._ignoreMouse, null);
  invokeChannel("widget:set-interactive", event, false);
  assert.equal(win._ignoreMouse.v, true);
});

test("关掉穿透后：无论光标在哪都不穿透（托盘开关是硬覆盖）", () => {
  const { host, created } = makeHost();
  host.start();
  host.action("heming.pet", "show");
  const win = onlyWindow(created);
  host.action("heming.pet", "toggleClickThrough");
  assert.equal(win._ignoreMouse.v, false);
  invokeChannel("widget:set-interactive", { sender: win.webContents }, true);
  assert.equal(win._ignoreMouse.v, false);
});

test("非本 widget 窗口发来的穿透请求被忽略（跨进程边界不靠调用方自觉）", () => {
  const { host, created } = makeHost();
  host.start();
  host.action("heming.pet", "show");
  const win = onlyWindow(created);
  win._ignoreMouse = null;
  const stranger = { sender: { fake: true } };
  assert.equal(invokeChannel("widget:set-interactive", stranger, true), undefined);
  assert.equal(win._ignoreMouse, null);
  // 未接线的通道（不是本窗口）一律拒绝
  assert.equal(invokeChannel("widget:state", stranger), null);
  assert.equal(invokeChannel("widget:set-scale", stranger, { dir: 1 }), null);
});

/* ────────────────────────────── 拖拽 ────────────────────────────── */

test("拖拽：按屏幕光标位移移动窗口，抬起时落盘", () => {
  const { host, store, created, screen } = makeHost();
  host.start();
  host.action("heming.pet", "show");
  const win = onlyWindow(created);
  win._bounds = { x: 100, y: 100, width: 300, height: 420 };
  const event = { sender: win.webContents };
  screen.setCursor(500, 500);
  invokeChannel("widget:drag-start", event);
  screen.setCursor(540, 520);
  invokeChannel("widget:drag-move", event);
  assert.equal(win._bounds.x, 140);
  assert.equal(win._bounds.y, 120);
  invokeChannel("widget:drag-end", event);
  assert.equal(store.readState("heming.pet").bounds.x, 140);
});

test("没有 drag-start 时 drag-move 不移动窗口（不会凭空跳）", () => {
  const { host, created, screen } = makeHost();
  host.start();
  host.action("heming.pet", "show");
  const win = onlyWindow(created);
  const before = { ...win._bounds };
  screen.setCursor(900, 900);
  invokeChannel("widget:drag-move", { sender: win.webContents });
  assert.deepEqual(win._bounds, before);
});

test("拖拽：位置没变时不重复 setPosition（少一次透明窗合成）", () => {
  const { host, created, screen } = makeHost();
  host.start();
  host.action("heming.pet", "show");
  const win = onlyWindow(created);
  screen.setCursor(500, 500);
  invokeChannel("widget:drag-start", { sender: win.webContents });
  screen.setCursor(520, 500);
  invokeChannel("widget:drag-move", { sender: win.webContents });
  const calls = win._setPositionCalls;
  screen.setCursor(520, 500); // 光标没动
  invokeChannel("widget:drag-move", { sender: win.webContents });
  assert.equal(win._setPositionCalls, calls);
  invokeChannel("widget:drag-end", { sender: win.webContents });
});

test("拖拽期间：渲染层的穿透上报被忽略（不在移动中反复切 ignore-mouse）", () => {
  const { host, created, screen } = makeHost();
  host.start();
  host.action("heming.pet", "show");
  const win = onlyWindow(created);
  screen.setCursor(500, 500);
  invokeChannel("widget:drag-start", { sender: win.webContents });
  win._ignoreMouse = null;
  invokeChannel("widget:set-interactive", { sender: win.webContents }, true);
  assert.equal(win._ignoreMouse, null);
});

test("拖拽收尾：按当前光标补终值 + 贴边吸附 + 落盘", () => {
  const { host, store, created, screen } = makeHost();
  host.start();
  host.action("heming.pet", "show");
  const win = onlyWindow(created);
  win._bounds = { x: 0, y: 0, width: 300, height: 420 };
  screen.setCursor(500, 500);
  invokeChannel("widget:drag-start", { sender: win.webContents });
  screen.setCursor(503, 502); // 收尾位置 = (3, 2)，在 12px 吸附阈值内
  invokeChannel("widget:drag-end", { sender: win.webContents });
  assert.equal(win._bounds.x, 0, "距左边 3px 应吸附到 0");
  assert.equal(win._bounds.y, 0, "距上边 2px 应吸附到 0");
  assert.equal(store.readState("heming.pet").bounds.x, 0);
});

/* ────────────────────────────── 缩放 / 位置 / 显示器 ────────────────────────────── */

test("放大一档：尺寸变化且右下角锚点不动", () => {
  const { host, created } = makeHost();
  host.start();
  host.action("heming.pet", "show");
  const win = onlyWindow(created);
  win._bounds = { x: 1000, y: 500, width: 300, height: 420 };
  host.action("heming.pet", "scaleUp");
  assert.equal(win._bounds.width, 375);
  assert.equal(win._bounds.height, 525);
  assert.equal(win._bounds.x, 925);
  assert.equal(win._bounds.y, 395);
});

test("缩放两端夹住；非法动作返回 ok:false", () => {
  const { host } = makeHost();
  host.start();
  host.action("heming.pet", "show");
  for (let i = 0; i < 10; i += 1) host.action("heming.pet", "scaleUp");
  assert.equal(host.stateOf("heming.pet").scale, 1.5);
  for (let i = 0; i < 10; i += 1) host.action("heming.pet", "scaleDown");
  assert.equal(host.stateOf("heming.pet").scale, 0.6);
  const bad = host.action("heming.pet", "explode");
  assert.equal(bad.ok, false);
  assert.equal(host.action("nope", "show").ok, false);
});

test("重置位置：回到工作区右下角默认落位并立即落盘；已是默认位时 no-op", () => {
  const { host, store, created } = makeHost();
  host.start();
  host.action("heming.pet", "show");
  const win = onlyWindow(created);
  win._bounds = { x: 5, y: 5, width: 300, height: 420 };
  host.action("heming.pet", "resetPosition");
  const expected = defaultWidgetPosition(SPEC, { x: 0, y: 0, width: 1920, height: 1040 }, widgetWindowSize(SPEC, 1));
  assert.deepEqual({ x: win._bounds.x, y: win._bounds.y }, expected);
  assert.deepEqual(store.readState("heming.pet").bounds, { ...expected, width: 300, height: 420 });
  const calls = win._setPositionCalls;
  host.action("heming.pet", "resetPosition");
  assert.equal(win._setPositionCalls, calls);
});

test("显示器变化：按当前档位重算尺寸、保持右下角不动；拖拽中不重算；尺寸一致不重复 setBounds", () => {
  const { host, created, screen } = makeHost();
  host.start();
  host.action("heming.pet", "show");
  const win = onlyWindow(created);
  win._bounds = { x: 1000, y: 500, width: 200, height: 200 };
  screen.emit("display-metrics-changed");
  assert.equal(win._bounds.width, 300);
  assert.equal(win._bounds.height, 420);
  assert.equal(win._bounds.x, 900);
  assert.equal(win._bounds.y, 280);

  const calls = win._setBoundsCalls;
  screen.emit("display-added");
  assert.equal(win._setBoundsCalls, calls, "尺寸已一致时不重复 setBounds");

  screen.setCursor(10, 10);
  invokeChannel("widget:drag-start", { sender: win.webContents });
  win._bounds = { x: 1, y: 2, width: 111, height: 222 };
  screen.emit("display-removed");
  assert.equal(win._bounds.width, 111, "拖拽中不和拖拽争抢窗口位置");
});

test("销毁：窗口与托盘都回收，且销毁前落盘一次；显示器监听解绑", () => {
  const { host, store, created, screen, FakeTray } = makeHost();
  host.start();
  host.action("heming.pet", "show");
  const win = onlyWindow(created);
  win._bounds = { x: 77, y: 88, width: 300, height: 420 };
  assert.ok(screen.listenerCount("display-metrics-changed") > 0);
  host.destroyAll();
  assert.equal(win.isDestroyed(), true);
  assert.equal(FakeTray.last.destroyed, true);
  assert.equal(screen.listenerCount("display-metrics-changed"), 0);
  assert.equal(store.readState("heming.pet").bounds.x, 77);
  host.destroyAll(); // 幂等
});

/* ────────────────────────────── 事件 ────────────────────────────── */

function fakeMainWindow(focused) {
  const win = {
    isDestroyed: () => false,
    isVisible: () => true,
    isMinimized: () => false,
    isFocused: () => focused,
    show() {},
    focus() {},
    restore() {},
  };
  return win;
}

test("渠道互斥：主窗口在前台 → 通知被抑制，widget 不冒泡", () => {
  const { host } = makeHost({ getMainWindow: () => fakeMainWindow(true) });
  host.start();
  host.action("heming.pet", "show");
  assert.equal(host.publish({ kind: "notify", title: "任务完成" }), "suppressed-foreground");
});

test("主窗不在前台 + widget 可见 → 正常送达 widget:event", () => {
  const { host } = makeHost({ getMainWindow: () => fakeMainWindow(false) });
  host.start();
  host.action("heming.pet", "show");
  const win = host.runtimeFor("heming.pet").window;
  assert.equal(host.publish({ kind: "notify", title: "任务完成", summary: "3 项", route: "tasks" }), "delivered");
  const event = win.webContents._sent.find((item) => item.ch === "widget:event");
  assert.ok(event);
  assert.deepEqual(event.payload, { kind: "notify", title: "任务完成", summary: "3 项", route: "tasks" });
});

test("错过不补发：widget 隐藏时事件直接丢弃", () => {
  const { host } = makeHost({ getMainWindow: () => fakeMainWindow(false) });
  host.start(); // 默认隐藏
  assert.equal(host.publish({ kind: "notify", title: "x" }), "no-target");
});

test("畸形事件一律 invalid；不带 notify 权限的插件收不到", () => {
  const store = makeStore();
  store._records[0].permissions = { events: [] };
  const { host, created } = makeHost({ store, getMainWindow: () => fakeMainWindow(false) });
  host.start();
  host.action("heming.pet", "show");
  const win = onlyWindow(created);
  assert.equal(host.publish(null), "invalid");
  assert.equal(host.publish({ kind: "nope" }), "invalid");
  assert.equal(host.publish({ kind: "notify" }), "invalid"); // 缺 title
  assert.equal(host.publish({ kind: "notify", title: "x" }), "no-target");
  assert.equal(win.webContents._sent.filter((item) => item.ch === "widget:event").length, 0);
});

test("theme 事件：更新宿主 theme（投递门禁见「theme / tray 事件」用例）", () => {
  const store = makeStore();
  store.setRecords([{ ...store._records[0], permissions: { events: ["notify", "theme"] } }]);
  const { host, created } = makeHost({ store });
  host.start();
  host.action("heming.pet", "show");
  const win = onlyWindow(created);
  assert.equal(host.publish({ kind: "theme", theme: "dark" }), "delivered");
  assert.equal(invokeChannel("widget:info", { sender: win.webContents }).theme, "dark");
});

/* ────────────────────────────── 设置 / 动作 / 跳页 ────────────────────────────── */

test("widget:settings-set：写入后推 widget:settings 全量给窗口", () => {
  const { host, store, created } = makeHost();
  host.start();
  host.action("heming.pet", "show");
  const win = onlyWindow(created);
  const next = invokeChannel("widget:settings-set", { sender: win.webContents }, { key: "bubble", value: false });
  assert.deepEqual(next, { bubble: false });
  assert.equal(store.readSettings("heming.pet").bubble, false);
  const pushed = win.webContents._sent.find((item) => item.ch === "widget:settings");
  assert.deepEqual(pushed.payload, { bubble: false });
});

test("widget:open-settings / 托盘设置项：都落到「外观 · 桌面小组件」页", () => {
  const { host, created, openedPages, trayMenus } = makeHost();
  host.start();
  host.action("heming.pet", "show");
  const win = onlyWindow(created);
  invokeChannel("widget:open-settings", { sender: win.webContents });
  assert.deepEqual(openedPages[0], { page: "settings", settingsTab: "appearance", pluginId: "heming.pet" });

  // 托盘「设置…」
  const template = trayMenus[trayMenus.length - 1].template;
  const settingsItem = template.find((item) => item.label === "设置…");
  settingsItem.click();
  assert.deepEqual(openedPages[1], { page: "settings", settingsTab: "appearance", pluginId: "heming.pet" });
});

test("widget:open-page：白名单外的页丢弃并记日志（进程边界不信任渲染层）", () => {
  const { host, created, openedPages, logs } = makeHost();
  host.start();
  host.action("heming.pet", "show");
  const win = onlyWindow(created);
  invokeChannel("widget:open-page", { sender: win.webContents }, { page: "infohub" });
  assert.deepEqual(openedPages[0], { page: "infohub", pluginId: "heming.pet" });
  invokeChannel("widget:open-page", { sender: win.webContents }, "https://evil.example");
  assert.equal(openedPages.length, 1);
  assert.match(logs.join("\n"), /丢弃未知页面跳转/);
});

test("widget:chat-config：网关来自主进程、agents 只含 id/name、30s 内缓存（P0-1 不下发 prompt）", async () => {
  let calls = 0;
  const { host } = makeHost({
    requestChatConfig: async () => {
      calls += 1;
      // 主窗即使给了 prompt，宿主也必须在 normalize 阶段剥掉（P0-1 数据外泄链）
      return { agents: [{ id: "a1", name: "幕僚", prompt: "SECRET-PERSONA" }], binding: { agentId: "a1" } };
    },
  });
  const config = await host.getChatConfig();
  assert.deepEqual(config, {
    gateway: { baseUrl: "http://127.0.0.1:4242/v1", key: "local" },
    agents: [{ id: "a1", name: "幕僚" }],
    binding: { agentId: "a1" },
    models: [],
    backgroundModel: null,
  });
  assert.ok(!JSON.stringify(config).includes("SECRET-PERSONA"), "chatConfig 不得下发智能体 prompt");
  await host.getChatConfig();
  assert.equal(calls, 1, "30s 内应命中缓存");
  host.invalidateChatConfig();
  await host.getChatConfig();
  assert.equal(calls, 2);
});

test("widget:chat-config：模型目录剥掉坏项、后台模型只认目录内 id（d.125）", async () => {
  const { host } = makeHost({
    requestChatConfig: async () => ({
      agents: [],
      models: [
        { id: "cheap", name: "便宜模型" },
        { id: "", name: "无 id" },
        { id: "no-name" },
        { id: "x".repeat(200), name: "y".repeat(300) },
        { id: 42, name: "非字符串" },
      ],
      backgroundModel: "cheap",
    }),
  });
  const config = await host.getChatConfig();
  assert.deepEqual(config.models, [
    { id: "cheap", name: "便宜模型" },
    { id: "no-name", name: "no-name" },
    { id: "x".repeat(128), name: "y".repeat(128) + "…" },
  ]);
  assert.equal(config.backgroundModel, "cheap");
});

test("widget:chat-config：后台模型已下架 → 置空（不发必然 404 的请求）", async () => {
  const { host } = makeHost({
    requestChatConfig: async () => ({ agents: [], models: [{ id: "a", name: "A" }], backgroundModel: "gone" }),
  });
  const config = await host.getChatConfig();
  assert.equal(config.backgroundModel, null);
});

test("widget:engine-status：没有引擎的插件返回 declared=false，不报错", () => {
  const { host, created } = makeHost();
  host.start();
  host.action("heming.pet", "show");
  const win = onlyWindow(created);
  const status = invokeChannel("widget:engine-status", { sender: win.webContents });
  assert.deepEqual(status, { declared: false, running: false, pid: null, startedAt: null, error: "" });
});

test("widget:engine-call：未声明引擎 → 拒绝；非本插件 sender → 拒绝（fail-closed）", async () => {
  const { host, created } = makeHost();
  host.start();
  host.action("heming.pet", "show");
  const win = onlyWindow(created);
  await assert.rejects(
    () => invokeChannel("widget:engine-call", { sender: win.webContents }, { method: "ping", params: {} }),
    /没有声明本机引擎/,
  );
  // 未知 sender：withRuntimeOrPage 走 fail-closed 的 null（不回调用方任何东西）
  assert.equal(
    invokeChannel("widget:engine-call", { sender: {} }, { method: "ping", params: {} }),
    null,
  );
});

test("widget:chat-config：主窗不应答时降级为空 agents，不抛错", async () => {
  const { host, created } = makeHost({ requestChatConfig: async () => null });
  host.start();
  host.action("heming.pet", "show");
  const config = await host.getChatConfig();
  assert.deepEqual(config.agents, []);
  assert.deepEqual(config.binding, { agentId: null });
  assert.equal(invokeChannel("widget:chat-config", { sender: { fake: true } }), null);
});

test("widget:chat-config：未声明 permissions.chat 拿不到网关与智能体；声明后也不下发 prompt（P0-1）", async () => {
  const store = makeStore();
  store.setRecords([{ ...store._records[0], permissions: { events: ["notify"] } }]);
  const { host, created } = makeHost({
    store,
    requestChatConfig: async () => ({
      agents: [{ id: "a1", name: "幕僚", prompt: "SECRET-PERSONA" }],
      binding: { agentId: "a1" },
    }),
  });
  host.start();
  host.action("heming.pet", "show");
  const win = onlyWindow(created);

  const denied = await invokeChannel("widget:chat-config", { sender: win.webContents });
  assert.equal(denied.gateway, null);
  assert.deepEqual(denied.agents, []);
  assert.match(denied.reason, /permissions\.chat/);

  // 升级到声明 chat:true 的版本 → 拿得到网关与 id/name，但 prompt 仍不下发
  store.setRecords([{ ...store._records[0], version: "2.0.0", permissions: { events: ["notify"], chat: true } }]);
  host.reconcile();
  const nextWin = created[created.length - 1];
  const config = await invokeChannel("widget:chat-config", { sender: nextWin.webContents });
  assert.equal(config.gateway.baseUrl, "http://127.0.0.1:4242/v1");
  assert.deepEqual(config.agents, [{ id: "a1", name: "幕僚" }]);
  assert.ok(!("prompt" in config.agents[0]));
});

test("theme / tray 事件：必须由 permissions.events 声明才投递（P1-5）", () => {
  const store = makeStore();
  // 未声明 theme/tray → 不投递，但宿主仍记住主题（新窗口 info().theme 要正确）
  const { host, created } = makeHost({ store });
  host.start();
  host.action("heming.pet", "show");
  const first = onlyWindow(created);
  assert.equal(host.publish({ kind: "theme", theme: "dark" }), "no-target");
  assert.equal(host.publish({ kind: "tray", action: "toggle" }), "no-target");
  assert.equal(first.webContents._sent.filter((item) => item.ch === "widget:event").length, 0);
  assert.equal(invokeChannel("widget:info", { sender: first.webContents }).theme, "dark");

  // 声明 theme / tray（版本变化触发重建）→ 对应事件才收到
  store.setRecords([
    { ...store._records[0], version: "2.0.0", permissions: { events: ["notify", "theme", "tray"] } },
  ]);
  host.reconcile();
  const second = created[created.length - 1];
  assert.equal(second.isDestroyed(), false);
  assert.equal(host.publish({ kind: "theme", theme: "light" }), "delivered");
  assert.equal(host.publish({ kind: "tray", action: "toggle" }), "delivered");
  const sent = second.webContents._sent.filter((item) => item.ch === "widget:event").map((item) => item.payload);
  assert.deepEqual(sent, [
    { kind: "theme", theme: "light" },
    { kind: "tray", action: "toggle" },
  ]);
});

/* ────────────────────────────── 对账 ────────────────────────────── */

test("对账：停用/卸载的插件销毁窗口；换版本重建", () => {
  const store = makeStore();
  const { host, created } = makeHost({ store });
  host.start();
  host.action("heming.pet", "show");
  assert.equal(host.size, 1);

  store.setRecords([{ ...store._records[0], enabled: false }]);
  host.reconcile();
  assert.equal(host.size, 0);
  assert.equal(created[0].isDestroyed(), true);

  store.setRecords([{ ...store._records[0], enabled: true }]);
  host.reconcile();
  assert.equal(host.size, 1);

  store.setRecords([{ ...store._records[0], version: "2.0.0" }]);
  host.reconcile();
  assert.equal(host.size, 1);
  assert.equal(created.length, 3, "换版本应重建窗口");
});

test("对账：文件缺失（error）的记录不建窗", () => {
  const store = makeStore();
  store._records[0].error = "插件文件缺失，请重新安装";
  const { host, created } = makeHost({ store });
  host.start();
  assert.equal(host.size, 0);
  assert.equal(created.length, 0);
});

test("widget:chat-config：binding.agentId 由插件设置覆盖（主窗固定回 null），且覆盖不进缓存", async () => {
  let calls = 0;
  const store = makeStore();
  store.setRecords([{ ...store._records[0], permissions: { events: ["notify"], chat: true } }]);
  const { host, created } = makeHost({
    store,
    requestChatConfig: async () => {
      calls += 1;
      return { agents: [{ id: "a1", name: "幕僚" }], binding: { agentId: null } };
    },
  });
  host.start();
  host.action("heming.pet", "show");
  const win = onlyWindow(created);

  const before = await invokeChannel("widget:chat-config", { sender: win.webContents });
  assert.equal(before.binding.agentId, null);

  // 用户在插件设置里选了「对话绑定智能体」→ 下一次 chatConfig 必须带上
  invokeChannel("widget:settings-set", { sender: win.webContents }, { key: "agentId", value: "a1" });
  const after = await invokeChannel("widget:chat-config", { sender: win.webContents });
  assert.equal(after.binding.agentId, "a1");
  // 覆盖不进缓存：设置变更会让缓存失效，主窗被重新问一次
  assert.equal(calls, 2);
});

/* ──────────────────── 生命周期事件（d.108，规格 §5.4） ──────────────────── */

test("生命周期：首装 installed 在窗口加载完成后投递一次，重载不重放", () => {
  const store = lifecycleStore();
  store.setRecords([]); // 启动时没有任何插件 → 补种阶段为空
  const { host, created } = makeHost({ store });
  host.start();

  // 运行中首装一只新插件（真实链路：widgetStore.install 之后 main 调 reconcile）
  store.setRecords([lifecycleRecord({ id: "heming.clock", name: "时钟" })]);
  host.reconcile();
  assert.equal(created.length, 0, "默认不自动显示，首装这一轮不必建窗");

  // 用户显示 → 建窗 → 页面加载完成才投递（窗口没建好前排队）
  host.action("heming.clock", "show");
  const win = onlyWindow(created);
  assert.deepEqual(lifecycleEvents(win), [], "页面还没加载完，不应提前投递");
  finishLoad(win);
  assert.deepEqual(lifecycleEvents(win), [{ event: "installed", version: "1.0.0" }]);

  // 重载/窗口重建不重放（事件「取走即清空」）
  finishLoad(win);
  assert.deepEqual(lifecycleEvents(win), [{ event: "installed", version: "1.0.0" }]);
  host.destroyAll();
});

test("生命周期：启用发 enabled、停用发 disabled；未声明 lifecycle 的插件一条都收不到", () => {
  const store = lifecycleStore();
  store.writeState("heming.pet", { scale: 1, visible: true });
  store.setRecords([lifecycleRecord({ enabled: false })]);
  const { host, created } = makeHost({ store });
  host.start();
  assert.equal(created.length, 0, "停用的插件不建窗");

  // 启用 → 建窗 → 加载完成投递 enabled
  store.setRecords([lifecycleRecord({ enabled: true })]);
  host.reconcile();
  const win = onlyWindow(created);
  finishLoad(win);
  assert.deepEqual(lifecycleEvents(win), [{ event: "enabled", version: "1.0.0" }]);

  // 停用 → 最后一条 disabled，随后销毁（测试夹具的 setTimeout 同步执行）
  store.setRecords([lifecycleRecord({ enabled: false })]);
  host.reconcile();
  assert.deepEqual(lifecycleEvents(win), [
    { event: "enabled", version: "1.0.0" },
    { event: "disabled", version: "1.0.0" },
  ]);
  assert.equal(win.isDestroyed(), true);

  // 同一套流程换成「未声明 lifecycle」的插件 → 启停都不产生生命周期事件
  const plain = makeStore();
  plain.writeState("heming.pet", { scale: 1, visible: true });
  plain.setRecords([{ ...plain._records[0], enabled: false }]);
  const second = makeHost({ store: plain });
  second.host.start();
  plain.setRecords([{ ...plain._records[0], enabled: true }]);
  second.host.reconcile();
  const plainWin = onlyWindow(second.created);
  finishLoad(plainWin);
  assert.deepEqual(lifecycleEvents(plainWin), []);
  plain.setRecords([{ ...plain._records[0], enabled: false }]);
  second.host.reconcile();
  assert.deepEqual(lifecycleEvents(plainWin), []);
  assert.equal(plainWin.isDestroyed(), true);
});

test("生命周期：未声明 lifecycle 的插件连 installed 也收不到", () => {
  const store = makeStore();
  store.setRecords([]);
  const { host, created } = makeHost({ store });
  host.start();

  const plain = { ...makeStore()._records[0], id: "heming.plain", name: "普通插件" };
  plain.permissions = { events: ["notify"] };
  store.setRecords([plain]);
  host.reconcile();
  host.action("heming.plain", "show");
  const win = onlyWindow(created);
  finishLoad(win);
  assert.deepEqual(lifecycleEvents(win), []);
});

test("生命周期：版本变化发 updated（带 from），窗口按新版本重建，旧窗口收不到", () => {
  const store = lifecycleStore();
  store.writeState("heming.pet", { scale: 1, visible: true });
  const { host, created } = makeHost({ store });
  host.start();
  const first = onlyWindow(created);
  finishLoad(first);
  assert.deepEqual(lifecycleEvents(first), [], "宿主启动时已装的插件不补发 installed");

  store.setRecords([lifecycleRecord({ version: "2.0.0" })]);
  host.reconcile();
  assert.equal(created.length, 2, "版本变化应重建窗口");
  assert.equal(first.isDestroyed(), true);
  const second = created[1];
  finishLoad(second);
  assert.deepEqual(lifecycleEvents(second), [{ event: "updated", version: "2.0.0", from: "1.0.0" }]);
  assert.deepEqual(lifecycleEvents(first), [], "旧窗口已被销毁，不该收到 updated");
  // 重建后不重放
  finishLoad(second);
  assert.equal(lifecycleEvents(second).length, 1);
});

test("生命周期：卸载发 uninstalled（最后一条）后销毁窗口；宿主重启不补发", () => {
  const store = lifecycleStore();
  store.writeState("heming.pet", { scale: 1, visible: true });
  const { host, created } = makeHost({ store });
  host.start();
  const win = onlyWindow(created);
  finishLoad(win);
  assert.deepEqual(lifecycleEvents(win), [], "重启不补发 installed");

  store.setRecords([]); // 卸载：注册表里已经没有这条
  host.reconcile();
  assert.deepEqual(lifecycleEvents(win), [{ event: "uninstalled", version: "1.0.0" }]);
  assert.equal(win.isDestroyed(), true);
});

test("生命周期：排队上限 20 条，溢出丢最旧，投递顺序仍是最新状态（d.110）", () => {
  const store = lifecycleStore();
  store.setRecords([]);
  const { host, created, logs } = makeHost({ store });
  host.start();

  // 首装（默认不显示 → 不建窗，事件全部排队）
  store.setRecords([lifecycleRecord({ version: "1.0.0" })]);
  host.reconcile();
  // 连续 24 次版本变化（每次一个 updated，窗口始终没加载完）
  for (let v = 2; v <= 25; v += 1) {
    store.setRecords([lifecycleRecord({ version: `${v}.0.0` })]);
    host.reconcile();
  }
  assert.equal(created.length, 0, "未显示前不建窗");

  // 显示 → 建窗 → did-finish-load 才投递；队列截断到 20 条，最旧的 5 条被丢弃
  host.action("heming.pet", "show");
  const win = onlyWindow(created);
  finishLoad(win);
  const events = lifecycleEvents(win);
  assert.equal(events.length, 20, "队列不得超过上限");
  assert.deepEqual(events[0], { event: "updated", version: "6.0.0", from: "5.0.0" });
  assert.deepEqual(events[events.length - 1], { event: "updated", version: "25.0.0", from: "24.0.0" });
  assert.ok(!events.some((item) => item.event === "installed"), "过期的 installed 应被丢弃");

  // 不重放：再次 did-finish-load 不会重复投递
  finishLoad(win);
  assert.equal(lifecycleEvents(win).length, 20);

  // 丢弃是显式记录，不是静默截断
  assert.match(logs.join("\n"), /生命周期事件排队超过 20 条/);
});

/* ────────────────────────── 插件数据目录（widget:data-*） ────────────────────────── */

test("widget:data-*：按 sender 的 pluginId 隔离，目录指向各自安装目录", () => {
  const store = makeStore();
  const base = { ...store.list()[0] };
  store.setRecords([base, { ...base, id: "acme.demo", name: "示例插件" }]);
  const { host } = makeHost({ store });
  host.start();
  host.action("heming.pet", "show");
  host.action("acme.demo", "show");
  const petWin = host.runtimeFor("heming.pet").window;
  const demoWin = host.runtimeFor("acme.demo").window;
  assert.notEqual(petWin, demoWin);

  const petEvent = { sender: petWin.webContents };
  const demoEvent = { sender: demoWin.webContents };

  assert.deepEqual(invokeChannel("widget:data-set", petEvent, { key: "cache", value: { hits: 2 } }), {
    key: "cache",
    bytes: Buffer.byteLength(JSON.stringify({ hits: 2 }, null, 2), "utf8"),
  });
  assert.deepEqual(invokeChannel("widget:data-get", petEvent, { key: "cache" }), { hits: 2 });
  assert.deepEqual(invokeChannel("widget:data-keys", petEvent), ["cache"]);

  // 另一个插件拿不到：同 key 读不到、列表为空、删除是 no-op
  assert.equal(invokeChannel("widget:data-get", demoEvent, { key: "cache" }), null);
  assert.deepEqual(invokeChannel("widget:data-keys", demoEvent), []);
  assert.equal(invokeChannel("widget:data-delete", demoEvent, { key: "cache" }), false);
  assert.deepEqual(invokeChannel("widget:data-get", petEvent, { key: "cache" }), { hits: 2 });

  assert.deepEqual(invokeChannel("widget:data-dir", petEvent), { dir: "/plugins/heming.pet/data" });
  assert.deepEqual(invokeChannel("widget:data-dir", demoEvent), { dir: "/plugins/acme.demo/data" });

  assert.equal(invokeChannel("widget:data-delete", petEvent, { key: "cache" }), true);
  assert.equal(invokeChannel("widget:data-get", petEvent, { key: "cache" }), null);
});

test("widget:data-*：非法 key / 坏载荷 / 超 1MB 一律抛可读错误，不落盘", () => {
  const { host, store } = makeHost();
  host.start();
  host.action("heming.pet", "show");
  const win = host.runtimeFor("heming.pet").window;
  const sender = { sender: win.webContents };

  // 载荷形状
  assert.throws(() => invokeChannel("widget:data-get", sender, null), /载荷必须是 \{ key \}/);
  assert.throws(() => invokeChannel("widget:data-set", sender, null), /载荷必须是 \{ key \}/);
  assert.throws(() => invokeChannel("widget:data-set", sender, { key: 42, value: 1 }), /缺少字符串 key/);
  assert.throws(() => invokeChannel("widget:data-set", sender, { key: "ok" }), /缺少 value/);
  assert.throws(() => invokeChannel("widget:data-delete", sender, { key: "" }), /缺少字符串 key/);

  // key 规则（穿越 / 分隔符 / 超长）
  for (const key of ["../escape", "a/b", "a\b", "..", "x".repeat(65)]) {
    assert.throws(() => invokeChannel("widget:data-get", sender, { key }), /key/, `get 应拒绝 ${key}`);
    assert.throws(() => invokeChannel("widget:data-set", sender, { key, value: 1 }), /key/, `set 应拒绝 ${key}`);
    assert.throws(() => invokeChannel("widget:data-delete", sender, { key }), /key/, `delete 应拒绝 ${key}`);
  }

  // 不可序列化 / 超限
  assert.throws(() => invokeChannel("widget:data-set", sender, { key: "fn", value: () => {} }), /JSON/);
  assert.throws(
    () => invokeChannel("widget:data-set", sender, { key: "huge", value: "x".repeat(1024 * 1024) }),
    /1MB/,
  );

  assert.deepEqual(invokeChannel("widget:data-keys", sender), [], "失败调用不能留下任何 key");
  assert.equal(store._data.size, 0);
});

test("widget:data-*：未知窗口（sender 不属于任何 widget）一律拒绝", () => {
  const { host } = makeHost();
  host.start();
  host.action("heming.pet", "show");
  const stranger = { sender: { fake: true } };
  assert.equal(invokeChannel("widget:data-get", stranger, { key: "k" }), null);
  assert.equal(invokeChannel("widget:data-set", stranger, { key: "k", value: 1 }), null);
  assert.equal(invokeChannel("widget:data-delete", stranger, { key: "k" }), false);
  assert.deepEqual(invokeChannel("widget:data-keys", stranger), []);
  assert.equal(invokeChannel("widget:data-dir", stranger), null);
  // 窗口销毁后也不认（fail-closed）
  host.runtimeFor("heming.pet").window.destroy();
  const win = host.runtimeFor("heming.pet").window;
  assert.equal(invokeChannel("widget:data-get", { sender: win.webContents }, { key: "k" }), null);
});

test("widget-preload 暴露 data* 方法且只调用 widget: 通道", () => {
  const src = fs.readFileSync(path.join(__dirname, "widget-preload.js"), "utf8");
  for (const method of ["dataGet", "dataSet", "dataDelete", "dataKeys", "dataDir"]) {
    assert.ok(src.includes(`${method}:`), `widget-preload 应暴露 ${method}`);
  }
  for (const channel of [
    "widget:data-get",
    "widget:data-set",
    "widget:data-delete",
    "widget:data-keys",
    "widget:data-dir",
  ]) {
    assert.ok(src.includes(`"${channel}"`), `widget-preload 应调用 ${channel}`);
  }
});

/* ─────────────── 插件页面（d.141：渲染层 iframe + widget:// 内嵌） ─────────────── */

const PAGE_SPEC = { title: "我的面板", icon: "layout", summary: "插件页面", entry: "files/page/index.html" };
const PAGE_URL = "widget://acme.page/files/page/index.html";

/** 一只「只有页面、没有浮窗」的界面插件记录（bundle 可只声明 page）。 */
function pageRecord(overrides = {}) {
  return {
    id: "acme.page",
    name: "页面插件",
    version: "1.0.0",
    enabled: true,
    widget: null,
    page: { ...PAGE_SPEC },
    permissions: { events: ["notify"] },
    settings: {},
    installedAt: "2026-11-07T00:00:00.000Z",
    ...overrides,
  };
}

function pageStore(overrides = {}) {
  const store = makeStore();
  store.setRecords([pageRecord(overrides)]);
  return store;
}

/**
 * 假主窗：页面帧的唯一合法 sender。
 *
 * d.141 之后主进程不再往主窗 contentView 里塞视图，只需要 webContents（send/mainFrame）
 * ——渲染层负责把 widget:// 页面装进 <iframe>。
 */
function fakePageMainWindow() {
  const sent = [];
  let destroyed = false;
  const mainFrame = { name: "main" };
  const webContents = {
    _sent: sent,
    mainFrame,
    isDestroyed: () => destroyed,
    send: (ch, payload) => sent.push({ ch, payload }),
  };
  return {
    _sent: sent,
    webContents,
    isDestroyed: () => destroyed,
    destroy: () => {
      destroyed = true;
    },
  };
}

/** 主窗收到的页面事件（按投递顺序）：{id, channel, payload}。 */
function pageEvents(main) {
  return main.webContents._sent.filter((item) => item.ch === "widgets:page-event").map((item) => item.payload);
}

/** 页面帧发起的 IPC 事件（sender = 主窗 webContents，frame = 主框架）。 */
function frameEvent(main, extra = {}) {
  return { sender: main.webContents, frame: main.webContents.mainFrame, ...extra };
}

/** 建一个带主窗的宿主（插件页面测试用）。 */
function makePageHost(overrides = {}) {
  const main = overrides.main || fakePageMainWindow();
  const store = overrides.store || pageStore();
  const made = makeHost({ store, getMainWindow: () => main });
  return { ...made, store, main };
}

test("插件页面：pageOpen 只解析地址并登记 activePage，不创建任何 WebContentsView", () => {
  const { host, createdViews, logs } = makePageHost();

  const result = host.pageOpen({ id: "acme.page" });

  assert.deepEqual(result, { ok: true, url: PAGE_URL, version: "1.0.0" });
  assert.equal(host.pageCount, 1);
  assert.equal(host.activePage.id, "acme.page");
  assert.equal(host.activePage.url, PAGE_URL);
  assert.equal(createdViews.length, 0, "d.141 起不再建 WebContentsView");
  assert.ok(logs.some((line) => line.includes(`插件页面已打开：${PAGE_URL}`)));
});

test("插件页面：意图 token 合法时拼进 hash，插件页自己解释；非法/缺省不加 hash", () => {
  const { host } = makePageHost();

  assert.equal(host.pageOpen({ id: "acme.page", intent: "agenda" }).url, `${PAGE_URL}#intent=agenda`);

  // 大写/空白/超长/以符号开头都算非法：退化成普通入口，不给页面添噪音
  for (const intent of ["Agenda", "  ", "9" + "a".repeat(40), "-x", 42, null, undefined]) {
    assert.equal(
      host.pageOpen({ id: "acme.page", intent }).url,
      PAGE_URL,
      `非法 intent ${JSON.stringify(intent)} 不应改变入口地址`,
    );
  }

  // 首尾空白会被裁掉，不产生空格 hash
  assert.equal(host.pageOpen({ id: "acme.page", intent: "  search  " }).url, `${PAGE_URL}#intent=search`);
});

test("插件页面：未安装 / 停用 / 文件坏 / 没有 page / 缺 id / 主窗不可用 都拒绝，文案可直接展示", () => {
  const missing = makePageHost({ store: makeStore() });
  const notInstalled = missing.host.pageOpen({ id: "acme.page" });
  assert.equal(notInstalled.ok, false);
  assert.match(notInstalled.error, /未安装/);

  const disabled = makePageHost({ store: pageStore({ enabled: false }) });
  assert.match(disabled.host.pageOpen({ id: "acme.page" }).error, /已停用/);

  const broken = makePageHost({ store: pageStore({ error: "插件文件缺失，请重新安装" }) });
  assert.match(broken.host.pageOpen({ id: "acme.page" }).error, /文件缺失/);

  const noPage = makePageHost({ store: pageStore({ page: undefined }) });
  assert.match(noPage.host.pageOpen({ id: "acme.page" }).error, /没有声明页面/);

  // 非法 id / 入口非法 / 主窗不可用
  assert.match(missing.host.pageOpen({}).error, /缺少插件 id/);
  const badEntry = makePageHost({ store: pageStore({ page: { ...PAGE_SPEC, entry: "../escape.html" } }) });
  assert.match(badEntry.host.pageOpen({ id: "acme.page" }).error, /页面入口非法/);
  const noMain = makeHost({ store: pageStore(), getMainWindow: () => null });
  assert.match(noMain.host.pageOpen({ id: "acme.page" }).error, /主窗口不可用/);
});

test("插件页面：切换页面直接覆盖登记（同一时刻只服务一个），pageClose 幂等", () => {
  const store = pageStore();
  const other = pageRecord({ id: "acme.other", name: "另一个页面插件" });
  store.setRecords([pageRecord(), other]);
  const { host } = makePageHost({ store });

  assert.equal(host.pageOpen({ id: "acme.page" }).ok, true);
  assert.equal(host.pageOpen({ id: "acme.other" }).ok, true);
  assert.equal(host.activePage.id, "acme.other");
  assert.equal(host.pageCount, 1);

  assert.equal(host.pageClose(), true);
  assert.equal(host.activePage, null);
  assert.equal(host.pageCount, 0);
  assert.equal(host.pageClose(), false);
});

test("插件页面：pageCall 方法表派发到既有 widget:* 通道（错误走 {ok:false}，不抛）", async () => {
  const { host } = makePageHost();
  host.start();
  host.pageOpen({ id: "acme.page" });

  const info = await host.pageCall({ id: "acme.page", method: "info" });
  assert.equal(info.ok, true);
  assert.equal(info.value.pluginId, "acme.page");
  assert.equal(info.value.pluginName, "页面插件");
  assert.deepEqual((await host.pageCall({ id: "acme.page", method: "settings" })).value, {});

  // 多参方法：args 数组还原成既有通道的载荷形状
  assert.deepEqual(
    (await host.pageCall({ id: "acme.page", method: "dataSet", payload: ["cache", { hits: 2 }] })).value,
    { key: "cache", bytes: Buffer.byteLength(JSON.stringify({ hits: 2 }, null, 2), "utf8") },
  );
  // 单参方法：非数组 payload 也按一个参数处理
  assert.deepEqual((await host.pageCall({ id: "acme.page", method: "dataGet", payload: "cache" })).value, {
    hits: 2,
  });
  assert.deepEqual((await host.pageCall({ id: "acme.page", method: "dataDir" })).value, {
    dir: "/plugins/acme.page/data",
  });

  // 未知方法：明确错误码，而不是静默 no-op
  const unknown = await host.pageCall({ id: "acme.page", method: "nope" });
  assert.equal(unknown.ok, false);
  assert.equal(unknown.error.code, "ERR_WIDGET_UNKNOWN_METHOD");

  // 非当前页面 / 没打开：越权一律 fail-closed
  const other = await host.pageCall({ id: "acme.other", method: "info" });
  assert.equal(other.ok, false);
  assert.equal(other.error.code, "ERR_WIDGET_PAGE_SCOPE");
  host.pageClose();
  const closed = await host.pageCall({ id: "acme.page", method: "info" });
  assert.equal(closed.ok, false);
  assert.equal(closed.error.code, "ERR_WIDGET_PAGE_SCOPE");
});

test("插件页面：pageSend 只派发 log/openSettings/openPage，其余方法与非当前页都静默丢弃", () => {
  const { host, openedPages, logs } = makePageHost();
  host.start();
  host.pageOpen({ id: "acme.page" });

  assert.equal(host.pageSend({ id: "acme.page", method: "openPage", payload: { page: "infohub" } }), true);
  assert.deepEqual(openedPages, [{ page: "infohub", pluginId: "acme.page" }]);

  assert.equal(host.pageSend({ id: "acme.page", method: "log", payload: "页面日志" }), true);
  assert.ok(logs.some((line) => line.includes("[widgets:acme.page] 页面日志")));

  // invoke 方法不许走 send 通道（不新增能力）
  assert.equal(host.pageSend({ id: "acme.page", method: "info" }), false);
  assert.equal(host.pageSend({ id: "acme.other", method: "log" }), false);
});

test("插件页面：settings / event / lifecycle / engine-event 都经主窗 widgets:page-event 中继", async () => {
  const permissions = { events: ["notify", "theme", "lifecycle"] };
  const store = pageStore({ permissions });
  const { host, main } = makePageHost({ store });
  host.start();
  host.pageOpen({ id: "acme.page" });

  // settings：页面自己 setSetting → 主进程回推同一份最新设置
  await host.pageCall({ id: "acme.page", method: "setSetting", payload: ["bubble", false] });
  assert.deepEqual(pageEvents(main).at(-1), {
    id: "acme.page",
    channel: "settings",
    payload: { bubble: false },
  });

  // event：主题切换沿用既有权限门禁，声明 theme 才收
  assert.equal(host.publish({ kind: "theme", theme: "dark" }), "delivered");
  assert.deepEqual(pageEvents(main).at(-1), {
    id: "acme.page",
    channel: "event",
    payload: { kind: "theme", theme: "dark" },
  });

  // lifecycle：插件被停用 → 中继给页面，然后作废登记
  store.setRecords([pageRecord({ enabled: false })]);
  host.reconcile();
  const lifecycle = pageEvents(main).at(-1);
  assert.equal(lifecycle.channel, "lifecycle");
  assert.ok(lifecycle.payload, "生命周期事件应带载荷");
  assert.equal(host.activePage, null);

  // engine-event：只有该插件自己的页面收；别的插件 id 不投递
  store.setRecords([pageRecord({ permissions })]);
  host.reconcile();
  assert.equal(host.pageOpen({ id: "acme.page" }).ok, true);
  assert.equal(host._internal.sendPageEvent("acme.page", "engine-event", { event: "progress" }), true);
  assert.deepEqual(pageEvents(main).at(-1), {
    id: "acme.page",
    channel: "engine-event",
    payload: { event: "progress" },
  });
  assert.equal(host._internal.sendPageEvent("acme.other", "engine-event", { event: "progress" }), false);
});

test("插件页面：帧 sender 反查——主窗 + 当前页面才认；窗口几何/拖拽/穿透通道继续拒绝", async () => {
  const { host, main, logs } = makePageHost();
  host.start();
  host.pageOpen({ id: "acme.page" });
  const event = frameEvent(main);

  // 数据/信息类走 withRuntimeOrPage 的页面分支
  assert.equal(invokeChannel("widget:info", event).pluginId, "acme.page");
  assert.deepEqual(invokeChannel("widget:settings-get", event), {});
  assert.deepEqual(invokeChannel("widget:data-dir", event), { dir: "/plugins/acme.page/data" });

  // 页面帧没有独立窗口：invoke 类抛明确错误，state 只读为 null
  assert.throws(() => invokeChannel("widget:show", event), /插件页面不支持窗口操作/);
  assert.throws(() => invokeChannel("widget:set-scale", event, { dir: 1 }), /插件页面不支持窗口操作/);
  assert.throws(() => invokeChannel("widget:set-click-through", event, true), /插件页面不支持窗口操作/);
  assert.equal(invokeChannel("widget:state", event), null);

  // send 类：不执行、不炸，留下日志
  for (const channel of [
    "widget:hide",
    "widget:toggle",
    "widget:set-interactive",
    "widget:drag-start",
    "widget:drag-move",
    "widget:drag-end",
    "widget:reset-position",
  ]) {
    assert.doesNotThrow(() => invokeChannel(channel, event, true), channel);
  }
  assert.ok(logs.some((line) => /插件页面不支持窗口操作通道/.test(line)));

  // 陌生 sender / 子框架 sender 一律不认（fail-closed）
  assert.equal(invokeChannel("widget:info", { sender: { fake: true } }), null);
  assert.equal(invokeChannel("widget:info", frameEvent(main, { frame: { name: "child" } })), null);

  // 页面关闭后 sender 失效
  host.pageClose();
  assert.equal(invokeChannel("widget:info", event), null);
});

test("插件页面：停用 / 卸载 / 版本更新 / 页面入口变化 → 对账立即作废登记", () => {
  const store = pageStore();
  const { host } = makePageHost({ store });

  // 停用
  host.pageOpen({ id: "acme.page" });
  store.setRecords([pageRecord({ enabled: false })]);
  host.reconcile();
  assert.equal(host.activePage, null);
  assert.equal(host.pageCount, 0);

  // 重新启用 → 再打开；然后卸载
  store.setRecords([pageRecord({ enabled: true })]);
  host.reconcile();
  assert.equal(host.pageOpen({ id: "acme.page" }).ok, true);
  store.setRecords([]);
  host.reconcile();
  assert.equal(host.activePage, null);

  // 版本更新
  store.setRecords([pageRecord()]);
  host.reconcile();
  host.pageOpen({ id: "acme.page" });
  store.setRecords([pageRecord({ version: "2.0.0" })]);
  host.reconcile();
  assert.equal(host.activePage, null);

  // 同版本但页面入口变了
  host.pageOpen({ id: "acme.page" });
  store.setRecords([pageRecord({ page: { ...PAGE_SPEC, entry: "files/page/other.html" } })]);
  host.reconcile();
  assert.equal(host.activePage, null);
});

test("插件页面：destroyAll / 主窗销毁后主动清登记，页面调用 fail-closed", async () => {
  const first = makePageHost();
  first.host.start();
  first.host.pageOpen({ id: "acme.page" });
  first.host.destroyAll();
  assert.equal(first.host.activePage, null);
  assert.equal(first.host.pageCount, 0);

  // 主窗销毁：activePage 还在，但拿不到合法 sender → 调用被拒（不留越权通道）
  const second = makePageHost();
  second.host.start();
  second.host.pageOpen({ id: "acme.page" });
  second.main.destroy();
  const result = await second.host.pageCall({ id: "acme.page", method: "info" });
  assert.equal(result.ok, false);
  assert.equal(result.error.code, "ERR_WIDGET_PAGE_SCOPE");
  assert.match(second.host.pageOpen({ id: "acme.page" }).error, /主窗口不可用/);

  // 主窗销毁后事件中继也没有去处（不抛）
  assert.equal(second.host._internal.sendPageEvent("acme.page", "event", { kind: "theme" }), false);
});

test("插件页面：主题切换按现有事件通道推给页面（声明 theme 才收，未声明 no-target）", () => {
  const store = pageStore({ permissions: { events: ["theme"] } });
  const { host, main } = makePageHost({ store });
  host.start();
  host.pageOpen({ id: "acme.page" });

  assert.equal(host.publish({ kind: "theme", theme: "dark" }), "delivered");
  assert.deepEqual(pageEvents(main).at(-1), {
    id: "acme.page",
    channel: "event",
    payload: { kind: "theme", theme: "dark" },
  });

  // 未声明 theme 权限的插件页面收不到
  const plain = makePageHost({ store: pageStore() });
  plain.host.start();
  plain.host.pageOpen({ id: "acme.page" });
  assert.equal(plain.host.publish({ kind: "theme", theme: "dark" }), "no-target");
  assert.deepEqual(pageEvents(plain.main), []);
});

/* ───────────────── 沙箱 bundle 插件：后台常驻页 / 首页卡片 / 信息中枢 / 通知 ───────────────── */

/** 只声明后台常驻页 + 首页卡片的记录（不声明 desktopWidget，避免顺带建托盘窗口）。 */
function backgroundRecord(overrides = {}) {
  return {
    id: "acme.bg",
    name: "自动化",
    version: "1.0.0",
    enabled: true,
    permissions: { infohub: true, notify: true },
    background: { entry: "files/background.html" },
    homeCards: [
      {
        id: "brief",
        title: "今日简报",
        summary: "每天 8 点汇总",
        icon: "assets/brief.png",
        page: "plugin:acme.bg",
        primary: "等待第一次汇总",
      },
    ],
    installedAt: "2026-11-07T00:00:00.000Z",
    ...overrides,
  };
}

function backgroundStore(overrides = {}) {
  const store = makeStore();
  store.setRecords([backgroundRecord(overrides)]);
  return store;
}

/** 假主窗：记录收到的事件（首页卡片广播 / 插件通知）。 */
function fakeCardMainWindow() {
  const sent = [];
  return {
    sent,
    window: {
      isDestroyed: () => false,
      webContents: {
        isDestroyed: () => false,
        send: (ch, payload) => sent.push({ ch, payload }),
      },
    },
  };
}

test("后台常驻页：enabled 且声明 background 时建隐藏窗口（沙箱 + background 标记），停用即销毁", async () => {
  const store = backgroundStore();
  const { host, created, logs } = makeHost({ store });
  host.start();

  assert.equal(host.backgroundCount, 1);
  const win = onlyWindow(created);
  assert.equal(win.opts.show, false);
  assert.equal(win.opts.skipTaskbar, true);
  assert.equal(win.opts.webPreferences.preload, "/tmp/widget-preload.js");
  assert.equal(win.opts.webPreferences.sandbox, true);
  assert.equal(win.opts.webPreferences.backgroundThrottling, false);
  assert.deepEqual(win.opts.webPreferences.additionalArguments, ["--heming-widget-mode=background"]);
  assert.equal(win._url, "widget://acme.bg/files/background.html");
  // 隐藏窗口：用户看不见，也不进任务栏
  assert.equal(win._visible, false);

  // 同一份 widget 桥照常可用（data API 走 withRuntimeOrPage 的 sender 反查）
  const event = { sender: win.webContents };
  invokeChannel("widget:data-set", event, { key: "cursor", value: { at: 1 } });
  assert.deepEqual(store.readData("acme.bg", "cursor"), { at: 1 });

  // 停用 → 下一轮对账立即销毁，不留孤儿渲染进程
  store.setRecords([backgroundRecord({ enabled: false })]);
  host.reconcile();
  assert.equal(host.backgroundCount, 0);
  assert.equal(win._destroyed, true);

  assert.ok(logs.some((line) => line.includes("后台常驻页已启动")));
});

test("后台常驻页：版本或入口变化时重建；destroyAll 统一关闭", () => {
  const store = backgroundStore();
  const { host, created } = makeHost({ store });
  host.start();
  const first = created[0];

  store.setRecords([backgroundRecord({ version: "2.0.0" })]);
  host.reconcile();
  assert.equal(first._destroyed, true);
  assert.equal(host.backgroundCount, 1);
  assert.equal(created.length, 2);
  assert.equal(created[1]._url, "widget://acme.bg/files/background.html");

  // 入口也变了：旧窗销毁、新窗按新入口加载
  store.setRecords([backgroundRecord({ version: "2.0.0", background: { entry: "files/next.html" } })]);
  host.reconcile();
  assert.equal(created[1]._destroyed, true);
  assert.equal(created[2]._url, "widget://acme.bg/files/next.html");

  host.destroyAll();
  assert.equal(host.backgroundCount, 0);
  assert.equal(created[2]._destroyed, true);
});

test("后台常驻页：没有模块时不建（只认 enabled + 无错误 + 有 background.entry）", () => {
  const store = makeStore();
  store.setRecords([
    backgroundRecord({ enabled: false }),
    backgroundRecord({ id: "acme.broken", error: "插件文件缺失，请重新安装" }),
    { ...backgroundRecord({ id: "acme.nobg" }), background: null },
  ]);
  const { host, created } = makeHost({ store });
  host.start();
  assert.equal(host.backgroundCount, 0);
  assert.equal(created.length, 0);
});

test("homeCards：只收启用插件，text 缺省用清单 primary，homeCardSet 写盘后覆盖生效", async () => {
  const store = backgroundStore();
  const { host, created } = makeHost({ store });
  host.start();

  const before = host.homeCards();
  assert.equal(before.length, 1);
  assert.deepEqual(before[0], {
    pluginId: "acme.bg",
    pluginName: "自动化",
    id: "brief",
    title: "今日简报",
    summary: "每天 8 点汇总",
    icon: "assets/brief.png",
    page: "plugin:acme.bg",
    text: "等待第一次汇总",
    detail: "",
    badge: "",
    items: [],
    actions: [],
  });

  const result = await invokeChannel("widget:homecard-set", { sender: created[0].webContents }, {
    cardId: "brief",
    patch: { text: "3 条待办", badge: "3" },
  });
  assert.equal(result.ok, true);
  // 覆盖值落在插件数据目录的 homecards.json（卸载时随 data/ 一起清理）
  assert.deepEqual(store.readData("acme.bg", "homecards"), { brief: { text: "3 条待办", badge: "3" } });
  assert.equal(host.homeCards()[0].text, "3 条待办");
  assert.equal(host.homeCards()[0].badge, "3");

  // 停用后首页不再出现这张卡（不能留一个点不开的死链）
  store.setRecords([backgroundRecord({ enabled: false })]);
  assert.deepEqual(host.homeCards(), []);
});

test("homecard-set：写盘后广播给主窗，只允许清单声明过的 cardId，主窗/陌生 sender 调不到", async () => {
  const store = backgroundStore();
  const main = fakeCardMainWindow();
  const { host, created } = makeHost({ store, getMainWindow: () => main.window });
  host.start();
  const event = { sender: created[0].webContents };

  const result = await invokeChannel("widget:homecard-set", event, {
    cardId: "brief",
    patch: { detail: "3 篇未读" },
  });
  assert.equal(result.ok, true);
  assert.equal(result.card.detail, "3 篇未读");
  assert.deepEqual(main.sent.at(-1), { ch: "plugin:homecard", payload: result.card });

  // 未声明的 cardId：拒绝（防止插件往首页塞清单里没有的卡片）
  assert.throws(
    () => invokeChannel("widget:homecard-set", event, { cardId: "nope", patch: { text: "x" } }),
    /未声明首页卡片/,
  );
  // 不是 widget 视图的 webContents：fail-closed 返回 denied，且不会写盘
  assert.equal(
    invokeChannel("widget:homecard-set", { sender: { id: 1 } }, { cardId: "brief", patch: { text: "x" } }),
    null,
  );
  assert.deepEqual(store.readData("acme.bg", "homecards"), { brief: { detail: "3 篇未读" } });
});

test("infohub-call：转发给注入的 request，超时收口（默认 60s / 1s..30min）", async () => {
  const calls = [];
  const infohubRequest = async (method, params, options) => {
    calls.push({ method, params, options });
    return { ok: true, method };
  };
  const store = backgroundStore();
  const { host, created } = makeHost({ store, infohubRequest });
  host.start();
  const event = { sender: created[0].webContents };

  assert.deepEqual(await invokeChannel("widget:infohub-call", event, { method: "ping" }), {
    ok: true,
    method: "ping",
  });
  assert.deepEqual(calls.at(-1), { method: "ping", params: undefined, options: { timeoutMs: 60_000 } });

  await invokeChannel("widget:infohub-call", event, {
    method: "sync",
    params: { full: true },
    timeoutMs: 999_999_999,
  });
  assert.deepEqual(calls.at(-1), {
    method: "sync",
    params: { full: true },
    options: { timeoutMs: 30 * 60_000 },
  });

  // 小于下限抬到 1s（别让插件用 1ms 超时把桥打成失败）
  await invokeChannel("widget:infohub-call", event, { method: "search", timeoutMs: 1 });
  assert.deepEqual(calls.at(-1).options, { timeoutMs: 1_000 });

  // shutdown 不在渲染层白名单（只有主进程可停引擎）
  // handler 是同步抛错的（invoke 侧由 Electron 转成 reject），所以用 assert.throws 断言。
  assert.throws(
    () => invokeChannel("widget:infohub-call", event, { method: "shutdown" }),
    /信息中枢不支持的方法/,
  );
});

test("infohub-call / notify：未声明对应 permissions 一律拒绝（宿主不代插件越权）", async () => {
  const store = backgroundStore({ permissions: {} });
  const { host, created } = makeHost({
    store,
    infohubRequest: async () => ({ ok: true }),
    notifyPlugin: () => ({ delivered: "renderer" }),
  });
  host.start();
  const event = { sender: created[0].webContents };

  assert.throws(
    () => invokeChannel("widget:infohub-call", event, { method: "ping" }),
    /缺少 permissions\.infohub/,
  );
  assert.throws(
    () => invokeChannel("widget:notify", event, { title: "x" }),
    /缺少 permissions\.notify/,
  );
});

test("infohub / notify：宿主没接线时给可读错误（不是静默 no-op）", async () => {
  const store = backgroundStore();
  const { host, created } = makeHost({ store });
  host.start();
  const event = { sender: created[0].webContents };

  assert.throws(
    () => invokeChannel("widget:infohub-call", event, { method: "ping" }),
    /信息中枢不可用/,
  );
  assert.throws(() => invokeChannel("widget:notify", event, { title: "x" }), /通知通道不可用/);
});

test("notify：把插件身份与正文一起交给注入的 notifyPlugin，返回投递方式", async () => {
  const delivered = [];
  const notifyPlugin = (payload) => {
    delivered.push(payload);
    return { delivered: "renderer" };
  };
  const store = backgroundStore();
  const { host, created } = makeHost({ store, notifyPlugin });
  host.start();

  const result = await invokeChannel("widget:notify", { sender: created[0].webContents }, {
    title: "汇总完成",
    body: "3 条待办",
    level: "warn",
  });
  assert.deepEqual(result, { ok: true, delivered: "renderer" });
  assert.deepEqual(delivered.at(-1), {
    pluginId: "acme.bg",
    title: "汇总完成",
    body: "3 条待办",
    level: "warn",
  });
});

test("通知标题截断按码点切，不劈 emoji 代理对（d.412 回归）", () => {
  const max = 80; // NOTIFY_TITLE_MAX
  // emoji 恰好骑在截断边界上：第 80 个码点是 emoji 的高代理时会把代理对劈开。
  const title = "A".repeat(max - 1) + "😀" + "尾巴";
  const event = normalizeEvent({ kind: "notify", title });
  assert.ok(event, "事件应有效");
  // 截断后每个码点都必须是完整字符，不能出现落单高/低代理。
  const points = [...event.title];
  const hasLoneSurrogate = points.some((ch) => {
    const cp = ch.codePointAt(0);
    return cp >= 0xd800 && cp <= 0xdfff;
  });
  assert.equal(hasLoneSurrogate, false, "标题里不该有落单代理（乱码方块）");
  assert.equal(points.length, max + 1, "按码点截断后应保留 max 个码点 + 省略号");
  assert.ok(event.title.endsWith("…"));
});

