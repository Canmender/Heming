/**
 * Mono 视觉 token —— 和鸣图表的唯一风格正本。
 *
 * 移植自 Lieflat Charts 的 `mono-tokens.js`（PolyForm Noncommercial 1.0.0），
 * 保留了它的核心主张：
 * - **明度即数据**：最重要 = 最黑，多系列按重要性沿灰阶分配，不按顺序随便拿；
 * - **一律实心**：不透明材质、无渐变、无阴影，质感全靠明度对比与形状；
 * - **单位诚实**：柱的契约是长度∝数值，柱状图不断轴。
 *
 * 与上游的差别：上游是 `window.MONO` 全局对象，这里是纯 TS 常量 + 纯函数，
 * 便于在 React（聊天气泡内渲染）与 Node（导出单文件 HTML）两处共用同一份实现，
 * 也便于测试。
 */

/** 色板：纸灰底 + 炭黑墨。 */
export const INK = "#1C1C1A";
export const PAPER = "#F0EFEB";
export const MUTED = "#8F8E88";
export const FAINT = "#C6C5BF";
export const GRID = "#DEDDD6";

/** 7 级灰阶：多系列时按重要性从黑到浅分配。 */
export const LADDER = [
  "#1C1C1A",
  "#4A4944",
  "#6A6963",
  "#8F8E88",
  "#B0AFA9",
  "#C6C5BF",
  "#D8D7D1",
] as const;

/** 5 级简版：少系列场景（如构成图）用，避免浅色档在白底上看不见。 */
export const LADDER_SHORT = ["#1C1C1A", "#4A4944", "#8F8E88", "#B0AFA9", "#D8D7D1"] as const;

/**
 * 暗卡专用：底为炭黑，其上"墨"反转为纸色。
 * 暗卡只给必须暗底衬托的形（花瓣、发光感网络），默认浅卡。
 */
export const DARK = {
  bg: "#1C1C1A",
  ink: "#F0EFEB",
  muted: "#8F8E88",
  faint: "#55554F",
  grid: "#2E2D29",
  gridSoft: "#2A2925",
  ladder: ["#F0EFEB", "#DCDAD2", "#C9C7BD", "#B3B0A4", "#8F8E88", "#6A6963", "#4A4944"],
} as const;

/** 字体规格（Inter 全家；离线时回落到系统无衬线）。 */
export const FONT = {
  family: "Inter, 'PingFang SC', 'Microsoft YaHei', system-ui, sans-serif",
  title: { size: 16.5, weight: 700, spacing: "-.02em" },
  sub: { size: 11.5, weight: 400 },
  src: { size: 9.5, weight: 500, spacing: ".08em" },
  value: { weight: 800 },
  axis: { size: 9.5, weight: 600 },
  /** SVG 内最小字号下限：半宽卡 6.5px、通栏 5.5px。低于下限改 hover 出。 */
  minHalf: 6.5,
  minWide: 5.5,
} as const;

/** 形状规格。 */
export const SHAPE = {
  cardRadius: 24,
  barRadius: 99,
} as const;

/**
 * 动画性格：快进快停，不弹跳。
 * 聊天内渲染的图表默认**不播入场动画**（消息是流式出现的，动画会打架），
 * 只有导出的单文件 HTML 才带动画。
 */
export const MOTION = {
  enter: 900,
  enterSlow: 1200,
  easing: "quarticOut",
  staggerDot: 12,
  staggerBar: 100,
} as const;

/**
 * 确定性伪随机：演示/占位数据一律用它，不用 Math.random()——
 * 刷新必须长一样，否则截图、录屏、回归对比全部失效。
 */
export function rnd(i: number, k: number): number {
  return Math.abs(((i * 73856093) ^ (k * 19349663)) % 1000) / 1000;
}

/** 极坐标换算（角度制，顺时针为正，与 SVG 的 y 轴向下坐标系一致）。 */
export function pol(cx: number, cy: number, r: number, deg: number): [number, number] {
  const rad = (deg * Math.PI) / 180;
  return [cx + r * Math.cos(rad), cy + r * Math.sin(rad)];
}

/** 环形扇区 path（内半径 r0、外半径 r1，角度制）。 */
export function sectPath(
  cx: number,
  cy: number,
  r0: number,
  r1: number,
  a0: number,
  a1: number,
): string {
  const big = a1 - a0 > 180 ? 1 : 0;
  const [xa, ya] = pol(cx, cy, r1, a0);
  const [xb, yb] = pol(cx, cy, r1, a1);
  const [xc, yc] = pol(cx, cy, r0, a1);
  const [xd, yd] = pol(cx, cy, r0, a0);
  return `M${xa} ${ya} A${r1} ${r1} 0 ${big} 1 ${xb} ${yb} L${xc} ${yc} A${r0} ${r0} 0 ${big} 0 ${xd} ${yd} Z`;
}

/**
 * HTML 转义：所有进入 SVG/HTML 的文本都要过这一道。
 * 图表标题、来源、轴标签都来自模型输出，属于不可信输入。
 */
export function esc(s: unknown): string {
  return String(s ?? "")
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;")
    .replace(/'/g, "&#39;");
}

/**
 * 数值格式化：图表里的大数不该写成 "12345678"。
 * 上万走「万」，上亿走「亿」——中文语境下这比 K/M 更自然。
 */
export function fmtNum(v: number, digits = 2): string {
  if (!Number.isFinite(v)) return "—";
  const abs = Math.abs(v);
  if (abs >= 1e8) return `${trimZeros((v / 1e8).toFixed(digits))}亿`;
  if (abs >= 1e4) return `${trimZeros((v / 1e4).toFixed(digits))}万`;
  if (Number.isInteger(v)) return String(v);
  return trimZeros(v.toFixed(digits));
}

function trimZeros(s: string): string {
  return s.includes(".") ? s.replace(/\.?0+$/, "") : s;
}

/**
 * 取一段文本的"刻度数"：轴标签与来源行都全大写、加字距（上游的 source 行规矩）。
 * 中文没有大写概念，保留原样即可。
 */
export function trackText(s: string): string {
  return s;
}
