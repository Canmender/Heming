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

// ── 核心圆点必须在 splash 存活期内出现 ──
// 回归：`.core` 曾带 `transition ... 1.4s` 延迟，而 .visible 在 DURATION-100=1400ms 才加上，
// 于是圆点 2.8s 才开始放大、3.2s 才完成——splash 在 ~1.7s 就被主进程关闭，永远看不到。
test("splash.html 核心圆点无 transition-delay（否则 2.8s 才起放大，早于关闭）", () => {
  const coreRule = html.slice(html.indexOf(".core {"), html.indexOf(".core.visible"));
  assert.ok(
    coreRule.includes("transition: transform 0.4s ease;"),
    "核心圆点过渡应为无 delay 的 `transition: transform 0.4s ease;`"
  );
  // 过渡简写只允许出现一个时间值（duration）；第二个即 delay
  const shorthand = coreRule.match(/transition:\s*transform[^;]*;/);
  assert.ok(shorthand, "未找到 .core 的 transition 声明");
  assert.equal(
    (shorthand[0].match(/\d+(\.\d+)?m?s/g) || []).length,
    1,
    `transition 简写不应含 delay：${shorthand[0]}`
  );
});

test("splash.html 核心圆点在动画结束前被点亮（早于 splash 关闭窗口）", () => {
  const m = html.match(/setTimeout\([\s\S]*?DURATION\s*-\s*(\d+)/);
  assert.ok(m, "未找到点亮核心圆点的定时器");
  const shownAt = 1500 - Number(m[1]);
  assert.ok(shownAt <= 1400, `点亮时刻 ${shownAt}ms 应在第一段动画内`);
});

// ── 粒子沿四边均匀铺开 ──
// 回归：原 `t * w` / `t * h` 从 0 起步，粒子贴屏幕边缘（越出 margin 内缩框）。
test("splash.html 粒子位置留出 margin 内缩并铺满整条边", () => {
  assert.ok(html.includes("spanX = w - 2 * margin"), "横向跨度应扣除两侧 margin");
  assert.ok(html.includes("spanY = h - 2 * margin"), "纵向跨度应扣除两侧 margin");
  assert.ok(html.includes("t * spanX + margin"), "横向坐标应内缩 margin");
  assert.ok(html.includes("t * spanY + margin"), "纵向坐标应内缩 margin");
  assert.ok(!/\bt \* w\b/.test(html), "不应再使用贴边的 t * w");
  assert.ok(!/\bt \* h\b/.test(html), "不应再使用贴边的 t * h");
});
