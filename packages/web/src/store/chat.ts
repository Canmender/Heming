import { create } from "zustand";
import type { Conversation, Member, Message, ReadState, User } from "@heming/shared";
import {
  fetchConversations,
  fetchFriends,
  fetchIncomingRequests,
  createConversation,
  fetchMessages,
  fetchMembers,
  api,
} from "../lib/api.js";

interface ChatState {
  conversations: Conversation[];
  friends: { id: string; user: User }[];
  incoming: { id: string; from: User }[];
  messages: Record<string, Message[]>;
  /** 跨群去重收集的智能体成员（雷达右下扇区；M2 仅展示，无 1:1 会话）。 */
  agents: Member[];
  /** 各会话已读状态（convId → [{userId, at}]；direct 气泡「已读」判定与 read_update 随动用）。 */
  reads: Record<string, ReadState[]>;
  loadWorkspace: () => Promise<void>;
  openDirect: (peerId: string) => Promise<string>;
  createGroup: (name: string, memberIds: string[]) => Promise<string>;
  loadAgents: () => Promise<void>;
  appendMessage: (m: Message) => void;
  setMessages: (convId: string, msgs: Message[]) => void;
  setReads: (convId: string, reads: ReadState[]) => void;
  loadReads: (convId: string) => Promise<void>;
}

export const useChatStore = create<ChatState>((set, get) => ({
  conversations: [],
  friends: [],
  incoming: [],
  messages: {},
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
    const byId = new Map<string, Member>();
    for (const list of lists) {
      for (const m of list) {
        if (m.kind === "agent" && !byId.has(m.id)) byId.set(m.id, m);
      }
    }
    set({ agents: [...byId.values()] });
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
