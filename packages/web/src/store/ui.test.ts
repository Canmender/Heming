import { describe, it, expect, beforeEach } from "vitest";
import {
  useUiStore,
  DEFAULT_NAV_ORDER,
  normalizeNavOrder,
  readStoredNavOrder,
  readSessionView,
  writeSessionView,
  resolvePage,
  SESSION_VIEW_KEY,
} from "./ui.js";
import { NAV_MODE_KEY } from "../lib/navPrefs.js";

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

describe("刷新恢复：当前页与会话落 sessionStorage（d.79）", () => {
  beforeEach(() => {
    sessionStorage.clear();
    useUiStore.setState({ page: "home", activeConversationId: null });
  });

  it("打开会话后写入 sessionStorage：刷新能回到那个会话", () => {
    useUiStore.getState().openConversation("c1");
    expect(JSON.parse(sessionStorage.getItem(SESSION_VIEW_KEY)!)).toEqual({
      page: "chat",
      activeConversationId: "c1",
    });
  });

  it("离开智能体页时清掉会话，写盘的是「首页 + 无会话」", () => {
    useUiStore.getState().openConversation("c1");
    useUiStore.getState().setPage("team");
    expect(JSON.parse(sessionStorage.getItem(SESSION_VIEW_KEY)!)).toEqual({
      page: "team",
      activeConversationId: null,
    });
  });

  it("readSessionView 只认宿主页；脏值/未知页/非 JSON 一律回落 null（不猜）", () => {
    sessionStorage.setItem(
      SESSION_VIEW_KEY,
      JSON.stringify({ page: "memory", activeConversationId: "c9" }),
    );
    expect(readSessionView()).toEqual({ page: "memory", activeConversationId: "c9" });

    // 已合并的旧页 id 不在宿主页集合里：不恢复（旧链接兼容由 resolvePage 负责，不在刷新路径）
    sessionStorage.setItem(SESSION_VIEW_KEY, JSON.stringify({ page: "interfaces" }));
    expect(readSessionView()).toBeNull();

    sessionStorage.setItem(SESSION_VIEW_KEY, JSON.stringify({ page: "chat", activeConversationId: 42 }));
    expect(readSessionView()).toEqual({ page: "chat", activeConversationId: null });

    sessionStorage.setItem(SESSION_VIEW_KEY, "{oops");
    expect(readSessionView()).toBeNull();
    expect(readSessionView(null)).toBeNull();
  });

  it("writeSessionView / readSessionView 往返；存储不可用时不抛", () => {
    writeSessionView({ page: "plugins", activeConversationId: null });
    expect(readSessionView()).toEqual({ page: "plugins", activeConversationId: null });

    const broken = {
      getItem: () => {
        throw new Error("blocked");
      },
      setItem: () => {
        throw new Error("blocked");
      },
    };
    expect(() => writeSessionView({ page: "home", activeConversationId: null }, broken)).not.toThrow();
    expect(readSessionView(broken)).toBeNull();
  });
});

describe("团队动向定位：focusTeamActivity（d.90）", () => {
  beforeEach(() => {
    useUiStore.setState({
      page: "home",
      teamFocusUserId: null,
      teamFocusActivityId: null,
      activeConversationId: null,
    });
  });

  it("一次性投递「成员 + 动向 id」并进团队页", () => {
    useUiStore.getState().focusTeamActivity("act-1", "u2");
    const s = useUiStore.getState();
    expect(s.page).toBe("team");
    expect(s.teamFocusUserId).toBe("u2");
    expect(s.teamFocusActivityId).toBe("act-1");
    expect(s.activeConversationId).toBeNull();

    s.consumeTeamActivityFocus();
    expect(useUiStore.getState().teamFocusActivityId).toBeNull();
    // 成员选中是另一条槽：消费动向 id 不应把它清掉
    expect(useUiStore.getState().teamFocusUserId).toBe("u2");
  });

  it("切页（setPage）清掉两个团队定位槽，避免下次进团队页被旧意图钉住", () => {
    useUiStore.setState({ teamFocusUserId: "u2", teamFocusActivityId: "act-9" });
    useUiStore.getState().setPage("home");
    expect(useUiStore.getState().teamFocusUserId).toBeNull();
    expect(useUiStore.getState().teamFocusActivityId).toBeNull();
  });
});

