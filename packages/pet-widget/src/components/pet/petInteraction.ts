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

/** 点是否落在任一矩形内。用于"角色 ∪ 气泡 ∪ 输入框 ∪ 菜单 ∪ 错误条"。 */
export function isInteractiveAt(rects: Array<Rect | null | undefined>, x: number, y: number): boolean {
  return rects.some((r) => containsPoint(r, x, y));
}

/**
 * 这一刻窗口该不该接收鼠标（用于上报 `pet:set-interactive`）。
 *
 * 两条规则，顺序不能反：
 *
 * 1. **浮层打开时整窗拦截**。菜单/输入框是窗口内的浮动 UI，它们打开时鼠标可能不在
 *    任何矩形上（比如菜单刚弹出、指针还在两帧之间），或者从菜单移到桌面时先收到
 *    `mouseleave`。若这时按坐标判成"不拦截"，穿透态会把菜单一起点穿——
 *    用户看到的就是「右键菜单点了没反应」。所以只要浮层开着就返回 true。
 *
 * 2. 否则按坐标判：命中区 = 角色包围盒 ∪ 气泡 ∪ 输入框 ∪ 菜单 ∪ 错误条。
 *    空白处一律穿透（桌宠不该挡住桌面点击）。
 *
 * ★ 菜单/错误条以前漏在命中区外（旧 `extraRects` 只有 bubble 与 input），
 *   是「菜单点了没反应」的第一根因：默认穿透时菜单区域不挡鼠标，点击落到桌面。
 */
export function resolveInteractive(
  hitBox: Rect | null | undefined,
  uiRects: Array<Rect | null | undefined>,
  x: number,
  y: number,
  floatingOpen: boolean,
): boolean {
  if (floatingOpen) return true;
  return isInteractiveAt([hitBox, ...uiRects], x, y);
}

/** 抬起时的最终判定：位移达到阈值才算拖拽。 */
export function classifyPointerUp(startX: number, startY: number, x: number, y: number): "tap" | "drag" {
  return exceedsDragThreshold(startX, startY, x, y) ? "drag" : "tap";
}

/** 位移是否已经越过「点击 vs 拖拽」的阈值（拖拽起点判定与抬起判定共用同一口径）。 */
export function exceedsDragThreshold(
  startX: number,
  startY: number,
  x: number,
  y: number,
): boolean {
  if (![startX, startY, x, y].every(Number.isFinite)) return false;
  const dx = x - startX;
  const dy = y - startY;
  return Math.hypot(dx, dy) >= DRAG_THRESHOLD_PX;
}

/** `MouseEvent.buttons` 的左键位（规范位掩码：1 = 左键，2 = 右键，4 = 中键）。 */
const LEFT_BUTTON_MASK = 1;

/**
 * 鼠标左键是否仍按着。
 *
 * ★ 这是「tap 之后桌宠被鼠标带着跑」那个缺陷的判据。放下鼠标抬起后，
 *   Chromium 仍会继续派发 mousemove（buttons === 0）；只看位移不看按键，
 *   残留的按下状态就会把任何超过 4px 的移动当成拖拽开始。
 *   非法值按「没按」处理——宁可不拖，也不要窗口自己动。
 */
export function isPrimaryButtonDown(buttons: number | null | undefined): boolean {
  if (typeof buttons !== "number" || !Number.isFinite(buttons)) return false;
  return (buttons & LEFT_BUTTON_MASK) === LEFT_BUTTON_MASK;
}

/** 一次「按下」的会话状态；dragging 一旦为真就不需要再判阈值。 */
export interface DragSession {
  startX: number;
  startY: number;
  dragging: boolean;
}

/**
 * 是否应该从「按下」进入「拖拽」：越过阈值 **且** 左键仍按着。
 *
 * 拖拽已经开始后不再调用本函数（中途松键丢抬起事件时，由鼠标移动里的
 * 「左键已抬起」分支清掉会话，见 PetWindow 的 onMoveDrag）。
 */
export function shouldBeginDrag(
  session: DragSession | null | undefined,
  x: number,
  y: number,
  buttons: number | null | undefined,
): boolean {
  if (!session || session.dragging) return false;
  if (!isPrimaryButtonDown(buttons)) return false;
  return exceedsDragThreshold(session.startX, session.startY, x, y);
}

/**
 * 按帧合并高频动作（拖拽移动上报用）。
 *
 * 设计稿（spec §5）要求拖拽按 requestAnimationFrame 节流、抬起补一次终值：
 * 原生 mousemove 在 Windows 上可达 125–1000Hz，逐次 IPC + 主进程逐次 setPosition
 * 会让透明置顶窗的合成跟不上，表现就是残影与边缘闪烁。这里把「这一帧内发生的
 * 任意多次 request」合并成一次 emit，并且只在真的有未发出的移动时补发终值。
 *
 * 调度器由调用方注入（组件用 requestAnimationFrame，测试用可控的假帧），
 * 所以本函数不依赖任何 DOM。
 */
export interface FrameCoalescer {
  /** 标记「有一次待上报」，同一帧内重复调用只会上报一次。 */
  request: () => void;
  /** 立刻把待上报的那次发出去（用于 mouseup 补终值）；没有待发的就不发。 */
  flush: () => void;
  /** 丢弃待上报的移动（组件卸载 / 拖拽被取消）。 */
  cancel: () => void;
}

export interface FrameScheduler {
  schedule: (callback: () => void) => number;
  cancel: (id: number) => void;
}

export function createFrameCoalescer(
  emit: () => void,
  scheduler: FrameScheduler,
): FrameCoalescer {
  let frame = 0; // 0 表示没有已排队的帧（rAF 的返回值恒为正整数）
  let dirty = false;
  return {
    request() {
      dirty = true;
      if (frame !== 0) return;
      frame = scheduler.schedule(() => {
        frame = 0;
        if (!dirty) return;
        dirty = false;
        emit();
      });
    },
    flush() {
      if (frame !== 0) {
        scheduler.cancel(frame);
        frame = 0;
      }
      if (!dirty) return;
      dirty = false;
      emit();
    },
    cancel() {
      if (frame !== 0) {
        scheduler.cancel(frame);
        frame = 0;
      }
      dirty = false;
    },
  };
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
