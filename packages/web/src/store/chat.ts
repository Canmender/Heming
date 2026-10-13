import { create } from "zustand";
import type { Message, User } from "@heming/shared";
import {
  fetchConversations,
  fetchFriends,
  fetchIncomingRequests,
  createConversation,
  fetchMessages,
} from "../lib/api.js";

interface ChatState {
  conversations: { id: string; type: "direct"; peer: User }[];
  friends: { id: string; user: User }[];
  incoming: { id: string; from: User }[];
  messages: Record<string, Message[]>;
  loadWorkspace: () => Promise<void>;
  openDirect: (peerId: string) => Promise<string>;
  appendMessage: (m: Message) => void;
  setMessages: (convId: string, msgs: Message[]) => void;
}

export const useChatStore = create<ChatState>((set, get) => ({
  conversations: [],
  friends: [],
  incoming: [],
  messages: {},
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
    if (!get().conversations.some((c) => c.id === conv.id)) {
      set({ conversations: [...get().conversations, conv] });
    }
    await get().loadWorkspace();
    return conv.id;
  },
  appendMessage(m) {
    const list = get().messages[m.conversationId] ?? [];
    if (list.some((x) => x.id === m.id)) return;
    set({ messages: { ...get().messages, [m.conversationId]: [...list, m] } });
  },
  setMessages(convId, msgs) {
    set({ messages: { ...get().messages, [convId]: msgs } });
  },
}));
