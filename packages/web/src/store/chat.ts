import { create } from "zustand";
import type { Agent, Conversation, Member, Message, ReadState, User, WsServerEvent } from "@heming/shared";
import {
  fetchConversations,
  fetchFriends,
  fetchIncomingRequests,
  createConversation,
  fetchMessages,
  fetchMembers,
  reencryptMessage,
  api,
} from "../lib/api.js";
import { listAgents } from "../lib/agentsApi.js";
import { sealMessage, msgCache, type E2eDeps, type PlainEnvelope } from "../lib/e2eSession.js";

// —— E2E Task 4：收信解密注入面（store 不 import e2eSession 的 openMessage 实现，
//    由 ChatPage 组装 deps 后经 setOpenHandler 注入——避免渲染层与会话层的循环依赖）——

/** 解密 handler 的入参：服务端信封（SealedEnvelope 结构）+ 所属会话 id。 */
export interface E2eOpenInput {
  conversationId: string;
  id: string;
  senderId?: string;
  chainKid?: string;
  n?: number;
  cipher: string;
  createdAt?: string;
}

/**
 * 流式事件的 AAD 上下文：chunk 按设计 §5.3（AAD=convId+streamId+index）；
 * error（fix I2）按 errorAad（convId+streamId，每 stream 恰一条）。
 */
export interface E2eStreamCtx {
  streamId: string;
  kind: "chunk" | "error";
  index?: number; // kind=chunk 必带（调用方保证）
}

/** 密文 agent_error 解不开/未注入 handler 时的降级文案（不含错误原文；agentStream 侧 GENERIC_SEAL_FALLBACK 同口径）。 */
export const E2E_ERROR_FALLBACK = "生成出错（内容无法解密）";

/**
 * 解密结果：ok=明文（chaindist 已在 handler 内落链并扫完暂挂）；defer=缺链暂挂（占位
 * 渲染 + pending 等 chaindist 重试）；failed=永久解不开（占位、不重试）；
 * skip=非本机定向/无缓存的重放（不入列）。
 */
export type E2eOpenOutcome =
  | { status: "ok"; plain: PlainEnvelope }
  | { status: "defer" }
  | { status: "skip" }
  | { status: "failed" };

export type E2eOpenHandler = (
  env: E2eOpenInput,
  ctx?: E2eStreamCtx,
) => Promise<E2eOpenOutcome>;

/** 服务端信封消息 → 解密入参（enc=e2e 时 cipher/chainKid/n 由 schema 保证可达）。 */
function toInput(m: Message): E2eOpenInput {
  return {
    conversationId: m.conversationId,
    id: m.id,
    senderId: m.senderId,
    ...(m.chainKid !== undefined ? { chainKid: m.chainKid } : {}),
    ...(m.n !== undefined ? { n: m.n } : {}),
    cipher: m.cipher ?? "",
    createdAt: m.createdAt,
  };
}

/**
 * 密文明文体 → 可渲染消息形态：payload 三件套（text/mentions/file/forward）与 replyTo
 * 全部来自密文（服务端库里的 payload 恒为 {text:""} 占位），enc 保持 "e2e"
 *（plain 自迁移扫描依赖 enc 判别，且渲染层据此找 plainById 占位）。
 */
function toRenderable(m: Message, plain: PlainEnvelope): Message {
  const payload: Message["payload"] = { text: plain.text ?? "" };
  if (plain.mentions) payload.mentions = plain.mentions;
  if (plain.file) payload.file = plain.file;
  if (plain.forward) payload.forward = plain.forward;
  return { ...m, payload, replyTo: plain.replyTo ?? null };
}

/** plain 存量消息 → 重封用明文体（自迁移 §7：forward > file > text 判 kind，载荷全带）。 */
function plainOfExisting(m: Message): PlainEnvelope {
  return {
    kind: m.payload.forward ? "forward" : m.payload.file ? "file" : "text",
    ...(m.payload.text ? { text: m.payload.text } : {}),
    ...(m.payload.mentions ? { mentions: m.payload.mentions } : {}),
    ...(m.payload.file ? { file: m.payload.file } : {}),
    ...(m.payload.forward ? { forward: m.payload.forward } : {}),
    ...(m.replyTo ? { replyTo: m.replyTo } : {}),
  };
}

