import { create } from "zustand";

export type Page = "home" | "workspace" | "interfaces" | "memory" | "settings" | "chat";

/** 联系人详情三类：群聊 / 人类好友 / 智能体（雷达扇区同口径）。 */
export type ContactKind = "group" | "human" | "agent";

/** 右栏目录投递的单文件槽：文件已在共享库，直接经 WS 发 payload.file，不再走上传。 */
export interface PendingAttachment {
  conversationId: string;
  file: { id: string; name: string; mime: string; size: number };
}

interface UiState {
  page: Page;
  navCollapsed: boolean;
  activeConversationId: string | null;
  /** 通讯录雷达面板显隐（page==="chat" 时覆盖层滑出/呼出；非 chat 页恒可见）。 */
  contactsHidden: boolean;
  /** 工作区联系人详情目标（null=雷达主视图；置位=分组竖列+详情卡）。切页时清空。 */
  detailContact: { kind: ContactKind; id: string } | null;
  /** 右栏「发送到会话」待投递单槽（null=无）。切页时清空；ChatPage 命中目标会话即消费。 */
  pendingAttachment: PendingAttachment | null;
  setPage: (page: Page) => void;
  setNavCollapsed: (v: boolean) => void;
  openConversation: (id: string) => void;
  leaveConversation: () => void;
  hideContacts: () => void;
  showContacts: () => void;
  openContactDetail: (kind: ContactKind, id: string) => void;
  closeContactDetail: () => void;
  /** 置入待投递槽（单槽：后写覆盖先写）。 */
  sendFileToConversation: (conversationId: string, file: PendingAttachment["file"]) => void;
  /** 消费待投递槽（发出即清空）。 */
  consumePendingAttachment: () => void;
}

export const useUiStore = create<UiState>((set, get) => ({
  page: "home",
  navCollapsed: false,
  activeConversationId: null,
  contactsHidden: false,
  detailContact: null,
  pendingAttachment: null,
  setPage: (page) =>
    set({
      page,
      navCollapsed: false,
      activeConversationId: null,
      contactsHidden: false,
      detailContact: null,
      pendingAttachment: null,
    }),
  setNavCollapsed: (v) => set({ navCollapsed: v }),
  openConversation: (id) =>
    set({ page: "chat", navCollapsed: true, activeConversationId: id, contactsHidden: true }),
  leaveConversation: () => get().setPage("workspace"),
  hideContacts: () => set({ contactsHidden: true }),
  showContacts: () => set({ contactsHidden: false }),
  openContactDetail: (kind, id) => set({ detailContact: { kind, id } }),
  closeContactDetail: () => set({ detailContact: null }),
  sendFileToConversation: (conversationId, file) =>
    set({ pendingAttachment: { conversationId, file } }),
  consumePendingAttachment: () => set({ pendingAttachment: null }),
}));
