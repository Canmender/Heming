import { describe, it, expect, beforeEach, vi } from "vitest";
import {
  useUiStore,
  readSessionView,
  writeSessionView,
  resolvePage,
  SESSION_VIEW_KEY,
} from "./ui.js";

/**
 * 精简外壳：导航轨已删，默认落地页是会话。
 * 这条必须是本文件第一个用例——模块初始化只发生一次，之后任何 setState 都会污染它。
 */
it("默认页：模块初始 page 是 chat（没有 sessionStorage 时直接进会话）", () => {
  expect(useUiStore.getState().page).toBe("chat");
  expect(useUiStore.getState().activeConversationId).toBeNull();
});

describe("ui store 页面与会话状态", () => {
  beforeEach(() => {
    useUiStore.setState({
      page: "home",
      activeConversationId: null,
    });
  });

  it("打开会话：进入 chat 并记录当前会话", () => {
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
      JSON.stringify({ page: "collab", activeConversationId: "c9" }),
    );
    expect(readSessionView()).toEqual({ page: "collab", activeConversationId: "c9" });

    // 已删除的记忆页不在宿主页集合里：不恢复（旧链接兼容由 resolvePage 负责，不在刷新路径）
    sessionStorage.setItem(
      SESSION_VIEW_KEY,
      JSON.stringify({ page: "memory", activeConversationId: "c9" }),
    );
    expect(readSessionView()).toBeNull();

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


/**
 * 默认页与会话恢复：page 默认值改为 chat，存过的会话页在刷新后仍然优先；
 * 非法/已删除的页一律回落 chat，不再猜。
 * 模块初始化只发生一次，这里用 vi.resetModules + 动态 import 重算初始 state。
 */
describe("默认页与会话恢复（精简外壳后默认进会话）", () => {
  beforeEach(() => {
    sessionStorage.clear();
  });

  it("sessionStorage 里存过设置页：重新初始化后恢复 settings", async () => {
    sessionStorage.setItem(
      SESSION_VIEW_KEY,
      JSON.stringify({ page: "settings", activeConversationId: null }),
    );
    vi.resetModules();
    const mod = await import("./ui.js");
    expect(mod.useUiStore.getState().page).toBe("settings");
  });

  it("sessionStorage 里存过会话页：重新初始化后恢复 chat 与当前会话", async () => {
    sessionStorage.setItem(
      SESSION_VIEW_KEY,
      JSON.stringify({ page: "chat", activeConversationId: "c1" }),
    );
    vi.resetModules();
    const mod = await import("./ui.js");
    const st = mod.useUiStore.getState();
    expect(st.page).toBe("chat");
    expect(st.activeConversationId).toBe("c1");
  });

  it("sessionStorage 里是非法页：回落 chat", async () => {
    sessionStorage.setItem(
      SESSION_VIEW_KEY,
      JSON.stringify({ page: "nope", activeConversationId: null }),
    );
    vi.resetModules();
    const mod = await import("./ui.js");
    expect(mod.useUiStore.getState().page).toBe("chat");
  });

  it("sessionStorage 里是已删除的旧页：回落 chat", async () => {
    sessionStorage.setItem(
      SESSION_VIEW_KEY,
      JSON.stringify({ page: "memory", activeConversationId: null }),
    );
    vi.resetModules();
    const mod = await import("./ui.js");
    expect(mod.useUiStore.getState().page).toBe("chat");
  });

  it("插件页是合法宿主页：刷新仍能恢复到 plugin:<id>", async () => {
    sessionStorage.setItem(
      SESSION_VIEW_KEY,
      JSON.stringify({ page: "plugin:acme.page-kit", activeConversationId: null }),
    );
    vi.resetModules();
    const mod = await import("./ui.js");
    expect(mod.useUiStore.getState().page).toBe("plugin:acme.page-kit");
  });
});

/**
 * d.198：「跳到某条消息」是一次性投递槽，与 `paletteIntent` 同口径（token 自增、消费即清）。
 *
 * 为什么需要它：左栏（Sidebar → ConversationRail）拿不到 ChatPage 的滚动容器与窗口化状态，
 * 只能把「去哪一段的哪一条」交给 ChatPage 消费。
 */
describe("消息跳转投递槽（d.198）", () => {
  beforeEach(() => {
    useUiStore.setState({ activeConversationId: null, messageJump: null });
  });

  it("requestMessageJump 带上会话与消息 id，连点两次也各触发一次（token 自增）", () => {
    useUiStore.getState().requestMessageJump("c1", "m1");
    const first = useUiStore.getState().messageJump;
    expect(first).toMatchObject({ conversationId: "c1", messageId: "m1" });

    useUiStore.getState().requestMessageJump("c1", "m1");
    expect(useUiStore.getState().messageJump!.token).toBe(first!.token + 1);
  });

  it("consumeMessageJump 消费即清", () => {
    useUiStore.getState().requestMessageJump("c1", "m1");
    useUiStore.getState().consumeMessageJump();
    expect(useUiStore.getState().messageJump).toBeNull();
  });

  it("手动 openConversation 丢掉上一次没落位的跳转意图（免得下次进来乱跳）", () => {
    useUiStore.getState().requestMessageJump("c1", "m1");
    useUiStore.getState().openConversation("c2");
    expect(useUiStore.getState().messageJump).toBeNull();
    expect(useUiStore.getState().activeConversationId).toBe("c2");
  });
});
