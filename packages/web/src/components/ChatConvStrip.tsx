import { useChatStore } from "../store/chat.js";
import { useUiStore } from "../store/ui.js";
import { convLabel } from "./ChatPage.js";
import { Avatar } from "./Avatar.js";

/**
 * 聊天页左侧头像缩略竖列：把已打开的会话（openTabs）以头像形式列出，点一下即切换。
 *
 * 与上方 ConversationTabs 是同一份数据的两种视图——一个看名字、一个看脸，
 * 都覆盖「快速切换」的需求。竖列只显示已经打开过的会话（不在通讯录里重新翻一遍），
 * 顶到上限 TABS_MAX 时它与标签栏一起滚动。
 *
 * 宽度固定 52px：只放 26px 头像 + 一点 padding，横向标签栏才是标题的阅读区。
 */
export function ChatConvStrip() {
  const conversations = useChatStore((s) => s.conversations);
  const openTabs = useUiStore((s) => s.openTabs);
  const activeId = useUiStore((s) => s.activeConversationId);
  const openConversation = useUiStore((s) => s.openConversation);

  if (openTabs.length === 0) return null;

  return (
    <aside
      className="flex w-[52px] shrink-0 flex-col items-center gap-1 overflow-y-auto border-r border-line-soft bg-[#fcfcfc] py-2"
      aria-label="会话缩略列"
    >
      {openTabs.map((id) => {
        // 会话可能还没加载完、或已从服务端消失——两种都给「已失效会话」占位，
        // 不能让 convLabel 拿到 undefined（它按三态取字段，遇 undefined 会抛）。
        const conv = conversations.find((c) => c.id === id);
        const label = conv ? convLabel(conv) : { name: "已失效会话", avatar: undefined };
        const name = label.name;
        const avatar = label.avatar;
        const unread = conv?.unreadCount ?? 0;
        const active = id === activeId;
        return (
          <button
            key={id}
            type="button"
            aria-label={`切换到 ${name}${unread > 0 ? ` ${unread} 条未读` : ""}`}
            aria-current={active || undefined}
            title={name}
            onClick={() => openConversation(id)}
            className={`relative flex w-[40px] shrink-0 items-center justify-center rounded-xl py-1 transition-colors ${
              active ? "bg-[#ededed]" : "hover:bg-[#f4f4f4]"
            }`}
          >
            <Avatar
              user={{ displayName: name, avatar }}
              size={26}
              className={active ? "ring-2 ring-ink ring-offset-1" : ""}
            />
            {unread > 0 && (
              <span
                aria-hidden="true"
                className="absolute -right-0.5 -top-0.5 min-w-[14px] rounded-full bg-ink px-1 text-center text-[9px] font-bold leading-[14px] text-white"
              >
                {unread > 99 ? "99+" : unread}
              </span>
            )}
          </button>
        );
      })}
    </aside>
  );
}