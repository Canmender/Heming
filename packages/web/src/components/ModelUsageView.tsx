import { useCallback, useEffect, useMemo, useState } from "react";
import { useLlmStore } from "../store/llm.js";
import {
  breakdownOf,
  bucketLabel,
  chartBars,
  fetchUsage,
  fetchUsageRequests,
  formatCost,
  formatTokens,
  type UsageBreakdownKind,
  type UsagePeriod,
  type UsageRequests,
  type UsageSummary,
} from "../lib/magpieUsage.js";

/**
 * 用量（d.110）：模型服务自己记的账，做成和鸣自己的图。
 *
 * 数据来自内核的 /v1/magpie/usage 与 /usage/requests（magpie 的用量页同源）：
 * 概览数字、按天的请求/token 柱状图、按模型/Agent/账号的拆分、以及最近的请求明细。
 * 页面只读，不改任何记账；导出 CSV 仍走模型服务命令。
 */

const PERIODS: { key: UsagePeriod; label: string }[] = [
  { key: "today", label: "今天" },
  { key: "7d", label: "7 天" },
  { key: "30d", label: "30 天" },
  { key: "all", label: "全部" },
];

const BREAKDOWNS: { key: UsageBreakdownKind; label: string }[] = [
  { key: "models", label: "按模型" },
  { key: "agents", label: "按 Agent" },
  { key: "accounts", label: "按账号" },
];

const AVATAR_COLORS = ["#7c6bd6", "#2f6feb", "#0f9d8a", "#d97706", "#db2777", "#4b5563"];

function avatarColor(name: string): string {
  let hash = 0;
  for (let i = 0; i < name.length; i++) hash = (hash * 31 + name.charCodeAt(i)) >>> 0;
  return AVATAR_COLORS[hash % AVATAR_COLORS.length]!;
}

function Avatar({ name }: { name: string }) {
  return (
    <span
      aria-hidden="true"
      className="flex h-6 w-6 shrink-0 items-center justify-center rounded-full text-[10px] font-bold text-white"
      style={{ backgroundColor: avatarColor(name) }}
    >
      {name.slice(0, 1).toUpperCase()}
    </span>
  );
}

