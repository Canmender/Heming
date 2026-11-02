import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import type { WikiGraph, WikiPage, WikiKind } from "../lib/wiki/index.js";
import { KIND_LABEL } from "../lib/wiki/index.js";
import { layoutGraph, nodeRadius } from "../lib/wiki/layout.js";
import { Avatar } from "./Avatar.js";

/**
 * 知识库图谱视图（参照 Obsidian graph view）。
 *
 * 看的是**形状**而不是内容：哪些页面是枢纽、哪些是孤儿、有哪些概念扎堆。
 * 这正是标准里推荐用图谱的理由——库长大之后，纯列表看不出结构问题。
 *
 * 交互沿用雷达图的成熟做法（缩放 + 拖动平移 + 双击复位），
 * 因为那两个手势用户已经在别处习惯了，不必重新学。
 */

const MIN_ZOOM = 0.4;
const MAX_ZOOM = 2.4;
const ZOOM_STEP = 0.15;
const DRAG_THRESHOLD = 4;

/** 类别 → 颜色。与雷达图扇区的低饱和风格保持一致，不喧宾夺主。 */
const KIND_COLOR: Record<WikiKind, string> = {
  entities: "#3b82f6",
  concepts: "#8b5cf6",
  sources: "#10b981",
  synthesis: "#f59e0b",
  notes: "#94a3b8",
};

