"use strict";
const test = require("node:test");
const assert = require("node:assert/strict");
const { attachSplashLifecycle, BOOT_WAVE_SNIPPET } = require("./splash-lifecycle");
const { SPLASH_MS, GAP_MS, LOAD_WATCHDOG_MS, ERR_ABORTED } = require("./splash-config");

// 真实驱动 splash-lifecycle.js（注入假窗口 + 假计时器），覆盖关闭时机与启动信号的所有路径。

/** 极简 EventEmitter：只实现本项目用到的方法。 */
function emitter() {
  const map = new Map();
  return {
    on(ev, fn) {
      if (!map.has(ev)) map.set(ev, new Set());
      map.get(ev).add(fn);
      return this;
    },
    once(ev, fn) {
      const wrap = (...args) => {
        this.removeListener(ev, wrap);
        fn(...args);
      };
      return this.on(ev, wrap);
    },
    removeListener(ev, fn) {
      const set = map.get(ev);
      if (set) set.delete(fn);
      return this;
    },
    listenerCount(ev) {
      return map.get(ev) ? map.get(ev).size : 0;
    },
    emit(ev, ...args) {
      for (const fn of [...(map.get(ev) || [])]) fn(...args);
    },
  };
}

function fakeWebContents() {
  const wc = {
    ...emitter(),
    destroyed: false,
    jsCalls: [],
    isDestroyed() {
      return wc.destroyed;
    },
    executeJavaScript(src) {
      wc.jsCalls.push(src);
      return Promise.resolve();
    },
  };
  return wc;
}

function fakeWindow() {
  const win = {
    ...emitter(),
    webContents: fakeWebContents(),
    destroyed: false,
    visible: false,
    showCalls: 0,
    isDestroyed() {
      return win.destroyed;
    },
    isVisible() {
      return win.visible;
    },
    show() {
      win.showCalls++;
      win.visible = true;
    },
    getBounds() {
      return { x: 0, y: 0, width: 1280, height: 840 };
    },
  };
  return win;
}

function fakeSplash() {
  const s = {
    ...emitter(),
    destroyed: false,
    visible: false,
    closeCalls: 0,
    isDestroyed() {
      return s.destroyed;
    },
    show() {
      s.visible = true;
    },
    close() {
      if (s.destroyed) return;
      s.closeCalls++;
      s.destroyed = true;
      s.emit("closed");
    },
  };
  return s;
}

/** 假计时器队列：advance(ms) 按到期顺序执行回调。 */
function fakeClock() {
  let now = 0;
  let seq = 0;
  const pending = new Map();
  return {
    now: () => now,
    setTimer(fn, ms) {
      const id = ++seq;
      pending.set(id, { fn, at: now + ms });
      return id;
    },
    clearTimer(id) {
      pending.delete(id);
    },
    pendingCount: () => pending.size,
    advance(ms) {
      const target = now + ms;
      for (;;) {
        let nextId = null;
        let nextAt = Infinity;
        for (const [id, t] of pending) {
          if (t.at <= target && t.at < nextAt) {
            nextAt = t.at;
            nextId = id;
          }
        }
        if (nextId === null) break;
        const t = pending.get(nextId);
        pending.delete(nextId);
        now = t.at;
        t.fn();
      }
      now = target;
    },
  };
}

/** 建好一套假环境并完成接线。 */
function setup() {
  const clock = fakeClock();
  const mainWin = fakeWindow();
  const splash = fakeSplash();
  const lifecycle = attachSplashLifecycle({
    splash,
    mainWin,
    now: clock.now,
    setTimer: clock.setTimer,
    clearTimer: clock.clearTimer,
  });
  return { clock, mainWin, splash, lifecycle };
}

const SPLASH_VISIBLE_MS = SPLASH_MS + GAP_MS; // 1700ms

// ── 正常路径：首次加载 ──

