/**
 * PageShell：页面级布局与排版基元（d.62 布局/排版统一轮）。
 *
 * 为什么要有它：改造前 16 个页面各自写「页头 + 内边距 + 滚动容器」——
 *   · 内边距 24px / 32px 混用；
 *   · 标题 15px/16px/17px 各种粗细；
 *   · 内容宽度有的通栏、有的 520px、有的 900px，宽屏上左右跳；
 *   · 滚动容器有的在页面根、有的在内部，导致「整页滚」与「列表滚」混在一起。
 *
 * 本组件只做三件事，不接管任何业务逻辑：
 *   1. `h-full` 的纵向布局 + 固定页头 + 可滚内容区；
 *   2. 页头统一用 `.ui-page-title` / `.ui-page-sub`，右侧 `actions` 槽；
 *   3. 内容宽度按语义档位收口（full / wide 1200 / readable 960 / narrow 720）。
 *
 * 用法：
 *   <PageShell title="插件区" subtitle="…" actions={<button …/>} width="wide">
 *     …内容…
 *   </PageShell>
 *
 * 页面有自己的双栏/三栏结构时用 `scroll={false}`，把滚动交给内部容器，
 * 但仍保留统一页头（例如智能体页、团队页）。
 */
import type { ReactNode } from "react";

export type PageWidth = "full" | "wide" | "readable" | "narrow";

const WIDTH_CLASS: Record<PageWidth, string> = {
  full: "",
  wide: "max-w-[1200px]",
  readable: "max-w-[960px]",
  narrow: "max-w-[720px]",
};

export interface PageShellProps {
  /** 页面标题（必填；字符串或节点，便于带徽标/时间） */
  title: ReactNode;
  /** 标题下方一句话说明 */
  subtitle?: ReactNode;
  /** 页头右侧操作区（按钮、徽标等） */
  actions?: ReactNode;
  /** 内容宽度档位，默认通栏 */
  width?: PageWidth;
  /** 是否由 PageShell 提供滚动容器（默认 true）；双栏/三栏页面传 false */
  scroll?: boolean;
  /** 额外容器类（例如 `bg-white`） */
  className?: string;
  /** 内容区额外类（例如 `flex flex-col gap-4`） */
  bodyClassName?: string;
  /** 页头与内容之间插入的附加行（页签、筛选条等），不滚动 */
  headerExtra?: ReactNode;
  /** 内容区顶部是否留内边距（默认 true；自带 padding 的段落可关） */
  padded?: boolean;
  children: ReactNode;
}

export function PageShell({
  title,
  subtitle,
  actions,
  width = "full",
  scroll = true,
  className = "",
  bodyClassName = "",
  headerExtra,
  padded = true,
  children,
}: PageShellProps) {
  return (
    <div className={`flex h-full min-h-0 flex-col ${className}`}>
      <header className="flex shrink-0 items-start justify-between gap-4 border-b border-line-soft px-6 pb-4 pt-5">
        <div className="min-w-0">
          <h1 className="ui-page-title">{title}</h1>
          {subtitle ? <p className="ui-page-sub">{subtitle}</p> : null}
        </div>
        {actions ? <div className="flex shrink-0 items-center gap-2">{actions}</div> : null}
      </header>
      {headerExtra ? <div className="shrink-0 border-b border-line-soft">{headerExtra}</div> : null}
      {scroll ? (
        <div className={`min-h-0 flex-1 overflow-y-auto ${padded ? "px-6 py-5" : ""}`}>
          <div className={`mx-auto w-full ${WIDTH_CLASS[width]} ${bodyClassName}`}>{children}</div>
        </div>
      ) : (
        <div className={`flex min-h-0 flex-1 flex-col ${bodyClassName}`}>{children}</div>
      )}
    </div>
  );
}
