import type { JSX, SVGProps } from "react";
import { BookIcon, ModelIcon, PlugIcon, TeamIcon } from "./icons.js";
import { usePluginPageEntries } from "../lib/pages/usePluginPages.js";
import { PluginPageIcon } from "./plugins/PluginPageIcon.js";
import { useUiStore, type Page } from "../store/ui.js";

/**
 * 常驻侧栏顶部的主导航（d.147.4.89）。
 *
 * 顺序按产品要求从用户视线自上而下排：插件 → 团队 → 模型 → 知识库，
 * 装出来的插件页面接在知识库下面（「装一个就多一行」），设置单独落在栏底。
 * 顶栏的「页面」下拉因此退场：导航只应该有一个入口，否则同一个页面名
 * 会在两处各排一次，用户还得猜哪一处才是「完整的」。
 *
 * 本组件只读 `page` 做高亮，点击走 `setPage`——真正的路由仍在 App 里，
 * 这里不复制任何页面集合：固定四项是宿主页，插件页来自注册表并过滤可用性。
 */

interface NavItem {
  page: Page;
  label: string;
  Icon: (props: SVGProps<SVGSVGElement>) => JSX.Element;
}

/** 固定四项宿主页（图标与页面语义对齐：插件=插头、团队=多人、模型=芯片、知识库=书）。 */
const NAV_ITEMS: NavItem[] = [
  { page: "plugins", label: "插件", Icon: PlugIcon },
  { page: "team", label: "团队", Icon: TeamIcon },
  { page: "model", label: "模型", Icon: ModelIcon },
  { page: "vault", label: "知识库", Icon: BookIcon },
];

/** 一行的共用观感：整行可点、当前页高亮（`aria-current="page"`）。栏底「设置」复用同一套。 */
export function sidebarRowClass(active: boolean): string {
  return `flex w-full items-center gap-2 rounded-lg px-2 py-1.5 text-left text-ui-sm transition-colors ${
    active ? "bg-subtle-3 text-ink" : "text-body hover:bg-subtle-2 hover:text-ink"
  }`;
}

export function SidebarNav() {
  const page = useUiStore((s) => s.page);
  const setPage = useUiStore((s) => s.setPage);
  const pluginEntries = usePluginPageEntries();

  // 只列装好且可用的插件页：预置但没装的条目不该占着导航位置。
  const available = pluginEntries.filter((entry) => entry.available);

  return (
    <nav aria-label="主导航" className="flex shrink-0 flex-col gap-0.5 px-2 pb-1 pt-2">
      {NAV_ITEMS.map(({ page: target, label, Icon }) => (
        <button
          key={target}
          type="button"
          aria-current={page === target ? "page" : undefined}
          onClick={() => setPage(target)}
          className={sidebarRowClass(page === target)}
        >
          <Icon width={16} height={16} aria-hidden="true" className="shrink-0" />
          <span className="min-w-0 flex-1 truncate">{label}</span>
        </button>
      ))}
      {/* 插件页：紧随知识库之后，装/卸即时增减（注册表本身是响应式的）。 */}
      {available.map((entry) => (
        <button
          key={entry.pageId}
          type="button"
          title={entry.title}
          aria-current={page === entry.pageId ? "page" : undefined}
          onClick={() => setPage(entry.pageId)}
          className={sidebarRowClass(page === entry.pageId)}
        >
          <PluginPageIcon icon={entry.icon} size={16} className="shrink-0" />
          <span className="min-w-0 flex-1 truncate">{entry.title}</span>
        </button>
      ))}
    </nav>
  );
}
