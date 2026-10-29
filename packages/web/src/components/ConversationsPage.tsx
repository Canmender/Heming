import { useEffect, useMemo, useRef, useState, useSyncExternalStore } from "react";
import type { Conversation, Message } from "@heming/shared";
import { archiveConversation } from "../lib/api.js";
import { msgCache } from "../lib/e2eSession.js";
import { useChatStore } from "../store/chat.js";
import { useUiStore } from "../store/ui.js";
import { hasDraft, getDraft, subscribeDrafts, draftsVersion } from "../lib/drafts.js";
import {
  convPrefsVersion,
  isMuted,
  isPinned,
  setMuted,
  setPinned,
  subscribeConvPrefs,
} from "../lib/convPrefs.js";
import { Avatar } from "./Avatar.js";
import { convLabel } from "./ChatPage.js";
import { ArchiveIcon, BellIcon, BellOffIcon, PinIcon, SearchIcon } from "./icons.js";

/** 预览截尾：列表一行只给一个大概，完整正文在会话里。 */
function clipPreview(text: string): string {
  const chars = [...text.replace(/\s+/g, " ").trim()];
  return chars.length > 60 ? `${chars.slice(0, 60).join("")}…` : chars.join("");
}

/** 本机解密缓存里最后一条可展示消息；reaction/chaindist/chunk/error 不算。 */
function cachedPreview(convId: string): { text: string; at: number } | null {
  // peek 而非 list：预览在每次 render/输入时都会调用，不能顺手刷 LRU（会写盘、淘汰别的会话）
  const list = msgCache.peek(convId);
  for (let i = list.length - 1; i >= 0; i -= 1) {
    const p = list[i].plain;
    if (p.kind === "text") return { text: p.text?.trim() || "(空消息)", at: list[i].at };
    if (p.kind === "file") return { text: "(附件)", at: list[i].at };
    if (p.kind === "forward") return { text: p.text?.trim() || "(转发消息)", at: list[i].at };
  }
  return null;
}

function lastLoaded(messages: Record<string, Message[]>, convId: string): Message | undefined {
  const list = messages[convId];
  return list && list.length > 0 ? list[list.length - 1] : undefined;
}

function previewOf(conv: Conversation, messages: Record<string, Message[]>): string {
  const draft = hasDraft(conv.id) ? getDraft(conv.id) : "";
  if (draft) return `草稿：${clipPreview(draft)}`;
  const last = lastLoaded(messages, conv.id);
  if (last) {
    return last.recalledAt != null
      ? "消息已撤回"
      : clipPreview(last.payload.text?.trim() || "(附件)");
  }
  const cached = cachedPreview(conv.id);
  if (cached) return clipPreview(cached.text);
  return conv.lastMessageAt ? "点击查看消息" : "暂无消息";
}

function timeOf(conv: Conversation, messages: Record<string, Message[]>): string {
  // 依次尝试：会话最后消息时间 → 已加载最后一条 → 本机缓存。
  // lastMessageAt 存在但非法（坏数据）时继续回退，而不是直接显示空字符串。
  const candidates: (string | null | undefined)[] = [conv.lastMessageAt];
  const last = lastLoaded(messages, conv.id);
  if (last) candidates.push(last.createdAt);
  const cached = cachedPreview(conv.id);
  if (cached) candidates.push(new Date(cached.at).toISOString());

  let d: Date | null = null;
  for (const iso of candidates) {
    if (!iso) continue;
    const parsed = new Date(iso);
    if (!Number.isNaN(parsed.getTime())) {
      d = parsed;
      break;
    }
  }
  if (!d) return "";
  const now = new Date();
  const hm = `${String(d.getHours()).padStart(2, "0")}:${String(d.getMinutes()).padStart(2, "0")}`;
  const sameDay =
    d.getFullYear() === now.getFullYear() &&
    d.getMonth() === now.getMonth() &&
    d.getDate() === now.getDate();
  return sameDay
    ? hm
    : `${String(d.getMonth() + 1).padStart(2, "0")}-${String(d.getDate()).padStart(2, "0")} ${hm}`;
}

