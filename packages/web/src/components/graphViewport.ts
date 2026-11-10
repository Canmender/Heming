/**
 * 图谱视口数学（纯函数）：缩放 / 以光标为锚点缩放 / 拖拽阈值 / 变换串。
 *
 * 为什么抽出来单独一层：图谱的手势逻辑最容易被"看起来能用"糊弄——
 * 以光标为中心缩放一旦算错，用户的感觉是"图在跑"而不是"我放大了这里"，
 * 回归测试又很难靠截图发现。把这些换算写成纯函数，单测直接断言
 * 「同一个图内点在缩放前后落回同一个屏幕位置」，比断言 DOM 可靠得多。
 *
 * 坐标口径（与 `WikiGraphView` 的 `<g transform>` 完全一致）：
 *   screen = 容器中心 + pan + zoom * (world - 容器中心)
 * 即先 `translate(-中心)`、再 `scale(zoom)`、最后 `translate(中心 + pan)`。
 */

/** 视口变换：缩放倍率 + 屏幕像素平移。 */
export interface GraphViewport {
  zoom: number;
  pan: { x: number; y: number };
}

/** 容器尺寸（css 像素）。 */
export interface ViewportSize {
  w: number;
  h: number;
}

/** 一个「屏幕上的点」，以容器左上角为原点（不是页面 client 坐标）。 */
export interface ViewportPoint {
  x: number;
  y: number;
}

/** 缩放下限：再小节点就不可点了。 */
export const MIN_ZOOM = 0.4;
/** 缩放上限：再大只能看到两三个节点，没有信息量。 */
export const MAX_ZOOM = 2.4;
/** 缩放按钮的步进（点在按钮上就是「放大一点」，没有锚点概念，以视口中心缩放）。 */
export const ZOOM_BUTTON_STEP = 0.2;
/** 滚轮 → 指数缩放的系数（deltaY 正数向下滚，缩小）。 */
export const WHEEL_ZOOM_RATE = 0.0015;
/** 单次滚轮事件最多缩放几倍：触控板/高精度滚轮可能一次给几百 delta，不夹住会「一滚到底」。 */
export const MAX_WHEEL_FACTOR = 2;
/** 拖拽判定阈值（px）：小于它算点击，不算拖拽，避免"手抖一下把节点拖跑"。 */
export const DRAG_THRESHOLD = 4;

/** 把缩放夹在 [MIN_ZOOM, MAX_ZOOM]，并统一保留 3 位小数（避免浮点噪声污染断言与百分比）。 */
export function clampZoom(value: number): number {
  if (!Number.isFinite(value)) return 1;
  const clamped = Math.min(MAX_ZOOM, Math.max(MIN_ZOOM, value));
  return Math.round(clamped * 1000) / 1000;
}

/** 复位视口（「重置视图」与双击复位共用）。 */
export function resetViewport(): GraphViewport {
  return { zoom: 1, pan: { x: 0, y: 0 } };
}

/** 当前缩放百分比（界面显示用）。 */
export function zoomPercent(zoom: number): number {
  return Math.round(zoom * 100);
}

/** 拖拽位移是否已超过阈值（超过才算「拖动」，否则仍按点击处理）。 */
export function isDragBeyondThreshold(dx: number, dy: number, threshold = DRAG_THRESHOLD): boolean {
  return Math.hypot(dx, dy) > threshold;
}

/**
 * 生成 `<g transform>` 串。
 * 顺序固定为「平移到中心 → pan 偏移 → 缩放 → 反向平移」，与坐标口径一一对应。
 */
export function viewportTransform(viewport: GraphViewport, size: ViewportSize): string {
  const cx = size.w / 2 + viewport.pan.x;
  const cy = size.h / 2 + viewport.pan.y;
  return `translate(${cx} ${cy}) scale(${viewport.zoom}) translate(${-size.w / 2} ${-size.h / 2})`;
}

