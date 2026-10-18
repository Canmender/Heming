"use strict";
const test = require("node:test");
const assert = require("node:assert/strict");
const {
  TITLE_BAR_HEIGHT,
  TITLE_BAR_COLOR,
  TITLE_BAR_SYMBOL_COLOR,
  titleBarOptions,
} = require("./title-bar");

test("Windows 走 titleBarOverlay：自定义配色与高度", () => {
  const opts = titleBarOptions("win32");
  assert.equal(opts.titleBarStyle, "hidden");
  assert.deepEqual(opts.titleBarOverlay, {
    color: TITLE_BAR_COLOR,
    symbolColor: TITLE_BAR_SYMBOL_COLOR,
    height: TITLE_BAR_HEIGHT,
  });
  assert.equal(opts.trafficLightPosition, undefined);
});

test("macOS 走 trafficLightPosition，不含 titleBarOverlay", () => {
  const opts = titleBarOptions("darwin");
  assert.equal(opts.titleBarStyle, "hidden");
  assert.deepEqual(opts.trafficLightPosition, { x: 14, y: 12 });
  assert.equal(opts.titleBarOverlay, undefined);
});

test("所有平台都隐藏系统标题栏", () => {
  for (const p of ["win32", "darwin", "linux"]) {
    assert.equal(titleBarOptions(p).titleBarStyle, "hidden");
  }
});

test("未知平台回退 Windows 分支（不抛错）", () => {
  const opts = titleBarOptions("freebsd");
  assert.equal(opts.titleBarStyle, "hidden");
  assert.ok(opts.titleBarOverlay);
});

test("配色常量与设计规格一致", () => {
  assert.equal(TITLE_BAR_HEIGHT, 38);
  assert.equal(TITLE_BAR_COLOR, "#fafafa");
  assert.equal(TITLE_BAR_SYMBOL_COLOR, "#666666");
});
