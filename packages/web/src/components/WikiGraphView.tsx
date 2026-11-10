import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import type { WikiGraph, WikiPage, WikiKind } from "../lib/wiki/index.js";
import { KIND_LABEL } from "../lib/wiki/index.js";
import { layoutGraph, nodeRadius } from "../lib/wiki/layout.js";
import {
  ZOOM_BUTTON_STEP,
  isDragBeyondThreshold,
  resetViewport,
  stepZoom,
  viewportTransform,
  wheelViewport,
  zoomPercent,
  type GraphViewport,
  type ViewportPoint,
} from "./graphViewport.js";

/**
 * 知识库图谱视图（参照 Obsidian graph view）。
 *
 * 看的是**形状**而不是内容：哪些页面是枢纽、哪些是孤儿、有哪些概念扎堆。
 * 这正是标准里推荐用图谱的理由——库长大之后，纯列表看不出结构问题。
 *
 * 交互沿用雷达图的成熟做法（缩放 + 拖动平移 + 双击复位），
 * 因为那两个手势用户已经在别处习惯了，不必重新学。
 *
 * 本轮（d.126）把「一格一格跳」的滚轮缩放改成**以光标为中心的连续缩放**：
 * 滚轮下面那一点在缩放前后不动，用户才觉得"放大的是我这里"；
 * 换算全在 `graphViewport.ts` 的纯函数里（可单测，不靠截图验收）。
 * 尊重 `prefers-reduced-motion`：系统要求减少动效时不加过渡动画。
 */

/** 容器尺寸兜底：jsdom/首帧拿不到布局时用 4:3 的默认画布，而不是 0×0 的空白。 */
const FALLBACK_SIZE = { w: 800, h: 480 };
/** 滚轮缩放期间暂停 CSS 过渡：过渡会让"以光标为中心"在动画过程中看起来像漂移。 */
const WHEEL_SETTLE_MS = 140;

/** 类别 → 颜色。与雷达图扇区的低饱和风格保持一致，不喧宾夺主。 */
const KIND_COLOR: Record<WikiKind, string> = {
  entities: "#3b82f6",
  concepts: "#8b5cf6",
  sources: "#10b981",
  synthesis: "#f59e0b",
  notes: "#94a3b8",
};

/** 系统是否要求减少动效（不支持 matchMedia 的环境按 false 处理）。 */
function prefersReducedMotion(): boolean {
  if (typeof window === "undefined" || typeof window.matchMedia !== "function") return false;
  try {
    return window.matchMedia("(prefers-reduced-motion: reduce)").matches;
  } catch {
    return false;
  }
}

