/**
 * 图表规范（ChartSpec）—— 图表的唯一数据契约。
 *
 * 一份规范同时驱动两处渲染：
 * 1. 聊天气泡内（`ChatChart.tsx`）——SVG 字符串直接内联；
 * 2. 导出单文件 HTML（`exportHtml.ts`）——同一份 SVG 包进完整 HTML 壳。
 *
 * 之所以走「模型输出 JSON 规范」而不是「模型直接写 SVG」：
 * - SVG 手写极易出坐标错误，且模型改不动；
 * - 规范是结构化的，模型能算、界面能换主题、导出能换配色；
 * - 规范可被 schema 校验，坏数据在入口就被拒，不进渲染层。
 *
 * 规范随消息走：模型把它放进 ` ```chart ` 围栏块，文本层解析。
 * 这样 E2E 加密、跨端同步、消息撤回等既有机制全都天然覆盖——
 * 不需要给协议加字段，也就不会漏掉某条链路。
 */

import { z } from "zod";

/** 一组数据点。x/y 至少给一个，另一维按序号补。 */
const PointSchema = z.object({
  /** 类别名（柱/条的横轴标签）。 */
  label: z.string().max(64).optional(),
  /** 数值。 */
  value: z.number().finite(),
  /** 第二维（散点、气泡）。 */
  x: z.number().finite().optional(),
  /** 散点的分组名（同组同色）。 */
  series: z.string().max(32).optional(),
});

/** 堆叠柱的一段：某类别在某系列上的值。 */
const StackSegmentSchema = z.object({
  label: z.string().max(64),
  value: z.number().finite(),
});

/** 矩阵热力的一格。 */
const CellSchema = z.object({
  row: z.string().max(32),
  col: z.string().max(32),
  value: z.number().finite(),
});

export const ChartSpecSchema = z.object({
  /** 图型 id，取自 `catalog.ts` 的 CHART_TYPES。 */
  type: z.string().min(1).max(8),
  /** 结论式标题：写判断，不写图型名（"哪个季度增长最快" 而非 "柱状图"）。 */
  title: z.string().max(120).default(""),
  /** 副标题：图例说明 · 时间范围，用 · 分隔。 */
  subtitle: z.string().max(200).optional(),
  /** 来源行。 */
  source: z.string().max(160).optional(),
  /** 单位后缀（如"元"、"人"）。 */
  unit: z.string().max(16).optional(),
  /** 简单图型的数据点。 */
  points: z.array(PointSchema).max(200).optional(),
  /** 堆叠柱：类别 → 各段。 */
  stacks: z.array(z.array(StackSegmentSchema)).max(60).optional(),
  /** 矩阵热力的格子。 */
  cells: z.array(CellSchema).max(400).optional(),
  /** 哑铃：每组的前后两点。 */
  pairs: z
    .array(
      z.object({
        label: z.string().max(64),
        before: z.number().finite(),
        after: z.number().finite(),
      }),
    )
    .max(40)
    .optional(),
  /** 瀑布/正负条：带正负的增减序列。 */
  deltas: z
    .array(
      z.object({
        label: z.string().max(64),
        value: z.number().finite(),
      }),
    )
    .max(40)
    .optional(),
  /** 进度：目标与当前。 */
  progress: z
    .object({
      value: z.number().finite(),
      max: z.number().finite().positive(),
    })
    .optional(),
  /** 矩形树图：带权重的叶子。 */
  treemap: z
    .array(
      z.object({
        label: z.string().max(64),
        value: z.number().finite().nonnegative(),
        group: z.string().max(64).optional(),
      }),
    )
    .max(80)
    .optional(),
  /** 直方图：各箱的频数（箱边界由渲染层等分推出）。 */
  histogram: z
    .array(
      z.object({
        label: z.string().max(64),
        count: z.number().finite().nonnegative(),
      }),
    )
    .max(60)
    .optional(),
  /** 漏斗：各阶段的人数。 */
  funnel: z
    .array(
      z.object({
        label: z.string().max(64),
        value: z.number().finite().nonnegative(),
      }),
    )
    .max(12)
    .optional(),
  /** 排名带：每个时间点的排名（值越小排名越高）。 */
  ranks: z
    .array(
      z.object({
        time: z.string().max(32),
        entries: z
          .array(
            z.object({
              label: z.string().max(64),
              rank: z.number().int().min(1).max(60),
            }),
          )
          .max(30),
      }),
    )
    .max(40)
    .optional(),
  /** 极性预设：mono（黑白灰）/ porcelain（青瓷蓝）/ palm（椰林绿）/ wire（编辑部红）。 */
  palette: z.enum(["mono", "porcelain", "palm", "wire"]).default("mono"),
  /** 暗卡：底为炭黑。只给必须暗底衬托的形。 */
  dark: z.boolean().default(false),
});

export type ChartSpec = z.infer<typeof ChartSpecSchema>;
export type ChartPoint = z.infer<typeof PointSchema>;

/**
 * 围栏块解析：从消息正文里抽出图表规范。
 *
 * 围栏格式：
 * ```chart
 * { ...json... }
 * ```
 *
 * 为什么用围栏而不是别的标记：模型对 markdown 围栏最熟悉，
 * 训练数据里到处都是；而且围栏块在纯文本界面里也读得懂（用户复制粘贴
 * 到别处仍能看懂那是一段 JSON）。
 */
export const CHART_FENCE = "chart";

/** 图表围栏块的匹配正则（全局，用于抽出全部图表）。 */
const FENCE_RE = new RegExp(
  "```" + CHART_FENCE + "\\s*\\n([\\s\\S]*?)\\n```",
  "g",
);

/** 从正文抽出全部图表规范（解析失败的跳过，不影响其余内容）。 */
export function extractCharts(text: string): { spec: ChartSpec; raw: string }[] {
  const out: { spec: ChartSpec; raw: string }[] = [];
  const re = new RegExp(FENCE_RE.source, "g");
  let m: RegExpExecArray | null;
  while ((m = re.exec(text)) !== null) {
    const raw = m[1];
    const parsed = parseChartSpec(raw);
    if (parsed) out.push({ spec: parsed, raw });
  }
  return out;
}

/** 解析单个图表 JSON；非法则返回 null（绝不抛给调用方）。 */
export function parseChartSpec(raw: string): ChartSpec | null {
  try {
    const obj = JSON.parse(raw) as unknown;
    const parsed = ChartSpecSchema.safeParse(obj);
    return parsed.success ? parsed.data : null;
  } catch {
    return null;
  }
}

/**
 * 从正文移除图表围栏块，返回剩余纯文本。
 * 渲染消息时用：图表单独渲染成卡片，文字部分不该重复显示围栏原文。
 */
export function stripChartFences(text: string): string {
  return text.replace(FENCE_RE, "").replace(/\n{3,}/g, "\n\n").trim();
}
