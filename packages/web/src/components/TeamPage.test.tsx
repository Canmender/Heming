import { beforeEach, describe, expect, it, vi } from "vitest";
import { fireEvent, render, screen, waitFor, within } from "@testing-library/react";
import type { TeamActivity, TeamUsageResponse } from "@heming/shared";
import {
  clearMyTeamUsage,
  fetchTeam,
  fetchTeamActivities,
  fetchTeamUsage,
  fetchWorkspaceTeams,
  fetchWorkspaceTeam,
  updateTeamTask,
  uploadTeamActivities,
  uploadTeamUsage,
} from "../lib/api.js";
import { TeamPage } from "./TeamPage.js";
import { useAuthStore } from "../store/auth.js";
import { useUiStore } from "../store/ui.js";
import { useTokenUsageStore } from "../store/tokenUsage.js";
import { useInfohubStore } from "../lib/infohub/store.js";
import { useTaskStore, type TaskRecord } from "../lib/tasks/store.js";
import { DEFAULT_TEAM_SHARE, useTeamShareStore } from "../lib/team/share.js";

// 只替换团队相关的 API：其余导出（getToken 等）必须保留真实实现，
// 否则 auth store 初始化就会炸。
vi.mock("../lib/api.js", async (importOriginal) => {
  const actual = await importOriginal<typeof import("../lib/api.js")>();
  return {
    ...actual,
    fetchTeam: vi.fn(),
    fetchTeamActivities: vi.fn(),
    fetchTeamUsage: vi.fn(),
    uploadTeamActivities: vi.fn(),
    uploadTeamUsage: vi.fn(),
    clearMyTeamActivities: vi.fn(),
    clearMyTeamUsage: vi.fn(),
    fetchWorkspaceTeams: vi.fn(),
    fetchWorkspaceTeam: vi.fn(),
    updateTeamTask: vi.fn(),
  };
});

/**
 * 团队页 ②-3：用量排行（默认与同队成员共享，可手动关闭）与团队日程（只读摘要）。
 *
 * 两个验收重点：
 * - 隐私：关闭共享时**不采集、不上传**，请求体里只有白名单字段；默认共享的也只是白名单摘要。
 * - 口径：排行按 token 降序，未上报单独展示（不是 0）。
 */

const me = { id: "u1", username: "alice", displayName: "爱丽丝" };
const bob = { id: "u2", username: "bob", displayName: "鲍勃" };
const nowIso = new Date().toISOString();

/** d.153 起共享是默认行为：设置里只剩三个水位字段，没有逐类开关。 */
const SHARED = { ...DEFAULT_TEAM_SHARE };

/** 服务端自建团队列表：团队页页头用它渲染「切换团队」。 */
const workspaceTeams = [
  {
    id: "team-1",
    name: "同事的团队",
    goal: "",
    ownerId: me.id,
    createdAt: nowIso,
    updatedAt: nowIso,
  },
];

/** 默认共享下用于验证「挂载即同步」的本机任务（只上白名单摘要，提示词不出本机）。 */
const taskRecord: TaskRecord = {
  id: "t1",
  conversationId: "c1",
  agentId: "a1",
  agentName: "小鸣",
  title: "整理周报",
  prompt: "不该上传的提示词",
  status: "running",
  createdAt: Date.now() - 60_000,
  updatedAt: Date.now(),
  steps: [],
};

function member(user: typeof me, online = false) {
  return { user, lastSeenAt: nowIso, online };
}

function activity(over: Partial<TeamActivity>): TeamActivity {
  return {
    id: "a1",
    actorId: me.id,
    kind: "agenda",
    title: "项目周会",
    detail: "日程 · 今天到期",
    sourceId: "agenda:1",
    occurredAt: nowIso,
    createdAt: nowIso,
    ...over,
  };
}

function usageResponse(over: Partial<TeamUsageResponse> = {}): TeamUsageResponse {
  return {
    range: "7d",
    from: "2026-10-27",
    to: "2026-11-02",
    self: {
      total: 1234,
      unreported: 2,
      byModel: [
        { model: "gpt-x", tokens: 1000, unreported: 1, connections: ["主连接"] },
        { model: "claude-y", tokens: 234, unreported: 1, connections: [] },
      ],
      byDay: [{ date: "2026-11-02", tokens: 1234, unreported: 2 }],
    },
    ranking: [
      { userId: bob.id, displayName: "鲍勃", tokens: 9000, unreported: 0, days: 3 },
      { userId: me.id, displayName: "爱丽丝", tokens: 1234, unreported: 2, days: 1 },
    ],
    ...over,
  };
}

