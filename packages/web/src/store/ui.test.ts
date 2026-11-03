import { describe, it, expect, beforeEach } from "vitest";
import { useUiStore, DEFAULT_NAV_ORDER, normalizeNavOrder, readStoredNavOrder } from "./ui.js";

describe("ui store 页面与会话状态", () => {
  beforeEach(() => {
    useUiStore.setState({
      page: "home",
      activeConversationId: null,
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

  it("默认顺序（团队页紧随主页，智能体页随后）", () => {
    expect(useUiStore.getState().navOrder).toEqual([
      "home",
      "team",
      "chat",
      "staff",
      "infohub",
      "automations",
      "workspace",
      "tasks",
      "skills",
      "plugins",
      "interfaces",
      "memory",
      "settings",
    ]);
  });

  it("moveNav 上移/下移生效并落盘", () => {
    useUiStore.getState().moveNav("memory", -1);
    expect(useUiStore.getState().navOrder.indexOf("memory")).toBe(10);
    useUiStore.getState().moveNav("memory", 1);
    expect(useUiStore.getState().navOrder.indexOf("memory")).toBe(11);
    expect(JSON.parse(localStorage.getItem("heming.navOrder.v1") as string)).toEqual(
      useUiStore.getState().navOrder,
    );
  });

  it("到顶/到底与未知页为 no-op（不写盘）", () => {
    const before = useUiStore.getState().navOrder;
    useUiStore.getState().moveNav("home", -1);
    useUiStore.getState().moveNav("settings", 1);
    useUiStore.getState().moveNav("no-such-page" as never, 1);
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
      "chat",
      "home",
      "team",
      "staff",
      "infohub",
      "automations",
      "workspace",
      "tasks",
      "skills",
      "plugins",
      "interfaces",
      "settings",
    ]);
  });

  it("非数组/损坏 JSON → 默认顺序", () => {
    expect(normalizeNavOrder("不是数组")).toEqual([...DEFAULT_NAV_ORDER]);
    expect(readStoredNavOrder({ getItem: () => "坏 JSON" })).toEqual([...DEFAULT_NAV_ORDER]);
    expect(readStoredNavOrder({ getItem: () => '["settings","home"]' })).toEqual([
      "settings",
      "home",
      "team",
      "chat",
      "staff",
      "infohub",
      "automations",
      "workspace",
      "tasks",
      "skills",
      "plugins",
      "interfaces",
      "memory",
    ]);
    expect(readStoredNavOrder(null)).toEqual([...DEFAULT_NAV_ORDER]);
  });
});

describe("ui store 自动化意图", () => {
  beforeEach(() => {
    useUiStore.setState({
      page: "home",
      activeConversationId: null,
      infohubIntent: null,
      automationIntent: null,
      taskFocusId: null,
      automationFocusId: null,
    });
  });

  it("openAutomations 进入自动化页并清掉其他瞬态槽", () => {
    useUiStore.getState().openConversation("c1");
    useUiStore.getState().openInfohub({ tab: "agenda" });
    useUiStore.getState().openAutomations({
      kind: "infohub.sync",
      sync: { sources: ["qq"], full: true, archive: false },
    });

    const s = useUiStore.getState();
    expect(s.page).toBe("automations");
    expect(s.activeConversationId).toBeNull();
    expect(s.infohubIntent).toBeNull();
    expect(s.automationIntent).toEqual({
      kind: "infohub.sync",
      sync: { sources: ["qq"], full: true, archive: false },
    });

    s.consumeAutomationIntent();
    expect(useUiStore.getState().automationIntent).toBeNull();
  });

  it("不带意图进入或切页时，旧意图不会残留", () => {
    useUiStore.getState().openAutomations({ kind: "infohub.agenda" });
    useUiStore.getState().openAutomations();
    expect(useUiStore.getState().automationIntent).toBeNull();

    useUiStore.getState().openAutomations({ kind: "infohub.agenda" });
    useUiStore.getState().setPage("home");
    expect(useUiStore.getState().automationIntent).toBeNull();
  });

  it("focusAutomation 进入自动化页并投递选中任务，消费后清空", () => {
    useUiStore.setState({
      activeConversationId: "c1",
      automationIntent: { kind: "infohub.sync" },
      taskFocusId: "t1",
    });
    useUiStore.getState().focusAutomation("a1");

    const s = useUiStore.getState();
    expect(s.page).toBe("automations");
    expect(s.automationFocusId).toBe("a1");
    // 跳转带过来的旧瞬态必须一起清掉：否则自动化页一进去就弹新建表单，
    // 任务区那边还残留一个「要选中」的 id。
    expect(s.automationIntent).toBeNull();
    expect(s.taskFocusId).toBeNull();
    expect(s.activeConversationId).toBeNull();

    s.consumeAutomationFocus();
    expect(useUiStore.getState().automationFocusId).toBeNull();
  });

  it("切页 / 开会话会清掉未消费的 automationFocusId", () => {
    useUiStore.getState().focusAutomation("a1");
    useUiStore.getState().setPage("home");
    expect(useUiStore.getState().automationFocusId).toBeNull();

    useUiStore.getState().focusAutomation("a1");
    useUiStore.getState().openConversation("c1");
    expect(useUiStore.getState().automationFocusId).toBeNull();
  });
});