export function ModelUsageView({
  onExportCsv,
}: {
  onExportCsv?: (period: UsagePeriod) => void;
}) {
  const baseUrl = useLlmStore((s) => s.gateway.baseUrl);
  const [period, setPeriod] = useState<UsagePeriod>("30d");
  const [summary, setSummary] = useState<UsageSummary | null>(null);
  const [requests, setRequests] = useState<UsageRequests | null>(null);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const [metric, setMetric] = useState<"calls" | "tokens">("calls");
  const [breakdown, setBreakdown] = useState<UsageBreakdownKind>("models");

  const load = useCallback(
    async (signal: AbortSignal) => {
      setLoading(true);
      setError(null);
      try {
        const [nextSummary, nextRequests] = await Promise.all([
          fetchUsage(baseUrl, period, { signal }),
          fetchUsageRequests(baseUrl, period, 12, { signal }),
        ]);
        if (signal.aborted) return;
        setSummary(nextSummary);
        setRequests(nextRequests);
      } catch (err) {
        if (signal.aborted) return;
        setError(err instanceof Error ? err.message : String(err));
      } finally {
        if (!signal.aborted) setLoading(false);
      }
    },
    [baseUrl, period],
  );

  useEffect(() => {
    const controller = new AbortController();
    void load(controller.signal);
    return () => controller.abort();
  }, [load]);

  const bars = useMemo(() => chartBars(summary?.series ?? [], metric), [summary, metric]);
  const rows = useMemo(
    () => (summary ? breakdownOf(summary, breakdown) : []),
    [summary, breakdown],
  );
  const maxCalls = Math.max(1, ...rows.map((row) => row.calls));

  return (
    <section aria-label="用量" className="space-y-4">
      <div className="flex flex-wrap items-center justify-between gap-2">
        <div className="text-[13px] font-bold">用量</div>
        <div className="flex flex-wrap items-center gap-1.5">
          <span className="inline-flex items-center gap-1 rounded-full bg-[#f2f3f5] p-1">
            {PERIODS.map((item) => (
              <button
                key={item.key}
                type="button"
                aria-pressed={period === item.key}
                className={`rta-segment rounded-full px-3 py-1 text-[12px] ${
                  period === item.key ? "bg-white font-bold text-ink shadow-card" : "text-muted hover:text-ink"
                }`}
                onClick={() => setPeriod(item.key)}
              >
                {item.label}
              </button>
            ))}
          </span>
          {onExportCsv && (
            <button
              type="button"
              className="rta-segment rounded-full bg-[#f2f3f5] px-3 py-1 text-[12px] text-muted hover:bg-[#e9ebef]"
              onClick={() => onExportCsv(period)}
            >
              导出 CSV
            </button>
          )}
        </div>
      </div>

      {error && (
        <div role="alert" className="rounded-xl border border-[#f3c9c9] bg-[#fff6f6] p-2 text-[12px]">
          {error}
        </div>
      )}

      {loading && !summary ? (
        <div className="grid gap-3 sm:grid-cols-4" aria-label="读取用量">
          {[0, 1, 2, 3].map((index) => (
            <div key={index} className="h-[86px] animate-pulse rounded-[20px] bg-[#eef0f3]" />
          ))}
        </div>
      ) : summary && summary.calls === 0 ? (
        <div className="rounded-[20px] border border-dashed border-line bg-white px-6 py-10 text-center">
          <div className="text-[14px] font-bold">这个时间段还没有调用</div>
          <p className="mx-auto mt-1 max-w-[420px] ui-caption">
            智能体通过模型服务发出的请求会自动记账；发一次对话再回来看。
          </p>
        </div>
      ) : (
        summary && (
          <>
            <div className="grid gap-3 sm:grid-cols-2 lg:grid-cols-4">
              <SummaryCard
                label="请求"
                value={String(summary.calls)}
                hint={summary.errors > 0 ? `${summary.errors} 次失败` : "全部成功"}
                tone={summary.errors > 0 ? "warn" : undefined}
              />
              <SummaryCard
                label="Token"
                value={formatTokens(summary.input + summary.output)}
                hint={`输入 ${formatTokens(summary.input)} · 输出 ${formatTokens(summary.output)}`}
              />
              <SummaryCard
                label="费用"
                value={formatCost(summary.cost, summary.unpriced)}
                hint={summary.unpriced > 0 ? "部分模型没有价格" : "按模型服务记账"}
              />
              <SummaryCard
                label="缓存"
                value={formatTokens(summary.cache_read)}
                hint="从缓存读到的输入 token"
              />
            </div>

            <div className="rounded-[20px] border border-line bg-white p-4">
              <div className="flex flex-wrap items-center justify-between gap-2">
                <div className="text-[13px] font-bold">{metric === "calls" ? "每天请求数" : "每天 Token"}</div>
                <span className="inline-flex items-center gap-1 rounded-full bg-[#f2f3f5] p-0.5">
                  {(["calls", "tokens"] as const).map((key) => (
                    <button
                      key={key}
                      type="button"
                      aria-pressed={metric === key}
                      className={`rta-segment rounded-full px-2.5 py-0.5 text-[11px] ${
                        metric === key ? "bg-white font-bold text-ink" : "text-muted"
                      }`}
                      onClick={() => setMetric(key)}
                    >
                      {key === "calls" ? "请求" : "Token"}
                    </button>
                  ))}
                </span>
              </div>
              <svg
                role="img"
                aria-label="用量柱状图"
                viewBox={`0 0 ${Math.max(320, bars.length * 22)} 150`}
                width="100%"
                height={150}
                className="mt-3"
              >
                <line x1="0" y1="120" x2={Math.max(320, bars.length * 22)} y2="120" stroke="#e4e7ec" />
                {bars.map((bar, index) => {
                  const height = Math.max(bar.value > 0 ? 3 : 0, Math.round(bar.ratio * 100));
                  const x = index * 22 + 4;
                  return (
                    <g key={`${bar.label}-${index}`}>
                      <rect
                        x={x}
                        y={120 - height}
                        width={14}
                        height={height}
                        rx={3}
                        fill={metric === "calls" ? "#2f6feb" : "#7c6bd6"}
                        opacity={0.85}
                      >
                        <title>{`${bar.label}：${bar.value}`}</title>
                      </rect>
                      {bar.showLabel && (
                        <text x={x + 7} y={138} textAnchor="middle" fontSize="9" fill="#98a2b3">
                          {bar.label}
                        </text>
                      )}
                    </g>
                  );
                })}
              </svg>
            </div>

            <div className="rounded-[20px] border border-line bg-white p-4">
              <div className="flex flex-wrap items-center justify-between gap-2">
                <div className="text-[13px] font-bold">用在哪</div>
                <span className="inline-flex items-center gap-1 rounded-full bg-[#f2f3f5] p-0.5">
                  {BREAKDOWNS.map((item) => (
                    <button
                      key={item.key}
                      type="button"
                      aria-pressed={breakdown === item.key}
                      className={`rta-segment rounded-full px-2.5 py-0.5 text-[11px] ${
                        breakdown === item.key ? "bg-white font-bold text-ink" : "text-muted"
                      }`}
                      onClick={() => setBreakdown(item.key)}
                    >
                      {item.label}
                    </button>
                  ))}
                </span>
              </div>
              <ul className="mt-2 space-y-2">
                {rows.map((row) => (
                  <li key={row.id} className="flex items-center gap-2">
                    <Avatar name={bucketLabel(row, breakdown)} />
                    <span className="min-w-0 flex-1">
                      <span className="flex items-baseline justify-between gap-2">
                        <span className="truncate text-[12px] font-bold">{bucketLabel(row, breakdown)}</span>
                        <span className="shrink-0 ui-caption">
                          {row.calls} 次 · {formatTokens(row.input + row.output)} tokens
                          {row.cost > 0 ? ` · ${formatCost(row.cost, row.unpriced)}` : ""}
                        </span>
                      </span>
                      <span className="mt-1 block h-1.5 overflow-hidden rounded-full bg-[#f2f3f5]">
                        <span
                          className="block h-full rounded-full bg-[#111]"
                          style={{ width: `${Math.max(3, (row.calls / maxCalls) * 100)}%` }}
                        />
                      </span>
                    </span>
                  </li>
                ))}
                {rows.length === 0 && <li className="ui-caption">这个时间段还没有可拆分的调用。</li>}
              </ul>
            </div>

            {requests && requests.rows.length > 0 && (
              <div className="overflow-x-auto rounded-[20px] border border-line bg-white p-4">
                <div className="flex items-center justify-between">
                  <div className="text-[13px] font-bold">最近请求</div>
                  <span className="ui-caption">共 {requests.total} 条</span>
                </div>
                <table className="mt-2 w-full text-left text-[12px]">
                  <thead className="ui-caption">
                    <tr>
                      <th className="py-1 pr-3">时间</th>
                      <th className="py-1 pr-3">Agent</th>
                      <th className="py-1 pr-3">模型</th>
                      <th className="py-1 pr-3">tokens</th>
                      <th className="py-1 pr-3">耗时</th>
                      <th className="py-1 pr-3">状态</th>
                    </tr>
                  </thead>
                  <tbody>
                    {requests.rows.map((row) => (
                      <tr key={row.route_id} className="border-t border-line">
                        <td className="py-1.5 pr-3 text-muted">
                          {new Date(row.t).toLocaleTimeString("zh-CN", { hour12: false })}
                        </td>
                        <td className="py-1.5 pr-3">{row.agentName || row.agent || "—"}</td>
                        <td className="py-1.5 pr-3 font-mono text-[11px]">{row.req || row.model}</td>
                        <td className="py-1.5 pr-3">
                          {row.in}/{row.out}
                        </td>
                        <td className="py-1.5 pr-3">{row.ms ? `${row.ms}ms` : "—"}</td>
                        <td className="py-1.5 pr-3 text-muted">{row.status || "—"}</td>
                      </tr>
                    ))}
                  </tbody>
                </table>
              </div>
            )}
          </>
        )
      )}
    </section>
  );
}

function SummaryCard({
  label,
  value,
  hint,
  tone,
}: {
  label: string;
  value: string;
  hint: string;
  tone?: "warn";
}) {
  return (
    <div className="rounded-[20px] border border-line bg-white p-4 shadow-[0_1px_2px_rgba(16,24,40,0.04)]">
      <div className="text-[11px] font-bold uppercase tracking-wide text-muted">{label}</div>
      <div className="mt-1.5 text-[22px] font-bold leading-none">{value}</div>
      <div className={`mt-1.5 ${tone === "warn" ? "text-[11px] text-[#b54708]" : "ui-caption"}`}>{hint}</div>
    </div>
  );
}