beforeEach(() => {
  localStorage.clear();
  sessionStorage.clear();
  useTeamShareStore.setState({ settings: { ...DEFAULT_TEAM_SHARE } });
  useAuthStore.setState({ token: "t1", user: me, status: "authed", error: null });
  useUiStore.setState({ page: "team", pageView: null, activeConversationId: null, teamFocusUserId: null });
  useInfohubStore.setState({ running: false, available: false, agenda: null });
  useTokenUsageStore.setState({
    records: [
      { model: "gpt-x", tokens: 700, at: nowIso, profileLabel: "主连接" },
      { model: "gpt-x", tokens: null, at: nowIso, profileLabel: "主连接" },
    ],
  });
  vi.mocked(fetchTeam).mockResolvedValue({
    members: [member(me, true), member(bob)],
    onlineCount: 1,
  });
  vi.mocked(fetchTeamActivities).mockResolvedValue({ activities: [] });
  vi.mocked(fetchTeamUsage).mockResolvedValue(usageResponse());
  vi.mocked(uploadTeamActivities).mockResolvedValue({ inserted: 0, skipped: 0 });
  vi.mocked(uploadTeamUsage).mockResolvedValue({ written: 0, stored: 0 });
  vi.mocked(clearMyTeamUsage).mockResolvedValue({ deleted: 0 });
  vi.mocked(fetchWorkspaceTeams).mockResolvedValue({ teams: workspaceTeams });
  vi.mocked(fetchWorkspaceTeam).mockResolvedValue({
    team: workspaceTeams[0],
    members: [
      { user: me, role: "owner", joinedAt: nowIso },
      { user: bob, role: "member", joinedAt: nowIso },
    ],
    plans: [],
    tasks: [],
  });
  for (const fn of [
    fetchTeam,
    fetchTeamActivities,
    fetchTeamUsage,
    fetchWorkspaceTeams,
    fetchWorkspaceTeam,
    uploadTeamActivities,
    uploadTeamUsage,
    clearMyTeamUsage,
  ]) {
    vi.mocked(fn).mockClear();
  }
});

async function renderPage() {
  render(<TeamPage />);
  // 页头副标题是「与你在同一团队的同事」，改用成员名作为「数据已到位」信号。
  await screen.findAllByText(/爱丽丝|鲍勃/);
}

