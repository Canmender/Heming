/**
 * 图表渲染器 —— 把 ChartSpec 变成 SVG 字符串。
 *
 * 移植自 Lieflat Charts 的视觉语法（PolyForm Noncommercial 1.0.0），
 * 但实现是重写的：上游用手写 SVG + Chart.js/ECharts 混合栈，
 * 这里统一为纯 SVG（无外部依赖、可内联、可导出、可测试）。
 *
 * 三条不可让步的规矩（来自上游规范）：
 * 1. **明度即数据** —— 最重要的系列最黑/最深，不按顺序随便拿；
 * 2. **柱状图不断轴** —— 柱的契约是长度∝数值，断轴毁契约；
 * 3. **数值与视觉严格成正比** —— 面积编码用 sqrt 换算半径，不拿数值直接当半径。
 *
 * 所有文本都经 `esc()` 转义：标题、轴标签都来自模型输出，属不可信输入。
 */

import {
  DARK,
  FONT,
  GRID,
  INK,
  LADDER,
  MOTION,
  PAPER,
  esc,
  fmtNum,
  pol,
  rnd,
  sectPath,
} from "./tokens.js";
import { pickPalette, type Palette } from "./palette.js";
import type { ChartPoint, ChartSpec } from "./spec.js";
import { findChartType } from "./catalog.js";

/** 画布尺寸：宽固定（气泡内渲染），高按图型比例。 */
export const CHART_W = 640;

export interface RenderOptions {
  /** 是否带入场动画（导出单文件时为 true，聊天气泡内为 false）。 */
  animate?: boolean;
  /** 暗卡。 */
  dark?: boolean;
}

export interface RenderedChart {
  /** SVG 字符串（不含 <svg> 外壳的部分内容已内联）。 */
  svg: string;
  /** 实际高度（viewBox 用）。 */
  height: number;
  /** 背景色（供外壳设置）。 */
  background: string;
}

/** 主入口：渲染成完整 SVG 字符串。 */
export function renderChart(spec: ChartSpec, opts: RenderOptions = {}): RenderedChart {
  const type = resolveType(spec);
  const catCount = countCategories(spec);
  const palette = pickPalette(spec.palette, catCount, spec.dark);
  const ctx: Ctx = { spec, p: palette, animate: opts.animate === true, dark: spec.dark };

  switch (type) {
    case "F1":
    case "G3":
      return renderBars(ctx);
    case "F5":
      return renderHBars(ctx);
    case "F2":
      return renderLine(ctx);
    case "F3":
      return renderArea(ctx);
    case "F4":
    case "L14":
      return renderDonut(ctx);
    case "F7":
      return renderStacked(ctx);
    case "F8":
      return renderScatter(ctx);
    case "F9":
    case "G10":
      return renderWaterfall(ctx);
    case "F10":
    case "L16":
      return renderHeat(ctx);
    case "F11":
      return renderProgress(ctx);
    case "F12":
      return renderDumbbell(ctx);
    case "F13":
      return renderTreemap(ctx);
    case "F14":
      return renderHistogram(ctx);
    case "L13":
      return renderFunnel(ctx);
    case "G21":
      return renderRankStrip(ctx);
    case "G22":
      return renderSankey(ctx);
    case "L1":
      return renderFan(ctx);
    case "L5":
      return renderRadial(ctx);
    case "L17":
      return renderCalendar(ctx);
    default:
      return renderBars(ctx);
  }
}

/** 图型 id → 实际渲染分支；未知 id 落到柱状图。 */
function resolveType(spec: ChartSpec): string {
  const id = spec.type.trim().toUpperCase();
  if (findChartType(id)) return id;
  // 别名兜底：模型选了未实现的图型时给出可画的那个
  const alias = ALIAS_MAP[id];
  return alias ?? "F1";
}

const ALIAS_MAP: Record<string, string> = {
  L2: "F5",
  L3: "F2",
  L4: "F10",
  L6: "G22",
  L7: "F12",
  L8: "F13",
  L9: "F13",
  L10: "F10",
  L11: "F2",
  L12: "F5",
  L15: "F1",
  G4: "F4",
  G5: "F1",
  G6: "G22",
  G7: "F13",
  G8: "F3",
  G9: "F8",
  G11: "G22",
  G12: "F1",
  G13: "F4",
  G14: "F10",
  G15: "F8",
  G16: "G21",
  G17: "F2",
  G18: "F11",
  G19: "F14",
  G20: "F10",
  M1: "F10",
  M2: "F10",
  B1: "G22",
  B2: "G22",
  B3: "G22",
  F6: "F12",
  F15: "F12",
  F16: "F3",
  F17: "F2",
};

interface Ctx {
  spec: ChartSpec;
  p: Palette;
  animate: boolean;
  dark: boolean;
}

/** 该规范里有多少个类目（决定配色容量与标签密度）。 */
function countCategories(spec: ChartSpec): number {
  if (spec.stacks?.length) return spec.stacks[0]?.length ?? 0;
  if (spec.cells?.length) {
    const rows = new Set(spec.cells.map((c: { row: string }) => c.row));
    return rows.size;
  }
  if (spec.pairs?.length) return spec.pairs.length * 2;
  if (spec.ranks?.length) return spec.ranks[0]?.entries.length ?? 0;
  if (spec.treemap?.length) return spec.treemap.length;
  if (spec.histogram?.length) return spec.histogram.length;
  if (spec.funnel?.length) return spec.funnel.length;
  if (spec.deltas?.length) return spec.deltas.length;
  if (spec.points?.length) {
    const series = new Set(spec.points.map((p: { series?: string }) => p.series).filter(Boolean));
    return Math.max(series.size, 1);
  }
  return 1;
}

/* ------------------------------------------------------------------ 公共件 */

/** SVG 元素构造（属性值不转义——数值与色值是内部产生的；文本走 esc）。 */
function el(tag: string, attrs: Record<string, string | number> = {}): string {
  const parts = Object.entries(attrs)
    .filter(([, v]) => v !== undefined && v !== null && v !== "")
    .map(([k, v]) => `${k}="${typeof v === "number" ? round(v) : String(v)}"`);
  return `<${tag}${parts.length ? " " + parts.join(" ") : ""}/>`;
}

/**
 * 文本节点（内容转义）。
 *
 * 不走 `el()` 的自闭合形式再 replace——那依赖属性值里不含 "/>"，
 * 标题里出现斜杠就会拼坏。文本节点单独构造，属性与内容分开处理。
 */
function text(x: number, y: number, content: string, attrs: Record<string, string | number> = {}): string {
  const parts = Object.entries({ x, y, ...attrs })
    .filter(([, v]) => v !== undefined && v !== null)
    .map(([k, v]) => `${k}="${typeof v === "number" ? round(v) : String(v)}"`);
  return `<text ${parts.join(" ")}>${esc(content)}</text>`;
}

function round(n: number): string {
  return Number.isInteger(n) ? String(n) : String(Number(n.toFixed(2)));
}

/** 轴标签。 */
function axisText(x: number, y: number, s: string, p: Palette, anchor = "middle"): string {
  return text(x, y, s, {
    "font-size": FONT.axis.size,
    "font-weight": FONT.axis.weight,
    fill: p.lab,
    "text-anchor": anchor,
    "dominant-baseline": "central",
  });
}

