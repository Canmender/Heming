"use strict";
const test = require("node:test");
const assert = require("node:assert/strict");
const fs = require("node:fs");
const path = require("node:path");
const { createWidgetHost } = require("./plugin-host");
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
  });
  assert.ok(!JSON.stringify(config).includes("SECRET-PERSONA"), "chatConfig 不得下发智能体 prompt");
  await host.getChatConfig();
  assert.equal(calls, 1, "30s 内应命中缓存");
  host.invalidateChatConfig();
  await host.getChatConfig();
  assert.equal(calls, 2);
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

/* ───────────────────── 页面视图（d.124 B 路径：WebContentsView） ───────────────────── */

const PAGE_SPEC = { title: "我的面板", icon: "layout", summary: "插件页面", entry: "files/page/index.html" };

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

/** 假主窗：只需要 contentView + 内容区尺寸（页面视图 rect 的坐标系）。 */
function fakePageMainWindow(content = { width: 1200, height: 800 }) {
  const children = [];
  let destroyed = false;
  return {
    _children: children,
    isDestroyed: () => destroyed,
    getContentBounds: () => ({ x: 0, y: 0, width: content.width, height: content.height }),
    contentView: {
      addChildView: (view) => children.push(view),
      removeChildView: (view) => {
        const index = children.indexOf(view);
        if (index >= 0) children.splice(index, 1);
      },
    },
    destroy: () => {
      destroyed = true;
    },
  };
}

/** 建一个带主窗的宿主（页面视图测试用）。 */
function makePageHost(overrides = {}) {
  const main = overrides.main || fakePageMainWindow();
  const store = overrides.store || pageStore();
  const made = makeHost({ store, getMainWindow: () => main });
  return { ...made, store, main };
}

test("页面视图：mount 建 WebContentsView（沙箱 + widget-preload + widget:// 独立 origin）并嵌进主窗内容区", async () => {
  const { host, createdViews, main } = makePageHost();
  host.start();
  const result = await host.pageMount({ id: "acme.page", rect: { x: 50, y: 60, width: 700, height: 500 } });
  assert.deepEqual(result, { ok: true });

  const view = createdViews[0];
  assert.ok(view, "应创建一个 WebContentsView");
  const prefs = view.opts.webPreferences;
  assert.equal(prefs.preload, "/tmp/widget-preload.js");
  assert.equal(prefs.sandbox, true);
  assert.equal(prefs.contextIsolation, true);
  assert.equal(prefs.nodeIntegration, false);
  assert.equal(prefs.spellcheck, false);
  assert.deepEqual(prefs.additionalArguments, ["--heming-page-view"]);
  assert.equal(view.webContents._url, "widget://acme.page/files/page/index.html");
  assert.deepEqual(view.bounds, { x: 50, y: 60, width: 700, height: 500 });
  assert.deepEqual(main._children, [view]);
  assert.equal(host.pageCount, 1);
});

test("页面视图：rect 按主窗内容区钳制（负坐标归零、超出裁掉、宽高至少 1）", async () => {
  const { host, createdViews } = makePageHost();
  host.start();
  await host.pageMount({ id: "acme.page", rect: { x: -20, y: -5, width: 9999, height: 9999 } });
  assert.deepEqual(createdViews[0].bounds, { x: 0, y: 0, width: 1200, height: 800 });

  // 非法数字回落默认值；0 宽高被钳到 1
  await host.pageMount({ id: "acme.page", rect: { x: "abc", y: null, width: 0, height: -50 } });
  assert.deepEqual(createdViews[1].bounds, { x: 0, y: 0, width: 1, height: 1 });
});

