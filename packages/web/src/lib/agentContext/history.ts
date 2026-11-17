import type { ChatMessage } from "./types.js";
import { DEFAULT_RESERVED_TOKENS, planContext } from "./budget.js";
import { estimateRowsTokens } from "./tokens.js";
import { planTurnBudget } from "./turnBudget.js";
import { SUMMARY_HEADER, SUMMARY_NOTICE, buildSummaryPrompt, deterministicSummary } from "./summary.js";
import { normalizeContextSettings, type ContextSettings } from "./settings.js";
import { setManualSummary, takeManualSummary } from "./manualCompact.js";
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
   * 强制折叠（d.183，手动 `/compact`）：即使历史「本来就放得下」也把除最后一轮以外的
   * 全部压成摘要。`aggressive` 是为了让**重试的那次请求真的变短**，`force` 是为了让
   * **用户主动要压缩时立刻生效**——目标相同（变短），触发理由不同，所以拆成两个开关。
   */
  force?: boolean;
  /**
   * 摘要缓存的会话分桶键。计划 Task A 的签名未含此项（可选、缺省空串），
   * 不加也能跑；由触发端传入才能让「每会话 20 条」真正按会话隔离。
   */
  conversationId?: string;
  /**
   * 系统提示词估算 token（P2-T11）：给了就算进同一个预算账，
   * 历史额度 = context - 预留 - 系统 - 本轮工具结果。
   */
  systemTokens?: number;
  /** 本轮已回灌的工具结果估算 token（P2-T11）。 */
  toolTokens?: number;
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
    /**
     * P2-T11：历史额度从统一账本算——`planContext` 的 `reservedTokens` 语义是
     * 「从总预算里再扣掉注入侧」，所以这里传 `budget - remaining.history`，
     * 效果等于再扣掉系统提示词与本轮工具结果（不再各算各的）。
     */
    const ledger = planTurnBudget({
      caps: { context: effective.budgetTokens },
      systemTokens: deps.systemTokens,
      toolTokens: deps.toolTokens,
    });
    const reservedForHistory = Math.max(
      0,
      effective.budgetTokens - ledger.remaining.history,
    );
    let plan = planContext(source, {
      budgetTokens: effective.budgetTokens,
      keepRecentTurns: effective.keepRecentTurns,
      reservedTokens: deps.reservedTokens ?? reservedForHistory,
    });
    if (!plan.older.length) {
      // ★ 溢出重试的真实痛点：如果历史本来就全放得下，`older` 为空 → 原样返回 →
      // 重试发出去的请求和上一次**一模一样**，必然再撞同一个 400（纯浪费一次调用）。
      // 重试轮必须真的变短：强制只留最后一轮原文，其余全部压成摘要。
      if (!deps.force && (!deps.aggressive || source.length <= 2)) return source;
      let lastUser = source.length - 1;
      while (lastUser > 0 && source[lastUser].role !== "user") lastUser -= 1;
      const recent = source.slice(lastUser);
      const older = source.slice(0, lastUser);
      if (!older.length) return source;
      plan = {
        recent,
        older,
        usedTokens: estimateRowsTokens(recent),
        overflowTokens: estimateRowsTokens(older),
      };
    }

    // 切点保护：`plan.recent` 的第 0 条不能是 role=tool ——
    // 那条工具结果对应的 assistant(tool_calls) 已经进摘要（被切走了），
    // 只发 tool 消息会被供应商判 400（「tool 消息没有对应的 tool_call」）。
    // 宁可丢掉这几条工具结果，也不能让整轮请求失败。
    const start = plan.recent.findIndex((row) => row.role !== "tool");
    if (start > 0) plan.recent.splice(0, start);

    const cache = deps.cache;
    const conversationId = deps.conversationId ?? "";
    const fingerprint = cache ? cache.fingerprint(conversationId, plan.older) : "";
    /**
     * 手动压缩（d.183）：用户在 `/compact` 里生成的那段摘要优先用掉，且**只用一次**。
     * 它不走指纹缓存的原因见 `manualCompact.ts`——发送路径上的行没有工具配对，
     * 指纹对不上会让「点完压缩下一轮照样重新摘要」，白等一次。
     */
    const manual = conversationId ? takeManualSummary(conversationId) : "";
    let summary = manual || (cache ? cache.get(conversationId, fingerprint) : "") || "";

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

