import { turnCompletion, type PairToolCallsResult } from "./pair.js";
import type { RolloutItem, RolloutTurnFailure } from "./types.js";

/**
 * 回放（replay）的**展示层纯逻辑**：相对时间、类型筛选、悬停配对、单回合导出。
 *
 * 为什么放在 `lib/` 而不是组件里：组件会将就 React 版本与状态，判定却应该可单测。
 * 这里不 import 任何 React——界面只负责把结果画出来。
 */

/* ---------------------------------------------------------------- 相对时间 */

/** 一条记录距回合开始的毫秒数；时间戳非法时返回 null（不显示 NaN）。 */
export function relativeOffsetMs(startAt: string, at: string): number | null {
  const start = new Date(startAt).getTime();
  const then = new Date(at).getTime();
  if (!Number.isFinite(start) || !Number.isFinite(then)) return null;
  return then - start;
}

function pad2(n: number): string {
  return String(n).padStart(2, "0");
}

/**
 * 「距开始 +3.2s」：排查时序问题时，相对时间比绝对时钟直观。
 *
 * 口径：<1s 用毫秒、<60s 保留一位小数、再往上给 `+1m02s` / `+1h02m`。
 * 记录早于开始（时钟回拨/坏数据）显示负号，不假装成 0。
 */
export function relativeLabel(startAt: string, at: string): string {
  const diff = relativeOffsetMs(startAt, at);
  if (diff === null) return "";
  const sign = diff < 0 ? "-" : "+";
  const abs = Math.abs(diff);
  if (abs < 1000) return `${sign}${Math.round(abs)}ms`;
  const seconds = abs / 1000;
  if (seconds < 60) return `${sign}${seconds.toFixed(1)}s`;
  // 先把总秒数四舍五入再拆分钟：old 版 Math.round(seconds % 60) 会把 59.6s 舍成 60s，
  // 出现 "+1m60s" 这种不合法的时间；进位应当在秒级先做完。
  const totalSeconds = Math.round(seconds);
  const minutes = Math.floor(totalSeconds / 60);
  if (minutes < 60) return `${sign}${minutes}m${pad2(totalSeconds % 60)}s`;
  const hours = Math.floor(minutes / 60);
  return `${sign}${hours}h${pad2(minutes % 60)}m`;
}

/* ------------------------------------------------------------------ 筛选 */

/** 类型筛选：只保留能回答具体问题的那几类（不看全部时最常用）。 */
export const ROLLOUT_FILTERS = [
  { key: "all", label: "全部" },
  { key: "tools", label: "工具" },
  { key: "failed", label: "失败" },
  { key: "denied", label: "被拒" },
] as const;

export type RolloutFilter = (typeof ROLLOUT_FILTERS)[number]["key"];

/**
 * 单条是否命中筛选。
 *
 * - `tools`：只看工具调用与结果（排查「它到底调了什么」）；
 * - `failed`：执行失败的工具结果 + 出错/中断的收尾（排查「哪一步坏了」）；
 * - `denied`：被 HITL 拒绝的调用（排查「为什么没执行」）。
 */
export function matchesRolloutFilter(item: RolloutItem, filter: RolloutFilter): boolean {
  switch (filter) {
    case "all":
      return true;
    case "tools":
      return item.type === "tool_call" || item.type === "tool_result";
    case "failed":
      if (item.type === "tool_result") return item.ok !== true;
      if (item.type === "turn_end") return item.status !== "ok";
      return false;
    case "denied":
      return item.type === "tool_result" && item.denied === true;
  }
}

export function filterRolloutItems(items: RolloutItem[], filter: RolloutFilter): RolloutItem[] {
  if (filter === "all") return items;
  return items.filter((item) => matchesRolloutFilter(item, filter));
}

/* -------------------------------------------------------------- 悬停配对 */

/**
 * 悬停一条时应当同时高亮的下标：`tool_call` ↔ `tool_result` 靠 `id` 配对。
 *
 * 判据来自 `pairToolCalls` 的结果（与「未完成」标注、分叉前置同一份），
 * 不在这里重新按 id 匹配一遍——两套判定迟早会漂移。
 */
export function counterpartIndex(pairing: PairToolCallsResult, index: number): number | null {
  for (const pair of pairing.pairs) {
    if (pair.callIndex === index) return pair.resultIndex;
    if (pair.resultIndex === index) return pair.callIndex;
  }
  return null;
}

/* -------------------------------------------------------------- 导出 JSON */

/** 单回合导出的格式版本：结构与面板口径变更时递增。 */
export const ROLLOUT_EXPORT_VERSION = 1;

export interface RolloutExportMeta {
  streamId: string;
  /** 日志版本（v1/v2/未来版本都如实带出）。 */
  version: number;
  /** 导出时间（由调用方传，便于测试；缺省不写）。 */
  exportedAt?: string;
}

/**
 * 导出**单个回合**的 JSON（附到 issue 里用）。
 *
 * 与会话导出**不是一件事**：会话导出带的是消息（E2E 信封内的对话事实），
 * 这里带的是本机过程日志（含被拒调用的参数）——两者口径不同，绝不合并（§3.5、§2.3）。
 * 导出内容与面板同源：`items` 是归一化后的序列，`incomplete` 是同一份未完成判定。
 */