test("首次 did-finish-load：不立即发信号，等满粒子段后关 splash 并触发声波段", () => {
  const { clock, mainWin, splash } = setup();
  mainWin.webContents.emit("did-finish-load");

  // 立刻发信号会让声波段在 splash 后面播完（用户看不到），故当下不得发
  assert.deepEqual(mainWin.webContents.jsCalls, []);
  assert.equal(splash.destroyed, false);

  clock.advance(SPLASH_VISIBLE_MS - 1);
  assert.equal(splash.destroyed, false, "splash 必须完整播满 1.7s");

  clock.advance(1);
  assert.equal(splash.destroyed, true);
  assert.equal(mainWin.visible, true, "关闭 splash 后必须露出主窗口");
  assert.deepEqual(mainWin.webContents.jsCalls, [BOOT_WAVE_SNIPPET]);
});

test("云端极快加载（86ms）仍播满 1.7s：不截断粒子聚拢段", () => {
  const { clock, mainWin, splash } = setup();
  clock.advance(86); // 远端页面 86ms 就加载完
  mainWin.webContents.emit("did-finish-load");

  clock.advance(SPLASH_VISIBLE_MS - 86 - 1);
  assert.equal(splash.destroyed, false, "快加载不等于可以早关");
  clock.advance(1);
  assert.equal(splash.destroyed, true);
  assert.equal(mainWin.webContents.jsCalls.length, 1);
});

test("加载已超过 1.7s：保底 200ms 静默仍保留", () => {
  const { clock, mainWin, splash } = setup();
  clock.advance(5000);
  mainWin.webContents.emit("did-finish-load");
  clock.advance(199);
  assert.equal(splash.destroyed, false);
  clock.advance(1);
  assert.equal(splash.destroyed, true);
});

test("正常收尾后不残留定时器（看门狗已被清掉，splash 不会被二次处理）", () => {
  const { clock, mainWin, splash } = setup();
  mainWin.webContents.emit("did-finish-load");
  clock.advance(SPLASH_VISIBLE_MS);
  assert.equal(splash.destroyed, true);
  assert.equal(clock.pendingCount(), 0);
  assert.equal(splash.closeCalls, 1);
});

test("主窗口已可见时不重复 show（不抢焦点）", () => {
  const { clock, mainWin, splash } = setup();
  mainWin.visible = true;
  mainWin.webContents.emit("did-finish-load");
  clock.advance(SPLASH_VISIBLE_MS);
  assert.equal(splash.destroyed, true);
  assert.equal(mainWin.showCalls, 0);
});

// ── R2：重载（视图 → 重新加载 / Ctrl+R）必须重发启动信号 ──
// 渲染进程是全新文档：preload 的 bootStarted 归零、BootWave 重新挂载等待信号。
// 若信号只在首次加载发，重载后 BootWave 只能等 5s 兜底，白遮罩会盖住界面 ~6.3s。

test("重载（第二次 did-finish-load）立刻收到启动信号，不等任何定时器", () => {
  const { clock, mainWin, splash } = setup();
  mainWin.webContents.emit("did-finish-load");
  clock.advance(SPLASH_VISIBLE_MS);
  assert.equal(splash.destroyed, true);
  assert.equal(mainWin.webContents.jsCalls.length, 1);

  // 用户按 Ctrl+R：新文档加载完成
  mainWin.webContents.emit("did-finish-load");
  assert.equal(mainWin.webContents.jsCalls.length, 2, "重载后必须立刻重发信号");
  assert.equal(clock.pendingCount(), 0, "重发信号不应排任何定时器");
});

test("splash 关闭后 did-finish-load 监听仍保留（重载才有信号可发）", () => {
  const { clock, mainWin, splash } = setup();
  mainWin.webContents.emit("did-finish-load");
  clock.advance(SPLASH_VISIBLE_MS);
  assert.equal(splash.destroyed, true);
  assert.equal(mainWin.webContents.listenerCount("did-finish-load"), 1);
});

test("连续多次重载：每次加载各发一次信号", () => {
  const { clock, mainWin } = setup();
  mainWin.webContents.emit("did-finish-load");
  clock.advance(SPLASH_VISIBLE_MS);

  for (let i = 0; i < 3; i++) mainWin.webContents.emit("did-finish-load");
  assert.equal(mainWin.webContents.jsCalls.length, 4);
});