/**
 * 图内数值标注（800 字重）。
 *
 * y 会被钳制在画布内：标签画在数据点之上，靠近顶部时容易溢出 viewBox
 * 被裁掉（看得见的现象是最高那根柱子的数字缺一截）。
 */
function valueText(x: number, y: number, s: string, p: Palette, anchor = "middle"): string {
  const clamped = Math.max(9, y);
  return text(x, clamped, s, {
    "font-size": 10,
    "font-weight": FONT.value.weight,
    fill: p.txt,
    "text-anchor": anchor,
    "dominant-baseline": "central",
  });
}

/** 悬停提示（SVG <title>）。 */
function tip(content: string): string {
  return `<title>${esc(content)}</title>`;
}

/**
 * 柱端胶囊圆角：竖柱只圆上端。
 * 返回的是 path 的 `d` 属性值（不是完整标签）——由调用方交给 `el("path", {d})` 拼装。
 */
function barTopPath(x: number, y: number, w: number, h: number): string {
  const r = Math.min(w / 2, h, 8);
  if (h <= 0) return "";
  return `M${round(x)} ${round(y + h)} L${round(x)} ${round(y + r)} Q${round(x)} ${round(y)} ${round(x + r)} ${round(y)} L${round(x + w - r)} ${round(y)} Q${round(x + w)} ${round(y)} ${round(x + w)} ${round(y + r)} L${round(x + w)} ${round(y + h)} Z`;
}

/** 横柱胶囊圆角：只圆外端（右端）。 */
function barRightPath(x: number, y: number, w: number, h: number): string {
  const r = Math.min(h / 2, w, 8);
  if (w <= 0) return "";
  return `M${round(x)} ${round(y)} L${round(x + w - r)} ${round(y)} Q${round(x + w)} ${round(y)} ${round(x + w)} ${round(y + r)} L${round(x + w)} ${round(y + h - r)} Q${round(x + w)} ${round(y + h)} ${round(x + w - r)} ${round(y + h)} L${round(x)} ${round(y + h)} Z`;
}

/** 热力色阶取值（0–1 → 色）。 */
function rampColor(p: Palette, t: number): string {
  if (!Number.isFinite(t)) return p.ramp[0];
  const clamped = Math.max(0, Math.min(1, t));
  const idx = Math.min(p.ramp.length - 1, Math.floor(clamped * (p.ramp.length - 1) + 0.5));
  return p.ramp[idx];
}

/** 分类色（按索引取，超出则循环）。 */
function catColor(p: Palette, i: number): string {
  return p.cat[i % p.cat.length];
}

/** 动画 class（导出时用；气泡内不播）。 */
function animClass(ctx: Ctx, base: "pop" | "fade" | "draw", delayMs: number): string {
  if (!ctx.animate) return "";
  return ` class="${base}" style="animation-delay:${delayMs}ms"`;
}

/** 网格线。 */
function gridLine(x1: number, y1: number, x2: number, y2: number, p: Palette): string {
  return el("line", { x1, y1, x2, y2, stroke: p.grid, "stroke-width": 0.8 });
}

/** 卡片骨架（标题/副标题/图/来源行四件套）。 */
function cardShell(
  ctx: Ctx,
  body: string,
  chartHeight: number,
  width = CHART_W,
): { svg: string; height: number; background: string } {
  const p = ctx.p;
  const parts: string[] = [];
  let y = 0;

  if (ctx.spec.title) {
    parts.push(
      text(0, y + 12, ctx.spec.title, {
        "font-size": FONT.title.size,
        "font-weight": FONT.title.weight,
        "letter-spacing": FONT.title.spacing,
        fill: p.txt,
      }),
    );
    y += 26;
  }
  if (ctx.spec.subtitle) {
    parts.push(
      text(0, y + 8, ctx.spec.subtitle, {
        "font-size": FONT.sub.size,
        "font-weight": FONT.sub.weight,
        fill: p.mut,
      }),
    );
    y += 22;
  }
  parts.push(`<g transform="translate(0, ${y})">${body}</g>`);
  const bodyBottom = y + chartHeight;

  if (ctx.spec.source) {
    parts.push(
      text(0, bodyBottom + 16, ctx.spec.source, {
        "font-size": FONT.src.size,
        "font-weight": FONT.src.weight,
        "letter-spacing": FONT.src.spacing,
        fill: p.faint,
      }),
    );
  }
  const height = bodyBottom + (ctx.spec.source ? 30 : 8);
  return {
    svg: parts.join(""),
    height: Math.max(120, Math.ceil(height)),
    background: p.bg,
  };
}

/** 画布左右留白（轴标签要地方放）。 */
const PAD = { left: 46, right: 16, top: 14, bottom: 34 };

/** 柱顶数值标签要画在柱子之上，需要额外留出的高度。 */
const VALUE_LABEL_SPACE = 14;

/* ------------------------------------------------------------------ 图型 */

/** F1/G3 阶梯柱：少类目比较。 */
function renderBars(ctx: Ctx): RenderedChart {
  const p = ctx.p;
  const points: ChartPoint[] = ctx.spec.points ?? [];
  const n = points.length;
  const chartH = 220;
  const innerW = CHART_W - PAD.left - PAD.right;
  // 顶部留 14px 给最高柱的数值标签（标签画在柱顶之上 9px）
  const innerH = chartH - PAD.top - PAD.bottom - VALUE_LABEL_SPACE;
  const max = Math.max(1, ...points.map((d) => Math.abs(d.value)));
  const slot = innerW / Math.max(1, n);
  const barW = Math.min(46, slot * 0.56);
  const baseY = PAD.top + innerH;
  const parts: string[] = [];

  // 网格：0 与 max 两道（上游规矩：可数刻度，不要密网格）
  parts.push(gridLine(PAD.left, PAD.top, PAD.left + innerW, PAD.top, p));
  parts.push(gridLine(PAD.left, baseY, PAD.left + innerW, baseY, p));

  const seriesNames = [...new Set(points.map((d) => d.series).filter(Boolean))] as string[];
  const multi = seriesNames.length > 1;

  points.forEach((d, i) => {
    const h = (Math.abs(d.value) / max) * innerH;
    const cx = PAD.left + slot * i + slot / 2;
    const x = cx - barW / 2;
    const color = multi
      ? catColor(p, seriesNames.indexOf(d.series ?? seriesNames[0] ?? ""))
      : p.data;
    const y = baseY - h;
    parts.push(
      `<g${animClass(ctx, "fade", i * MOTION.staggerBar)}>${tip(
        `${d.label ?? ""} · ${fmtNum(d.value)}${ctx.spec.unit ?? ""}`,
      )}${el("path", { d: barTopPath(x, y, barW, h), fill: color })}</g>`,
    );
    parts.push(valueText(cx, y - 9, fmtNum(d.value), p));
    parts.push(axisText(cx, baseY + 14, d.label ?? "", p));
  });

  // 柱状图不断轴：基线必须从 0 起
  parts.push(gridLine(PAD.left, baseY, PAD.left + innerW, baseY, p));
  const shell = cardShell(ctx, parts.join(""), chartH);
  return { ...shell, svg: wrapSvg(shell.svg, shell.height, ctx.p) };
}

