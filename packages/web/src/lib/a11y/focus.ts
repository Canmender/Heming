/**
 * 键盘焦点可见性的统一口径（③-2 无障碍巡检）。
 *
 * 背景：Tailwind v4 迁移把旧的 `outline-none` 改名为 `outline-hidden`
 * （`outline: 2px solid transparent`），本仓 56 处输入框/按钮都带着它——
 * 迁移后这些控件**彻底没有可见焦点环**，只靠 `focus:border-*` 变一点颜色
 * （WCAG 2.4.7 / 2.4.11 只认「可见的焦点指示」，细边框变色通常不够）。
 *
 * 为什么做成常量而不是全局 CSS：`index.css` 属于样式链基线（不归本轨），
 * 且在 components 里逐处声明能让「哪些控件有焦点环」在代码里可读、可测。
 * 约定：凡是写了 `outline-hidden` 的可聚焦控件，都必须再带上 FOCUS_RING。
 *
 * v4 语义提醒：
 * - `outline-hidden` = 旧 `outline-none`（抹掉焦点环，但保留 Windows 高对比模式下的可见性）；
 * - `outline-none` 在 v4 是「style: none」，连高对比模式也抹掉 —— **禁止使用**；
 * - `outline-2`/`outline-offset-2`/`outline-ink` 才是可见环。
 */

/** 标准焦点环（外扩 2px，不遮挡相邻内容）：输入框、独立按钮用。 */
export const FOCUS_RING = "focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-ink";

/** 紧凑焦点环（不偏移）：密集列表/工具条里用，避免环被容器裁掉。 */
export const FOCUS_RING_TIGHT = "focus-visible:outline-2 focus-visible:outline-ink";

/** 在既有 className 后追加焦点环（去重：已经带过的原样返回）。 */
export function withFocusRing(base: string, ring: string = FOCUS_RING): string {
  if (base.includes("focus-visible:outline")) return base;
  return `${base} ${ring}`.trim();
}

/** 本仓焦点环的判定（给测试与代码扫描用）。 */
export function hasFocusRing(className: string): boolean {
  return /focus-visible:outline-/.test(className);
}
