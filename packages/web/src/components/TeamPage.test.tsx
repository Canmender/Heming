import { beforeEach, describe, expect, it, vi } from "vitest";
import { fireEvent, render, screen, waitFor, within } from "@testing-library/react";
import type { TeamActivity } from "@heming/shared";
import {
  clearMyTeamActivities,
  fetchTeam,
  fetchTeamActivities,
  fetchWorkspaceTeams,
  fetchWorkspaceTeam,
  uploadTeamActivities,
} from "../lib/api.js";
import { TeamPage } from "./TeamPage.js";
import { useAuthStore } from "../store/auth.js";
import { useUiStore } from "../store/ui.js";
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
    clearMyTeamActivities: vi.fn(),
    fetchWorkspaceTeams: vi.fn(),
    fetchWorkspaceTeam: vi.fn(),
    uploadTeamActivities: vi.fn(),
  };
});

const me = { id: "u1", username: "alice", displayName: "爱丽丝" };
const bob = { id: "u2", username: "bob", displayName: "鲍勃" };
const nowIso = new Date().toISOString();

const SHARED = { ...DEFAULT_TEAM_SHARE };

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

/** 用于验证「挂载即同步」的本机任务（只上白名单摘要，提示词不出本机）。 */
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

beforeEach(() => {
  localStorage.clear();
  sessionStorage.clear();
  useTeamShareStore.setState({ settings: { ...DEFAULT_TEAM_SHARE } });
  useAuthStore.setState({ token: "t1", user: me, status: "authed", error: null });
  useUiStore.setState({
    page: "team",
    pageView: null,
    activeConversationId: null,
    teamFocusUserId: null,
  });
  useTaskStore.setState({ tasks: [] });
  vi.mocked(fetchTeam).mockResolvedValue({
    members: [member(me, true), member(bob)],
    onlineCount: 1,
  });
  vi.mocked(fetchTeamActivities).mockResolvedValue({ activities: [] });
  vi.mocked(uploadTeamActivities).mockResolvedValue({ inserted: 0, skipped: 0 });
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
    fetchWorkspaceTeams,
    fetchWorkspaceTeam,
    uploadTeamActivities,
    clearMyTeamActivities,
  ]) {
    vi.mocked(fn).mockClear();
  }
});

async function renderPage() {
  render(<TeamPage />);
  // 页头副标题是「与你在同一团队的同事」，改用成员名作为「数据已到位」信号。
  await screen.findAllByText(/爱丽丝|鲍勃/);
}

describe("团队视图页签：只有团队列表 / 看板 / 动向", () => {
  it("命令面板的 focus-tab 意图把团队页切到团队列表，且消费即清（d.142）", async () => {
    useUiStore.setState({
      paletteIntent: { kind: "focus-tab", token: 7, data: { page: "team", tab: "workspace" } },
    });
    render(<TeamPage />);
    await waitFor(() =>
      expect(screen.getByRole("tab", { name: "团队列表" })).toHaveAttribute("aria-selected", "true"),
    );
    expect(useUiStore.getState().paletteIntent).toBeNull();
  });

  it("没有团队日程、用量页，也没有任何信息中枢入口", async () => {
    await renderPage();
    const list = screen.getByRole("tablist", { name: "团队视图" });
    expect(within(list).getAllByRole("tab")).toHaveLength(3);
    for (const label of ["团队列表", "看板", "动向"]) {
      expect(within(list).getByRole("tab", { name: label })).toBeInTheDocument();
    }
    expect(within(list).queryByRole("tab", { name: "团队日程" })).toBeNull();
    expect(within(list).queryByRole("tab", { name: "用量" })).toBeNull();
    expect(screen.queryByRole("button", { name: "去连接信息中枢" })).toBeNull();
    expect(screen.queryByText(/信息中枢/)).toBeNull();
    expect(screen.queryByRole("button", { name: "清除我的用量" })).toBeNull();
  });

  it("整组一个 Tab 停靠点，←/→ 切换视图并联动 tabpanel", async () => {
    await renderPage();
    const list = screen.getByRole("tablist", { name: "团队视图" });
    const teams = within(list).getByRole("tab", { name: "团队列表" });
    const feed = within(list).getByRole("tab", { name: "动向" });
    const board = within(list).getByRole("tab", { name: "看板" });

    expect(teams).toHaveAttribute("tabindex", "-1");
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
    expect(teams).toHaveAttribute("aria-selected", "true");
    expect(document.activeElement).toBe(teams);
  });

  it("同屏挂两份也不产生重复 id（useId 前缀）", async () => {
    render(<TeamPage />);
    render(<TeamPage />);
    await screen.findAllByText(/爱丽丝|鲍勃/);
    const panelIds = screen.getAllByRole("tabpanel").map((el) => el.id);
    expect(new Set(panelIds).size).toBe(panelIds.length);
    const tabIds = screen.getAllByRole("tab").map((el) => el.id);
    expect(new Set(tabIds).size).toBe(tabIds.length);
    const controlled = screen
      .getAllByRole("tab")
      .map((el) => el.getAttribute("aria-controls"))
      .filter((id): id is string => id !== null);
    expect(controlled).toHaveLength(2);
    for (const id of controlled) {
      expect(document.getElementById(id)).not.toBeNull();
    }
  });

  it("页签行常驻页头下方，三个页签都带 14px 图标且能来回切", async () => {
    await renderPage();
    const list = screen.getByRole("tablist", { name: "团队视图" });
    const row = list.parentElement as HTMLElement;
    expect(row.className).toContain("border-line-soft");
    expect(row.className).toContain("px-6");
    expect(list.closest("aside")).toBeNull();
    for (const label of ["团队列表", "动向", "看板"]) {
      expect(
        within(list).getByRole("tab", { name: label }).querySelector("svg"),
        `${label} 页签缺图标`,
      ).not.toBeNull();
    }

    fireEvent.click(within(list).getByRole("tab", { name: "团队列表" }));
    expect(within(list).getByRole("tab", { name: "团队列表" })).toHaveAttribute("aria-selected", "true");
    fireEvent.click(within(list).getByRole("tab", { name: "动向" }));
    expect(within(list).getByRole("tab", { name: "动向" })).toHaveAttribute("aria-selected", "true");
  });
});