/** F5 横向条：排名比较，标签长。 */
function renderHBars(ctx: Ctx): RenderedChart {
  const p = ctx.p;
  const points: ChartPoint[] = ctx.spec.points ?? [];
  const n = points.length;
  const rowH = 30;
  const chartH = Math.max(120, n * rowH + PAD.top + 24);
  const labelW = 96;
  const valueW = 56;
  const innerW = CHART_W - labelW - valueW - 12;
  const max = Math.max(1, ...points.map((d) => Math.abs(d.value)));
  const parts: string[] = [];

  points.forEach((d, i) => {
    const y = PAD.top + i * rowH;
    const w = (Math.abs(d.value) / max) * innerW;
    const color = d.series ? catColor(p, i) : p.data;
    parts.push(axisText(labelW - 8, y + 9, d.label ?? "", p, "end"));
    parts.push(
      `<g${animClass(ctx, "fade", i * MOTION.staggerBar)}>${tip(
        `${d.label ?? ""} · ${fmtNum(d.value)}${ctx.spec.unit ?? ""}`,
      )}${el("path", { d: barRightPath(labelW, y, w, 16), fill: color })}</g>`,
    );
    parts.push(
      valueText(labelW + w + 8, y + 9, fmtNum(d.value), p, "start"),
    );
  });

  const shell = cardShell(ctx, parts.join(""), chartH);
  return { ...shell, svg: wrapSvg(shell.svg, shell.height, ctx.p) };
}

/** F2 折线：带时间的连续序列。 */
function renderLine(ctx: Ctx): RenderedChart {
  const p = ctx.p;
  const points: ChartPoint[] = ctx.spec.points ?? [];
  const chartH = 220;
  const innerW = CHART_W - PAD.left - PAD.right;
  const innerH = chartH - PAD.top - PAD.bottom;
  const baseY = PAD.top + innerH;
  const max = Math.max(1, ...points.map((d) => Math.abs(d.value)));
  const min = Math.min(0, ...points.map((d) => d.value));
  const range = max - min || 1;
  const x = (i: number) => PAD.left + (points.length <= 1 ? innerW / 2 : (innerW * i) / (points.length - 1));
  const y = (v: number) => baseY - ((v - min) / range) * innerH;
  const parts: string[] = [];

  parts.push(gridLine(PAD.left, PAD.top, PAD.left + innerW, PAD.top, p));
  parts.push(gridLine(PAD.left, baseY, PAD.left + innerW, baseY, p));

  // 折线：发丝线，不用渐变
  if (points.length > 1) {
    const d = points.map((pt, i) => `${i === 0 ? "M" : "L"}${round(x(i))} ${round(y(pt.value))}`).join(" ");
    parts.push(el("path", { d, fill: "none", stroke: p.data, "stroke-width": 1.6, "stroke-linejoin": "round", "stroke-linecap": "round" }));
  }
  points.forEach((pt, i) => {
    parts.push(
      `<g${animClass(ctx, "pop", i * MOTION.staggerDot)}>${tip(
        `${pt.label ?? ""} · ${fmtNum(pt.value)}${ctx.spec.unit ?? ""}`,
      )}${el("circle", { cx: x(i), cy: y(pt.value), r: 3, fill: p.data })}</g>`,
    );
  });
  // 端点标值（只标首尾与极值，避免糊成一片）
  points.forEach((pt, i) => {
    if (i === 0 || i === points.length - 1) {
      parts.push(valueText(x(i), y(pt.value) - 12, fmtNum(pt.value), p));
    }
  });
  // 轴标签：最多 6 个，多了抽稀
  const step = Math.max(1, Math.ceil(points.length / 6));
  points.forEach((pt, i) => {
    if (i % step === 0 || i === points.length - 1) {
      // 首尾标签靠边时改用 start/end 对齐，居中会让一半溢出画布
      const anchor = i === 0 ? "start" : i === points.length - 1 ? "end" : "middle";
      parts.push(axisText(x(i), baseY + 14, pt.label ?? "", p, anchor));
    }
  });

  const shell = cardShell(ctx, parts.join(""), chartH);
  return { ...shell, svg: wrapSvg(shell.svg, shell.height, ctx.p) };
}

/** F3 面积：连续序列看总量与形态。 */
function renderArea(ctx: Ctx): RenderedChart {
  const p = ctx.p;
  const points: ChartPoint[] = ctx.spec.points ?? [];
  const chartH = 220;
  const innerW = CHART_W - PAD.left - PAD.right;
  const innerH = chartH - PAD.top - PAD.bottom;
  const baseY = PAD.top + innerH;
  const max = Math.max(1, ...points.map((d) => Math.abs(d.value)));
  const x = (i: number) => PAD.left + (points.length <= 1 ? innerW / 2 : (innerW * i) / (points.length - 1));
  const y = (v: number) => baseY - (Math.abs(v) / max) * innerH;
  const parts: string[] = [];

  parts.push(gridLine(PAD.left, PAD.top, PAD.left + innerW, PAD.top, p));
  if (points.length > 1) {
    const line = points.map((pt, i) => `${i === 0 ? "M" : "L"}${round(x(i))} ${round(y(pt.value))}`).join(" ");
    const area = `${line} L${round(x(points.length - 1))} ${round(baseY)} L${round(x(0))} ${round(baseY)} Z`;
    parts.push(el("path", { d: area, fill: p.data, opacity: 0.16 }));
    parts.push(el("path", { d: line, fill: "none", stroke: p.data, "stroke-width": 1.6, "stroke-linejoin": "round" }));
  }
  points.forEach((pt, i) => {
    parts.push(
      `<g${animClass(ctx, "pop", i * MOTION.staggerDot)}>${tip(
        `${pt.label ?? ""} · ${fmtNum(pt.value)}${ctx.spec.unit ?? ""}`,
      )}${el("circle", { cx: x(i), cy: y(pt.value), r: 2.6, fill: p.data })}</g>`,
    );
  });
  const step = Math.max(1, Math.ceil(points.length / 6));
  points.forEach((pt, i) => {
    if (i % step === 0 || i === points.length - 1) {
      // 首尾标签靠边时改用 start/end 对齐，居中会让一半溢出画布
      const anchor = i === 0 ? "start" : i === points.length - 1 ? "end" : "middle";
      parts.push(axisText(x(i), baseY + 14, pt.label ?? "", p, anchor));
    }
  });
  parts.push(gridLine(PAD.left, baseY, PAD.left + innerW, baseY, p));

  const shell = cardShell(ctx, parts.join(""), chartH);
  return { ...shell, svg: wrapSvg(shell.svg, shell.height, ctx.p) };
}

/**
 * 图例：按行分组、每行整体居中。
 *
 * 固定列宽会让不满的一行孤零零贴在左边（如 4 项分 3 列时的第二行），
 * 视觉上不平衡。所以按每项的实际文字宽度排布，整行居中。
 *
 * @param items 图例项（label + color）
 * @param top 图例第一行的 y 坐标
 * @param perRow 每行最多几项
 * @returns 渲染好的 SVG 片段与占用的行数
 */
