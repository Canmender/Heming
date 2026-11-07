/**
 * 工作流画布：节点、连线、缩放/平移、框选、拖动与拖线连接。
 *
 * 为什么自己画而不是引画布库：工作流的节点模型很窄（固定宽度卡片、单/多端口、
 * 正交连线），引 React Flow 之类要背一套主题、受控模型与 jsdom 兼容成本；
 * 这里用 div + SVG，几何计算全在 `lib/workflow/canvas/geometry.ts` 里单测。
 *
 * 组件只吃 props、只发回调：**不持久化、不改 workflow**。所有改动（移动/连线/删除）
 * 都交给 WorkflowEditor 落到本地草稿与撤销栈上。
 */

import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import {
  NODE_HEIGHT,
  NODE_WIDTH,
  WORLD_HEIGHT,
  WORLD_WIDTH,
  canvasToScreen,
  edgePath,
  fitView,
  inputPortPoint,
  nodeRect,
  nodesInRect,
  normalizeRect,
  outputPortPoint,
  screenToCanvas,
  zoomAtPoint,
  type CanvasPoint,
  type CanvasViewport,
} from "../../../lib/workflow/canvas/geometry.js";
import { inputCountOf, outputCountOf } from "../../../lib/workflow/model.js";
import { getNodeType } from "../../../lib/workflow/registry.js";
import type { Workflow, WorkflowNode } from "../../../lib/workflow/types.js";
import { NodeIcon } from "../nodeIcons.js";

export type NodeRunVisual = "idle" | "running" | "success" | "error";

export interface WorkflowCanvasProps {
  workflow: Workflow;
  selectedIds: string[];
  nodeRunState: Record<string, { state: NodeRunVisual; itemCount?: number }>;
  readOnly?: boolean;
  onSelectionChange(ids: string[]): void;
  onMoveNodes(moves: Array<{ id: string; position: CanvasPoint }>): void;
  onConnect(input: { sourceId: string; sourceOutput: number; targetId: string; targetInput: number }): void;
  onRequestDelete(ids: string[]): void;
  onOpenNode(id: string): void;
  onRequestAddNode(position: CanvasPoint): void;
  onCanvasDoubleClick?(position: CanvasPoint): void;
}

type Interaction =
  | { mode: "idle" }
  | { mode: "pan"; startScreen: CanvasPoint; startViewport: CanvasViewport }
  | { mode: "select"; startCanvas: CanvasPoint; additive: boolean }
  | { mode: "drag"; startCanvas: CanvasPoint; origins: Record<string, CanvasPoint> }
  | { mode: "link"; sourceId: string; outputIndex: number; from: CanvasPoint; cursor: CanvasPoint };

const FALLBACK_SIZE = { width: 900, height: 620 };

function pointerPoint(event: { clientX: number; clientY: number }, rect: DOMRect): CanvasPoint {
  return { x: event.clientX - rect.left, y: event.clientY - rect.top };
}

