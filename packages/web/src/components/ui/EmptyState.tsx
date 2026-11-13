import type { ReactNode } from "react";

/**
 * 统一空态（d.63 · T3；d.140 增 `framed`）。
 *
 * 为什么单独立组件：d.62 之后各页空态仍是「图标 24/28/32、标题 12/13/14、说明宽度各异」
 * 各写一套。这里把结构收敛成一份，视觉走 `index.css` 的 `.ui-empty*` 基元——
 * 页面只传内容（图标/标题/说明/操作），不再自己拼间距与字号。
 *
 * 用法：
 *   <EmptyState
 *     icon={<AutomationIcon width={22} height={22} />}
 *     title="还没有自动化任务"
 *     desc="可以把信息中枢的同步设成每天定时执行。"
 *     actions={<button …>新建自动化</button>}
 *   />
 *
 * `compact` 用于卡片内部的小空态（列表卡/侧栏卡）：收紧上下留白，不撑高卡片。
 * `framed` 用于「空态自己就是一块卡片」的场景（列表为空、页面降级）：套 `.ui-card`
 * 描边并把上下留白收到 py-8——插件区曾有三处逐字重复这套壳（审计 S2「三态各自为战」）。
 */
export interface EmptyStateProps {
  /** 图标节点（可选）。统一放在 40px 的图标槽里，由本组件控制尺寸与颜色。 */
  icon?: ReactNode;
  /** 主标题（一句话说清「现在没有什么」）。 */
  title: ReactNode;
  /** 补充说明（怎么产生内容 / 为什么空），可选。 */
  desc?: ReactNode;
  /** 操作区（主按钮/次按钮），可选。 */
  actions?: ReactNode;
  /** 紧凑变体：用于卡片内部而非整页空态。 */
  compact?: boolean;
  /** 自带卡片描边：空态本身就是一块独立卡片时使用。 */
  framed?: boolean;
  /** 额外容器类（如高度约束/最大宽度），可选。 */
  className?: string;
}

export function EmptyState({
  icon,
  title,
  desc,
  actions,
  compact = false,
  framed = false,
  className = "",
}: EmptyStateProps) {
  const classes = [
    "ui-empty",
    compact ? "gap-1 py-5" : "",
    framed ? "ui-card py-8" : "",
    className,
  ]
    .filter(Boolean)
    .join(" ");
  return (
    <div className={classes}>
      {icon ? (
        <div className="ui-icon-tile" aria-hidden="true">
          {icon}
        </div>
      ) : null}
      <p className="ui-empty-title">{title}</p>
      {desc ? <p className="ui-empty-desc">{desc}</p> : null}
      {actions ? <div className="ui-empty-actions">{actions}</div> : null}
    </div>
  );
}