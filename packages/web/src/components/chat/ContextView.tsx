import { useMemo } from "react";
import { transcriptOf, useChatStore } from "../../store/chat.js";
import {
  recordsForConversation,
  totalsOf,
  useTokenUsageStore,
  type UsageRecord,
} from "../../store/tokenUsage.js";
import { rolloutLog } from "../../lib/rollout/index.js";
import { failureCounts, streamUsageTotals, toolTimings } from "../../lib/rollout/view.js";
import type { RolloutTurnFailure } from "../../lib/rollout/types.js";
import { ROW_TOKEN_OVERHEAD, estimateTokens } from "../../lib/agentContext/tokens.js";
import { RecallLog } from "../../lib/memory/recallLog.js";
import { RECALL_DROP_LABELS, explainRecalls, recallLayerLabel } from "../../lib/memory/explain.js";
import { DEFAULT_BUDGET_TOKENS, DEFAULT_RESERVED_TOKENS } from "../../lib/agentContext/budget.js";

/** 一个回合（stream）的用量 + 工具耗时（数据来自记账 + 回放日志，两处都是本机真实数据）。 */
interface TurnUsageRow {
  streamId: string;
  model: string;
  tokens: number | null;
  /** 回放日志里的轮次数与缓存拆分；旧日志没有就是 undefined（界面显示「—」）。 */
  rounds?: number;
  cacheRead?: number;
  /** 工具调用耗时合计与次数（被拒调用不计耗时）。 */
  toolMs?: number;
  toolCount: number;
  /** 完成证据（P3-T15）：本回合成功的写入文件数与动作数；没有证据就是 undefined。 */
  evidenceFiles?: number;
  evidenceCommands?: number;
}

const MAX_TURN_ROWS = 5;

/**
 * 把本会话的记账记录按回合（streamId）折叠，并尽量补上回放日志里的
 * 轮次数 / 缓存读 / 工具耗时。
 *
 * 为什么要两处合并：记账回答「花了多少」，回放日志回答「贵在哪」（轮次、缓存、工具耗时）。
 * 两者都可能缺（老记录没有 streamId、日志被清过），缺就是缺，界面不编数字。
 */
function turnRowsOf(records: UsageRecord[]): TurnUsageRow[] {
  const byStream = new Map<string, TurnUsageRow>();
  for (const r of records) {
    if (!r.streamId) continue;
    const existing = byStream.get(r.streamId);
    if (existing) {
      // 同一回合理论上只记一次；真出现多次就累加，接口不会漏掉钱。
      existing.tokens = existing.tokens === null || r.tokens === null ? null : existing.tokens + r.tokens;
      continue;
    }
    byStream.set(r.streamId, {
      streamId: r.streamId,
      model: r.model,
      tokens: r.tokens,
      toolCount: 0,
    });
  }

  const rows: TurnUsageRow[] = [];
  for (const row of byStream.values()) {
    let items: ReturnType<typeof rolloutLog.read> = [];
    try {
      items = rolloutLog.read(row.streamId);
    } catch {
      items = []; // 日志读不出来不影响记账口径
    }
    if (items.length > 0) {
      const usage = streamUsageTotals(items);
      if (usage.reported) {
        row.rounds = usage.rounds;
        row.cacheRead = usage.cacheRead;
      }
      const timings = toolTimings(items);
      row.toolCount = timings.length;
      const evidence = items.find((it) => it.type === "assistant_final")?.evidence;
      if (evidence) {
        if (evidence.files.length > 0) row.evidenceFiles = evidence.files.length;
        if (evidence.commands.length > 0) row.evidenceCommands = evidence.commands.length;
      }
      const totalMs = timings.reduce((sum, t) => sum + (t.ms ?? 0), 0);
      if (totalMs > 0) row.toolMs = totalMs;
    }
    rows.push(row);
  }
  return rows.slice(-MAX_TURN_ROWS).reverse();
}

function formatTokens(n: number): string {
  return n >= 10_000 ? `${(n / 1000).toFixed(1)}k` : String(n);
}

function formatMs(ms: number): string {
  return ms < 1000 ? `${Math.round(ms)}ms` : `${(ms / 1000).toFixed(1)}s`;
}

/**
 * 失败归因的人话标签（P3-T16）。键与 `RolloutTurnFailure` 同源：
 * 少一个键就编译不过，不会出现「报表里有一类没名字」。
 */
