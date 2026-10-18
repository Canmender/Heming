"use strict";
const test = require("node:test");
const assert = require("node:assert/strict");
const fs = require("node:fs");
const path = require("node:path");
const {
  shouldShowSplash,
  splashWindowOptions,
  splashCloseDelayMs,
  isFatalLoadFailure,
  SPLASH_MS,
  GAP_MS,
  WAVE_MS,
  BOOT_TOTAL_MS,
  LOAD_WATCHDOG_MS,
} = require("./splash-config");

// 直接引用生产代码（splash-config.js 由 main.js require），避免平行实现。
const mainSrc = fs.readFileSync(path.join(__dirname, "main.js"), "utf8");

test("默认环境显示 splash", () => {
  assert.equal(shouldShowSplash({}), true);
  assert.equal(shouldShowSplash(undefined), true);
  assert.equal(shouldShowSplash({ HEMING_NO_SPLASH: "0" }), true);
});

test("HEMING_NO_SPLASH=1 时不显示 splash", () => {
  assert.equal(shouldShowSplash({ HEMING_NO_SPLASH: "1" }), false);
});

test("splash 窗口配置：无边框透明置顶 + 铺满主显示器", () => {
  const cfg = splashWindowOptions({ width: 1920, height: 1040 });
  // 无边框透明置顶
  assert.equal(cfg.frame, false);
  assert.equal(cfg.transparent, true);
  assert.equal(cfg.alwaysOnTop, true);
  assert.equal(cfg.skipTaskbar, true);
  // 铺满主显示器工作区
  assert.equal(cfg.width, 1920);
  assert.equal(cfg.height, 1040);
  // 先隐藏创建，避免白屏闪烁
  assert.equal(cfg.show, false);
  assert.equal(cfg.backgroundColor, "#ffffff");
});

test("多显示器：主屏不在原点时使用 workArea 的 x/y", () => {
  // 主屏位于右侧副屏（非 0,0 原点）
  const cfg = splashWindowOptions({ x: 1920, y: 0, width: 1920, height: 1040 });
  assert.equal(cfg.x, 1920);
  assert.equal(cfg.y, 0);
  assert.equal(cfg.width, 1920);
  assert.equal(cfg.height, 1040);
});

// ── 启动动画时间轴：总时长必须恰好 3000ms（粒子 1500 + 静默 200 + 声波 1300） ──
test("启动动画总时长 3000ms（1.5s 粒子 + 0.2s 静默 + 1.3s 声波）", () => {
  assert.equal(SPLASH_MS, 1500);
  assert.equal(GAP_MS, 200);
  assert.equal(WAVE_MS, 1300);
  assert.equal(BOOT_TOTAL_MS, 3000);
  assert.equal(BOOT_TOTAL_MS, SPLASH_MS + GAP_MS + WAVE_MS);
});

test("加载看门狗硬上限 8s（既不 finish 也不 fail 时兜底收掉 splash）", () => {
  assert.equal(LOAD_WATCHDOG_MS, 8000);
});

// ── splashCloseDelayMs：远端 ~86ms 就加载完时不能立刻关 splash（会截断第一段动画） ──
test("云端极快加载（86ms）不截断粒子段：仍需等满 1.5s + 0.2s", () => {
  const delay = splashCloseDelayMs(86);
  assert.equal(delay, BOOT_TOTAL_MS - WAVE_MS - 86); // 1614ms，非常量兜底
  assert.equal(delay + 86, SPLASH_MS + GAP_MS); // splash 实际可见 1700ms
  assert.ok(delay > 200, "不能被 200ms 下限吃掉");
});

test("加载在 1.5s 内完成时，splash 恰好可见 1.7s（任意 elapsed）", () => {
  for (const elapsed of [0, 1, 50, 300, 1000, 1500]) {
    assert.equal(elapsed + splashCloseDelayMs(elapsed), SPLASH_MS + GAP_MS, `elapsed=${elapsed}`);
  }
});

test("任意加载耗时下 splash 可见时长都不会低于 1.7s（不可截断）", () => {
  for (const elapsed of [0, 86, 900, 1500, 1699, 1700, 3000, 7900]) {
    const visible = elapsed + splashCloseDelayMs(elapsed);
    assert.ok(visible >= SPLASH_MS + GAP_MS, `elapsed=${elapsed} 只可见 ${visible}ms`);
  }
});

test("加载耗时超过 1.7s 时保留下限 200ms（静默间隔不消失）", () => {
  assert.equal(splashCloseDelayMs(1700), 200);
  assert.equal(splashCloseDelayMs(5000), 200);
  // 负数/非法输入（时钟回拨等）按 0 处理，不会给出负等待
  assert.equal(splashCloseDelayMs(-100), BOOT_TOTAL_MS - WAVE_MS);
  assert.equal(splashCloseDelayMs(NaN), BOOT_TOTAL_MS - WAVE_MS);
});

// ── did-fail-load 判定：子 frame 与 ERR_ABORTED 都不算主页面失败 ──
test("isFatalLoadFailure：主 frame 的普通错误码才算加载失败", () => {
  assert.equal(isFatalLoadFailure(-105, true), true); // ERR_NAME_NOT_RESOLVED
  assert.equal(isFatalLoadFailure(-102, true), true); // ERR_CONNECTION_REFUSED
});

test("isFatalLoadFailure：子 frame 失败不算（不打断启动动画）", () => {
  assert.equal(isFatalLoadFailure(-105, false), false);
  assert.equal(isFatalLoadFailure(-102, false), false);
});

test("isFatalLoadFailure：ERR_ABORTED(-3) 不算失败（导航被主动取消）", () => {
  assert.equal(isFatalLoadFailure(-3, true), false);
});

// ── main.js 接线不变量（无法在 Node 里起 Electron，用源码断言钉住无行为接缝的两处）──
// 关闭时机 / 启动信号 / 失败兜底 / 看门狗 / 主窗口关闭等行为在 splash-lifecycle.test.js
// 用假窗口真实驱动，不在这里做字符串断言。
test("main.js：有启动动画时主窗口 show:false（避免先闪白底主窗口）", () => {
  assert.ok(mainSrc.includes("show: !withSplash"));
});

test("main.js：splash 覆盖主窗口所在显示器（多显示器）", () => {
  assert.ok(mainSrc.includes("screen.getDisplayMatching(mainWin.getBounds())"));
  assert.ok(!mainSrc.includes("screen.getPrimaryDisplay()"));
});
