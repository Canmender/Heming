import { useEffect, useMemo, useRef, useState } from "react";
import { useLlmStore } from "../store/llm.js";
import {
  EDGE_STATE_LABEL,
  buildTraceGraph,
  fetchTrace,
  shortTime,
  type EdgeState,
  type TraceGraph,
  type TraceRoute,
  type TraceSnapshot,
} from "../lib/magpieTrace.js";

/**
 * 实时链路（d.101）：网关路由的节点视图。
 *
 * 左边是发请求的客户端（和鸣智能体 / 外部 agent），中间是内核，右边是请求最终落到的
 * 账号或 Key。每条连线是一个请求：蓝色流动＝正在进行，绿色＝成功，琥珀色＝失败后换人。
 * 数据全部来自内核自己的 `GET /v1/magpie/trace`（与 magpie 原版 Routing 页同一份），
 * 页面不推断、不补数据；没有请求时显示引导。
 */

const COLORS: Record<EdgeState, string> = {
  live: "#2f6feb",
  ok: "#1f9d55",
  failed: "#d97706",
};

const WIDTH = 1000;
const PAD = 24;
const NODE_W = 190;
const NODE_H = 46;
const AGENT_X = PAD;
const ACCOUNT_X = WIDTH - PAD - NODE_W;
const CENTER_X = WIDTH / 2;
const CENTER_W = 150;

function nodeY(index: number, count: number, height: number): number {
  const top = 40;
  const usable = Math.max(120, height - top * 2);
  const step = count > 1 ? Math.min(64, usable / (count - 1)) : 0;
  const total = step * (count - 1);
  const start = (height - total) / 2;
  return start + index * step;
}

function curve(fromX: number, fromY: number, toX: number, toY: number, throughX: number, throughY: number): string {
  const mid1 = fromX + (throughX - fromX) / 2;
  const mid2 = throughX + (toX - throughX) / 2;
  return `M ${fromX} ${fromY} C ${mid1} ${fromY}, ${throughX - 40} ${throughY}, ${throughX} ${throughY} C ${throughX + 40} ${throughY}, ${mid2} ${toY}, ${toX} ${toY}`;
}

