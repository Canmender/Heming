import { describe, it, expect, beforeEach } from "vitest";
import { useUiStore, DEFAULT_NAV_ORDER, normalizeNavOrder, readStoredNavOrder, resolvePage } from "./ui.js";
import { NAV_MODE_KEY } from "../lib/navPrefs.js";
import { useModuleStore } from "../lib/modules/store.js";

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

  it("默认顺序（d.72 重排后 9 个宿主页）", () => {
    // 工作台（主页 → 智能体 → 团队）→ 智能模块 → 资料与能力 → 系统
    expect(useUiStore.getState().navOrder).toEqual([
      "home",
      "chat",
      "team",
      "staff",
      "infohub",
      "automations",
      "plugins",
      "memory",
      "settings",
    ]);
  });

  it("moveNav 上移/下移生效并落盘", () => {
    useUiStore.getState().moveNav("memory", -1);
    expect(useUiStore.getState().navOrder.indexOf("memory")).toBe(6);
    useUiStore.getState().moveNav("memory", 1);
    expect(useUiStore.getState().navOrder.indexOf("memory")).toBe(7);
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
      "plugins",
      "settings",
    ]);
  });

  it("合并前的旧页面名折叠成宿主页，且不与已有宿主页重复", () => {
    // 老用户 localStorage 里可能还是 13 项：读回后必须只剩 9 个宿主页，
    // 顺序以旧列表中「第一次出现」的位置为准。
    expect(
      normalizeNavOrder([
        "settings",
        "workspace",
        "home",
        "skills",
        "tasks",
        "interfaces",
        "memory",
      ]),
    ).toEqual(["settings", "team", "home", "plugins", "chat", "memory", "staff", "infohub", "automations"]);
  });

  it("非数组/损坏 JSON → 默认顺序", () => {
    expect(normalizeNavOrder("不是数组")).toEqual([...DEFAULT_NAV_ORDER]);
    expect(readStoredNavOrder({ getItem: () => "坏 JSON" })).toEqual([...DEFAULT_NAV_ORDER]);
    expect(readStoredNavOrder({ getItem: () => '["settings","home"]' })).toEqual([
      "settings",
      "home",
      "chat",
      "team",
      "staff",
      "infohub",
      "automations",
      "plugins",
      "memory",
    ]);
    expect(readStoredNavOrder(null)).toEqual([...DEFAULT_NAV_ORDER]);
  });

  it("没动过顺序的老用户跟随新默认顺序；自定义顺序原样保留", () => {
    const legacyDefault = JSON.stringify([
      "home",
      "team",
      "chat",
      "staff",
      "infohub",
      "automations",
      "plugins",
      "memory",
      "settings",
    ]);
    expect(readStoredNavOrder({ getItem: () => legacyDefault })).toEqual([...DEFAULT_NAV_ORDER]);
    // 用户亲手排过的顺序（哪怕很短）不被升级覆盖
    expect(readStoredNavOrder({ getItem: () => '["memory","settings"]' })).toEqual([
      "memory",
      "settings",
      "home",
      "chat",
      "team",
      "staff",
      "infohub",
      "automations",
      "plugins",
    ]);
  });
});

