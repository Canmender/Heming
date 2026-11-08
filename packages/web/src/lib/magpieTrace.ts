/**
 * 实时链路（d.101）：读网关自己的路由快照，画成节点图。
 *
 * 数据源是内核的 `GET /v1/magpie/trace`（magpie 的 Routing 页用的同一份 trace）：
 * 每个请求一条 Route，里面有 agent、模型、候选顺序（order）、每次尝试（tries）与状态。
 * 页面只做「读快照 + 画图」：不猜、不推断，节点与连线全部来自网关记录。
 *
 * 边界：
 * - 只读本机回环（内核的 trace 端点只服务本机）；经主进程反代访问，渲染层不直连 3425；
 * - 拿不到/没请求时显示空状态，不伪造数据；
 * - 浏览器手填远端网关时，能不能读取决于对方的 CORS 与是否允许本机以外读 trace。
 */

export interface TraceWeighed {
  id: string;
  provider: string;
  name: string;
  who?: string;
  kind?: string;
  model: string;
  agent?: string;
  used?: number;
  known?: boolean;
  fallback?: boolean;
}

export interface TraceTry {
  id: string;
  model?: string;
  done: boolean;
  status?: number;
  ms?: number;
}

export interface TraceRoute {
  id: number;
  seq: number;
  time: string;
  agent: string;
  model: string;
  provider: string;
  group?: { id?: string; name?: string } | null;
  order: TraceWeighed[];
  tries: TraceTry[];
  done: boolean;
  status?: number;
  error?: string;
  ms?: number;
  tokens?: number;
  out?: number;
}

export interface TraceSnapshot {
  seq: number;
  now: string;
  routes: TraceRoute[];
  totals?: unknown;
  pid?: number;
}

export type EdgeState = "live" | "ok" | "failed";

export interface GraphNode {
  id: string;
  label: string;
  sub: string;
  kind: "agent" | "account";
}

export interface GraphEdge {
  id: string;
  routeId: number;
  from: string;
  to: string;
  state: EdgeState;
  agent: string;
  model: string;
  account: string;
  detail: string;
}

export interface TraceGraph {
  agents: GraphNode[];
  accounts: GraphNode[];
  edges: GraphEdge[];
  /** 每条 route 的展示行（列表用），与 edges 一一对应。 */
  rows: {
    route: TraceRoute;
    account: string;
    state: EdgeState;
  }[];
}

/** 从网关读一次快照；失败抛出带人话的错误。 */
export async function fetchTrace(
  gatewayBaseUrl: string,
  opts: { signal?: AbortSignal; fetchImpl?: typeof fetch } = {},
): Promise<TraceSnapshot> {
  const fetchImpl = opts.fetchImpl ?? fetch;
  const base = gatewayBaseUrl.replace(/\/$/, "");
  const response = await fetchImpl(`${base}/magpie/trace`, {
    headers: { accept: "application/json" },
    signal: opts.signal,
  });
  if (!response.ok) {
    throw new Error(`读取路由 trace 失败：HTTP ${response.status}`);
  }
  const data = (await response.json()) as Partial<TraceSnapshot>;
  if (!data || !Array.isArray(data.routes)) {
    throw new Error("路由 trace 形状不对：缺少 routes");
  }
  return {
    seq: typeof data.seq === "number" ? data.seq : 0,
    now: typeof data.now === "string" ? data.now : new Date().toISOString(),
    routes: data.routes as TraceRoute[],
    totals: data.totals,
    pid: typeof data.pid === "number" ? data.pid : undefined,
  };
}

function routeState(route: TraceRoute): EdgeState {
  if (!route.done) return "live";
  const status = route.status ?? route.tries.at(-1)?.status ?? 0;
  return status >= 400 || route.error ? "failed" : "ok";
}

/** 一次请求最终落在哪个账号/Key：优先最后一次尝试，其次候选顺序的第一位。 */
function accountOf(route: TraceRoute): { id: string; label: string; sub: string } {
  const tried = [...(route.tries ?? [])].reverse().find((t) => t.id);
  const weighed =
    (tried ? route.order?.find((o) => o.id === tried.id) : undefined) ??
    route.order?.[0];
  const who = weighed?.who || weighed?.name || weighed?.id || route.provider || "未知账号";
  const model = tried?.model || weighed?.model || route.model;
  return {
    id: weighed?.id || `${route.provider}/${model}`,
    label: who,
    sub: weighed?.provider ? `${weighed.provider} · ${model}` : model,
  };
}

/**
 * 把快照变成节点图：左边 agent、中间内核、右边账号/Key。
 *
 * 去重与排序都是确定性的（按最近出现），所以同一份快照每次渲染一致，
 * 也便于单测。
 */
export function buildTraceGraph(routes: readonly TraceRoute[]): TraceGraph {
  const agents = new Map<string, GraphNode>();
  const accounts = new Map<string, GraphNode>();
  const edges: GraphEdge[] = [];
  const rows: TraceGraph["rows"] = [];

  for (const route of routes) {
    const agentName = route.agent?.trim() || "未知客户端";
    const agentId = `agent:${agentName}`;
    if (!agents.has(agentId)) {
      agents.set(agentId, { id: agentId, label: agentName, sub: "和鸣 / 客户端", kind: "agent" });
    }
    const account = accountOf(route);
    const accountId = `account:${account.id}`;
    if (!accounts.has(accountId)) {
      accounts.set(accountId, { id: accountId, label: account.label, sub: account.sub, kind: "account" });
    }
    const state = routeState(route);
    const status = route.status ?? route.tries.at(-1)?.status;
    const detail = [
      route.group?.name ? `分组 ${route.group.name}` : "",
      `请求 ${route.model}`,
      `候选 ${route.order?.length ?? 0} 个`,
      `尝试 ${route.tries?.length ?? 0} 次`,
      status ? `状态 ${status}` : "",
      route.ms ? `${route.ms}ms` : "",
      route.error || "",
    ]
      .filter(Boolean)
      .join(" · ");
    edges.push({
      id: `edge:${route.id}`,
      routeId: route.id,
      from: agentId,
      to: accountId,
      state,
      agent: agentName,
      model: route.model,
      account: account.label,
      detail,
    });
    rows.push({ route, account: account.label, state });
  }

  return { agents: [...agents.values()], accounts: [...accounts.values()], edges, rows };
}

/** 供页面显示的短时间（本地 HH:MM:SS）。 */
export function shortTime(iso: string): string {
  const date = new Date(iso);
  if (Number.isNaN(date.getTime())) return "—";
  return date.toLocaleTimeString("zh-CN", { hour12: false });
}

/** 颜色 / 文案（页面与图例共用，避免两处漂移）。 */
export const EDGE_STATE_LABEL: Record<EdgeState, string> = {
  live: "进行中",
  ok: "成功",
  failed: "失败/换人",
};
