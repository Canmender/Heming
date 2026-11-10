import type { ReactNode } from "react";

/**
 * 模型页的分区卡片（d.112 / d.124 视觉收口）：统一标题/图标/说明/右侧动作的排版。
 *
 * 模型页组件多，若每个分区各写一遍「标题 + 说明 + 卡片边距」，很快会出现字号、
 * 间距、圆角漂移。这里只收口外观，不接管业务：
 * - 卡片一律 `.ui-card`（12px 圆角 / token 阴影 / 暗色自动跟随），不再各自写 `bg-white + shadow-[…]`；
 * - 分区标题可选一枚 16px 图标（与全站 icons.tsx 同一套描边），让「模型/来源/运行」有稳定的视觉锚点；
 * - 内部间距固定：标题—说明 4px、标题区—内容 12px。
 */
export function SectionCard({
  icon,
  title,
  description,
  action,
  children,
  className = "",
}: {
  /** 分区图标（建议 16px，由调用方从 icons.tsx 传入）。 */
  icon?: ReactNode;
  title: ReactNode;
  description?: ReactNode;
  action?: ReactNode;
  children: ReactNode;
  className?: string;
}) {
  return (
    <section className={`ui-card p-4 ${className}`}>
      <div className="flex items-start justify-between gap-3">
        <div className="min-w-0">
          <div className="flex items-center gap-2">
            {icon && <span className="shrink-0 text-muted">{icon}</span>}
            <div className="text-[13px] font-bold">{title}</div>
          </div>
          {description && <p className="mt-1 ui-caption">{description}</p>}
        </div>
        {action && <div className="shrink-0">{action}</div>}
      </div>
      <div className="mt-3">{children}</div>
    </section>
  );
}