test("页面视图：page-bounds 更新边界并钳制；卸载后调用无副作用", async () => {
  const { host, createdViews } = makePageHost();
  host.start();
  await host.pageMount({ id: "acme.page", rect: { x: 0, y: 0, width: 200, height: 200 } });
  const view = createdViews[0];

  assert.equal(host.pageBounds({ rect: { x: 10, y: 20, width: 300, height: 400 } }), true);
  assert.deepEqual(view.bounds, { x: 10, y: 20, width: 300, height: 400 });

  // 越界：x/y 夹到内容区内（至少留 1px 可见），height 被内容区剩余高度裁掉
  host.pageBounds({ rect: { x: -100, y: 10000, width: 50, height: 50 } });
  assert.deepEqual(view.bounds, { x: 0, y: 799, width: 50, height: 1 });

  host.pageUnmount();
  assert.equal(host.pageBounds({ rect: { x: 1, y: 1, width: 2, height: 2 } }), false);
});

test("页面视图：重复 mount 先销毁旧视图再建新的（同一时刻只有一个，不留孤儿）", async () => {
  const { host, createdViews, main } = makePageHost();
  host.start();
  await host.pageMount({ id: "acme.page", rect: { x: 0, y: 0, width: 100, height: 100 } });
  const first = createdViews[0];
  await host.pageMount({ id: "acme.page", rect: { x: 0, y: 0, width: 100, height: 100 } });
  const second = createdViews[1];

  assert.equal(first.webContents._closed, true, "旧视图必须被销毁");
  assert.equal(second.webContents._closed, false);
  assert.deepEqual(main._children, [second], "内容区里只该有最新视图");
  assert.equal(host.pageCount, 1);
});

test("页面视图：unmount 移除并销毁视图，重复调用无害", async () => {
  const { host, createdViews, main } = makePageHost();
  host.start();
  await host.pageMount({ id: "acme.page", rect: { x: 5, y: 6, width: 100, height: 100 } });
  const view = createdViews[0];

  assert.equal(host.pageUnmount(), true);
  assert.equal(view.webContents._closed, true);
  assert.deepEqual(main._children, []);
  assert.equal(host.pageCount, 0);
  assert.equal(host.pageUnmount(), false);
});

test("页面视图：未安装 / 停用 / 文件坏 / 没有 page 都拒绝，且 error 是可直接展示的中文", async () => {
  const missing = makePageHost({ store: makeStore() });
  missing.host.start();
  assert.match((await missing.host.pageMount({ id: "acme.page", rect: {} })).error, /未安装/);

  const disabled = makePageHost({ store: pageStore({ enabled: false }) });
  disabled.host.start();
  assert.match((await disabled.host.pageMount({ id: "acme.page", rect: {} })).error, /已停用/);

  const broken = makePageHost({ store: pageStore({ error: "插件文件缺失，请重新安装" }) });
  broken.host.start();
  assert.match((await broken.host.pageMount({ id: "acme.page", rect: {} })).error, /文件缺失/);

  const noPage = makePageHost({ store: pageStore({ page: undefined }) });
  noPage.host.start();
  assert.match((await noPage.host.pageMount({ id: "acme.page", rect: {} })).error, /没有声明页面/);

  // 非法 id / 主窗不可用
  assert.match((await missing.host.pageMount({ rect: {} })).error, /缺少插件 id/);
  const noMain = makeHost({ store: pageStore(), getMainWindow: () => null });
  noMain.host.start();
  assert.match((await noMain.host.pageMount({ id: "acme.page", rect: {} })).error, /主窗口不可用/);
});

test("页面视图：加载失败 → 返回错误并销毁刚建的视图（不白屏、不留空视图）", async () => {
  const { host, createdViews, main, setNextViewLoadError } = makePageHost();
  host.start();
  setNextViewLoadError(new Error("ERR_FILE_NOT_FOUND"));
  const result = await host.pageMount({ id: "acme.page", rect: { x: 0, y: 0, width: 100, height: 100 } });
  assert.equal(result.ok, false);
  assert.match(result.error, /页面加载失败/);
  assert.equal(createdViews[0].webContents._closed, true);
  assert.deepEqual(main._children, []);
  assert.equal(host.pageCount, 0);
});

