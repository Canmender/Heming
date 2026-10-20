/**
 * 导出单文件 HTML。
 *
 * 沿用 Lieflat Charts 的交付形态：图表是一份**自包含**的 HTML 文件——
 * 内联样式、内联 SVG，不依赖外部资源，双击就能看、能发出去。
 *
 * 与上游的差别：上游的模板靠 CDN 拉 Chart.js/ECharts，离线打不开；
 * 和鸣的图表全部是手写 SVG，**离线可用**，字体回落到系统无衬线。
 */

import { CHART_MOTION_CSS, renderChart } from "./renderer.js";
import { esc } from "./tokens.js";
import type { ChartSpec } from "./spec.js";

/**
 * 生成单文件 HTML。
 *
 * @param spec 图表规范
 * @param opts.title 页面标题（默认用图表标题）
 */
export function exportChartHtml(spec: ChartSpec, opts: { title?: string } = {}): string {
  const { svg, background } = renderChart(spec, { animate: true });
  const pageTitle = opts.title || spec.title || "图表";
  return `<!DOCTYPE html>
<html lang="zh-CN">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width,initial-scale=1">
<title>${esc(pageTitle)}</title>
<style>
  :root{color-scheme:light}
  *{margin:0;padding:0;box-sizing:border-box}
  body{background:${background};font-family:Inter,'PingFang SC','Microsoft YaHei',system-ui,sans-serif;
    color:#1C1C1A;padding:32px;-webkit-font-smoothing:antialiased}
  .wrap{max-width:${spec.type === "F10" || spec.type === "L16" ? 900 : 720}px;margin:0 auto}
  svg{display:block;width:100%;height:auto}
${CHART_MOTION_CSS}
</style>
</head>
<body>
<div class="wrap">
${svg}
</div>
</body>
</html>
`;
}

/** 建议的文件名：图表标题 + 图型，无标题时用时间戳。 */
export function chartFileName(spec: ChartSpec): string {
  const base = (spec.title || "").trim();
  const safe = base
    ? base.replace(/[<>:"/\\|?*\x00-\x1f]/g, "-").replace(/\s+/g, "-").slice(0, 48)
    : "chart";
  return `${safe || "chart"}-${spec.type}.html`;
}
