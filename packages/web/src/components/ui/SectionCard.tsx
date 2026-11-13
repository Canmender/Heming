import type { ReactNode } from "react";

/**
 * 通用分区卡片（③-1：把模型页先跑出来的分区骨架提升为公共基元）。
 *
 * 语义沿用 `components/model/SectionCard`（卡片 `.ui-card` + 图标/标题/说明 + 右侧动作
 * + 12px 内容间距），但定位改为「任何页面都能用的分区容器」：模型页那份仍归模型页
 * （本轨不改 model/），这里不复制它的文件，只把对外契约固定下来，供后续页面迁移。
 *
 * 与 `EmptyState` 的分工：这里是**有内容**的分区壳；空态/失败态用 `AsyncBoundary`。
 * 标题不写成 <hN>：调用方页面已有 h1/h2 层级，强塞标题级别会造成跳过层级；
 * 需要语义标题时由调用方在 `title` 里传 <h2> 之类的节点（本组件只负责排版）。
 */
export interface SectionCardProps {
  /** 分区图标（建议 16px，取自 icons.tsx）。 */
  icon?: ReactNode;
  title: ReactNode;
  description?: ReactNode;
  /** 标题右侧的动作（按钮/开关）。 */
  action?: ReactNode;
  children: ReactNode;
  /** 额外容器类（可加 margin / grid 跨度）。 */
  className?: string;
}

export function SectionCard({
  icon,
  title,
  description,
  action,
  children,
  className = "",
}: SectionCardProps) {
  return (
    <section className={`ui-card p-4${className ? ` ${className}` : ""}`}>
      <div className="flex items-start justify-between gap-3">
        <div className="min-w-0">
          <div className="flex items-center gap-2">
            {icon ? <span className="shrink-0 text-muted">{icon}</span> : null}
            <div className="text-ui-md font-bold">{title}</div>
          </div>
          {description ? <p className="mt-1 ui-caption">{description}</p> : null}
        </div>
        {action ? <div className="shrink-0">{action}</div> : null}
      </div>
      <div className="mt-3">{children}</div>
    </section>
  );
}