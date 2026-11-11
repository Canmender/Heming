/**
 * 画布几何：**纯函数**，不碰 React、不碰 DOM。
 *
 * 为什么单独抽出来：画布是工作流模块里最容易「看起来差不多、实际上算错」的一块
 * （缩放锚点、端口位置、框选命中、适配视图）。纯函数可以用单测钉死，且 Canvas 组件
 * 只剩事件接线，改交互时不必靠肉眼回归。
 *
 * 坐标约定：
 * - 画布坐标（canvas）：节点 position 所在的空间，原点在左上；
 * - 屏幕坐标（screen）：相对画布容器的像素；
 * - `viewport = { x, y, zoom }` 表示「画布坐标 (0,0) 在屏幕上的位置 + 缩放」。
 */

export interface CanvasPoint {
  x: number;
  y: number;
}

export interface CanvasSize {
  width: number;
  height: number;
}

export interface CanvasRect {
  x: number;
  y: number;
  width: number;
  height: number;
}

export interface CanvasViewport {
  x: number;
  y: number;
  zoom: number;
}

/** 节点卡片宽度（与 Canvas 组件的 CSS 宽度一致）。 */
export const NODE_WIDTH = 224;
/** 节点卡片高度估算（画布只用于端口/命中，不参与真实布局）。 */
export const NODE_HEIGHT = 68;
export const MIN_ZOOM = 0.2;
export const MAX_ZOOM = 2;
export const ZOOM_STEP = 1.2;
/** 画布世界尺寸（够放下一张流程图；节点可以超过，只是滚动边界内不裁剪）。 */
export const WORLD_WIDTH = 4000;
export const WORLD_HEIGHT = 3000;

export function clampZoom(zoom: number): number {
  if (!Number.isFinite(zoom)) return 1;
  return Math.min(MAX_ZOOM, Math.max(MIN_ZOOM, zoom));
}

/** 屏幕坐标 → 画布坐标。 */
export function screenToCanvas(point: CanvasPoint, viewport: CanvasViewport): CanvasPoint {
  return {
    x: (point.x - viewport.x) / viewport.zoom,
    y: (point.y - viewport.y) / viewport.zoom,
  };
}

/** 画布坐标 → 屏幕坐标。 */
export function canvasToScreen(point: CanvasPoint, viewport: CanvasViewport): CanvasPoint {
  return {
    x: point.x * viewport.zoom + viewport.x,
    y: point.y * viewport.zoom + viewport.y,
  };
}

/** 以某个屏幕点为锚点缩放：锚点下的画布位置保持不动。 */
export function zoomAtPoint(
  viewport: CanvasViewport,
  anchor: CanvasPoint,
  nextZoom: number,
): CanvasViewport {
  const zoom = clampZoom(nextZoom);
  const canvasPoint = screenToCanvas(anchor, viewport);
  return {
    zoom,
    x: anchor.x - canvasPoint.x * zoom,
    y: anchor.y - canvasPoint.y * zoom,
  };
}

/** 节点矩形（画布坐标）。 */
export function nodeRect(position: CanvasPoint): CanvasRect {
  return { x: position.x, y: position.y, width: NODE_WIDTH, height: NODE_HEIGHT };
}

/** 第 index 个输入端口的画布坐标（沿左边竖向均分；只有一个时居中）。 */
export function inputPortPoint(position: CanvasPoint, inputIndex: number, inputCount: number): CanvasPoint {
  const count = Math.max(1, inputCount);
  return {
    x: position.x,
    y: position.y + (NODE_HEIGHT * (inputIndex + 1)) / (count + 1),
  };
}

/** 第 index 个输出端口的画布坐标（沿右边竖向均分）。 */
export function outputPortPoint(position: CanvasPoint, outputIndex: number, outputCount: number): CanvasPoint {
  const count = Math.max(1, outputCount);
  return {
    x: position.x + NODE_WIDTH,
    y: position.y + (NODE_HEIGHT * (outputIndex + 1)) / (count + 1),
  };
}

/** 连线贝塞尔路径：横向留出控制点，让线从右侧「甩」出去再进左侧。 */
export function edgePath(from: CanvasPoint, to: CanvasPoint): string {
  const dx = Math.max(40, Math.abs(to.x - from.x) * 0.5);
  return `M ${from.x} ${from.y} C ${from.x + dx} ${from.y}, ${to.x - dx} ${to.y}, ${to.x} ${to.y}`;
}

/** 两个角点 → 规范矩形（支持从右下往左上拉框）。 */
export function normalizeRect(a: CanvasPoint, b: CanvasPoint): CanvasRect {
  return {
    x: Math.min(a.x, b.x),
    y: Math.min(a.y, b.y),
    width: Math.abs(a.x - b.x),
    height: Math.abs(a.y - b.y),
  };
}

export function pointInRect(point: CanvasPoint, rect: CanvasRect): boolean {
  return (
    point.x >= rect.x &&
    point.x <= rect.x + rect.width &&
    point.y >= rect.y &&
    point.y <= rect.y + rect.height
  );
}

export function rectsIntersect(a: CanvasRect, b: CanvasRect): boolean {
  return (
    a.x < b.x + b.width &&
    a.x + a.width > b.x &&
    a.y < b.y + b.height &&
    a.y + a.height > b.y
  );
}

/** 框选命中的节点 id（与矩形相交即选中）。 */
export function nodesInRect(
  nodes: ReadonlyArray<{ id: string; position: CanvasPoint }>,
  rect: CanvasRect,
): string[] {
  return nodes.filter((node) => rectsIntersect(nodeRect(node.position), rect)).map((node) => node.id);
}

/** 点命中节点（用于拖线落点）；返回最上层（数组最后绘制的优先）。 */
export function nodeAtPoint(
  nodes: ReadonlyArray<{ id: string; position: CanvasPoint }>,
  point: CanvasPoint,
): string | null {
  for (let i = nodes.length - 1; i >= 0; i -= 1) {
    if (pointInRect(point, nodeRect(nodes[i].position))) return nodes[i].id;
  }
  return null;
}

/**
 * 适配视图：把所有节点放进视口中央（最多放大到 1 倍——放太大反而看不出结构）。
 * 没有节点时回到 100% 原点。
 */
export function fitView(
  nodes: ReadonlyArray<{ position: CanvasPoint }>,
  viewportSize: CanvasSize,
  padding = 64,
): CanvasViewport {
  if (nodes.length === 0) return { x: 0, y: 0, zoom: 1 };
  let minX = Infinity;
  let minY = Infinity;
  let maxX = -Infinity;
  let maxY = -Infinity;
  for (const node of nodes) {
    minX = Math.min(minX, node.position.x);
    minY = Math.min(minY, node.position.y);
    maxX = Math.max(maxX, node.position.x + NODE_WIDTH);
    maxY = Math.max(maxY, node.position.y + NODE_HEIGHT);
  }
  const width = Math.max(1, viewportSize.width - padding * 2);
  const height = Math.max(1, viewportSize.height - padding * 2);
  const zoom = clampZoom(Math.min(width / Math.max(1, maxX - minX), height / Math.max(1, maxY - minY), 1));
  return {
    zoom,
    x: (viewportSize.width - (maxX - minX) * zoom) / 2 - minX * zoom,
    y: (viewportSize.height - (maxY - minY) * zoom) / 2 - minY * zoom,
  };
}
