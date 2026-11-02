/**
 * 桌宠的指针交互判定（纯函数，便于单测）。
 *
 * 这里有两条容易写错的规则，都在本文件里钉死：
 *
 * 1. **点击 vs 拖拽**：鼠标按下再抬起，位移小于阈值应判为"点击"（呼出对话），
 *    超过阈值才是"拖拽"（移动窗口）。没有阈值的话，手抖 1px 就会让"点一下"变成"拖一下"，
 *    表现是角色永远点不出对话框。
 *
 * 2. **可交互区**：窗口是 300×420 的透明矩形，但角色只占其中一块不规则区域。
 *    若整窗都算可交互，桌宠会在角色周围的空白处挡住桌面点击——那正是"桌宠很烦"的来源。
 *    所以命中区取角色的实际包围盒（由渲染层按模型 bounds 算出），空白处一律穿透。
 */

export interface Rect {
  x: number;
  y: number;
  width: number;
  height: number;
}

/** 位移阈值（CSS 像素）：小于它算点击，大于等于它算拖拽。 */
export const DRAG_THRESHOLD_PX = 4;

/** 点是否落在矩形内（含边界）。rect 为空视为不命中。 */
export function containsPoint(rect: Rect | null | undefined, x: number, y: number): boolean {
  if (!rect) return false;
  if (!Number.isFinite(x) || !Number.isFinite(y)) return false;
  const { x: rx, y: ry, width, height } = rect;
  if (![rx, ry, width, height].every(Number.isFinite)) return false;
  if (width <= 0 || height <= 0) return false;
  return x >= rx && x <= rx + width && y >= ry && y <= ry + height;
}

/** 点是否落在任一矩形内。用于"角色 ∪ 气泡 ∪ 输入框"。 */
export function isInteractiveAt(rects: Array<Rect | null | undefined>, x: number, y: number): boolean {
  return rects.some((r) => containsPoint(r, x, y));
}

/** 抬起时的最终判定：位移达到阈值才算拖拽。 */
export function classifyPointerUp(startX: number, startY: number, x: number, y: number): "tap" | "drag" {
  if (![startX, startY, x, y].every(Number.isFinite)) return "tap";
  const dx = x - startX;
  const dy = y - startY;
  return Math.hypot(dx, dy) >= DRAG_THRESHOLD_PX ? "drag" : "tap";
}

/**
 * 把模型包围盒换算成窗口内的 CSS 像素矩形。
 *
 * pixi 的 bounds 是舞台坐标，舞台铺满窗口且不缩放，所以只需把负坐标（模型可能超出
 * 画布左侧）夹到窗口内——命中区不该延伸到窗口之外。
 */
export function modelBoundsToHitBox(
  bounds: { x: number; y: number; width: number; height: number } | null,
  viewport: { width: number; height: number },
): Rect | null {
  if (!bounds) return null;
  const { x, y, width, height } = bounds;
  if (![x, y, width, height].every(Number.isFinite)) return null;
  if (width <= 0 || height <= 0) return null;

  const left = Math.max(0, x);
  const top = Math.max(0, y);
  const right = Math.min(viewport.width, x + width);
  const bottom = Math.min(viewport.height, y + height);
  if (right <= left || bottom <= top) return null;
  return { x: left, y: top, width: right - left, height: bottom - top };
}

/**
 * 「现在该不该上报可交互」的去重判断。
 * mousemove 每秒几十次，值不变就不该发 IPC——否则主进程会被无意义的调用塞满。
 */
export function shouldReportChange(previous: boolean, next: boolean): boolean {
  return previous !== next;
}
