import { create } from "zustand";

export type Page = "home" | "workspace" | "interfaces" | "memory" | "settings" | "chat";

interface UiState {
  page: Page;
  navCollapsed: boolean;
  activeConversationId: string | null;
  /** 通讯录雷达面板显隐（page==="chat" 时覆盖层滑出/呼出；非 chat 页恒可见）。 */
  contactsHidden: boolean;
  setPage: (page: Page) => void;
  setNavCollapsed: (v: boolean) => void;
  openConversation: (id: string) => void;
  leaveConversation: () => void;
  hideContacts: () => void;
  showContacts: () => void;
}

export const useUiStore = create<UiState>((set, get) => ({
  page: "home",
  navCollapsed: false,
  activeConversationId: null,
  contactsHidden: false,
  setPage: (page) =>
    set({ page, navCollapsed: false, activeConversationId: null, contactsHidden: false }),
  setNavCollapsed: (v) => set({ navCollapsed: v }),
  openConversation: (id) =>
    set({ page: "chat", navCollapsed: true, activeConversationId: id, contactsHidden: true }),
  leaveConversation: () => get().setPage("workspace"),
  hideContacts: () => set({ contactsHidden: true }),
  showContacts: () => set({ contactsHidden: false }),
}));
