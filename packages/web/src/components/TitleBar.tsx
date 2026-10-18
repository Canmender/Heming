/**
 * 桌面窗口标题栏（设计 §5/§6）：仅在 Electron 内渲染的顶部拖拽带。
 *
 * 背景：隐藏了系统标题栏（titleBarStyle: "hidden"），内容延伸到窗口顶部。
 * 定位与拖拽属性由 index.css 的 .desktop-titlebar 类承载（env() 在 CSS 文件里
 * 是标准写法；React 内联样式与 jsdom 都会丢弃非标准 CSS 函数）。
 */
export function TitleBar() {
  // 同一份 bundle 也会在浏览器打开（http://47.92.39.184）：
  // 桌面端由 preload 暴露 window.heming，浏览器无此对象 → 渲染 null。
  if (typeof window === "undefined" || !window.heming) return null;

  return (
    <div className="desktop-titlebar flex shrink-0 items-stretch border-b border-line-soft" />
  );
}