function legendBlock(
  items: { label: string; color: string }[],
  top: number,
  p: Palette,
  perRow = 3,
): { svg: string; rows: number } {
  if (items.length === 0) return { svg: "", rows: 0 };
  const cols = Math.max(1, Math.min(perRow, items.length));
  const rows: { label: string; color: string }[][] = [];
  items.forEach((it, i) => {
    const row = Math.floor(i / cols);
    (rows[row] ??= []).push(it);
  });
  const parts: string[] = [];
  rows.forEach((row, ri) => {
    const ly = top + ri * 18;
    // 每项宽度按文字长度估：中文按 10px/字，数字与符号按 5.4px/字符
    const widths = row.map((it) => 22 + it.label.length * 10);
    const rowWidth = widths.reduce((a, b) => a + b, 0);
    let lx = Math.max(PAD.left, (CHART_W - rowWidth) / 2);
    row.forEach((it, i) => {
      parts.push(el("rect", { x: lx, y: ly - 4, width: 8, height: 8, fill: it.color }));
      parts.push(
        text(lx + 13, ly, it.label, {
          "font-size": FONT.axis.size,
          fill: p.lab,
          "dominant-baseline": "central",
        }),
      );
      lx += widths[i];
    });
  });
  return { svg: parts.join(""), rows: rows.length };
}

/** F4/L14 环形构成：100% 构成，≤6 段。 */
function renderDonut(ctx: Ctx): RenderedChart {
  const p = ctx.p;
  const points: ChartPoint[] = ctx.spec.points ?? [];
  const chartH = 240;
  const cx = CHART_W / 2;
  const cy = PAD.top + chartH / 2 - 10;
  const r1 = 92;
  const r0 = 56;
  const total = points.reduce((s, d) => s + Math.abs(d.value), 0) || 1;
  const parts: string[] = [];
  let angle = -90;

  points.forEach((d, i) => {
    const span = (Math.abs(d.value) / total) * 360;
    const color = catColor(p, i);
    parts.push(
      `<g${animClass(ctx, "fade", i * MOTION.staggerDot)}>${tip(
        `${d.label ?? ""} · ${fmtNum(d.value)} (${Math.round((Math.abs(d.value) / total) * 100)}%)`,
      )}${el("path", { d: sectPath(cx, cy, r0, r1, angle, angle + span), fill: color })}</g>`,
    );
    angle += span;
  });

  // 中心大数字（上游 Glance 系的标志手法）
  const top = [...points].sort((a, b) => Math.abs(b.value) - Math.abs(a.value))[0];
  if (top) {
    parts.push(
      valueText(cx, cy - 4, fmtNum(Math.abs(top.value)), p),
    );
    parts.push(
      text(cx, cy + 14, top.label ?? "", {
        "font-size": FONT.sub.size,
        fill: p.mut,
        "text-anchor": "middle",
        "dominant-baseline": "central",
      }),
    );
  }

  // 图例：按行分组、每行整体居中（共用实现）。
  const legend = legendBlock(
    points.map((d, i) => ({
      label: `${d.label ?? ""} ${fmtNum(d.value)}`,
      color: catColor(p, i),
    })),
    PAD.top + chartH - 8,
    p,
  );
  parts.push(legend.svg);
  // 图例占了多少行，卡片就要相应加高（来源行在图例之下）
  const shell = cardShell(ctx, parts.join(""), chartH + (legend.rows - 1) * 18 + 12);
  return { ...shell, svg: wrapSvg(shell.svg, shell.height, ctx.p) };
}

/** F7 堆叠柱：构成随时间变化。 */
function renderStacked(ctx: Ctx): RenderedChart {
  const p = ctx.p;
  const stacks: { label: string; value: number }[][] = ctx.spec.stacks ?? [];
  const chartH = 230;
  const innerW = CHART_W - PAD.left - PAD.right;
  const innerH = chartH - PAD.top - PAD.bottom;
  const baseY = PAD.top + innerH;
  const slot = innerW / Math.max(1, stacks.length);
  const barW = Math.min(40, slot * 0.5);
  const totals = stacks.map((s) => s.reduce((a, b) => a + Math.abs(b.value), 0));
  const max = Math.max(1, ...totals);
  const parts: string[] = [];

  parts.push(gridLine(PAD.left, PAD.top, PAD.left + innerW, PAD.top, p));
  parts.push(gridLine(PAD.left, baseY, PAD.left + innerW, baseY, p));

  stacks.forEach((stack, i) => {
    const cx = PAD.left + slot * i + slot / 2;
    const x = cx - barW / 2;
    let cursor = baseY;
    stack.forEach((seg, j) => {
      const h = (Math.abs(seg.value) / max) * innerH;
      const y = cursor - h;
      const color = catColor(p, j);
      parts.push(
        `<g${animClass(ctx, "fade", i * MOTION.staggerBar + j * 20)}>${tip(
          `${seg.label} · ${fmtNum(seg.value)}${ctx.spec.unit ?? ""}`,
        )}${el("rect", { x, y, width: barW, height: h, fill: color })}</g>`,
      );
      cursor = y;
    });
    parts.push(valueText(cx, cursor - 9, fmtNum(totals[i]), p));
    parts.push(axisText(cx, baseY + 14, stack[0]?.label ?? "", p));
  });

  // 图例（共用实现：按行分组、整行居中）
  const segNames = stacks[0]?.map((s) => s.label) ?? [];
  const legend = legendBlock(
    segNames.map((name, j) => ({ label: name, color: catColor(p, j) })),
    PAD.top + chartH - 4,
    p,
  );
  parts.push(legend.svg);

  const shell = cardShell(ctx, parts.join(""), chartH + (legend.rows - 1) * 18 + 8);
  return { ...shell, svg: wrapSvg(shell.svg, shell.height, ctx.p) };
}

/** F8 散点：两个连续维度的关系。 */
function renderScatter(ctx: Ctx): RenderedChart {
  const p = ctx.p;
  const points: ChartPoint[] = ctx.spec.points ?? [];
  const chartH = 230;
  const innerW = CHART_W - PAD.left - PAD.right;
  const innerH = chartH - PAD.top - PAD.bottom;
  const baseY = PAD.top + innerH;
  const xs = points.map((d) => d.x ?? 0);
  const ys = points.map((d) => d.value);
  const maxX = Math.max(1, ...xs);
  const maxY = Math.max(1, ...ys.map(Math.abs));
  const seriesNames = [...new Set(points.map((d) => d.series).filter(Boolean))] as string[];
  const parts: string[] = [];

  parts.push(gridLine(PAD.left, PAD.top, PAD.left + innerW, PAD.top, p));
  parts.push(gridLine(PAD.left, baseY, PAD.left + innerW, baseY, p));

  points.forEach((d, i) => {
    const cx = PAD.left + ((d.x ?? 0) / maxX) * innerW;
    const cy = baseY - (Math.abs(d.value) / maxY) * innerH;
    const color = d.series ? catColor(p, seriesNames.indexOf(d.series)) : p.data;
    parts.push(
      `<g${animClass(ctx, "pop", i * 12)}>${tip(
        `${d.label ?? ""} · (${d.x ?? 0}, ${fmtNum(d.value)})`,
      )}${el("circle", { cx, cy, r: 4.5, fill: color, opacity: 0.88 })}</g>`,
    );
  });

  // 坐标轴端标
  parts.push(axisText(PAD.left, baseY + 14, "0", p, "start"));
  parts.push(axisText(PAD.left + innerW, baseY + 14, fmtNum(maxX), p, "end"));
  parts.push(axisText(PAD.left - 8, PAD.top, fmtNum(maxY), p, "end"));
  parts.push(axisText(PAD.left - 8, baseY, "0", p, "end"));

  const shell = cardShell(ctx, parts.join(""), chartH);
  return { ...shell, svg: wrapSvg(shell.svg, shell.height, ctx.p) };
}

