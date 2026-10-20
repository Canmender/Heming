/**
 * 图表配色 —— 四套预设的色值与选取规则。
 *
 * 移植自 Lieflat Charts 的 `color-presets.js`（PolyForm Noncommercial 1.0.0）。
 * 核心约束照搬：**同一份图只锁一套色彩系统，不得混用**。
 *
 * - mono：黑白灰，明度即数据，是保底方案；
 * - porcelain（青瓷蓝）：单色相蓝阶，适合有序数据（进度/热力/时间序列）；
 * - palm（椰林绿）：色相=类目，适合几个互不排序的类目并列；
 * - wire（编辑部红）：灰阶承载数据 + 一点橙作视线落点，橙永远只给一个元素。
 */

export type PaletteName = "mono" | "porcelain" | "palm" | "wire";

export interface Palette {
  name: PaletteName;
  cn: string;
  /** 纸（背景）。 */
  bg: string;
  /** 墨（主数据与文字）。 */
  txt: string;
  /** 次级文字。 */
  mut: string;
  /** 轴标签。 */
  lab: string;
  /** 来源行 / 辅助刻度。 */
  faint: string;
  /** 网格线。 */
  grid: string;
  /** 主数据色。 */
  data: string;
  /** 次数据色。 */
  data2: string;
  /** 视线落点（仅一元素）。 */
  hero: string;
  /** 热力色阶（浅→深）。 */
  ramp: string[];
  /** 类目色（多系列）。 */
  cat: string[];
}

export const PALETTES: Record<PaletteName, Palette> = {
  mono: {
    name: "mono",
    cn: "黑白灰",
    bg: "#F0EFEB",
    txt: "#1C1C1A",
    mut: "#8F8E88",
    lab: "#8F8E88",
    faint: "#C6C5BF",
    grid: "#DEDDD6",
    data: "#1C1C1A",
    data2: "#6A6963",
    hero: "#1C1C1A",
    ramp: ["#F0EFEB", "#D8D7D1", "#B0AFA9", "#8F8E88", "#4A4944", "#1C1C1A"],
    cat: ["#1C1C1A", "#4A4944", "#6A6963", "#8F8E88", "#B0AFA9", "#C6C5BF", "#D8D7D1"],
  },
  porcelain: {
    name: "porcelain",
    cn: "青瓷蓝",
    bg: "#F7F2EB",
    txt: "#081F5C",
    mut: "rgba(8,31,92,.60)",
    lab: "rgba(8,31,92,.72)",
    faint: "rgba(8,31,92,.32)",
    grid: "rgba(8,31,92,.16)",
    data: "#334EAC",
    data2: "#7096D1",
    hero: "#081F5C",
    ramp: ["#D0E3FF", "#BAD6EB", "#7096D1", "#334EAC", "#081F5C"],
    cat: ["#081F5C", "#334EAC", "#7096D1", "#BAD6EB", "#8FA8CF", "#C9D9EE"],
  },
  palm: {
    name: "palm",
    cn: "椰林绿",
    bg: "#F0EFEB",
    txt: "#58402E",
    mut: "rgba(88,64,46,.60)",
    lab: "rgba(88,64,46,.72)",
    faint: "rgba(88,64,46,.32)",
    grid: "rgba(88,64,46,.16)",
    data: "#43593B",
    data2: "#77835A",
    hero: "#D4A017",
    ramp: ["#F2D17E", "#C0B37A", "#9EA47B", "#77835A", "#43593B"],
    cat: ["#43593B", "#77835A", "#ACAD79", "#D4A017", "#58402E", "#F2D17E"],
  },
  wire: {
    name: "wire",
    cn: "编辑部红",
    bg: "#F0F0EE",
    txt: "#1F1E1C",
    mut: "rgba(31,30,28,.60)",
    lab: "rgba(31,30,28,.72)",
    faint: "rgba(31,30,28,.32)",
    grid: "rgba(31,30,28,.16)",
    data: "#22211F",
    data2: "#8F8E86",
    hero: "#F5572F",
    ramp: ["#DBDAD3", "#C0BFB7", "#8F8E86", "#5A5954", "#22211F"],
    cat: ["#22211F", "#5A5954", "#8F8E86", "#C0BFB7", "#F5572F", "#A8A79F"],
  },
};

/**
 * 暗卡下的配色：底为炭黑，其上"墨"反转为纸色。
 * 暗卡只给必须暗底衬托的形，默认浅卡。
 */
export function darkPalette(p: Palette): Palette {
  return {
    ...p,
    bg: "#1C1C1A",
    txt: "#F0EFEB",
    mut: "#8F8E88",
    lab: "#8F8E88",
    faint: "#55554F",
    grid: "#2E2D29",
    // 暗卡上灰阶反过来：最重要 = 最亮
    ramp: p.ramp.slice().reverse(),
    cat: p.cat.map(() => "#F0EFEB"),
  };
}

/**
 * 按数据量选色阶。
 * 上游的规矩：类目超过预设容量就换 Mono 灰阶（7 档）。
 */
export function pickPalette(
  name: PaletteName,
  categoryCount: number,
  dark: boolean,
): Palette {
  const base = PALETTES[name] ?? PALETTES.mono;
  if (name === "mono") return dark ? darkPalette(base) : base;
  // 彩色预设容量：porcelain 适合有序（可多档），palm/wire 类目色有限
  const capacity = name === "porcelain" ? 6 : 4;
  if (categoryCount > capacity) {
    const mono = PALETTES.mono;
    return dark ? darkPalette(mono) : mono;
  }
  return dark ? darkPalette(base) : base;
}
