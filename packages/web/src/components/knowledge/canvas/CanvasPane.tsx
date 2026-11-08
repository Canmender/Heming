import { useEffect, useId, useMemo, useRef, useState } from "react";
import {
  GRID_SIZE,
  addTextNode,
  canvasBounds,
  createNodeId,
  edgeGeometry,
  findNode,
  moveNode,
  parseCanvas,
  removeNode,
  serializeCanvas,
  snapToGrid,
  updateNode,
  type CanvasDoc,
  type CanvasNode,
} from "./canvasModel.js";

/**
 * Obsidian Canvas 画布视图（受控组件）。
 *
 * 组件只做三件事：把文档画成 SVG、把用户手势翻译成「新文档」、用
 * `onChange(serializeCanvas(next))` 交回去。**不写文件、不碰存储、不自己 setState 文档**——
 * 落盘与脏标记由知识库页统一负责（见 `KnowledgePage` 的 EditorPane 分支）。
 *
 * 安全与语义约束：
 * - 坏 JSON 只显示中文错误 + 原文只读预览，任何手势都不触发 `onChange`；
 * - `readOnly` 时禁用新建/编辑/拖动/删除，但保留平移缩放（看画布不算写操作）；
 * - 颜色/填充全部走 CSS 变量（`--surface` / `--ink` / `--line-strong` / `--heat-3`…），
 *   暗色主题自动可读，不出现硬编码亮色；
 * - 链接节点只放行 http(s)，文件节点点击走 `onOpenLink`（由页面决定打开哪篇笔记）。
 */

export interface CanvasPaneProps {
  /** 画布文件的原始文本（`.canvas` 的 JSON）。 */
  text: string;
  /** 文档变更回调；只在用户操作后调用，参数是完整的新文件文本。 */
  onChange: (next: string) => void;
  /** 只读（坏 JSON 预览、只读模式共用）。 */
  readOnly?: boolean;
  /** 点击文件节点：打开库内笔记（rel 为库内相对路径）。 */
  onOpenLink?: (rel: string) => void;
  /** 读库内图片附件 → data URL / blob URL（桌面桥 vault:readBinary）。 */
  resolveAsset?: (rel: string) => Promise<string | null>;
}

/** 逻辑视口尺寸：viewBox 的基准大小，缩放只改 viewBox 宽高，不依赖容器测量。 */
const VIEW_WIDTH = 1200;
const VIEW_HEIGHT = 800;
const MIN_SCALE = 0.2;
const MAX_SCALE = 3;

type DragState =
  | {
      kind: "pan";
      startClientX: number;
      startClientY: number;
      originViewX: number;
      originViewY: number;
      unitsPerPx: number;
    }
  | {
      kind: "node";
      id: string;
      startClientX: number;
      startClientY: number;
      originX: number;
      originY: number;
      unitsPerPx: number;
      baseDoc: CanvasDoc;
      moved: boolean;
    };