/** 名册 join：群内 agentId 集合 × 名册全量 → Agent 行（roster 缺行的 id 跳过，不占位）。 */
function joinRoster(roster: Agent[], ids: Set<string>): Agent[] {
  const byId = new Map(roster.map((a) => [a.id, a]));
  const out: Agent[] = [];
  for (const id of ids) {
    const a = byId.get(id);
    if (a) out.push(a);
  }
  return out;
}

/** 单条流式生成的打字机状态（key=streamId）。 */
export interface AgentStreamState {
  agentId: string;
  conversationId: string;
  text: string;
  status: "streaming" | "error";
  errorMessage?: string;
  /** 最后一次写入（含文本累积/事件到达）的毫秒时间戳；他机流 watchdog 据此判「长时间无响应」。 */
  lastAt: number;
}

/** upsert 补丁：必带归属字段（创建首帧即定 agent/会话），其余字段缺省继承/补默认。 */
export type AgentStreamPatch = Partial<AgentStreamState> &
  Pick<AgentStreamState, "agentId" | "conversationId">;

/** 他机流 agent_error 的「短暂显示」时长（本机流不走此路径——保留供重试）。 */
const REMOTE_ERROR_TTL_MS = 6000;

/**
 * 他机流「无响应」判定阈值（Task 7 watchdog）：距最后一次写入超过此时长仍未收尾
 * （message_new/agent_error）即判为中断，置 error 行——本机流不自动重试，error 行已有手动重试 UI。
 * 取舍：TTFT 或流内间隔超过此值的慢模型会被短暂误报「生成可能已中断」，下个 chunk 到达即自愈
 * （patch 会清掉 errorMessage 并回到 streaming）；60s 对常规对话式生成足够宽松，误报成本可接受。
 */
const STREAM_STALE_MS = 60_000;

