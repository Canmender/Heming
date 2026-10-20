/**
 * 图型目录 —— 选型的唯一依据。
 *
 * 移植自 Lieflat Charts 的 `catalog.md`（PolyForm Noncommercial 1.0.0），
 * 保留其核心主张：**先判数据形状，再选图型**。
 * 数据形状是选图的主键，图型名不是——用户说「把这季度转化画一下」，
 * 不该要求他先知道该叫"漏斗图"还是"金字塔图"。
 *
 * 与上游的差别：上游覆盖 63 张图型、每张有真实模板实现；和鸣实现的是
 * 主力图型（可真实渲染的那批），其余在 `ALIASES` 里给出替代建议，
 * 避免模型选到一个和鸣根本画不出来的图型。
 */

/** 图型分类，对应上游的三套视觉体系。 */
export type ChartFamily = "basics" | "glance" | "lupi";

/** 读者时间：决定用哪套体系。 */
export type ReadTime = "<10s" | "~30s" | ">30s";

export interface ChartType {
  /** 图型编号（沿用上游编号，便于对照）。 */
  id: string;
  /** 图型名。 */
  name: string;
  /** 数据形状（选图主键）。 */
  shape: string;
  /** 适用场合。 */
  occasion: string;
  /** 读者花多久读完。 */
  readTime: ReadTime;
  /** 视觉体系。 */
  family: ChartFamily;
}

/**
 * 和鸣可渲染的图型（主力）。
 * 每一项都有真实 SVG 实现——`renderer.ts` 里能查到同 id 的分支。
 */
export const CHART_TYPES: readonly ChartType[] = [
  // —— 基础编辑型（Basics）：结构简单，读者快读 ——
  {
    id: "F1",
    name: "阶梯柱",
    shape: "少类目比较（≤8），单位可数",
    occasion: "周报 / 汇报",
    readTime: "<10s",
    family: "basics",
  },
  {
    id: "F2",
    name: "折线",
    shape: "带时间的连续序列",
    occasion: "趋势复盘",
    readTime: "<10s",
    family: "basics",
  },
  {
    id: "F3",
    name: "面积",
    shape: "带时间的连续序列，看总量与形态",
    occasion: "趋势复盘",
    readTime: "<10s",
    family: "basics",
  },
  {
    id: "F4",
    name: "环形构成",
    shape: "100% 构成（占比，≤6 段）",
    occasion: "通用；饼图的默认替代",
    readTime: "<10s",
    family: "basics",
  },
  {
    id: "F5",
    name: "横向条",
    shape: "排名比较（≤10），标签长",
    occasion: "排行榜 / 明细",
    readTime: "<10s",
    family: "basics",
  },
  {
    id: "F7",
    name: "堆叠柱",
    shape: "构成随时间变化（≤4 类 × ≤3 段）",
    occasion: "业务复盘",
    readTime: "~30s",
    family: "basics",
  },
  {
    id: "F8",
    name: "散点",
    shape: "两个连续维度的关系（≤60 点）",
    occasion: "产品分析",
    readTime: "~30s",
    family: "basics",
  },
  {
    id: "F9",
    name: "瀑布",
    shape: "增减分解（≤6 级，有正负）",
    occasion: "财务 / 复盘",
    readTime: "~30s",
    family: "basics",
  },
  {
    id: "F10",
    name: "点阵热力",
    shape: "两个离散维度 × 数值（≤120 格）",
    occasion: "运营 / 支持",
    readTime: "<10s",
    family: "basics",
  },
  {
    id: "F11",
    name: "进度",
    shape: "单值完成度（0–100%）",
    occasion: "汇报开场",
    readTime: "<10s",
    family: "basics",
  },
  {
    id: "F12",
    name: "哑铃",
    shape: "类目级前后对比（≤6 类，每类两点）",
    occasion: "年报 / 复盘",
    readTime: "~30s",
    family: "basics",
  },
  {
    id: "F13",
    name: "矩形树图",
    shape: "层级构成（2–3 层，面积=数值）",
    occasion: "预算 / 空间占用",
    readTime: "~30s",
    family: "basics",
  },
  {
    id: "F14",
    name: "直方图",
    shape: "单变量分箱频数（bin 有含义）",
    occasion: "支持 / 运营分析",
    readTime: "~30s",
    family: "basics",
  },
  // —— 快读型（Glance）：粗笔画、提前聚合 ——
  {
    id: "G3",
    name: "粗柱",
    shape: "少类目排名比较（≤6）",
    occasion: "周报 dashboard",
    readTime: "<10s",
    family: "glance",
  },
  {
    id: "G10",
    name: "正负条",
    shape: "有正负的分类数值",
    occasion: "周报 dashboard",
    readTime: "<10s",
    family: "glance",
  },
  {
    id: "G21",
    name: "排名带",
    shape: "多实体排名随离散时间变化",
    occasion: "汇报 / 账单复盘",
    readTime: "<10s",
    family: "glance",
  },
  {
    id: "G22",
    name: "聚合流向",
    shape: "两端聚合流量，带宽=数量",
    occasion: "归因 / 转化分析",
    readTime: "~30s",
    family: "glance",
  },
  // —— 编辑叙事型（Lupi）：逐记录、发丝线、留白 ——
  {
    id: "L1",
    name: "放射扇",
    shape: "多实体各带时间 + 当前规模",
    occasion: "年报 / 故事页",
    readTime: "~30s",
    family: "lupi",
  },
  {
    id: "L5",
    name: "径向汇聚",
    shape: "多对一归属，不丢明细",
    occasion: "海报 / 封面",
    readTime: "~30s",
    family: "lupi",
  },
  {
    id: "L13",
    name: "漏斗",
    shape: "分阶段递减",
    occasion: "年报 / 故事页",
    readTime: "~30s",
    family: "lupi",
  },
  {
    id: "L14",
    name: "百点阵",
    shape: "100% 构成（≤6 类小数据）",
    occasion: "年报 / 故事页",
    readTime: "~30s",
    family: "lupi",
  },
  {
    id: "L16",
    name: "矩阵热力",
    shape: "两个离散维度 × 数值（≤100 格）",
    occasion: "年报 / 产品分析",
    readTime: "~30s",
    family: "lupi",
  },
  {
    id: "L17",
    name: "日历热力",
    shape: "整年日期 × 数量（52 周 × 7 天）",
    occasion: "年报 / 运营复盘",
    readTime: ">30s",
    family: "lupi",
  },
] as const;

