import type { Conversation } from "@heming/shared";
import { useSyncExternalStore } from "react";
import { archiveConversation } from "../lib/api.js";
import { draftsVersion, hasDraft, subscribeDrafts } from "../lib/drafts.js";
import { useChatStore } from "../store/chat.js";
import { useUiStore } from "../store/ui.js";
import { Avatar } from "./Avatar.js";

/** 会话 → 标签上显示的名字与头像（direct / agent / group 三态集中一处）。 */
function labelOf(conv: Conversation | undefined): { name: string; avatar?: string } {
  if (!conv) return { name: "已失效会话", avatar: undefined };
  if (conv.type === "direct") return { name: conv.peer.displayName, avatar: conv.peer.avatar };
  if (conv.type === "agent") {
    return { name: conv.agent.name, avatar: conv.agent.avatar ?? undefined };
  }
  return { name: conv.name, avatar: undefined };
}

/**
 * 聊天页上方横向标签栏：记录当前打开过的会话，点标签即切换。
 *
 * 为什么标题/头像从 conversations 实时取而不是存进标签：
 * 群名与会话对象都会变（改名、成员数变化），标签里存快照会留下过期文字。
 * 标签只存 id，一切显示字段按当前数据渲染。
 *
 * 会话已从服务端消失（被删/退出群）时标签显示为「已失效」而不是整个崩掉——
 * 点了会由 openConversation 正常处理（ChatPage 取不到会话就走空态）。
 */
export function ConversationTabs() {
  const conversations = useChatStore((s) => s.conversations);
  const loadWorkspace = useChatStore((s) => s.loadWorkspace);
  const openTabs = useUiStore((s) => s.openTabs);
  const activeId = useUiStore((s) => s.activeConversationId);
  const openConversation = useUiStore((s) => s.openConversation);
  const closeConversationTab = useUiStore((s) => s.closeConversationTab);

  // 草稿落盘后刷新标签（版本号变化触发重渲染；不订阅具体内容）。
  // 必须在下面的 early return 之前调用——hooks 顺序不能因空标签而变。
  useSyncExternalStore(subscribeDrafts, draftsVersion, () => 0);

  /**
   * 归档：从日常视野里收起来，可在「归档」页恢复。
   *
   * 顺序是「先归档成功再关标签」——反过来的话一旦请求失败，标签没了但会话
   * 还在列表里，用户会以为归档成功了。
   */
  const doArchive = async (id: string, name: string) => {
    try {
      await archiveConversation(id, true);
      closeConversationTab(id);
      // 全量刷新：归档状态在服务端，本地只改一条容易与其它字段脱节
      await loadWorkspace();
    } catch (err) {
      // 归档失败是增强功能的失败，不该静默——用户点了没反应会怀疑界面坏了
      window.alert(`归档「${name}」失败：${(err as Error).message}`);
    }
  };

  if (openTabs.length === 0) return null;

  return (
    <div
      className="flex shrink-0 items-stretch gap-1 overflow-x-auto border-b border-line-soft bg-[#fcfcfc] px-2 pt-1.5"
      role="tablist"
      aria-label="已打开的会话"
    >
      {openTabs.map((id) => {
        const conv = conversations.find((c) => c.id === id);
        const { name, avatar } = labelOf(conv);
        const unread = conv?.unreadCount ?? 0;
        const draft = hasDraft(id);
        const active = id === activeId;
        return (
          <div
            key={id}
            role="tab"
            aria-selected={active}
            aria-label={`${name}${unread > 0 ? ` ${unread} 条未读` : ""}${draft ? " 有草稿" : ""}`}
            tabIndex={active ? 0 : -1}
            onKeyDown={(e) => {
              // 左右方向键在标签间移动焦点（标准 tablist 键盘约定）
              if (e.key !== "ArrowLeft" && e.key !== "ArrowRight") return;
              e.preventDefault();
              const dir = e.key === "ArrowRight" ? 1 : -1;
              const next = openTabs[(openTabs.indexOf(id) + dir + openTabs.length) % openTabs.length];
              if (next) {
                openConversation(next);
                document.getElementById(`tab-${next}`)?.focus();
              }
            }}
            className={`group relative flex max-w-[168px] shrink-0 cursor-pointer items-center gap-1.5 rounded-t-lg border border-b-0 px-2.5 py-1.5 text-[12px] transition-colors ${
              active
                ? "border-line-soft bg-white font-bold text-ink"
                : "border-transparent text-muted hover:bg-[#f4f4f4]"
            }`}
          >
            <button
              id={`tab-${id}`}
              type="button"
              onClick={() => openConversation(id)}
              className="flex min-w-0 flex-1 items-center gap-1.5 text-left"
              aria-label={`切换到 ${name}`}
            >
              <Avatar user={{ displayName: name, avatar }} size={15} className="shrink-0" />
              <span className="truncate">{name}</span>
              {draft && (
                <span
                  aria-hidden="true"
                  title="有草稿"
                  className="h-1.5 w-1.5 shrink-0 rounded-full bg-[#b45309]"
                />
              )}
              {unread > 0 && (
                <span
                  aria-hidden="true"
                  className="min-w-[15px] shrink-0 rounded-full bg-ink px-1 text-center text-[9px] font-semibold leading-[14px] text-white"
                >
                  {unread > 99 ? "99+" : unread}
                </span>
              )}
            </button>
            <button
              type="button"
              aria-label={`归档 ${name}`}
              title="归档（可在「归档」页恢复）"
              onClick={(e) => {
                e.stopPropagation();
                void doArchive(id, name);
              }}
              className="shrink-0 rounded px-1 text-[11px] leading-none text-[#c4c4c4] opacity-0 transition-opacity hover:bg-[#eaeaea] hover:text-[#666] focus:opacity-100 group-hover:opacity-100"
            >
              ↓
            </button>
            <button
              type="button"
              aria-label={`关闭 ${name} 标签`}
              onClick={(e) => {
                // 停止冒泡：否则关闭会连带触发外层的切换（点了「×」却跳进那个会话）
                e.stopPropagation();
                closeConversationTab(id);
              }}
              className="shrink-0 rounded px-1 text-[13px] leading-none text-[#c4c4c4] opacity-0 transition-opacity hover:bg-[#eaeaea] hover:text-[#666] focus:opacity-100 group-hover:opacity-100"
            >
              ×
            </button>
          </div>
        );
      })}
    </div>
  );
}