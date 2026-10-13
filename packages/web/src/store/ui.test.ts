import { describe, it, expect, beforeEach } from "vitest";
import { useUiStore } from "./ui.js";

describe("ui store 导航显隐", () => {
  beforeEach(() => {
    useUiStore.setState({ page: "home", navCollapsed: false, activeConversationId: null });
  });

  it("默认主页且导航展开", () => {
    const s = useUiStore.getState();
    expect(s.page).toBe("home");
    expect(s.navCollapsed).toBe(false);
  });

  it("打开会话时导航完全收起", () => {
    useUiStore.getState().openConversation("c1");
    const s = useUiStore.getState();
    expect(s.page).toBe("chat");
    expect(s.navCollapsed).toBe(true);
    expect(s.activeConversationId).toBe("c1");
  });

  it("切回非聊天页时恢复展开", () => {
    useUiStore.getState().openConversation("c1");
    useUiStore.getState().setPage("home");
    expect(useUiStore.getState().navCollapsed).toBe(false);
  });

  it("可手动收起/展开", () => {
    useUiStore.getState().setNavCollapsed(true);
    expect(useUiStore.getState().navCollapsed).toBe(true);
    useUiStore.getState().setNavCollapsed(false);
    expect(useUiStore.getState().navCollapsed).toBe(false);
  });
});
