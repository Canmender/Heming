import { HomeIcon, ChatIcon, PlugIcon, MemoryIcon, GearIcon, ChevronIcon, UserIcon } from "./icons.js";
import { useUiStore, type Page } from "../store/ui.js";
import { useAuthStore } from "../store/auth.js";
import { useChatStore } from "../store/chat.js";

const ITEMS: { page: Page; label: string; icon: JSX.Element; digit: string }[] = [
  { page: "home", label: "主页", icon: <HomeIcon width={17} height={17} />, digit: "1" },
  { page: "workspace", label: "工作区", icon: <ChatIcon width={17} height={17} />, digit: "2" },
  { page: "interfaces", label: "接口区", icon: <PlugIcon width={17} height={17} />, digit: "3" },
  { page: "memory", label: "记忆区", icon: <MemoryIcon width={17} height={17} />, digit: "4" },
  { page: "settings", label: "设置区", icon: <GearIcon width={17} height={17} />, digit: "5" },
];

/** 悬停黑色胶囊浮签：淡入 + 轻微左移进入（group-hover，150ms）。 */
function Tip({ label, shortcut }: { label: string; shortcut?: string }) {
  return (
    <span className="pointer-events-none absolute left-full top-1/2 z-20 ml-2 flex -translate-y-1/2 translate-x-1 items-center gap-1.5 whitespace-nowrap rounded-[7px] bg-ink px-2 py-1 text-[11px] font-medium text-white opacity-0 shadow-[0_2px_6px_rgba(0,0,0,0.25)] transition-all duration-150 group-hover:translate-x-0 group-hover:opacity-100">
      <span>{label}</span>
      {shortcut && (
        <kbd className="rounded border border-[#666] px-1 text-[10px] font-normal text-[#ccc]">
          {shortcut}
        </kbd>
      )}
    </span>
  );
}

/** 图标轨（A 方案默认态）：约 54px 常驻左缘，无产品名文字。 */
export function NavRail() {
  const page = useUiStore((s) => s.page);
  const setPage = useUiStore((s) => s.setPage);
  const displayName = useAuthStore((s) => s.user?.displayName);
  const avatar = useAuthStore((s) => s.user?.avatar);
  // 全局未读总和（direct+group）：数据由登录后已有挂载加载（HomePage/RadarContacts 的 loadWorkspace），此处纯读取
  const unread = useChatStore((s) => s.conversations.reduce((n, c) => n + c.unreadCount, 0));
  const who = displayName || "我";

  return (
    <nav
      aria-label="主导航"
      className="flex w-[54px] shrink-0 flex-col items-center border-r border-line-soft bg-[#fafafa] py-3"
    >
      <div className="flex flex-1 flex-col items-center justify-center gap-1.5">
        {ITEMS.map((it) => {
          const active = page === it.page || (it.page === "workspace" && page === "chat");
          const shortcut = `Alt${it.digit}`;
          // 工作区按钮承载全局未读角标：>0 时 aria-label 追加「N 条未读」
          const showUnread = it.page === "workspace" && unread > 0;
          return (
            <div key={it.page} className="group relative">
              <button
                type="button"
                aria-label={`${it.label} ${shortcut}${showUnread ? ` ${unread} 条未读` : ""}`}
                onClick={() => setPage(it.page)}
                className={`relative flex h-[34px] w-[34px] items-center justify-center rounded-[9px] transition-colors duration-150 ${
                  active ? "bg-ink text-white" : "text-[#666] hover:bg-[#f0f0f0] hover:text-ink"
                }`}
              >
                {it.icon}
                {showUnread && (
                  <span className="absolute -right-1 -top-1 min-w-[16px] rounded-full border border-white bg-ink px-1 text-center text-[9px] font-semibold leading-[14px] text-white">
                    {unread}
                  </span>
                )}
              </button>
              <Tip label={it.label} shortcut={shortcut} />
            </div>
          );
        })}
      </div>

      <div className="group relative">
        <button
          type="button"
          aria-label="退出登录"
          onClick={() => useAuthStore.getState().logout()}
          className="flex h-[28px] w-[28px] items-center justify-center overflow-hidden rounded-full bg-[#ececec] text-[12px] font-bold text-[#555] transition-colors duration-150 hover:bg-[#f0f0f0]"
        >
          {avatar ? (
            <img src={avatar} alt="" className="h-full w-full rounded-full object-cover" />
          ) : (
            <UserIcon width={14} height={14} />
          )}
        </button>
        <Tip label={`${who} · 在线`} />
      </div>
    </nav>
  );
}

/** 会话隐藏态（navCollapsed=true）左缘的可发现呼出提示。 */
export function NavPeek() {
  const setNavCollapsed = useUiStore((s) => s.setNavCollapsed);
  return (
    <div className="flex w-[8px] shrink-0 flex-col items-center border-r border-line-soft bg-[#fafafa] pt-3">
      <button
        type="button"
        aria-label="呼出导航"
        onClick={() => setNavCollapsed(false)}
        className="rounded p-0.5 text-[#999] transition-colors duration-150 hover:bg-[#f0f0f0] hover:text-ink"
      >
        <ChevronIcon width={12} height={12} />
      </button>
    </div>
  );
}