const FAILURE_LABELS: Record<RolloutTurnFailure, string> = {
  context_overflow: "上下文超限",
  tool_error: "工具报错",
  model_refusal: "模型拒答",
  hitl_denied: "HITL 拒绝",
  max_rounds: "轮次打满",
  provider_error: "上游异常",
};

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
  const records = useTokenUsageStore((s) => s.records);

  let used = 0;
  let toolResults = 0;
  for (const row of rows) {
    used += estimateTokens(row.payload?.text ?? "") + ROW_TOKEN_OVERHEAD;
    toolResults += transcriptOf(row)?.tools?.length ?? 0;
  }

  const budget = DEFAULT_BUDGET_TOKENS;
  // 进度条宽度按比例给，但 aria-valuenow 报真实用量（超预算时进度条封顶、数字说真话）。
  const ratio = budget > 0 ? Math.min(1, used / budget) : 0;

  // 本会话的**真实消耗**（P0-T2）：只认显式带 conversationId 的记账，归不到的不算进来。
  const usage = useMemo(() => {
    const conv = recordsForConversation(records, conversationId ?? "");
    return { totals: totalsOf(conv), turns: turnRowsOf(conv), streams: conv };
  }, [records, conversationId]);

  /**
   * 失败归因（P3-T16）：只看本会话记账里出现过的那几条回合日志。
   *
   * 为什么以记账为入口而不是遍历全部日志：日志最多 20 条回合，但没有「会话 → 回合」
   * 索引；记账是唯一显式知道归属的地方，用它筛出来的集合与「本会话消耗」完全一致，
   * 两张表不会一个说 5 条一个说 3 条。
   */
  const failures = useMemo(() => {
    const items = [];
    const seen = new Set<string>();
    for (const r of usage.streams) {
      if (!r.streamId || seen.has(r.streamId)) continue;
      seen.add(r.streamId);
      try {
        items.push(...rolloutLog.read(r.streamId));
      } catch {
        /* 日志读不出来不影响报表口径：这一回合就当没归因 */
      }
    }
    return failureCounts(items);
  }, [usage.streams]);
  const failureTotal = failures.reduce((sum, row) => sum + row.count, 0);

  /**
   * 注入可解释（P3/T17）：读召回日志，只挑本会话的最近几次。
   *
   * 日志是旁路诊断数据（写失败一律静默），读失败就当没有——不能因为一次读不到
   * 让整个「上下文」页签崩掉；宁可少一块解释，也不影响预算与用量这些主信息。
   */
  const recalls = useMemo(() => {
    try {
      return explainRecalls(new RecallLog().list(), conversationId ?? "");
    } catch {
      return [];
    }
  }, [conversationId]);

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
      {/* 真实消耗（P0-T2）：记账按会话/回合归因，回答「这句话花了多少、贵在哪」。
          与上面的上下文预算不是一套口径：上面是「还没发出去的行会有多大」，这里是「已经花掉多少」。 */}
      <h4 className="ui-section-title mb-2 mt-5">本会话消耗</h4>
      <ul aria-label="本会话消耗" className="list-none space-y-1.5 p-0">
        <li className="flex items-baseline justify-between gap-3 text-ui-sm">
          <span className="text-muted">已上报</span>
          <span className="shrink-0 tabular-nums text-ink" data-testid="conversation-tokens">
            {formatTokens(usage.totals.total)} tokens
          </span>
        </li>
        <li className="flex items-baseline justify-between gap-3 text-ui-sm">
          <span className="text-muted">回合数</span>
          <span className="shrink-0 tabular-nums text-ink">
            {usage.totals.runs} 次
            {/* 未上报单独说清楚：混进「已上报」就成了编数字。 */}
            {usage.totals.unreported > 0 ? `（${usage.totals.unreported} 次未上报）` : ""}
          </span>
        </li>
      </ul>
      {usage.turns.length > 0 ? (
        <ol aria-label="回合消耗明细" className="mt-3 list-none space-y-1.5 p-0">
          {usage.turns.map((turn) => (
            <li
              key={turn.streamId}
              className="flex flex-wrap items-baseline justify-between gap-x-3 gap-y-0.5 rounded-md border border-line-soft px-2 py-1.5 text-ui-sm"
            >
              <span className="min-w-0 truncate text-muted" title={turn.streamId}>
                {turn.model}
              </span>
              <span className="shrink-0 tabular-nums text-ink">
                {turn.tokens === null ? "未上报" : `${formatTokens(turn.tokens)} tokens`}
                {turn.rounds !== undefined ? ` · ${turn.rounds} 轮` : ""}
                {/* 前缀缓存：报了就显示，没报就不显示（旧日志/供应商不拆）。 */}
                {turn.cacheRead !== undefined ? ` · 缓存读 ${formatTokens(turn.cacheRead)}` : ""}
                {turn.toolMs !== undefined ? ` · 工具 ${formatMs(turn.toolMs)}` : ""}
                {/* 完成证据（P3-T15）：有证据才显示——「没证据」不等于「查过没副作用」。 */}
                {turn.evidenceFiles !== undefined ? ` · 改了 ${turn.evidenceFiles} 个文件` : ""}
                {turn.evidenceCommands !== undefined ? ` · 执行 ${turn.evidenceCommands} 个动作` : ""}
              </span>
            </li>
          ))}
        </ol>
      ) : (
        <p className="mt-3 text-ui-sm text-muted">这个会话还没有可归因的用量记录。</p>
      )}
      {/* 失败归因（P3-T16）：日志里有归因才出这块——没有数据时整块省略，
          而不是给一张全 0 的表假装在做报表。 */}
      {failureTotal > 0 ? (
        <>
          <h4 className="ui-section-title mb-2 mt-5">失败归因</h4>
          <ul aria-label="失败归因" className="list-none space-y-1.5 p-0">
            {failures
              .filter((row) => row.count > 0)
              .map((row) => (
                <li
                  key={row.failure}
                  className="flex items-baseline justify-between gap-3 text-ui-sm"
                >
                  <span className="text-muted">{FAILURE_LABELS[row.failure]}</span>
                  <span
                    className="shrink-0 tabular-nums text-ink"
                    data-testid={`failure-count-${row.failure}`}
                  >
                    {row.count} 次
                  </span>
                </li>
              ))}
          </ul>
        </>
      ) : null}
      {/* 注入可解释（P3/T17）：最近几次「注入了哪几条、哪些被裁、为什么」。
          召回日志里没有本会话的档案就整块省略：编不出解释，就不假装能解释。 */}
      {recalls.length > 0 ? (
        <>
          <h4 className="ui-section-title mb-2 mt-5">记忆注入</h4>
          <ul aria-label="记忆注入" className="list-none space-y-2 p-0">
            {recalls.map((run) => {
              const recalledTotal =
                run.recalled.semantic + run.recalled.episodic + run.recalled.working;
              return (
                <li key={run.id} className="rounded-md border border-line-soft px-2 py-1.5 text-ui-sm">
                  <p className="truncate text-ink" title={run.query}>
                    {run.query || "（空提问）"}
                  </p>
                  <p className="text-muted">
                    召回 {recalledTotal} 条 · 注入 {run.injected.length} 条
                    {run.dropped.length > 0 ? ` · 裁掉 ${run.dropped.length} 条` : ""}
                    {run.used.length > 0 ? ` · 疑似引用 ${run.used.length} 条` : ""}
                  </p>
                  {run.injected.length > 0 ? (
                    <ul aria-label="注入条目" className="mt-1 list-none space-y-0.5 p-0 pl-3">
                      {run.injected.map((item) => (
                        <li key={item.id} className="text-muted">
                          [{recallLayerLabel(item.layer)}] {item.content}
                          {item.truncated ? "（已截断）" : ""}
                          {item.score !== undefined ? ` · 分 ${item.score.toFixed(2)}` : ""}
                        </li>
                      ))}
                    </ul>
                  ) : null}
                  {run.dropped.length > 0 ? (
                    <ul aria-label="被裁条目" className="mt-1 list-none space-y-0.5 p-0 pl-3">
                      {run.dropped.map((drop) => (
                        <li key={drop.id} className="text-muted">
                          [{recallLayerLabel(drop.layer)}] {drop.content ?? drop.id} ·{" "}
                          {RECALL_DROP_LABELS[drop.reason]}
                        </li>
                      ))}
                    </ul>
                  ) : null}
                </li>
              );
            })}
          </ul>
        </>
      ) : null}
    </section>
  );
}
