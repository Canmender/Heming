/**
 * 图表工具集（chart.*）：让智能体按需产出图表。
 *
 * 形态与 self.* 同源——都是「和鸣自带的工具」，走同一套工具桥，
 * agentStream 的工具循环零改动。
 *
 * 但与 self.* 有一处根本不同：**self.* 改的是配置，chart.* 产出的是内容**。
 * 所以 chart.* 不写存储、不留痕、也没有护栏预算——它只是把数据变成图。
 *
 * 两个工具：
 * - `chart_types`：按数据形状查候选图型（先判形状再选图型，是上游规范的核心）；
 * - `chart_render`：给定规范，产出可直接放进回复的围栏块。
 *
 * 为什么图表规范要走「围栏块」而不是直接塞进消息 payload：
 * 围栏块是普通文本，会被 E2E 加密、被跨端同步、被消息撤回覆盖——
 * 不需要给协议加字段，也就不会漏掉某条链路。
 */

import type { ToolBridge } from "../agentStream.js";
import { CHART_TYPES, findChartType, suggestChartTypes } from "./catalog.js";
import { ChartSpecSchema, type ChartSpec } from "./spec.js";

/** chart.* 工具的命名前缀（分流与展示共用）。 */
export const CHART_TOOL_PREFIX = "chart_";

interface ToolSpec {
  name: string;
  description: string;
  parameters: Record<string, unknown>;
}

/** JSON Schema 片段构造器。 */
const str = (description: string) => ({ type: "string" as const, description });
const num = (description: string) => ({ type: "number" as const, description });
const bool = (description: string) => ({ type: "boolean" as const, description });
const arr = (description: string, items: Record<string, unknown>) => ({
  type: "array" as const,
  items,
  description,
});
const obj = (description: string, props: Record<string, unknown>) => ({
  type: "object" as const,
  properties: props,
  description,
});

/** 工具清单。 */
const TOOLS: ToolSpec[] = [
  {
    name: "chart_types",
    description: [
      "按数据形状查询可用图型。",
      "先判断数据长什么样（几个类目的比较？带时间的序列？占比构成？有正负？多对一归属？），",
      "再据此选图型——不要先挑图型名再套数据。",
      "shape 用一句话描述数据形状，例如「少类目排名比较」「带时间的连续序列」「100% 构成占比」。",
      "返回候选图型 id、名称、数据形状与场合。",
    ].join(""),
    parameters: obj("查询参数", {
      shape: str("数据形状的一句话描述，如「少类目排名比较」「100% 构成占比」"),
    }),
  },
  {
    name: "chart_render",
    description: [
      "把数据渲染成图表，产出一段可直接放进回复正文的围栏块。",
      "调用后必须把返回的围栏块原样贴进你的回复里（不要改写、不要省略），用户才能看到图。",
      "type 用 chart_types 给出的图型 id；不同图型用不同的数据字段（见 description 与字段说明）。",
      "title 写结论不写图型名——「哪个季度增长最快」好过「柱状图」。",
      "数值必须诚实：不要为了好看调整数据，比例要由数值决定。",
    ].join(""),
    parameters: obj("图表规范", {
      type: str("图型 id，取自 chart_types 的返回值"),
      title: str("结论式标题，写判断不写图型名"),
      subtitle: str("副标题：图例说明 · 时间范围，用 · 分隔"),
      source: str("来源行"),
      unit: str("单位后缀，如「元」「人」"),
      points: arr(
        "简单图型的数据点：柱/线/面积/散点用这个",
        obj("数据点", {
          label: str("类别名"),
          value: num("数值"),
          x: num("第二维（散点用）"),
          series: str("分组名（同组同色）"),
        }),
      ),
      stacks: arr(
        "堆叠柱/流向图：每个类别一段，每段含 label 与 value",
        arr("堆叠段", obj("段", { label: str("段名"), value: num("数值") })),
      ),
      cells: arr(
        "热力图：矩阵格子",
        obj("格子", { row: str("行标签"), col: str("列标签"), value: num("数值") }),
      ),
      pairs: arr(
        "哑铃图：类目级前后对比",
        obj("对比项", { label: str("类目名"), before: num("之前的值"), after: num("之后的值") }),
      ),
      deltas: arr(
        "瀑布图：带正负的增减序列",
        obj("增减项", { label: str("项名"), value: num("增量（可为负）") }),
      ),
      progress: obj("进度图：单值完成度", {
        value: num("当前值"),
        max: num("目标值（大于 0）"),
      }),
      treemap: arr(
        "矩形树图：带权重的构成项",
        obj("构成项", { label: str("名称"), value: num("权重（≥0）"), group: str("分组名（可选）") }),
      ),
      histogram: arr(
        "直方图：各箱频数",
        obj("箱", { label: str("箱标签"), count: num("频数") }),
      ),
      funnel: arr(
        "漏斗图：各阶段人数",
        obj("阶段", { label: str("阶段名"), value: num("人数") }),
      ),
      ranks: arr(
        "排名带：各时间点的排名",
        obj("时间点", {
          time: str("时间标签"),
          entries: arr("排名项", obj("项", { label: str("名称"), rank: num("名次（1 为最好）") })),
        }),
      ),
      palette: {
        type: "string",
        enum: ["mono", "porcelain", "palm", "wire"],
        description: "配色：mono 黑白灰（默认）/ porcelain 青瓷蓝 / palm 椰林绿 / wire 编辑部红",
      },
      dark: bool("暗卡：底为炭黑，只给必须暗底衬托的形"),
    }),
  },
];

