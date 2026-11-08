/**
 * 模型服务用量（d.110）：读内核的 /v1/magpie/usage 与 /v1/magpie/usage/requests。
 *
 * 内核（vendored magpie）自己记账：按时间桶的请求/token/费用、按 Agent/模型/账号的拆分，
 * 以及每次请求的明细。页面只负责取数与展示，不复制记账逻辑。
 */

export type UsagePeriod = "today" | "7d" | "30d" | "all";

export interface UsageSeriesPoint {
  label: string;
  time: string;
  calls: number;
  errors: number;
  input: number;
  output: number;
  cost: number;
  unpriced: number;
}

export interface UsageBucket {
  id: string;
  calls: number;
  errors: number;
  input: number;
  output: number;
  cache_read?: number;
  cache_write?: number;
  cost: number;
  unpriced?: number;
  timed?: number;
  ttft_ms?: number;
  name?: string;
  provider?: string;
  model?: string;
  icon?: string;
}

export interface UsageSummary {
  period: UsagePeriod;
  since: string;
  calls: number;
  errors: number;
  input: number;
  output: number;
  cache_read: number;
  cache_write: number;
  cost: number;
  unpriced: number;
  series: UsageSeriesPoint[];
  agents: UsageBucket[];
  models: UsageBucket[];
  accounts: UsageBucket[];
}

export interface UsageRequestRow {
  route_id: number;
  t: string;
  agent: string;
  agentName?: string;
  provider: string;
  providerName?: string;
  model: string;
  req: string;
  served?: string;
  in: number;
  out: number;
  ms: number;
  status: number;
  cost: number;
  priced?: boolean;
  ep?: string;
}

export interface UsageRequests {
  period: UsagePeriod;
  total: number;
  rows: UsageRequestRow[];
}

const BASE = (baseUrl: string) => baseUrl.replace(/\/$/, "");

function num(value: unknown): number {
  return typeof value === "number" && Number.isFinite(value) ? value : 0;
}

function buckets(value: unknown): UsageBucket[] {
  if (!Array.isArray(value)) return [];
  return value
    .filter((item): item is Record<string, unknown> => Boolean(item) && typeof item === "object")
    .map((item) => ({
      id: typeof item.id === "string" ? item.id : "",
      calls: num(item.calls),
      errors: num(item.errors),
      input: num(item.input),
      output: num(item.output),
      cache_read: num(item.cache_read),
      cache_write: num(item.cache_write),
      cost: num(item.cost),
      unpriced: num(item.unpriced),
      timed: num(item.timed),
      ttft_ms: num(item.ttft_ms),
      name: typeof item.name === "string" ? item.name : undefined,
      provider: typeof item.provider === "string" ? item.provider : undefined,
      model: typeof item.model === "string" ? item.model : undefined,
      icon: typeof item.icon === "string" ? item.icon : undefined,
    }));
}

export async function fetchUsage(
  gatewayBaseUrl: string,
  period: UsagePeriod,
  opts: { signal?: AbortSignal; fetchImpl?: typeof fetch } = {},
): Promise<UsageSummary> {
  const fetchImpl = opts.fetchImpl ?? fetch;
  const response = await fetchImpl(`${BASE(gatewayBaseUrl)}/magpie/usage?period=${period}`, {
    headers: { accept: "application/json" },
    signal: opts.signal,
  });
  if (!response.ok) throw new Error(`读取用量失败：HTTP ${response.status}`);
  const data = (await response.json()) as Record<string, unknown>;
  const series = Array.isArray(data.series)
    ? (data.series as Record<string, unknown>[]).map((point) => ({
        label: typeof point.label === "string" ? point.label : "",
        time: typeof point.time === "string" ? point.time : "",
        calls: num(point.calls),
        errors: num(point.errors),
        input: num(point.input),
        output: num(point.output),
        cost: num(point.cost),
        unpriced: num(point.unpriced),
      }))
    : [];
  return {
    period: (typeof data.period === "string" ? data.period : period) as UsagePeriod,
    since: typeof data.since === "string" ? data.since : "",
    calls: num(data.calls),
    errors: num(data.errors),
    input: num(data.input),
    output: num(data.output),
    cache_read: num(data.cache_read),
    cache_write: num(data.cache_write),
    cost: num(data.cost),
    unpriced: num(data.unpriced),
    series,
    agents: buckets(data.agents),
    models: buckets(data.models),
    accounts: buckets(data.accounts),
  };
}

