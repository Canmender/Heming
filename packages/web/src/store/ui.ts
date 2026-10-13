import { create } from "zustand";

export type Page = "home" | "workspace" | "interfaces" | "memory" | "settings" | "chat";

interface UiState {
  page: Page;
  navCollapsed: boolean;
  activeConversationId: string | null;
  setPage: (page: Page) => void;
  setNavCollapsed: (v: boolean) => void;
  openConversation: (id: string) => void;
  leaveConversation: () => void;
}

export const useUiStore = create<UiState>((set, get) => ({
  page: "home",
  navCollapsed: false,
  activeConversationId: null,
  setPage: (page) => set({ page, navCollapsed: false, activeConversationId: null }),
  setNavCollapsed: (v) => set({ navCollapsed: v }),
  openConversation: (id) => set({ page: "chat", navCollapsed: true, activeConversationId: id }),
  leaveConversation: () => get().setPage("workspace"),
}));
