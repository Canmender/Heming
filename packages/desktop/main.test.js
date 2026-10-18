"use strict";
const test = require("node:test");
const assert = require("node:assert/strict");
const { shouldShowSplash, splashWindowOptions } = require("./splash-config");

// 直接引用生产代码（splash-config.js 由 main.js require），避免平行实现。

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
  // 铺满主显示器工作区，原点归零
  assert.equal(cfg.x, 0);
  assert.equal(cfg.y, 0);
  assert.equal(cfg.width, 1920);
  assert.equal(cfg.height, 1040);
  // 先隐藏创建，避免白屏闪烁
  assert.equal(cfg.show, false);
  assert.equal(cfg.backgroundColor, "#ffffff");
});