describe("团队视图页签（③-1 roving tabindex）", () => {
  it("命令面板的 focus-tab 意图把团队页切到指定页签，且消费即清（d.142）", async () => {
    useUiStore.setState({
      paletteIntent: { kind: "focus-tab", token: 7, data: { page: "team", tab: "usage" } },
    });
    render(<TeamPage />);
    await waitFor(() =>
      expect(screen.getByRole("tab", { name: "用量" })).toHaveAttribute("aria-selected", "true"),
    );
    expect(useUiStore.getState().paletteIntent).toBeNull();
  });

  it("整组一个 Tab 停靠点，←/→ 切换视图并联动 tabpanel", async () => {
    await renderPage();
    const list = screen.getByRole("tablist", { name: "团队视图" });
    const workspace = within(list).getByRole("tab", { name: "工作台" });
    const feed = within(list).getByRole("tab", { name: "动向" });
    const board = within(list).getByRole("tab", { name: "看板" });

    expect(workspace).toHaveAttribute("tabindex", "-1");
    expect(feed).toHaveAttribute("tabindex", "0");

    feed.focus();
    fireEvent.keyDown(feed, { key: "ArrowRight" });
    expect(board).toHaveAttribute("aria-selected", "true");
    expect(document.activeElement).toBe(board);
    const panel = screen.getByRole("tabpanel");
    // id 用 useId 生成（同屏挂两份也不撞车），所以断言「关系」而不是字面量：
    expect(board).toHaveAttribute("aria-controls", panel.getAttribute("id"));
    expect(panel).toHaveAttribute("aria-labelledby", board.getAttribute("id"));

    fireEvent.keyDown(board, { key: "Home" });
    expect(workspace).toHaveAttribute("aria-selected", "true");
    expect(document.activeElement).toBe(workspace);
  });

  it("同屏挂两份也不产生重复 id（useId 前缀）", async () => {
    render(<TeamPage />);
    render(<TeamPage />);
    await screen.findAllByText(/爱丽丝|鲍勃/);
    const panelIds = screen.getAllByRole("tabpanel").map((el) => el.id);
    expect(new Set(panelIds).size).toBe(panelIds.length);
    const tabIds = screen.getAllByRole("tab").map((el) => el.id);
    expect(new Set(tabIds).size).toBe(tabIds.length);
    // 面板按需挂载，所以只有当前选中页签带 aria-controls（指向真实存在的面板），
    // 未选中页签不写悬空引用。两份实例各有一条有效引用。
    const controlled = screen
      .getAllByRole("tab")
      .map((el) => el.getAttribute("aria-controls"))
      .filter((id): id is string => id !== null);
    expect(controlled).toHaveLength(2);
    for (const id of controlled) {
      expect(document.getElementById(id)).not.toBeNull();
    }
  });

  it("页签行常驻页头下方（不再被名册挤到右栏，也不再在工作台视图消失）", async () => {
    await renderPage();
    const list = screen.getByRole("tablist", { name: "团队视图" });
    const row = list.parentElement as HTMLElement;
    // 与模型/插件页同一套位置：页头正下方的通栏行、同左右内边距
    expect(row.className).toContain("border-line-soft");
    expect(row.className).toContain("px-6");
    // 此前页签挂在右栏 <main> 里、被 300px 名册 aside 挤到右边
    expect(list.closest("aside")).toBeNull();
    // 五个页签都带 14px 图标
    for (const label of ["工作台", "动向", "看板", "团队日程", "用量"]) {
      expect(
        within(list).getByRole("tab", { name: label }).querySelector("svg"),
        `${label} 页签缺图标`,
      ).not.toBeNull();
    }

    // 工作台视图此前 headerExtra=null、页签整条消失（进去就切不出来）：现在仍在，且能切回动向
    fireEvent.click(within(list).getByRole("tab", { name: "工作台" }));
    expect(within(list).getByRole("tab", { name: "工作台" })).toHaveAttribute("aria-selected", "true");
    fireEvent.click(within(list).getByRole("tab", { name: "动向" }));
    expect(within(list).getByRole("tab", { name: "动向" })).toHaveAttribute("aria-selected", "true");
  });
});

