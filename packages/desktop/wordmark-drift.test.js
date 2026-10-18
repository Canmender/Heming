"use strict";
const test = require("node:test");
const assert = require("node:assert/strict");
const fs = require("node:fs");
const path = require("node:path");

/**
 * 字形单一真源守卫。
 *
 * 「Heming」的 path 数据有两份：web 端 `wordmarkGlyphs.ts`（登录页字样）与
 * splash.html 的内嵌副本（桌面端原生页要求自包含，无法 import TS 模块）。
 * 两份漂移会表现为「动画里的字和登录页的字不一样」，肉眼未必立刻发现。
 * 这里断言两者逐字节一致 —— 改一处必须改另一处。
 *
 * 项目已把「WAVE_MS 在 web/desktop 各写一份且无断言」记为技术债，这里不再重复那个坑。
 */

const SPLASH_PATH = path.join(__dirname, "splash.html");
const GLYPHS_PATH = path.join(__dirname, "..", "web", "src", "components", "wordmarkGlyphs.ts");

/** 从 splash.html 的 wordmark SVG 里按文档顺序取出全部 d 属性。 */
function splashPaths() {
  const html = fs.readFileSync(SPLASH_PATH, "utf8");
  const svgStart = html.indexOf('<svg class="wordmark"');
  assert.ok(svgStart > 0, "未能在 splash.html 中定位 wordmark SVG");
  const svgEnd = html.indexOf("</svg>", svgStart);
  assert.ok(svgEnd > svgStart, "wordmark SVG 未闭合");
  const svg = html.slice(svgStart, svgEnd);
  return [...svg.matchAll(/<path\s+d="([^"]+)"/g)].map((m) => m[1]);
}

/** 从 wordmarkGlyphs.ts 里按声明顺序取出全部 d 值。 */
function sourcePaths() {
  const ts = fs.readFileSync(GLYPHS_PATH, "utf8");
  return [...ts.matchAll(/\bd:\s*"([^"]+)"/g)].map((m) => m[1]);
}

test("splash.html 内嵌字形与 wordmarkGlyphs.ts 逐字节一致（顺序也一致）", () => {
  const fromSplash = splashPaths();
  const fromSource = sourcePaths();

  assert.ok(fromSource.length > 0, "未能从 wordmarkGlyphs.ts 解析出 path（正则失效？）");
  assert.ok(fromSplash.length > 0, "未能从 splash.html 解析出 path（结构变了？）");
  assert.equal(
    fromSplash.length,
    fromSource.length,
    `笔画数不一致：splash.html ${fromSplash.length} 条，wordmarkGlyphs.ts ${fromSource.length} 条`
  );

  for (let i = 0; i < fromSource.length; i++) {
    assert.equal(
      fromSplash[i],
      fromSource[i],
      `第 ${i + 1} 条 path 不一致：\n  splash.html      : ${fromSplash[i]}\n  wordmarkGlyphs.ts: ${fromSource[i]}`
    );
  }
});

test("字形数据非空：六个字母、十四个笔画都在", () => {
  const fromSource = sourcePaths();
  // H=3（左竖/右竖/横），e=1，m=4（左竖+三拱），i=2（竖+点），n=2（竖+拱），g=2（碗+下伸）
  assert.equal(fromSource.length, 14, "笔画总数应为 14");
  assert.ok(
    fromSource.every((d) => d.startsWith("M ")),
    "每条 path 都应以绝对 M 开头"
  );
});
