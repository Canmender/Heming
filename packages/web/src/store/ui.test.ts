import { describe, it, expect, beforeEach } from "vitest";
import { useUiStore, DEFAULT_NAV_ORDER, normalizeNavOrder, readStoredNavOrder } from "./ui.js";

describe("ui store 页面与会话状态", () => {
  beforeEach(() => {
    useUiStore.setState({
      page: "home",
      activeConversationId: null,
      contactsHidden: false,
    });
  });

  it("默认主页", () => {
    expect(useUiStore.getState().page).toBe("home");
  });

  it("打开会话：进入 chat 并记录当前会话（导航轨不再折叠）", () => {
    useUiStore.getState().openConversation("c1");
    const s = useUiStore.getState();
    expect(s.page).toBe("chat");
    expect(s.activeConversationId).toBe("c1");
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

describe("ui store 导航顺序", () => {
  beforeEach(() => {
    localStorage.clear();
    useUiStore.setState({ navOrder: [...DEFAULT_NAV_ORDER] });
  });

  it("默认顺序（会话页紧随主页）", () => {
    expect(useUiStore.getState().navOrder).toEqual([
      "home",
      "conversations",
      "infohub",
      "workspace",
      "tasks",
      "skills",
      "plugins",
      "interfaces",
      "memory",
      "archive",
      "settings",
    ]);
  });

  it("moveNav 上移/下移生效并落盘", () => {
    useUiStore.getState().moveNav("memory", -1);
    expect(useUiStore.getState().navOrder.indexOf("memory")).toBe(7);
    useUiStore.getState().moveNav("memory", 1);
    expect(useUiStore.getState().navOrder.indexOf("memory")).toBe(8);
    expect(JSON.parse(localStorage.getItem("heming.navOrder.v1") as string)).toEqual(
      useUiStore.getState().navOrder,
    );
  });

  it("到顶/到底与未知页为 no-op（不写盘）", () => {
    const before = useUiStore.getState().navOrder;
    useUiStore.getState().moveNav("home", -1);
    useUiStore.getState().moveNav("settings", 1);
    useUiStore.getState().moveNav("chat" as never, 1);
    expect(useUiStore.getState().navOrder).toEqual(before);
  });

  it("恢复默认", () => {
    useUiStore.getState().setNavOrder(["settings", "memory", "home"]);
    expect(useUiStore.getState().navOrder[0]).toBe("settings");
    useUiStore.getState().resetNavOrder();
    expect(useUiStore.getState().navOrder).toEqual([...DEFAULT_NAV_ORDER]);
  });
});

describe("normalizeNavOrder / readStoredNavOrder", () => {
  it("去重、剔除未知页、缺失项补在末尾", () => {
    expect(normalizeNavOrder(["memory", "memory", "chat", 42, "home"])).toEqual([
      "memory",
      "home",
      "conversations",
      "infohub",
      "workspace",
      "tasks",
      "skills",
      "plugins",
      "interfaces",
      "archive",
      "settings",
    ]);
  });

  it("非数组/损坏 JSON → 默认顺序", () => {
    expect(normalizeNavOrder("不是数组")).toEqual([...DEFAULT_NAV_ORDER]);
    expect(readStoredNavOrder({ getItem: () => "坏 JSON" })).toEqual([...DEFAULT_NAV_ORDER]);
    expect(readStoredNavOrder({ getItem: () => '["settings","home"]' })).toEqual([
      "settings",
      "home",
      "conversations",
      "infohub",
      "workspace",
      "tasks",
      "skills",
      "plugins",
      "interfaces",
      "memory",
      "archive",
    ]);
    expect(readStoredNavOrder(null)).toEqual([...DEFAULT_NAV_ORDER]);
  });
});
