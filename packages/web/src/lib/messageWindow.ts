/**
 * 消息列表的轻量窗口化（d.33 · P2-2）。
 *
 * 背景：`ChatPage` 的消息区是**全量渲染**——800 条消息就挂 800 个气泡，
 * 每条还带引用卡、回应 chips、图表解析与 Markdown，首屏开销随会话长度线性增长。
 *
 * 这里只做**渲染窗口**的纯计算，不碰数据层：消息仍全量加载（服务端一次给全），
 * 只限制同时挂多少 DOM 节点。滚动补偿、状态接线在组件里。
 */

/** 初始渲染窗口（条）：一屏约 8–12 条，60 条够「往上翻一会儿」又不至于首屏太重。 */
export const DEFAULT_WINDOW = 60;

/** 每次向历史追加的步长（条）。 */
export const WINDOW_STEP = 60;

/** 距顶部多少像素内触发自动追加。 */
export const NEAR_TOP_PX = 80;

/**
 * 窗口起点下标（窗口覆盖 `[start, total)`）。
 *
 * 窗口总是贴着**最新**消息：`count` 小于 0 或大于总值时都夹到合法范围。
 */
export function windowStart(total: number, count: number): number {
  const totalSafe = Math.max(0, Math.floor(total));
  const countSafe = Math.max(0, Math.floor(count));
  return Math.max(0, totalSafe - countSafe);
}

/**
 * 向下（更早）追加后的窗口条数：不超过总条数。
 *
 * @param step 步长；小于 1 时按 1 处理（否则永远原地踏步）
 */
export function expandCount(current: number, total: number, step: number = WINDOW_STEP): number {
  const totalSafe = Math.max(0, Math.floor(total));
  const currentSafe = Math.max(0, Math.floor(current));
  const stepSafe = Math.max(1, Math.floor(step));
  return Math.min(totalSafe, currentSafe + stepSafe);
}

/**
 * 是否该在滚动时追加历史。
 *
 * 三个条件缺一不可：还有更早的消息、窗口已贴顶（`scrollTop <= threshold`）。
 * 窗口条数已经覆盖全部消息时**永不**追加（否则会无限 setState）。
 */
export function shouldLoadMore(
  scrollTop: number,
  total: number,
  count: number,
  threshold: number = NEAR_TOP_PX,
): boolean {
  if (count >= total) return false;
  return Math.max(0, scrollTop) <= Math.max(0, threshold);
}

/**
 * 要让下标 `index` 的消息落进窗口，窗口至少需要多少条。
 *
 * 用于会话内搜索跳转：命中一条比当前窗口更早的消息时，先把窗口扩到包含它
 * （再留 `margin` 条上下文），渲染出来才跳得过去。
 * 返回值**不小于**当前 `count`——调用方据此判断「要不要扩」。
 */
export function countToInclude(
  index: number,
  total: number,
  count: number,
  margin = 2,
): number {
  const totalSafe = Math.max(0, Math.floor(total));
  const currentSafe = Math.max(0, Math.floor(count));
  if (index < 0 || index >= totalSafe) return currentSafe;
  const need = totalSafe - index + Math.max(0, Math.floor(margin));
  return Math.min(totalSafe, Math.max(currentSafe, need));
}
