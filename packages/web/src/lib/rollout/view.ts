import { turnCompletion, type PairToolCallsResult } from "./pair.js";
import type { RolloutItem } from "./types.js";

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
  const minutes = Math.floor(seconds / 60);
  if (minutes < 60) return `${sign}${minutes}m${pad2(Math.round(seconds % 60))}s`;
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
