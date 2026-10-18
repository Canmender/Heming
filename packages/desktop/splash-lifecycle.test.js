"use strict";
const test = require("node:test");
const assert = require("node:assert/strict");
const { attachSplashLifecycle, BOOT_WAVE_SNIPPET } = require("./splash-lifecycle");
const { WRITE_MS, SPLASH_MS, GAP_MS, LOAD_WATCHDOG_MS, ERR_ABORTED } = require("./splash-config");

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

/** 建好一套假环境并完成接线。reducedMotion 可选（默认关闭）。 */
function setup(opts = {}) {
  const clock = fakeClock();
  const mainWin = fakeWindow();
  const splash = fakeSplash();
  const lifecycle = attachSplashLifecycle({
    splash,
    mainWin,
    now: clock.now,
    setTimer: clock.setTimer,
    clearTimer: clock.clearTimer,
    reducedMotion: opts.reducedMotion === true,
  });
  return { clock, mainWin, splash, lifecycle };
}

// 手写 1500 + 粒子 1500 + 静默 200 = 3200ms（splash 的可见地板）
const SPLASH_VISIBLE_MS = WRITE_MS + SPLASH_MS + GAP_MS;

// ── 正常路径：首次加载 ──

test("首次 did-finish-load：不立即发信号，等满粒子段后关 splash 并触发声波段", () => {
  const { clock, mainWin, splash } = setup();
  mainWin.webContents.emit("did-finish-load");

  // 立刻发信号会让声波段在 splash 后面播完（用户看不到），故当下不得发
  assert.deepEqual(mainWin.webContents.jsCalls, []);
  assert.equal(splash.destroyed, false);

  clock.advance(SPLASH_VISIBLE_MS - 1);
  assert.equal(splash.destroyed, false, "splash 必须完整播满 3.2s");

  clock.advance(1);
  assert.equal(splash.destroyed, true);
  assert.equal(mainWin.visible, true, "关闭 splash 后必须露出主窗口");
  assert.deepEqual(mainWin.webContents.jsCalls, [BOOT_WAVE_SNIPPET]);
});

test("云端极快加载（86ms）仍播满 3.2s：不截断手写段与粒子段", () => {
  const { clock, mainWin, splash } = setup();
  clock.advance(86); // 远端页面 86ms 就加载完
  mainWin.webContents.emit("did-finish-load");

  clock.advance(SPLASH_VISIBLE_MS - 86 - 1);
  assert.equal(splash.destroyed, false, "快加载不等于可以早关");
  clock.advance(1);
  assert.equal(splash.destroyed, true);
  assert.equal(mainWin.webContents.jsCalls.length, 1);
});

test("加载已超过 3.2s：保底 200ms 静默仍保留", () => {
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

// 启动信号必须在 splash 关闭之后派发：splash 是覆盖整个工作区的 alwaysOnTop 窗口，
// 还在屏幕上时主渲染进程被遮挡（Chromium 会暂停其 rAF/定时器），声波段会被卡住。
test("启动信号在 splash 关闭之后才派发（主渲染进程不再被遮挡）", () => {
  const clock = fakeClock();
  const mainWin = fakeWindow();
  const splash = fakeSplash();
  const order = [];

  const origSplashClose = splash.close.bind(splash);
  splash.close = () => {
    if (!splash.destroyed) order.push("close-splash");
    origSplashClose();
  };
  const origExec = mainWin.webContents.executeJavaScript.bind(mainWin.webContents);
  mainWin.webContents.executeJavaScript = (src) => {
    order.push("signal");
    return origExec(src);
  };
  const origShow = mainWin.show.bind(mainWin);
  mainWin.show = () => {
    order.push("show-main");
    origShow();
  };

  attachSplashLifecycle({
    splash,
    mainWin,
    now: clock.now,
    setTimer: clock.setTimer,
    clearTimer: clock.clearTimer,
  });

  mainWin.webContents.emit("did-finish-load");
  clock.advance(SPLASH_VISIBLE_MS);

  assert.deepEqual(order, ["close-splash", "show-main", "signal"]);
  assert.ok(order.indexOf("close-splash") < order.indexOf("signal"), "先关 splash 再发信号");
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

// ── 减弱动态（prefers-reduced-motion） ──
// 开启时 splash.html 不播任何动画（只留一个静止墨点），3.2s 可见地板失去意义；
// 不让这类用户对着静止画面干等。

test("减弱动态：did-finish-load 后立刻收尾，不等 3.2s 地板", () => {
  const { clock, mainWin, splash } = setup({ reducedMotion: true });
  mainWin.webContents.emit("did-finish-load");

  clock.advance(0); // 无动画可播，下一个 tick 就应关掉
  assert.equal(splash.destroyed, true, "减弱动态下不该等满地板");
  assert.equal(mainWin.visible, true);
  assert.deepEqual(mainWin.webContents.jsCalls, [BOOT_WAVE_SNIPPET], "仍要发信号让 BootWave 立即揭开");
});

test("减弱动态：偏好查询晚于 did-finish-load 到达时就地提前收尾", () => {
  const { clock, mainWin, splash, lifecycle } = setup();
  mainWin.webContents.emit("did-finish-load");

  // 已按常规排上 3.2s 定时器
  clock.advance(100);
  assert.equal(splash.destroyed, false, "此刻还没到常规关闭时刻");

  lifecycle.setReducedMotion(true);
  assert.equal(splash.destroyed, true, "查到减弱动态后应立即收尾");
  assert.equal(mainWin.visible, true);
  assert.equal(mainWin.webContents.jsCalls.length, 1);
  assert.equal(clock.pendingCount(), 0, "不应残留定时器");
});

test("减弱动态：false 不改变常规时序（不会误伤普通用户）", () => {
  const { clock, mainWin, splash, lifecycle } = setup();
  lifecycle.setReducedMotion(false);
  mainWin.webContents.emit("did-finish-load");

  clock.advance(SPLASH_VISIBLE_MS - 1);
  assert.equal(splash.destroyed, false, "普通路径仍须播满地板");
  clock.advance(1);
  assert.equal(splash.destroyed, true);
});

test("减弱动态：重复调用幂等（查询结果多次回填不会重复收尾）", () => {
  const { clock, mainWin, splash, lifecycle } = setup();
  mainWin.webContents.emit("did-finish-load");
  lifecycle.setReducedMotion(true);
  lifecycle.setReducedMotion(true);
  clock.advance(SPLASH_VISIBLE_MS * 2);
  assert.equal(splash.closeCalls, 1, "只应收尾一次");
  assert.equal(mainWin.webContents.jsCalls.length, 1, "信号也不应重复发");
});
