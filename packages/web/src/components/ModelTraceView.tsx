import { useEffect, useMemo, useRef, useState } from "react";
import { useLlmStore } from "../store/llm.js";
import { useUiStore } from "../store/ui.js";
import {
  EDGE_STATE_LABEL,
  buildTraceGraph,
  fetchTrace,
  shortTime,
  type EdgeState,
  type TraceGraph,
  type TraceSnapshot,
} from "../lib/magpieTrace.js";

/**
 * 实时链路（d.104）：模型服务正在做的决定，一张节点图。
 *
 * 布局与动效参考 magpie 的「路由」页：
 * - 左列是发请求的客户端，中间是和鸣（模型路由），右列是请求落到的账号；
 * - 连线按状态着色：蓝=进行中（虚线 0.7s 循环流动）、绿=完成、琥珀=失败换人；
 * - 正在回答的账号行加深边框，其余行淡出，便于一眼看出「谁在回答」；
 * - 图下方是一句人话总结 + 统计，再下面是最近请求的逐条记录；点击任意记录看详情。
 *
 * 数据来自模型服务自己的路由记录，页面不推断、不补数据；没有请求时显示引导。
 */

const COLORS: Record<EdgeState, string> = {
  live: "#2f6feb",
  ok: "#16a34a",
  failed: "#d97706",
};

const W = 960;
const ROW_H = 64;
const ROW_GAP = 12;
const TOP = 10;
const LEFT_W = 232;
const HUB_W = 196;
const RIGHT_W = 268;
const HUB_X = (W - HUB_W) / 2;
const RIGHT_X = W - RIGHT_W;
const HUB_H = 116;

const AVATAR_COLORS = ["#7c6bd6", "#2f6feb", "#0f9d8a", "#d97706", "#db2777", "#4b5563"];

const STRATEGY_LABELS: Record<string, string> = {
  order: "按声明顺序",
  smart: "智能",
  usage: "用得最少",
  pace: "按节奏",
  weight: "按权重",
  fast: "按速度",
  rotate: "轮流",
  cheap: "最便宜",
  drain: "用完再换",
  expiring: "到期前用完",
};

function avatarColor(name: string): string {
  let hash = 0;
  for (let i = 0; i < name.length; i++) hash = (hash * 31 + name.charCodeAt(i)) >>> 0;
  return AVATAR_COLORS[hash % AVATAR_COLORS.length]!;
}

function rowY(index: number): number {
  return TOP + index * (ROW_H + ROW_GAP) + ROW_H / 2;
}

function curve(fromX: number, fromY: number, toX: number, toY: number): string {
  const mid = (fromX + toX) / 2;
  return `M ${fromX} ${fromY} C ${mid} ${fromY}, ${mid} ${toY}, ${toX} ${toY}`;
}