export async function fetchUsageRequests(
  gatewayBaseUrl: string,
  period: UsagePeriod,
  limit = 12,
  opts: { signal?: AbortSignal; fetchImpl?: typeof fetch } = {},
): Promise<UsageRequests> {
  const fetchImpl = opts.fetchImpl ?? fetch;
  const response = await fetchImpl(
    `${BASE(gatewayBaseUrl)}/magpie/usage/requests?period=${period}&limit=${limit}`,
    { headers: { accept: "application/json" }, signal: opts.signal },
  );
  if (!response.ok) throw new Error(`读取请求明细失败：HTTP ${response.status}`);
  const data = (await response.json()) as Record<string, unknown>;
  const rows = Array.isArray(data.rows)
    ? (data.rows as Record<string, unknown>[]).map((row) => ({
        route_id: num(row.route_id),
        t: typeof row.t === "string" ? row.t : "",
        agent: typeof row.agent === "string" ? row.agent : "",
        agentName: typeof row.agentName === "string" ? row.agentName : undefined,
        provider: typeof row.provider === "string" ? row.provider : "",
        providerName: typeof row.providerName === "string" ? row.providerName : undefined,
        model: typeof row.model === "string" ? row.model : "",
        req: typeof row.req === "string" ? row.req : "",
        served: typeof row.served === "string" ? row.served : undefined,
        in: num(row.in),
        out: num(row.out),
        ms: num(row.ms),
        status: num(row.status),
        cost: num(row.cost),
        priced: row.priced === true,
        ep: typeof row.ep === "string" ? row.ep : undefined,
      }))
    : [];
  return {
    period: (typeof data.period === "string" ? data.period : period) as UsagePeriod,
    total: num(data.total),
    rows,
  };
}

/** 1.2k / 3.4M：给概览卡片用的紧凑 token 数。 */
export function formatTokens(value: number): string {
  if (!Number.isFinite(value) || value <= 0) return "0";
  if (value >= 1_000_000) return `${(value / 1_000_000).toFixed(1)}M`;
  if (value >= 1_000) return `${(value / 1_000).toFixed(1)}k`;
  return String(Math.round(value));
}

/** 费用：内核按它自己的货币设置记账；这里只格式化数值，未定价条数单独标。 */
export function formatCost(cost: number, unpriced = 0): string {
  if (!Number.isFinite(cost) || cost <= 0) {
    return unpriced > 0 ? "未定价" : "0";
  }
  const text = cost >= 1 ? cost.toFixed(2) : cost.toFixed(4);
  return unpriced > 0 ? `${text}（${unpriced} 条未定价）` : text;
}

export interface ChartBar {
  label: string;
  value: number;
  ratio: number;
  showLabel: boolean;
}

/** 柱状图：按指标取每日桶，ratio 为相对最大值（0..1），供 SVG 画高度。 */
export function chartBars(
  series: readonly UsageSeriesPoint[],
  metric: "calls" | "tokens" = "calls",
  maxLabels = 7,
): ChartBar[] {
  const values = series.map((point) =>
    metric === "calls" ? point.calls : point.input + point.output,
  );
  const max = Math.max(1, ...values);
  const step = Math.max(1, Math.ceil(series.length / maxLabels));
  return series.map((point, index) => ({
    label: point.label,
    value: values[index] ?? 0,
    ratio: (values[index] ?? 0) / max,
    showLabel: index % step === 0 || index === series.length - 1,
  }));
}

export type UsageBreakdownKind = "models" | "agents" | "accounts";

export function breakdownOf(summary: UsageSummary, kind: UsageBreakdownKind): UsageBucket[] {
  const list = kind === "models" ? summary.models : kind === "agents" ? summary.agents : summary.accounts;
  return [...list].sort((a, b) => b.calls - a.calls).slice(0, 8);
}

/** 拆分行的主标题：模型显示 `provider/model`，Agent/账号显示 name。 */
export function bucketLabel(bucket: UsageBucket, kind: UsageBreakdownKind): string {
  if (kind === "models") return bucket.model || bucket.id;
  return bucket.name || bucket.id;
}