test("页面视图：sender 反查——info/settings/data/openPage/log 可用，跨插件读不到数据", async () => {
  const store = pageStore();
  store.setRecords([pageRecord(), pageRecord({ id: "acme.other", name: "另一个页面插件" })]);
  const { host, createdViews, openedPages, logs } = makePageHost({ store });
  host.start();
  await host.pageMount({ id: "acme.page", rect: {} });
  const view = createdViews[0];
  const event = { sender: view.webContents };

  assert.equal(invokeChannel("widget:info", event).pluginId, "acme.page");
  assert.equal(invokeChannel("widget:info", event).pluginName, "页面插件");
  assert.deepEqual(invokeChannel("widget:settings-get", event), {});
  assert.deepEqual(invokeChannel("widget:data-set", event, { key: "cache", value: { hits: 2 } }), {
    key: "cache",
    bytes: Buffer.byteLength(JSON.stringify({ hits: 2 }, null, 2), "utf8"),
  });
  assert.deepEqual(invokeChannel("widget:data-get", event, { key: "cache" }), { hits: 2 });
  assert.deepEqual(invokeChannel("widget:data-dir", event), { dir: "/plugins/acme.page/data" });

  invokeChannel("widget:open-page", event, { page: "infohub" });
  assert.deepEqual(openedPages, [{ page: "infohub", pluginId: "acme.page" }]);
  invokeChannel("widget:log", event, "页面日志");
  assert.ok(logs.some((line) => line.includes("[widgets:acme.page] 页面日志")));

  // 别的插件 sender（不是当前页面视图）拿不到数据
  const stranger = { sender: { fake: true } };
  assert.equal(invokeChannel("widget:info", stranger), null);
  assert.equal(invokeChannel("widget:data-get", stranger, { key: "cache" }), null);
});

test("页面视图：窗口几何/拖拽/穿透通道一律拒绝（返回明确错误而不是静默 no-op）", async () => {
  const { host, createdViews, logs } = makePageHost();
  host.start();
  await host.pageMount({ id: "acme.page", rect: {} });
  const view = createdViews[0];
  const event = { sender: view.webContents };

  // invoke 类：抛中文错误（页面视图没有独立窗口）
  assert.throws(() => invokeChannel("widget:show", event), /页面视图不支持窗口操作/);
  assert.throws(() => invokeChannel("widget:set-scale", event, { dir: 1 }), /页面视图不支持窗口操作/);
  assert.throws(() => invokeChannel("widget:set-click-through", event, true), /页面视图不支持窗口操作/);
  // 状态只读 unsupported → null（不伪造 visible/scale）
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
  assert.ok(logs.some((line) => /页面视图不支持窗口操作通道/.test(line)));

  // reload 不是窗口几何操作：允许页面自己重载
  invokeChannel("widget:reload", event);
  assert.equal(view.webContents._reloaded, 1);

  // 卸载后 sender 失效（fail-closed）
  host.pageUnmount();
  assert.equal(invokeChannel("widget:info", event), null);
});

test("页面视图：导航只允许自身 origin；window.open deny；下载取消", async () => {
  const { host, createdViews, fakeSession } = makePageHost();
  host.start();
  await host.pageMount({ id: "acme.page", rect: {} });
  const view = createdViews[0];
  const wc = view.webContents;

  const prevented = [];
  const navEvent = { preventDefault: () => prevented.push(true) };
  wc._listeners["will-navigate"](navEvent, "widget://acme.page/other.html");
  assert.equal(prevented.length, 0, "同 origin 内的翻页应放行");
  wc._listeners["will-navigate"](navEvent, "https://evil.example/");
  assert.equal(prevented.length, 1, "离开自身 origin 必须拦截");
  wc._listeners["will-navigate"](navEvent, "widget://acme.other/x.html");
  assert.equal(prevented.length, 2, "也不许导航到别的插件 origin");

  const redirectEvent = { preventDefault: () => prevented.push(true) };
  wc._listeners["will-redirect"](redirectEvent, "https://evil.example/");
  assert.equal(prevented.length, 3);

  assert.deepEqual(wc._openHandler({ url: "https://evil.example/" }), { action: "deny" });

  // 下载：只取消本页面发起的（同 session 其他页面的下载不受影响）
  const downloadEvent = { prevented: 0, preventDefault() { this.prevented += 1; } };
  fakeSession.emit("will-download", downloadEvent, { getURL: () => "https://evil.example/file.zip" }, wc);
  assert.equal(downloadEvent.prevented, 1);
  const otherEvent = { prevented: 0, preventDefault() { this.prevented += 1; } };
  fakeSession.emit("will-download", otherEvent, { getURL: () => "x" }, { fake: true });
  assert.equal(otherEvent.prevented, 0);
});

