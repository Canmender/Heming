import type { ReactNode } from "react";

/**
 * 模型页的分区卡片（d.112）：统一标题/说明/右侧动作的排版。
 *
 * 模型页组件多，若每个分区各写一遍「标题 + 说明 + 卡片边距」，很快会出现字号、
 * 间距、圆角漂移。这里只收口外观，不接管业务。
 */
export function SectionCard({
  title,
  description,
  action,
  children,
  className = "",
}: {
  title: ReactNode;
  description?: ReactNode;
  action?: ReactNode;
  children: ReactNode;
  className?: string;
}) {
  return (
    <section className={`rounded-[20px] border border-line bg-white p-4 ${className}`}>
      <div className="flex items-start justify-between gap-3">
        <div className="min-w-0">
          <div className="text-[13px] font-bold">{title}</div>
          {description && <p className="mt-0.5 ui-caption">{description}</p>}
        </div>
        {action && <div className="shrink-0">{action}</div>}
      </div>
      <div className="mt-2">{children}</div>
    </section>
  );
}
