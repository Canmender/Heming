import { forwardRef, type ButtonHTMLAttributes, type ReactNode } from "react";

/**
 * 按钮基元（d.138 · 阶段 2 的第一块）。
 *
 * 现状是反过来的：`.ui-btn-*` 这套类早就收口了，但调用方仍各自拼字符串
 *（`className="ui-btn ui-btn-md ui-btn-primary"` 在仓里出现上百次），于是
 *   · 有人忘写 `ui-btn-md`，按钮变成 0 高度；
 *   · 有人给 danger 按钮补 `text-[var(--danger)]`，和 `.ui-btn-danger` 的
 *     白字打架；
 *   · 尺寸/变体的组合没有类型约束，写错也编译得过。
 * 这一层只做三件事：把「变体 + 尺寸」变成 props、把 busy 统一成 disabled +
 * `aria-busy`、把前置图标统一成 `aria-hidden` 的装饰。
 *
 * 样式仍全部落在 `.ui-btn-*` 上——不引入第二套按钮样式，迁移一个地方就少一处
 * 手拼字符串。
 */
export type ButtonVariant = "primary" | "ghost" | "danger";
export type ButtonSize = "sm" | "md";

export interface ButtonProps extends Omit<ButtonHTMLAttributes<HTMLButtonElement>, "className"> {
  variant?: ButtonVariant;
  size?: ButtonSize;
  /** 进行中：禁用 + `aria-busy`，并让调用方自己换文案（这里不猜「加载中」）。 */
  busy?: boolean;
  /** 前置图标（16px 以内最好）；容器自动 `aria-hidden`。 */
  leadingIcon?: ReactNode;
  /** 追加的布局类（宽、间距、`ml-auto` 等）；不要用它改颜色或字号。 */
  className?: string;
}

export const Button = forwardRef<HTMLButtonElement, ButtonProps>(function Button(
  {
    variant = "primary",
    size = "md",
    busy = false,
    leadingIcon,
    className = "",
    children,
    disabled,
    type = "button",
    ...rest
  },
  ref,
) {
  return (
    <button
      ref={ref}
      type={type}
      disabled={disabled || busy}
      aria-busy={busy || undefined}
      className={`ui-btn ui-btn-${size} ui-btn-${variant}${className ? ` ${className}` : ""}`}
      {...rest}
    >
      {leadingIcon ? (
        <span aria-hidden="true" className="inline-flex shrink-0 items-center">
          {leadingIcon}
        </span>
      ) : null}
      {children}
    </button>
  );
});