/** F9/G10 瀑布与正负条：增减分解。 */
function renderWaterfall(ctx: Ctx): RenderedChart {
  const p = ctx.p;
  const deltas: { label: string; value: number }[] = ctx.spec.deltas ?? [];
  const chartH = 220;
  const innerW = CHART_W - PAD.left - PAD.right;
  const innerH = chartH - PAD.top - PAD.bottom;
  const baseY = PAD.top + innerH;
  const slot = innerW / Math.max(1, deltas.length);
  const barW = Math.min(44, slot * 0.56);
  // 累计基线
  let acc = 0;
  const bars = deltas.map((d) => {
    const start = acc;
    acc += d.value;
    return { ...d, start, end: acc };
  });
  const all = bars.flatMap((b) => [b.start, b.end, 0]);
  const max = Math.max(1, ...all);
  const min = Math.min(0, ...all);
  const range = max - min || 1;
  const y = (v: number) => baseY - ((v - min) / range) * innerH;
  const parts: string[] = [];

  // 零轴
  const zeroY = y(0);
  parts.push(el("line", { x1: PAD.left, y1: zeroY, x2: PAD.left + innerW, y2: zeroY, stroke: p.grid, "stroke-width": 0.8 }));

  bars.forEach((b, i) => {
    const cx = PAD.left + slot * i + slot / 2;
    const x = cx - barW / 2;
    const yTop = Math.min(y(b.start), y(b.end));
    const h = Math.abs(y(b.end) - y(b.start));
    const positive = b.value >= 0;
    // 正负用明度区分，不用红绿（配色只一套，语义靠明度）
    const color = positive ? p.data : p.data2;
    parts.push(
      `<g${animClass(ctx, "fade", i * MOTION.staggerBar)}>${tip(
        `${b.label} · ${positive ? "+" : ""}${fmtNum(b.value)}${ctx.spec.unit ?? ""}`,
      )}${el("path", { d: barTopPath(x, yTop, barW, h), fill: color })}</g>`,
    );
    parts.push(
      valueText(cx, yTop - 9, `${positive ? "+" : ""}${fmtNum(b.value)}`, p),
    );
    // 连接线（瀑布的关键：上一根的顶接到下一根的起点）
    if (i < bars.length - 1) {
      const nextCx = PAD.left + slot * (i + 1) + slot / 2;
      parts.push(
        el("line", {
          x1: cx + barW / 2,
          y1: y(b.end),
          x2: nextCx - barW / 2,
          y2: y(b.end),
          stroke: p.faint,
          "stroke-width": 0.8,
          "stroke-dasharray": "2 2",
        }),
      );
    }
    parts.push(axisText(cx, baseY + 14, b.label ?? "", p));
  });

  const shell = cardShell(ctx, parts.join(""), chartH);
  return { ...shell, svg: wrapSvg(shell.svg, shell.height, ctx.p) };
}

/** F10/L16 点阵热力与矩阵热力。 */
function renderHeat(ctx: Ctx): RenderedChart {
  const p = ctx.p;
  const cells: { row: string; col: string; value: number }[] = ctx.spec.cells ?? [];
  const rows = [...new Set(cells.map((c) => c.row))];
  const cols = [...new Set(cells.map((c) => c.col))];
  const chartH = Math.max(140, rows.length * 26 + PAD.top + 34);
  const labelW = 76;
  const labelH = 18;
  const gridW = CHART_W - labelW - 16;
  const gridH = rows.length * 26;
  const cellW = gridW / Math.max(1, cols.length);
  const cellH = gridH / Math.max(1, rows.length);
  const max = Math.max(1, ...cells.map((c) => Math.abs(c.value)));
  const parts: string[] = [];

  rows.forEach((row, ri) => {
    parts.push(axisText(labelW - 8, PAD.top + ri * cellH + cellH / 2, row, p, "end"));
    cols.forEach((col, ci) => {
      const cell = cells.find((c) => c.row === row && c.col === col);
      if (!cell) return;
      const t = Math.abs(cell.value) / max;
      const x = labelW + ci * cellW;
      const y = PAD.top + ri * cellH;
      parts.push(
        `<g${animClass(ctx, "fade", ri * 40 + ci * 12)}>${tip(
          `${row} · ${col} · ${fmtNum(cell.value)}${ctx.spec.unit ?? ""}`,
        )}${el("rect", {
          x: x + 1,
          y: y + 1,
          width: Math.max(1, cellW - 2),
          height: Math.max(1, cellH - 2),
          rx: 2,
          fill: rampColor(p, t),
        })}</g>`,
      );
    });
  });

  // 列标签（横排在下方）
  const colStep = Math.max(1, Math.ceil(cols.length / 8));
  cols.forEach((col, ci) => {
    if (ci % colStep === 0) {
      parts.push(
        axisText(labelW + ci * cellW + cellW / 2, PAD.top + gridH + labelH - 4, col, p),
      );
    }
  });

  const shell = cardShell(ctx, parts.join(""), chartH);
  return { ...shell, svg: wrapSvg(shell.svg, shell.height, ctx.p) };
}

/** F11 进度：单值完成度。 */
function renderProgress(ctx: Ctx): RenderedChart {
  const p = ctx.p;
  const prog = ctx.spec.progress ?? { value: 0, max: 100 };
  const chartH = 120;
  const trackW = CHART_W - 40;
  const t = Math.max(0, Math.min(1, prog.value / prog.max));
  const parts: string[] = [];

  parts.push(
    el("rect", { x: 20, y: PAD.top + 30, width: trackW, height: 26, rx: 13, fill: p.grid }),
  );
  parts.push(
    `<g${animClass(ctx, "draw", 0)}>${tip(`${fmtNum(prog.value)} / ${fmtNum(prog.max)}`)}${el(
      "rect",
      { x: 20, y: PAD.top + 30, width: Math.max(2, trackW * t), height: 26, rx: 13, fill: p.data },
    )}</g>`,
  );
  parts.push(
    valueText(20 + trackW * t / 2, PAD.top + 43, `${Math.round(t * 100)}%`, {
      ...p,
      txt: p.bg,
    }),
  );
  parts.push(
    text(20, PAD.top + 16, `${fmtNum(prog.value)} / ${fmtNum(prog.max)}${ctx.spec.unit ?? ""}`, {
      "font-size": FONT.sub.size,
      fill: p.mut,
    }),
  );

  const shell = cardShell(ctx, parts.join(""), chartH);
  return { ...shell, svg: wrapSvg(shell.svg, shell.height, ctx.p) };
}

