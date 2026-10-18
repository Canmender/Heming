"use strict";
const test = require("node:test");
const assert = require("node:assert/strict");
const fs = require("node:fs");
const path = require("node:path");

const html = fs.readFileSync(path.join(__dirname, "splash.html"), "utf8");

test("splash.html 包含粒子容器", () => {
  assert.ok(html.includes('id="scene"'));
  assert.ok(html.includes("'particle'"));
});

test("splash.html 包含核心圆点", () => {
  assert.ok(html.includes('id="core"'));
  assert.ok(html.includes("border-radius: 50%"));
});

test("splash.html 包含 Web Audio 音效", () => {
  assert.ok(html.includes("AudioContext"));
  assert.ok(html.includes("300"));
});

test("splash.html 包含 prefers-reduced-motion 检测", () => {
  assert.ok(html.includes("prefers-reduced-motion"));
});

test("splash.html 动画时长 1500ms", () => {
  assert.ok(html.includes("1500"));
});

test("splash.html 无 preload 依赖（不引用 window.heming）", () => {
  assert.ok(!html.includes("window.heming"));
});
