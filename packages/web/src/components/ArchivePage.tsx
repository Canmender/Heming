import { useEffect, useMemo, useState } from "react";
import type { Conversation } from "@heming/shared";
import { archiveConversation } from "../lib/api.js";
import { useChatStore } from "../store/chat.js";
import { useUiStore } from "../store/ui.js";
import { convLabel } from "./ChatPage.js";
import { Avatar } from "./Avatar.js";

/**
 * 归档处：存放已收起的会话。
 *
 * ## 为什么单独一页而不是在会话列表里折叠
 *
 * 会话列表是「现在要处理的事」，归档是「以后可能要翻的事」——两种意图。
 * 混在一个列表里，要么归档区占着注意力，要么折叠后根本想不起来去点。
 * 单独成页还有个附带好处：这里是天然的检索入口，找旧对话不必先想起它在哪。
 *
 * ## 归档状态是「我」的，不是会话的
 *
 * 服务端把它存在成员关系上（见 `store.setConversationArchived`），
 * 所以群聊里我归档了，别人照常在列表里看到——这里展示的也只是**我**归档的那些。
 *
 * ## 搜索为什么在这里
 *
 * 归档页的典型用法就是「找一个我记得存在、但不记得在哪的对话」。
 * 先做成本地按名字过滤：数据都已经在前端（会话列表本来就要拉全量），
 * 不需要额外接口；消息内容级的全文检索是另一件事（要索引、要按会话分页拉），
 * 留到后面单独做，别把这一页拖成半成品。
 */

/** 归档时间的展示：只到日期，归档页不需要精确到秒。 */
function archiveDay(iso: string): string {
  const d = new Date(iso);
  if (Number.isNaN(d.getTime())) return "";
  const pad = (n: number) => String(n).padStart(2, "0");
  return `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())}`;
}