/**
 * 屏幕上的一点 → 图内坐标（未缩放前的世界坐标）。
 * 用于锚点缩放与（未来的）坐标拾取；保持与 `viewportTransform` 严格互逆。
 */
export function screenToWorld(
  point: ViewportPoint,
  viewport: GraphViewport,
  size: ViewportSize,
): ViewportPoint {
  const cx = size.w / 2;
  const cy = size.h / 2;
  return {
    x: cx + (point.x - cx - viewport.pan.x) / viewport.zoom,
    y: cy + (point.y - cy - viewport.pan.y) / viewport.zoom,
  };
}

/**
 * 以屏幕上 `anchor` 为锚点缩放到 `nextZoom`：**锚点下方的图内内容保持不动**。
 *
 * 推导：令 world 为锚点下的图内点，缩放前 screen = c + pan + z(w - c)，
 * 缩放后要求 screen 不变、只改 z' 与 pan'，解得
 *   pan' = (p - c) - (z'/z) * ((p - c) - pan)
 * 也就是「锚点相对中心的偏移按比例缩放，再减掉原本的平移」。
 *
 * 夹到边界时返回原对象（不产生无意义的 pan 漂移：到达 MAX 后继续滚不该让图乱跑）。
 */
export function zoomAtAnchor(
  viewport: GraphViewport,
  nextZoom: number,
  anchor: ViewportPoint,
  size: ViewportSize,
): GraphViewport {
  const zoom = clampZoom(nextZoom);
  if (zoom === viewport.zoom) return viewport;
  const ratio = zoom / viewport.zoom;
  const cx = size.w / 2;
  const cy = size.h / 2;
  const offsetX = anchor.x - cx;
  const offsetY = anchor.y - cy;
  return {
    zoom,
    pan: {
      x: offsetX - ratio * (offsetX - viewport.pan.x),
      y: offsetY - ratio * (offsetY - viewport.pan.y),
    },
  };
}

/** 滚动事件的极简形状（单测不必构造真的 WheelEvent）。 */
export interface WheelLike {
  deltaY: number;
  /** 0 = 像素、1 = 行、2 = 页（与 DOM WheelEvent.deltaMode 一致）。 */
  deltaMode?: number;
}

/**
 * 把一次滚轮换算成「指数缩放倍率」。
 *
 * 用指数而不是加法：触控板会一次发很多小 delta，指数叠加才跟手；
 * 加法在慢滚时几乎不动、快滚时一步跳到底，手感是两个极端。
 */
export function wheelZoomFactor(deltaY: number, deltaMode = 0, viewportHeight = 800): number {
  const unit = deltaMode === 1 ? 16 : deltaMode === 2 ? Math.max(1, viewportHeight) : 1;
  const dy = deltaY * unit;
  if (!Number.isFinite(dy) || dy === 0) return 1;
  const factor = Math.exp(-dy * WHEEL_ZOOM_RATE);
  return Math.min(MAX_WHEEL_FACTOR, Math.max(1 / MAX_WHEEL_FACTOR, factor));
}

/**
 * 滚轮 → 下一个视口（连续、以光标为锚点）。
 *
 * @param anchor 光标在容器内的坐标（调用方减掉 getBoundingClientRect 的偏移）
 */
export function wheelViewport(
  viewport: GraphViewport,
  event: WheelLike,
  anchor: ViewportPoint,
  size: ViewportSize,
): GraphViewport {
  const factor = wheelZoomFactor(event.deltaY, event.deltaMode, size.h);
  if (factor === 1) return viewport;
  return zoomAtAnchor(viewport, viewport.zoom * factor, anchor, size);
}

/** 缩放按钮：以视口中心为锚点（中心缩放不改变 pan，等价于直接改 zoom）。 */
export function stepZoom(
  viewport: GraphViewport,
  delta: number,
  size: ViewportSize,
): GraphViewport {
  return zoomAtAnchor(viewport, viewport.zoom + delta, { x: size.w / 2, y: size.h / 2 }, size);
}
