import { describe, it, expect, beforeEach } from "vitest";
import { useUiStore } from "./ui.js";

describe("ui store 导航显隐", () => {
  beforeEach(() => {
    useUiStore.setState({
      page: "home",
      navCollapsed: false,
      activeConversationId: null,
      contactsHidden: false,
    });
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

  it("打开会话同时隐藏通讯录（contactsHidden → true）", () => {
    useUiStore.getState().showContacts();
    expect(useUiStore.getState().contactsHidden).toBe(false);
    useUiStore.getState().openConversation("c1");
    expect(useUiStore.getState().contactsHidden).toBe(true);
  });

  it("切到非聊天页复位通讯录可见（contactsHidden → false）", () => {
    useUiStore.getState().openConversation("c1");
    expect(useUiStore.getState().contactsHidden).toBe(true);
    useUiStore.getState().setPage("workspace");
    expect(useUiStore.getState().contactsHidden).toBe(false);
  });

  it("showContacts 仅恢复通讯录、不改页与当前会话", () => {
    useUiStore.getState().openConversation("c1");
    useUiStore.getState().showContacts();
    const s = useUiStore.getState();
    expect(s.contactsHidden).toBe(false);
    expect(s.page).toBe("chat");
    expect(s.activeConversationId).toBe("c1");
    expect(s.navCollapsed).toBe(true);
  });

  it("hideContacts 仅隐藏、不改页", () => {
    useUiStore.getState().openConversation("c1");
    useUiStore.getState().showContacts();
    useUiStore.getState().hideContacts();
    const s = useUiStore.getState();
    expect(s.contactsHidden).toBe(true);
    expect(s.page).toBe("chat");
    expect(s.activeConversationId).toBe("c1");
  });

  it("openContactDetail/closeContactDetail 与 setPage 清空", () => {
    const s = useUiStore.getState();
    s.openContactDetail("human", "u1");
    expect(useUiStore.getState().detailContact).toEqual({ kind: "human", id: "u1" });
    useUiStore.getState().setPage("home");
    expect(useUiStore.getState().detailContact).toBeNull();
    useUiStore.getState().openContactDetail("agent", "a1");
    useUiStore.getState().closeContactDetail();
    expect(useUiStore.getState().detailContact).toBeNull();
  });

  it("sendFileToConversation/consumePendingAttachment 单槽语义", () => {
    useUiStore
      .getState()
      .sendFileToConversation("c1", { id: "f1", name: "a.png", mime: "image/png", size: 3 });
    expect(useUiStore.getState().pendingAttachment).toEqual({
      conversationId: "c1",
      file: { id: "f1", name: "a.png", mime: "image/png", size: 3 },
    });
    useUiStore.getState().consumePendingAttachment();
    expect(useUiStore.getState().pendingAttachment).toBeNull();
  });

  it("setPage 清空 pendingAttachment", () => {
    useUiStore
      .getState()
      .sendFileToConversation("c1", { id: "f1", name: "a", mime: "text/plain", size: 1 });
    useUiStore.getState().setPage("home");
    expect(useUiStore.getState().pendingAttachment).toBeNull();
  });
});