export function ArchivePage() {
  const conversations = useChatStore((s) => s.conversations);
  const loadWorkspace = useChatStore((s) => s.loadWorkspace);
  const workspaceReady = useChatStore((s) => s.workspaceReady);
  const workspaceError = useChatStore((s) => s.workspaceError);
  const openConversation = useUiStore((s) => s.openConversation);

  const [query, setQuery] = useState("");
  const [busyId, setBusyId] = useState<string | null>(null);
  const [notice, setNotice] = useState<string | null>(null);

  // 自己拉一次：归档页不依赖「先经过主页」这个前提。
  // 别人可能在另一台设备归档过，每次进入都以服务端为准。
  // 失败不再静默：store 的 workspaceReady/workspaceError 会驱动下面的重试条，
  // 否则「拉取失败」和「确实没有归档」会长得一模一样。
  useEffect(() => {
    void loadWorkspace().catch(() => {});
  }, [loadWorkspace]);

  const retryWorkspace = () => {
    void loadWorkspace().catch(() => {});
  };

  const archived = useMemo(() => {
    const rows = conversations
      .filter((c): c is Conversation & { archivedAt: string } => Boolean(c.archivedAt))
      // 最近归档的排前面：刚收起来的东西最可能是要找的
      .sort((a, b) => b.archivedAt.localeCompare(a.archivedAt));
    const keyword = query.trim().toLowerCase();
    if (!keyword) return rows;
    return rows.filter((c) => convLabel(c).name.toLowerCase().includes(keyword));
  }, [conversations, query]);

  const total = conversations.filter((c) => c.archivedAt).length;

  const restore = async (conv: Conversation) => {
    if (busyId) return;
    setBusyId(conv.id);
    setNotice(null);
    try {
      await archiveConversation(conv.id, false);
      // 刷新整份列表：归档状态是服务端权威，本地改单条容易与其它字段
      //（未读数、成员数）不同步，而这里的数据量很小，全量拉一次更稳
      await loadWorkspace();
    } catch (err) {
      setNotice(`恢复失败：${(err as Error).message}`);
    } finally {
      setBusyId(null);
    }
  };

  return (
    <div className="flex h-full min-h-0 flex-col">
      <div className="flex items-center justify-between gap-3 border-b border-line-soft px-5 py-2.5">
        <div className="flex items-baseline gap-2">
          <span className="text-[13px] font-bold">归档</span>
          <span className="text-[11px] text-muted">
            {!workspaceReady ? "加载中…" : total > 0 ? `${total} 个已归档会话` : "暂无归档"}
          </span>
        </div>
        <input
          aria-label="搜索归档会话"
          value={query}
          onChange={(e) => setQuery(e.target.value)}
          placeholder="搜索名称…"
          className="w-[200px] rounded-lg border border-line bg-white px-2.5 py-1 text-[12px] outline-none placeholder:text-[#bbb] focus:border-[#c9c9c9]"
        />
      </div>

      {notice ? (
        <div role="status" className="px-5 pt-2 text-[12px] text-[#b45309]">
          {notice}
        </div>
      ) : null}

      <div className="min-h-0 flex-1 overflow-y-auto px-5 py-3">
        {!workspaceReady ? (
          workspaceError ? (
            <div role="alert" className="mt-16 flex flex-col items-center gap-2 text-center text-[12px]">
              <p className="text-[#b42318]">加载失败：{workspaceError}</p>
              <button
                type="button"
                onClick={retryWorkspace}
                className="rounded-md border border-[#e6e6e6] px-2.5 py-1 text-[11px] hover:bg-[#f7f7f7]"
              >
                重试
              </button>
            </div>
          ) : (
            <div role="status" aria-label="正在加载归档" className="flex flex-col gap-2 py-1.5">
              {[0, 1, 2].map((i) => (
                <div key={i} className="h-12 animate-pulse rounded-lg bg-[#f4f4f4]" />
              ))}
            </div>
          )
        ) : archived.length === 0 ? (
          <div className="mt-16 text-center text-[12px] text-muted">
            {total === 0 ? (
              <>
                <p>还没有归档的会话。</p>
                <p className="mt-1 text-[11px] text-[#aaa]">
                  在会话标签上点「归档」，它会收进这里，随时可以恢复。
                </p>
              </>
            ) : (
              <p>没有匹配「{query}」的归档会话。</p>
            )}
          </div>
        ) : (
          <ul className="flex max-w-[640px] flex-col gap-1">
            {archived.map((c) => {
              const label = convLabel(c);
              const busy = busyId === c.id;
              return (
                <li
                  key={c.id}
                  className="group flex items-center gap-2.5 rounded-lg px-2 py-1.5 hover:bg-[#f7f7f7]"
                >
                  <button
                    type="button"
                    className="flex min-w-0 flex-1 items-center gap-2.5 text-left"
                    aria-label={`打开会话 ${label.name}`}
                    onClick={() => openConversation(c.id)}
                  >
                    <Avatar user={{ displayName: label.name, avatar: label.avatar }} size={32} />
                    <span className="min-w-0 flex-1">
                      <span className="block truncate text-[13px]">{label.name}</span>
                      <span className="block text-[11px] text-muted">
                        {label.group ? "群聊" : c.type === "agent" ? "智能体" : "好友"} · 归档于{" "}
                        {archiveDay(c.archivedAt)}
                      </span>
                    </span>
                  </button>
                  <button
                    type="button"
                    disabled={busy}
                    aria-label={`恢复会话 ${label.name}`}
                    onClick={() => void restore(c)}
                    className="shrink-0 rounded-lg border border-line px-2 py-1 text-[11px] text-muted opacity-0 transition-opacity hover:bg-white focus:opacity-100 disabled:opacity-50 group-hover:opacity-100"
                  >
                    {busy ? "恢复中…" : "恢复"}
                  </button>
                </li>
              );
            })}
          </ul>
        )}
      </div>
    </div>
  );
}