export function WikiGraphView({
  graph,
  pages,
  selected,
  onSelect,
}: {
  graph: WikiGraph;
  pages: WikiPage[];
  selected: string | null;
  onSelect: (path: string) => void;
}) {
  const wrapRef = useRef<HTMLDivElement | null>(null);
  const [size, setSize] = useState({ w: 800, h: 480 });
  const [zoom, setZoom] = useState(1);
  const [pan, setPan] = useState({ x: 0, y: 0 });
  const [panning, setPanning] = useState(false);
  const [hover, setHover] = useState<string | null>(null);
  const dragRef = useRef<{ x: number; y: number; panX: number; panY: number } | null>(null);
  const draggedRef = useRef(false);

  // 容器尺寸：图谱要铺满可用区域，得跟着窗口走
  useEffect(() => {
    const el = wrapRef.current;
    if (!el) return;
    const read = () => setSize({ w: el.clientWidth, h: el.clientHeight });
    read();
    // ResizeObserver 在 jsdom 里不存在，浏览器端才有；缺失时退回 window.resize
    if (typeof ResizeObserver !== "undefined") {
      const ro = new ResizeObserver(read);
      ro.observe(el);
      return () => ro.disconnect();
    }
    window.addEventListener("resize", read);
    return () => window.removeEventListener("resize", read);
  }, []);

  const points = useMemo(() => layoutGraph(graph, size.w, size.h), [graph, size.w, size.h]);
  const pointById = useMemo(() => new Map(points.map((p) => [p.id, p])), [points]);
  const titleById = useMemo(() => new Map(pages.map((p) => [p.path, p.title])), [pages]);

  const clampZoom = useCallback((z: number) => {
    if (!Number.isFinite(z)) return 1;
    return Math.round(Math.min(MAX_ZOOM, Math.max(MIN_ZOOM, z)) * 100) / 100;
  }, []);

  const reset = useCallback(() => {
    setZoom(1);
    setPan({ x: 0, y: 0 });
  }, []);

  const zoomBy = useCallback(
    (delta: number) => setZoom((z) => clampZoom(z + delta)),
    [clampZoom],
  );

  // Ctrl/⌘ + 滚轮缩放：普通滚轮留给页面滚动，不劫持
  useEffect(() => {
    const el = wrapRef.current;
    if (!el) return;
    const onWheel = (e: WheelEvent) => {
      if (!e.ctrlKey && !e.metaKey) return;
      e.preventDefault();
      setZoom((z) => clampZoom(z + (e.deltaY > 0 ? -ZOOM_STEP : ZOOM_STEP)));
    };
    el.addEventListener("wheel", onWheel, { passive: false });
    return () => el.removeEventListener("wheel", onWheel);
  }, [clampZoom]);

  const onDown = (e: React.PointerEvent<HTMLDivElement>) => {
    draggedRef.current = false;
    dragRef.current = { x: e.clientX, y: e.clientY, panX: pan.x, panY: pan.y };
    setPanning(true);
    e.currentTarget.setPointerCapture?.(e.pointerId);
  };

  const onMove = (e: React.PointerEvent<HTMLDivElement>) => {
    const d = dragRef.current;
    if (!d) return;
    const dx = e.clientX - d.x;
    const dy = e.clientY - d.y;
    if (!draggedRef.current && Math.hypot(dx, dy) > DRAG_THRESHOLD) draggedRef.current = true;
    setPan({ x: d.panX + dx, y: d.panY + dy });
  };

  const onUp = (e: React.PointerEvent<HTMLDivElement>) => {
    if (!dragRef.current) return;
    dragRef.current = null;
    setPanning(false);
    try {
      e.currentTarget.releasePointerCapture?.(e.pointerId);
    } catch {
      /* 已释放 */
    }
  };

  const orphans = graph.nodes.filter((n) => n.orphan).length;

  if (graph.nodes.length === 0) {
    return (
      <div className="flex h-full items-center justify-center text-[12px] text-muted">
        还没有页面。建一页就会出现在图谱里。
      </div>
    );
  }

  return (
    <div className="flex h-full flex-col">
      <div className="flex flex-wrap items-center gap-2 pb-2 text-[11px] text-muted">
        <span className="font-bold text-muted">图谱</span>
        <span>{graph.nodes.length} 页 · {graph.edges.length} 条链接</span>
        {orphans > 0 && (
          <span className="text-[#b45309]">{orphans} 个孤儿页（无任何链接）</span>
        )}
        <span className="ml-auto flex items-center gap-2.5">
          {WIKI_LEGEND.map((k) => (
            <span key={k} className="flex items-center gap-1">
              <span
                className="inline-block h-2 w-2 rounded-full"
                style={{ backgroundColor: KIND_COLOR[k] }}
              />
              {KIND_LABEL[k]}
            </span>
          ))}
        </span>
      </div>

      <div
        ref={wrapRef}
        role="application"
        aria-label="知识库图谱，可缩放与拖动"
        data-panning={panning ? "on" : "off"}
        onPointerDown={onDown}
        onPointerMove={onMove}
        onPointerUp={onUp}
        onPointerCancel={onUp}
        onDoubleClick={reset}
        className="relative min-h-[320px] flex-1 cursor-grab overflow-hidden rounded-xl border border-line bg-[#fcfcfc] touch-none"
        style={{ cursor: panning ? "grabbing" : undefined }}
      >
        <svg width={size.w} height={size.h} className="block">
          <g
            transform={`translate(${size.w / 2 + pan.x} ${size.h / 2 + pan.y}) scale(${zoom}) translate(${-size.w / 2} ${-size.h / 2})`}
            style={{ transition: panning ? "none" : "transform .15s ease" }}
          >
            {/* 连线 */}
            {graph.edges.map((edge, i) => {
              const a = pointById.get(edge.source);
              const b = pointById.get(edge.target);
              if (!a || !b) return null;
              const active =
                hover === edge.source || hover === edge.target ||
                selected === edge.source || selected === edge.target;
              return (
                <line
                  key={`${edge.source}->${edge.target}-${i}`}
                  x1={a.x}
                  y1={a.y}
                  x2={b.x}
                  y2={b.y}
                  stroke={active ? "#9ca3af" : "#e3e3e3"}
                  strokeWidth={active ? 1.4 : 0.9}
                />
              );
            })}
            {/* 节点 */}
            {graph.nodes.map((node) => {
              const p = pointById.get(node.id);
              if (!p) return null;
              const active = hover === node.id || selected === node.id;
              return (
                <g key={node.id} transform={`translate(${p.x} ${p.y})`}>
                  <circle
                    r={nodeRadius(node.degree)}
                    fill={active ? KIND_COLOR[node.kind] : "#fff"}
                    stroke={KIND_COLOR[node.kind]}
                    strokeWidth={node.orphan ? 1 : 1.8}
                    // 孤儿页用虚线圈：一眼看出「这篇谁都没链接」
                    strokeDasharray={node.orphan ? "2 2" : undefined}
                    opacity={active ? 1 : 0.92}
                  />
                  <text
                    y={nodeRadius(node.degree) + 11}
                    textAnchor="middle"
                    fontSize={active ? 11 : 9.5}
                    fontWeight={active ? 700 : 400}
                    fill={active ? "#1a1a1a" : "#777"}
                    style={{ pointerEvents: "none", userSelect: "none" }}
                  >
                    {node.title.length > 12 ? `${node.title.slice(0, 12)}…` : node.title}
                  </text>
                </g>
              );
            })}
          </g>
        </svg>

        {/* 缩放控件 */}
        <div className="absolute bottom-2 right-2 flex items-center gap-1 rounded-lg border border-line bg-white px-1 py-0.5 shadow-card">
          <button
            type="button"
            aria-label="缩小图谱"
            onClick={() => zoomBy(-ZOOM_STEP)}
            className="rounded-sm px-1.5 py-0.5 text-[12px] text-muted hover:bg-[#f3f3f3]"
          >
            −
          </button>
          <button
            type="button"
            aria-label="复位图谱"
            onClick={reset}
            className="min-w-[38px] rounded-sm px-1 py-0.5 text-[10px] text-muted hover:bg-[#f3f3f3]"
          >
            {Math.round(zoom * 100)}%
          </button>
          <button
            type="button"
            aria-label="放大图谱"
            onClick={() => zoomBy(ZOOM_STEP)}
            className="rounded-sm px-1.5 py-0.5 text-[12px] text-muted hover:bg-[#f3f3f3]"
          >
            ＋
          </button>
        </div>
        <div className="pointer-events-none absolute bottom-2 left-2 text-[10px] text-muted">
          拖动平移 · Ctrl+滚轮缩放 · 双击复位 · 点节点打开页面
        </div>
      </div>
    </div>
  );
}

/** 图例顺序（与 WIKI_KINDS 一致）。 */
const WIKI_LEGEND: WikiKind[] = ["entities", "concepts", "sources", "synthesis", "notes"];