/** 工具清单（对外暴露给模型）。 */
export function chartToolSpecs(): ToolSpec[] {
  return TOOLS;
}

/** 从模型给的 arguments 里取字符串参数。 */
function argString(args: Record<string, unknown>, key: string): string {
  const v = args[key];
  return typeof v === "string" ? v : "";
}

/** 构建图表工具桥。 */
export function buildChartToolBridge(): ToolBridge {
  return {
    tools: TOOLS.map((t) => ({
      type: "function" as const,
      function: { name: t.name, description: t.description, parameters: t.parameters },
    })),
    execute: async (call) => {
      let args: Record<string, unknown> = {};
      try {
        const parsed = JSON.parse(call.arguments || "{}") as unknown;
        if (parsed && typeof parsed === "object" && !Array.isArray(parsed)) {
          args = parsed as Record<string, unknown>;
        }
      } catch {
        return { text: "参数不是合法 JSON，请检查后重试。", ok: false };
      }

      if (call.name === "chart_types") {
        return { text: runChartTypes(argString(args, "shape")), ok: true };
      }
      if (call.name === "chart_render") {
        return { text: runChartRender(args), ok: true };
      }
      return { text: `未知工具 ${call.name}`, ok: false };
    },
  };
}

/** chart_types：按数据形状给候选。 */
function runChartTypes(shape: string): string {
  const q = shape.trim();
  if (!q) {
    return [
      "请先描述数据形状。常见形状：",
      "- 少类目排名比较（≤8）",
      "- 带时间的连续序列",
      "- 100% 构成占比（≤6 段）",
      "- 两个连续维度的关系",
      "- 增减分解（有正负）",
      "- 阶段递减",
      "",
      "全部可用图型：",
      ...CHART_TYPES.map((t) => `${t.id} ${t.name} — ${t.shape}`),
    ].join("\n");
  }
  const hits = suggestChartTypes(q, 4);
  if (hits.length === 0) {
    return `没有匹配「${q}」的图型。可用图型：\n${CHART_TYPES.map((t) => `${t.id} ${t.name} — ${t.shape}`).join("\n")}`;
  }
  return [
    `与「${q}」匹配的图型（按契合度排序）：`,
    ...hits.map(
      (t) =>
        `- ${t.id} ${t.name}｜数据形状：${t.shape}｜场合：${t.occasion}｜读者时间：${t.readTime}`,
    ),
    "",
    "选定后用 chart_render 渲染。若都不合适，回「可用图型」里挑最接近的。",
  ].join("\n");
}

/** chart_render：校验规范并产出围栏块。 */
function runChartRender(args: Record<string, unknown>): string {
  const type = argString(args, "type").trim().toUpperCase();
  if (!type) {
    return "缺少 type（图型 id）。先用 chart_types 选一个。";
  }
  const known = findChartType(type);
  if (!known) {
    return `未知图型 ${type}。先用 chart_types 查询可用图型。`;
  }

  // 只把白名单字段交给 schema 校验：模型可能多传字段，不该因此整条失败
  const allowed = [
    "type",
    "title",
    "subtitle",
    "source",
    "unit",
    "points",
    "stacks",
    "cells",
    "pairs",
    "deltas",
    "progress",
    "treemap",
    "histogram",
    "funnel",
    "ranks",
    "palette",
    "dark",
  ];
  const clean: Record<string, unknown> = {};
  for (const key of allowed) {
    if (args[key] !== undefined) clean[key] = args[key];
  }
  clean.type = type;

  const parsed = ChartSpecSchema.safeParse(clean);
  if (!parsed.success) {
    const issues = parsed.error.issues
      .slice(0, 6)
      .map((i) => `- ${i.path.join(".") || "(根)"}：${i.message}`)
      .join("\n");
    return `图表规范不合法，请修正后重试：\n${issues}`;
  }

  const spec: ChartSpec = parsed.data;
  const block = toFence(spec);
  return [
    "图表已生成。请把下面这段原样放进你的回复正文（不要改写、不要省略）：",
    "",
    block,
  ].join("\n");
}

/**
 * 把规范转成围栏块。
 *
 * 围栏用 ```chart ——模型对 markdown 围栏最熟悉，且这段文本进消息后
 * 会被 E2E 加密、被跨端同步，用户在界面上直接看到渲染好的图。
 */
export function toFence(spec: ChartSpec): string {
  return ["```chart", JSON.stringify(spec), "```"].join("\n");
}