export function WikiGraphView({
  graph,
  pages,
  selected,
  onSelect,
  showLegend = true,
  emptyHint,
}: {
  graph: WikiGraph;
  pages: WikiPage[];
  selected: string | null;
  onSelect: (path: string) => void;
  /** 是否显示右侧的类别图例。vault 图谱只有「笔记」一类，传 false 让调用方自己标题。 */
  showLegend?: boolean;
  /** 空图时的提示文案（缺省沿用 wiki 页的说法）。 */
  emptyHint?: string;
}) {
  const wrapRef = useRef<HTMLDivElement | null>(null);
  const [size, setSize] = useState(FALLBACK_SIZE);
  const [viewport, setViewport] = useState<GraphViewport>(resetViewport);
  const [panning, setPanning] = useState(false);
  const [wheelActive, setWheelActive] = useState(false);
  const [reduceMotion, setReduceMotion] = useState(prefersReducedMotion);
  const [hover, setHover] = useState<string | null>(null);
  const dragRef = useRef<{ x: number; y: number; panX: number; panY: number } | null>(null);
  const draggedRef = useRef(false);
  /** 拖拽松手的位置：浏览器随后补发的 click 与它重合，据此吞掉那一次点击。 */
  const dragEndRef = useRef<{ x: number; y: number } | null>(null);
  const wheelTimerRef = useRef<ReturnType<typeof setTimeout> | null>(null);
  /** 尺寸给滚轮监听用：effect 里拿最新值，避免每次 resize 重建监听器。 */
  const sizeRef = useRef(size);
  sizeRef.current = size;

  // 容器尺寸：图谱要铺满可用区域，得跟着窗口走
  useEffect(() => {
    const el = wrapRef.current;
    if (!el) return;
    const read = () => {
      const w = el.clientWidth;
      const h = el.clientHeight;
      // 布局还没算出来（jsdom / 首帧）时保留兜底尺寸，别把画布缩成 0×0
      setSize({ w: w > 0 ? w : FALLBACK_SIZE.w, h: h > 0 ? h : FALLBACK_SIZE.h });
    };
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

  // 系统动效偏好：跟随变化（用户中途改设置也生效）
  useEffect(() => {
    if (typeof window === "undefined" || typeof window.matchMedia !== "function") return;
    let mq: MediaQueryList;
    try {
      mq = window.matchMedia("(prefers-reduced-motion: reduce)");
    } catch {
      return;
    }
    const onChange = () => setReduceMotion(mq.matches);
    mq.addEventListener?.("change", onChange);
    return () => mq.removeEventListener?.("change", onChange);
  }, []);

  const points = useMemo(() => layoutGraph(graph, size.w, size.h), [graph, size.w, size.h]);
  const pointById = useMemo(() => new Map(points.map((p) => [p.id, p])), [points]);
  const titleById = useMemo(() => new Map(pages.map((p) => [p.path, p.title])), [pages]);

  const reset = useCallback(() => {
    setViewport(resetViewport());
  }, []);

  const zoomBy = useCallback((delta: number) => {
    setViewport((current) => stepZoom(current, delta, sizeRef.current));
  }, []);

  /** 滚轮缩放期间把过渡关掉：锚点缩放是逐帧计算，过渡只会让内容"糊着漂"。 */
  const markWheelActive = useCallback(() => {
    setWheelActive(true);
    if (wheelTimerRef.current) clearTimeout(wheelTimerRef.current);
    wheelTimerRef.current = setTimeout(() => {
      wheelTimerRef.current = null;
      setWheelActive(false);
    }, WHEEL_SETTLE_MS);
  }, []);

  useEffect(
    () => () => {
      if (wheelTimerRef.current) clearTimeout(wheelTimerRef.current);
    },
    [],
  );

  // 滚轮 = 以光标为中心的连续缩放。
  // 不用 Ctrl 修饰键：图谱面板是独立视图（不叠在长页面上），滚轮缩放正是这里的常规手势；
  // 也不用 passive 监听——必须 preventDefault 才能阻止"滚轮缩放同时把页面滚走"。
  useEffect(() => {
    const el = wrapRef.current;
    if (!el) return;
    const onWheel = (e: WheelEvent) => {
      e.preventDefault();
      const rect = el.getBoundingClientRect();
      const anchor: ViewportPoint = { x: e.clientX - rect.left, y: e.clientY - rect.top };
      setViewport((current) => wheelViewport(current, e, anchor, sizeRef.current));
      markWheelActive();
    };
    el.addEventListener("wheel", onWheel, { passive: false });
    return () => el.removeEventListener("wheel", onWheel);
  }, [markWheelActive]);

  const onDown = (e: React.PointerEvent<HTMLDivElement>) => {
    draggedRef.current = false;
    dragRef.current = { x: e.clientX, y: e.clientY, panX: viewport.pan.x, panY: viewport.pan.y };
    setPanning(true);
    e.currentTarget.setPointerCapture?.(e.pointerId);
  };

  const onMove = (e: React.PointerEvent<HTMLDivElement>) => {
    const d = dragRef.current;
    if (!d) return;
    const dx = e.clientX - d.x;
    const dy = e.clientY - d.y;
    if (!draggedRef.current && isDragBeyondThreshold(dx, dy)) draggedRef.current = true;
    setViewport((current) => ({
      ...current,
      pan: { x: d.panX + dx, y: d.panY + dy },
    }));
  };

  const onUp = (e: React.PointerEvent<HTMLDivElement>) => {
    if (!dragRef.current) return;
    dragRef.current = null;
    setPanning(false);
    // 只有真的拖动过才记「松手点」：没拖动的点击不该被吞
    dragEndRef.current = draggedRef.current ? { x: e.clientX, y: e.clientY } : null;
    draggedRef.current = false;
    try {
      e.currentTarget.releasePointerCapture?.(e.pointerId);
    } catch {
      /* 已释放 */
    }
  };

  /**
   * 拖拽结束后浏览器仍会补发一次 click：不拦的话「拖动平移」会顺手打开一个页面。
   *
   * 用「click 坐标是否等于松手坐标」判断而不是无脑吞下一次点击：
   * 用户拖动后立刻点另一个节点（坐标不同）应该照常打开，不该被吃掉一次操作。
   */
  const selectNode = useCallback(
    (path: string, event: { clientX: number; clientY: number } | null) => {
      const end = dragEndRef.current;
      dragEndRef.current = null;
      if (
        event &&
        end &&
        Math.abs(event.clientX - end.x) <= 2 &&
        Math.abs(event.clientY - end.y) <= 2
      ) {
        return;
      }
      onSelect(path);
    },
    [onSelect],
  );

  const orphans = graph.nodes.filter((n) => n.orphan).length;
  const percent = zoomPercent(viewport.zoom);
  const animate = !reduceMotion && !panning && !wheelActive;

  if (graph.nodes.length === 0) {
    return (
      <div className="flex h-full items-center justify-center text-[12px] text-muted">
        {emptyHint ?? "还没有页面。建一页就会出现在图谱里。"}
      </div>
    );
  }

  return (
    <div className="flex h-full flex-col">
      <div className="flex flex-wrap items-center gap-2 pb-2 text-[11px] text-muted">
        <span className="font-bold text-muted">图谱</span>
        <span>{graph.nodes.length} 页 · {graph.edges.length} 条链接</span>
        {orphans > 0 && (
          <span className="text-[var(--warn)]">{orphans} 个孤儿页（无任何链接）</span>
        )}
        <span className="ml-auto flex items-center gap-2.5">
          {showLegend
            ? WIKI_LEGEND.map((k) => (
                <span key={k} className="flex items-center gap-1">
                  <span
                    className="inline-block h-2 w-2 rounded-full"
                    style={{ backgroundColor: KIND_COLOR[k] }}
                  />
                  {KIND_LABEL[k]}
                </span>
              ))
            : null}
        </span>
      </div>

      <div
        ref={wrapRef}
        role="application"
        aria-label="知识库图谱，可缩放与拖动"
        data-panning={panning ? "on" : "off"}
        data-zoom={viewport.zoom}
        data-testid="wiki-graph-canvas"
        onPointerDown={onDown}
        onPointerMove={onMove}
        onPointerUp={onUp}
        onPointerCancel={onUp}
        onDoubleClick={reset}
        className="relative min-h-[320px] flex-1 cursor-grab overflow-hidden rounded-xl border border-line-soft bg-[var(--subtle)] touch-none"
        style={{ cursor: panning ? "grabbing" : undefined }}
      >
        <svg width={size.w} height={size.h} className="block">
          <g
            transform={viewportTransform(viewport, size)}
            // 拖拽/滚轮期间不加过渡（见文件头）；其余情况给按钮缩放一个短过渡
            style={{ transition: animate ? "transform .15s ease" : "none" }}
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
                  stroke={active ? "var(--line-strong)" : "var(--line)"}
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
                // 点节点打开页面：整组（圆 + 文字）都是点击区，点击半径比 circle 大，好点
                <g
                  key={node.id}
                  transform={`translate(${p.x} ${p.y})`}
                  role="button"
                  tabIndex={0}
                  aria-label={`打开页面 ${node.title}`}
                  onClick={(e) => selectNode(node.id, e)}
                  onKeyDown={(e) => {
                    if (e.key === "Enter" || e.key === " ") {
                      e.preventDefault();
                      selectNode(node.id, null);
                    }
                  }}
                  style={{ cursor: "pointer" }}
                >
                  <circle
                    r={nodeRadius(node.degree)}
                    fill={active ? KIND_COLOR[node.kind] : "var(--surface)"}
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
                    fill={active ? "var(--ink)" : "var(--muted)"}
                    style={{ pointerEvents: "none", userSelect: "none" }}
                  >
                    {(titleById.get(node.id) ?? node.title).length > 12
                      ? `${(titleById.get(node.id) ?? node.title).slice(0, 12)}…`
                      : (titleById.get(node.id) ?? node.title)}
                  </text>
                </g>
              );
            })}
          </g>
        </svg>

        {/* 缩放控件：−/百分比/＋ + 重置视图（双击复位保留为快捷手势） */}
        <div className="absolute bottom-2 right-2 flex items-center gap-1 rounded-lg border border-line-soft bg-[var(--surface)] px-1 py-0.5 shadow-card">
          <button
            type="button"
            aria-label="缩小图谱"
            onClick={() => zoomBy(-ZOOM_BUTTON_STEP)}
            className="rounded-sm px-1.5 py-0.5 text-[12px] text-muted transition-colors hover:bg-[var(--subtle-3)] hover:text-ink"
          >
            −
          </button>
          <span
            aria-live="polite"
            data-testid="graph-zoom-percent"
            className="min-w-[38px] text-center text-[10px] tabular-nums text-muted"
          >
            {percent}%
          </span>
          <button
            type="button"
            aria-label="放大图谱"
            onClick={() => zoomBy(ZOOM_BUTTON_STEP)}
            className="rounded-sm px-1.5 py-0.5 text-[12px] text-muted transition-colors hover:bg-[var(--subtle-3)] hover:text-ink"
          >
            ＋
          </button>
          <button
            type="button"
            aria-label="重置视图"
            onClick={reset}
            className="ml-0.5 rounded-sm px-1.5 py-0.5 text-[10px] text-muted transition-colors hover:bg-[var(--subtle-3)] hover:text-ink"
          >
            重置
          </button>
        </div>
        <div className="pointer-events-none absolute bottom-2 left-2 text-[10px] text-muted">
          拖动平移 · 滚轮缩放（以光标为中心） · 双击复位 · 点节点打开页面
        </div>
      </div>
    </div>
  );
}

/** 图例顺序（与 WIKI_KINDS 一致）。 */
const WIKI_LEGEND: WikiKind[] = ["entities", "concepts", "sources", "synthesis", "notes"];