/** Obsidian 色板预设 → 主题 token；未知值只在是十六进制时原样使用（数据驱动，不是硬编码样式）。 */
function accentOf(color: string | undefined): string | null {
  if (!color) return null;
  const preset: Record<string, string> = {
    "1": "var(--danger)",
    "2": "var(--warn)",
    "3": "var(--warn)",
    "4": "var(--success)",
    "5": "var(--heat-3)",
    "6": "var(--heat-4)",
  };
  if (preset[color]) return preset[color];
  if (/^#[0-9a-f]{3,8}$/i.test(color)) return color;
  return null;
}

function fileNameOf(rel: string | undefined): string {
  if (!rel) return "（未指定文件）";
  const parts = rel.split("/");
  return parts[parts.length - 1] || rel;
}

function isImageRel(rel: string | undefined): boolean {
  return typeof rel === "string" && /\.(png|jpe?g|gif|webp|svg)$/i.test(rel);
}

/** 只接受图片 data URL / blob URL，避免把任意协议塞进 <image href>。 */
function sanitizeAssetUrl(url: string | null | undefined): string | null {
  if (typeof url !== "string") return null;
  if (url.startsWith("data:image/") || url.startsWith("blob:")) return url;
  return null;
}

function isHttpUrl(url: string | undefined): boolean {
  return typeof url === "string" && /^https?:\/\//i.test(url.trim());
}

function nodeAriaLabel(node: CanvasNode): string {
  switch (node.type) {
    case "text":
      return `文本节点：${node.text?.trim() || "空白"}`;
    case "file":
      return `文件节点：${fileNameOf(node.file)}`;
    case "link":
      return `链接节点：${node.url ?? "无地址"}`;
    default:
      return `分组：${node.label ?? "未命名"}`;
  }
}

/** 工具栏按钮共用样式：走 token，暗色自动可读；禁用态降透明度。 */
const toolbarButton =
  "rounded-sm border border-line px-2 py-1 text-[11px] leading-4 text-ink transition-colors hover:bg-subtle-3 disabled:cursor-not-allowed disabled:opacity-40";

export function CanvasPane({
  text,
  onChange,
  readOnly = false,
  onOpenLink,
  resolveAsset,
}: CanvasPaneProps) {
  const parsed = useMemo(() => parseCanvas(text), [text]);
  const doc = parsed.ok ? parsed.doc : null;
  const docRef = useRef<CanvasDoc | null>(doc);
  docRef.current = doc;

  const [selectedId, setSelectedId] = useState<string | null>(null);
  const [editing, setEditing] = useState<{ id: string; draft: string } | null>(null);
  const [view, setView] = useState({ x: -60, y: -60, scale: 1 });
  const [assets, setAssets] = useState<Record<string, string | null>>({});

  const svgRef = useRef<SVGSVGElement | null>(null);
  const dragRef = useRef<DragState | null>(null);
  const cancelEditingRef = useRef(false);
  // SVG 内 id 不能带 useId 的冒号（url(#…) 解析会失败），这里过滤成安全字符。
  const markerId = `canvas-arrow-${useId().replace(/[^a-zA-Z0-9_-]/g, "")}`;

  const viewWidth = VIEW_WIDTH / view.scale;
  const viewHeight = VIEW_HEIGHT / view.scale;

  /* -------------------------------------------------- 图片附件（异步读） */
  const imageRels = useMemo(() => {
    if (!doc) return [] as string[];
    const rels = new Set<string>();
    for (const node of doc.nodes) {
      if (node.type === "file" && isImageRel(node.file) && node.file) rels.add(node.file);
    }
    return [...rels].sort();
  }, [doc]);
  const imageKey = imageRels.join("\u0000");

  useEffect(() => {
    if (!resolveAsset || imageRels.length === 0) return;
    let cancelled = false;
    for (const rel of imageRels) {
      if (rel in assets) continue;
      resolveAsset(rel)
        .then((url) => {
          if (cancelled) return;
          setAssets((prev) => ({ ...prev, [rel]: sanitizeAssetUrl(url) }));
        })
        .catch(() => {
          if (cancelled) return;
          setAssets((prev) => ({ ...prev, [rel]: null }));
        });
    }
    return () => {
      cancelled = true;
    };
    // imageKey 是依赖项的稳定摘要（imageRels 每次 useMemo 都可能是新数组）
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [imageKey, resolveAsset, assets]);

  /* -------------------------------------------------- 滚轮缩放 */
  useEffect(() => {
    const element = svgRef.current;
    if (!element) return;
    const onWheel = (event: WheelEvent) => {
      // 原生监听器 + passive:false 才能 preventDefault（React 的 onWheel 是 passive）
      event.preventDefault();
      const factor = event.deltaY > 0 ? 0.9 : 1.1;
      setView((current) => {
        const scale = Math.min(MAX_SCALE, Math.max(MIN_SCALE, current.scale * factor));
        if (scale === current.scale) return current;
        // 以视口中心为锚点缩放，避免节点「跑出屏幕」
        const centerX = current.x + VIEW_WIDTH / current.scale / 2;
        const centerY = current.y + VIEW_HEIGHT / current.scale / 2;
        return {
          x: centerX - VIEW_WIDTH / scale / 2,
          y: centerY - VIEW_HEIGHT / scale / 2,
          scale,
        };
      });
    };
    element.addEventListener("wheel", onWheel, { passive: false });
    return () => element.removeEventListener("wheel", onWheel);
  }, []);

  /** 客户端像素 → 画布单位（jsdom 没有布局，退化成 1:1，测试仍能验证拖动会回调）。 */
  function unitsPerPixel(scale: number): number {
    const rect = svgRef.current?.getBoundingClientRect();
    const width = rect && rect.width > 0 ? rect.width : 0;
    const height = rect && rect.height > 0 ? rect.height : 0;
    if (width <= 0 && height <= 0) return 1;
    const perX = VIEW_WIDTH / scale / (width || VIEW_WIDTH);
    const perY = VIEW_HEIGHT / scale / (height || VIEW_HEIGHT);
    return Math.max(perX, perY);
  }

  /* -------------------------------------------------- 编辑提交 */
  function commitEditing() {
    const current = editing;
    if (!current) return;
    if (cancelEditingRef.current) {
      cancelEditingRef.current = false;
      setEditing(null);
      return;
    }
    setEditing(null);
    if (readOnly) return;
    const currentDoc = docRef.current;
    if (!currentDoc) return;
    const node = findNode(currentDoc, current.id);
    if (!node || node.type !== "text") return;
    if ((node.text ?? "") === current.draft) return;
    onChange(serializeCanvas(updateNode(currentDoc, current.id, { text: current.draft })));
  }

  /* -------------------------------------------------- 指针手势 */
  function handleSurfacePointerDown(event: React.PointerEvent<SVGRectElement>) {
    event.currentTarget.setPointerCapture?.(event.pointerId);
    dragRef.current = {
      kind: "pan",
      startClientX: event.clientX,
      startClientY: event.clientY,
      originViewX: view.x,
      originViewY: view.y,
      unitsPerPx: unitsPerPixel(view.scale),
    };
  }

  function handleNodePointerDown(event: React.PointerEvent<SVGGElement>, node: CanvasNode) {
    event.stopPropagation();
    setSelectedId(node.id);
    if (readOnly || !docRef.current) return;
    if (editing?.id === node.id) return;
    event.currentTarget.setPointerCapture?.(event.pointerId);
    dragRef.current = {
      kind: "node",
      id: node.id,
      startClientX: event.clientX,
      startClientY: event.clientY,
      originX: node.x,
      originY: node.y,
      unitsPerPx: unitsPerPixel(view.scale),
      baseDoc: docRef.current,
      moved: false,
    };
  }

  function handlePointerMove(event: React.PointerEvent<SVGSVGElement>) {
    const drag = dragRef.current;
    if (!drag) return;
    const dx = (event.clientX - drag.startClientX) * drag.unitsPerPx;
    const dy = (event.clientY - drag.startClientY) * drag.unitsPerPx;

    if (drag.kind === "pan") {
      setView((current) => ({
        ...current,
        x: drag.originViewX - dx,
        y: drag.originViewY - dy,
      }));
      return;
    }

    if (!drag.moved && Math.abs(dx) < 2 && Math.abs(dy) < 2) return; // 手抖容差
    drag.moved = true;
    // 始终基于「按下时的文档」重算，避免多次 pointermove 累积误差
    const next = moveNode(drag.baseDoc, drag.id, drag.originX + dx, drag.originY + dy);
    onChange(serializeCanvas(next));
  }

  function handlePointerUp() {
    const drag = dragRef.current;
    dragRef.current = null;
    if (!drag || drag.kind !== "node" || drag.moved) return;
    // 单击（未拖动）文件节点 = 打开该笔记；读只读模式也允许导航
    const node = findNode(drag.baseDoc, drag.id);
    if (node?.type === "file" && node.file && onOpenLink) onOpenLink(node.file);
  }

  /* -------------------------------------------------- 双击 / 键盘 */
  function handleNodeDoubleClick(event: React.MouseEvent<SVGGElement>, node: CanvasNode) {
    event.stopPropagation();
    setSelectedId(node.id);
    if (readOnly) return;
    if (node.type === "text") {
      setEditing({ id: node.id, draft: node.text ?? "" });
      return;
    }
    if (node.type === "file" && node.file && onOpenLink) {
      onOpenLink(node.file);
      return;
    }
    if (node.type === "link" && isHttpUrl(node.url)) {
      window.open(node.url, "_blank", "noopener,noreferrer");
    }
  }

  function handleNodeKeyDown(event: React.KeyboardEvent<SVGGElement>, node: CanvasNode) {
    if (event.key !== "Enter" && event.key !== " ") return;
    event.preventDefault();
    event.stopPropagation();
    setSelectedId(node.id);
    if (readOnly) return;
    if (node.type === "text") setEditing({ id: node.id, draft: node.text ?? "" });
    else if (node.type === "file" && node.file && onOpenLink) onOpenLink(node.file);
    else if (node.type === "link" && isHttpUrl(node.url)) {
      window.open(node.url, "_blank", "noopener,noreferrer");
    }
  }

  function handleKeyDown(event: React.KeyboardEvent<HTMLDivElement>) {
    if (editing || readOnly || !doc) return;
    if (event.key !== "Delete" && event.key !== "Backspace") return;
    if (!selectedId) return;
    event.preventDefault();
    const next = removeNode(doc, selectedId);
    if (next === doc) return;
    setSelectedId(null);
    onChange(serializeCanvas(next));
  }

  /* -------------------------------------------------- 工具栏动作 */
  function handleAddNode() {
    if (readOnly || !doc) return;
    const bounds = canvasBounds(doc);
    const id = createNodeId(doc);
    const next = addTextNode(doc, {
      id,
      x: snapToGrid(bounds.x + bounds.width + GRID_SIZE * 2),
      y: snapToGrid(bounds.y),
      text: "",
    });
    setSelectedId(id);
    onChange(serializeCanvas(next));
  }

  function handleDeleteSelected() {
    if (readOnly || !doc || !selectedId) return;
    const next = removeNode(doc, selectedId);
    if (next === doc) return;
    setSelectedId(null);
    onChange(serializeCanvas(next));
  }

  function handleResetView() {
    if (!doc) return;
    const bounds = canvasBounds(doc);
    setView({ x: bounds.x - 60, y: bounds.y - 60, scale: 1 });
  }

  function handleZoom(direction: 1 | -1) {
    setView((current) => {
      const factor = direction > 0 ? 1.2 : 1 / 1.2;
      const scale = Math.min(MAX_SCALE, Math.max(MIN_SCALE, current.scale * factor));
      return { ...current, scale };
    });
  }

  /* -------------------------------------------------- 坏 JSON：只读预览 */
  if (!parsed.ok) {
    return (
      <div className="flex h-full flex-col gap-2 overflow-hidden p-3" data-testid="canvas-pane">
        <div
          role="alert"
          className="rounded-sm border border-danger-line bg-danger-soft px-2 py-1 text-[12px] leading-5 text-danger"
        >
          {parsed.error}
        </div>
        <p className="text-[11px] text-muted">
          画布内容无法解析，已切换为原文只读预览；不会把这段内容写回文件。
        </p>
        <pre
          className="min-h-0 flex-1 overflow-auto rounded-sm border border-line-soft bg-subtle-2 p-2 font-mono text-[11px] leading-5 text-body"
          aria-label="画布原文只读预览"
        >
          {text}
        </pre>
      </div>
    );
  }

  const activeDoc = parsed.doc;

  return (
    <div
      className="relative h-full w-full overflow-hidden bg-subtle-2"
      data-testid="canvas-pane"
      data-readonly={readOnly ? "true" : "false"}
      tabIndex={-1}
      onKeyDown={handleKeyDown}
      aria-readonly={readOnly || undefined}
    >
      {/* 工具栏：写操作在只读时禁用，缩放平移始终可用 */}
      <div className="pointer-events-none absolute inset-x-0 top-0 z-10 flex items-start justify-between gap-2 p-2">
        <div className="pointer-events-auto flex items-center gap-1 rounded-sm border border-line bg-panel p-1">
          <button
            type="button"
            className={toolbarButton}
            onClick={handleAddNode}
            disabled={readOnly}
            title="在当前画布右侧新增一个文本节点"
          >
            新建文本节点
          </button>
          <button
            type="button"
            className={toolbarButton}
            onClick={handleDeleteSelected}
            disabled={readOnly || !selectedId}
            title="删除选中的节点（连带删除相连的边）"
          >
            删除选中
          </button>
        </div>
        <div className="pointer-events-auto flex items-center gap-1 rounded-sm border border-line bg-panel p-1">
          <span className="px-1 text-[11px] leading-4 text-muted">
            {Math.round(view.scale * 100)}%
          </span>
          <button type="button" className={toolbarButton} onClick={() => handleZoom(-1)} title="缩小">
            缩小
          </button>
          <button type="button" className={toolbarButton} onClick={() => handleZoom(1)} title="放大">
            放大
          </button>
          <button type="button" className={toolbarButton} onClick={handleResetView} title="复位视图">
            复位
          </button>
          {readOnly ? (
            <span className="rounded-sm border border-line px-2 py-1 text-[11px] leading-4 text-muted">
              只读
            </span>
          ) : null}
        </div>
      </div>

      <svg
        ref={svgRef}
        className="h-full w-full touch-none select-none"
        viewBox={`${view.x} ${view.y} ${viewWidth} ${viewHeight}`}
        role="group"
        aria-label="Obsidian 画布"
        onPointerMove={handlePointerMove}
        onPointerUp={handlePointerUp}
        onPointerLeave={handlePointerUp}
        onPointerCancel={handlePointerUp}
      >
        <defs>
          <marker
            id={markerId}
            viewBox="0 0 10 10"
            refX="9"
            refY="5"
            markerWidth="6"
            markerHeight="6"
            orient="auto-start-reverse"
          >
            <path d="M 0 0 L 10 5 L 0 10 z" fill="var(--muted)" />
          </marker>
        </defs>

        {/* 背景：拖拽平移的落点 */}
        <rect
          data-testid="canvas-surface"
          x={view.x}
          y={view.y}
          width={viewWidth}
          height={viewHeight}
          fill="transparent"
          onPointerDown={handleSurfacePointerDown}
        />

        {/* 连线画在节点下面 */}
        {activeDoc.edges.map((edge) => {
          const from = findNode(activeDoc, edge.fromNode);
          const to = findNode(activeDoc, edge.toNode);
          if (!from || !to) return null; // 悬空边（指向已删节点）不画，但保留在文档里
          const geometry = edgeGeometry(from, to, edge.fromSide, edge.toSide);
          const path = `M ${geometry.x1} ${geometry.y1} C ${geometry.cx1} ${geometry.cy1}, ${geometry.cx2} ${geometry.cy2}, ${geometry.x2} ${geometry.y2}`;
          const midX = (geometry.x1 + geometry.x2) / 2;
          const midY = (geometry.y1 + geometry.y2) / 2;
          return (
            <g key={edge.id} data-testid="canvas-edge" data-edge-id={edge.id} pointerEvents="none">
              <path
                d={path}
                fill="none"
                stroke={accentOf(edge.color) ?? "var(--muted)"}
                strokeWidth={1.5}
                markerEnd={`url(#${markerId})`}
              />
              {edge.label ? (
                <text
                  x={midX}
                  y={midY - 6}
                  textAnchor="middle"
                  fontSize={12}
                  fill="var(--body)"
                  stroke="var(--surface)"
                  strokeWidth={4}
                  paintOrder="stroke"
                >
                  {edge.label}
                </text>
              ) : null}
            </g>
          );
        })}

        {/* 节点 */}
        {activeDoc.nodes.map((node) => {
          const selected = node.id === selectedId;
          const accent = accentOf(node.color);
          const isEditing = editing?.id === node.id;
          const isGroup = node.type === "group";
          const imageUrl = node.type === "file" && node.file ? assets[node.file] : undefined;
          return (
            <g
              key={node.id}
              data-testid="canvas-node"
              data-node-id={node.id}
              data-node-type={node.type}
              data-selected={selected ? "true" : "false"}
              role="button"
              tabIndex={0}
              aria-label={nodeAriaLabel(node)}
              aria-pressed={selected}
              className="cursor-pointer"
              style={{ outline: "2px solid transparent" }}
              onPointerDown={(event) => handleNodePointerDown(event, node)}
              onDoubleClick={(event) => handleNodeDoubleClick(event, node)}
              onKeyDown={(event) => handleNodeKeyDown(event, node)}
              onFocus={() => setSelectedId(node.id)}
            >
              <rect
                x={0}
                y={0}
                width={node.width}
                height={node.height}
                rx={isGroup ? 10 : 6}
                fill={isGroup ? "transparent" : "var(--surface)"}
                stroke={selected ? "var(--heat-3)" : accent ?? "var(--line-strong)"}
                strokeWidth={selected ? 2 : 1}
                strokeDasharray={isGroup ? "6 4" : undefined}
              />

              {isGroup ? (
                <text x={10} y={20} fontSize={12} fill="var(--muted)">
                  {node.label ?? "分组"}
                </text>
              ) : null}

              {!isGroup && !isEditing ? (
                imageUrl ? (
                  <image
                    href={imageUrl}
                    x={0}
                    y={0}
                    width={node.width}
                    height={node.height}
                    preserveAspectRatio="xMidYMid meet"
                    pointerEvents="none"
                  />
                ) : (
                  <foreignObject x={0} y={0} width={node.width} height={node.height} pointerEvents="none">
                    <div
                      className="flex h-full w-full flex-col gap-1 overflow-hidden p-2"
                      style={{ pointerEvents: "none" }}
                    >
                      {node.type === "text" ? (
                        <span className="whitespace-pre-wrap break-words text-[12px] leading-5 text-ink">
                          {node.text?.trim() ? node.text : "双击编辑文本"}
                        </span>
                      ) : null}
                      {node.type === "file" ? (
                        <>
                          <span className="truncate text-[12px] leading-5 text-ink">
                            {fileNameOf(node.file)}
                          </span>
                          <span className="text-[10px] leading-4 text-muted">点击打开笔记</span>
                        </>
                      ) : null}
                      {node.type === "link" ? (
                        <>
                          <span className="break-all text-[11px] leading-4 text-ink">
                            {node.url ?? "（无地址）"}
                          </span>
                          <span className="text-[10px] leading-4 text-muted">
                            {isHttpUrl(node.url) ? "双击在浏览器打开" : "只支持 http(s) 链接"}
                          </span>
                        </>
                      ) : null}
                    </div>
                  </foreignObject>
                )
              ) : null}

              {isEditing ? (
                <foreignObject x={0} y={0} width={node.width} height={node.height}>
                  <div className="h-full w-full p-1">
                    <textarea
                      autoFocus
                      aria-label="编辑文本节点"
                      value={editing?.draft ?? ""}
                      onChange={(event) =>
                        setEditing((current) =>
                          current ? { id: current.id, draft: event.target.value } : current,
                        )
                      }
                      onBlur={commitEditing}
                      onKeyDown={(event) => {
                        if (event.key === "Escape") {
                          event.preventDefault();
                          event.stopPropagation();
                          cancelEditingRef.current = true;
                          setEditing(null);
                        } else if (event.key === "Enter" && (event.metaKey || event.ctrlKey)) {
                          event.preventDefault();
                          event.stopPropagation();
                          commitEditing();
                        }
                      }}
                      className="h-full w-full resize-none rounded-sm border border-line bg-surface p-1 font-sans text-[12px] leading-5 text-ink"
                      style={{ outline: "2px solid transparent" }}
                    />
                  </div>
                </foreignObject>
              ) : null}
            </g>
          );
        })}
      </svg>

      {activeDoc.nodes.length === 0 ? (
        <div className="pointer-events-none absolute inset-0 flex items-center justify-center">
          <p className="rounded-sm border border-dashed border-line px-3 py-2 text-[12px] text-muted">
            画布为空{readOnly ? "。" : "，点击「新建文本节点」开始。"}
          </p>
        </div>
      ) : null}

      <div className="pointer-events-none absolute bottom-2 left-2 rounded-sm border border-line bg-panel px-2 py-1 text-[11px] leading-4 text-muted">
        {readOnly
          ? "只读模式：可平移与缩放，不能修改画布"
          : "拖动空白处平移 · 滚轮缩放 · 双击文本编辑 · Delete 删除选中"}
      </div>
    </div>
  );
}
