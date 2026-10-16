import { Fragment, useEffect, useRef, useState } from "react";
import { useChatStore } from "../store/chat.js";
import { useUiStore } from "../store/ui.js";
import { useAuthStore } from "../store/auth.js";
import { fetchMessages, fetchMembers } from "../lib/api.js";
import { connectWs, type WsHandle } from "../lib/ws.js";
import { ChevronIcon } from "./icons.js";
import { Avatar } from "./Avatar.js";
import { MentionPicker, type MentionItem } from "./MentionPicker.js";

/** 正则转义：mention 名按字面量匹配（名字可含 . * + 等元字符）。 */
const escapeRegExp = (s: string) => s.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");

/**
 * 气泡文本 mentions 高亮（M3 Task 7）：按各 name 在 text 中的出现位置 split 拆分——
 * 命中段包浅蓝 chip span，其余段为 Fragment 纯文本节点（React 文本输出天然转义，防注入）。
 * 名字按长度降序参与 alternation，防「小鸣」吃掉「和小鸣」的前缀；无 mentions 时原样单节点。
 */
export function renderTextWithMentions(
  text: string,
  mentions?: { agentId: string; name: string }[],
): JSX.Element[] {
  const names = [...new Set((mentions ?? []).map((m) => m.name).filter((n) => n.length > 0))].sort(
    (a, b) => b.length - a.length,
  );
  if (names.length === 0) return [<Fragment key="t0">{text}</Fragment>];
  const re = new RegExp(`(${names.map(escapeRegExp).join("|")})`, "g");
  return text.split(re).map((part, i) =>
    part !== "" && names.includes(part) ? (
      <span key={i} className="rounded bg-[#eef3f8] px-0.5">
        {part}
      </span>
    ) : (
      <Fragment key={i}>{part}</Fragment>
    ),
  );
}

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
  /** @ 选择器：null=关；via 区分按钮/键入 token（键入选中后锁到 token 消失，防草稿未变时每击键重弹）。 */
  const [picker, setPicker] = useState<{ via: "button" | "token"; query: string } | null>(null);
  /** 已选 mention（输入栏下 chip）：与草稿文本解耦，发送时非空才进 payload.mentions。 */
  const [selectedMentions, setSelectedMentions] = useState<{ agentId: string; name: string }[]>(
    [],
  );
  const [tokenLock, setTokenLock] = useState(false);
  /**
   * 群成员挂载快照（带 convId 防跨会话串数据）：
   * byId = id→名（他人气泡署名，M2 消息体无 senderName）；
   * agents = kind=agent 行 → @ 选择器候选（**只认本会话群 members**，评审 F1——跨群 join 视图不作数）。
   */
  const [groupMembers, setGroupMembers] = useState<{
    convId: string;
    byId: Record<string, string>;
    agents: MentionItem[];
  } | null>(null);
  const wsHandleRef = useRef<WsHandle | null>(null);
  const bottomRef = useRef<HTMLDivElement | null>(null);

  // conversations 为联合类型（M2）：仅 direct 有 peer；群显群名+人数
  const conv = conversations.find((c) => c.id === convId);
  const peer = conv?.type === "direct" ? conv.peer : undefined;
  const memberNameById = groupMembers?.convId === convId ? groupMembers.byId : undefined;
  /** 本会话群的 @ 候选：只认本群 members 的 agent 行（评审 F1；快照未落定/失败则空）。 */
  const mentionCandidates = groupMembers?.convId === convId ? groupMembers.agents : [];
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
  const isGroup = conv?.type === "group";
  /** 选择器条目：剔除已选（防重复 chip）+ 按 token query 过滤（空串=全量）。 */
  const pickerItems = mentionCandidates.filter(
    (a) =>
      !selectedMentions.some((m) => m.agentId === a.id) &&
      a.name.toLowerCase().includes((picker?.query ?? "").toLowerCase()),
  );

  // 切会话清 @ 选择态：chip/picker/锁都是会话级（ChatPage 常驻不重挂），防跨会话带出 mentions
  useEffect(() => {
    setSelectedMentions([]);
    setPicker(null);
    setTokenLock(false);
  }, [convId]);

  useEffect(() => {
    void fetchMessages(convId).then((msgs) => setMessages(convId, msgs));
  }, [convId, setMessages]);

  // 挂载拉本会话已读态（direct 气泡「已读」依赖；失败不阻断会话）
  useEffect(() => {
    void loadReads(convId).catch(() => {
      /* 已读是增强信息：拉取失败静默降级（无「已读」标记） */
    });
  }, [convId, loadReads]);

  // 群会话挂载拉一次成员表：id→名（气泡署名）+ agent 行（@ 候选，本会话群口径）；direct 走 peer.displayName
  useEffect(() => {
    if (conv?.type !== "group") return;
    let alive = true;
    void fetchMembers(convId)
      .then((list) => {
        if (!alive) return;
        setGroupMembers({
          convId,
          byId: Object.fromEntries(list.map((m) => [m.id, m.name])),
          agents: list
            .filter((m) => m.kind === "agent")
            .map((m) => ({ id: m.id, name: m.name, avatar: m.avatar })),
        });
      })
      .catch(() => {
        /* 成员缺失仅影响署名与 @ 候选，不阻断会话 */
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

  /** 键入触发：草稿尾随 @token（空格一断 token 即结束）→ 过滤弹选择器；direct 不触发。 */
  const onDraftChange = (value: string) => {
    setDraft(value);
    if (!isGroup) return;
    const token = /@([^\s@]*)$/.exec(value);
    if (token) {
      if (!tokenLock) setPicker({ via: "token", query: token[1] });
    } else {
      if (tokenLock) setTokenLock(false);
      // token 触发的选择器随 token 消失关闭；按钮开的保留（靠 Esc/发送关）
      setPicker((p) => (p?.via === "token" ? null : p));
    }
  };

  const pickMention = (item: MentionItem) => {
    setSelectedMentions((prev) =>
      prev.some((m) => m.agentId === item.id)
        ? prev
        : [...prev, { agentId: item.id, name: item.name }],
    );
    // 键入路径：草稿保持原样（@token 还在），锁住到 token 消失，否则继续输入会每击键重弹
    if (picker?.via === "token") setTokenLock(true);
    setPicker(null);
  };

  const onInputKeyDown = (e: React.KeyboardEvent<HTMLInputElement>) => {
    if (e.key === "Escape" && picker) {
      e.preventDefault();
      setPicker(null);
      setTokenLock(false); // Esc 关闭同步解锁：后续键入可重开（否则旧锁卡住 token 路径）
    }
  };

  const send = (e: React.FormEvent) => {
    e.preventDefault();
    const text = draft.trim();
    if (!text) return;
    const handle = wsHandleRef.current;
    if (!handle) {
      // 保留草稿与已选 mention，给出可见提示（不静默丢弃）
      setSendNotice("连接未就绪，消息未发送");
      return;
    }
    handle.send({
      type: "send_message",
      conversationId: convId,
      payload: {
        text,
        // mentions 非空才带（空则整个键不出现，与 M2 消息形状一致）
        ...(selectedMentions.length ? { mentions: selectedMentions } : {}),
      },
    });
    setDraft("");
    setSelectedMentions([]);
    setPicker(null);
    setTokenLock(false);
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
                {renderTextWithMentions(m.payload.text, m.payload.mentions)}
                {readByPeer ? (
                  <div className="mt-0.5 text-right text-[9px] text-muted">已读</div>
                ) : null}
              </div>
            </div>
          );
        })}
        <div ref={bottomRef} />
      </div>
      <form onSubmit={send} className="relative border-t border-line-soft">
        {sendNotice && (
          <p role="status" className="px-5 pt-2 text-[12px] text-[#b45309]">
            {sendNotice}
          </p>
        )}
        {/* @ 选择器：输入栏上方浮层（仅群会话；direct 无智能体可提及） */}
        {isGroup && picker && <MentionPicker items={pickerItems} onPick={pickMention} />}
        <div className="flex gap-2 px-5 py-3">
          {isGroup && (
            <button
              type="button"
              aria-label="提及智能体"
              className="shrink-0 rounded-lg border border-line px-2.5 text-sm text-muted hover:bg-[#f3f3f3]"
              onClick={() => setPicker({ via: "button", query: "" })}
            >
              @
            </button>
          )}
          <input
            className="flex-1 rounded-lg border border-line px-3 py-2 text-sm outline-none focus:border-[#bbb]"
            placeholder="输入消息…"
            value={draft}
            onChange={(e) => onDraftChange(e.target.value)}
            onKeyDown={onInputKeyDown}
          />
          <button
            type="submit"
            className="rounded-lg bg-ink px-4 py-2 text-sm font-bold text-white"
          >
            发送
          </button>
        </div>
        {/* 已选 mention chip（输入栏下方）：× 移除；文本保持原样不注入草稿 */}
        {selectedMentions.length > 0 && (
          <div className="flex flex-wrap gap-2 px-5 pb-3">
            {selectedMentions.map((m) => (
              <span
                key={m.agentId}
                className="inline-flex items-center gap-1 rounded-full border border-line bg-[#f3f3f3] py-0.5 pl-2 pr-1 text-[12px]"
              >
                @{m.name}
                <button
                  type="button"
                  aria-label={`移除 ${m.name}`}
                  className="rounded-full px-1 text-muted hover:text-ink"
                  onClick={() =>
                    setSelectedMentions((prev) => prev.filter((x) => x.agentId !== m.agentId))
                  }
                >
                  ×
                </button>
              </span>
            ))}
          </div>
        )}
      </form>
    </div>
  );
}