describe("团队协作口径：共享是默认行为", () => {
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

  it("名册有「管理成员」入口，一步切到团队列表", async () => {
    await renderPage();
    const manage = screen.getByRole("button", { name: "管理成员" });
    expect(manage).toHaveAttribute("title", "到团队列表管理成员、派任务");
    fireEvent.click(manage);
    await waitFor(() =>
      expect(screen.getByRole("tab", { name: "团队列表" })).toHaveAttribute("aria-selected", "true"),
    );
    expect(screen.queryByRole("button", { name: "管理成员" })).toBeNull();
  });

  it("没有摘要时，空态说的是「等摘要」而不是「去开启共享」", async () => {
    vi.mocked(fetchTeamActivities).mockResolvedValue({ activities: [] });
    await renderPage();
    fireEvent.click(screen.getByRole("tab", { name: "动向" }));
    expect(await screen.findByText(/成员产生任务或日程后/)).toBeInTheDocument();
    expect(screen.queryByText(/去开启共享/)).toBeNull();
  });

  it("成员详情给出最近动向条数，不再出现「用量未共享」这种旧口径", async () => {
    await renderPage();
    fireEvent.click(screen.getByRole("button", { name: /鲍勃/ }));
    expect(await screen.findByText(/最近动向 0 条/)).toBeInTheDocument();
    expect(screen.queryByText(/用量未共享/)).toBeNull();
  });

  it("页头说明撤回语义，没有开关也没有用量相关入口", async () => {
    useTeamShareStore.setState({ settings: { ...SHARED } });
    await renderPage();
    expect(await screen.findByText(/已上传的内容不会随任何开关消失/)).toBeInTheDocument();
    expect(screen.queryByText(/当前未共享任何内容/)).toBeNull();
    expect(screen.queryByText(/用量/)).toBeNull();
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
    expect(useUiStore.getState().teamFocusActivityId).toBeNull();
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
    expect(screen.getAllByRole("button", { name: "重试" }).length).toBe(2);
  });
});

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
    expect(fetchWorkspaceTeam).toHaveBeenCalledWith("team-1");

    const headings = screen.getAllByRole("heading", { level: 1 });
    expect(headings).toHaveLength(1);
    expect(headings[0]).toHaveTextContent("团队");
    expect(screen.queryByText("团队看板")).not.toBeInTheDocument();
    expect(document.querySelectorAll(".ui-page-title")).toHaveLength(1);

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
    expect(useUiStore.getState().pageView).toBeNull();

    fireEvent.click(screen.getByRole("tab", { name: "动向" }));
    expect(screen.getByRole("tab", { name: "动向" })).toHaveAttribute("aria-selected", "true");
    expect(screen.getByLabelText("搜索团队成员")).toBeInTheDocument();
  });
});

describe("d.109 团队优化：深链 / 高亮 / 动向筛选", () => {
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

  it("日程摘要仍在动向里按「日程」筛选，不再单开日程页", async () => {
    vi.mocked(fetchTeamActivities).mockResolvedValue({
      activities: [
        activity({ id: "a1", title: "项目周会", occurredAt: "2026-11-02T09:00:00.000Z" }),
        activity({ id: "t1", kind: "task", title: "写周报" }),
      ],
    });
    await renderPage();
    expect(await screen.findByText("项目周会")).toBeInTheDocument();
    fireEvent.click(screen.getByRole("button", { name: "日程" }));
    expect(screen.getByText("项目周会")).toBeInTheDocument();
    // 任务类动向的 title 是历史提示词，显示层按 kind 派生，不该上屏
    expect(screen.queryByText("写周报")).toBeNull();
    fireEvent.click(screen.getByRole("button", { name: "任务" }));
    expect(screen.queryByText("项目周会")).toBeNull();
    const rows = screen.getAllByRole("listitem").filter((li) => li.hasAttribute("data-activity-id"));
    expect(rows).toHaveLength(1);
    expect(rows[0]!.textContent).toContain("任务");
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
});