describe("团队用量与共享（d.153：全部共享，没有逐类开关）", () => {
  it("页头没有共享开关、也没有「共享 N/3」徽标，只说明默认共享", async () => {
    await renderPage();
    expect(screen.queryByLabelText("任务摘要")).toBeNull();
    expect(screen.queryByLabelText("日程摘要")).toBeNull();
    expect(screen.queryByLabelText("用量排行")).toBeNull();
    expect(screen.queryByText(/共享 \d\/3/)).toBeNull();
    // 说明从「选择要共享的部分」改成「默认全部共享」的事实陈述
    expect(await screen.findByText(/没有逐类开关/)).toBeInTheDocument();
  });

  it("挂载即上传白名单摘要并拉排行；名册与用量都带当前团队 id", async () => {
    useTaskStore.setState({ tasks: [taskRecord] });
    await renderPage();

    await waitFor(() => expect(uploadTeamUsage).toHaveBeenCalled());
    // 团队 id 就绪前后各同步一次（服务端按 (actor,date,model) 幂等），看最后一次即可
    const calls = vi.mocked(uploadTeamUsage).mock.calls;
    const items = calls[calls.length - 1]![0];
    expect(items).toEqual([
      { date: expect.any(String), model: "gpt-x", tokens: 700, unreported: 1, connections: ["主连接"] },
    ]);
    const raw = JSON.stringify(items);
    for (const forbidden of ["prompt", "content", '"text"', "args", "result"]) {
      expect(raw).not.toContain(forbidden);
    }
    await waitFor(() =>
      expect(fetchTeamUsage).toHaveBeenLastCalledWith(
        expect.objectContaining({ range: "7d", teamId: "team-1" }),
      ),
    );
    await waitFor(() =>
      expect(fetchTeam).toHaveBeenLastCalledWith(expect.objectContaining({ teamId: "team-1" })),
    );

    fireEvent.click(screen.getByRole("tab", { name: "用量" }));
    const ranking = await screen.findByRole("region", { name: "团队用量排行" });
    const rows = within(ranking).getAllByRole("listitem");
    expect(rows[0]).toHaveTextContent("鲍勃");
    expect(rows[1]).toHaveTextContent("爱丽丝（我）");
    expect(rows[1]).toHaveTextContent("未上报 2 轮");
    const mine = screen.getByRole("region", { name: "我的用量" });
    expect(mine).toHaveTextContent("gpt-x");
    expect(mine).toHaveTextContent("主连接");
    expect(ranking).not.toHaveTextContent("gpt-x");
  });

  it("页头团队切换器：切到另一个团队后按新 teamId 重新取名册与排行", async () => {
    vi.mocked(fetchWorkspaceTeams).mockResolvedValue({
      teams: [
        { ...workspaceTeams[0]! },
        { ...workspaceTeams[0]!, id: "team-2", name: "另一个团队" },
      ],
    });
    await renderPage();

    const select = await screen.findByLabelText("切换团队");
    await waitFor(() => expect(select).toHaveValue("team-1"));
    fireEvent.change(select, { target: { value: "team-2" } });

    await waitFor(() =>
      expect(fetchTeam).toHaveBeenLastCalledWith(expect.objectContaining({ teamId: "team-2" })),
    );
    await waitFor(() =>
      expect(fetchTeamUsage).toHaveBeenLastCalledWith(expect.objectContaining({ teamId: "team-2" })),
    );
    expect(select).toHaveValue("team-2");
  });

  it("排行空态：没有成员共享时给可解释文案", async () => {
    vi.mocked(fetchTeamUsage).mockResolvedValue(usageResponse({ ranking: [] }));
    await renderPage();
    fireEvent.click(screen.getByRole("tab", { name: "用量" }));
    expect(await screen.findByText("还没有成员共享用量。")).toBeInTheDocument();
  });

  it("排行被截断时说明总人数（P2-6：不再静默只给前 100）", async () => {
    vi.mocked(fetchTeamUsage).mockResolvedValue(
      usageResponse({ rankingTotal: 130, rankingTruncated: true }),
    );
    await renderPage();
    fireEvent.click(screen.getByRole("tab", { name: "用量" }));
    expect(await screen.findByText("共 130 人参与，仅显示前 2 名。")).toBeInTheDocument();
  });

  it("区间切换会带 range 重新拉取", async () => {
    await renderPage();
    await waitFor(() => expect(fetchTeamUsage).toHaveBeenCalled());
    fireEvent.click(screen.getByRole("tab", { name: "用量" }));
    fireEvent.click(screen.getByRole("button", { name: "近 30 天" }));
    await waitFor(() =>
      expect(fetchTeamUsage).toHaveBeenLastCalledWith(
        expect.objectContaining({ range: "30d" }),
      ),
    );
  });
});

describe("团队用量：清除已上传记录", () => {
  it("点「清除我的用量」二次确认后才删，删完重拉排行且不再含本人", async () => {
    // 用「清除后才变空」的可变实现：团队 id 就绪前后各拉一次，不能靠 once 队列对号入座
    let cleared = false;
    vi.mocked(clearMyTeamUsage).mockImplementation(async () => {
      cleared = true;
      return { deleted: 2 };
    });
    vi.mocked(fetchTeamUsage).mockImplementation(async () =>
      cleared
        ? usageResponse({
            self: { total: 0, unreported: 0, byModel: [], byDay: [] },
            ranking: [{ userId: bob.id, displayName: "鲍勃", tokens: 9000, unreported: 0, days: 3 }],
          })
        : usageResponse(),
    );

    await renderPage();
    await waitFor(() => expect(fetchTeamUsage).toHaveBeenCalled());
    fireEvent.click(screen.getByRole("tab", { name: "用量" }));

    fireEvent.click(await screen.findByRole("button", { name: "清除我的用量" }));
    expect(clearMyTeamUsage).not.toHaveBeenCalled();
    const dialog = screen.getByRole("dialog", { name: "清除上传的用量？" });
    expect(within(dialog).getByText(/清除后你不再出现在用量排行里/)).toBeInTheDocument();

    fireEvent.click(within(dialog).getByRole("button", { name: "清除" }));
    await waitFor(() => expect(clearMyTeamUsage).toHaveBeenCalledTimes(1));
    const ranking = screen.getByRole("region", { name: "团队用量排行" });
    await waitFor(() => expect(within(ranking).getAllByRole("listitem")).toHaveLength(1));
    expect(within(ranking).queryByText(/爱丽丝/)).toBeNull();
    expect(within(ranking).getByText("鲍勃")).toBeInTheDocument();
    // 本地水位已落：水位之前的用量不会被下一轮同步再传回去
    expect(useTeamShareStore.getState().settings.usageClearedAt).toBeTypeOf("number");
  });
});

