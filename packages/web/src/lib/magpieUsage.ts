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
  /** 首字：从发请求到回复出现第一个内容（文字、推理或工具调用）的毫秒；没流式就没有。 */
  ttft?: number;
  /** 首段文字出现的时间，与 ttft 同口径；ttft 到它的差就是「先想后说」的时间。 */
  firstText?: number;
  /** 发出去的耗时：首字减去它，才是上游自己花的时间。 */
  sent?: number;
  /** sent 里属于和鸣自己的部分（读请求、翻译、挑谁答）。 */
  own?: number;
  /** sent 里花在「先失败的那几次试」与重试间隔上的部分。 */
  retried?: number;
  /** sent 里花在等并发/速率名额（排队）上的部分。 */
  queued?: number;
  /** 回复内容本身流了多久。 */
  flow?: number;
  /** 这条请求总共试了几次；大于一说明前面有试失败过。 */
  tries?: number;
  /** 这一试失败后把请求交给了下一试：它是过程中的一条，不是最终结果。 */
  handedOn?: boolean;
  /** 失败时上游给的原因（被截短过）。 */
  err?: string;
  /** 上游给这个错误起的类型名。 */
  errType?: string;
  /** 上游说它为什么结束（stop_reason / finish_reason）。 */
  stop?: string;
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
        ttft: num(row.ttft_ms) || undefined,
        firstText: num(row.first_text_ms) || undefined,
        sent: num(row.sent_ms) || undefined,
        own: num(row.own_ms) || undefined,
        retried: num(row.retried_ms) || undefined,
        queued: num(row.queued_ms) || undefined,
        flow: num(row.flow_ms) || undefined,
        tries: num(row.tries) || undefined,
        handedOn: row.handed_on === true,
        err: typeof row.err === "string" && row.err ? row.err : undefined,
        errType: typeof row.err_type === "string" && row.err_type ? row.err_type : undefined,
        stop: typeof row.stop === "string" && row.stop ? row.stop : undefined,
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

/**
 * 首字慢在哪儿：内核把一次请求的等待拆成和鸣自己、先失败的那几次试、排队，
 * 剩下的才是上游（sent 减掉前三者），这里按同一口径说人话。没流式的回复没有
 * 首字，返回空串。
 */
export function describeRequestWait(row: UsageRequestRow): string {
  if (!row.ttft || row.ttft <= 0) return "";
  const detail: string[] = [];
  if (row.own) detail.push(`和鸣自己 ${row.own}ms`);
  if (row.retried) detail.push(`先失败的那几次 ${row.retried}ms`);
  if (row.queued) detail.push(`排队 ${row.queued}ms`);
  if (row.sent) {
    const upstream = row.sent - (row.own ?? 0) - (row.retried ?? 0) - (row.queued ?? 0);
    if (upstream > 0) detail.push(`上游 ${upstream}ms`);
  }
  const head = `首字 ${row.ttft}ms`;
  return detail.length > 0 ? `${head}（${detail.join("、")}）` : head;
}

/**
 * 这条请求试了几次：多于一次说明前面有试失败过；handedOn 的那一行是过程中
 * 的一试，它失败了、把请求交给了下一试，不是最终结果。
 */
export function describeRequestTries(row: UsageRequestRow): string {
  if (row.handedOn) return "这一试失败，交给了下一条";
  if ((row.tries ?? 0) > 1) return `试了 ${row.tries} 次`;
  return "";
}

/**
 * 一组调用（按模型 / Agent / 账号）的平均首字：内核只把真被计时的流式回复记进
 * timed 与 ttft_ms 的和，所以这里也只在有计时的时候给数，没有就给 null。
 */
export function averageTTFT(bucket: UsageBucket): number | null {
  const timed = bucket.timed ?? 0;
  const total = bucket.ttft_ms ?? 0;
  if (timed <= 0 || total <= 0) return null;
  return Math.round(total / timed);
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
