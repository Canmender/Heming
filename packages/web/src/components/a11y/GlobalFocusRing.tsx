import { useEffect } from "react";

/**
 * 全站键盘焦点环（③-2 无障碍巡检）。
 *
 * 为什么是运行时注入一条 `<style>`：
 * - 本仓 56 处输入框/按钮带着 Tailwind v4 的 `outline-hidden`（= 旧 `outline-none`），
 *   迁移后这些控件**没有任何可见焦点环**；逐处改 className 既容易漏，也会和别的批次撞同一批文件；
 * - `index.css` 属于样式链基线（不归本轨），在组件层注入是唯一不越界的系统性修法；
 * - 只加一条 `:focus-visible` 规则、不碰任何既有 token/间距/颜色，观感只在**键盘聚焦**时出现。
 *
 * 选择器为什么能赢过 `outline-hidden`：两者特异性相同（0,1,0），
 * 而这条 style 在 Tailwind 样式表之后插入文档，后者胜出——鼠标点击不会出环（`:focus-visible` 语义），
 * 键盘 Tab/方向键才出环，正符合 WCAG 2.4.7 与「不要给鼠标用户加噪音」的双重要求。
 */

export const FOCUS_STYLE_ID = "heming-focus-visible";

/** 焦点环的 CSS（单独导出便于测试与复用）。 */
export const FOCUS_CSS = `
:focus-visible {
  outline: 2px solid var(--heming-accent, #1a1a1a);
  outline-offset: 2px;
}
/* 系统高对比模式：交还给系统色，别用自定义黑盖掉可见性 */
@media (forced-colors: active) {
  :focus-visible {
    outline: 2px solid Highlight;
  }
}
`;

/**
 * 挂一次即可（放在常驻的导航轨里）。幂等：已存在同名 style 时不重复插入。
 * 不做卸载清理：焦点样式是会话级基础设施，卸载再挂回来反而会闪一帧无环。
 */
export function GlobalFocusRing() {
  useEffect(() => {
    if (typeof document === "undefined") return;
    if (document.getElementById(FOCUS_STYLE_ID)) return;
    const style = document.createElement("style");
    style.id = FOCUS_STYLE_ID;
    style.textContent = FOCUS_CSS;
    document.head.appendChild(style);
  }, []);
  return null;
}