/** F12 哑铃：类目级前后对比。 */
function renderDumbbell(ctx: Ctx): RenderedChart {
  const p = ctx.p;
  const pairs: { label: string; before: number; after: number }[] = ctx.spec.pairs ?? [];
  const rowH = 34;
  const chartH = Math.max(120, pairs.length * rowH + PAD.top + 20);
  const labelW = 96;
  const valueW = 60;
  const innerW = CHART_W - labelW - valueW - 12;
  const all = pairs.flatMap((x) => [x.before, x.after]);
  const min = Math.min(0, ...all);
  const max = Math.max(1, ...all);
  const range = max - min || 1;
  const x = (v: number) => labelW + ((v - min) / range) * innerW;
  const parts: string[] = [];

  pairs.forEach((pair, i) => {
    const y = PAD.top + i * rowH + 12;
    const x1 = x(pair.before);
    const x2 = x(pair.after);
    parts.push(axisText(labelW - 8, y, pair.label ?? "", p, "end"));
    parts.push(
      el("line", { x1: Math.min(x1, x2), y1: y, x2: Math.max(x1, x2), y2: y, stroke: p.data, "stroke-width": 1.4, opacity: 0.4 }),
    );
    parts.push(
      `<g${animClass(ctx, "pop", i * 60)}>${tip(`前 ${fmtNum(pair.before)} → 后 ${fmtNum(pair.after)}`)}${el(
        "circle",
        { cx: x1, cy: y, r: 4, fill: "none", stroke: p.data2, "stroke-width": 1.6 },
      )}</g>`,
    );
    parts.push(
      `<g${animClass(ctx, "pop", i * 60 + 40)}>${tip(`前 ${fmtNum(pair.before)} → 后 ${fmtNum(pair.after)}`)}${el(
        "circle",
        { cx: x2, cy: y, r: 5, fill: p.data },
      )}</g>`,
    );
    parts.push(
      valueText(Math.max(x1, x2) + 10, y, fmtNum(pair.after), p, "start"),
    );
  });

  // 图例：空心=前，实心=后
  const ly = PAD.top + chartH - 12;
  parts.push(el("circle", { cx: 44, cy: ly, r: 4, fill: "none", stroke: p.data2, "stroke-width": 1.6 }));
  parts.push(text(53, ly, "之前", { "font-size": FONT.axis.size, fill: p.lab, "dominant-baseline": "central" }));
  parts.push(el("circle", { cx: 96, cy: ly, r: 5, fill: p.data }));
  parts.push(text(106, ly, "之后", { "font-size": FONT.axis.size, fill: p.lab, "dominant-baseline": "central" }));

  const shell = cardShell(ctx, parts.join(""), chartH);
  return { ...shell, svg: wrapSvg(shell.svg, shell.height, ctx.p) };
}

/**
 * F13 矩形树图：层级构成，面积=数值。
 *
 * 布局用「条带法」而非完整 squarified：把条目按值降序，
 * 每条独占一条横带，带高按其值占比分配——面积严格正比于数值，
 * 且不需要复杂的递归切分。代价是长条形（每条都通栏），
 * 但对"占比构成"这个主要用途已经足够清楚。
 */
function renderTreemap(ctx: Ctx): RenderedChart {
  const p = ctx.p;
  const items: { label: string; value: number; group?: string }[] = ctx.spec.treemap ?? [];
  const sorted = [...items]
    .filter((d) => d.value > 0)
    .sort((a, b) => b.value - a.value);
  const total = sorted.reduce((s, d) => s + d.value, 0);
  const W = CHART_W;
  const parts: string[] = [];

  if (total <= 0) {
    const shell = cardShell(ctx, `<text x="0" y="20" font-size="12" fill="${p.mut}">没有可展示的正值数据</text>`, 40);
    return { ...shell, svg: wrapSvg(shell.svg, shell.height, ctx.p) };
  }

  const H = Math.max(80, Math.min(360, sorted.length * 34));
  const groupNames = [...new Set(sorted.map((d) => d.group).filter(Boolean))] as string[];

  let cursorY = PAD.top;
  sorted.forEach((it, i) => {
    const h = (it.value / total) * H;
    const color = it.group
      ? catColor(p, groupNames.indexOf(it.group))
      : rampColor(p, 1 - i / Math.max(1, sorted.length - 1));
    parts.push(
      `<g${animClass(ctx, "fade", i * 40)}>${tip(
        `${it.label} · ${fmtNum(it.value)}${ctx.spec.unit ?? ""}${
          it.group ? ` · ${it.group}` : ""
        }`)}${el("rect", {
        x: 0,
        y: cursorY,
        width: W,
        height: Math.max(2, h - 2),
        rx: 3,
        fill: color,
      })}</g>`,
    );
    // 带够高才写标签，否则留给悬停提示
    if (h >= 18) {
      parts.push(
        text(10, cursorY + h / 2, it.label, {
          "font-size": 10,
          "font-weight": 600,
          fill: p.bg,
          "dominant-baseline": "central",
        }),
      );
      parts.push(
        text(W - 10, cursorY + h / 2, `${fmtNum(it.value)}（${Math.round((it.value / total) * 100)}%）`, {
          "font-size": 9.5,
          fill: p.bg,
          "text-anchor": "end",
          "dominant-baseline": "central",
          opacity: 0.85,
        }),
      );
    }
    cursorY += h;
  });

  // 图例（仅当有分组时；共用实现）
  if (groupNames.length > 1) {
    const legend = legendBlock(
      groupNames.map((name, i) => ({ label: name, color: catColor(p, i) })),
      cursorY + 16,
      p,
    );
    parts.push(legend.svg);
    cursorY += 16 + (legend.rows - 1) * 18 + 6;
  }

  const shell = cardShell(ctx, parts.join(""), cursorY - PAD.top);
  return { ...shell, svg: wrapSvg(shell.svg, shell.height, ctx.p) };
}

/** F14 直方图：单变量分箱频数。 */
function renderHistogram(ctx: Ctx): RenderedChart {
  const p = ctx.p;
  const bins: { label: string; count: number }[] = ctx.spec.histogram ?? [];
  const chartH = 200;
  const innerW = CHART_W - PAD.left - PAD.right;
  const innerH = chartH - PAD.top - PAD.bottom;
  const baseY = PAD.top + innerH;
  const max = Math.max(1, ...bins.map((b) => b.count));
  const slot = innerW / Math.max(1, bins.length);
  const barW = Math.max(2, slot - 6);
  const parts: string[] = [];

  parts.push(gridLine(PAD.left, PAD.top, PAD.left + innerW, PAD.top, p));
  parts.push(gridLine(PAD.left, baseY, PAD.left + innerW, baseY, p));

  bins.forEach((b, i) => {
    const h = (b.count / max) * innerH;
    const x = PAD.left + slot * i + (slot - barW) / 2;
    const y = baseY - h;
    parts.push(
      `<g${animClass(ctx, "fade", i * 40)}>${tip(
        `${b.label} · ${fmtNum(b.count)}`,
      )}${el("path", { d: barTopPath(x, y, barW, h), fill: p.data })}</g>`,
    );
    if (b.count > 0) parts.push(valueText(x + barW / 2, y - 8, fmtNum(b.count), p));
    parts.push(axisText(x + barW / 2, baseY + 14, b.label ?? "", p));
  });

  const shell = cardShell(ctx, parts.join(""), chartH);
  return { ...shell, svg: wrapSvg(shell.svg, shell.height, ctx.p) };
}