describe("团队协作口径（d.153：共享是默认行为）", () => {
  it("挂载即同步白名单摘要；提示词 / 正文 / 工具参数都不在请求体里", async () => {
    vi.mocked(fetchTeamActivities).mockResolvedValue({
      activities: [activity({ id: "a1", title: "整理周报", kind: "task", status: "done" })],
    });
    useTaskStore.setState({ tasks: [taskRecord] });
    await renderPage();
    await waitFor(() => expect(uploadTeamActivities).toHaveBeenCalled());
    const calls = vi.mocked(uploadTeamActivities).mock.calls;
    const items = calls[calls.length - 1]![0];
    expect(items.map((i) => i.kind)).toContain("task");
    expect(JSON.stringify(items)).not.toMatch(/prompt|content|args|result/);
    // 动向行的标题是派生状态摘要，提问派生的标题（历史遗留行）不再上屏
    expect((await screen.findAllByText("任务 · 已完成")).length).toBeGreaterThan(0);
    expect(screen.queryByText("整理周报")).toBeNull();
  });

  it("团队只有自己时，说明怎么加入团队", async () => {
    vi.mocked(fetchTeam).mockResolvedValue({ members: [member(me, true)], onlineCount: 1 });
    await renderPage();
    expect(screen.getByText(/你还没加入团队/)).toBeInTheDocument();
    expect(screen.getByText(/让队长把你拉进来/)).toBeInTheDocument();
  });

  it("名册有多人时不再显示「只有你」的说明", async () => {
    vi.mocked(fetchTeam).mockResolvedValue({
      members: [member(me, true), member(bob)],
      onlineCount: 1,
    });
    await renderPage();
    expect(screen.queryByText(/团队目前只有你/)).toBeNull();
  });

  it("名册有「管理成员」入口，一步切到工作台（痛点 9 / 方案 1.1）", async () => {
    await renderPage();
    const manage = screen.getByRole("button", { name: "管理成员" });
    expect(manage).toHaveAttribute("title", "到工作台管理成员、派任务");
    fireEvent.click(manage);
    await waitFor(() =>
      expect(screen.getByRole("tab", { name: "工作台" })).toHaveAttribute("aria-selected", "true"),
    );
    // 切到工作台后名册让位，入口随之消失
    expect(screen.queryByRole("button", { name: "管理成员" })).toBeNull();
  });

  it("没有摘要时，空态说的是「等摘要」而不是「去开启共享」", async () => {
    vi.mocked(fetchTeamActivities).mockResolvedValue({ activities: [] });
    await renderPage();
    fireEvent.click(screen.getByRole("tab", { name: "动向" }));
    expect(await screen.findByText(/成员产生任务或日程后/)).toBeInTheDocument();
    expect(screen.queryByText(/去开启共享/)).toBeNull();
  });

  it("成员详情给出「近 N 天动向条数」，不再出现「用量未共享」这种旧口径", async () => {
    vi.mocked(fetchTeamUsage).mockResolvedValue(usageResponse({ ranking: [] }));
    await renderPage();
    fireEvent.click(screen.getByRole("button", { name: /鲍勃/ }));
    expect(await screen.findByText(/近 7 天动向 0 条/)).toBeInTheDocument();
    expect(screen.queryByText(/用量未共享/)).toBeNull();
  });
});
describe("首页动向条目 → 定位到那一条（d.90）", () => {
  it("消费一次性 intent：切回动向、滚到该条并高亮，随后清空", async () => {
    const scrollSpy = vi.fn();
    Element.prototype.scrollIntoView = scrollSpy;
    const acts = [
      activity({ id: "target-1", actorId: bob.id, title: "发版了" }),
      activity({ id: "other-1", title: "写周报" }),
    ];
    vi.mocked(fetchTeamActivities).mockResolvedValue({ activities: acts });
    useUiStore.setState({ teamFocusUserId: bob.id, teamFocusActivityId: "target-1" });
    await renderPage();

    const row = await waitFor(() => {
      const el = document.querySelector('[data-activity-id="target-1"]');
      expect(el).not.toBeNull();
      return el as HTMLElement;
    });
    await waitFor(() => expect(row.className).toContain("ring-1"));
    expect(scrollSpy).toHaveBeenCalled();
    // 一次性意图：消费后清空，再切走回来不会被钉住
    expect(useUiStore.getState().teamFocusActivityId).toBeNull();
  });
});

