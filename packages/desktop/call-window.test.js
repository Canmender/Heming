"use strict";
const test = require("node:test");
const assert = require("node:assert/strict");
const { CALL_WINDOW_FLAG, isCallWindowUrl, callWindowOptions } = require("./call-window");

test("嵌入式源：app://heming 下的通话 URL 放行", () => {
  assert.equal(
    isCallWindowUrl("app://heming/index.html?hemingWindow=call&conv=c1&peers=u2&mode=voice", "app://heming"),
    true,
  );
});

test("嵌入式源：带路径前缀 / 根路径也放行", () => {
  assert.equal(isCallWindowUrl("app://heming/?hemingWindow=call&conv=c1&peers=u2", "app://heming"), true);
  assert.equal(isCallWindowUrl("app://heming?hemingWindow=call&conv=c1&peers=u2", "app://heming"), true);
});

test("外部站点即使带标记也不放行（防把第三方页面当通话窗）", () => {
  assert.equal(
    isCallWindowUrl("https://evil.example/?hemingWindow=call&conv=c1&peers=u2", "app://heming"),
    false,
  );
});

test("没有标记的普通外链不放行", () => {
  assert.equal(isCallWindowUrl("https://example.com/a", "app://heming"), false);
  assert.equal(isCallWindowUrl("app://heming/index.html", "app://heming"), false);
});

test("http(s) 部署源按 origin 比对：同源放行、跨源拒绝", () => {
  const origin = "http://47.92.39.184";
  assert.equal(isCallWindowUrl(`${origin}/?hemingWindow=call&conv=c1&peers=u2`, origin), true);
  assert.equal(isCallWindowUrl("http://47.92.39.184:8080/?hemingWindow=call", origin), false);
  assert.equal(isCallWindowUrl("http://another.host/?hemingWindow=call", origin), false);
});

test("非法输入不抛错、一律拒绝", () => {
  assert.equal(isCallWindowUrl("", "app://heming"), false);
  assert.equal(isCallWindowUrl(null, "app://heming"), false);
  assert.equal(isCallWindowUrl(`${CALL_WINDOW_FLAG}`, ""), false);
  assert.equal(isCallWindowUrl("not a url ?hemingWindow=call", "http://47.92.39.184"), false);
});

test("通话窗口参数：窄窗、置顶、有最小尺寸", () => {
  const opts = callWindowOptions();
  assert.equal(opts.alwaysOnTop, true);
  assert.ok(opts.width >= 360 && opts.width <= 520);
  assert.ok(opts.height >= 480);
  assert.ok(opts.minWidth <= opts.width && opts.minHeight <= opts.height);
  // 每次调用返回新对象（避免被调用方改动后污染下次）
  assert.notEqual(callWindowOptions(), opts);
});
