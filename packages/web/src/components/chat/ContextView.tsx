import { transcriptOf, useChatStore } from "../../store/chat.js";
import { ROW_TOKEN_OVERHEAD, estimateTokens } from "../../lib/agentContext/tokens.js";
import { DEFAULT_BUDGET_TOKENS, DEFAULT_RESERVED_TOKENS } from "../../lib/agentContext/budget.js";

/**
 * 「上下文」页签（T32）：本会话的上下文预算用量。
 *
 * 口径与 `lib/agentContext` 的实际预算一致，不另立一套：
 * - 每条消息 = `estimateTokens(正文) + ROW_TOKEN_OVERHEAD`（与 planContext 的 rowCost 同式）；
 * - 总预算 = DEFAULT_BUDGET_TOKENS；注入预留 = DEFAULT_RESERVED_TOKENS（系统提示词/记忆/技能）。
 *
 * 为什么不显示「百分比 + 进度条」就够：用户真正想回答的是「还能塞多少、为什么被截断」，
 * 所以下面三行明细必须是真实计数（消息条数、工具结果条数、预留额度），
 * 取不到就是 0，不编一个看起来合理的数字。
 */
export function ContextView({ conversationId }: { conversationId: string | null }) {
  const messages = useChatStore((s) => (conversationId ? s.messages[conversationId] : undefined));
  const rows = messages ?? [];

  let used = 0;
  let toolResults = 0;
  for (const row of rows) {
    used += estimateTokens(row.payload?.text ?? "") + ROW_TOKEN_OVERHEAD;
    toolResults += transcriptOf(row)?.tools?.length ?? 0;
  }

  const budget = DEFAULT_BUDGET_TOKENS;
  // 进度条宽度按比例给，但 aria-valuenow 报真实用量（超预算时进度条封顶、数字说真话）。
  const ratio = budget > 0 ? Math.min(1, used / budget) : 0;

  return (
    <section aria-label="上下文" data-view-panel="context">
      <h3 className="ui-section-title mb-3">上下文</h3>
      <div className="rounded-lg border border-line-soft bg-surface p-3">
        <div
          role="progressbar"
          aria-label="上下文预算"
          aria-valuemin={0}
          aria-valuemax={budget}
          aria-valuenow={used}
          aria-valuetext={`${used} / ${budget} tokens`}
          className="h-2 w-full overflow-hidden rounded-full bg-subtle-3"
        >
          <div
            className="h-full rounded-full bg-accent transition-[width] motion-reduce:transition-none"
            style={{ width: `${Math.round(ratio * 100)}%` }}
          />
        </div>
        <p className="mt-2 text-ui-sm tabular-nums text-ink">
          {used} / {budget} tokens
        </p>
      </div>
      {/* 明细三行：数字全部来自本会话真实数据（消息条数 / 工具结果条数 / 注入预留额度）。 */}
      <ul aria-label="上下文明细" className="mt-3 list-none space-y-1.5 p-0">
        <li className="flex items-baseline justify-between gap-3 text-ui-sm">
          <span className="text-muted">消息</span>
          <span className="shrink-0 tabular-nums text-ink">{rows.length} 条</span>
        </li>
        <li className="flex items-baseline justify-between gap-3 text-ui-sm">
          <span className="text-muted">工具结果</span>
          <span className="shrink-0 tabular-nums text-ink">{toolResults} 条</span>
        </li>
        <li className="flex items-baseline justify-between gap-3 text-ui-sm">
          <span className="text-muted">注入预留</span>
          <span className="shrink-0 tabular-nums text-ink">{DEFAULT_RESERVED_TOKENS} tokens</span>
        </li>
      </ul>
    </section>
  );
}