describe("d.67 页面合并：旧页面 id 折叠成宿主页 + 视图意图", () => {
  beforeEach(() => {
    useUiStore.setState({
      page: "home",
      pageView: null,
      activeConversationId: null,
      taskFocusId: null,
      automationFocusId: null,
      infohubIntent: null,
      automationIntent: null,
    });
  });

  it("resolvePage 折叠四个已合并页面", () => {
    expect(resolvePage("workspace")).toEqual({ page: "team", view: "board" });
    expect(resolvePage("tasks")).toEqual({ page: "chat", view: "tasks" });
    expect(resolvePage("skills")).toEqual({ page: "plugins", view: "skills" });
    expect(resolvePage("interfaces")).toEqual({ page: "plugins", view: "interfaces" });
    // 宿主页本身不产生视图意图
    expect(resolvePage("home")).toEqual({ page: "home", view: null });
    // 显式 view 优先于旧页面的默认视图
    expect(resolvePage("interfaces", "skills")).toEqual({ page: "plugins", view: "skills" });
  });

  it("setPage 折叠旧 id 并投递一次性视图意图，consumePageView 取走即清", () => {
    useUiStore.getState().setPage("skills");
    expect(useUiStore.getState().page).toBe("plugins");
    expect(useUiStore.getState().pageView).toBe("skills");
    expect(useUiStore.getState().consumePageView()).toBe("skills");
    expect(useUiStore.getState().pageView).toBeNull();
    // 已经消费过：再取是 null（页面 effect 不会重复切 Tab）
    expect(useUiStore.getState().consumePageView()).toBeNull();
  });

  it("普通切页把视图意图清掉（不把上一个宿主的 Tab 带过来）", () => {
    useUiStore.getState().setPage("tasks");
    useUiStore.getState().setPage("home");
    expect(useUiStore.getState().pageView).toBeNull();
  });

  it("focusTask 进智能体页的任务视图（任务区已并入）", () => {
    useUiStore.getState().focusTask("t1", "c1");
    const s = useUiStore.getState();
    expect(s.page).toBe("chat");
    expect(s.pageView).toBe("tasks");
    expect(s.taskFocusId).toBe("t1");
    expect(s.activeConversationId).toBe("c1");
  });

  it("openConversation 从通知/会话入口进来时显式切回对话视图（不落进任务 Tab）", () => {
    useUiStore.getState().setPage("tasks");
    useUiStore.getState().openConversation("c1");
    expect(useUiStore.getState().page).toBe("chat");
    // "chat" 视图意图会插队覆盖掉刚才的 "tasks"：通知点进来必须看见对话
    expect(useUiStore.getState().pageView).toBe("chat");
    expect(useUiStore.getState().consumePageView()).toBe("chat");
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

/**
 * 导航栏显示模式（d.68）：pinned（默认常显）/ auto（自动隐藏）。
 * store 只做状态与持久化；解析/坏值回落由 lib/navPrefs 的用例覆盖。
 */
describe("ui store 导航栏模式", () => {
  beforeEach(() => {
    localStorage.clear();
    useUiStore.setState({ navMode: "pinned", navOpen: false });
  });

  it("默认常显，浮层默认收起", () => {
    const s = useUiStore.getState();
    expect(s.navMode).toBe("pinned");
    expect(s.navOpen).toBe(false);
  });

  it("setNavMode 切换并落盘；切档时收起浮层", () => {
    useUiStore.getState().openNav(); // pinned 下 openNav 是 no-op
    expect(useUiStore.getState().navOpen).toBe(false);

    useUiStore.getState().setNavMode("auto");
    expect(useUiStore.getState().navMode).toBe("auto");
    expect(localStorage.getItem(NAV_MODE_KEY)).toBe("auto");

    useUiStore.getState().openNav();
    expect(useUiStore.getState().navOpen).toBe(true);

    // 切回 pinned：浮层必须一起收起，否则会出现「常显 + 还挂着浮层」的半展开态
    useUiStore.getState().setNavMode("pinned");
    expect(useUiStore.getState().navMode).toBe("pinned");
    expect(useUiStore.getState().navOpen).toBe(false);
    expect(localStorage.getItem(NAV_MODE_KEY)).toBe("pinned");
  });

  it("toggleNavMode 在固定 ↔ 自动之间来回", () => {
    useUiStore.getState().toggleNavMode();
    expect(useUiStore.getState().navMode).toBe("auto");
    useUiStore.getState().toggleNavMode();
    expect(useUiStore.getState().navMode).toBe("pinned");
  });

  it("Ctrl+B 语义（toggleNav）：pinned → 切 auto；auto → 展开/收起浮层", () => {
    useUiStore.getState().toggleNav();
    expect(useUiStore.getState().navMode).toBe("auto");
    expect(useUiStore.getState().navOpen).toBe(false);

    useUiStore.getState().toggleNav();
    expect(useUiStore.getState().navOpen).toBe(true);
    useUiStore.getState().toggleNav();
    expect(useUiStore.getState().navOpen).toBe(false);
    // 收起浮层 ≠ 放弃自动隐藏：再按一次还能呼出
    useUiStore.getState().toggleNav();
    expect(useUiStore.getState().navOpen).toBe(true);
    expect(useUiStore.getState().navMode).toBe("auto");
  });

  it("openNav/closeNav 只在 auto 下对浮层生效", () => {
    useUiStore.getState().openNav();
    expect(useUiStore.getState().navOpen).toBe(false);

    useUiStore.getState().setNavMode("auto");
    useUiStore.getState().openNav();
    expect(useUiStore.getState().navOpen).toBe(true);
    useUiStore.getState().closeNav();
    expect(useUiStore.getState().navOpen).toBe(false);
    // 重复 close 不产生额外状态变化（幂等）
    useUiStore.getState().closeNav();
    expect(useUiStore.getState().navOpen).toBe(false);
  });
});

/** d.71：停用模块的通知/旧链接不能静默不动，统一落到「插件区 → 模块」。 */
describe("模块停用时的跳转落点", () => {
  beforeEach(() => {
    useModuleStore.getState().reset();
    useUiStore.setState({ page: "home", pageView: null, infohubIntent: null, automationIntent: null });
  });

  it("openInfohub：模块停用 → 插件区模块 Tab；启用 → 信息中枢页", () => {
    useModuleStore.getState().setEnabled("infohub", false);
    useUiStore.getState().openInfohub({ tab: "agenda" });
    let s = useUiStore.getState();
    expect(s.page).toBe("plugins");
    expect(s.pageView).toBe("modules");
    expect(s.infohubIntent).toBeNull();

    useModuleStore.getState().setEnabled("infohub", true);
    useUiStore.getState().openInfohub({ tab: "agenda" });
    s = useUiStore.getState();
    expect(s.page).toBe("infohub");
    expect(s.infohubIntent).toEqual({ tab: "agenda" });
  });

  it("openAutomations / focusAutomation：模块停用 → 模块管理，不留下选中态", () => {
    useModuleStore.getState().setEnabled("automations", false);
    useUiStore.getState().openAutomations({ kind: "infohub.agenda" });
    expect(useUiStore.getState().page).toBe("plugins");
    expect(useUiStore.getState().pageView).toBe("modules");

    useUiStore.getState().focusAutomation("a1");
    expect(useUiStore.getState()).toMatchObject({
      page: "plugins",
      pageView: "modules",
      automationFocusId: null,
      automationIntent: null,
    });
  });

  it("openStaff：停用 → 模块管理；启用 → 幕僚页", () => {
    useModuleStore.getState().setEnabled("staff", false);
    useUiStore.getState().openStaff();
    expect(useUiStore.getState().page).toBe("plugins");
    expect(useUiStore.getState().pageView).toBe("modules");

    useModuleStore.getState().setEnabled("staff", true);
    useUiStore.getState().openStaff();
    expect(useUiStore.getState().page).toBe("staff");
  });
});
