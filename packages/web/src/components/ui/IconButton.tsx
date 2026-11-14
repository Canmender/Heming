import { forwardRef, type ButtonHTMLAttributes, type ReactNode } from "react";
import { FOCUS_RING } from "../../lib/a11y/focus.js";

/**
 * 图标按钮基元（③-2 可访问性收口）。
 *
 * 背景：全站「只有一个图标、没有文字」的按钮（关闭提示、更多、刷新小按钮）都是手写
 * `<button><svg/></button>`——三个问题反复出现：
 *   · 多数没有 `aria-label`，读屏念「按钮」；有的把 title 当名字（移动端不显示）；
 *   · 命中区只有图标大小（16–20px），低于 32×32 的可点下限（WCAG 2.5.8 目标尺寸）；
 *   · 图标没标 `aria-hidden`，装饰图形偶尔被当成内容。
 *
 * 这个基元把三件事一次做对，且把 `label` 设成**必填**：没有读屏名的图标按钮编译不过。
 * 视觉仍是既有 token（`text-muted` / `hover:bg-subtle-2` / `rounded-md`），
 * 不引入新色值；尺寸固定 32×32（h-8 w-8），需要更大时由调用方传 `className` 覆盖
 * （Tailwind utility 在 @layer 里优先于组件类，覆盖有效）。
 */
export interface IconButtonProps
  extends Omit<ButtonHTMLAttributes<HTMLButtonElement>, "className" | "children" | "aria-label"> {
  /** 读屏名（必填）：说明「这个按钮做什么」，如「关闭提示」。 */
  label: string;
  /** 图标节点（建议 16px）；容器自动 `aria-hidden`。 */
  icon: ReactNode;
  /** 追加的布局类（如 `ml-auto`）；不要用它改颜色。 */
  className?: string;
}

export const IconButton = forwardRef<HTMLButtonElement, IconButtonProps>(function IconButton(
  { label, icon, className = "", type = "button", ...rest },
  ref,
) {
  return (
    <button
      ref={ref}
      type={type}
      aria-label={label}
      // title 只作鼠标悬停提示；名字来自 aria-label（title 在触屏与部分读屏上不可靠）。
      title={label}
      className={`inline-flex h-8 w-8 shrink-0 items-center justify-center rounded-md text-muted transition-colors hover:bg-subtle-2 hover:text-ink disabled:pointer-events-none disabled:opacity-50 motion-reduce:transition-none ${FOCUS_RING}${className ? ` ${className}` : ""}`}
      {...rest}
    >
      <span aria-hidden="true" className="inline-flex items-center justify-center">
        {icon}
      </span>
    </button>
  );
});