export function ModelTraceView() {
  const baseUrl = useLlmStore((s) => s.gateway.baseUrl);
  const [snapshot, setSnapshot] = useState<TraceSnapshot | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [paused, setPaused] = useState(false);
  const [hovered, setHovered] = useState<number | null>(null);
  const [selected, setSelected] = useState<number | null>(null);
  const [filter, setFilter] = useState<EdgeState | "all">("all");
  const [reducedMotion, setReducedMotion] = useState(false);
  const listRef = useRef<HTMLDivElement | null>(null);

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

  const graph: TraceGraph = useMemo(() => buildTraceGraph(snapshot?.routes ?? []), [snapshot]);

  const stats = useMemo(() => {
    const done = graph.rows.filter((row) => row.route.done);
    const avgMs = done.length
      ? Math.round(done.reduce((sum, row) => sum + (row.route.ms ?? 0), 0) / done.length)
      : 0;
    return {
      total: graph.rows.length,
      live: graph.rows.filter((row) => row.state === "live").length,
      ok: graph.rows.filter((row) => row.state === "ok").length,
      failed: graph.rows.filter((row) => row.state === "failed").length,
      avgMs,
      tokens: graph.rows.reduce((sum, row) => sum + (row.route.tokens ?? 0), 0),
    };
  }, [graph]);

  const visibleRows = graph.rows.filter((row) => filter === "all" || row.state === filter);
  const visibleRouteIds = new Set(visibleRows.map((row) => row.route.id));
  const agents = graph.agents.slice(0, 6);
  const accounts = graph.accounts.slice(0, 8);
  const height = TOP * 2 + Math.max(3, agents.length, accounts.length) * (ROW_H + ROW_GAP);
  const hubY = height / 2;

  const agentIndex = new Map(agents.map((node, index) => [node.id, index]));
  const accountIndex = new Map(accounts.map((node, index) => [node.id, index]));
  const agentCount = (id: string) => graph.edges.filter((edge) => edge.from === id).length;
  const accountCount = (id: string) => graph.edges.filter((edge) => edge.to === id).length;

  const storeProfiles = useLlmStore((s) => s.profiles);
  const storeRoutes = useLlmStore((s) => s.routes);
  const setPage = useUiStore((s) => s.setPage);
  const candidates = useMemo(
    () =>
      storeRoutes.map((route) => ({
        id: route.id,
        label: route.label || "候选链",
        strategy: route.strategy,
        members: route.members
          .map((member) => {
            const profile = storeProfiles.find((item) => item.id === member.profileId);
            if (!profile) return null;
            const provider = profile.model.includes("/")
              ? profile.model.split("/")[0]!
              : profile.label;
            return { id: profile.id, model: profile.model, provider };
          })
          .filter((item): item is { id: string; model: string; provider: string } => item !== null),
      })),
    [storeRoutes, storeProfiles],
  );

  const latest = graph.rows.at(-1);
  const summary = latest
    ? `${latest.route.agent || "客户端"} 请求 ${latest.route.model}，${
        latest.route.done ? `由 ${latest.account} 回答（${latest.route.status ?? "完成"}）` : "正在等待回答"
      }`
    : "";
  const seen = graph.rows.find((row) => row.route.id === selected) ?? null;

  return (
    <section aria-label="实时链路" className="space-y-3">
      <div className="flex flex-wrap items-center justify-between gap-2">
        <div className="flex items-center gap-2">
          <span
            aria-hidden="true"
            className={`inline-block h-2 w-2 rounded-full ${
              paused ? "bg-[#98a2b3]" : "rta-live-dot bg-[#12b76a]"
            }`}
          />
          <span className="text-[13px] font-bold">实时</span>
          <span className="ui-caption">
            {paused ? "已暂停" : "模型服务正在做的决定"}
            {snapshot ? ` · 最后读取 ${shortTime(snapshot.now)}` : ""}
          </span>
        </div>
        <div className="flex flex-wrap items-center gap-1.5">
          {(["all", "live", "ok", "failed"] as const).map((key) => (
            <button
              key={key}
              type="button"
              aria-pressed={filter === key}
              className={`rta-segment rounded-full px-3 py-1 text-[12px] ${
                filter === key ? "bg-ink text-white" : "bg-[#f2f3f5] text-muted hover:bg-[#e9ebef]"
              }`}
              onClick={() => setFilter(key)}
            >
              {key === "all" ? "全部" : EDGE_STATE_LABEL[key]}
            </button>
          ))}
          <button
            type="button"
            className="rta-segment rounded-full bg-[#f2f3f5] px-3 py-1 text-[12px] text-muted hover:bg-[#e9ebef]"
            onClick={() => setPaused((value) => !value)}
          >
            {paused ? "继续" : "暂停"}
          </button>
        </div>
      </div>

      {error && (
        <div role="alert" className="rounded-xl border border-[#f3c9c9] bg-[#fff6f6] p-2 text-[12px]">
          {error}
        </div>
      )}

      <div className="overflow-x-auto rounded-[20px] border border-line bg-[#f8f9fb] p-4">
        {visibleRows.length === 0 ? (
          <div className="flex min-h-[240px] flex-col items-center justify-center gap-2 text-center">
            <svg aria-hidden="true" width="160" height="72" viewBox="0 0 160 72">
              <rect x="2" y="22" width="44" height="26" rx="8" fill="#f2f3f5" stroke="#e4e7ec" />
              <rect x="114" y="2" width="44" height="26" rx="8" fill="#f2f3f5" stroke="#e4e7ec" />
              <rect x="114" y="44" width="44" height="26" rx="8" fill="#f2f3f5" stroke="#e4e7ec" />
              <rect x="62" y="22" width="36" height="26" rx="8" fill="#eef2f8" stroke="#d9e2ef" />
              <path d="M46 35 C54 35 54 15 62 15" stroke="#d0d5dd" strokeDasharray="4 4" fill="none" />
              <path d="M46 35 C54 35 54 57 62 57" stroke="#d0d5dd" strokeDasharray="4 4" fill="none" />
              <path d="M98 15 C106 15 106 35 114 35" stroke="#d0d5dd" strokeDasharray="4 4" fill="none" />
              <path d="M98 57 C106 57 106 35 114 35" stroke="#d0d5dd" strokeDasharray="4 4" fill="none" />
            </svg>
            <div className="text-[13px] font-bold">
              {graph.rows.length === 0 ? "还没有请求经过" : "当前筛选下没有请求"}
            </div>
            <p className="max-w-[380px] ui-caption">
              {graph.rows.length === 0
                ? "发一次智能体对话，这里会画出它从哪个客户端出发、经过和鸣、落到哪个账号；失败换人也会画出来。"
                : "换一个筛选条件，或点「全部」看所有请求。"}
            </p>
          </div>
        ) : (
          <div style={{ width: W, height }} className="relative mx-auto">
            <svg
              role="img"
              aria-label="路由节点图"
              width={W}
              height={height}
              className="pointer-events-none absolute inset-0"
            >
              {graph.edges
                .filter((edge) => visibleRouteIds.has(edge.routeId))
                .map((edge) => {
                  const ai = agentIndex.get(edge.from);
                  const ci = accountIndex.get(edge.to);
                  if (ai === undefined || ci === undefined) return null;
                  const y1 = rowY(ai);
                  const y2 = rowY(ci);
                  const active = hovered === edge.routeId || selected === edge.routeId;
                  const dim = hovered !== null || selected !== null;
                  const opacity = active ? 1 : dim ? 0.18 : 0.55;
                  const flowClass = edge.state === "live" && !reducedMotion ? "rta-flow" : undefined;
                  return (
                    <g
                      key={edge.id}
                      data-testid={`trace-edge-${edge.routeId}`}
                      stroke={COLORS[edge.state]}
                      strokeWidth={active ? 2.2 : 1.4}
                      fill="none"
                      opacity={opacity}
                    >
                      <path d={curve(LEFT_W, y1, HUB_X, hubY)} strokeDasharray={edge.state === "live" ? "5 6" : undefined} className={flowClass} />
                      <path
                        d={curve(HUB_X + HUB_W, hubY, RIGHT_X, y2)}
                        strokeDasharray={edge.state === "live" ? "5 6" : undefined}
                        className={flowClass}
                      />
                      <circle
                        cx={RIGHT_X}
                        cy={y2}
                        r={3}
                        fill={COLORS[edge.state]}
                        className={edge.state === "live" && !reducedMotion ? "rta-live-dot" : undefined}
                      />
                      {edge.state === "live" && !reducedMotion && (
                        <circle r={3.5} fill={COLORS.live} opacity={0.9}>
                          <animateMotion
                            dur="1.6s"
                            repeatCount="indefinite"
                            path={`M ${LEFT_W} ${y1} C ${(LEFT_W + HUB_X) / 2} ${y1}, ${(LEFT_W + HUB_X) / 2} ${hubY}, ${HUB_X} ${hubY} L ${HUB_X + HUB_W} ${hubY} C ${(HUB_X + HUB_W + RIGHT_X) / 2} ${hubY}, ${(HUB_X + HUB_W + RIGHT_X) / 2} ${y2}, ${RIGHT_X} ${y2}`}
                          />
                        </circle>
                      )}
                    </g>
                  );
                })}
            </svg>

            {agents.map((node, index) => (
              <button
                key={node.id}
                type="button"
                className="rta-hit rta-enter absolute rounded-2xl border border-line bg-white px-3 text-left"
                style={{ left: 0, top: rowY(index) - ROW_H / 2, width: LEFT_W, height: ROW_H }}
                onMouseEnter={() => setHovered(graph.edges.find((edge) => edge.from === node.id)?.routeId ?? null)}
                onMouseLeave={() => setHovered(null)}
              >
                <span className="flex items-center gap-2">
                  <span
                    className="flex h-6 w-6 shrink-0 items-center justify-center rounded-full text-[11px] font-bold text-white"
                    style={{ backgroundColor: avatarColor(node.label) }}
                  >
                    {node.label.slice(0, 1).toUpperCase()}
                  </span>
                  <span className="min-w-0">
                    <span className="block truncate text-[13px] font-bold">{node.label}</span>
                    <span className="block ui-caption">{agentCount(node.id)} 个请求</span>
                  </span>
                </span>
              </button>
            ))}

            <div
              className="absolute flex flex-col items-center justify-center rounded-[20px] border border-ink bg-white shadow-[0_10px_30px_rgba(16,24,40,0.08)]"
              style={{ left: HUB_X, top: hubY - HUB_H / 2, width: HUB_W, height: HUB_H }}
            >
              <span className="relative flex h-8 w-8 items-center justify-center">
                <span className="absolute inset-0 rounded-full bg-[#f2f3f5]" />
                <span
                  aria-hidden="true"
                  className={`absolute inset-0 rounded-full border ${
                    stats.live > 0 ? "rta-live-dot border-[#2f6feb]" : "border-line"
                  }`}
                />
                <span className="relative text-[13px] font-bold">鸣</span>
              </span>
              <div className="mt-1 text-[14px] font-bold tracking-wide">和鸣</div>
              <span className="mt-1 rounded-full bg-[#111] px-2.5 py-0.5 text-[11px] text-white">
                {stats.live > 0 ? "回答中" : "待命"}
              </span>
            </div>

            {accounts.map((node, index) => {
              const routeId = graph.edges.find((edge) => edge.to === node.id)?.routeId ?? null;
              const active = visibleRows.some(
                (row) => row.account === node.label && row.state === "live",
              );
              const label = node.label;
              const model = node.sub.includes("·")
                ? node.sub.split("·").slice(1).join("·").trim()
                : node.sub;
              return (
                <button
                  key={node.id}
                  type="button"
                  className={`rta-hit rta-enter absolute rounded-[18px] border bg-white px-3 text-left ${
                    active ? "border-ink shadow-[0_6px_18px_rgba(16,24,40,0.06)]" : "border-line"
                  }`}
                  style={{ left: RIGHT_X, top: rowY(index) - ROW_H / 2, width: RIGHT_W, height: ROW_H }}
                  onMouseEnter={() => setHovered(routeId)}
                  onMouseLeave={() => setHovered(null)}
                  onClick={() => {
                    if (routeId !== null) {
                      setSelected(routeId);
                      listRef.current?.scrollIntoView({ block: "nearest" });
                    }
                  }}
                >
                  <span className="flex items-center gap-2">
                    <span
                      className="flex h-6 w-6 shrink-0 items-center justify-center rounded-full text-[11px] font-bold text-white"
                      style={{ backgroundColor: avatarColor(label) }}
                    >
                      {label.slice(0, 1).toUpperCase()}
                    </span>
                    <span className="min-w-0 flex-1">
                      <span className="flex items-baseline gap-1.5">
                        <span className="truncate text-[13px] font-bold">{label}</span>
                        {model && <span className="truncate font-mono text-[11px] text-muted">{model}</span>}
                      </span>
                      <span className="block ui-caption">{accountCount(node.id)} 个请求</span>
                    </span>
                    <span className={`shrink-0 text-[11px] ${active ? "text-[#2f6feb]" : "text-muted"}`}>
                      {active ? "回答中…" : visibleRows.some((row) => row.account === node.label) ? "已就绪" : "待命"}
                    </span>
                  </span>
                </button>
              );
            })}
          </div>
        )}
      </div>

      {graph.rows.length > 0 && (
        <div className="flex flex-wrap items-end justify-between gap-3 rounded-2xl border border-line bg-white px-4 py-3">
          <div className="text-[13px]">{summary}</div>
          <div className="flex items-end gap-6">
            {[
              { label: "请求", value: stats.total },
              { label: "改道", value: stats.failed },
              {
                label: "失败",
                value: graph.rows.filter((row) => (row.route.status ?? 0) >= 400).length,
              },
            ].map((item) => (
              <span key={item.label} className="text-right">
                <span className="block text-[20px] font-bold leading-none">{item.value}</span>
                <span className="block ui-caption">{item.label}</span>
              </span>
            ))}
          </div>
        </div>
      )}

      {candidates.length > 0 && (
        <div className="rounded-[20px] border border-line bg-white p-4">
          <div className="flex items-center justify-between">
            <div className="text-[13px] font-bold">候选链</div>
            <button
              type="button"
              className="rta-segment rounded-full bg-[#f2f3f5] px-3 py-1 text-[12px] text-muted hover:bg-[#e9ebef]"
              onClick={() => setPage("modelroute")}
            >
              管理候选链 →
            </button>
          </div>
          <ul className="mt-2 divide-y divide-line">
            {candidates.map((route) => (
              <li key={route.id} className="flex items-center gap-3 py-2">
                <span className="flex -space-x-1.5">
                  {route.members.slice(0, 3).map((member) => (
                    <span
                      key={member.id}
                      className="flex h-6 w-6 items-center justify-center rounded-full border-2 border-white text-[10px] font-bold text-white"
                      style={{ backgroundColor: avatarColor(member.provider) }}
                      title={member.model}
                    >
                      {member.provider.slice(0, 1).toUpperCase()}
                    </span>
                  ))}
                </span>
                <span className="min-w-0 flex-1">
                  <span className="block truncate text-[13px] font-bold">{route.label}</span>
                  <span className="block truncate ui-caption">
                    {route.members.map((member) => member.model).join(" · ") || "还没有候选"}
                  </span>
                </span>
                <span className="shrink-0 rounded-full bg-[#f2f3f5] px-2.5 py-0.5 text-[11px] text-muted">
                  {STRATEGY_LABELS[route.strategy ?? "order"] ?? route.strategy}
                </span>
              </li>
            ))}
          </ul>
        </div>
      )}

      {graph.rows.length > 0 && (
        <div ref={listRef} className="rounded-[20px] border border-line bg-white p-4">
          <div className="text-[13px] font-bold">最近请求是怎么走的</div>
          <ul className="mt-2 space-y-2">
            {[...visibleRows]
              .reverse()
              .slice(0, 8)
              .map(({ route, account, state }) => (
                <li key={route.id}>
                  <button
                    type="button"
                    className="flex w-full items-start gap-2 text-left"
                    onClick={() => setSelected(route.id)}
                    onMouseEnter={() => setHovered(route.id)}
                    onMouseLeave={() => setHovered(null)}
                  >
                    <span
                      aria-hidden="true"
                      className="mt-1.5 h-2 w-2 shrink-0 rounded-full"
                      style={{ backgroundColor: COLORS[state] }}
                    />
                    <span className="min-w-0">
                      <span className="block text-[12px]">
                        {route.agent || "客户端"} 请求 <span className="font-mono">{route.model}</span>
                        {route.done ? `，由 ${account} 回答` : `，正在交给 ${account}`}
                      </span>
                      <span className="block ui-caption">
                        {shortTime(route.time)}
                        {route.ms ? ` · ${route.ms}ms` : ""}
                        {route.tokens ? ` · ${route.tokens} tokens` : ""}
                        {route.status ? ` · ${route.status}` : ""}
                        {route.group?.name ? ` · 分组 ${route.group.name}` : ""}
                      </span>
                    </span>
                  </button>
                </li>
              ))}
          </ul>
        </div>
      )}

      {selected && (
        <div className="rounded-xl border border-line bg-[#fafafa] p-3 text-[12px]">
          <div className="flex items-center justify-between">
            <div className="font-bold">请求详情</div>
            <button type="button" className="ui-btn ui-btn-sm ui-btn-ghost" onClick={() => setSelected(null)}>
              关闭
            </button>
          </div>
          {seen && (
            <div className="mt-1 grid gap-x-6 gap-y-0.5 sm:grid-cols-2">
              <span>客户端：{seen.route.agent || "—"}</span>
              <span>模型：{seen.route.model}</span>
              <span>落点：{seen.account}</span>
              <span>耗时：{seen.route.ms ? `${seen.route.ms}ms` : "—"}</span>
              <span>token：{seen.route.tokens ?? "—"}</span>
              <span>状态：{seen.route.status ?? (seen.route.done ? "完成" : "进行中")}</span>
            </div>
          )}
          {seen?.route.error && <div className="mt-1 text-[#b42318]">{seen.route.error}</div>}
        </div>
      )}
    </section>
  );
}