export function ModelTraceView() {
  const baseUrl = useLlmStore((s) => s.gateway.baseUrl);
  const [snapshot, setSnapshot] = useState<TraceSnapshot | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [paused, setPaused] = useState(false);
  const [hovered, setHovered] = useState<number | null>(null);
  const [selected, setSelected] = useState<number | null>(null);
  const [filter, setFilter] = useState<EdgeState | "all">("all");
  const [nodeFilter, setNodeFilter] = useState<{ kind: "agent" | "account"; id: string } | null>(
    null,
  );
  const [reducedMotion, setReducedMotion] = useState(false);
  const listedRef = useRef<HTMLDivElement | null>(null);

  useEffect(() => {
    if (typeof window === "undefined" || !window.matchMedia) return;
    const query = window.matchMedia("(prefers-reduced-motion: reduce)");
    const update = () => setReducedMotion(query.matches);
    update();
    query.addEventListener?.("change", update);
    return () => query.removeEventListener?.("change", update);
  }, []);

  useEffect(() => {
    if (paused) return;
    let stopped = false;
    let timer: ReturnType<typeof setTimeout> | null = null;
    const controller = new AbortController();
    const tick = async () => {
      try {
        const next = await fetchTrace(baseUrl, { signal: controller.signal });
        if (stopped) return;
        setSnapshot(next);
        setError(null);
      } catch (err) {
        if (stopped) return;
        setError(err instanceof Error ? err.message : String(err));
      }
      if (!stopped) timer = setTimeout(() => void tick(), 2500);
    };
    void tick();
    return () => {
      stopped = true;
      controller.abort();
      if (timer) clearTimeout(timer);
    };
  }, [baseUrl, paused]);

  const graph: TraceGraph = useMemo(
    () => buildTraceGraph(snapshot?.routes ?? []),
    [snapshot],
  );

  const height = Math.max(
    380,
    100 + Math.max(graph.agents.length, graph.accounts.length) * 64,
  );

  const agentPositions = new Map(
    graph.agents.map((node, index) => [node.id, nodeY(index, graph.agents.length, height)]),
  );
  const accountPositions = new Map(
    graph.accounts.map((node, index) => [node.id, nodeY(index, graph.accounts.length, height)]),
  );
  const centerY = height / 2;

  const selectedRoute = graph.rows.find((row) => row.route.id === selected)?.route ?? null;
  const liveCount = graph.edges.filter((edge) => edge.state === "live").length;
  const stats = useMemo(() => {
    const done = graph.rows.filter((row) => row.route.done);
    const avgMs = done.length
      ? Math.round(done.reduce((sum, row) => sum + (row.route.ms ?? 0), 0) / done.length)
      : 0;
    return {
      total: graph.rows.length,
      live: liveCount,
      ok: graph.rows.filter((row) => row.state === "ok").length,
      failed: graph.rows.filter((row) => row.state === "failed").length,
      avgMs,
      tokens: graph.rows.reduce((sum, row) => sum + (row.route.tokens ?? 0), 0),
    };
  }, [graph, liveCount]);

  /** 按状态 + 选中的节点过滤；节点过滤只影响图与列表，不影响顶部统计。 */
  const visibleRows = graph.rows.filter((row) => {
    if (filter !== "all" && row.state !== filter) return false;
    if (nodeFilter) {
      const edge = graph.edges.find((item) => item.routeId === row.route.id);
      if (!edge) return false;
      if (nodeFilter.kind === "agent" && edge.from !== nodeFilter.id) return false;
      if (nodeFilter.kind === "account" && edge.to !== nodeFilter.id) return false;
    }
    return true;
  });
  const visibleRouteIds = new Set(visibleRows.map((row) => row.route.id));
  const nodeCounts = useMemo(() => {
    const counts = new Map<string, number>();
    for (const edge of graph.edges) {
      counts.set(edge.from, (counts.get(edge.from) ?? 0) + 1);
      counts.set(edge.to, (counts.get(edge.to) ?? 0) + 1);
    }
    return counts;
  }, [graph]);

  return (
    <section aria-label="实时链路" className="space-y-3">
      <div className="flex flex-wrap items-center justify-between gap-2">
        <div className="flex flex-wrap items-center gap-3">
          <div className="text-[12px] font-bold text-muted">路由实时图</div>
          <span className="ui-caption">
            {snapshot
              ? `${stats.total} 个请求 · ${stats.live} 进行中 · ${stats.ok} 成功 · ${stats.failed} 失败`
              : "读取中…"}
          </span>
          {snapshot && stats.avgMs > 0 && (
            <span className="ui-caption">
              平均 {stats.avgMs}ms · {stats.tokens} tokens
            </span>
          )}
          <span className="ui-caption">最后读取 {snapshot ? shortTime(snapshot.now) : "—"}</span>
          {(Object.keys(EDGE_STATE_LABEL) as EdgeState[]).map((state) => (
            <span key={state} className="ui-caption flex items-center gap-1">
              <span
                aria-hidden="true"
                className="inline-block h-[3px] w-4 rounded"
                style={{ backgroundColor: COLORS[state] }}
              />
              {EDGE_STATE_LABEL[state]}
            </span>
          ))}
        </div>
        <div className="flex flex-wrap items-center gap-2">
          {(["all", "live", "ok", "failed"] as const).map((key) => (
            <button
              key={key}
              type="button"
              aria-pressed={filter === key}
              className={`ui-btn ui-btn-sm ${filter === key ? "ui-btn-primary" : "ui-btn-ghost"}`}
              onClick={() => setFilter(key)}
            >
              {key === "all" ? "全部" : EDGE_STATE_LABEL[key]}
            </button>
          ))}
          {(filter !== "all" || nodeFilter) && (
            <button
              type="button"
              className="ui-btn ui-btn-sm ui-btn-ghost"
              onClick={() => {
                setFilter("all");
                setNodeFilter(null);
              }}
            >
              清除筛选
            </button>
          )}
          <button
            type="button"
            className="ui-btn ui-btn-sm ui-btn-ghost"
            onClick={() => setPaused((value) => !value)}
          >
            {paused ? "继续刷新" : "暂停"}
          </button>
          <button
            type="button"
            className="ui-btn ui-btn-sm ui-btn-ghost"
            onClick={() => {
              setSelected(null);
              setHovered(null);
            }}
          >
            清除选中
          </button>
        </div>
      </div>

      {error && (
        <div role="alert" className="rounded-lg border border-[#f3c9c9] bg-[#fff6f6] p-2 text-[12px]">
          {error}
        </div>
      )}

      <div className="overflow-x-auto rounded-xl border border-line bg-white">
        {visibleRows.length === 0 ? (
          <div className="flex min-h-[260px] flex-col items-center justify-center gap-2 p-6 text-center">
            <div className="text-[13px] font-bold text-muted">
              {graph.rows.length === 0 ? "还没有请求经过" : "当前筛选下没有请求"}
            </div>
            <p className="ui-caption max-w-[420px]">
              {graph.rows.length === 0
                ? "发一次智能体对话（或让任意客户端调用网关），这里会实时画出它从哪个客户端出发、经过内核、最终落到哪个账号；失败换人也会画出来。"
                : "换个筛选条件，或点「清除筛选」看全部请求。"}
            </p>
          </div>
        ) : (
          <svg
            role="img"
            aria-label="路由节点图"
            viewBox={`0 0 ${WIDTH} ${height}`}
            width="100%"
            height={height}
            className="min-w-[900px]"
          >
            {/* 连线先画：节点覆盖在上面，读起来是「穿过内核」 */}
            {graph.edges
              .filter((edge) => visibleRouteIds.has(edge.routeId))
              .map((edge) => {
              const y1 = agentPositions.get(edge.from) ?? centerY;
              const y2 = accountPositions.get(edge.to) ?? centerY;
              const d = curve(AGENT_X + NODE_W, y1 + NODE_H / 2, ACCOUNT_X, y2 + NODE_H / 2, CENTER_X, centerY);
              const active = hovered === edge.routeId || selected === edge.routeId;
              const opacity = hovered === null && selected === null ? 0.75 : active ? 1 : 0.2;
              return (
                <g key={edge.id} data-testid={`trace-edge-${edge.routeId}`}>
                  <path
                    d={d}
                    fill="none"
                    stroke={COLORS[edge.state]}
                    strokeWidth={active ? 3 : 1.6}
                    strokeOpacity={opacity}
                    strokeDasharray={edge.state === "live" ? "6 5" : undefined}
                    className={edge.state === "live" ? "animate-[dash_1.2s_linear_infinite]" : undefined}
                  />
                  {edge.state === "live" && !reducedMotion && (
                    <circle r={4} fill={COLORS.live} opacity={opacity}>
                      <animateMotion dur="1.8s" repeatCount="indefinite" path={d} />
                    </circle>
                  )}
                  <path
                    d={d}
                    fill="none"
                    stroke="transparent"
                    strokeWidth={14}
                    className="cursor-pointer"
                    onMouseEnter={() => setHovered(edge.routeId)}
                    onMouseLeave={() => setHovered(null)}
                    onClick={() => {
                      setSelected(edge.routeId);
                      listedRef.current?.scrollIntoView({ block: "nearest" });
                    }}
                  >
                    <title>{edge.detail}</title>
                  </path>
                </g>
              );
              })}

            {/* 中间：内核 */}
            <g>
              <rect
                x={CENTER_X - CENTER_W / 2}
                y={centerY - 30}
                width={CENTER_W}
                height={60}
                rx={12}
                fill="#111"
              />
              <text x={CENTER_X} y={centerY - 6} textAnchor="middle" fill="#fff" fontSize="12" fontWeight="700">
                和鸣内核
              </text>
              <text x={CENTER_X} y={centerY + 12} textAnchor="middle" fill="#bbb" fontSize="10">
                magpie-core
              </text>
            </g>

            {/* 左：客户端 */}
            {graph.agents.map((node) => {
              const y = agentPositions.get(node.id)!;
              const active = nodeFilter?.kind === "agent" && nodeFilter.id === node.id;
              return (
                <g
                  key={node.id}
                  className="cursor-pointer"
                  onClick={() => setNodeFilter(active ? null : { kind: "agent", id: node.id })}
                >
                  <rect
                    x={AGENT_X}
                    y={y}
                    width={NODE_W}
                    height={NODE_H}
                    rx={10}
                    fill={active ? "#e4ecfb" : "#f4f6fb"}
                    stroke={active ? COLORS.live : "#c9d3e6"}
                    strokeWidth={active ? 2 : 1}
                  />
                  <text x={AGENT_X + 12} y={y + 19} fontSize="12" fontWeight="700" fill="#222">
                    {node.label.length > 18 ? `${node.label.slice(0, 18)}…` : node.label}
                  </text>
                  <text x={AGENT_X + 12} y={y + 34} fontSize="10" fill="#666">
                    {nodeCounts.get(node.id) ?? 0} 个请求 · 点击筛选
                  </text>
                </g>
              );
            })}

            {/* 右：账号 / Key */}
            {graph.accounts.map((node) => {
              const y = accountPositions.get(node.id)!;
              const active = nodeFilter?.kind === "account" && nodeFilter.id === node.id;
              return (
                <g
                  key={node.id}
                  className="cursor-pointer"
                  onClick={() => setNodeFilter(active ? null : { kind: "account", id: node.id })}
                >
                  <rect
                    x={ACCOUNT_X}
                    y={y}
                    width={NODE_W}
                    height={NODE_H}
                    rx={10}
                    fill={active ? "#e3f5ea" : "#f3faf5"}
                    stroke={active ? COLORS.ok : "#bcdcc8"}
                    strokeWidth={active ? 2 : 1}
                  />
                  <text x={ACCOUNT_X + 12} y={y + 19} fontSize="12" fontWeight="700" fill="#222">
                    {node.label.length > 18 ? `${node.label.slice(0, 18)}…` : node.label}
                  </text>
                  <text x={ACCOUNT_X + 12} y={y + 34} fontSize="10" fill="#666">
                    {node.sub.length > 24 ? `${node.sub.slice(0, 24)}…` : node.sub} ·{" "}
                    {nodeCounts.get(node.id) ?? 0} 请求
                  </text>
                </g>
              );
            })}
          </svg>
        )}
      </div>

      {selectedRoute && <RouteDetail route={selectedRoute} onClose={() => setSelected(null)} />}

      {graph.rows.length > 0 && (
        <div ref={listedRef} className="overflow-x-auto rounded-xl border border-line">
          <table className="w-full text-left text-[12px]">
            <thead className="ui-caption">
              <tr>
                <th className="px-3 py-2">时间</th>
                <th className="px-3 py-2">客户端</th>
                <th className="px-3 py-2">请求模型</th>
                <th className="px-3 py-2">落点</th>
                <th className="px-3 py-2">状态</th>
                <th className="px-3 py-2">耗时</th>
              </tr>
            </thead>
            <tbody>
              {[...visibleRows].reverse().slice(0, 30).map(({ route, account, state }) => (
                <tr
                  key={route.id}
                  className={`cursor-pointer border-t border-line ${
                    selected === route.id ? "bg-[#f4f7ff]" : hovered === route.id ? "bg-[#fafafa]" : ""
                  }`}
                  onMouseEnter={() => setHovered(route.id)}
                  onMouseLeave={() => setHovered(null)}
                  onClick={() => setSelected(route.id)}
                >
                  <td className="px-3 py-1.5 text-muted">{shortTime(route.time)}</td>
                  <td className="px-3 py-1.5">{route.agent || "—"}</td>
                  <td className="px-3 py-1.5 font-mono text-[11px]">{route.model}</td>
                  <td className="px-3 py-1.5">{account}</td>
                  <td className="px-3 py-1.5" style={{ color: COLORS[state] }}>
                    {state === "live" ? "进行中" : route.status ? `${route.status}` : EDGE_STATE_LABEL[state]}
                  </td>
                  <td className="px-3 py-1.5">{route.ms ? `${route.ms}ms` : "—"}</td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      )}
    </section>
  );
}

function RouteDetail({ route, onClose }: { route: TraceRoute; onClose: () => void }) {
  return (
    <div className="rounded-xl border border-line bg-[#fafafa] p-3 text-[12px]">
      <div className="flex items-center justify-between">
        <div className="font-bold">请求 #{route.id}</div>
        <button type="button" className="ui-btn ui-btn-sm ui-btn-ghost" onClick={onClose}>
          关闭详情
        </button>
      </div>
      <dl className="mt-2 grid gap-x-6 gap-y-1 sm:grid-cols-2">
        <div className="flex gap-2">
          <dt className="text-muted">客户端</dt>
          <dd>{route.agent || "—"}</dd>
        </div>
        <div className="flex gap-2">
          <dt className="text-muted">请求模型</dt>
          <dd className="font-mono text-[11px]">{route.model}</dd>
        </div>
        <div className="flex gap-2">
          <dt className="text-muted">供应商</dt>
          <dd>{route.provider || "—"}</dd>
        </div>
        <div className="flex gap-2">
          <dt className="text-muted">分组</dt>
          <dd>{route.group?.name || "—"}</dd>
        </div>
        <div className="flex gap-2">
          <dt className="text-muted">候选顺序</dt>
          <dd>{route.order?.length ?? 0} 个</dd>
        </div>
        <div className="flex gap-2">
          <dt className="text-muted">尝试</dt>
          <dd>{route.tries?.length ?? 0} 次</dd>
        </div>
        <div className="flex gap-2">
          <dt className="text-muted">耗时</dt>
          <dd>{route.ms ? `${route.ms}ms` : "—"}</dd>
        </div>
        <div className="flex gap-2">
          <dt className="text-muted">token</dt>
          <dd>{route.tokens ?? "—"}</dd>
        </div>
      </dl>
      {route.error && <div className="mt-2 text-[#b42318]">{route.error}</div>}
      {(route.tries?.length ?? 0) > 0 && (
        <ol className="mt-2 list-decimal space-y-0.5 pl-5">
          {route.tries.map((attempt, index) => (
            <li key={`${attempt.id}-${index}`} className="font-mono text-[11px]">
              {attempt.id} · {attempt.model || "—"} · {attempt.done ? "结束" : "进行中"}
              {attempt.status ? ` · ${attempt.status}` : ""}
              {attempt.ms ? ` · ${attempt.ms}ms` : ""}
            </li>
          ))}
        </ol>
      )}
    </div>
  );
}