export function buildRolloutExport(items: RolloutItem[], meta: RolloutExportMeta): string {
  const payload = {
    format: "heming-rollout",
    version: ROLLOUT_EXPORT_VERSION,
    ...(meta.exportedAt ? { exportedAt: meta.exportedAt } : {}),
    streamId: meta.streamId,
    rolloutVersion: meta.version,
    /** 与面板一致：未完成判定用的是同一份 turnCompletion。 */
    incomplete: turnCompletion(items),
    count: items.length,
    items,
  };
  return JSON.stringify(payload, null, 2);
}

/** 导出文件的建议文件名（单个回合，带 streamId 便于对照）。 */
export function rolloutExportFileName(streamId: string): string {
  const safe = streamId.replace(/[^\w.-]+/g, "_").slice(0, 80) || "rollout";
  return `rollout-${safe}.json`;
}

/* ----------------------------------------------------------- 用量与耗时 */

/**
 * 一回合的用量合计（v3 / P0-T1）。
 *
 * `reported` 是必需的：全 0 有两种含义——「真的没用 token」与「网关没上报」，
 * 面板必须能区分，否则会把一条没数据的记录显示成「零消耗」。
 */
export interface RolloutUsageTotals {
  input: number;
  output: number;
  cacheRead: number;
  cacheWrite: number;
  /** 模型轮次数（工具循环里每轮 +1）。 */
  rounds: number;
  /** 有没有任何一条 `turn_end` 带 usage（false = 未上报，不是 0）。 */
  reported: boolean;
}

/**
 * 把一回合里所有 `turn_end.usage` 求和。
 *
 * 正常一回合只有一条 `turn_end`；这里仍然遍历求和，是因为日志可能被外部拼接
 * （导出再导入、合并排查包），多一条就多算一条，不假设唯一性。
 */
export function streamUsageTotals(items: readonly RolloutItem[]): RolloutUsageTotals {
  const totals: RolloutUsageTotals = {
    input: 0,
    output: 0,
    cacheRead: 0,
    cacheWrite: 0,
    rounds: 0,
    reported: false,
  };
  for (const item of items) {
    if (item.type !== "turn_end" || !item.usage) continue;
    totals.reported = true;
    totals.input += item.usage.input ?? 0;
    totals.output += item.usage.output ?? 0;
    totals.cacheRead += item.usage.cacheRead ?? 0;
    totals.cacheWrite += item.usage.cacheWrite ?? 0;
    totals.rounds += item.usage.rounds ?? 0;
  }
  return totals;
}

/** 一次工具调用的耗时行（v3）：没有记录耗时的条目 `ms` 为 undefined。 */
export interface RolloutToolTiming {
  id: string;
  name: string;
  ok: boolean;
  denied: boolean;
  /** 从发出到拿到结果的墙钟耗时；被拒/旧日志没有这个字段。 */
  ms?: number;
}

/**
 * 按调用顺序取出工具结果与耗时（面板「哪个工具慢」的直接数据源）。
 *
 * 只取 `tool_result`：`tool_call` 只是模型的决策，尚未执行，没有耗时可言。
 */
export function toolTimings(items: readonly RolloutItem[]): RolloutToolTiming[] {
  const rows: RolloutToolTiming[] = [];
  for (const item of items) {
    if (item.type !== "tool_result") continue;
    rows.push({
      id: item.id,
      name: item.name,
      ok: item.ok,
      denied: item.denied === true,
      ...(item.ms !== undefined ? { ms: item.ms } : {}),
    });
  }
  return rows;
}

/** 「五抽屉」报表的一格：归因码 + 本段日志里出现的次数。 */
export interface RolloutFailureCount {
  failure: RolloutTurnFailure;
  count: number;
}

/** 报表抽屉顺序：五个可归因类在前，兜底类最后（见 `RolloutTurnFailure` 的注释）。 */
const FAILURE_ORDER: readonly RolloutTurnFailure[] = [
  "context_overflow",
  "tool_error",
  "model_refusal",
  "hitl_denied",
  "max_rounds",
  "provider_error",
];

/**
 * 失败归因计数（v4 / P3-T16）：把 `turn_end.failure` 聚成「五抽屉 + 兜底」。
 *
 * - 只统计**写了归因**的回合：v3 及更早的旧日志没有这个字段，不能算成「没失败」；
 * - 永远返回全部抽屉（count 可能为 0）：面板要能回答「这一类一次都没发生」，
 *   缺行会被误读成「没统计」；
 * - 顺序固定：报表里同一类的位置不随数据变化，方便按周对比截图。
 */
export function failureCounts(items: readonly RolloutItem[]): RolloutFailureCount[] {
  const counts = new Map<RolloutTurnFailure, number>();
  for (const item of items) {
    if (item.type !== "turn_end" || !item.failure) continue;
    counts.set(item.failure, (counts.get(item.failure) ?? 0) + 1);
  }
  return FAILURE_ORDER.map((failure) => ({ failure, count: counts.get(failure) ?? 0 }));
}