interface ChatState {
  conversations: Conversation[];
  friends: { id: string; user: User }[];
  incoming: { id: string; from: User }[];
  messages: Record<string, Message[]>;
  /** 名册全量（GET /api/agents；雷达扇区 join 与编辑弹窗取 owner/description 用）。 */
  agentsRoster: Agent[];
  /** 跨群去重收集的智能体成员 id（雷达扇区「出现在我任一群 members」判定）。 */
  agentIdsInGroups: Set<string>;
  /** 群内出现过的 agentId × 名册 join 的视图（M3 起为 Agent 行，非 Member 行）。 */
  agents: Agent[];
  /** 各会话已读状态（convId → [{userId, at}]；direct 气泡「已读」判定与 read_update 随动用）。 */
  reads: Record<string, ReadState[]>;
  /** 流式生成打字机项（key=streamId；本机触发端本地累积写入，他机流由 WS 回声累积）。 */
  streaming: Record<string, AgentStreamState>;
  /** 本机发起的流（key=streamId）：自身 agent_chunk 回声跳过，agent_error 走可重试分支。 */
  streamOwner: Record<string, true>;
  /** E2E 解密 handler（ChatPage 注入）：null 时 e2e 收信按占位入列并挂 pending，注入后冲刷。 */
  openHandler: E2eOpenHandler | null;
  /** 已解密明文（convId → msgId → plain）：渲染层据此判 kind（reaction 不画气泡）与占位。 */
  plainById: Record<string, Record<string, PlainEnvelope>>;
  /** 解不开（defer）的 e2e 消息 id：chaindist 到达/重新注入 handler 后重试。 */
  pendingE2e: Record<string, string[]>;
  loadWorkspace: () => Promise<void>;
  openDirect: (peerId: string) => Promise<string>;
  createGroup: (name: string, memberIds: string[]) => Promise<string>;
  /** 把名册 agent 挂到会话（POST /api/conversations/:id/agents，幂等；权限在服务端路由层）。 */
  attachAgentToGroup: (convId: string, agentId: string) => Promise<void>;
  /** 会话卸载 agent（DELETE …/agents/:agentId，幂等 204）。 */
  detachAgentFromGroup: (convId: string, agentId: string) => Promise<void>;
  loadAgents: () => Promise<void>;
  loadAgentsRoster: () => Promise<void>;
  appendMessage: (m: Message) => void;
  setMessages: (convId: string, msgs: Message[]) => void;
  /**
   * 注入 E2E 解密 handler（ChatPage 挂载时组装 e2eSession 依赖后调用；卸载置 null）。
   * 注入非 null 时冲刷全部 pendingE2e——handler 建立前到达的占位由此补齐。
   */
  setOpenHandler: (fn: E2eOpenHandler | null) => void;
  /**
   * 拉历史并做 E2E 合并（设计 §6 读取顺序）：plain 直通；e2e 信封按「已有明文 → handler
   * 解密 → 占位」落列，chaindist/非本机定向过滤出列表；defer 的 id 挂 pendingE2e。
   * 返回合并后的列表（store 状态同步写入）；alive 为假（组件已卸载/切会话）则不写 store
   * ——晚到的 fetch 结果不得污染新挂载的状态。
   */
  loadMessages: (convId: string, alive?: () => boolean) => Promise<Message[]>;
  /**
   * 存量自迁移（设计 §7）：本会话 `enc:"plain"` 且 `senderId===meId` 的消息逐条
   * sealMessage 重封 → `PUT /api/messages/:id/reencrypt`，**20/s 节流**（首条立即、
   * 后续每条间隔 50ms）。成功后本地替换为服务端返回的 e2e 形态；
   * `attempted`（组件 ref）跨 effect 批次去重，失败条目（含 409 冲突）本挂载不再重试。
   */
  migrateOwnPlain: (
    convId: string,
    members: string[],
    deps: E2eDeps,
    attempted: Set<string>,
    meId: string,
    alive?: () => boolean,
  ) => Promise<void>;
  setReads: (convId: string, reads: ReadState[]) => void;
  loadReads: (convId: string) => Promise<void>;
  upsertStream: (id: string, patch: AgentStreamPatch) => void;
  removeStream: (id: string) => void;
  markStreamOwner: (id: string) => void;
  /**
   * 清掉某会话的全部打字机项连同其 streamOwner 键（I1）：ChatPage 新挂载时调用——
   * runsRef 随组件重建必为空，该 convId 下不可能还有进行中流，残留项均为卸载后
   * echo 收不到的孤儿（会一直渲染「生成中」且中断按钮 no-op）。
   */
  clearStreamsForConversation: (convId: string) => void;
  /** 流式三事件收口（chunk/error/message_new{streamId}），由 ChatPage 的 onEvent 转发。 */
  onWsEvent: (e: WsServerEvent) => void;
  /**
   * 他机流 watchdog（Task 7）：扫描 streaming 项，status==="streaming" 且距 lastAt 超过
   * STREAM_STALE_MS 未刷新者置 error（长时间无响应，生成可能已中断）。由 ChatPage 定时器调用。
   */
  sweepStaleStreams: (now: number) => void;
}