describe("团队日程：只读摘要", () => {
  it("未连接信息中枢：空态给「去连接」出口，且不自动拉起、不上传", async () => {
    useTeamShareStore.setState({ settings: { ...SHARED } });
    await renderPage();
    fireEvent.click(screen.getByRole("tab", { name: "团队日程" }));
    expect(screen.getByText("还没有共享的日程")).toBeInTheDocument();
    expect(screen.getByText(/不会自动拉起/)).toBeInTheDocument();
    // 空态必须给出可点的下一步（审计 P1-7：原来只有一段术语，没有出口）
    const uploadsBefore = vi.mocked(uploadTeamActivities).mock.calls.length;
    fireEvent.click(screen.getByRole("button", { name: "去连接信息中枢" }));
    // 旧 "infohub" 页 id 由 resolvePage 折叠到插件页，入口本身仍直达信息中枢
    expect(useUiStore.getState().page).toBe("plugin:heming.infohub");
    // d.153：挂载即同步是默认行为；切到日程页/点空态出口都不再新增上传
    expect(vi.mocked(uploadTeamActivities).mock.calls.length).toBe(uploadsBefore);
    expect(useInfohubStore.getState().running).toBe(false);
  });

  it("有日程摘要时按时间列出，只读（不新增任何上传）", async () => {
    useTeamShareStore.setState({ settings: { ...SHARED } });
    vi.mocked(fetchTeamActivities).mockResolvedValue({
      activities: [
        activity({ id: "a1", title: "项目周会", occurredAt: "2026-11-02T09:00:00.000Z" }),
        activity({
          id: "a2",
          actorId: bob.id,
          title: "客户回访",
          occurredAt: "2026-11-01T09:00:00.000Z",
        }),
        activity({ id: "t1", kind: "task", title: "不该出现在日程区" }),
      ],
    });
    await renderPage();
    const uploadsBefore = vi.mocked(uploadTeamActivities).mock.calls.length;
    fireEvent.click(screen.getByRole("tab", { name: "团队日程" }));

    expect(await screen.findByText("项目周会")).toBeInTheDocument();
    expect(screen.getByText("客户回访")).toBeInTheDocument();
    expect(screen.queryByText("不该出现在日程区")).not.toBeInTheDocument();
    // 只读：切到日程页不产生新的上传
    expect(vi.mocked(uploadTeamActivities).mock.calls.length).toBe(uploadsBefore);
  });
});

describe("团队页错误态语义（③-3）", () => {
  it("名册与动向失败都用 role=alert 播报，并给可重试按钮（不静默）", async () => {
    vi.mocked(fetchTeam).mockRejectedValue(new Error("网络异常"));
    vi.mocked(fetchTeamActivities).mockRejectedValue(new Error("网络异常"));

    render(<TeamPage />);
    const alerts = await screen.findAllByRole("alert");
    const text = alerts.map((a) => a.textContent ?? "").join("\n");
    expect(text).toContain("名册加载失败");
    expect(text).toContain("动向加载失败");
    // 两个失败态都带「重试」入口
    expect(screen.getAllByRole("button", { name: "重试" }).length).toBe(2);
  });

  it("用量加载失败用 role=alert 播报并可重试", async () => {
    useTeamShareStore.setState({ settings: { ...SHARED } });
    vi.mocked(fetchTeamUsage).mockRejectedValue(new Error("网络异常"));

    await renderPage();
    fireEvent.click(screen.getByRole("tab", { name: "用量" }));

    const alert = await screen.findByRole("alert");
    expect(alert).toHaveTextContent(/用量加载失败/);
    expect(screen.getByRole("button", { name: "重试" })).toBeInTheDocument();
  });
});

/** d.62-B 布局迁移守卫：页头统一走 PageShell（标题档位/副标题在同一处）。 */
describe("团队页布局（d.62-B）", () => {
  it("页头由 PageShell 提供：唯一 h1 用 ui-page-title，副标题用 ui-page-sub", async () => {
    await renderPage();
    const headings = screen.getAllByRole("heading", { level: 1 });
    expect(headings).toHaveLength(1);
    expect(headings[0]).toHaveClass("ui-page-title");
    expect(headings[0]).toHaveTextContent("团队");
    expect(document.querySelector(".ui-page-sub")?.textContent).toContain("与你在同一团队的同事");
  });
});