/** L13 漏斗：分阶段递减。 */
function renderFunnel(ctx: Ctx): RenderedChart {
  const p = ctx.p;
  const steps: { label: string; value: number }[] = ctx.spec.funnel ?? [];
  const chartH = Math.max(160, steps.length * 38 + PAD.top + 20);
  const max = Math.max(1, ...steps.map((s) => s.value));
  const W = CHART_W - 80;
  const parts: string[] = [];

  steps.forEach((s, i) => {
    const y = PAD.top + i * 38;
    const w = (s.value / max) * W;
    const nextW = steps[i + 1] ? (steps[i + 1].value / max) * W : w;
    const color = rampColor(p, 1 - i / Math.max(1, steps.length - 1));
    // 梯形：上宽下窄
    const d = `M40 ${round(y)} L${round(40 + w)} ${round(y)} L${round(40 + nextW)} ${round(y + 30)} L40 ${round(y + 30)} Z`;
    parts.push(
      `<g${animClass(ctx, "fade", i * 60)}>${tip(
        `${s.label} · ${fmtNum(s.value)}${ctx.spec.unit ?? ""}`,
      )}${el("path", { d, fill: color })}</g>`,
    );
    parts.push(
      text(48, y + 15, s.label, {
        "font-size": 10.5,
        "font-weight": 600,
        fill: p.bg,
        "dominant-baseline": "central",
      }),
    );
    parts.push(
      valueText(40 + Math.min(w, nextW) - 8, y + 15, fmtNum(s.value), {
        ...p,
        txt: p.bg,
      }, "end"),
    );
    if (i < steps.length - 1) {
      const rate = steps[i + 1].value / (s.value || 1);
      parts.push(
        text(CHART_W - 12, y + 15, `${Math.round(rate * 100)}%`, {
          "font-size": FONT.axis.size,
          fill: p.mut,
          "text-anchor": "end",
          "dominant-baseline": "central",
        }),
      );
    }
  });

  const shell = cardShell(ctx, parts.join(""), chartH);
  return { ...shell, svg: wrapSvg(shell.svg, shell.height, ctx.p) };
}

/** G21 排名带：排名随时间变化。 */
function renderRankStrip(ctx: Ctx): RenderedChart {
  const p = ctx.p;
  const frames: { time: string; entries: { label: string; rank: number }[] }[] = ctx.spec.ranks ?? [];
  const chartH = 240;
  const names = [...new Set(frames.flatMap((f) => f.entries.map((e) => e.label)))];
  const maxRank = Math.max(1, ...frames.flatMap((f) => f.entries.map((e) => e.rank)));
  const rowH = 22;
  const parts: string[] = [];
  const colW = (CHART_W - 120) / Math.max(1, frames.length);

  frames.forEach((frame, fi) => {
    const x = 110 + colW * fi;
    parts.push(
      axisText(x + colW / 2, PAD.top - 6, frame.time, p),
    );
    frame.entries.forEach((entry) => {
      const y = PAD.top + (entry.rank - 1) * rowH + rowH / 2;
      const color = catColor(p, names.indexOf(entry.label));
      parts.push(
        `<g${animClass(ctx, "fade", fi * 40 + entry.rank * 10)}>${tip(
          `${frame.time} · ${entry.label} 第 ${entry.rank} 名`,
        )}${el("rect", { x, y: y - 7, width: Math.max(6, colW - 4), height: 14, rx: 7, fill: color })}</g>`,
      );
      parts.push(
        text(x - 8, y, entry.label, {
          "font-size": 9.5,
          fill: p.lab,
          "text-anchor": "end",
          "dominant-baseline": "central",
        }),
      );
    });
  });

  const shell = cardShell(ctx, parts.join(""), chartH);
  return { ...shell, svg: wrapSvg(shell.svg, shell.height, ctx.p) };
}

/** G22 聚合流向：两端聚合流量。 */
function renderSankey(ctx: Ctx): RenderedChart {
  const p = ctx.p;
  const stacks: { label: string; value: number }[][] = ctx.spec.stacks ?? [];
  const chartH = 240;
  const lefts = [...new Set(stacks.map((s) => s[0]?.label ?? ""))];
  const rights = [...new Set(stacks.flatMap((s) => s.slice(1).map((x) => x.label)))];
  const leftTotal = new Map<string, number>();
  const rightTotal = new Map<string, number>();
  stacks.forEach((s) => {
    const l = s[0]?.label ?? "";
    const lv = Math.abs(s[0]?.value ?? 0);
    leftTotal.set(l, (leftTotal.get(l) ?? 0) + lv);
    s.slice(1).forEach((seg) => {
      rightTotal.set(seg.label, (rightTotal.get(seg.label) ?? 0) + Math.abs(seg.value));
    });
  });
  const lMax = Math.max(1, ...leftTotal.values());
  const rMax = Math.max(1, ...rightTotal.values());
  const lH = chartH - 60;
  const parts: string[] = [];

  // 左节点
  let lY = PAD.top + 10;
  for (const name of lefts) {
    const h = ((leftTotal.get(name) ?? 0) / lMax) * lH;
    parts.push(el("rect", { x: 90, y: lY, width: 12, height: Math.max(3, h), rx: 3, fill: p.data }));
    parts.push(
      text(84, lY + h / 2, name, {
        "font-size": FONT.axis.size,
        fill: p.lab,
        "text-anchor": "end",
        "dominant-baseline": "central",
      }),
    );
    lY += h + 12;
  }

  // 右节点
  let rY = PAD.top + 10;
  for (const name of rights) {
    const h = ((rightTotal.get(name) ?? 0) / rMax) * lH;
    parts.push(el("rect", { x: CHART_W - 102, y: rY, width: 12, height: Math.max(3, h), rx: 3, fill: p.data2 }));
    parts.push(
      text(CHART_W - 108, rY + h / 2, name, {
        "font-size": FONT.axis.size,
        fill: p.lab,
        "dominant-baseline": "central",
      }),
    );
    rY += h + 12;
  }

  // 流带（贝塞尔）
  const midX = CHART_W / 2;
  let flowY = PAD.top + 10;
  stacks.forEach((s) => {
    const l = s[0]?.label ?? "";
    const lv = Math.abs(s[0]?.value ?? 0);
    const lh = (lv / lMax) * lH;
    s.slice(1).forEach((seg) => {
      const sv = Math.abs(seg.value);
      const sh = (sv / lMax) * lH;
      const x1 = 102;
      const x2 = CHART_W - 102;
      const d = `M${x1} ${round(flowY)} C${round(midX)} ${round(flowY)} ${round(midX)} ${round(flowY)} ${x2} ${round(flowY)} L${x2} ${round(flowY + sh)} C${round(midX)} ${round(flowY + sh)} ${round(midX)} ${round(flowY + sh)} ${x1} ${round(flowY + sh)} Z`;
      parts.push(
        `<g${animClass(ctx, "fade", 40)}>${tip(
          `${l} → ${seg.label} · ${fmtNum(seg.value)}`,
        )}${el("path", { d, fill: p.data, opacity: 0.18 })}</g>`,
      );
      flowY += sh;
    });
    void lh;
  });

  const shell = cardShell(ctx, parts.join(""), chartH);
  return { ...shell, svg: wrapSvg(shell.svg, shell.height, ctx.p) };
}