test("页面视图：停用 / 卸载 / 版本更新 / 页面入口变化 → 对账立即销毁视图", async () => {
  const store = pageStore();
  const { host, createdViews, main } = makePageHost({ store });
  host.start();
  await host.pageMount({ id: "acme.page", rect: {} });

  // 停用
  store.setRecords([pageRecord({ enabled: false })]);
  host.reconcile();
  assert.equal(createdViews[0].webContents._closed, true);
  assert.deepEqual(main._children, []);

  // 重新启用 + 进入页面 → 再挂一次；然后卸载
  store.setRecords([pageRecord({ enabled: true })]);
  host.reconcile();
  await host.pageMount({ id: "acme.page", rect: {} });
  const second = createdViews[1];
  store.setRecords([]);
  host.reconcile();
  assert.equal(second.webContents._closed, true);

  // 版本更新
  store.setRecords([pageRecord()]);
  host.reconcile();
  await host.pageMount({ id: "acme.page", rect: {} });
  const third = createdViews[2];
  store.setRecords([pageRecord({ version: "2.0.0" })]);
  host.reconcile();
  assert.equal(third.webContents._closed, true);

  // 同版本但页面入口变了
  store.setRecords([pageRecord({ page: { ...PAGE_SPEC, entry: "files/page/other.html" } })]);
  host.reconcile();
  await host.pageMount({ id: "acme.page", rect: {} });
  const fourth = createdViews[3];
  store.setRecords([pageRecord({ page: { ...PAGE_SPEC, entry: "files/page/new.html" } })]);
  host.reconcile();
  assert.equal(fourth.webContents._closed, true);
});

test("页面视图：主窗关闭 / destroyAll / 主窗不可用 时销毁视图，不留孤儿", async () => {
  const first = makePageHost();
  first.host.start();
  await first.host.pageMount({ id: "acme.page", rect: {} });
  first.host.destroyAll();
  assert.equal(first.createdViews[0].webContents._closed, true);

  const second = makePageHost();
  second.host.start();
  await second.host.pageMount({ id: "acme.page", rect: {} });
  second.main.destroy();
  assert.equal(second.host.pageBounds({ rect: { x: 0, y: 0, width: 10, height: 10 } }), false);
  assert.equal(second.createdViews[0].webContents._closed, true);
  assert.equal(second.host.pageCount, 0);
});

test("页面视图：主题切换按现有 widget:event 通道推送给页面（不新增通道）", async () => {
  const store = pageStore({ permissions: { events: ["theme"] } });
  const { host, createdViews } = makePageHost({ store });
  host.start();
  await host.pageMount({ id: "acme.page", rect: {} });
  const view = createdViews[0];

  assert.equal(host.publish({ kind: "theme", theme: "dark" }), "delivered");
  assert.deepEqual(view.webContents._sent.find((item) => item.ch === "widget:event").payload, {
    kind: "theme",
    theme: "dark",
  });
  // 未声明 theme 权限的插件页面收不到
  const plain = pageStore();
  const second = makePageHost({ store: plain });
  second.host.start();
  await second.host.pageMount({ id: "acme.page", rect: {} });
  assert.equal(second.host.publish({ kind: "theme", theme: "dark" }), "no-target");
});

