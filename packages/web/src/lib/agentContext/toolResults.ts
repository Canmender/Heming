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
 * - 预算只按工具结果统计（用户贴的长文档不该把工具结果挤掉）；
 * - 最近 `keepRecent` 条工具结果**永不折叠**——模型往往还在用它们；
 * - 从最旧的开始折叠，折叠到工具结果总量进入预算即停；
 * - 折叠是**替换内容为占位说明**，不是删除消息：删掉会让 tool_call 与 tool_result
 *   对不上，OpenAI 与 Anthropic 都会直接 400。
 */

/** 工具结果回灌预算（token）：约等于 8000 汉字，够 3–4 次中等查询并存。 */
export const MAX_TOOL_CONTEXT_TOKENS = 3000;

/** 最近 N 条工具结果永不折叠。 */
export const KEEP_RECENT_TOOL_RESULTS = 3;

/**
 * 同一工具保留最近几条**全文**（P2-T10）。
 *
 * 为什么按工具名合并：一次任务里 file_read 读 5 个文件、file_patch 改 3 处是常态，
 * 这些结果除了最近一条，其余几乎不会被再引用，却每轮都要重发。把它们压成单行摘要
 * （保留文件名/首行，能认出是哪一条），既省 token 又不让模型失忆。
 */
export const KEEP_RECENT_SAME_TOOL = 1;

export interface FoldOptions {
  budgetTokens?: number;
  keepRecent?: number;
  /** 同名工具结果保留最近几条全文（默认 1；更早的压成单行摘要）。 */
  keepRecentSameTool?: number;
  /** 折叠标记的措辞可覆盖（测试与不同展示场景用）。 */
  placeholder?: (info: { chars: number; index: number }) => string;
}

export interface FoldResult {
  rows: ChatMessage[];
  /** 实际被折叠的条数（0 = 未超预算，`rows` 就是入参本身）。 */
  folded: number;
  /** 因「同名工具重复」被压成单行摘要的条数（P2-T10）。 */
  merged: number;
  beforeTokens: number;
  afterTokens: number;
}

function toolCost(row: ChatMessage): number {
  return estimateTokens(String(row?.content ?? "")) + ROW_TOKEN_OVERHEAD;
}

/**
 * 同名工具结果的单行摘要（P2-T10）。
 *
 * 保留「首行 + 字符数」：首行通常就是路径/命令/标题，模型据此能认出是哪一次调用；
 * 字符数让它知道原文有多长、要不要重查。
 */
export function summarizeToolResult(row: ChatMessage): string {
  const text = String(row?.content ?? "").trim();
  const firstLine = text.split("\n")[0]?.trim() ?? "";
  // 按码点截断：slice(0, 80) 按 UTF-16 单元切，边界落在 emoji 代理对中间会留下落单代理，
  // 摘要回灌给模型时变成乱码方块。首行通常是路径/命令，多字节字符很常见。
  const points = [...firstLine];
  const clipped = points.length > 80 ? `${points.slice(0, 80).join("")}…` : firstLine;
  const name = row?.name ?? "工具";
  return `（较早的 ${name} 结果已折叠为单行摘要：${clipped || "（空）"}；原文 ${text.length} 字符，如需重查请再次调用该工具）`;
}

/**
 * 折叠较早的工具结果，使总量进入预算。
 *
 * 两遍（P2-T10）：
 * 1. **同名合并**：同一工具更早的结果压成单行摘要（最近 `keepRecentSameTool` 条保留全文）；
 * 2. **预算折叠**：仍超预算时，从最旧的开始换成占位说明。
 *
 * 未发生任何变化时**返回入参本身**（同一引用）：调用方可据此判断「什么都没发生」，
 * 也避免每轮都产生一份新数组。
 */
export function foldToolResults(rows: ChatMessage[], options: FoldOptions = {}): FoldResult {
  const list = Array.isArray(rows) ? rows : [];
  const budget = Math.max(0, Math.floor(options.budgetTokens ?? MAX_TOOL_CONTEXT_TOKENS));
  const keepRecent = Math.max(0, Math.floor(options.keepRecent ?? KEEP_RECENT_TOOL_RESULTS));
  const keepSameTool = Math.max(0, Math.floor(options.keepRecentSameTool ?? KEEP_RECENT_SAME_TOOL));
  const placeholder =
    options.placeholder ??
    (({ chars }) => `（较早的工具结果已折叠：原 ${chars} 字符，如需重查请再次调用该工具）`);

  /**
   * 只统计工具结果本身（P2-9）：这个预算管的是「工具输出占了多少」，
   * 用户/助手文本不是折叠对象——把它们算进来，会在用户贴长文档时白折掉
   * 还有用的工具结果，而且折完预算照样超（白丢上下文、不见效）。
   */
  const beforeTokens = list.reduce(
    (sum, row) => (row?.role === "tool" ? sum + toolCost(row) : sum),
    0,
  );

  const next = list.slice();
  let current = beforeTokens;
  let merged = 0;
  /** 已被压成摘要的下标：第二遍不再覆盖它们（摘要已够小，再换占位只会丢信息）。 */
  const mergedIndexes = new Set<number>();

  /** 可折叠的候选下标：role=tool，且不在「最近 keepRecent 条」里。 */
  const toolIndexes: number[] = [];
  list.forEach((row, i) => {
    if (row?.role === "tool") toolIndexes.push(i);
  });
  const candidates = toolIndexes.slice(0, Math.max(0, toolIndexes.length - keepRecent));

  // 第一遍：同名工具只留最近 keepSameTool 条全文，更早的压成单行摘要。
  const byName = new Map<string, number[]>();
  for (const i of candidates) {
    const key = next[i]?.name ?? "";
    const bucket = byName.get(key);
    if (bucket) bucket.push(i);
    else byName.set(key, [i]);
  }
  for (const bucket of byName.values()) {
    const redundant = bucket.slice(0, Math.max(0, bucket.length - keepSameTool));
    for (const i of redundant) {
      const row = next[i];
      const text = String(row?.content ?? "");
      // 带图片说明的结果不压：那几行是「模型看不到图」的唯一解释，压掉会误导。
      if (text.includes("张图片")) continue;
      const summary = summarizeToolResult(row);
      const saved = toolCost(row) - (estimateTokens(summary) + ROW_TOKEN_OVERHEAD);
      if (saved <= 0) continue;
      next[i] = { ...row, content: summary };
      current -= saved;
      merged += 1;
      mergedIndexes.add(i);
    }
  }

  if (current <= budget) {
    return merged
      ? { rows: next, folded: 0, merged, beforeTokens, afterTokens: current }
      : { rows: list, folded: 0, merged: 0, beforeTokens, afterTokens: beforeTokens };
  }
  if (!candidates.length) {
    return { rows: merged ? next : list, folded: 0, merged, beforeTokens, afterTokens: current };
  }

  // 第二遍：仍超预算，从最旧的开始换成占位说明。
  let folded = 0;
  for (const i of candidates) {
    if (current <= budget) break;
    if (mergedIndexes.has(i)) continue;
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

  return { rows: next, folded, merged, beforeTokens, afterTokens: current };
}