test("重载不再重放 splash 收尾逻辑（不会二次 close、不改主窗口可见性）", () => {
  const { clock, mainWin, splash } = setup();
  mainWin.webContents.emit("did-finish-load");
  clock.advance(SPLASH_VISIBLE_MS);
  assert.equal(splash.closeCalls, 1);

  mainWin.webContents.emit("did-finish-load");
  clock.advance(10000);
  assert.equal(splash.closeCalls, 1, "splash 只应被关一次");
  assert.equal(clock.pendingCount(), 0);
});

test("兜底收尾（看门狗）之后重载仍能收到启动信号", () => {
  const { clock, mainWin, splash } = setup();
  clock.advance(LOAD_WATCHDOG_MS);
  assert.equal(splash.destroyed, true);

  mainWin.webContents.emit("did-finish-load");
  assert.equal(mainWin.webContents.jsCalls.length, 1);
});

test("兜底收尾（加载失败）之后重载仍能收到启动信号", () => {
  const { mainWin, splash } = setup();
  mainWin.webContents.emit("did-fail-load", {}, -105, "ERR", "http://x", true);
  assert.equal(splash.destroyed, true);

  mainWin.webContents.emit("did-finish-load");
  assert.equal(mainWin.webContents.jsCalls.length, 1);
});

// ── 主窗口被关（C2） ──

test("启动期间主窗口被关：splash 一并关闭（否则残留无任务栏入口的置顶遮罩）", () => {
  const { mainWin, splash } = setup();
  assert.equal(splash.destroyed, false);
  mainWin.emit("closed");
  assert.equal(splash.destroyed, true);
});

test("主窗口被关后 did-finish-load 不再发信号（webContents 已销毁，不越界调用）", () => {
  const { clock, mainWin, splash } = setup();
  mainWin.emit("closed");
  assert.equal(splash.destroyed, true);
  const before = mainWin.webContents.jsCalls.length;

  mainWin.destroyed = true;
  mainWin.webContents.destroyed = true;
  mainWin.webContents.emit("did-finish-load");
  clock.advance(10000);
  assert.equal(mainWin.webContents.jsCalls.length, before, "销毁后 executeJavaScript 不得被调用");
});

// ── 加载失败（I4） ──

test("did-fail-load：只有主 frame 的真实错误才收掉 splash", () => {
  // 子 frame 失败：页面里的子帧挂掉不代表主页面没加载出来
  const sub = setup();
  sub.mainWin.webContents.emit("did-fail-load", {}, -105, "ERR", "http://x", false);
  assert.equal(sub.splash.destroyed, false, "子 frame 失败不应打断启动动画");

  // ERR_ABORTED：后续导航主动取消在途请求，不是失败
  const aborted = setup();
  aborted.mainWin.webContents.emit("did-fail-load", {}, ERR_ABORTED, "ERR", "http://x", true);
  assert.equal(aborted.splash.destroyed, false, "ERR_ABORTED 不算失败");

  // 主 frame 真错误：立刻收尾露出错误页
  const failed = setup();
  failed.mainWin.webContents.emit("did-fail-load", {}, -105, "ERR", "http://x", true);
  assert.equal(failed.splash.destroyed, true);
  assert.equal(failed.mainWin.visible, true, "失败路径也要把主窗口露出来");
});

// ── 看门狗（M12） ──

test("8s 看门狗：既不 finish 也不 fail 时关掉 splash 并露出主窗口", () => {
  const { clock, mainWin, splash } = setup();
  clock.advance(LOAD_WATCHDOG_MS - 1);
  assert.equal(splash.destroyed, false);

  clock.advance(1);
  assert.equal(splash.destroyed, true);
  assert.equal(mainWin.visible, true);
  assert.deepEqual(mainWin.webContents.jsCalls, [], "无页面可揭示，看门狗路径不发信号");
});

// ── abort（loadFile 失败路径） ──

test("abort() 幂等：重复调用只收尾一次且不抛", () => {
  const { mainWin, splash, lifecycle } = setup();
  lifecycle.abort();
  assert.equal(splash.closeCalls, 1);
  assert.equal(mainWin.visible, true);
  assert.doesNotThrow(() => lifecycle.abort());
  assert.equal(splash.closeCalls, 1);
});
