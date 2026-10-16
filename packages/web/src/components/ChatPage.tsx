import { Fragment, useEffect, useRef, useState } from "react";
import { useChatStore } from "../store/chat.js";
import { useUiStore } from "../store/ui.js";
import { useAuthStore } from "../store/auth.js";
import { useLlmStore } from "../store/llm.js";
import { fetchMessages, fetchMembers } from "../lib/api.js";
import { streamChat } from "../lib/llmClient.js";
import { runAgentMentions, type TriggerDeps } from "../lib/agentStream.js";
import { connectWs, type WsHandle } from "../lib/ws.js";
import { ChevronIcon } from "./icons.js";
import { Avatar } from "./Avatar.js";
import { MentionPicker, type MentionItem } from "./MentionPicker.js";
import { AgentStreamBubble } from "./AgentStreamBubble.js";

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
  const streaming = useChatStore((s) => s.streaming);
  const streamOwner = useChatStore((s) => s.streamOwner);
  const upsertStream = useChatStore((s) => s.upsertStream);
  const removeStream = useChatStore((s) => s.removeStream);
  const markStreamOwner = useChatStore((s) => s.markStreamOwner);
  const clearStreamsForConversation = useChatStore((s) => s.clearStreamsForConversation);
  const agentsRoster = useChatStore((s) => s.agentsRoster);
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
  /** 触发句柄（convId → 集合）：「中断」只 abort 当前会话的流；卸载时全部中止（关页不空烧 token）。 */
  const runsRef = useRef<Record<string, Set<{ abortAll(): void }>>>({});
  /** 本机流元数据（streamId → 触发上下文）：onLocalDelta 回填 agentId、重试取原触发文本。 */
  const streamMeta = useRef<Record<string, { agentId: string; name: string; text: string }>>({});

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

  /** agentId → LLM 连接（绑定表解析）：无绑定/连接已删都归为 undefined（发送前拦截与触发共用）。 */
  const resolveProfile = (agentId: string) => {
    const llm = useLlmStore.getState();
    const pid = llm.bindings[agentId];
    return pid ? llm.getProfile(pid) : undefined;
  };

  /** 流气泡署名：本会话 members 映射名优先，其次名册，兜底「智能体」。 */
  const nameOf = (agentId: string) =>
    memberNameById?.[agentId] ?? agentsRoster.find((a) => a.id === agentId)?.name ?? "智能体";

  /** 本会话的打字机项（含他机流）：渲染在消息列表尾部。 */
  const streamEntries = Object.entries(streaming).filter(([, s]) => s.conversationId === convId);
  /** 「生成中」提示行只报本机流（他机流错误行短暂停留，不占中断入口）。 */
  const activeLocal = streamEntries.filter(([id, s]) => streamOwner[id] && s.status === "streaming");

  /**
   * 启动一次 mention 触发（发送成功 / 错误行重试共用）：
   * deps 全部从 stores + WS 句柄组装；fetchHistory 映射 role 并剔掉刚发出的这条
   * （服务端很可能已入库，否则当前 user 轮会在提示词里出现两遍）。
   */
  const startRun = (mentions: { agentId: string; name: string }[], text: string) => {
    const deps: TriggerDeps = {
      getProfile: resolveProfile,
      getPrompt: (agentId) => useLlmStore.getState().prompts[agentId] ?? "",
      fetchHistory: async () => {
        // spec §3：提示词只带近 30 条历史（服务端全量返回，客户端切尾）
        const msgs = (await fetchMessages(convId)).slice(-30);
        const rows = msgs.map((m) => ({
          role: m.senderType === "user" ? ("user" as const) : ("assistant" as const),
          content: m.payload.text,
        }));
        const last = rows[rows.length - 1];
        if (last && last.role === "user" && last.content === text) rows.pop();
        return rows;
      },
      send: (e) => wsHandleRef.current?.send(e),
      streamChat,
      onLocalDelta: (streamId, acc) => {
        const meta = streamMeta.current[streamId];
        if (!meta) return;
        // 本机流文本已本地累积（不等 WS 回声），回声由 onWsEvent 按 streamOwner 跳过
        upsertStream(streamId, {
          agentId: meta.agentId,
          conversationId: convId,
          text: acc,
          status: "streaming",
        });
      },
      onStart: (streamId, mention) => {
        streamMeta.current[streamId] = { ...mention, text };
        markStreamOwner(streamId);
        upsertStream(streamId, {
          agentId: mention.agentId,
          conversationId: convId,
          text: "",
          status: "streaming",
        });
      },
    };
    // 同步拿句柄（挂在 promise 上）：中断按钮不必等 fetchHistory/流完成
    const run = runAgentMentions(convId, mentions, text, deps);
    const runs = (runsRef.current[convId] ??= new Set());
    runs.add(run);
    // 完成即摘除：卸载时 WS cleanup 据此判断是否还有「进行中流」需延迟 close（F1）
    run.then(
      () => runs.delete(run),
      (e) => {
        runs.delete(run);
        // fetchHistory 失败等启动期错误：生成未开始，可见提示而非静默
        console.warn("智能体生成启动失败", e);
        setSendNotice("智能体生成启动失败，请稍后重试");
      },
    );
  };

  /** 中断当前会话全部进行中流：abort → 各流 catch 走 finish-partial + agent_error(aborted)。 */
  const abortRuns = () => {
    for (const h of runsRef.current[convId] ?? []) h.abortAll();
  };

  /** 错误行重试：清掉旧项，按原触发文本重新跑该单个 mention（新 streamId 重新登记）。 */
  const retryStream = (streamId: string) => {
    const meta = streamMeta.current[streamId];
    if (!meta) return;
    removeStream(streamId);
    delete streamMeta.current[streamId];
    startRun([{ agentId: meta.agentId, name: meta.name }], meta.text);
  };

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
        // 流式三事件收口（chunk 累积/message_new{streamId} 移除/agent_error 分态）在 store 统一处理
        useChatStore.getState().onWsEvent(e);
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
      // F1 回归：进行中流被卸载中止时，catch 要经此连接补发 finish(partial)+agent_error
      // （服务端入库 partial、他机端收 error 收口）。立即 close + 清 ref 会把两帧静默丢弃——
      // catch 在微任务里跑，故把 close 延后一个宏任务（微任务必先排空），ref 同步清空也一并延后。
      // 无进行中流则立即关（绝大多数切会话/卸载路径，行为不变）。
      const hasInFlight = Object.values(runsRef.current).some((s) => s.size > 0);
      if (hasInFlight && handle) {
        setTimeout(() => {
          handle.close();
          if (wsHandleRef.current === handle) wsHandleRef.current = null;
        }, 0);
      } else {
        handle?.close();
        wsHandleRef.current = null;
      }
    };
  }, [convId, appendMessage, setMessages, loadReads]);

  useEffect(() => {
    bottomRef.current?.scrollIntoView({ behavior: "smooth" });
  }, [messages.length]);

  // I1 挂载清扫：上一轮卸载中止流后 socket 已关，finish/echo 收不到，store（整页刷新
  // 才会清空）里可能残留本会话的「生成中」孤儿项与 streamOwner 键。新挂载时 runsRef
  // 必为空 → 该 convId 下不可能有进行中流，残留一律按孤儿清（他/其他会话条目不动）。
  // 空依赖 = 只在新挂载执行；切会话（convId 变化）不清——那时他机流条目仍有效。
  useEffect(() => {
    clearStreamsForConversation(convId);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  // 卸载（离开聊天页）：中止全部进行中流，不再空烧供应商 token
  useEffect(
    () => () => {
      for (const set of Object.values(runsRef.current)) {
        for (const h of set) h.abortAll();
      }
    },
    [],
  );

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
    // 发送前拦截：@ 到的智能体没绑 LLM 连接 → 不发消息，本地提示去设置页配置（草稿/chip 保留）
    const unbound = selectedMentions.find((m) => !resolveProfile(m.agentId));
    if (unbound) {
      setSendNotice(`${unbound.name} 未绑定 LLM 连接，请先在设置页配置`);
      return;
    }
    const handle = wsHandleRef.current;
    if (!handle) {
      // 保留草稿与已选 mention，给出可见提示（不静默丢弃）
      setSendNotice("连接未就绪，消息未发送");
      return;
    }
    const mentions = selectedMentions;
    handle.send({
      type: "send_message",
      conversationId: convId,
      payload: {
        text,
        // mentions 非空才带（空则整个键不出现，与 M2 消息形状一致）
        ...(mentions.length ? { mentions } : {}),
      },
    });
    setDraft("");
    setSelectedMentions([]);
    setPicker(null);
    setTokenLock(false);
    setSendNotice(null);
    // 发送成功即触发各 mention 的本机流式生成（失败/中断由 WS 三事件回声收口）
    if (mentions.length) startRun(mentions, text);
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
        {/* 流式打字机行（本机/他机）：渲染于消息列表尾部，finish 的 message_new 收口后移除 */}
        {streamEntries.map(([id, s]) => (
          <AgentStreamBubble
            key={id}
            name={nameOf(s.agentId)}
            text={s.text}
            status={s.status}
            errorMessage={s.errorMessage}
            onRetry={streamOwner[id] && s.status === "error" ? () => retryStream(id) : undefined}
          />
        ))}
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
        {/* 「生成中」提示行（输入栏上方）：本机流署名 + 中断入口 */}
        {activeLocal.length > 0 && (
          <div className="flex items-center gap-3 px-5 pt-2 text-[12px] text-muted">
            <span>生成中：{activeLocal.map(([, s]) => nameOf(s.agentId)).join("、")}</span>
            <button
              type="button"
              className="rounded border border-line px-2 py-0.5 hover:bg-[#f3f3f3]"
              onClick={abortRuns}
            >
              中断
            </button>
          </div>
        )}
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
