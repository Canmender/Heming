import { HomeIcon, ChatIcon, PlugIcon, MemoryIcon, GearIcon, MenuIcon } from "./icons.js";
import { useUiStore, type Page } from "../store/ui.js";

const ITEMS: { page: Page; icon: JSX.Element; label: string }[] = [
  { page: "home", icon: <HomeIcon width={16} height={16} />, label: "主页" },
  { page: "workspace", icon: <ChatIcon width={16} height={16} />, label: "工作区" },
  { page: "interfaces", icon: <PlugIcon width={16} height={16} />, label: "接口区" },
  { page: "memory", icon: <MemoryIcon width={16} height={16} />, label: "记忆区" },
  { page: "settings", icon: <GearIcon width={16} height={16} />, label: "设置区" },
];

export function NavRail() {
  const setPage = useUiStore((s) => s.setPage);
  const setNavCollapsed = useUiStore((s) => s.setNavCollapsed);
  return (
    <nav className="flex w-[48px] shrink-0 flex-col items-center gap-2 border-r border-line-soft bg-panel py-3">
      <button
        type="button"
        aria-label="展开导航"
        title="展开导航 (⌘\)"
        onClick={() => setNavCollapsed(false)}
        className="rounded-md p-1.5 text-ink hover:bg-[#f0f0f0]"
      >
        <MenuIcon width={16} height={16} />
      </button>
      {ITEMS.map((it) => (
        <button
          key={it.page}
          type="button"
          aria-label={it.label}
          title={it.label}
          onClick={() => setPage(it.page)}
          className="rounded-md p-1.5 text-[#666] hover:bg-[#f0f0f0] hover:text-ink"
        >
          {it.icon}
        </button>
      ))}
    </nav>
  );
}