/**
 * 上游有、和鸣暂未实现的图型 → 给一个能画出来的替代。
 * 模型若选了这些图型，收到的是替代建议而不是空图。
 */
export const ALIASES: Record<string, string> = {
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
  L18: "F1",
  L19: "F14",
  L20: "F8",
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

/** 按 id 查图型。 */
export function findChartType(id: string): ChartType | undefined {
  const key = id.trim().toUpperCase();
  return CHART_TYPES.find((t) => t.id === key);
}

/**
 * 选型：给一份数据形状描述，返回候选图型（按可读性优先排序）。
 *
 * 规则沿用上游「主力优先」：先比较 basics（结构简单、快读），
 * 其次是 glance（快读聚合），最后 lupi（细读叙事）。
 * 排序靠形状关键词命中数——命中越多越可能是正解。
 */
export function suggestChartTypes(shape: string, limit = 3): ChartType[] {
  const text = shape.toLowerCase();
  const scored = CHART_TYPES.map((t) => {
    let score = 0;
    const hay = `${t.shape} ${t.name} ${t.occasion}`.toLowerCase();
    // 逐关键词命中：数据形状的词越具体，权重越高
    for (const kw of text.split(/[\s、，,与和或（）()的]+/)) {
      if (kw.length < 2) continue;
      if (hay.includes(kw)) score += kw.length;
    }
    return { t, score };
  })
    .filter((x) => x.score > 0)
    .sort((a, b) => b.score - a.score);

  if (scored.length === 0) {
    // 形状描述太含糊：给最通用的三个（柱/线/构成）
    return ["F1", "F2", "F4"]
      .map((id) => findChartType(id))
      .filter((t): t is ChartType => !!t)
      .slice(0, limit);
  }
  return scored.slice(0, limit).map((x) => x.t);
}

/** 图型 id → 名称，供工具返回值给模型看。 */
export function chartTypeName(id: string): string {
  const direct = findChartType(id);
  if (direct) return `${direct.id} ${direct.name}`;
  const alias = ALIASES[id.trim().toUpperCase()];
  const aliased = alias ? findChartType(alias) : undefined;
  return aliased ? `${aliased.id} ${aliased.name}（${id} 的替代）` : id;
}