/** L1 放射扇：多实体各带时间 + 当前规模。 */
function renderFan(ctx: Ctx): RenderedChart {
  const p = ctx.p;
  const points: ChartPoint[] = ctx.spec.points ?? [];
  const chartH = 250;
  const cx = CHART_W / 2;
  const cy = PAD.top + chartH / 2 + 6;
  const max = Math.max(1, ...points.map((d) => Math.abs(d.value)));
  const rMax = 108;
  const parts: string[] = [];
  const n = points.length;

  parts.push(el("circle", { cx, cy, r: rMax, fill: "none", stroke: p.grid, "stroke-width": 0.8 }));
  parts.push(el("circle", { cx, cy, r: rMax * 0.6, fill: "none", stroke: p.grid, "stroke-width": 0.6 }));
  parts.push(el("circle", { cx, cy, r: rMax * 0.3, fill: "none", stroke: p.grid, "stroke-width": 0.6 }));

  points.forEach((d, i) => {
    const angle = n <= 1 ? 0 : (360 / n) * i;
    const [ex, ey] = pol(cx, cy, rMax, angle);
    const [ix, iy] = pol(cx, cy, rMax * 0.28, angle);
    parts.push(
      el("line", { x1: ix, y1: iy, x2: ex, y2: ey, stroke: p.grid, "stroke-width": 0.8 }),
    );
    // 端点大小按当前规模（面积编码用 sqrt，直径∝sqrt(值)）
    const t = Math.abs(d.value) / max;
    const r = 4 + Math.sqrt(t) * 11;
    const [px, py] = pol(cx, cy, rMax, angle);
    const color = catColor(p, i);
    parts.push(
      `<g${animClass(ctx, "pop", i * 60)}>${tip(
        `${d.label ?? ""} · ${fmtNum(d.value)}${ctx.spec.unit ?? ""}`,
      )}${el("circle", { cx: px, cy: py, r, fill: color, opacity: 0.9 })}</g>`,
    );
    const [lx, ly] = pol(cx, cy, rMax + 22, angle);
    parts.push(
      text(lx, ly, d.label ?? "", {
        "font-size": 9.5,
        fill: p.lab,
        "text-anchor": Math.abs(lx - cx) < 12 ? "middle" : lx > cx ? "start" : "end",
        "dominant-baseline": "central",
      }),
    );
  });

  const shell = cardShell(ctx, parts.join(""), chartH);
  return { ...shell, svg: wrapSvg(shell.svg, shell.height, ctx.p) };
}

/** L5 径向汇聚：多对一归属，不丢明细。 */
function renderRadial(ctx: Ctx): RenderedChart {
  const p = ctx.p;
  const points: ChartPoint[] = ctx.spec.points ?? [];
  const chartH = 250;
  const cx = CHART_W / 2;
  const cy = PAD.top + chartH / 2 + 6;
  const max = Math.max(1, ...points.map((d) => Math.abs(d.value)));
  const parts: string[] = [];

  points.forEach((d, i) => {
    const t = Math.abs(d.value) / max;
    const r = 20 + Math.sqrt(t) * 96;
    const [px, py] = pol(cx, cy, r, -90 + i * 12);
    const color = catColor(p, i);
    parts.push(
      `<g${animClass(ctx, "pop", i * 50)}>${tip(
        `${d.label ?? ""} · ${fmtNum(d.value)}${ctx.spec.unit ?? ""}`,
      )}${el("circle", { cx: px, cy: py, r: 7, fill: color, opacity: 0.85 })}</g>`,
    );
    const [lx, ly] = pol(cx, cy, r + 18, -90 + i * 12);
    parts.push(
      text(lx, ly, d.label ?? "", {
        "font-size": 9.5,
        fill: p.lab,
        "dominant-baseline": "central",
      }),
    );
  });

  parts.push(el("circle", { cx, cy, r: 14, fill: p.data, opacity: 0.9 }));
  parts.push(
    text(cx, cy, "汇总", {
      "font-size": 9.5,
      "font-weight": 600,
      fill: p.bg,
      "text-anchor": "middle",
      "dominant-baseline": "central",
    }),
  );

  const shell = cardShell(ctx, parts.join(""), chartH);
  return { ...shell, svg: wrapSvg(shell.svg, shell.height, ctx.p) };
}

/** L17 日历热力：整年日期 × 数量。 */
function renderCalendar(ctx: Ctx): RenderedChart {
  const p = ctx.p;
  const cells: { row: string; col: string; value: number }[] = ctx.spec.cells ?? [];
  const weeks = [...new Set(cells.map((c) => c.col))];
  const days = ["一", "二", "三", "四", "五", "六", "日"];
  const chartH = 130;
  const cellW = Math.min(14, (CHART_W - 60) / Math.max(1, weeks.length));
  const cellH = 14;
  const max = Math.max(1, ...cells.map((c) => Math.abs(c.value)));
  const parts: string[] = [];

  days.forEach((d, di) => {
    parts.push(axisText(38, PAD.top + di * cellH + cellH / 2, d, p, "end"));
  });
  cells.forEach((c) => {
    const wi = weeks.indexOf(c.col);
    const di = days.indexOf(c.row);
    if (wi < 0 || di < 0) return;
    parts.push(
      `<g${animClass(ctx, "fade", wi * 4)}>${tip(
        `${c.col} ${c.row} · ${fmtNum(c.value)}`,
      )}${el("rect", {
        x: 44 + wi * cellW,
        y: PAD.top + di * cellH,
        width: Math.max(2, cellW - 2),
        height: Math.max(2, cellH - 2),
        rx: 2,
        fill: rampColor(p, Math.abs(c.value) / max),
      })}</g>`,
    );
  });

  const shell = cardShell(ctx, parts.join(""), chartH);
  return { ...shell, svg: wrapSvg(shell.svg, shell.height, ctx.p) };
}

/* ------------------------------------------------------------------ 外壳 */

/** 包上 <svg> 外壳。 */
function wrapSvg(inner: string, height: number, p: Palette): string {
  return `<svg viewBox="0 0 ${CHART_W} ${height}" width="100%" xmlns="http://www.w3.org/2000/svg" role="img" style="display:block">${inner}</svg>`;
}

/** 导出用的动画 CSS（与上游一致的节奏）。 */
export const CHART_MOTION_CSS = `
.pop{transform-box:fill-box;transform-origin:center;animation:pop .5s cubic-bezier(.2,.7,.3,1.3) both}
@keyframes pop{from{transform:scale(0)}to{transform:none}}
.fade{animation:fade .9s ease both}
@keyframes fade{from{opacity:0}}
.draw{stroke-dasharray:1;stroke-dashoffset:1;animation:draw 1s cubic-bezier(.4,0,.2,1) both}
@keyframes draw{to{stroke-dashoffset:0}}
@media (prefers-reduced-motion:reduce){
  .pop,.fade{animation:none}
  .draw{animation:none;stroke-dasharray:none;stroke-dashoffset:0}
}`;

export { GRID, INK, LADDER, PAPER, DARK };
