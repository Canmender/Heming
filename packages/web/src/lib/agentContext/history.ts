import type { ChatMessage } from "./types.js";
import { DEFAULT_RESERVED_TOKENS, planContext } from "./budget.js";
import { SUMMARY_HEADER, SUMMARY_NOTICE, buildSummaryPrompt, deterministicSummary } from "./summary.js";
import { normalizeContextSettings, type ContextSettings } from "./settings.js";
import type { SummaryCache } from "./store.js";

/**
 * 触发链路的上下文准备（设计 §4）：预算切分 → 早期对话压缩为一段摘要 →
 * `[system 摘要, ...recent]`。**任何失败都回落「原样发送」**，绝不阻断生成。
 */

export interface PrepareHistoryDeps {
  settings?: ContextSettings;
  cache?: SummaryCache;
  /** 注入侧（系统提示词 + 记忆段 + 技能段）预留 token；缺省按设计上界 900。 */
  reservedTokens?: number;
  /** LLM 摘要：入参即 `buildSummaryPrompt` 的结果，可直接交给 `streamChat`；返回 null/抛错 → 确定性回落。 */
  summarize?: (messages: ChatMessage[]) => Promise<string | null>;
  /** 溢出重试级别：1 = 半预算/半轮数，2 = 四分之一预算/2 轮（设计 §3.4）。 */
  aggressive?: 1 | 2;
  /**
   * 摘要缓存的会话分桶键。计划 Task A 的签名未含此项（可选、缺省空串），
   * 不加也能跑；由触发端传入才能让「每会话 20 条」真正按会话隔离。
   */
  conversationId?: string;
}

/** 溢出重试的两次收紧（设计 §3.4）：只动预算与轮数，其余照旧。 */
function tighten(settings: ContextSettings, aggressive?: 1 | 2): ContextSettings {
  if (aggressive === 1) {
    return {
      ...settings,
      budgetTokens: Math.max(1, Math.round(settings.budgetTokens * 0.5)),
      keepRecentTurns: Math.max(2, Math.floor(settings.keepRecentTurns / 2)),
    };
  }
  if (aggressive === 2) {
    return {
      ...settings,
      budgetTokens: Math.max(1, Math.round(settings.budgetTokens * 0.25)),
      keepRecentTurns: 2,
    };
  }
  return settings;
}

/** 摘要正文：模型/回落摘要自带骨架标题时去掉，避免与统一抬头重复。 */
function bodyOf(summary: string): string {
  const text = summary.trim();
  return text.startsWith(SUMMARY_HEADER) ? text.slice(SUMMARY_HEADER.length).trim() : text;
}

/**
 * 准备发送给模型的历史（五条分支，测试逐条锁定）：
 * 1. 预算关闭 / rows 为空 → 原样返回；
 * 2. `older` 为空（全放得下）→ 原样返回；
 * 3. 摘要命中缓存 → 直接用（不再发请求）；
 * 4. 未命中：`llmSummary && summarize` 时 await 一次（失败/返回空白 → 确定性摘要），
 *    否则直接用确定性摘要；LLM 摘要成功才写入缓存（确定性摘要零成本，不占缓存额度）；
 * 5. 摘要为空串 → 丢弃摘要只发 recent（不留空的 system 消息）；任何异常 → 原样返回。
 */
export async function prepareHistory(
  rows: ChatMessage[],
  deps: PrepareHistoryDeps = {},
): Promise<ChatMessage[]> {
  const source = Array.isArray(rows) ? rows : [];
  try {
    const settings = normalizeContextSettings(deps.settings);
    if (!settings.enabled || !source.length) return source;

    const effective = tighten(settings, deps.aggressive);
    const plan = planContext(source, {
      budgetTokens: effective.budgetTokens,
      keepRecentTurns: effective.keepRecentTurns,
      reservedTokens: deps.reservedTokens ?? DEFAULT_RESERVED_TOKENS,
    });
    if (!plan.older.length) return source;

    const cache = deps.cache;
    const conversationId = deps.conversationId ?? "";
    const fingerprint = cache ? cache.fingerprint(conversationId, plan.older) : "";
    let summary = (cache ? cache.get(conversationId, fingerprint) : "") ?? "";

    if (!summary && effective.llmSummary && deps.summarize) {
      try {
        const text = await deps.summarize(buildSummaryPrompt(plan.older));
        if (typeof text === "string" && text.trim()) {
          summary = text.trim();
          cache?.set(conversationId, fingerprint, summary);
        }
      } catch {
        /* LLM 摘要失败 → 走确定性回落（不阻断生成） */
      }
    }
    if (!summary) summary = deterministicSummary(plan.older);
    if (!summary) return plan.recent;

    const content = [SUMMARY_HEADER, bodyOf(summary), `> ${SUMMARY_NOTICE}`].join("\n");
    return [{ role: "system", content }, ...plan.recent];
  } catch {
    return source;
  }
}
