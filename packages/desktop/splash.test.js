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

// ── 粒子沿四边真正铺满 ──
// 回归①：原 `t * w` / `t * h` 从 0 起步，粒子贴屏幕边缘（越出 margin 内缩框）。
// 回归②：`t = counts/perSide` 使 t 只到 5/6，每条边末端 1/6 永远没有粒子
//        （w=1200、margin=20 时上边最右只到 987px，右侧 213px 空白）。
// 直接从 splash.html 抽出 particlePosition 真实执行 —— 不是字符串匹配。
function loadParticlePosition() {
  const start = html.indexOf("function particlePosition");
  const end = html.indexOf("function createParticles");
  assert.ok(start > 0 && end > start, "未能在 splash.html 中定位 particlePosition");
  // eslint-disable-next-line no-new-func
  return new Function(
    html.slice(start, end) + "\nreturn particlePosition;"
  )();
}

test("粒子位置公式含两端：t∈[0,1] 时端点恰好落在 margin 内缩框上", () => {
  const particlePosition = loadParticlePosition();
  const w = 1200, h = 800, margin = 20;

  // 每条边的「起点 / 终点」坐标（含变化轴与固定轴）——穷举四边，避免断言互相掩盖
  const cases = [
    { side: 0, start: { x: margin, y: margin }, end: { x: w - margin, y: margin } },
    { side: 1, start: { x: w - margin, y: margin }, end: { x: w - margin, y: h - margin } },
    { side: 2, start: { x: margin, y: h - margin }, end: { x: w - margin, y: h - margin } },
    { side: 3, start: { x: margin, y: margin }, end: { x: margin, y: h - margin } },
  ];
  for (const c of cases) {
    assert.deepEqual(particlePosition(c.side, 0, w, h, margin), c.start, `side ${c.side} 起点`);
    assert.deepEqual(particlePosition(c.side, 1, w, h, margin), c.end, `side ${c.side} 终点`);
  }
});

test("每条边的粒子等距铺满整条边（末个粒子到达 w/h - margin，无 1/6 空白）", () => {
  const particlePosition = loadParticlePosition();
  const w = 1200, h = 800, margin = 20, perSide = 6;

  // 复刻 splash.html 的取点：t = i / (perSide - 1)，i ∈ [0, perSide)
  const sideCoords = (side) =>
    Array.from({ length: perSide }, (_, i) =>
      particlePosition(side, i / (perSide - 1), w, h, margin)
    );
  // side 0/2 沿上/下边 → 变化的是 x；side 1/3 沿右/左边 → 变化的是 y
  const alongX = [0, 2];
  const alongY = [1, 3];

  for (const side of alongX) {
    const xs = sideCoords(side).map((p) => p.x);
    assert.equal(xs[0], margin, `side ${side} 首粒子应贴左边内缩框`);
    assert.equal(xs[xs.length - 1], w - margin, `side ${side} 末粒子应到达右边内缩框`);
    const step = (w - 2 * margin) / (perSide - 1);
    for (let i = 1; i < xs.length; i++) {
      assert.ok(
        Math.abs(xs[i] - xs[i - 1] - step) < 1e-9,
        `side ${side} 第 ${i} 段间距 ${xs[i] - xs[i - 1]} ≠ ${step}`
      );
    }
  }
  for (const side of alongY) {
    const ys = sideCoords(side).map((p) => p.y);
    assert.equal(ys[0], margin, `side ${side} 首粒子应贴上边内缩框`);
    assert.equal(ys[ys.length - 1], h - margin, `side ${side} 末粒子应到达下边内缩框`);
  }

  // 反证：旧公式（除以 perSide）在同尺寸下末端差一整格，正是被修的空白
  const oldLast = ((perSide - 1) / perSide) * (w - 2 * margin) + margin;
  assert.ok(oldLast < w - margin - 150, "对照：旧公式末端确实差约一格");
});

test("createParticles 使用抽出的 particlePosition（公式不是死代码）", () => {
  assert.ok(html.includes("particlePosition(side, t, w, h, margin)"));
  assert.ok(html.includes("counts[side] / (perSide - 1)"));
  assert.ok(!html.includes("counts[side] / perSide"), "不应再用除以 perSide 的取点");
  assert.ok(!/\bt \* w\b/.test(html), "不应再使用贴边的 t * w");
  assert.ok(!/\bt \* h\b/.test(html), "不应再使用贴边的 t * h");
});
