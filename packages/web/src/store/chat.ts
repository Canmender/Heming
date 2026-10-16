import { create } from "zustand";
import type { Agent, Conversation, Member, Message, ReadState, User } from "@heming/shared";
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
  loadWorkspace: () => Promise<void>;
  openDirect: (peerId: string) => Promise<string>;
  createGroup: (name: string, memberIds: string[]) => Promise<string>;
  loadAgents: () => Promise<void>;
  loadAgentsRoster: () => Promise<void>;
  appendMessage: (m: Message) => void;
  setMessages: (convId: string, msgs: Message[]) => void;
  setReads: (convId: string, reads: ReadState[]) => void;
  loadReads: (convId: string) => Promise<void>;
}

/** 稳定空引用：非群会话的候选（zustand 选择器按 Object.is 比较，避免每次 state 变更重渲染）。 */
const NO_MENTION_AGENTS: Agent[] = [];

/**
 * 本会话可 @ 的智能体候选（M3 Task 7 @ 选择器数据源）：
 * 群会话取 Task 6 的「群内 agentId × 名册」join 视图（agents）；direct/未知会话不给候选
 * （智能体仅群内可对话）。逐群 agent 集合未按会话分桶，「本群」口径即该 join 视图。
 */
export function selectMentionCandidates(state: ChatState, convId: string): Agent[] {
  const conv = state.conversations.find((c) => c.id === convId);
  return conv?.type === "group" ? state.agents : NO_MENTION_AGENTS;
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
}));