/** d.67 导航合并：原「团队看板」独立页并成团队页的「看板」Tab；现已改造为真任务板。 */
describe("团队页：看板 Tab（真任务板）", () => {
  it("Tab 栏有看板；切过去读 team_tasks 按状态分列，页头仍只有一个 h1", async () => {
    vi.mocked(fetchWorkspaceTeam).mockResolvedValue({
      team: workspaceTeams[0],
      members: [
        { user: me, role: "owner", joinedAt: nowIso },
        { user: bob, role: "member", joinedAt: nowIso },
      ],
      plans: [],
      tasks: [
        {
          id: "k1",
          teamId: "team-1",
          planId: null,
          title: "真任务：写周报",
          detail: "",
          assigneeId: me.id,
          status: "doing",
          createdBy: me.id,
          createdAt: nowIso,
          updatedAt: nowIso,
          dueAt: null,
          attachmentFileId: null,
        },
      ],
    });
    await renderPage();

    fireEvent.click(screen.getByRole("tab", { name: "看板" }));
    expect(await screen.findByText("真任务：写周报")).toBeInTheDocument();
    expect(screen.getByRole("tab", { name: "看板" })).toHaveAttribute("aria-selected", "true");
    // 看板读真正的 team_tasks（fetchWorkspaceTeam），不是动向摘要
    expect(fetchWorkspaceTeam).toHaveBeenCalledWith("team-1");

    // 嵌入后不再出现第二个页面标题：看板不画自己的「团队看板」页头
    const headings = screen.getAllByRole("heading", { level: 1 });
    expect(headings).toHaveLength(1);
    expect(headings[0]).toHaveTextContent("团队");
    expect(screen.queryByText("团队看板")).not.toBeInTheDocument();
    expect(document.querySelectorAll(".ui-page-title")).toHaveLength(1);

    // 真看板：状态分列 + 搜索/筛选，名册给看板让位
    expect(screen.getByLabelText("搜索任务看板")).toBeInTheDocument();
    expect(screen.getByRole("region", { name: "进行中" })).toBeInTheDocument();
    expect(screen.getByRole("region", { name: "待验收" })).toBeInTheDocument();
    expect(screen.queryByLabelText("搜索团队成员")).not.toBeInTheDocument();
  });

  it("pageView=board 意图：自动切到看板并消费，之后手动切走不残留", async () => {
    useUiStore.setState({ pageView: "board" });
    await renderPage();
    await waitFor(() =>
      expect(screen.getByRole("tab", { name: "看板" })).toHaveAttribute("aria-selected", "true"),
    );
    // 意图读走即清：切走再回来应回到默认的动向视图
    expect(useUiStore.getState().pageView).toBeNull();

    fireEvent.click(screen.getByRole("tab", { name: "动向" }));
    expect(screen.getByRole("tab", { name: "动向" })).toHaveAttribute("aria-selected", "true");
    expect(screen.getByLabelText("搜索团队成员")).toBeInTheDocument();
  });
});

describe("d.109 团队优化：深链 / 高亮 / 日程错误态", () => {
  it("深链未命中：数据就绪后消费意图并说明，不会永远把团队页钉在动向", async () => {
    useUiStore.setState({ teamFocusUserId: bob.id, teamFocusActivityId: "gone-1" });
    await renderPage();
    expect(await screen.findByText(/已不在最近的列表里/)).toBeInTheDocument();
    await waitFor(() => expect(useUiStore.getState().teamFocusActivityId).toBeNull());
  });

  it("高亮 2.4 秒后褪去（d.91 规格；原来计时器被 cleanup 抵消）", async () => {
    Element.prototype.scrollIntoView = vi.fn();
    vi.mocked(fetchTeamActivities).mockResolvedValue({ activities: [activity({ id: "t-1" })] });
    useUiStore.setState({ teamFocusActivityId: "t-1" });
    await renderPage();
    const row = await waitFor(() => {
      const el = document.querySelector('[data-activity-id="t-1"]');
      expect(el).not.toBeNull();
      return el as HTMLElement;
    });
    await waitFor(() => expect(row.className).toContain("ring-1"));
    await waitFor(() => expect(row.className).not.toContain("ring-1"), { timeout: 5000 });
  }, 10_000);

  it("团队日程加载失败：给 role=alert 与重试，而不是说成「没有共享的日程」", async () => {
    vi.mocked(fetchTeamActivities).mockRejectedValue(new Error("网络异常"));
    await renderPage();
    fireEvent.click(screen.getByRole("tab", { name: "团队日程" }));
    const alert = await screen.findByRole("alert");
    expect(alert).toHaveTextContent(/日程加载失败/);
    expect(screen.getByRole("button", { name: "重试" })).toBeInTheDocument();
    expect(screen.queryByText("还没有共享的日程")).not.toBeInTheDocument();
  });
});