export const useChatStore = create<ChatState>((set, get) => {
  // —— E2E Task 4 内部辅助（解密结果应用 / pending 重试）——

  /** 解密成功后的入列（替换或追加）：defer 占位 → 明文补齐靠同 id 替换完成。 */
  const upsertMessage = (m: Message) => {
    const list = get().messages[m.conversationId] ?? [];
    const i = list.findIndex((x) => x.id === m.id);
    if (i === -1) {
      set({ messages: { ...get().messages, [m.conversationId]: [...list, m] } });
      return;
    }
    const next = [...list];
    next[i] = m;
    set({ messages: { ...get().messages, [m.conversationId]: next } });
  };

  const recordPlain = (convId: string, msgId: string, plain: PlainEnvelope) => {
    set({
      plainById: {
        ...get().plainById,
        [convId]: { ...(get().plainById[convId] ?? {}), [msgId]: plain },
      },
    });
  };

  const addPending = (convId: string, id: string) => {
    const cur = get().pendingE2e[convId] ?? [];
    if (cur.includes(id)) return;
    set({ pendingE2e: { ...get().pendingE2e, [convId]: [...cur, id] } });
  };

  const dropPending = (convId: string, id: string) => {
    const cur = get().pendingE2e[convId];
    if (!cur?.includes(id)) return;
    set({ pendingE2e: { ...get().pendingE2e, [convId]: cur.filter((x) => x !== id) } });
  };

  /** 重扫全部 defer 占位：chaindist 落链（handler 内已 await sweep）或 handler 重新注入后调用。 */
  const retryPending = async (convId: string): Promise<void> => {
    const h = get().openHandler;
    if (!h) return;
    for (const id of [...(get().pendingE2e[convId] ?? [])]) {
      const m = (get().messages[convId] ?? []).find((x) => x.id === id);
      if (!m) {
        dropPending(convId, id);
        continue;
      }
      try {
        applyOutcome(m, await h(toInput(m)));
      } catch {
        applyOutcome(m, { status: "failed" });
      }
    }
  };

  /** 把一次解密结果落到 store（列表/pending/plainById 的唯一出口）。 */
  const applyOutcome = (m: Message, out: E2eOpenOutcome): void => {
    const convId = m.conversationId;
    if (out.status === "ok") {
      dropPending(convId, m.id);
      recordPlain(convId, m.id, out.plain);
      if (out.plain.kind === "chaindist") {
        // 控制消息不入列；handler 已 await 完暂挂重扫 → 此刻重试占位可直接命中明文缓存
        void retryPending(convId);
        return;
      }
      upsertMessage(toRenderable(m, out.plain));
      return;
    }
    if (out.status === "defer") {
      upsertMessage(m); // 占位入列（渲染层按「enc=e2e 且无明文」显示无法解密）
      addPending(convId, m.id);
      return;
    }
    if (out.status === "failed") {
      dropPending(convId, m.id);
      upsertMessage(m); // 永久失败：占位且不重试
      return;
    }
    // skip：非本机定向 chaindist / 无缓存的重放——不入列、不重试
    dropPending(convId, m.id);
  };

  return {
  conversations: [],
  friends: [],
  incoming: [],
  messages: {},
  agentsRoster: [],
  agentIdsInGroups: new Set<string>(),
  agents: [],
  reads: {},
  streaming: {},
  streamOwner: {},
  openHandler: null,
  plainById: {},
  pendingE2e: {},
  async loadWorkspace() {
    const [conversations, friends, incoming] = await Promise.all([
      fetchConversations(),
      fetchFriends(),
      fetchIncomingRequests(),
    ]);
    set({ conversations, friends, incoming });
  },
  async openDirect(peerId) {
    const conv = await createConversation(peerId);
    // 服务端直聊创建响应不带 unreadCount：先补 0 入列，随后 loadWorkspace 全量刷新
    if (!get().conversations.some((c) => c.id === conv.id)) {
      set({ conversations: [...get().conversations, { ...conv, unreadCount: 0 }] });
    }
    await get().loadWorkspace();
    return conv.id;
  },
  async createGroup(name, memberIds) {
    const conv = await api<Conversation>("/api/conversations", {
      method: "POST",
      body: JSON.stringify({ name, memberIds }),
    });
    await get().loadWorkspace();
    return conv.id;
  },
  async attachAgentToGroup(convId, agentId) {
    await api(`/api/conversations/${convId}/agents`, {
      method: "POST",
      body: JSON.stringify({ agentId }),
    });
  },
  async detachAgentFromGroup(convId, agentId) {
    await api(`/api/conversations/${convId}/agents/${agentId}`, { method: "DELETE" });
  },
  async loadAgents() {
    const groups = get().conversations.filter((c) => c.type === "group");
    // 单群失败不拖垮全部（如中途被移出群 403）：该群按空列表处理
    const lists = await Promise.all(
      groups.map((g) => fetchMembers(g.id).catch(() => [] as Member[])),
    );
    const ids = new Set<string>();
    for (const list of lists) {
      for (const m of list) {
        if (m.kind === "agent") ids.add(m.id);
      }
    }
    // join 名册拿 owner/description（Member 行升级为名册全量行）；与 loadAgentsRoster 双向重算，
    // 谁后完成谁用对方已落定的 state 再 join 一次，保证终态一致
    set({ agentIdsInGroups: ids, agents: joinRoster(get().agentsRoster, ids) });
  },
  async loadAgentsRoster() {
    const agentsRoster = await listAgents();
    set({ agentsRoster, agents: joinRoster(agentsRoster, get().agentIdsInGroups) });
  },
  appendMessage(m) {
    if (m.enc === "e2e") {
      // E2E Task 4：先过注入的解密 handler 再进列表——ok 明文入列 / defer 占位挂起 /
      // failed 占位不重试 / skip 丢弃；handler 未注入（挂载竞态）按占位入列并挂 pending。
      const h = get().openHandler;
      if (!h) {
        upsertMessage(m);
        addPending(m.conversationId, m.id);
        return;
      }
      void h(toInput(m))
        .then((out) => applyOutcome(m, out))
        .catch(() => applyOutcome(m, { status: "failed" }));
      return;
    }
    const list = get().messages[m.conversationId] ?? [];
    if (list.some((x) => x.id === m.id)) return;
    set({ messages: { ...get().messages, [m.conversationId]: [...list, m] } });
  },
  setMessages(convId, msgs) {
    // 历史响应落定前可能已有 message_new 入列（fetch 与 WS 交错）：
    // 以历史为底，保留本地独有的条目（按 id 去重，按 createdAt 插回原时间位）
    const localOnly = (get().messages[convId] ?? []).filter(
      (m) => !msgs.some((x) => x.id === m.id),
    );
    const merged = [...msgs];
    for (const m of localOnly) {
      const at = merged.findIndex((x) => x.createdAt > m.createdAt);
      if (at === -1) merged.push(m);
      else merged.splice(at, 0, m);
    }
    set({ messages: { ...get().messages, [convId]: merged } });
  },
  setOpenHandler(fn) {
    set({ openHandler: fn });
    // 注入即冲刷：handler 建立前到达的 e2e 占位（loadMessages/WS 竞态窗口）现在可解
    if (fn) for (const convId of Object.keys(get().pendingE2e)) void retryPending(convId);
  },
  async loadMessages(convId, alive) {
    const fetched = await fetchMessages(convId);
    const h = get().openHandler;
    const resolved: Message[] = [];
    let landed = false; // 本次拉取里是否解开了 chaindist（落链 → 需重试占位）
    for (const m of fetched) {
      if (m.enc !== "e2e") {
        resolved.push(m);
        continue;
      }
      const known = get().plainById[convId]?.[m.id];
      if (known) {
        // 缓存优先（§6）：已解密过的信封不再回调 handler
        if (known.kind !== "chaindist") resolved.push(toRenderable(m, known));
        continue;
      }
      if (!h) {
        resolved.push(m); // 未注入：占位 + pending，注入后冲刷
        addPending(convId, m.id);
        continue;
      }
      let out: E2eOpenOutcome;
      try {
        out = await h(toInput(m));
      } catch {
        out = { status: "failed" };
      }
      if (out.status === "ok") {
        recordPlain(convId, m.id, out.plain);
        dropPending(convId, m.id);
        if (out.plain.kind === "chaindist") landed = true;
        else resolved.push(toRenderable(m, out.plain));
      } else if (out.status === "defer") {
        resolved.push(m);
        addPending(convId, m.id);
      } else if (out.status === "failed") {
        resolved.push(m); // 占位（解不开的不进 LLM 提示词，渲染层显示无法解密）
        dropPending(convId, m.id);
      } else {
        dropPending(convId, m.id); // skip → 过滤出列表（非本机 chaindist 等）
      }
    }
    if (alive && !alive()) return resolved; // 卸载/切会话后晚到：结果返回但不写 store
    get().setMessages(convId, resolved);
    if (landed) void retryPending(convId);
    return resolved;
  },
  async migrateOwnPlain(convId, members, deps, attempted, meId, alive) {
    const targets = (get().messages[convId] ?? []).filter(
      (m) => m.enc === "plain" && m.senderId === meId && m.recalledAt == null,
    );
    let sent = 0;
    for (const m of targets) {
      if (attempted.has(m.id)) continue; // 组件 ref 去重：跨 effect 批次不重复 PUT
      attempted.add(m.id);
      if (sent > 0) await new Promise((r) => setTimeout(r, 50)); // 分批 20/s 防风暴（§7）
      sent += 1;
      try {
        const plain = plainOfExisting(m);
        const ev = await sealMessage({ id: convId, members }, plain, deps);
        if (ev.type !== "send_message" || !ev.cipher) throw new Error("seal 未产出信封");
        const updated = await reencryptMessage(m.id, {
          enc: "e2e",
          cipher: ev.cipher,
          ...(ev.chainKid !== undefined ? { chainKid: ev.chainKid } : {}),
          ...(ev.n !== undefined ? { n: ev.n } : {}),
        });
        if (alive && !alive()) return; // 卸载后晚到：不写本地（服务端已重封，重进走缓存）
        // 本地替换为服务端返回的 e2e 形态：明文本就是自己刚封的——直接记进 plainById
        // 并按明文回填 payload（否则列表会退化成「无法解密」占位；后续 loadMessages
        // 命中 plainById 同样按明文合并，见 §6 缓存优先）。
        recordPlain(convId, updated.id, plain);
        // 同步落明文缓存（§6）：plainById 仅本会话内存——重载后自发消息没有 recv 链，
        // 只能靠 msgCache 的「缓存优先」自解。
        msgCache.append(convId, {
          id: updated.id,
          senderId: updated.senderId,
          at: Date.parse(updated.createdAt) || Date.now(),
          plain,
        });
        upsertMessage(toRenderable(updated, plain));
      } catch {
        // 409（他端已重封）/网络/公钥校验失败：跳过该条继续（attempted 已挡本挂载重试）
      }
    }
  },
  setReads(convId, reads) {
    set({ reads: { ...get().reads, [convId]: reads } });
  },
  async loadReads(convId) {
    const reads = await api<ReadState[]>(`/api/conversations/${convId}/reads`);
    get().setReads(convId, reads);
  },
  upsertStream(id, patch) {
    const prev = get().streaming[id];
    // 无既有项时用补丁归属字段 + 默认值起底，再整体打补丁（有既有项则在其上合并）
    const base: AgentStreamState = prev ?? {
      agentId: patch.agentId,
      conversationId: patch.conversationId,
      text: "",
      status: "streaming",
      lastAt: Date.now(),
    };
    set({
      streaming: {
        ...get().streaming,
        [id]: { ...base, ...patch },
      },
    });
  },
  removeStream(id) {
    // streamOwner 刻意不清理：finish 的 message_new 先到、agent_error 回声后到时，
    // 仍能按本机流归类（置 error 供重试），否则会被误当他机流走去自清
    const { [id]: _removed, ...rest } = get().streaming;
    set({ streaming: rest });
  },
  markStreamOwner(id) {
    set({ streamOwner: { ...get().streamOwner, [id]: true } });
  },
  clearStreamsForConversation(convId) {
    const { streaming, streamOwner } = get();
    const kept: Record<string, AgentStreamState> = {};
    const removed: string[] = [];
    for (const [id, s] of Object.entries(streaming)) {
      if (s.conversationId === convId) removed.push(id);
      else kept[id] = s;
    }
    if (removed.length === 0) return;
    const keptOwner = { ...streamOwner };
    for (const id of removed) delete keptOwner[id];
    // 只动本 convId 的条目：其他会话的流式项（含他机流）原样保留
    set({ streaming: kept, streamOwner: keptOwner });
  },
  onWsEvent(e) {
    if (e.type === "message_new") {
      // agent_finish 入库后的收口：打字机项移除，正式消息由 ChatPage appendMessage 入列
      if (e.streamId) get().removeStream(e.streamId);
      return;
    }
    if (e.type === "message_recalled") {
      // 撤回不移除列表：按 messageId 置 recalledAt（气泡渲染层按它切换「消息已撤回」）
      const list = get().messages[e.conversationId];
      if (list) {
        set({
          messages: {
            ...get().messages,
            [e.conversationId]: list.map((m) =>
              m.id === e.messageId ? { ...m, recalledAt: e.at } : m,
            ),
          },
        });
      }
      return;
    }
    if (e.type === "message_updated") {
      // 表情回应（Task 6）：整条替换，按 id 定位；列表长度与顺序不变（未加载的消息静默忽略）
      const list = get().messages[e.message.conversationId];
      if (list) {
        set({
          messages: {
            ...get().messages,
            [e.message.conversationId]: list.map((m) => (m.id === e.message.id ? e.message : m)),
          },
        });
      }
      return;
    }
    if (e.type === "agent_chunk") {
      // 本机流已在触发端本地累积（onLocalDelta），回声不再重复 upsert
      if (get().streamOwner[e.streamId]) return;
      if (
        e.cipher !== undefined &&
        e.chainKid !== undefined &&
        e.n !== undefined &&
        e.index !== undefined
      ) {
        // E2E 流式片（设计 §5.3）：按 AAD=convId+streamId+index 解密后累积；
        // 解不开/未注入 handler → 跳过该片不崩（流式容错，finish 的全文信封兜底展示）
        const h = get().openHandler;
        if (!h) return;
        void h(
          {
            conversationId: e.conversationId,
            id: `chunk:${e.streamId}:${e.index}`,
            senderId: e.agentId,
            cipher: e.cipher,
            chainKid: e.chainKid,
            n: e.n,
          },
          { streamId: e.streamId, kind: "chunk", index: e.index },
        )
          .then((out) => {
            if (out.status !== "ok" || out.plain.kind !== "chunk") return;
            const prev = get().streaming[e.streamId];
            get().upsertStream(e.streamId, {
              agentId: e.agentId,
              conversationId: e.conversationId,
              text: (prev?.text ?? "") + (out.plain.text ?? ""),
              status: "streaming",
              lastAt: Date.now(),
              errorMessage: undefined,
            });
          })
          .catch(() => {
            /* 解密异常同「解不开」：跳过该片 */
          });
        return;
      }
      const prev = get().streaming[e.streamId];
      get().upsertStream(e.streamId, {
        agentId: e.agentId,
        conversationId: e.conversationId,
        text: (prev?.text ?? "") + e.text,
        status: "streaming",
        lastAt: Date.now(), // Task 7：累积即刷新，watchdog 以此为「仍有活动」依据
        errorMessage: undefined, // 清掉可能残留的 watchdog 误报（恢复即自愈）
      });
      return;
    }
    if (e.type === "agent_error") {
      const local = !!get().streamOwner[e.streamId];
      const applyError = (errorMessage: string) => {
        get().upsertStream(e.streamId, {
          agentId: e.agentId,
          conversationId: e.conversationId,
          status: "error",
          errorMessage,
        });
        if (!local) {
          // 他机流失败：短暂显示原因后自清（本机流保留错误行供重试）
          const id = e.streamId;
          setTimeout(() => {
            if (!get().streamOwner[id] && get().streaming[id]?.status === "error") {
              get().removeStream(id);
            }
          }, REMOTE_ERROR_TTL_MS);
        }
      };
      if (e.cipher !== undefined && e.chainKid !== undefined && e.n !== undefined) {
        // 密文错误（fix I2）：正文只在 cipher 里——解密得正文；解不开/未注入 → 通用降级
        // 文案（绝不把密文当正文显示）；code 非敏感明文保留。
        const h = get().openHandler;
        if (!h) {
          applyError(E2E_ERROR_FALLBACK);
          return;
        }
        void h(
          {
            conversationId: e.conversationId,
            id: `err:${e.streamId}`,
            senderId: e.agentId,
            cipher: e.cipher,
            chainKid: e.chainKid,
            n: e.n,
          },
          { kind: "error", streamId: e.streamId },
        )
          .then((out) =>
            applyError(
              out.status === "ok" && out.plain.kind === "error" && typeof out.plain.text === "string"
                ? out.plain.text
                : E2E_ERROR_FALLBACK,
            ),
          )
          .catch(() => applyError(E2E_ERROR_FALLBACK));
        return;
      }
      applyError(e.message); // 明文 legacy（服务端自产 forbidden / 旧端）
      return;
    }
  },
  sweepStaleStreams(now) {
    const entries = get().streaming;
    let changed = false;
    const next = { ...entries };
    const selfClear: string[] = [];
    for (const [id, s] of Object.entries(entries)) {
      if (s.status === "streaming" && now - (s.lastAt ?? 0) > STREAM_STALE_MS) {
        next[id] = { ...s, status: "error", errorMessage: "长时间无响应，生成可能已中断" };
        changed = true;
        // 他机流（非本机触发）：无 agent_error 回声来收口，与 agent_error 分支同款短暂显示后自清；
        // 本机流保留 error 行供手动重试（不自清）。
        if (!get().streamOwner[id]) selfClear.push(id);
      }
    }
    if (!changed) return; // 无变更则不写（保引用稳定，不触发多余重渲染）
    set({ streaming: next });
    for (const id of selfClear) {
      setTimeout(() => {
        // 兜底：期间若该流自愈（回到 streaming）或已换归属，则不自清
        if (!get().streamOwner[id] && get().streaming[id]?.status === "error") {
          get().removeStream(id);
        }
      }, REMOTE_ERROR_TTL_MS);
    }
  },
  };
});
