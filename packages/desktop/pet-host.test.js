"use strict";
const test = require("node:test");
const assert = require("node:assert/strict");
const { createPetHost } = require("./pet-host");
const { petWindowSize } = require("./pet-window");

/* ────────────────────────────── 假对象 ────────────────────────────── */

/**
 * 最小 BrowserWindow 替身：只实现 pet-host 真正调用到的那几个方法。
 * 刻意不做成"完整模拟"——多出来的方法会掩盖"代码其实没走到"的问题。
 */
function makeFakeElectron() {
  const created = [];

  class FakeBrowserWindow {
    constructor(opts) {
      this.opts = opts;
      this._bounds = { x: opts.x, y: opts.y, width: opts.width, height: opts.height };
      this._visible = false;
      this._destroyed = false;
      this._ignoreMouse = null;
      this._url = null;
      this._inactiveShown = false;
      this._listeners = {};
      this.webContents = {
        _sent: [],
        on: () => {},
        send: (ch, payload) => this.webContents._sent.push({ ch, payload }),
      };
      created.push(this);
    }
    isDestroyed() { return this._destroyed; }
    isVisible() { return this._visible && !this._destroyed; }
    isMinimized() { return false; }
    getBounds() { return { ...this._bounds }; }
    setBounds(b) { this._bounds = { ...this._bounds, ...b }; }
    setPosition(x, y) { this._bounds.x = x; this._bounds.y = y; }
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

  const menu = (template) => ({ template });

  let cursor = { x: 0, y: 0 };
  const screen = {
    getAllDisplays: () => [{ workArea: { x: 0, y: 0, width: 1920, height: 1040 } }],
    getPrimaryDisplay: () => ({ workArea: { x: 0, y: 0, width: 1920, height: 1040 } }),
    getCursorScreenPoint: () => ({ ...cursor }),
    setCursor: (x, y) => { cursor = { x, y }; },
  };

  return {
    electron: {
      BrowserWindow: FakeBrowserWindow,
      Tray: FakeTray,
      Menu: { buildFromTemplate: menu },
      nativeImage: { createFromPath: (p) => ({ path: p }), createEmpty: () => ({}) },
      screen,
      ipcMain,
    },
    created,
    handles,
    ons,
    trayMenus,
    screen,
    FakeTray,
    FakeBrowserWindow,
  };
}

function makeHost(overrides = {}) {
  const fake = makeFakeElectron();
  const written = [];
  const host = createPetHost({
    ...fake.electron,
    app: { quit() {} },
    stateFile: "/tmp/pet-state.json",
    preloadPath: "/tmp/preload.js",
    trayIconPath: "/tmp/pet-tray.png",
    resolveAppUrl: () => "app://heming/index.html",
    getMainWindow: () => null,
    readState: overrides.readState || (() => null),
    writeState: (file, s) => written.push({ file, s }),
    log: () => {},
    setTimeout: (fn) => { fn(); return 1; }, // 立即执行，避免测试里等真实定时器
    clearTimeout: () => {},
  });
  return { host, ...fake, written };
}

/* ────────────────────────────── 启动 ────────────────────────────── */

test("启动：默认不自动显示（用户上次关掉的桌面不该自己弹回来）", () => {
  const { host, created } = makeHost();
  host.start();
  assert.equal(created.length, 0);
  assert.equal(host.state.visible, false);
});

test("启动：上次是显示状态则自动出现，且用 showInactive 不抢焦点", () => {
  const { host, created } = makeHost({ readState: () => ({ visible: true, scale: 1 }) });
  host.start();
  assert.equal(created.length, 1);
  assert.equal(created[0]._visible, true);
  assert.equal(created[0]._inactiveShown, true, "首次出现不能抢走用户正在打字的焦点");
  assert.equal(host.state.visible, true);
});

test("托盘在启动时就常驻（穿透模式下它是唯一可靠出口）", () => {
  const { host, trayMenus } = makeHost();
  host.start();
  assert.ok(trayMenus.length >= 1, "托盘菜单必须建好");
});

/* ────────────────────────────── 显隐 ────────────────────────────── */

test("显隐切换：show → hide → toggle", () => {
  const { host, created } = makeHost();
  host.start();
  host.show();
  assert.equal(created[0]._visible, true);

  host.hide();
  assert.equal(created[0]._visible, false);
  assert.equal(host.state.visible, false);

  host.toggle();
  assert.equal(created[0]._visible, true);
  assert.equal(host.state.visible, true);

  host.toggle();
  assert.equal(created[0]._visible, false);
});

test("窗口被销毁后再 show 会重建（不是报错）", () => {
  const { host, created } = makeHost();
  host.start();
  host.show();
  created[0].destroy();
  host.show();
  assert.equal(created.length, 2, "应重建一个新窗口");
  assert.equal(created[1]._visible, true);
});

test("重建窗口时沿用已记忆的 bounds 与缩放", () => {
  const { host, created } = makeHost({
    readState: () => ({ visible: true, scale: 1.25, bounds: { x: 300, y: 400, width: 375, height: 525 } }),
  });
  host.start();
  host.hide();
  const opts = created[0].opts;
  assert.equal(opts.x, 300);
  assert.equal(opts.y, 400);
  assert.deepEqual({ width: opts.width, height: opts.height }, petWindowSize(1.25));
});

test("桌宠窗口加载的是独立入口 pet.html（不是主应用 index.html）", () => {
  const { host, created } = makeHost();
  host.start();
  host.show();
  // 走独立入口，才能不把整个应用 bundle 拖进这个常驻小窗
  assert.equal(created[0]._url, "app://heming/pet.html?hemingWindow=pet");
});

/* ────────────────────────────── 穿透 ────────────────────────────── */

test("默认穿透：创建后立刻 setIgnoreMouseEvents(true, forward)", () => {
  const { host, created } = makeHost();
  host.start();
  host.show();
  assert.deepEqual(created[0]._ignoreMouse, { v: true, o: { forward: true } });
});

test("穿透模式：光标进入角色 → 停止穿透；离开 → 恢复穿透", () => {
  const { host, created, ons } = makeHost();
  host.start();
  host.show();
  const w = created[0];
  const event = { sender: w.webContents };

  ons.get("pet:set-interactive")(event, true);
  assert.equal(w._ignoreMouse.v, false, "光标在角色上时必须能接收点击");

  ons.get("pet:set-interactive")(event, false);
  assert.equal(w._ignoreMouse.v, true, "光标离开后要把桌面点击还回去");
});

test("重复上报同一值不重复调用（mousemove 是高频事件）", () => {
  const { host, created, ons } = makeHost();
  host.start();
  host.show();
  const w = created[0];
  const event = { sender: w.webContents };

  ons.get("pet:set-interactive")(event, true);
  const first = w._ignoreMouse;
  w._ignoreMouse = null; // 清掉，若再调用就会重新赋值
  ons.get("pet:set-interactive")(event, true);
  assert.equal(w._ignoreMouse, null, "值没变就不该再调 setIgnoreMouseEvents");
  assert.ok(first);
});

test("关掉穿透后：无论光标在哪都不穿透（托盘开关是硬覆盖）", () => {
  const { host, created, ons } = makeHost();
  host.start();
  host.show();
  const w = created[0];
  const event = { sender: w.webContents };

  host.setClickThrough(false);
  assert.equal(w._ignoreMouse.v, false);

  // 即使渲染层上报"光标离开了"，也不该恢复穿透
  ons.get("pet:set-interactive")(event, false);
  assert.equal(w._ignoreMouse.v, false);
});

test("非桌宠窗口发来的穿透请求被忽略（跨进程边界不靠调用方自觉）", () => {
  const { host, created, ons } = makeHost();
  host.start();
  host.show();
  const w = created[0];

  ons.get("pet:set-interactive")({ sender: { notThePet: true } }, false);
  assert.equal(w._ignoreMouse.v, true, "仍保持默认穿透，未被外部请求改动");
});

/* ────────────────────────────── 拖拽 ────────────────────────────── */

test("拖拽：按屏幕光标位移移动窗口，抬起时落盘", () => {
  const { host, created, ons, screen, written } = makeHost();
  host.start();
  host.show();
  const w = created[0];
  const event = { sender: w.webContents };
  w.setPosition(1000, 500);

  screen.setCursor(1200, 700);
  ons.get("pet:drag-start")(event);

  screen.setCursor(1260, 740);
  ons.get("pet:drag-move")(event);
  assert.deepEqual({ x: w._bounds.x, y: w._bounds.y }, { x: 1060, y: 540 });

  screen.setCursor(1100, 650);
  ons.get("pet:drag-move")(event);
  assert.deepEqual({ x: w._bounds.x, y: w._bounds.y }, { x: 900, y: 450 });

  ons.get("pet:drag-end")(event);
  assert.ok(written.length >= 1, "抬起后应写盘");
  assert.deepEqual(written.at(-1).s.bounds, { x: 900, y: 450, width: w._bounds.width, height: w._bounds.height });
});

test("没有 drag-start 时 drag-move 不移动窗口（不会凭空跳）", () => {
  const { host, created, ons, screen } = makeHost();
  host.start();
  host.show();
  const w = created[0];
  w.setPosition(1000, 500);
  screen.setCursor(0, 0);
  ons.get("pet:drag-move")({ sender: w.webContents });
  assert.deepEqual({ x: w._bounds.x, y: w._bounds.y }, { x: 1000, y: 500 });
});

test("非桌宠窗口不能拖走桌宠", () => {
  const { host, created, ons, screen } = makeHost();
  host.start();
  host.show();
  const w = created[0];
  w.setPosition(1000, 500);
  screen.setCursor(0, 0);
  ons.get("pet:drag-start")({ sender: { notThePet: true } });
  screen.setCursor(500, 500);
  ons.get("pet:drag-move")({ sender: { notThePet: true } });
  assert.deepEqual({ x: w._bounds.x, y: w._bounds.y }, { x: 1000, y: 500 });
});

/* ────────────────────────────── 缩放 ────────────────────────────── */

test("放大一档：尺寸变化且右下角锚点不动", () => {
  const { host, created } = makeHost();
  host.start();
  host.show();
  const w = created[0];
  w.setBounds({ x: 100, y: 200, width: 300, height: 420 });
  const right = 100 + 300;
  const bottom = 200 + 420;

  host.stepScale(1); // 1.0 → 1.25
  assert.equal(host.state.scale, 1.25);
  assert.deepEqual({ width: w._bounds.width, height: w._bounds.height }, petWindowSize(1.25));
  assert.equal(w._bounds.x + w._bounds.width, right, "右边缘应保持不动");
  assert.equal(w._bounds.y + w._bounds.height, bottom, "下边缘应保持不动");
});

test("缩放两端夹住，档位不变时不重建窗口", () => {
  const { host, created } = makeHost();
  host.start();
  host.show();
  const w = created[0];

  host.setScale(1.5);
  const atMax = w._bounds.width;
  host.stepScale(1); // 已在最大档，再加不越界
  assert.equal(w._bounds.width, atMax);
  assert.equal(host.state.scale, 1.5);

  host.setScale(0.6);
  host.stepScale(-1); // 已在最小档，再减不越界
  assert.equal(host.state.scale, 0.6);
});

/* ────────────────────────────── 设置跳转 ────────────────────────────── */

test("桌宠请求打开设置：显示并聚焦主窗口，并把事件转给主窗口", () => {
  const fake = makeFakeElectron();
  const mainWin = new fake.FakeBrowserWindow({ x: 0, y: 0, width: 800, height: 600 });
  const host = createPetHost({
    ...fake.electron,
    app: { quit() {} },
    stateFile: "/tmp/s.json",
    preloadPath: "/tmp/p.js",
    trayIconPath: "/tmp/t.png",
    resolveAppUrl: () => "app://heming/index.html",
    getMainWindow: () => mainWin,
    readState: () => ({ visible: true }),
    writeState: () => {},
    log: () => {},
    setTimeout: (fn) => { fn(); return 1; },
    clearTimeout: () => {},
  });
  host.start();

  const petWin = fake.created.find((w) => w !== mainWin);
  fake.ons.get("pet:open-settings")({ sender: petWin.webContents });

  assert.equal(mainWin._visible, true);
  assert.equal(mainWin._focused, true);
  assert.deepEqual(mainWin.webContents._sent.at(-1), { ch: "pet:open-settings", payload: undefined });
});

/* ────────────────────────────── 销毁 ────────────────────────────── */

test("销毁：窗口与托盘都回收，且销毁前落盘一次", () => {
  const { host, created, written, FakeTray } = makeHost();
  host.start();
  host.show();
  host.destroy();
  assert.equal(created[0]._destroyed, true);
  assert.equal(FakeTray.last.destroyed, true);
  assert.ok(written.length >= 1);
});

test("销毁后再销毁不抛错", () => {
  const { host } = makeHost();
  host.start();
  host.destroy();
  assert.doesNotThrow(() => host.destroy());
});

/* ────────────────────────────── 反向事件通道（主进程 → 桌宠） ────────────────────────────── */

test("pushEvent：窗口不存在时返回 false，不抛错", () => {
  const { host } = makeHost();
  host.start();
  assert.equal(host.pushEvent({ kind: "speak", text: "hi" }), false);
});

test("pushEvent：窗口存在时送达 pet:event 通道", () => {
  const { host, created } = makeHost();
  host.start();
  host.show();
  const win = created[0];
  assert.equal(host.pushEvent({ kind: "speak", text: "早报来了" }), true);
  const sent = win.webContents._sent.filter((m) => m.ch === "pet:event");
  assert.equal(sent.length, 1);
  assert.deepEqual(sent[0].payload, { kind: "speak", text: "早报来了" });
});

test("pushEvent：畸形载荷一律拒绝，不把垃圾送进渲染层", () => {
  const { host, created } = makeHost();
  host.start();
  host.show();
  for (const bad of [null, undefined, "x", 42, [], { noKind: 1 }, { kind: 7 }]) {
    assert.equal(host.pushEvent(bad), false, JSON.stringify(bad));
  }
  assert.equal(created[0].webContents._sent.filter((m) => m.ch === "pet:event").length, 0);
});

test("pushEvent：窗口销毁后返回 false", () => {
  const { host } = makeHost();
  host.start();
  host.show();
  host.destroy();
  assert.equal(host.pushEvent({ kind: "reset" }), false);
});
