import { HomeIcon, ChatIcon, PlugIcon, MemoryIcon, GearIcon, MenuIcon } from "./icons.js";
import { useUiStore, type Page } from "../store/ui.js";

const ITEMS: { page: Page; label: string; icon: JSX.Element }[] = [
  { page: "home", label: "主页", icon: <HomeIcon width={16} height={16} /> },
  { page: "workspace", label: "工作区", icon: <ChatIcon width={16} height={16} /> },
  { page: "interfaces", label: "接口区", icon: <PlugIcon width={16} height={16} /> },
  { page: "memory", label: "记忆区", icon: <MemoryIcon width={16} height={16} /> },
  { page: "settings", label: "设置区", icon: <GearIcon width={16} height={16} /> },
];

export function NavSidebar() {
  const page = useUiStore((s) => s.page);
  const setPage = useUiStore((s) => s.setPage);
  const setNavCollapsed = useUiStore((s) => s.setNavCollapsed);
  return (
    <nav className="flex w-[184px] shrink-0 flex-col gap-1 border-r border-line-soft bg-panel p-3">
      <div className="mb-2 flex items-center justify-between border-b border-line-soft pb-2">
        <span className="text-[15px] font-extrabold">合序 Heming</span>
        <button
          type="button"
          aria-label="收起导航"
          onClick={() => setNavCollapsed(true)}
          className="rounded p-1 text-muted hover:bg-[#f0f0f0]"
        >
          <MenuIcon width={15} height={15} />
        </button>
      </div>
      {ITEMS.map((it) => {
        const active = page === it.page || (it.page === "workspace" && page === "chat");
        return (
          <button
            key={it.page}
            type="button"
            onClick={() => setPage(it.page)}
            className={`flex items-center gap-2 rounded-lg border px-2.5 py-2 text-[13px] ${
              active
                ? "border-[#d9d9d9] bg-white font-bold text-ink shadow-float"
                : "border-transparent text-[#555] hover:bg-[#f3f3f3]"
            }`}
          >
            {it.icon}
            {it.label}
          </button>
        );
      })}
      <div className="flex-1" />
      <div className="border-t border-line-soft pt-2 text-[11px] text-muted">已登录</div>
    </nav>
  );
}