export function WorkflowCanvas(props: WorkflowCanvasProps) {
  const {
    workflow,
    selectedIds,
    nodeRunState,
    readOnly = false,
    onSelectionChange,
    onMoveNodes,
    onConnect,
    onRequestDelete,
    onOpenNode,
    onRequestAddNode,
    onCanvasDoubleClick,
  } = props;

  const containerRef = useRef<HTMLDivElement | null>(null);
  const [size, setSize] = useState(FALLBACK_SIZE);
  const [viewport, setViewport] = useState<CanvasViewport>({ x: 0, y: 0, zoom: 1 });
  const [interaction, setInteraction] = useState<Interaction>({ mode: "idle" });
  const [draftPositions, setDraftPositions] = useState<Record<string, CanvasPoint>>({});
  const [selectionRect, setSelectionRect] = useState<
    { x: number; y: number; width: number; height: number } | null
  >(null);
  const spaceHeld = useRef(false);
  const viewportRef = useRef(viewport);
  viewportRef.current = viewport;

  // 容器尺寸：ResizeObserver 缺失（jsdom）时用兜底尺寸，保证几何计算不出现 NaN
  useEffect(() => {
    const element = containerRef.current;
    if (!element) return;
    const read = () => {
      const rect = element.getBoundingClientRect();
      if (rect.width > 0 && rect.height > 0) setSize({ width: rect.width, height: rect.height });
    };
    read();
    if (typeof ResizeObserver === "undefined") return;
    const observer = new ResizeObserver(read);
    observer.observe(element);
    return () => observer.disconnect();
  }, []);

  // 首次挂载：有节点就适配视图到中央
  const didFit = useRef(false);
  useEffect(() => {
    if (didFit.current) return;
    didFit.current = true;
    if (workflow.nodes.length > 0) setViewport(fitView(workflow.nodes, size));
  }, [workflow.nodes, size]);

  // 空格按下时进入「平移」态（与 n8n 一致）；松开退出
  useEffect(() => {
    const onKeyDown = (event: KeyboardEvent) => {
      if (event.code === "Space") spaceHeld.current = true;
    };
    const onKeyUp = (event: KeyboardEvent) => {
      if (event.code === "Space") spaceHeld.current = false;
    };
    window.addEventListener("keydown", onKeyDown);
    window.addEventListener("keyup", onKeyUp);
    return () => {
      window.removeEventListener("keydown", onKeyDown);
      window.removeEventListener("keyup", onKeyUp);
    };
  }, []);

  // 滚轮缩放：必须 non-passive 才能 preventDefault（避免页面跟着滚）
  useEffect(() => {
    const element = containerRef.current;
    if (!element) return;
    const onWheel = (event: WheelEvent) => {
      event.preventDefault();
      const rect = element.getBoundingClientRect();
      const point = pointerPoint(event, rect);
      setViewport((current) =>
        zoomAtPoint(current, point, current.zoom * (event.deltaY < 0 ? 1.1 : 0.9)),
      );
    };
    element.addEventListener("wheel", onWheel, { passive: false });
    return () => element.removeEventListener("wheel", onWheel);
  }, []);

  const frameNodes = useMemo(
    () =>
      workflow.nodes.map((node) => ({
        node,
        position: draftPositions[node.id] ?? node.position,
      })),
    [workflow.nodes, draftPositions],
  );

  const edges = useMemo(() => {
    const result: Array<{ id: string; path: string; error: boolean }> = [];
    for (const source of frameNodes) {
      const ports = workflow.connections[source.node.id]?.main ?? [];
      const outputCount = outputCountOf(source.node);
      ports.forEach((list, outputIndex) => {
        for (const target of list) {
          const targetFrame = frameNodes.find((entry) => entry.node.id === target.node);
          if (!targetFrame) continue;
          const from = outputPortPoint(source.position, outputIndex, outputCount);
          const to = inputPortPoint(targetFrame.position, target.index, inputCountOf(targetFrame.node));
          result.push({
            id: `${source.node.id}:${outputIndex}->${target.node}:${target.index}`,
            path: edgePath(from, to),
            error: nodeRunState[source.node.id]?.state === "error",
          });
        }
      });
    }
    return result;
  }, [frameNodes, workflow.connections, nodeRunState]);

  const rect = useCallback(
    () => containerRef.current?.getBoundingClientRect() ?? new DOMRect(0, 0, size.width, size.height),
    [size.height, size.width],
  );

  const handlePointerDown = (event: React.PointerEvent<HTMLDivElement>) => {
    if (event.button === 1 || spaceHeld.current) {
      event.preventDefault();
      containerRef.current?.setPointerCapture?.(event.pointerId);
      setInteraction({
        mode: "pan",
        startScreen: pointerPoint(event, rect()),
        startViewport: viewportRef.current,
      });
      return;
    }
    if (event.button !== 0) return;
    const point = pointerPoint(event, rect());
    const canvasPoint = screenToCanvas(point, viewportRef.current);
    containerRef.current?.setPointerCapture?.(event.pointerId);
    setInteraction({ mode: "select", startCanvas: canvasPoint, additive: event.shiftKey });
    setSelectionRect({ x: canvasPoint.x, y: canvasPoint.y, width: 0, height: 0 });
    if (!event.shiftKey) onSelectionChange([]);
  };

  const handlePointerMove = (event: React.PointerEvent<HTMLDivElement>) => {
    if (interaction.mode === "idle") return;
    const point = pointerPoint(event, rect());
    const canvasPoint = screenToCanvas(point, viewportRef.current);
    if (interaction.mode === "pan") {
      setViewport({
        ...interaction.startViewport,
        x: interaction.startViewport.x + (point.x - interaction.startScreen.x),
        y: interaction.startViewport.y + (point.y - interaction.startScreen.y),
      });
      return;
    }
    if (interaction.mode === "select") {
      setSelectionRect(normalizeRect(interaction.startCanvas, canvasPoint));
      return;
    }
    if (interaction.mode === "drag") {
      const dx = canvasPoint.x - interaction.startCanvas.x;
      const dy = canvasPoint.y - interaction.startCanvas.y;
      const next: Record<string, CanvasPoint> = {};
      for (const [id, origin] of Object.entries(interaction.origins)) {
        next[id] = { x: Math.round(origin.x + dx), y: Math.round(origin.y + dy) };
      }
      setDraftPositions(next);
      return;
    }
    if (interaction.mode === "link") {
      setInteraction({ ...interaction, cursor: canvasPoint });
    }
  };

  const finishInteraction = () => {
    if (interaction.mode === "select") {
      setSelectionRect(null);
      if (selectionRect) {
        const hits = nodesInRect(
          frameNodes.map((entry) => ({ id: entry.node.id, position: entry.position })),
          selectionRect,
        );
        const next = interaction.additive ? [...new Set([...selectedIds, ...hits])] : hits;
        if (next.length > 0 || !interaction.additive) onSelectionChange(next);
      }
      setInteraction({ mode: "idle" });
      return;
    }
    if (interaction.mode === "drag") {
      const moves = Object.entries(draftPositions).map(([id, position]) => ({ id, position }));
      setDraftPositions({});
      if (moves.length > 0) onMoveNodes(moves);
      setInteraction({ mode: "idle" });
      return;
    }
    if (interaction.mode === "link") {
      const targetId = findNodeAt(interaction.cursor, frameNodes);
      if (targetId && targetId !== interaction.sourceId) {
        const target = frameNodes.find((entry) => entry.node.id === targetId)!.node;
        onConnect({
          sourceId: interaction.sourceId,
          sourceOutput: interaction.outputIndex,
          targetId,
          targetInput: nearestInputIndex(target, interaction.cursor),
        });
      }
      setInteraction({ mode: "idle" });
      return;
    }
    setInteraction({ mode: "idle" });
  };

  const findNodeAt = (point: CanvasPoint, frames: Array<{ node: WorkflowNode; position: CanvasPoint }>) => {
    for (let i = frames.length - 1; i >= 0; i -= 1) {
      const rectOfNode = nodeRect(frames[i].position);
      if (
        point.x >= rectOfNode.x &&
        point.x <= rectOfNode.x + rectOfNode.width &&
        point.y >= rectOfNode.y &&
        point.y <= rectOfNode.y + rectOfNode.height
      ) {
        return frames[i].node.id;
      }
    }
    return null;
  };

  const nearestInputIndex = (node: WorkflowNode, point: CanvasPoint): number => {
    const inputs = Math.max(1, inputCountOf(node));
    let best = 0;
    let bestDistance = Infinity;
    for (let index = 0; index < inputs; index += 1) {
      const port = inputPortPoint(node.position, index, inputs);
      const distance = Math.abs(port.y - point.y);
      if (distance < bestDistance) {
        bestDistance = distance;
        best = index;
      }
    }
    return best;
  };

  const onNodePointerDown = (event: React.PointerEvent<HTMLDivElement>, node: WorkflowNode) => {
    if (readOnly || event.button !== 0) return;
    event.stopPropagation();
    const isSelected = selectedIds.includes(node.id);
    if (!isSelected) onSelectionChange([node.id]);
    const point = screenToCanvas(pointerPoint(event, rect()), viewportRef.current);
    const ids = isSelected ? selectedIds : [node.id];
    const origins: Record<string, CanvasPoint> = {};
    for (const id of ids) {
      const target = frameNodes.find((entry) => entry.node.id === id);
      if (target) origins[id] = { ...target.position };
    }
    containerRef.current?.setPointerCapture?.(event.pointerId);
    setInteraction({ mode: "drag", startCanvas: point, origins });
  };

  const onOutputPointerDown = (
    event: React.PointerEvent<HTMLElement>,
    node: WorkflowNode,
    outputIndex: number,
  ) => {
    if (readOnly) return;
    event.stopPropagation();
    const point = screenToCanvas(pointerPoint(event, rect()), viewportRef.current);
    setInteraction({
      mode: "link",
      sourceId: node.id,
      outputIndex,
      from: outputPortPoint(node.position, outputIndex, outputCountOf(node)),
      cursor: point,
    });
  };

  const handleKeyDown = (event: React.KeyboardEvent<HTMLDivElement>) => {
    if (event.key === "Delete" || event.key === "Backspace") {
      if (selectedIds.length > 0 && !readOnly) {
        event.preventDefault();
        onRequestDelete(selectedIds);
      }
      return;
    }
    if (event.key === "Escape") {
      onSelectionChange([]);
      return;
    }
    if ((event.key === "a" || event.key === "A") && (event.ctrlKey || event.metaKey)) {
      event.preventDefault();
      onSelectionChange(workflow.nodes.map((node) => node.id));
    }
  };

  const zoomBy = (factor: number) => {
    setViewport((current) =>
      zoomAtPoint(current, { x: size.width / 2, y: size.height / 2 }, current.zoom * factor),
    );
  };

  const zoomPercent = Math.round(viewport.zoom * 100);

  return (
    <div
      ref={containerRef}
      role="application"
      aria-label="工作流画布"
      tabIndex={0}
      className="relative h-full w-full overflow-hidden bg-[#fbfbfa]"
      style={{
        backgroundImage: "radial-gradient(circle, #dcdcd8 1px, transparent 1px)",
        backgroundSize: `${20 * viewport.zoom}px ${20 * viewport.zoom}px`,
        backgroundPosition: `${viewport.x}px ${viewport.y}px`,
      }}
      onPointerDown={handlePointerDown}
      onPointerMove={handlePointerMove}
      onPointerUp={finishInteraction}
      onPointerCancel={finishInteraction}
      onKeyDown={handleKeyDown}
      onDoubleClick={(event) => {
        if (event.target !== event.currentTarget) return;
        const point = screenToCanvas(pointerPoint(event, rect()), viewportRef.current);
        onRequestAddNode(point);
        onCanvasDoubleClick?.(point);
      }}
    >
      <div
        className="absolute left-0 top-0"
        style={{
          width: WORLD_WIDTH,
          height: WORLD_HEIGHT,
          transform: `translate(${viewport.x}px, ${viewport.y}px) scale(${viewport.zoom})`,
          transformOrigin: "0 0",
        }}
      >
        <svg
          width={WORLD_WIDTH}
          height={WORLD_HEIGHT}
          className="pointer-events-none absolute left-0 top-0 overflow-visible"
          aria-hidden="true"
        >
          <defs>
            <marker id="wf-arrow" viewBox="0 0 8 8" refX="7" refY="4" markerWidth="7" markerHeight="7" orient="auto">
              <path d="M0 0 L8 4 L0 8 z" fill="#9a9a94" />
            </marker>
          </defs>
          {edges.map((edge) => (
            <path
              key={edge.id}
              d={edge.path}
              fill="none"
              stroke={edge.error ? "#c0392b" : "#9a9a94"}
              strokeWidth={1.5}
              markerEnd="url(#wf-arrow)"
            />
          ))}
          {interaction.mode === "link" ? (
            <path
              d={edgePath(interaction.from, interaction.cursor)}
              fill="none"
              stroke="#1a1a1a"
              strokeWidth={1.8}
              strokeDasharray="6 4"
            />
          ) : null}
        </svg>

        {selectionRect ? (
          <div
            data-testid="canvas-selection"
            className="absolute border border-ink/60 bg-ink/5"
            style={{
              left: selectionRect.x,
              top: selectionRect.y,
              width: selectionRect.width,
              height: selectionRect.height,
            }}
          />
        ) : null}

        {frameNodes.map(({ node, position }) => {
          const nodeType = getNodeType(node.type);
          const run = nodeRunState[node.id];
          const selected = selectedIds.includes(node.id);
          const inputCount = Math.max(1, inputCountOf(node));
          const outputCount = Math.max(1, outputCountOf(node));
          const borderClass =
            run?.state === "error"
              ? "border-danger"
              : run?.state === "success"
                ? "border-success"
                : run?.state === "running"
                  ? "border-ink"
                  : "border-line";
          return (
            <div
              key={node.id}
              data-node-id={node.id}
              role="button"
              tabIndex={0}
              aria-label={`节点 ${node.name}${node.disabled ? "（已禁用）" : ""}`}
              aria-pressed={selected}
              className={`absolute flex flex-col overflow-visible rounded-xl border bg-white text-left shadow-card transition-shadow ${
                selected ? "ring-2 ring-ink" : ""
              } ${borderClass} ${node.disabled ? "opacity-50" : ""} ${
                readOnly ? "cursor-default" : "cursor-grab"
              } ${run?.state === "running" ? "animate-pulse" : ""}`}
              style={{ left: position.x, top: position.y, width: NODE_WIDTH, height: NODE_HEIGHT }}
              onPointerDown={(event) => onNodePointerDown(event, node)}
              onDoubleClick={(event) => {
                event.stopPropagation();
                onOpenNode(node.id);
              }}
              onKeyDown={(event) => {
                if (event.key === "Enter" || event.key === " ") {
                  event.preventDefault();
                  onOpenNode(node.id);
                }
              }}
            >
              <div className="flex min-w-0 items-center gap-2 px-3 pt-2">
                <span className="flex h-7 w-7 shrink-0 items-center justify-center rounded-md border border-line-soft bg-subtle text-ink">
                  <NodeIcon icon={nodeType?.description.icon} width={15} height={15} />
                </span>
                <span className="min-w-0 flex-1">
                  <span className="block truncate text-[13px] font-medium leading-5 text-ink">{node.name}</span>
                  <span className="block truncate ui-micro">
                    {nodeType?.description.displayName ?? node.type}
                  </span>
                </span>
                {node.pinData ? (
                  <span
                    title="已固定数据"
                    className="shrink-0 rounded border border-line-soft px-1 text-[10px] text-muted"
                  >
                    固定
                  </span>
                ) : null}
                {run?.itemCount !== undefined ? (
                  <span className="shrink-0 rounded bg-subtle-2 px-1.5 py-0.5 text-[10px] ui-numeric text-muted">
                    {run.itemCount}
                  </span>
                ) : null}
              </div>
              <div className="mt-auto flex items-center justify-between px-3 pb-2">
                <span className="truncate ui-micro">
                  {node.disabled ? "已禁用 · 数据透传" : (node.notes ?? "")}
                </span>
                {run?.state === "running" ? <span className="ui-micro text-ink">运行中</span> : null}
              </div>

              {Array.from({ length: inputCount }).map((_, index) => {
                const port = inputPortPoint({ x: 0, y: 0 }, index, inputCount);
                return (
                  <span
                    key={`in-${index}`}
                    data-port={`${node.id}:in:${index}`}
                    className="absolute h-2.5 w-2.5 -translate-x-1/2 -translate-y-1/2 rounded-full border border-line-strong bg-white"
                    style={{ left: port.x, top: port.y }}
                  />
                );
              })}
              {Array.from({ length: outputCount }).map((_, index) => {
                const port = outputPortPoint({ x: 0, y: 0 }, index, outputCount);
                return (
                  <span
                    key={`out-${index}`}
                    data-port={`${node.id}:out:${index}`}
                    role="button"
                    aria-label={`从 ${node.name} 输出 ${index + 1} 拖出连线`}
                    title="拖出连线"
                    className="absolute h-3 w-3 -translate-y-1/2 translate-x-[-50%] cursor-crosshair rounded-full border border-line-strong bg-white hover:border-ink"
                    style={{ left: port.x, top: port.y }}
                    onPointerDown={(event) => onOutputPointerDown(event, node, index)}
                  />
                );
              })}
            </div>
          );
        })}
      </div>

      <div className="absolute right-3 top-3 z-10 flex items-center gap-1 rounded-lg border border-line bg-white/95 p-1 shadow-card">
        <button type="button" className="ui-btn ui-btn-sm ui-btn-ghost" aria-label="缩小" onClick={() => zoomBy(1 / 1.2)}>
          −
        </button>
        <span className="w-12 text-center text-[11px] ui-numeric text-muted" aria-live="polite">
          {zoomPercent}%
        </span>
        <button type="button" className="ui-btn ui-btn-sm ui-btn-ghost" aria-label="放大" onClick={() => zoomBy(1.2)}>
          +
        </button>
        <button
          type="button"
          className="ui-btn ui-btn-sm ui-btn-ghost"
          aria-label="适配视图"
          onClick={() => setViewport(fitView(workflow.nodes, size))}
        >
          适配
        </button>
        <button
          type="button"
          className="ui-btn ui-btn-sm ui-btn-ghost"
          aria-label="重置缩放"
          onClick={() => setViewport({ x: 0, y: 0, zoom: 1 })}
        >
          100%
        </button>
      </div>

      {workflow.nodes.length === 0 ? (
        <div className="pointer-events-none absolute inset-0 flex flex-col items-center justify-center gap-2">
          <p className="ui-body-sm text-muted">画布是空的</p>
          <p className="ui-micro">双击空白处添加第一个节点，或从模板创建一条工作流。</p>
        </div>
      ) : null}
    </div>
  );
}

export { canvasToScreen };
