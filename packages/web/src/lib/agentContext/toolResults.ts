import type { ChatMessage } from "./types.js";
import { ROW_TOKEN_OVERHEAD, estimateTokens } from "./tokens.js";

/**
 * 工具结果的**回灌预算**（对应 Codex 的 retained tool outputs 思路）。
 *
 * 为什么需要它：工具轮每多一轮，请求里就多带一份「历史 + 之前的全部工具结果」。
 * 到第 5、6 轮，真正挤占预算的往往不是对话，而是几条巨大的工具输出。
 * 等供应商报 400 再压缩是**被动**的——用户已经等了两个来回。
 * 这里在**组装下一轮请求之前**就把较早的工具结果折叠掉，把超限变成不会发生。
 *
 * 口径（与 `planContext` 一致，测试锁定）：
 * - 只折叠 `role === "tool"` 的消息，用户/助手消息一律不动（它们是语义，不是数据）；
 * - 最近 `keepRecent` 条工具结果**永不折叠**——模型往往还在用它们；
 * - 从最旧的开始折叠，折叠到总量进入预算即停；
 * - 折叠是**替换内容为占位说明**，不是删除消息：删掉会让 tool_call 与 tool_result
 *   对不上，OpenAI 与 Anthropic 都会直接 400。
 */

/** 工具结果回灌预算（token）：约等于 8000 汉字，够 3–4 次中等查询并存。 */
export const MAX_TOOL_CONTEXT_TOKENS = 3000;

/** 最近 N 条工具结果永不折叠。 */
export const KEEP_RECENT_TOOL_RESULTS = 3;

export interface FoldOptions {
  budgetTokens?: number;
  keepRecent?: number;
  /** 折叠标记的措辞可覆盖（测试与不同展示场景用）。 */
  placeholder?: (info: { chars: number; index: number }) => string;
}

export interface FoldResult {
  rows: ChatMessage[];
  /** 实际被折叠的条数（0 = 未超预算，`rows` 就是入参本身）。 */
  folded: number;
  beforeTokens: number;
  afterTokens: number;
}

function toolCost(row: ChatMessage): number {
  return estimateTokens(String(row?.content ?? "")) + ROW_TOKEN_OVERHEAD;
}

/**
 * 折叠较早的工具结果，使总量进入预算。
 *
 * 未超预算时**返回入参本身**（同一引用）：调用方可据此判断「什么都没发生」，
 * 也避免每轮都产生一份新数组。
 */
export function foldToolResults(rows: ChatMessage[], options: FoldOptions = {}): FoldResult {
  const list = Array.isArray(rows) ? rows : [];
  const budget = Math.max(0, Math.floor(options.budgetTokens ?? MAX_TOOL_CONTEXT_TOKENS));
  const keepRecent = Math.max(0, Math.floor(options.keepRecent ?? KEEP_RECENT_TOOL_RESULTS));
  const placeholder =
    options.placeholder ??
    (({ chars }) => `（较早的工具结果已折叠：原 ${chars} 字符，如需重查请再次调用该工具）`);

  const beforeTokens = list.reduce((sum, row) => sum + toolCost(row), 0);
  if (beforeTokens <= budget) {
    return { rows: list, folded: 0, beforeTokens, afterTokens: beforeTokens };
  }

  /** 可折叠的候选下标：role=tool，且不在「最近 keepRecent 条」里。 */
  const toolIndexes: number[] = [];
  list.forEach((row, i) => {
    if (row?.role === "tool") toolIndexes.push(i);
  });
  const candidates = toolIndexes.slice(0, Math.max(0, toolIndexes.length - keepRecent));
  if (!candidates.length) {
    return { rows: list, folded: 0, beforeTokens, afterTokens: beforeTokens };
  }

  const next = list.slice();
  let current = beforeTokens;
  let folded = 0;
  for (const i of candidates) {
    if (current <= budget) break;
    const row = next[i];
    const text = String(row?.content ?? "");
    const replacement = placeholder({ chars: text.length, index: i });
    const saved = toolCost(row) - (estimateTokens(replacement) + ROW_TOKEN_OVERHEAD);
    // 折叠反而更长（内容本来只有几十字）时不折腾：换掉也省不下 token，
    // 却让模型看不到原文。
    if (saved <= 0) continue;
    next[i] = { ...row, content: replacement };
    current -= saved;
    folded += 1;
  }

  return { rows: next, folded, beforeTokens, afterTokens: current };
}
