import { useMemo } from "react";
import { useChatStore } from "../../store/chat.js";
import { useUiStore } from "../../store/ui.js";
import { Avatar } from "../Avatar.js";
import { FOCUS_RING } from "../../lib/a11y/focus.js";

/**
 * 首页「最近对话」（d.84）：日活用户打开主页的第一诉求是接着上次干。
 *
 * 以前这里是「智能体动态」——列出三个智能体的名字与简介，整块不可点，
 * 和智能体页左栏完全重复。现在换成「最近对话」：按最后消息时间取前 3 个会话，
 * 点一下直接进那个会话（d.83 的阅读位置恢复会接着上次的位置）。
 *
 * 只看会话元数据（名称/时间/未读数）——不读消息正文，首页不承担解密成本。
 */

function fmtRelative(iso: string | null | undefined, now = Date.now()): string {
  if (!iso) return "";
  const at = Date.parse(iso);
  if (!Number.isFinite(at)) return "";
  const diff = Math.max(0, now - at);
  if (diff < 60_000) return "刚刚";
  if (diff < 3_600_000) return `${Math.floor(diff / 60_000)} 分钟前`;
  if (diff < 86_400_000) return `${Math.floor(diff / 3_600_000)} 小时前`;
  if (diff < 7 * 86_400_000) return `${Math.floor(diff / 86_400_000)} 天前`;
  const d = new Date(at);
  return `${d.getMonth() + 1}-${d.getDate()}`;
}

export function RecentConversations() {
  const conversations = useChatStore((s) => s.conversations);
  const openConversation = useUiStore((s) => s.openConversation);
  const setPage = useUiStore((s) => s.setPage);

  const recent = useMemo(
    () =>
      [...conversations]
        .sort((a, b) => {
          const at = a.lastMessageAt ? Date.parse(a.lastMessageAt) : 0;
          const bt = b.lastMessageAt ? Date.parse(b.lastMessageAt) : 0;
          return bt - at;
        })
        .slice(0, 3),
    [conversations],
  );

  return (
    // d.138：h-full 让这张卡与左栏「团队动向」底边齐平——首页两栏此前顶对齐、
    // 右卡内容少时底边差出一截，看起来像布局没做完。
    <section aria-label="最近对话" className="ui-card h-full p-3">
      <div className="mb-1.5 flex items-center justify-between">
        <div className="text-[12px] font-bold text-muted">最近对话</div>
        <button type="button" className="ui-link" onClick={() => setPage("chat")}>
          全部智能体
        </button>
      </div>
      {recent.length === 0 ? (
        <div className="flex flex-col items-start gap-1.5 py-1">
          <p className="ui-caption">还没有对话。挑一个智能体，把它当成同事来用。</p>
          <button
            type="button"
            className="ui-btn ui-btn-sm ui-btn-ghost"
            onClick={() => setPage("chat")}
          >
            去智能体页
          </button>
        </div>
      ) : (
        <ul className="flex flex-col">
          {recent.map((conv) => {
            // d.128 起会话有名字：首页与智能体页左栏同一口径——一级是会话名，副行才是智能体 + 时间。
            const title = (conv.title ?? "").trim() || conv.agent.name;
            const timeText = conv.lastMessageAt ? fmtRelative(conv.lastMessageAt) : "还没有消息";
            const meta = title === conv.agent.name ? timeText : `${conv.agent.name} · ${timeText}`;
            return (
            <li key={conv.id}>
              <button
                type="button"
                aria-label={`继续与 ${conv.agent.name} 的对话：${title}`}
                onClick={() => openConversation(conv.id)}
                className={`flex w-full items-center gap-2 rounded-lg px-1.5 py-1.5 text-left transition-colors hover:bg-[var(--subtle-2)] ${FOCUS_RING}`}
              >
                <Avatar
                  user={{ displayName: conv.agent.name, avatar: conv.agent.avatar ?? undefined }}
                  size={22}
                />
                <span className="min-w-0 flex-1">
                  <span className="block truncate text-[12px] font-medium">{title}</span>
                  <span className="block truncate ui-caption">{meta}</span>
                </span>
                {conv.unreadCount > 0 ? (
                  <span className="shrink-0 rounded-full bg-[var(--danger)] px-1.5 text-[10px] font-semibold text-white">
                    {conv.unreadCount > 99 ? "99+" : conv.unreadCount}
                  </span>
                ) : null}
              </button>
            </li>
            );
          })}
        </ul>
      )}
    </section>
  );
}
