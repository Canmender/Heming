import { forwardRef, type HTMLAttributes, type ReactNode } from "react";

/**
 * 列表行基元（2026-11-14 审计 C3）。
 *
 * 只包一层 `.ui-list-row`：行高两档（normal 48 / dense 36）、横向 px-4、
 * 末行无分割线、hover 用 --subtle。调用方仍自己决定「左侧图标 + 主标题 + 右侧操作」的
 * 内部排布（各页密度不同，收口到「行高 + 对齐 + 分隔线」即可，不再收内边距）。
 *
 * 为什么不用 `<li>`：调用方有的是 `<div role="listitem">`、有的直接是 `<button>`；
 * 这一层不猜语义，需要列表语义时由调用方传 `role`/包 `<ul>`。
 */
export interface ListRowProps extends Omit<HTMLAttributes<HTMLDivElement>, "className"> {
  /** 紧凑档（36px），用于设置项/名册这类一行一行的纯文本列表。 */
  dense?: boolean;
  /** 追加的布局类（如 `justify-between`）；不要用它改行高或颜色。 */
  className?: string;
  children?: ReactNode;
}

export const ListRow = forwardRef<HTMLDivElement, ListRowProps>(function ListRow(
  { dense = false, className = "", children, ...rest },
  ref,
) {
  const classes = `ui-list-row${dense ? " ui-list-row-dense" : ""}${className ? ` ${className}` : ""}`;
  return (
    <div ref={ref} className={classes} {...rest}>
      {children}
    </div>
  );
});
