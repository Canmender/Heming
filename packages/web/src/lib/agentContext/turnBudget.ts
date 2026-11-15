import { DEFAULT_BUDGET_TOKENS, DEFAULT_RESERVED_TOKENS } from "./budget.js";
import { MAX_TOOL_CONTEXT_TOKENS } from "./toolResults.js";

/**
 * 每请求预算账本（P2-T11）。
 *
 * 为什么需要：P0 之前，三处闸门各说各话——
 * - `planContext` 管历史（默认 6000，含 900 注入预留）；
 * - `foldToolResults` 管工具结果（3000）；
 * - `agentStream` 管单轮工具轮（12000）。
 * 三个数字谁都不管谁，于是长会话里可能「历史按 6000 切完、再叠 3000 工具结果、
 * 加上系统提示词」一次请求就顶到供应商上限，报 400 之后才被动重试。
 *
 * 这里的口径只有一句：**一次请求 = 系统提示词 + 历史（含摘要）+ 本轮工具结果**，
 * 三者共享同一个 context 上限；工具结果另有两个更紧的上限（折叠预算、单轮累计）。
 * 闸门只从这一个账本取数，改上限只改这里。
 */

/** 一次请求的三个上限（token）。 */
export interface TurnBudgetCaps {
  /** 整次请求（系统 + 历史 + 工具结果）的上限。 */
  context: number;
  /** 历史里工具结果未折叠部分的上限（交给 `foldToolResults`）。 */
  toolContext: number;
  /** 单轮工具回灌累计上限（超过就不再开新一轮）。 */
  turnTool: number;
  /** 注入侧（系统提示词 + 记忆段 + 技能段）预留。 */
  reserved: number;
}

/** 默认上限：与 P0 现状一致，只是搬到同一个账本里。 */
export const DEFAULT_TURN_CAPS: TurnBudgetCaps = {
  context: DEFAULT_BUDGET_TOKENS,
  toolContext: MAX_TOOL_CONTEXT_TOKENS,
  turnTool: 12_000,
  reserved: DEFAULT_RESERVED_TOKENS,
};

export interface TurnBudgetInput {
  caps?: Partial<TurnBudgetCaps>;
  /** 系统提示词（含工具清单）估算 token。 */
  systemTokens?: number;
  /** 历史（recent + 摘要）估算 token。 */
  historyTokens?: number;
  /** 本轮已回灌的工具结果估算 token。 */
  toolTokens?: number;
}

export type TurnBudgetGate = "context" | "toolResults" | "turn";

export interface TurnBudgetPlan {
  caps: TurnBudgetCaps;
  used: { system: number; history: number; toolResults: number; total: number };
  /** 还剩多少可用：`history` 是 `planContext` 能用的额度，`toolResults` 是折叠预算剩余。 */
  remaining: { context: number; history: number; toolResults: number; turn: number };
  /** 超限的闸门（空数组 = 全部在限内）。 */
  over: TurnBudgetGate[];
  verdict: "ok" | "over";
}

function nonNegative(value: unknown): number {
  return typeof value === "number" && Number.isFinite(value) ? Math.max(0, Math.floor(value)) : 0;
}

/**
 * 算一次请求的预算账。
 *
 * 注意 `remaining.history`：`planContext` 的 `reservedTokens` 语义是「从总预算里再扣掉
 * 注入侧」，所以这里直接给出**它可以用的净值**，避免调用方再减一次（减两次是这类
 * 预算 bug 的经典来源）。
 *
 * 系统提示词**已包含在 `reserved` 那份注入预留里**（设计 §3.2：900 覆盖系统提示词 +
 * 记忆段 + 技能段）。只有它超出预留信封时才从历史额度里再扣超出部分——否则就是
 * 同一块内容被扣两次，历史会被压得过狠。
 */
export function planTurnBudget(input: TurnBudgetInput = {}): TurnBudgetPlan {
  const caps: TurnBudgetCaps = { ...DEFAULT_TURN_CAPS };
  const patch = input.caps ?? {};
  for (const key of ["context", "toolContext", "turnTool", "reserved"] as const) {
    const value = patch[key];
    if (typeof value === "number" && Number.isFinite(value)) caps[key] = Math.max(0, Math.floor(value));
  }

  const system = nonNegative(input.systemTokens);
  const history = nonNegative(input.historyTokens);
  const toolResults = nonNegative(input.toolTokens);
  const total = system + history + toolResults;

  const over: TurnBudgetGate[] = [];
  if (total > caps.context) over.push("context");
  if (toolResults > caps.toolContext) over.push("toolResults");
  if (toolResults > caps.turnTool) over.push("turn");

  /** 系统提示词超出注入预留的部分（在预留内不重复扣历史）。 */
  const systemExcess = Math.max(0, system - caps.reserved);

  return {
    caps,
    used: { system, history, toolResults, total },
    remaining: {
      context: Math.max(0, caps.context - total),
      history: Math.max(0, caps.context - caps.reserved - systemExcess - toolResults),
      toolResults: Math.max(0, caps.toolContext - toolResults),
      turn: Math.max(0, caps.turnTool - toolResults),
    },
    over,
    verdict: over.length ? "over" : "ok",
  };
}
