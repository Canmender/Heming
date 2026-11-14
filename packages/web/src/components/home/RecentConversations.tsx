import { useMemo } from "react";
import { useChatStore } from "../../store/chat.js";
import { useUiStore } from "../../store/ui.js";
import { Avatar } from "../Avatar.js";
import { FOCUS_RING } from "../../lib/a11y/focus.js";
import { Button } from "../../components/ui/Button.js";

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

export function RecentConversations({
  /**
   * 首跑引导卡在场时隐藏空态占位（d.141）。
   *
   * 首页首屏上，「开始使用 0/3」和「还没有对话 → 去智能体页」是同一个下一步：
   * 两块并排劝同一件事，用户只会觉得首页在重复说话。引导卡负责劝，这里整块不出现；
   * 有会话时照常显示（列表本身就是「继续上次」，与引导不冲突）。
   */
  hideWhenEmpty = false,
}: {
  hideWhenEmpty?: boolean;
} = {}) {
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

  // 引导卡在场 + 没有会话：让引导成为首屏唯一的「下一步」。
  if (hideWhenEmpty && recent.length === 0) return null;

  return (
    // d.138：h-full 让这张卡与左栏「团队动向」底边齐平——首页两栏此前顶对齐、
    // 右卡内容少时底边差出一截，看起来像布局没做完。
    <section aria-label="最近对话" className="ui-card h-full p-3">
      <div className="mb-2 flex items-center justify-between">
        <div className="text-ui-sm font-semibold text-muted">最近对话</div>
        <button type="button" className="ui-link ui-hit" onClick={() => setPage("chat")}>
          全部智能体
        </button>
      </div>
      {recent.length === 0 ? (
        <div className="flex flex-col items-start gap-2 py-2">
          {/* 空态 = 标题 + 一个行动（d.142）：不再解释「智能体可以当同事用」——
              标题已经说清缺什么，按钮已经给出下一步。 */}
          <p className="ui-caption">还没有对话</p>
          <Button
            type="button"
            size="sm" variant="ghost"
            onClick={() => setPage("chat")}
          >
            去智能体页
          </Button>
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
                className={`flex w-full items-center gap-2 rounded-lg px-2 py-2 text-left transition-colors hover:bg-subtle-2 ${FOCUS_RING}`}
              >
                <Avatar
                  user={{ displayName: conv.agent.name, avatar: conv.agent.avatar ?? undefined }}
                  size={22}
                />
                <span className="min-w-0 flex-1">
                  <span className="block truncate text-ui-sm font-medium">{title}</span>
                  <span className="block truncate ui-caption">{meta}</span>
                </span>
                {conv.unreadCount > 0 ? (
                  <span className="shrink-0 rounded-full bg-danger px-2 text-ui-xs font-semibold text-danger-on">
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
