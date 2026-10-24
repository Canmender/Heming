import { useState } from "react";
import {
  HomeIcon,
  ChatIcon,
  PlugIcon,
  MemoryIcon,
  ArchiveIcon,
  GearIcon,
  UserIcon,
  SkillsIcon,
  TaskIcon,
  SearchIcon,
} from "./icons.js";
import { normalizeNavOrder, useUiStore, type NavPage } from "../store/ui.js";
import { useAuthStore } from "../store/auth.js";
import { useChatStore } from "../store/chat.js";
import { NotificationCenter } from "./NotificationCenter.js";
import { ConfirmDialog } from "./ConfirmDialog.js";

/**
 * 导航项目录（顺序无关）：展示顺序由设置区的「导航顺序」决定（store.navOrder），
 * 而 digit 固定绑定页本身——所以排序后 Alt+N 快捷键不变。
 */
const ITEMS: { page: NavPage; label: string; icon: JSX.Element; digit: string }[] = [
  { page: "home", label: "主页", icon: <HomeIcon width={17} height={17} />, digit: "1" },
  { page: "workspace", label: "工作区", icon: <ChatIcon width={17} height={17} />, digit: "2" },
  // 任务区是新页，拿 8（老页编号不动，见设置区的注释）
  { page: "tasks", label: "任务区", icon: <TaskIcon width={17} height={17} />, digit: "8" },
  { page: "skills", label: "技能区", icon: <SkillsIcon width={17} height={17} />, digit: "3" },
  { page: "interfaces", label: "接口区", icon: <PlugIcon width={17} height={17} />, digit: "4" },
  { page: "memory", label: "记忆区", icon: <MemoryIcon width={17} height={17} />, digit: "5" },
  // 归档是新页，拿 7；设置区保持 6 不动——digit 绑定页面不随显示顺序变，
  // 改老页的编号等于把用户肌肉记忆里的快捷键换掉。
  { page: "archive", label: "归档", icon: <ArchiveIcon width={17} height={17} />, digit: "7" },
  { page: "settings", label: "设置区", icon: <GearIcon width={17} height={17} />, digit: "6" },
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
export function NavRail({ onOpenSearch }: { onOpenSearch?: () => void } = {}) {
  const page = useUiStore((s) => s.page);
  const setPage = useUiStore((s) => s.setPage);
  // 渲染前再规整一次：手改过 localStorage 或旧版本残留时，缺项也会被补齐，绝不漏掉某个入口
  const navOrder = normalizeNavOrder(useUiStore((s) => s.navOrder));
  const displayName = useAuthStore((s) => s.user?.displayName);
  const avatar = useAuthStore((s) => s.user?.avatar);
  // 全局未读总和（direct+group）：数据由登录后已有挂载加载（HomePage/RadarContacts 的 loadWorkspace），此处纯读取
  const unread = useChatStore((s) => s.conversations.reduce((n, c) => n + c.unreadCount, 0));
  const who = displayName || "我";
  // 退出是破坏性操作（会清掉会话态），先问一句再登出
  const [confirmLogout, setConfirmLogout] = useState(false);

  return (
    <nav
      aria-label="主导航"
      className="flex w-[54px] shrink-0 flex-col items-center border-r border-line-soft bg-[#fafafa] py-3"
    >
      <div className="group relative mb-2">
        <button
          type="button"
          aria-label="全局搜索 Ctrl K"
          onClick={() => onOpenSearch?.()}
          className="flex h-[34px] w-[34px] items-center justify-center rounded-[9px] text-[#666] transition-colors duration-150 hover:bg-[#f0f0f0] hover:text-ink"
        >
          <SearchIcon width={17} height={17} />
        </button>
        <Tip label="搜索" shortcut="Ctrl K" />
      </div>

      <div className="flex flex-1 flex-col items-center justify-center gap-1.5">
        {navOrder
          .map((navPage) => ITEMS.find((it) => it.page === navPage))
          .filter((it): it is (typeof ITEMS)[number] => Boolean(it))
          .map((it) => {
          const active = page === it.page || (it.page === "workspace" && page === "chat");
          const shortcut = `Alt${it.digit}`;
          // 工作区按钮承载全局未读角标：>0 时 aria-label 追加「N 条未读」
          const showUnread = it.page === "workspace" && unread > 0;
          return (
            <div key={it.page} className="group relative">
              <button
                type="button"
                aria-label={`${it.label} ${shortcut}${showUnread ? ` ${unread} 条未读` : ""}`}
                aria-current={active ? "page" : undefined}
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

      <div className="mb-1 flex flex-col items-center gap-1.5">
        <NotificationCenter />
      </div>

      <div className="group relative">
        <button
          type="button"
          aria-label={`账户：${who} · 退出登录`}
          title="退出登录"
          onClick={() => setConfirmLogout(true)}
          className="flex h-[28px] w-[28px] items-center justify-center overflow-hidden rounded-full bg-[#ececec] text-[12px] font-bold text-[#555] transition-colors duration-150 hover:bg-[#f0f0f0]"
        >
          {avatar ? (
            <img src={avatar} alt="" className="h-full w-full rounded-full object-cover" />
          ) : (
            <UserIcon width={14} height={14} />
          )}
        </button>
        <Tip label={`${who} · 账户`} />
      </div>

      {confirmLogout && (
        <ConfirmDialog
          title="退出登录"
          onCancel={() => setConfirmLogout(false)}
          footer={
            <>
              <button
                type="button"
                onClick={() => setConfirmLogout(false)}
                className="rounded-lg border border-line px-3 py-1.5 text-[12px] hover:bg-[#fafafa]"
              >
                取消
              </button>
              <button
                type="button"
                onClick={() => {
                  setConfirmLogout(false);
                  useAuthStore.getState().logout();
                }}
                className="rounded-lg bg-[#b42318] px-3 py-1.5 text-[12px] font-medium text-white hover:bg-[#912018]"
              >
                退出登录
              </button>
            </>
          }
        >
          <p className="text-[12px] leading-6">退出后需要重新登录才能继续使用和鸣。</p>
        </ConfirmDialog>
      )}
    </nav>
  );
}
