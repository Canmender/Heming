import type { MemoryLayer } from "./format.js";
import type { RecallDropReason, RecallRun } from "./recallLog.js";

/**
 * 「注入可解释」（P3/T17）：把召回日志里的原始档案整理成一眼能读的行。
 *
 * 为什么要这一层：`RecallRun` 是给日志存的**事实**（召回几条、注入几条、谁被裁），
 * 面板需要的是**解释**——哪句提问、命中了哪几条、被裁的那条为什么没进去。
 * 两件事分开，UI 不自己做过滤/排序，也就不会出现「同一个档案在两处读出不同结论」。
 *
 * 纯函数、不碰存储：调用方给 runs，这里只负责挑本会话的、倒序、取最近几条。
 */

/** 一次生成里实际注入的一条。 */
export interface RecallExplainInjected {
  id: string;
  layer: MemoryLayer;
  /** 召回打分（可能缺失：未参与排序的兜底项）。 */
  score?: number;
  /** 日志里截断过的注入文本，够看出是哪条。 */
  content: string;
  /** 注入时按预算截断过。 */
  truncated: boolean;
}

/** 召回了却没有注入的一条，带原因。 */
export interface RecallExplainDropped {
  id: string;
  layer: MemoryLayer;
  reason: RecallDropReason;
  content?: string;
}

/** 一次生成的可解释档案。 */
export interface RecallExplainRow {
  id: string;
  at: string;
  query: string;
  /** 三层各召回多少条（与注入条数可以不同）。 */
  recalled: RecallRun["recalled"];
  injected: RecallExplainInjected[];
  dropped: RecallExplainDropped[];
  /** 疑似被回答引用的条目 id。 */
  used: string[];
}

/** 被裁原因的展示文案：与 `MemoryDrop.reason` 同源，少一个键就编译不过。 */
export const RECALL_DROP_LABELS: Record<RecallDropReason, string> = {
  budget: "预算不够",
  superseded: "被同键新值覆盖",
};

/** 记忆层的中文名（面板用；枚举本身是英文标识）。 */
const LAYER_LABELS: Record<MemoryLayer, string> = {
  semantic: "语义",
  episodic: "情景",
  working: "工作",
};

export function recallLayerLabel(layer: MemoryLayer): string {
  return LAYER_LABELS[layer] ?? layer;
}

/** 面板默认只留最近 3 次：再多也读不过来，日志本身也只留 40 条。 */
export const RECALL_EXPLAIN_LIMIT = 3;

/**
 * 挑出属于某会话的最近几次召回档案（最新在前）。
 *
 * 只认显式 `conversationId` 匹配：日志里没有「会话 → 档案」索引，
 * 把「不知道属于谁」的老档案当成本会话，会让面板显示别人的注入，比不显示更糟。
 */
export function explainRecalls(
  runs: readonly RecallRun[],
  conversationId: string,
  limit = RECALL_EXPLAIN_LIMIT,
): RecallExplainRow[] {
  if (!conversationId) return [];
  const rows: RecallExplainRow[] = [];
  for (const run of runs) {
    if (run.conversationId !== conversationId) continue;
    rows.push({
      id: run.id,
      at: run.at,
      query: run.query,
      recalled: run.recalled,
      injected: run.injected.map((item) => ({
        id: item.id,
        layer: item.layer,
        ...(item.score === undefined ? {} : { score: item.score }),
        content: item.content,
        truncated: item.truncated,
      })),
      dropped: run.dropped.map((drop) => ({
        id: drop.id,
        layer: drop.layer,
        reason: drop.reason,
        ...(drop.content === undefined ? {} : { content: drop.content }),
      })),
      used: [...run.used],
    });
  }
  // 日志 list() 是升序；面板要「最近一次在最上面」。
  return rows.slice(-Math.max(1, limit)).reverse();
}
