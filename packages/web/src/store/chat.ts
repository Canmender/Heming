import { create } from "zustand";
import type { Agent, Conversation, Member, Message, ReadState, User, WsServerEvent } from "@heming/shared";
import {
  fetchConversations,
  fetchFriends,
  fetchIncomingRequests,
  createConversation,
  fetchMessages,
  fetchMembers,
  api,
} from "../lib/api.js";
import { listAgents } from "../lib/agentsApi.js";

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
}

/** upsert 补丁：必带归属字段（创建首帧即定 agent/会话），其余字段缺省继承/补默认。 */
export type AgentStreamPatch = Partial<AgentStreamState> &
  Pick<AgentStreamState, "agentId" | "conversationId">;

/** 他机流 agent_error 的「短暂显示」时长（本机流不走此路径——保留供重试）。 */
const REMOTE_ERROR_TTL_MS = 6000;

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
}

export const useChatStore = create<ChatState>((set, get) => ({
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
      const prev = get().streaming[e.streamId];
      get().upsertStream(e.streamId, {
        agentId: e.agentId,
        conversationId: e.conversationId,
        text: (prev?.text ?? "") + e.text,
        status: "streaming",
      });
      return;
    }
    if (e.type === "agent_error") {
      const local = !!get().streamOwner[e.streamId];
      get().upsertStream(e.streamId, {
        agentId: e.agentId,
        conversationId: e.conversationId,
        status: "error",
        errorMessage: e.message,
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
    }
  },
}));
