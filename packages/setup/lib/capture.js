"use strict";
/**
 * 视觉验收用：把界面推进到各个状态，逐个截图。
 *
 * 为什么要有这个：安装动画是这套界面最贵的部分，而真装一遍要下载 60 MB、装两分钟、
 * 还得有真实机器。开发时用 `electron . --capture=<dir>` 直接把每个状态渲染出来存 PNG，
 * 改一版看一眼，不用反复走完整安装。
 *
 * 截图之外还顺手把渲染层的自检信息写成 diagnostics.json（字形每条笔画的实际长度、
 * 当前 dashoffset、SVG 实际尺寸、页面报错）。截图只能看出「少了一笔」，
 * 有了这些数字才知道是没画、被裁掉，还是动画压根没跑到。
 */

const fs = require("node:fs/promises");
const path = require("node:path");

const delay = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

/** 覆盖全部界面状态；顺序即截图顺序。 */
const DEFAULT_SHOTS = [
  { name: "01-ready-writing", state: "ready", waitMs: 360 },
  { name: "02-ready", state: "ready", waitMs: 1900 },
  { name: "03-work-download", state: "work-download", waitMs: 800 },
  { name: "04-work-install", state: "work-install", waitMs: 800 },
  { name: "05-done", state: "done", waitMs: 1100 },
  { name: "06-error", state: "error", waitMs: 700 },
];

/** 在渲染进程里读字形与布局的实际数值。字符串会在页面上下文里执行。 */
const DIAGNOSTICS_SCRIPT = `(() => {
  const round = (value) => Math.round(value * 100) / 100;
  const boxOf = (element) => {
    if (!element) return null;
    const rect = element.getBoundingClientRect();
    return { x: round(rect.x), y: round(rect.y), width: round(rect.width), height: round(rect.height) };
  };
  const svg = document.getElementById("wordmark");
  const paths = Array.from(document.querySelectorAll("#wordmark-strokes path"));
  return {
    viewport: { width: window.innerWidth, height: window.innerHeight, dpr: window.devicePixelRatio },
    svg: boxOf(svg),
    svgStyle: svg ? { width: getComputedStyle(svg).width, height: getComputedStyle(svg).height } : null,
    pathCount: paths.length,
    paths: paths.map((path) => ({
      letter: path.dataset.letter || "",
      length: round(path.getTotalLength()),
      dashoffset: path.style.strokeDashoffset,
      dasharray: path.style.strokeDasharray,
      box: boxOf(path),
    })),
    errors: Array.isArray(window.__setupErrors) ? window.__setupErrors.slice(0, 12) : [],
  };
})()`;

/**
 * @param {Electron.WebContents} webContents
 * @param {string} outDir
 * @param {{name: string, state: string, waitMs: number}[]} [shots]
 */
async function captureShots(webContents, outDir, shots = DEFAULT_SHOTS) {
  await fs.mkdir(outDir, { recursive: true });
  const files = [];
  for (const shot of shots) {
    webContents.send("setup:capture-state", shot.state);
    await delay(shot.waitMs);
    const image = await webContents.capturePage();
    const filePath = path.join(outDir, `${shot.name}.png`);
    await fs.writeFile(filePath, image.toPNG());
    files.push(filePath);
  }

  try {
    const diagnostics = await webContents.executeJavaScript(DIAGNOSTICS_SCRIPT);
    await fs.writeFile(path.join(outDir, "diagnostics.json"), `${JSON.stringify(diagnostics, null, 2)}\n`);
  } catch (error) {
    await fs.writeFile(
      path.join(outDir, "diagnostics.json"),
      `${JSON.stringify({ error: String((error && error.message) || error) }, null, 2)}\n`,
    );
  }
  return files;
}

module.exports = { captureShots, DEFAULT_SHOTS };
