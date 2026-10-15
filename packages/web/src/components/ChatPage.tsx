import { useEffect, useRef, useState } from "react";
import { useChatStore } from "../store/chat.js";
import { useUiStore } from "../store/ui.js";
import { useAuthStore } from "../store/auth.js";
import { fetchMessages, fetchMembers } from "../lib/api.js";
import { connectWs, type WsHandle } from "../lib/ws.js";
import { ChevronIcon } from "./icons.js";
import { Avatar } from "./Avatar.js";

export function ChatPage() {
  const convId = useUiStore((s) => s.activeConversationId)!;
  const leave = useUiStore((s) => s.leaveConversation);
  const conversations = useChatStore((s) => s.conversations);
  const messages = useChatStore((s) => s.messages[convId] ?? []);
  const setMessages = useChatStore((s) => s.setMessages);
  const appendMessage = useChatStore((s) => s.appendMessage);
  const reads = useChatStore((s) => s.reads);
  const loadReads = useChatStore((s) => s.loadReads);
  const me = useAuthStore((s) => s.user);
  const [draft, setDraft] = useState("");
  const [sendNotice, setSendNotice] = useState<string | null>(null);
  const [connected, setConnected] = useState(false);
  /** 群成员 id→名映射：M2 消息体无 senderName，挂载时拉一次 members 建表（带 convId 防跨会话串名）。 */
  const [memberNames, setMemberNames] = useState<{
    convId: string;
    byId: Record<string, string>;
  } | null>(null);
  const wsHandleRef = useRef<WsHandle | null>(null);
  const bottomRef = useRef<HTMLDivElement | null>(null);

  // conversations 为联合类型（M2）：仅 direct 有 peer；群显群名+人数
  const conv = conversations.find((c) => c.id === convId);
  const peer = conv?.type === "direct" ? conv.peer : undefined;
  const memberNameById = memberNames?.convId === convId ? memberNames.byId : undefined;
  // 仅 direct 有「已读」：取对方（peer）在本会话的读点；ISO 时间戳同构（…Z），字符串比较即时间序
  const peerReadAt =
    conv?.type === "direct"
      ? reads[convId]?.find((r) => r.userId === conv.peer.id)?.at
      : undefined;
  const headerTitle = conv
    ? conv.type === "direct"
      ? conv.peer.displayName
      : `${conv.name}（${conv.memberCount} 人）`
    : "会话";

  useEffect(() => {
    void fetchMessages(convId).then((msgs) => setMessages(convId, msgs));
  }, [convId, setMessages]);

  // 挂载拉本会话已读态（direct 气泡「已读」依赖；失败不阻断会话）
  useEffect(() => {
    void loadReads(convId).catch(() => {
      /* 已读是增强信息：拉取失败静默降级（无「已读」标记） */
    });
  }, [convId, loadReads]);

  // 群会话挂载拉一次成员表建 id→名字映射（他人气泡发送者名；direct 走 peer.displayName）
  useEffect(() => {
    if (conv?.type !== "group") return;
    let alive = true;
    void fetchMembers(convId)
      .then((list) => {
        if (!alive) return;
        setMemberNames({
          convId,
          byId: Object.fromEntries(list.map((m) => [m.id, m.name])),
        });
      })
      .catch(() => {
        /* 成员名缺失仅影响气泡署名，不阻断会话 */
      });
    return () => {
      alive = false;
    };
  }, [convId, conv?.type]);

  useEffect(() => {
    const handle = connectWs({
      onEvent: (e) => {
        if (e.type === "message_new" && e.message.conversationId === convId) {
          appendMessage(e.message);
          // 会话内正在看的新消息即时标记已读：否则退出后 loadWorkspace 会把已读内容算作未读
          if (e.message.senderId !== useAuthStore.getState().user?.id) {
            wsHandleRef.current?.send({ type: "mark_read", conversationId: convId });
          }
        } else if (e.type === "read_update" && e.conversationId === convId) {
          // 事件只带 userId/at：整表重拉（读数很小），direct 气泡「已读」随动；他会话忽略
          void loadReads(convId).catch(() => {
            /* 同挂载期降级：拉取失败保留旧读态 */
          });
        } else if (e.type === "error") {
          console.warn(`[${e.code}] ${e.message}`);
        }
      },
      onOpen: () => {
        setConnected(true);
        // 断线重连成功：补拉断档消息（setMessages 是合并去重语义，幂等）
        void fetchMessages(convId).then((msgs) => setMessages(convId, msgs));
      },
      onClose: () => setConnected(false),
    });
    wsHandleRef.current = handle;
    // 进会话即报已读（有未读才发；send 在未连通时入队，连接后随首帧冲刷）。
    // 经 getState 读，避免把 conversations 放进依赖导致 WS 随列表刷新重连
    const unread = useChatStore
      .getState()
      .conversations.find((c) => c.id === convId)?.unreadCount ?? 0;
    if (unread > 0) {
      handle?.send({ type: "mark_read", conversationId: convId });
    }
    return () => {
      handle?.close();
      wsHandleRef.current = null;
    };
  }, [convId, appendMessage, setMessages, loadReads]);

  useEffect(() => {
    bottomRef.current?.scrollIntoView({ behavior: "smooth" });
  }, [messages.length]);

  const send = (e: React.FormEvent) => {
    e.preventDefault();
    const text = draft.trim();
    if (!text) return;
    const handle = wsHandleRef.current;
    if (!handle) {
      // 保留草稿，给出可见提示（不静默丢弃）
      setSendNotice("连接未就绪，消息未发送");
      return;
    }
    handle.send({
      type: "send_message",
      conversationId: convId,
      payload: { text },
    });
    setDraft("");
    setSendNotice(null);
  };

  return (
    <div className="flex h-full flex-col">
      <header className="flex items-center gap-2 border-b border-line-soft px-5 py-3">
        <button
          type="button"
          aria-label="返回"
          className="rounded p-1 text-muted hover:bg-[#f3f3f3]"
          onClick={leave}
        >
          <ChevronIcon width={15} height={15} className="rotate-180" />
        </button>
        <span className="text-[14px] font-bold">{headerTitle}</span>
        <span className="text-[12px] text-muted">{connected ? "已连接" : "连接中…"}</span>
      </header>
      <div className="flex-1 overflow-y-auto px-5 py-4">
        {messages.map((m) => {
          const mine = m.senderId === me?.id;
          // 署名：自己「我」；direct 对方名；群内他人用挂载时拉到的成员映射名（缺失则不渲染署名行）
          const senderName = mine
            ? "我"
            : conv?.type === "direct"
              ? peer?.displayName
              : memberNameById?.[m.senderId];
          // 仅 direct：对方读点 ≥ 本条时间 → 已读（逐条判断；群 M2 不显示）
          const readByPeer = mine && !!peerReadAt && peerReadAt >= m.createdAt;
          return (
            <div
              key={m.id}
              className={`mb-3 flex ${mine ? "justify-end" : "items-start gap-2"}`}
            >
              {/* 对方消息：左侧头像（无 avatar 首字回退）；自己的消息不显示头像 */}
              {!mine && peer && <Avatar user={peer} size={22} className="mt-0.5" />}
              <div
                className={`max-w-[70%] rounded-lg border border-line px-3 py-2 text-[13px] shadow-card ${
                  mine ? "bg-white" : "bg-[#f7f7f7]"
                }`}
              >
                {senderName ? (
                  <div className="mb-0.5 text-[10px] text-muted">{senderName}</div>
                ) : null}
                {m.payload.text}
                {readByPeer ? (
                  <div className="mt-0.5 text-right text-[9px] text-muted">已读</div>
                ) : null}
              </div>
            </div>
          );
        })}
        <div ref={bottomRef} />
      </div>
      <form onSubmit={send} className="border-t border-line-soft">
        {sendNotice && (
          <p role="status" className="px-5 pt-2 text-[12px] text-[#b45309]">
            {sendNotice}
          </p>
        )}
        <div className="flex gap-2 px-5 py-3">
          <input
            className="flex-1 rounded-lg border border-line px-3 py-2 text-sm outline-none focus:border-[#bbb]"
            placeholder="输入消息…"
            value={draft}
            onChange={(e) => setDraft(e.target.value)}
          />
          <button
            type="submit"
            className="rounded-lg bg-ink px-4 py-2 text-sm font-bold text-white"
          >
            发送
          </button>
        </div>
      </form>
    </div>
  );
}