describe("ui store 导航顺序", () => {
  beforeEach(() => {
    localStorage.clear();
    useUiStore.setState({ navOrder: [...DEFAULT_NAV_ORDER] });
  });

  it("默认顺序：固定 8 项（主页 / 团队 / 智能体 / 插件 / 记忆 / 知识库 / 模型 / 设置）", () => {
    // 工作台（主页 → 团队 → 智能体）→ 能力（插件）→ 资料（记忆/知识库/模型）→ 系统（设置）
    expect(useUiStore.getState().navOrder).toEqual([
      "home",
      "team",
      "chat",
      "plugins",
      "memory",
      "vault",
      "model",
      "settings",
    ]);
  });

  it("moveNav 上移/下移生效并落盘", () => {
    useUiStore.getState().moveNav("memory", -1);
    expect(useUiStore.getState().navOrder.indexOf("memory")).toBe(3);
    useUiStore.getState().moveNav("memory", 1);
    expect(useUiStore.getState().navOrder.indexOf("memory")).toBe(4);
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
      "plugins",
      "vault",
      "model",
      "settings",
    ]);
  });

  it("合并前的旧页面名折叠成宿主页，且不与已有宿主页重复", () => {
    // 老用户 localStorage 里可能还是 13 项：读回后必须只剩 10 个宿主页，
    // 顺序以旧列表中「第一次出现」的位置为准。
    // d.138：tasks 原来折叠到 { chat, view: "tasks" }，而对话页早就不认这个视图——
    // 「派任务」「新建任务」会静默落到对话 Tab。任务现在活在团队页看板里，
    // tasks 改折叠成 team/board，于是旧的 tasks 项不再占 chat 的位置，
    // chat 只能按默认顺序补到 memory 之后。
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
    ).toEqual([
      "settings",
      "team",
      "home",
      "plugins",
      "memory",
      "chat",
      "vault",
      "model",
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
      "plugins",
      "memory",
      "vault",
      "model",
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
      "team",
      "chat",
      "plugins",
      "vault",
      "model",
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
    // d.138：tasks 不再折叠到对话页的「任务视图」——那个视图早就没了，
    // 折叠过去只会静默落到对话 Tab；任务现在在团队看板里。
    expect(resolvePage("tasks")).toEqual({ page: "team", view: "board" });
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
    expect(s.page).toBe("plugin:heming.automations");
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
    expect(s.page).toBe("plugin:heming.automations");
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

/** modules 运行时下线后：旧模块页 id 一律折叠到对应插件页，入口不再被门禁拦到插件区。 */
describe("旧模块页入口折叠到插件页", () => {
  beforeEach(() => {
    useUiStore.setState({ page: "home", pageView: null, infohubIntent: null, automationIntent: null });
  });

  it("resolvePage 把旧模块页 id 折成 plugin:<id>", () => {
    expect(resolvePage("infohub")).toEqual({ page: "plugin:heming.infohub", view: null });
    expect(resolvePage("automations")).toEqual({ page: "plugin:heming.automations", view: null });
    expect(resolvePage("workflows")).toEqual({ page: "plugin:heming.automations", view: null });
    // 幕僚页已并入自动化插件的简报 Tab，没有独立插件页，落到插件区
    expect(resolvePage("staff")).toEqual({ page: "plugins", view: null });
    // 已带 plugin: 前缀的页保持原样
    expect(resolvePage("plugin:heming.infohub")).toEqual({ page: "plugin:heming.infohub", view: null });
  });

  it("openInfohub 总是进信息中枢插件页并投递检索意图", () => {
    useUiStore.getState().openInfohub({ tab: "agenda" });
    const s = useUiStore.getState();
    expect(s.page).toBe("plugin:heming.infohub");
    expect(s.infohubIntent).toEqual({ tab: "agenda" });
  });

  it("openAutomations / focusAutomation 进自动化插件页", () => {
    useUiStore.getState().openAutomations({ kind: "infohub.agenda" });
    expect(useUiStore.getState()).toMatchObject({
      page: "plugin:heming.automations",
      automationTab: "tasks",
      automationIntent: { kind: "infohub.agenda" },
    });

    useUiStore.getState().focusAutomation("a1");
    expect(useUiStore.getState()).toMatchObject({
      page: "plugin:heming.automations",
      automationFocusId: "a1",
      automationIntent: null,
    });
  });

  it("openStaff 进自动化插件的简报 Tab（幕僚简报已并入）", () => {
    useUiStore.getState().openStaff();
    expect(useUiStore.getState().page).toBe("plugin:heming.automations");
    expect(useUiStore.getState().automationTab).toBe("briefing");
  });
});

describe("知识库动作意图 vaultIntent（d.114）", () => {
  it("openVault 切页并投递意图；同类连点两次 token 递增（各自消费一次）", () => {
    useUiStore.setState({ page: "home", vaultIntent: null });
    useUiStore.getState().openVault({ kind: "new" });
    const first = useUiStore.getState();
    expect(first.page).toBe("vault");
    expect(first.vaultIntent).toMatchObject({ kind: "new" });

    useUiStore.getState().openVault({ kind: "new" });
    expect(useUiStore.getState().vaultIntent!.token).toBeGreaterThan(first.vaultIntent!.token);
  });

  it("openVault 不传意图 = 普通进入（清掉残留动作）", () => {
    useUiStore.getState().openVault({ kind: "daily" });
    useUiStore.getState().openVault();
    expect(useUiStore.getState().page).toBe("vault");
    expect(useUiStore.getState().vaultIntent).toBeNull();
  });

  it("consumeVaultIntent 消费即清；切页清掉未消费的意图", () => {
    useUiStore.getState().openVault({ kind: "settings" });
    useUiStore.getState().consumeVaultIntent();
    expect(useUiStore.getState().vaultIntent).toBeNull();

    useUiStore.getState().openVault({ kind: "settings" });
    useUiStore.getState().setPage("home");
    expect(useUiStore.getState().vaultIntent).toBeNull();
  });
});

describe("插件首页卡快捷入口意图 pluginPageIntent（d.139）", () => {
  it("先导航再投递：切页清理不会抹掉刚设的意图", () => {
    useUiStore.setState({ page: "home", pluginPageIntent: null });
    useUiStore.getState().setPage("plugin:heming.infohub");
    useUiStore.getState().setPluginPageIntent("heming.infohub", "agenda");
    expect(useUiStore.getState().page).toBe("plugin:heming.infohub");
    expect(useUiStore.getState().pluginPageIntent).toEqual({
      pluginId: "heming.infohub",
      intent: "agenda",
    });
  });

  it("顺序反了（先设再导航）会被切页清掉——文档化这个坑", () => {
    useUiStore.setState({ page: "home", pluginPageIntent: null });
    useUiStore.getState().setPluginPageIntent("heming.infohub", "agenda");
    useUiStore.getState().setPage("plugin:heming.infohub");
    expect(useUiStore.getState().pluginPageIntent).toBeNull();
  });

  it("consumePluginPageIntent 返回并清空（一过性提示，用后即清）", () => {
    useUiStore.getState().setPage("home");
    useUiStore.getState().setPluginPageIntent("heming.infohub", "archive");
    expect(useUiStore.getState().consumePluginPageIntent()).toEqual({
      pluginId: "heming.infohub",
      intent: "archive",
    });
    expect(useUiStore.getState().pluginPageIntent).toBeNull();
    expect(useUiStore.getState().consumePluginPageIntent()).toBeNull();
  });

  it("再导航 / 离开会话都会清掉未消费的残留意图", () => {
    useUiStore.getState().setPage("home");
    useUiStore.getState().setPluginPageIntent("heming.infohub", "agenda");
    useUiStore.getState().setPage("vault");
    expect(useUiStore.getState().pluginPageIntent).toBeNull();

    useUiStore.getState().setPluginPageIntent("heming.infohub", "agenda");
    useUiStore.getState().leaveConversation();
    expect(useUiStore.getState().pluginPageIntent).toBeNull();
  });
});
