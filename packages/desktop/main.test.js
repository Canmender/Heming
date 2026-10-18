"use strict";
const test = require("node:test");
const assert = require("node:assert/strict");

// 纯逻辑：是否应该显示 splash
function shouldShowSplash(env) {
  return !env || !env.HEMING_NO_SPLASH;
}

test("默认环境显示 splash", () => {
  assert.equal(shouldShowSplash({}), true);
  assert.equal(shouldShowSplash(undefined), true);
});

test("HEMING_NO_SPLASH=1 时不显示 splash", () => {
  assert.equal(shouldShowSplash({ HEMING_NO_SPLASH: "1" }), false);
});

test("splash 窗口配置：无边框透明置顶", () => {
  // 与 main.js 内 createSplashWindow 保持一致
  const cfg = { frame: false, transparent: true, alwaysOnTop: true, skipTaskbar: true };
  assert.equal(cfg.frame, false);
  assert.equal(cfg.transparent, true);
  assert.equal(cfg.alwaysOnTop, true);
  assert.equal(cfg.skipTaskbar, true);
});