describe("d.153 撤回口径：共享是默认行为，撤回靠手动清除", () => {
  it("页头说明「已上传的内容不会随任何开关消失，需要手动清除」", async () => {
    await renderPage();
    expect(await screen.findByText(/已上传的内容不会随任何开关消失/)).toBeInTheDocument();
    expect(screen.queryByText(/当前未共享任何内容/)).toBeNull();
  });

  it("用量页一直有「清除我的用量」入口（没有开关可关）", async () => {
    await renderPage();
    fireEvent.click(screen.getByRole("tab", { name: "用量" }));
    expect(await screen.findByRole("button", { name: "清除我的用量" })).toBeInTheDocument();
    expect(screen.queryByText(/可用「清除共享记录」撤回/)).toBeNull();
  });
});

describe("d.109 成员详情与条目可点", () => {
  it("成员详情给出最近 3 条（超出只取 3）", async () => {
    vi.mocked(fetchTeamActivities).mockResolvedValue({
      activities: [
        activity({ id: "b1", actorId: bob.id, title: "鲍勃事一" }),
        activity({ id: "b2", actorId: bob.id, title: "鲍勃事二" }),
        activity({ id: "b3", actorId: bob.id, title: "鲍勃事三" }),
        activity({ id: "b4", actorId: bob.id, title: "鲍勃事四" }),
      ],
    });
    await renderPage();
    const roster = document.querySelector("aside") as HTMLElement;
    fireEvent.click(within(roster).getByRole("button", { name: /鲍勃/ }));

    const label = await screen.findByText("最近动向");
    const list = label.parentElement as HTMLElement;
    expect(within(list).getAllByRole("button")).toHaveLength(3);
    expect(within(list).getByText("鲍勃事一")).toBeInTheDocument();
    expect(within(list).queryByText("鲍勃事四")).toBeNull();
  });

  it("点动向条目 = 选中该成员（与首页/看板一致，且键盘可达）", async () => {
    vi.mocked(fetchTeamActivities).mockResolvedValue({
      activities: [activity({ id: "f1", actorId: bob.id, title: "鲍勃发版" })],
    });
    await renderPage();
    fireEvent.click(await screen.findByRole("button", { name: /鲍勃发版/ }));
    expect(await screen.findByText("@bob")).toBeInTheDocument();
    expect(screen.getByRole("button", { name: /返回全部/ })).toBeInTheDocument();
  });

  it("排行被截断时，榜外成员显示「未进前 100」而不是「用量暂无」（T2-14）", async () => {
    useTeamShareStore.setState({ settings: { ...SHARED } });
    vi.mocked(fetchTeamUsage).mockResolvedValue(
      usageResponse({
        ranking: [{ userId: me.id, displayName: "爱丽丝", tokens: 1234, unreported: 2, days: 1 }],
        rankingTotal: 130,
        rankingTruncated: true,
      }),
    );
    await renderPage();
    const roster = document.querySelector("aside") as HTMLElement;
    fireEvent.click(within(roster).getByRole("button", { name: /鲍勃/ }));

    expect(await screen.findByText(/@bob/)).toBeInTheDocument();
    expect(screen.getByText(/用量未进前 100 名/)).toBeInTheDocument();
    expect(screen.queryByText(/用量暂无/)).toBeNull();
  });

  it("点用量排行里的成员 = 选中他并切到动向", async () => {
    useTeamShareStore.setState({ settings: { ...SHARED } });
    await renderPage();
    fireEvent.click(screen.getByRole("tab", { name: "用量" }));
    const rank = await screen.findByRole("region", { name: "团队用量排行" });
    vi.mocked(fetchTeamActivities).mockClear();
    fireEvent.click(within(rank).getByRole("button", { name: /鲍勃/ }));
    expect(await screen.findByText("@bob")).toBeInTheDocument();
    expect(screen.getByRole("tab", { name: "动向" })).toHaveAttribute("aria-selected", "true");
    expect(fetchTeamActivities).toHaveBeenCalledTimes(1);
  });
});
