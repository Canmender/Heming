import type { ChatMessage } from "./types.js";
import { ROW_TOKEN_OVERHEAD, estimateRowsTokens, estimateTokens } from "./tokens.js";

/**
 * 预算与切分（设计 §3.2）：从最新往回累计 recent，超预算的更早消息进 older。
 * 两条硬约束：**不拆「user→assistant」对**（切点使 recent 以 assistant 开头时，
 * 把紧邻其前的 user 一并移入），以及 `keepRecentTurns` 轮数上限。
 */

/** 默认总预算（token）。 */
export const DEFAULT_BUDGET_TOKENS = 6000;
/** 默认保留轮数。 */
export const DEFAULT_KEEP_RECENT_TURNS = 8;
/** 注入侧（系统提示词 + 记忆段 + 技能段）预留 token 上界（设计 §3.2）。 */
export const DEFAULT_RESERVED_TOKENS = 900;

export interface PlanInput {
  budgetTokens: number;
  keepRecentTurns: number;
  reservedTokens?: number;
}

export interface PlanResult {
  recent: ChatMessage[];
  older: ChatMessage[];
  usedTokens: number;
  overflowTokens: number;
}

function safeInt(value: unknown, min: number): number {
  return typeof value === "number" && Number.isFinite(value) ? Math.max(min, Math.floor(value)) : min;
}

function rowCost(row: ChatMessage): number {
  return estimateTokens(String(row?.content ?? "")) + ROW_TOKEN_OVERHEAD;
}

/**
 * 切分历史为 `recent`（原文保留）与 `older`（待压缩）。
 *
 * 口径（测试锁定）：
 * - 预算：可用额度 = `budgetTokens - reservedTokens`（负数按 0）；从末尾逐条累计，
 *   放不下即止，更早的全部进 `older`；`usedTokens`/`overflowTokens` 为两侧的估算量。
 * - 原子组保护：切点使 `recent` 以 assistant 开头时，把紧邻其前的 user 一并移入；
 *   这可能让 `usedTokens` 略微超出额度（宁可高估，不拆轮次）。
 * - 轮数上限：**一轮 = 一条 user 消息 + 其后直到下一条 user 之前的全部消息**，
 *   即 `recent` 中的轮数等于其中的 user 条数；先按预算取，再按上限从最旧整轮丢弃
 *   （`keepRecentTurns ≤ 0` 视为 1 轮，至少留下最后一轮上下文）。
 */
export function planContext(rows: ChatMessage[], input: PlanInput): PlanResult {
  const list = Array.isArray(rows) ? rows : [];
  const headroom = Math.max(0, safeInt(input?.budgetTokens, 0) - safeInt(input?.reservedTokens, 0));
  const keep = safeInt(input?.keepRecentTurns, 1);

  if (!list.length) return { recent: [], older: [], usedTokens: 0, overflowTokens: 0 };

  // 1) 从末尾按预算累计（放不下的更早消息全部进 older）
  let cut = list.length;
  let used = 0;
  for (let i = list.length - 1; i >= 0; i--) {
    const cost = rowCost(list[i]);
    if (used + cost > headroom) break;
    used += cost;
    cut = i;
  }

  // 2) 原子组保护：recent 以 assistant 开头 → 把紧邻其前的 user 一并移入
  while (cut > 0 && cut < list.length && list[cut].role === "assistant") {
    const prev = list[cut - 1];
    if (prev.role !== "user") break;
    cut -= 1;
    used += rowCost(prev);
  }

  // 3) 轮数上限：从末尾数 user，第 keep 条 user 即最旧保留轮的起点，更早的整轮移入 older
  let limited = cut;
  let seen = 0;
  for (let i = list.length - 1; i >= cut; i--) {
    if (list[i].role !== "user") continue;
    seen += 1;
    if (seen === keep) {
      limited = i;
      break;
    }
  }

  const recent = list.slice(limited);
  const older = list.slice(0, limited);
  return {
    recent,
    older,
    usedTokens: estimateRowsTokens(recent),
    overflowTokens: estimateRowsTokens(older),
  };
}