/**
 * 这次准备里折掉了多少条原始消息（d.217）。
 *
 * `prepareHistory` 的返回值只有「要发出去的 messages」，折叠了几条是内部信息；
 * 界面需要它来解释「它怎么忘了我刚才说的话」。判据与 `compactNow` 完全一致：
 * 头是 system 且以摘要骨架开头，才算「真的折了」——否则返回 0，不编数字。
 */
export function countFoldedMessages(rows: ChatMessage[], prepared: ChatMessage[]): number {
  const head = prepared[0];
  if (!head || head.role !== "system") return 0;
  if (typeof head.content !== "string" || !head.content.startsWith(SUMMARY_HEADER)) return 0;
  const folded = rows.length - (prepared.length - 1);
  return folded > 0 ? folded : 0;
}

/** 手动压缩（d.183）的返回：消息 + 给用户/界面看的统计。 */export interface CompactResult {
  /** 压缩后真正要发出去的 messages（未压缩时与入参同序）。 */
  messages: ChatMessage[];
  /** 是否真的折叠了东西（只有一轮、或全是系统消息时为 false）。 */
  compacted: boolean;
  /** 摘要正文（含固定骨架标题与背景声明；未压缩时为空串）。 */
  summary: string;
  /** 被折叠进摘要的原始消息条数。 */
  foldedCount: number;
  beforeTokens: number;
  afterTokens: number;
}

/**
 * 手动压缩（d.183）：把当前历史的**除最后一轮以外**全部折叠成一段摘要。
 *
 * 与自动压缩的关系：自动压缩由预算触发（`prepareHistory` 的 `older` 非空才折），
 * 这里由**用户按需触发**（输入 `/compact`），所以走 `force`——即使历史本来放得下也折，
 * 让「我现在就想让它轻一点」成为可执行的动作，而不是只能等预算撞墙。
 *
 * 摘要写进同一个 `SummaryCache`：下一轮真实请求命中缓存，不会再花一次摘要调用。
 */
export async function compactNow(
  rows: ChatMessage[],
  deps: PrepareHistoryDeps = {},
): Promise<CompactResult> {
  const source = Array.isArray(rows) ? rows : [];
  const messages = await prepareHistory(source, { ...deps, force: true });
  const head = messages[0];
  const compacted =
    head?.role === "system" &&
    typeof head.content === "string" &&
    head.content.startsWith(SUMMARY_HEADER);
  const beforeTokens = estimateRowsTokens(source);
  const afterTokens = estimateRowsTokens(messages);
  /**
   * 压缩本身也要占地方：摘要 + 背景声明约几百 token。对话还短的时候强行折叠，
   * 结果是**发出去的内容反而更多**，而且真实信息被换成摘要——纯亏。
   * 所以「压缩完不比原来省」就当没发生：如实回 `compacted: false` 并带上两个数字，
   * 由界面告诉用户「这段还短，压了不划算」，而不是悄悄把他刚说的话换掉。
   */
  const worthwhile = compacted && afterTokens < beforeTokens;
  const conversationId = String(deps.conversationId ?? "").trim();
  if (worthwhile && conversationId) {
    /**
     * 存**正文**而不是整条消息：`prepareHistory` 会重新加骨架标题与背景声明，
     * 存渲染后的整条会变成「标题 + 正文 + 声明 + 声明」两份声明（实测抓到的重复）。
     */
    const body = bodyOf(String(messages[0]?.content ?? ""))
      .split("\n")
      .filter((line) => !line.trimStart().startsWith("> "))
      .join("\n")
      .trim();
    if (body) setManualSummary(conversationId, body);
  }
  return {
    messages: worthwhile ? messages : source,
    compacted: worthwhile,
    summary: worthwhile ? String(messages[0]?.content ?? "") : "",
    foldedCount: worthwhile ? Math.max(0, source.length - (messages.length - 1)) : 0,
    beforeTokens,
    afterTokens: worthwhile ? afterTokens : beforeTokens,
  };
}