/**
 * 会话中心：全部未归档会话的一站式列表（d.40）。
 *
 * 只读本机数据：会话列表来自 workspace、预览来自已加载消息与本机解密缓存、草稿/偏好在本机。
 * 列表排序是「置顶优先 → lastMessageAt 降序」，缺失时间的排最后、等值保持原序（sort 稳定）。
 */
export function ConversationsPage() {
  const conversations = useChatStore((s) => s.conversations);
  const messages = useChatStore((s) => s.messages);
  const workspaceReady = useChatStore((s) => s.workspaceReady);
  const workspaceError = useChatStore((s) => s.workspaceError);
  const loadWorkspace = useChatStore((s) => s.loadWorkspace);
  const openConversation = useUiStore((s) => s.openConversation);

  // 偏好与草稿变化都要重渲染：排序依赖置顶（prefsVersion 进 memo deps），
  // 预览依赖草稿（订阅本身触发重渲染即可，不必进 memo deps——排序不依赖草稿）。
  const prefsVersion = useSyncExternalStore(subscribeConvPrefs, convPrefsVersion, () => 0);
  useSyncExternalStore(subscribeDrafts, draftsVersion, () => 0);

  const [query, setQuery] = useState("");
  const [busyId, setBusyId] = useState<string | null>(null);
  const [notice, setNotice] = useState<string | null>(null);
  /** 同一 tick 连点两下时 state 尚未刷新，用 ref 立即拦住第二次归档。 */
  const busyRef = useRef(false);

  useEffect(() => {
    void loadWorkspace().catch(() => {});
  }, [loadWorkspace]);

  const rows = useMemo(() => {
    const keyword = query.trim().toLowerCase();
    return conversations
      .filter((c) => !c.archivedAt)
      .filter((c) => !keyword || convLabel(c).name.toLowerCase().includes(keyword))
      .sort((a, b) => {
        const ap = isPinned(a.id) ? 1 : 0;
        const bp = isPinned(b.id) ? 1 : 0;
        if (ap !== bp) return bp - ap;
        const ax = a.lastMessageAt ?? "";
        const bx = b.lastMessageAt ?? "";
        return ax === bx ? 0 : ax < bx ? 1 : -1;
      });
  }, [conversations, query, prefsVersion]);

  const active = conversations.filter((c) => !c.archivedAt);
  const unread = active.reduce((n, c) => n + (c.unreadCount ?? 0), 0);

  const archive = async (conv: Conversation) => {
    if (busyRef.current) return;
    busyRef.current = true;
    setBusyId(conv.id);
    setNotice(null);
    try {
      await archiveConversation(conv.id, true);
      try {
        await loadWorkspace();
      } catch {
        // 归档已成功，只是列表没刷出来：不能报「归档失败」误导用户重复操作
        setNotice("已归档，但列表刷新失败");
      }
    } catch (err) {
      setNotice(`归档失败：${err instanceof Error ? err.message : String(err)}`);
    } finally {
      busyRef.current = false;
      setBusyId(null);
    }
  };

  return (
    <div className="flex h-full flex-col">
      <div className="shrink-0 px-6 pt-5">
        <div className="flex items-baseline justify-between gap-3">
          <h1 className="text-[17px] font-extrabold">会话</h1>
          <span className="text-[11px] text-muted">
            {rows.length} 个会话{unread > 0 ? ` · ${unread} 条未读` : ""}
          </span>
        </div>
        <div className="relative mt-3 max-w-[420px]">
          <SearchIcon
            width={15}
            height={15}
            className="pointer-events-none absolute left-3 top-1/2 -translate-y-1/2 text-[#bbb]"
          />
          <input
            aria-label="搜索会话"
            value={query}
            onChange={(e) => setQuery(e.target.value)}
            placeholder="搜索会话"
            className="w-full rounded-lg border border-line py-1.5 pl-8 pr-3 text-[12px] outline-none focus:border-[#bbb]"
          />
        </div>
        {notice && (
          <div role="alert" className="mt-2 text-[11px] text-red-600">
            {notice}
          </div>
        )}
      </div>

      <div className="min-h-0 flex-1 overflow-y-auto px-6 pb-6 pt-3">
        {rows.length === 0 ? (
          !workspaceReady ? (
            workspaceError ? (
              <div className="py-8 text-center text-[12px] text-muted">
                加载失败：{workspaceError}
                <button
                  type="button"
                  className="ml-2 rounded-lg border border-line px-2 py-0.5 text-[11px] hover:bg-[#fafafa]"
                  onClick={() => void loadWorkspace().catch(() => {})}
                >
                  重试
                </button>
              </div>
            ) : (
              <div className="py-8 text-center text-[12px] text-muted">正在加载会话…</div>
            )
          ) : (
            <div className="py-8 text-center text-[12px] text-muted">
              {query.trim() ? `没有匹配「${query.trim()}」的会话` : "还没有会话，去工作区开始"}
            </div>
          )
        ) : (
          <div className="max-w-[720px] space-y-1">
            {rows.map((c) => {
              const label = convLabel(c);
              const pinned = isPinned(c.id);
              const muted = isMuted(c.id);
              const preview = previewOf(c, messages);
              const time = timeOf(c, messages);
              return (
                <div
                  key={c.id}
                  data-conv-id={c.id}
                  className="group flex items-center gap-2 rounded-xl border border-[#ececec] bg-white px-2.5 py-2 shadow-card transition-colors hover:bg-[#fafafa]"
                >
                  <button
                    type="button"
                    aria-label={`打开会话 ${label.name}${c.unreadCount > 0 ? ` ${c.unreadCount} 条未读` : ""}`}
                    onClick={() => openConversation(c.id)}
                    className="flex min-w-0 flex-1 items-center gap-3 text-left"
                  >
                    <span className="relative shrink-0">
                      <Avatar user={{ displayName: label.name, avatar: label.avatar }} size={32} />
                      {c.unreadCount > 0 && (
                        <span
                          aria-label={`${c.unreadCount} 条未读`}
                          className="absolute -right-1 -top-1 min-w-[16px] rounded-full bg-ink px-1 text-center text-[10px] font-semibold leading-4 text-white"
                        >
                          {c.unreadCount}
                        </span>
                      )}
                    </span>
                    <span className="min-w-0 flex-1">
                      <span className="flex items-center gap-1.5">
                        <span className="truncate text-[13px] font-medium">{label.name}</span>
                        {pinned && (
                          <PinIcon
                            width={12}
                            height={12}
                            className="shrink-0 text-[#b45309]"
                            aria-hidden="true"
                          />
                        )}
                        {muted && (
                          <BellOffIcon
                            width={12}
                            height={12}
                            className="shrink-0 text-[#b45309]"
                            aria-hidden="true"
                          />
                        )}
                      </span>
                      <span className="block truncate text-[11px] text-muted">{preview}</span>
                    </span>
                    <span className="shrink-0 text-[10px] text-muted">{time}</span>
                  </button>

                  <div className="flex shrink-0 items-center gap-1 opacity-0 transition-opacity group-hover:opacity-100 group-focus-within:opacity-100">
                    <button
                      type="button"
                      aria-label={`${pinned ? "取消置顶" : "置顶"} ${label.name}`}
                      title={pinned ? "取消置顶" : "置顶"}
                      onClick={() => setPinned(c.id, !pinned)}
                      className="rounded p-1 text-muted hover:bg-[#f3f3f3]"
                    >
                      <PinIcon width={14} height={14} />
                    </button>
                    <button
                      type="button"
                      aria-label={`${muted ? "取消免打扰" : "免打扰"} ${label.name}`}
                      title={muted ? "取消免打扰" : "免打扰"}
                      onClick={() => setMuted(c.id, !muted)}
                      className="rounded p-1 text-muted hover:bg-[#f3f3f3]"
                    >
                      {muted ? <BellOffIcon width={14} height={14} /> : <BellIcon width={14} height={14} />}
                    </button>
                    <button
                      type="button"
                      aria-label={`归档 ${label.name}`}
                      title="归档"
                      disabled={busyId !== null}
                      onClick={() => void archive(c)}
                      className="rounded p-1 text-muted hover:bg-[#f3f3f3] disabled:opacity-40"
                    >
                      <ArchiveIcon width={14} height={14} />
                    </button>
                  </div>
                </div>
              );
            })}
          </div>
        )}
      </div>
    </div>
  );
}
