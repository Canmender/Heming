import type { InjectedItem, MemoryLayer } from "./format.js";
import { tokenize } from "./tokenize.js";

/**
 * 记忆引用判定（可观测性）：**字符串级、确定性、零额外模型调用**。
 *
 * 为什么不用「再问一次模型你用了哪条记忆」：那是第二次 LLM 成本，且答案本身不可复现
 * （同一份注入这次说用了、下次说没用），用户在记忆区看到的「引用」就成了玄学。
 * 这里只做一件事——注入文本的词有没有出现在回答里，出现多少**个不同词**。
 * 判据刻意保守（见 USAGE_MIN_HITS）：宁可漏报「其实用了」，也不要误报「用了这条」，
 * 因为误报会让用户以为记忆系统在瞎认功，比沉默更伤信任。
 *
 * 口径与 agentStream 的来源脚注一致：**与模型是否在正文里复述无关**，
 * 这是一个提示层与回答层的重合度指标，不是因果证明。UI 必须按「疑似引用」呈现。
 */

/** 至少命中这么多**不同词**才算疑似引用（单个大词双词都太容易撞）。 */
export const USAGE_MIN_HITS = 2;
/** 只有 1 个命中词时，词本身长度达到此值（如 `react`、`8787`）也算——长词几乎不会白撞。 */
export const USAGE_STRONG_TOKEN_LEN = 3;

/** 一次疑似引用：`hits` 是命中的词（最多留 6 个，够 UI 解释「凭什么叫命中」）。 */
export interface UsageMatch {
  id: string;
  layer: MemoryLayer;
  hits: string[];
}

/** 情景注入行的日期前缀（`2026-10-16：…`）是排版产物，不是记忆内容。 */
const EPISODIC_DATE_PREFIX = /^\d{4}-\d{2}-\d{2}：/;

/**
 * 判定哪些注入项疑似被回答用到。
 *
 * 只看语义／情景两层：工作层就是刚才那几轮对话，回答必然复述其中的词，
 * 「命中」在这里恒为真，等于没有信息量，还会把真正的长期记忆信号淹掉。
 *
 * 匹配对象是 `content`（**截断后的实际注入文本**）而不是原始条目：
 * 模型看到的只有被预算裁过的那半句，拿全文去比对会把「模型没看到的部分」也算成命中。
 */
export function matchUsage(answer: string, injected: InjectedItem[]): UsageMatch[] {
  const answerTokens = new Set(tokenize(answer ?? ""));
  if (!answerTokens.size) return [];
  const out: UsageMatch[] = [];
  for (const item of injected) {
    if (item.layer === "working" || item.id === "focus") continue;
    const content = item.layer === "episodic" ? item.content.replace(EPISODIC_DATE_PREFIX, "") : item.content;
    const hits: string[] = [];
    for (const token of tokenize(content)) {
      if (!answerTokens.has(token)) continue;
      if (!hits.includes(token)) hits.push(token);
    }
    const strong = hits.length === 1 && hits[0].length >= USAGE_STRONG_TOKEN_LEN;
    if (hits.length < USAGE_MIN_HITS && !strong) continue;
    out.push({ id: item.id, layer: item.layer, hits: hits.slice(0, 6) });
  }
  return out;
}
