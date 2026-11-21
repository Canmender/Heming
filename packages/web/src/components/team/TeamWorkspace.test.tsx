import { beforeEach, describe, expect, it, vi } from "vitest";
import { fireEvent, render, screen, waitFor, within, act } from "@testing-library/react";
import type { TeamPlanItem, TeamTask, TeamWorkspaceSnapshot } from "@heming/shared";
import { TeamWorkspace } from "./TeamWorkspace.js";
import {
  addWorkspaceMember,
  createTeamPlan,
  createTeamTask,
  createTeamTaskComment,
  createWorkspaceTeam,
  discoverTeams,
  createJoinRequest,
  fetchMyJoinRequests,
  fetchJoinRequests,
  reviewJoinRequest,
  deleteTeamPlan,
  deleteTeamTask,
  deleteWorkspaceTeam,
  fetchTeamTaskComments,
  fetchTeamEvents,
  fetchWorkspaceTeam,
  fetchWorkspaceTeams,
  leaveWorkspaceTeam,
  removeWorkspaceMember,
  transferWorkspaceTeamOwner,
  updateTeamPlan,
  updateTeamTask,
  updateWorkspaceTeam,
} from "../../lib/api.js";
import { useAuthStore } from "../../store/auth.js";

vi.mock("../../lib/api.js", async (importOriginal) => {
  const actual = await importOriginal<typeof import("../../lib/api.js")>();
  return {
    ...actual,
    fetchWorkspaceTeams: vi.fn(),
    createWorkspaceTeam: vi.fn(),
    fetchWorkspaceTeam: vi.fn(),
    updateWorkspaceTeam: vi.fn(),
    discoverTeams: vi.fn(),
    createJoinRequest: vi.fn(),
    fetchMyJoinRequests: vi.fn(),
    fetchJoinRequests: vi.fn(),
    reviewJoinRequest: vi.fn(),
    deleteWorkspaceTeam: vi.fn(),
    addWorkspaceMember: vi.fn(),
    removeWorkspaceMember: vi.fn(),
    leaveWorkspaceTeam: vi.fn(),
    transferWorkspaceTeamOwner: vi.fn(),
    createTeamPlan: vi.fn(),
    updateTeamPlan: vi.fn(),
    deleteTeamPlan: vi.fn(),
    createTeamTask: vi.fn(),
    createTeamTaskComment: vi.fn(),
    fetchTeamTaskComments: vi.fn(),
    fetchTeamEvents: vi.fn(),
    updateTeamTask: vi.fn(),
    deleteTeamTask: vi.fn(),
  };
});

const me = { id: "u1", username: "admin", displayName: "阿鸣" };
const bob = { id: "u2", username: "bob", displayName: "鲍勃" };
const iso = "2026-11-07T10:00:00.000Z";

function team(over: Partial<TeamWorkspaceSnapshot["team"]> = {}): TeamWorkspaceSnapshot["team"] {
  return {
    id: "t1",
    name: "增长小组",
    goal: "把周报自动化，把复盘变成习惯",
    ownerId: me.id,
    createdAt: iso,
    updatedAt: iso,
    ...over,
  };
}

function snapshot(over: Partial<TeamWorkspaceSnapshot> = {}): TeamWorkspaceSnapshot {
  return {
    team: team(),
    members: [
      { user: me, role: "owner", joinedAt: iso },
      { user: bob, role: "member", joinedAt: iso },
    ],
    plans: [
      {
        id: "p1",
        teamId: "t1",
        title: "先把周报自动化",
        detail: "拉归档，生成初稿",
        status: "doing",
        orderIndex: 0,
        createdBy: me.id,
        createdAt: iso,
        updatedAt: iso,
      },
    ],
    tasks: [
      {
        id: "k1",
        teamId: "t1",
        planId: "p1",
        title: "产出本周周报初稿",
        detail: "",
        assigneeId: bob.id,
        status: "todo",
        createdBy: me.id,
        createdAt: iso,
        updatedAt: iso,
        dueAt: null,
        attachmentFileId: null,
      },
    ],
    ...over,
  };
}

beforeEach(() => {
  localStorage.clear();
  sessionStorage.clear();
  vi.mocked(fetchWorkspaceTeams).mockReset().mockResolvedValue({ teams: [team()] });
  vi.mocked(fetchWorkspaceTeam).mockReset().mockResolvedValue(snapshot());
  vi.mocked(createWorkspaceTeam).mockReset();
  vi.mocked(updateWorkspaceTeam).mockReset();
  vi.mocked(discoverTeams).mockReset().mockResolvedValue({ teams: [] });
  vi.mocked(createJoinRequest).mockReset();
  vi.mocked(fetchMyJoinRequests).mockReset().mockResolvedValue({ requests: [] });
  vi.mocked(fetchJoinRequests).mockReset().mockResolvedValue({ requests: [] });
  vi.mocked(reviewJoinRequest).mockReset();
  vi.mocked(addWorkspaceMember).mockReset();
  vi.mocked(removeWorkspaceMember).mockReset();
  vi.mocked(leaveWorkspaceTeam).mockReset();
  vi.mocked(transferWorkspaceTeamOwner).mockReset();
  vi.mocked(createTeamPlan).mockReset();
  vi.mocked(updateTeamPlan).mockReset();
  vi.mocked(createTeamTask).mockReset();
  vi.mocked(updateTeamTask).mockReset();
  vi.mocked(deleteWorkspaceTeam).mockReset();
  vi.mocked(deleteTeamPlan).mockReset();
  vi.mocked(deleteTeamTask).mockReset();
  vi.mocked(updateTaskRefresh());
  useAuthStore.setState({ token: "t1", user: me, status: "authed", error: null });
});

/** create/update 之后组件会重新拉快照：默认返回带新数据的版本。 */
function updateTaskRefresh() {
  return vi.mocked(fetchWorkspaceTeam).mockResolvedValue(snapshot());
}

/**
 * 假时钟下「把 promise 链跑完」：本文件的 api mock 全部同步 resolve，
 * 多轮微任务即可。**不能用 waitFor**——它自己的 setTimeout 也会被假时钟接管，
 * 两边互等只会超时。
 */
async function flush(times = 10) {
  for (let i = 0; i < times; i += 1) {
    await act(async () => {
      await Promise.resolve();
    });
  }
}

describe("团队工作台（d.92）", () => {
  it("没有任何团队：空态引导新建，创建后直接进入该团队", async () => {
    vi.mocked(fetchWorkspaceTeams).mockResolvedValue({ teams: [] });
    const created = snapshot({ team: team({ id: "t9", name: "新小组", goal: "先写目标" }) });
    vi.mocked(createWorkspaceTeam).mockResolvedValue(created);
    vi.mocked(fetchWorkspaceTeams).mockResolvedValueOnce({ teams: [] });
    vi.mocked(fetchWorkspaceTeams).mockResolvedValue({ teams: [created.team] });
    vi.mocked(fetchWorkspaceTeam).mockResolvedValue(created);

    render(<TeamWorkspace />);
    expect(await screen.findByText("还没有团队")).toBeInTheDocument();
    fireEvent.click(screen.getByRole("button", { name: "新建团队" }));
    fireEvent.change(screen.getByLabelText("团队名称"), { target: { value: "新小组" } });
    fireEvent.change(screen.getByLabelText("团队目标"), { target: { value: "先写目标" } });
    fireEvent.click(screen.getByRole("button", { name: "创建" }));

    await waitFor(() =>
      expect(createWorkspaceTeam).toHaveBeenCalledWith({ name: "新小组", goal: "先写目标" }),
    );
    expect(await screen.findByRole("heading", { name: "新小组" })).toBeInTheDocument();
  });

  it("目标：编辑后保存调用 updateWorkspaceTeam，并展示新目标", async () => {
    render(<TeamWorkspace />);
    const overview = await screen.findByRole("region", { name: "团队概况" });
    expect(within(overview).getByText(/把周报自动化/)).toBeInTheDocument();

    vi.mocked(updateWorkspaceTeam).mockResolvedValue(
      snapshot({ team: team({ goal: "新的目标：每周五出一版" }) }),
    );
    vi.mocked(fetchWorkspaceTeam).mockResolvedValue(
      snapshot({ team: team({ goal: "新的目标：每周五出一版" }) }),
    );
    fireEvent.click(screen.getByRole("button", { name: "编辑" }));
    fireEvent.change(screen.getByLabelText("编辑团队目标"), {
      target: { value: "新的目标：每周五出一版" },
    });
    fireEvent.click(screen.getByRole("button", { name: "保存" }));

    await waitFor(() =>
      expect(updateWorkspaceTeam).toHaveBeenCalledWith("t1", {
        goal: "新的目标：每周五出一版",
      }),
    );
    expect(
      within(await screen.findByRole("region", { name: "团队概况" })).getByText(
        "新的目标：每周五出一版",
      ),
    ).toBeInTheDocument();
  });

  it("方案：添加方案、点状态切到下一档、删除前二次确认", async () => {
    render(<TeamWorkspace />);
    expect(await screen.findByText("先把周报自动化")).toBeInTheDocument();

    vi.mocked(createTeamPlan).mockResolvedValue({
      ...snapshot().plans[0],
      id: "p2",
      title: "把复盘变成习惯",
      status: "todo",
    });
    vi.mocked(fetchWorkspaceTeam).mockResolvedValue(
      snapshot({
        plans: [
          ...snapshot().plans,
          {
            ...snapshot().plans[0],
            id: "p2",
            title: "把复盘变成习惯",
            status: "todo",
            orderIndex: 1,
          },
        ],
      }),
    );
    fireEvent.click(screen.getByRole("button", { name: "添加方案" }));
    fireEvent.change(screen.getByLabelText("方案标题"), { target: { value: "把复盘变成习惯" } });
    fireEvent.click(screen.getByRole("button", { name: "保存" }));
    await waitFor(() => expect(createTeamPlan).toHaveBeenCalled());
    expect(await screen.findByText("把复盘变成习惯")).toBeInTheDocument();

    // 点状态标签：doing → done
    const plan = screen.getByText("先把周报自动化").closest("li") as HTMLElement;
    fireEvent.click(within(plan).getByRole("button", { name: "进行中" }));
    await waitFor(() =>
      expect(updateTeamPlan).toHaveBeenCalledWith("t1", "p1", { status: "done" }),
    );

    // 删除方案：先出应用内确认框；取消不发请求，确认后才调一次。
    const confirmSpy = vi.spyOn(window, "confirm");
    vi.mocked(deleteTeamPlan).mockResolvedValue(undefined);
    fireEvent.click(screen.getByRole("button", { name: "删除方案 先把周报自动化" }));
    let planDialog = await screen.findByRole("dialog", { name: "删除方案？" });
    expect(deleteTeamPlan).not.toHaveBeenCalled();
    fireEvent.click(within(planDialog).getByRole("button", { name: "取消" }));
    await waitFor(() => expect(screen.queryByRole("dialog", { name: "删除方案？" })).toBeNull());
    expect(deleteTeamPlan).not.toHaveBeenCalled();

    fireEvent.click(screen.getByRole("button", { name: "删除方案 先把周报自动化" }));
    planDialog = await screen.findByRole("dialog", { name: "删除方案？" });
    fireEvent.click(within(planDialog).getByRole("button", { name: "删除" }));
    await waitFor(() => expect(deleteTeamPlan).toHaveBeenCalledTimes(1));
    expect(deleteTeamPlan).toHaveBeenCalledWith("t1", "p1");
    // 统一走 ConfirmDialog 后，源码里不再有原生 window.confirm 依赖。
    expect(confirmSpy).not.toHaveBeenCalled();
    confirmSpy.mockRestore();
  });

  it("任务：创建时带负责人与方案、上传交付物复用共享文件、点状态切下一档", async () => {
    render(<TeamWorkspace />);
    expect(await screen.findByText("产出本周周报初稿")).toBeInTheDocument();

    vi.mocked(createTeamTask).mockResolvedValue({
      ...snapshot().tasks[0],
      id: "k2",
      title: "整理复盘清单",
      assigneeId: bob.id,
      status: "todo",
    });
    vi.mocked(fetchWorkspaceTeam).mockResolvedValue(
      snapshot({
        tasks: [
          ...snapshot().tasks,
          {
            ...snapshot().tasks[0],
            id: "k2",
            title: "整理复盘清单",
            assigneeId: bob.id,
            status: "todo",
          },
        ],
      }),
    );

    fireEvent.click(screen.getByRole("button", { name: "派任务" }));
    fireEvent.change(screen.getByLabelText("任务标题"), { target: { value: "整理复盘清单" } });
    fireEvent.change(screen.getByLabelText("任务负责人"), { target: { value: bob.id } });
    fireEvent.change(screen.getByLabelText("归属方案"), { target: { value: "p1" } });
    fireEvent.click(screen.getByRole("button", { name: "发布任务" }));
    await waitFor(() =>
      expect(createTeamTask).toHaveBeenCalledWith(
        "t1",
        expect.objectContaining({ title: "整理复盘清单", assigneeId: bob.id, planId: "p1" }),
      ),
    );
    expect(await screen.findByText("整理复盘清单")).toBeInTheDocument();

    // 切换状态：todo → doing
    const task = screen.getByText("产出本周周报初稿").closest("li") as HTMLElement;
    fireEvent.click(within(task).getByRole("button", { name: "待开始" }));
    await waitFor(() =>
      expect(updateTeamTask).toHaveBeenCalledWith("t1", "k1", { status: "doing" }),
    );

    // 删除任务：同样先出确认框，不弹原生 confirm。
    const confirmSpy = vi.spyOn(window, "confirm");
    vi.mocked(deleteTeamTask).mockResolvedValue(undefined);
    fireEvent.click(screen.getByRole("button", { name: "删除任务 产出本周周报初稿" }));
    let taskDialog = await screen.findByRole("dialog", { name: "删除任务？" });
    expect(deleteTeamTask).not.toHaveBeenCalled();
    fireEvent.click(within(taskDialog).getByRole("button", { name: "取消" }));
    await waitFor(() => expect(screen.queryByRole("dialog", { name: "删除任务？" })).toBeNull());
    expect(deleteTeamTask).not.toHaveBeenCalled();

    fireEvent.click(screen.getByRole("button", { name: "删除任务 产出本周周报初稿" }));
    taskDialog = await screen.findByRole("dialog", { name: "删除任务？" });
    fireEvent.click(within(taskDialog).getByRole("button", { name: "删除" }));
    await waitFor(() => expect(deleteTeamTask).toHaveBeenCalledTimes(1));
    expect(deleteTeamTask).toHaveBeenCalledWith("t1", "k1");
    expect(confirmSpy).not.toHaveBeenCalled();
    confirmSpy.mockRestore();
  });

  it("成员：owner 可按用户名加人、可移除成员；非 owner 没有这些入口", async () => {
    const { unmount } = render(<TeamWorkspace />);
    expect(await screen.findByText("成员")).toBeInTheDocument();
    vi.mocked(addWorkspaceMember).mockResolvedValue(
      snapshot({
        members: [
          ...snapshot().members,
          { user: { id: "u3", username: "carol", displayName: "卡罗" }, role: "member", joinedAt: iso },
        ],
      }),
    );
    vi.mocked(fetchWorkspaceTeam).mockResolvedValue(
      snapshot({
        members: [
          ...snapshot().members,
          { user: { id: "u3", username: "carol", displayName: "卡罗" }, role: "member", joinedAt: iso },
        ],
      }),
    );
    fireEvent.change(screen.getByLabelText("成员用户名"), { target: { value: "carol" } });
    fireEvent.click(screen.getByRole("button", { name: "添加" }));
    await waitFor(() => expect(addWorkspaceMember).toHaveBeenCalledWith("t1", "carol"));

    // 移除成员要二次确认（服务端会解绑他的任务），文案必须说清后果。
    vi.mocked(removeWorkspaceMember).mockResolvedValue(
      snapshot({
        members: [
          ...snapshot().members,
          { user: { id: "u3", username: "carol", displayName: "卡罗" }, role: "member", joinedAt: iso },
        ],
      }),
    );
    const carolRemove = await screen.findByRole("button", { name: "移除成员 卡罗" });
    const confirmSpy = vi.spyOn(window, "confirm");
    fireEvent.click(carolRemove);
    let removeDialog = await screen.findByRole("dialog", { name: "移除成员？" });
    expect(within(removeDialog).getByText(/解绑为待认领/)).toBeInTheDocument();
    expect(within(removeDialog).getByRole("button", { name: "取消" })).toHaveFocus();
    expect(removeWorkspaceMember).not.toHaveBeenCalled();
    fireEvent.click(within(removeDialog).getByRole("button", { name: "取消" }));
    await waitFor(() => expect(screen.queryByRole("dialog", { name: "移除成员？" })).toBeNull());
    expect(removeWorkspaceMember).not.toHaveBeenCalled();

    fireEvent.click(screen.getByRole("button", { name: "移除成员 卡罗" }));
    removeDialog = await screen.findByRole("dialog", { name: "移除成员？" });
    fireEvent.click(within(removeDialog).getByRole("button", { name: "移除" }));
    await waitFor(() => expect(removeWorkspaceMember).toHaveBeenCalledTimes(1));
    expect(removeWorkspaceMember).toHaveBeenCalledWith("t1", "u3");
    expect(confirmSpy).not.toHaveBeenCalled();
    confirmSpy.mockRestore();
    unmount();

    // 非 owner（鲍勃视角）：没有删除团队 / 添加成员 / 移除成员，也没有「编辑」目标
    useAuthStore.setState({ token: "t2", user: bob, status: "authed", error: null });
    render(<TeamWorkspace />);
    await screen.findByText("先把周报自动化");
    expect(screen.queryByRole("button", { name: "删除团队" })).toBeNull();
    expect(screen.queryByLabelText("成员用户名")).toBeNull();
    expect(screen.queryByRole("button", { name: /移除成员/ })).toBeNull();
    // d.109：owner-only 的目标编辑入口不再对成员显示（原来点了保存才 403）
    expect(screen.queryByRole("button", { name: "编辑" })).toBeNull();
  });

  it("刷新：点按钮重新拉取快照并提示「团队数据已刷新」，不清空未保存的草稿", async () => {
    render(<TeamWorkspace />);
    await screen.findByRole("region", { name: "团队概况" });
    expect(fetchWorkspaceTeam).toHaveBeenCalledTimes(1);

    // 有一个未保存的目标草稿：刷新只换快照，不该把用户正在写的东西清掉。
    fireEvent.click(screen.getByRole("button", { name: "编辑" }));
    fireEvent.change(screen.getByLabelText("编辑团队目标"), { target: { value: "还没保存的草稿" } });

    fireEvent.click(screen.getByRole("button", { name: "刷新团队数据" }));
    await waitFor(() => expect(fetchWorkspaceTeam).toHaveBeenCalledTimes(2));
    expect(fetchWorkspaceTeam).toHaveBeenLastCalledWith("t1");
    expect(await screen.findByText("团队数据已刷新")).toBeInTheDocument();
    expect(screen.getByLabelText("编辑团队目标")).toHaveValue("还没保存的草稿");
  });

  it("截止时间按本地时区显示；未完成且过期带「已逾期」，已完成不带", async () => {
    const overdue = "2026-01-05T10:30:00.000Z";
    const future = new Date(Date.now() + 86_400_000).toISOString();
    vi.mocked(fetchWorkspaceTeam).mockResolvedValue(
      snapshot({
        tasks: [
          { ...snapshot().tasks[0], id: "k1", title: "已过期的任务", status: "todo", dueAt: overdue },
          { ...snapshot().tasks[0], id: "k2", title: "已完成的过期任务", status: "done", dueAt: overdue },
          { ...snapshot().tasks[0], id: "k3", title: "还没到期的任务", status: "todo", dueAt: future },
        ],
      }),
    );
    render(<TeamWorkspace />);
    await screen.findByText("已过期的任务");

    // 本地时区渲染：与服务端 ISO 的本地时刻一致，而不是按 UTC 截断。
    const d = new Date(overdue);
    const pad = (n: number) => String(n).padStart(2, "0");
    const localText = `截止 ${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())} ${pad(
      d.getHours(),
    )}:${pad(d.getMinutes())}`;
    const utcText = `截止 ${overdue.slice(0, 16).replace("T", " ")}`;

    const overdueRow = screen.getByText("已过期的任务").closest("li") as HTMLElement;
    expect(within(overdueRow).getByText(localText)).toBeInTheDocument();
    expect(within(overdueRow).getByText("已逾期")).toBeInTheDocument();
    // 机器在 UTC 时两者相同，只有非零时区才有区分度——那正是旧 bug 的现场。
    if (localText !== utcText) {
      expect(within(overdueRow).queryByText(utcText)).toBeNull();
    }

    // 未到期的没有标记
    const futureRow = screen.getByText("还没到期的任务").closest("li") as HTMLElement;
    expect(within(futureRow).queryByText("已逾期")).toBeNull();

    // 已完成的任务即使过了截止时间也不标逾期（切到「已完成」筛选才看得到）
    fireEvent.click(screen.getByRole("button", { name: "已完成" }));
    const doneRow = (await screen.findByText("已完成的过期任务")).closest("li") as HTMLElement;
    expect(within(doneRow).queryByText("已逾期")).toBeNull();
  });

  it("按截止日看：今天要交的和已经拖的分开列，已完成的不占位置", async () => {
    const today = new Date();
    today.setHours(23, 0, 0, 0);
    const overdue = new Date(Date.now() - 3 * 86_400_000).toISOString();
    const owner = snapshot().members[0]!.user.id;
    vi.mocked(fetchWorkspaceTeam).mockResolvedValue(
      snapshot({
        tasks: [
          { ...snapshot().tasks[0]!, id: "s1", title: "今天要交的", status: "doing", dueAt: today.toISOString(), assigneeId: owner },
          { ...snapshot().tasks[0]!, id: "s2", title: "拖了三天了", status: "todo", dueAt: overdue },
          { ...snapshot().tasks[0]!, id: "s3", title: "已经交掉", status: "done", dueAt: today.toISOString() },
        ],
      }),
    );
    render(<TeamWorkspace />);
    const panel = await screen.findByTestId("team-schedule");
    // 默认收起（展开才渲染标题，避免和任务板碰脸）
    expect(within(panel).queryByText("今天要交的")).toBeNull();
    fireEvent.click(within(panel).getByRole("button", { name: "展开近期要交的活" }));

    expect(within(panel).getByText("今天要交的")).toBeInTheDocument();
    expect(within(panel).getByText("拖了三天了")).toBeInTheDocument();
    // 已完成的不进这个视图（要不要验收是任务板「待验收」那档的事）
    expect(within(panel).queryByText("已经交掉")).toBeNull();

    const overdueBucket = screen.getByTestId("schedule-bucket-overdue");
    expect(within(overdueBucket).getByText("拖了三天了")).toBeInTheDocument();
    expect(within(overdueBucket).getByText("逾期 3 天")).toBeInTheDocument();
    expect(screen.getByTestId("schedule-summary").textContent).toContain("1 件已逾期");
  });

  it("删除团队：先出确认框，取消不调 API，确认后调用一次", async () => {
    render(<TeamWorkspace />);
    await screen.findByRole("region", { name: "团队概况" });
    vi.mocked(deleteWorkspaceTeam).mockResolvedValue(undefined);
    const confirmSpy = vi.spyOn(window, "confirm");

    fireEvent.click(screen.getByRole("button", { name: "删除团队" }));
    let dialog = await screen.findByRole("dialog", { name: "删除团队？" });
    // 初始焦点在「取消」：误按回车不会删掉团队。
    expect(within(dialog).getByRole("button", { name: "取消" })).toHaveFocus();
    expect(deleteWorkspaceTeam).not.toHaveBeenCalled();
    fireEvent.click(within(dialog).getByRole("button", { name: "取消" }));
    await waitFor(() => expect(screen.queryByRole("dialog", { name: "删除团队？" })).toBeNull());
    expect(deleteWorkspaceTeam).not.toHaveBeenCalled();

    fireEvent.click(screen.getByRole("button", { name: "删除团队" }));
    dialog = await screen.findByRole("dialog", { name: "删除团队？" });
    fireEvent.click(within(dialog).getByRole("button", { name: "删除" }));
    await waitFor(() => expect(deleteWorkspaceTeam).toHaveBeenCalledTimes(1));
    expect(deleteWorkspaceTeam).toHaveBeenCalledWith("t1");
    expect(confirmSpy).not.toHaveBeenCalled();
    confirmSpy.mockRestore();
  });

  it("轮询：有快照时每 45s 静默刷新一次", async () => {
    vi.useFakeTimers();
    try {
      render(<TeamWorkspace />);
      await flush();
      expect(fetchWorkspaceTeam).toHaveBeenCalledTimes(1);

      await act(async () => {
        vi.advanceTimersByTime(45_000);
      });
      await flush();
      expect(fetchWorkspaceTeam).toHaveBeenCalledTimes(2);
      // 轮询静默更新快照：不再每 45 秒弹一次「团队数据已刷新」（只有手动刷新给提示）。
      expect(screen.queryByText("团队数据已刷新")).toBeNull();
    } finally {
      vi.useRealTimers();
    }
  });

  it("空团队不轮询：没有快照就不起计时器", async () => {
    vi.mocked(fetchWorkspaceTeams).mockResolvedValue({ teams: [] });
    vi.useFakeTimers();
    try {
      render(<TeamWorkspace />);
      await flush();
      expect(screen.getByText("还没有团队")).toBeInTheDocument();

      await act(async () => {
        vi.advanceTimersByTime(90_000);
      });
      await flush();
      expect(fetchWorkspaceTeam).not.toHaveBeenCalled();
    } finally {
      vi.useRealTimers();
    }
  });

  it("「团队已创建」提示 3 秒后消失（不再常驻）", async () => {
    vi.mocked(fetchWorkspaceTeams).mockResolvedValue({ teams: [] });
    const created = snapshot({ team: team({ id: "t9", name: "新小组", goal: "先写目标" }) });
    vi.mocked(createWorkspaceTeam).mockResolvedValue(created);
    vi.mocked(fetchWorkspaceTeam).mockResolvedValue(created);

    vi.useFakeTimers();
    try {
      render(<TeamWorkspace />);
      await flush();
      expect(screen.getByText("还没有团队")).toBeInTheDocument();

      vi.mocked(fetchWorkspaceTeams).mockResolvedValue({ teams: [created.team] });
      fireEvent.click(screen.getByRole("button", { name: "新建团队" }));
      fireEvent.change(screen.getByLabelText("团队名称"), { target: { value: "新小组" } });
      fireEvent.click(screen.getByRole("button", { name: "创建" }));
      await flush();
      expect(createWorkspaceTeam).toHaveBeenCalledWith({ name: "新小组", goal: "" });
      expect(screen.getByText("团队已创建")).toBeInTheDocument();

      await act(async () => {
        vi.advanceTimersByTime(3000);
      });
      await flush();
      expect(screen.queryByText("团队已创建")).toBeNull();
    } finally {
      vi.useRealTimers();
    }
  });

  /**
   * W-06：首屏加载失败必须显示错误态与「重试」，不能冒充「还没有团队」——
   * 后者会让用户以为团队被删了，还引导他去新建一个。
   */
  it("首屏加载失败：显示错误态与「重试」，不冒充「还没有团队」", async () => {
    vi.mocked(fetchWorkspaceTeams)
      .mockRejectedValueOnce(new Error("网络异常"))
      .mockResolvedValue({ teams: [team()] });

    render(<TeamWorkspace />);
    expect(await screen.findByText("团队加载失败")).toBeInTheDocument();
    expect(screen.queryByText("还没有团队")).toBeNull();
    // 首屏失败时错误只出现一次（错误态里），页顶不再重复一条横幅。
    expect(screen.queryByRole("alert")).toBeNull();
    expect(screen.getByText(/网络异常/)).toBeInTheDocument();

    fireEvent.click(screen.getByRole("button", { name: "重试" }));
    expect(await screen.findByRole("heading", { name: "增长小组" })).toBeInTheDocument();
    expect(fetchWorkspaceTeams).toHaveBeenCalledTimes(2);
  });

  /**
   * W-06：面板里的写操作失败就地显示在面板内。只写页顶横幅的话，
   * 用户滚在任务/方案区根本看不到错误，会以为按钮没生效。
   */
  it("面板错误就地显示在面板内，不再只写页顶", async () => {
    render(<TeamWorkspace />);
    const planRegion = await screen.findByRole("region", { name: "团队方案" });
    vi.mocked(createTeamPlan).mockRejectedValueOnce(new Error("方案标题过长"));

    fireEvent.click(within(planRegion).getByRole("button", { name: "添加方案" }));
    fireEvent.change(within(planRegion).getByLabelText("方案标题"), {
      target: { value: "一个很长很长的方案标题" },
    });
    fireEvent.click(within(planRegion).getByRole("button", { name: "保存" }));

    const alert = await within(planRegion).findByRole("alert");
    expect(alert).toHaveTextContent("方案标题过长");
    // 页顶不再重复同一条错误
    expect(screen.getAllByRole("alert")).toHaveLength(1);

    fireEvent.click(within(alert).getByRole("button", { name: "关闭" }));
    await waitFor(() => expect(within(planRegion).queryByRole("alert")).toBeNull());
  });

  /** W-04：提交中禁用「发布任务」，双击只发一次创建请求。 */
  it("双击「发布任务」只创建一条，提交中按钮禁用", async () => {
    render(<TeamWorkspace />);
    expect(await screen.findByText("产出本周周报初稿")).toBeInTheDocument();

    let resolveCreate!: (task: TeamTask) => void;
    vi.mocked(createTeamTask).mockImplementation(
      () =>
        new Promise<TeamTask>((resolve) => {
          resolveCreate = resolve;
        }),
    );

    fireEvent.click(screen.getByRole("button", { name: "派任务" }));
    fireEvent.change(screen.getByLabelText("任务标题"), { target: { value: "只应创建一次" } });
    const submit = screen.getByRole("button", { name: "发布任务" });
    fireEvent.click(submit);
    fireEvent.click(submit);

    await waitFor(() => expect(createTeamTask).toHaveBeenCalledTimes(1));
    expect(submit).toBeDisabled();

    await act(async () => {
      resolveCreate({ ...snapshot().tasks[0], id: "k9", title: "只应创建一次" });
    });
    // 创建成功后表单收起（按钮不再存在），且始终只发过一次请求。
    await waitFor(() => expect(screen.queryByLabelText("任务标题")).toBeNull());
    expect(createTeamTask).toHaveBeenCalledTimes(1);
  });

  /**
   * W-04：状态胶囊用最新快照推进。此前用渲染闭包里的旧 status 算下一档，
   * 连点两次会从 todo 直接跳到 done。
   */
  it("连点状态胶囊只发一次更新、只前进一档", async () => {
    render(<TeamWorkspace />);
    expect(await screen.findByText("产出本周周报初稿")).toBeInTheDocument();

    let resolveUpdate!: (task: TeamTask) => void;
    vi.mocked(updateTeamTask).mockImplementation(
      () =>
        new Promise<TeamTask>((resolve) => {
          resolveUpdate = resolve;
        }),
    );

    const row = screen.getByText("产出本周周报初稿").closest("li") as HTMLElement;
    const pill = within(row).getByRole("button", { name: "待开始" });
    fireEvent.click(pill);
    fireEvent.click(pill);

    await waitFor(() => expect(updateTeamTask).toHaveBeenCalledTimes(1));
    expect(updateTeamTask).toHaveBeenCalledWith("t1", "k1", { status: "doing" });
    expect(pill).toBeDisabled();

    await act(async () => {
      resolveUpdate({ ...snapshot().tasks[0], status: "doing" });
    });
    const rowAfter = screen.getByText("产出本周周报初稿").closest("li") as HTMLElement;
    await waitFor(() =>
      expect(within(rowAfter).getByRole("button", { name: "待开始" })).not.toBeDisabled(),
    );
    expect(updateTeamTask).toHaveBeenCalledTimes(1);
  });

  /** W-04：方案「保存」提交中禁用，双击只创建一条。 */
  it("双击方案「保存」只创建一条，提交中按钮禁用", async () => {
    render(<TeamWorkspace />);
    await screen.findByText("先把周报自动化");
    const nextPlans = [
      ...snapshot().plans,
      { ...snapshot().plans[0], id: "p2", title: "只应创建一次", status: "todo" as const, orderIndex: 1 },
    ];
    vi.mocked(fetchWorkspaceTeam).mockResolvedValue(snapshot({ plans: nextPlans }));

    let resolveCreate!: (plan: TeamPlanItem) => void;
    vi.mocked(createTeamPlan).mockImplementation(
      () =>
        new Promise<TeamPlanItem>((resolve) => {
          resolveCreate = resolve;
        }),
    );

    fireEvent.click(screen.getByRole("button", { name: "添加方案" }));
    fireEvent.change(screen.getByLabelText("方案标题"), { target: { value: "只应创建一次" } });
    const save = screen.getByRole("button", { name: "保存" });
    fireEvent.click(save);
    fireEvent.click(save);

    await waitFor(() => expect(createTeamPlan).toHaveBeenCalledTimes(1));
    expect(save).toBeDisabled();

    await act(async () => {
      resolveCreate(nextPlans[1]);
    });
    expect(await screen.findByText("只应创建一次")).toBeInTheDocument();
    expect(createTeamPlan).toHaveBeenCalledTimes(1);
  });
});

describe("方案进度汇总（痛点 7）", () => {
  it("方案卡显示挂在其下的任务完成数与逾期数", async () => {
    const now = Date.now();
    const t = snapshot().tasks[0]!;
    vi.mocked(fetchWorkspaceTeam).mockResolvedValue(
      snapshot({
        tasks: [
          { ...t, id: "k-done", planId: "p1", title: "完成的任务", status: "done" },
          { ...t, id: "k-open", planId: "p1", title: "没完成的", status: "todo" },
          {
            ...t,
            id: "k-late",
            planId: "p1",
            title: "逾期的",
            status: "doing",
            dueAt: new Date(now - 86_400_000).toISOString(),
          },
          { ...t, id: "k-other", planId: null, title: "独立任务" },
        ],
      }),
    );
    render(<TeamWorkspace />);
    await screen.findByText("先把周报自动化");
    const planCard = screen.getByText("先把周报自动化").closest("li") as HTMLElement;
    expect(within(planCard).getByText("1/3 任务完成")).toBeInTheDocument();
    expect(within(planCard).getByText("1 个逾期")).toBeInTheDocument();
    expect(within(planCard).getByLabelText("方案进度 先把周报自动化")).toBeInTheDocument();
  });
});

describe("成员自退与队长转让（P1-4）", () => {
  it("普通成员可以自己退出团队，确认后才发请求", async () => {
    vi.mocked(fetchWorkspaceTeam).mockResolvedValue(
      snapshot({
        team: team({ ownerId: bob.id }),
        members: [
          { user: bob, role: "owner", joinedAt: iso },
          { user: me, role: "member", joinedAt: iso },
        ],
      }),
    );
    vi.mocked(leaveWorkspaceTeam).mockResolvedValue(undefined);
    // 首屏还能看到团队（否则会先落到空态，成员区不渲染）；退出后再拉列表为空。
    vi.mocked(fetchWorkspaceTeams)
      .mockResolvedValueOnce({ teams: [team()] })
      .mockResolvedValue({ teams: [] });

    render(<TeamWorkspace />);
    const leave = await screen.findByRole("button", { name: "退出团队" });
    fireEvent.click(leave);
    // 打开确认框但还没点「退出」：不能已经发请求（取消 = 不发）。
    expect(leaveWorkspaceTeam).not.toHaveBeenCalled();

    fireEvent.click(screen.getByRole("button", { name: "退出" }));
    await waitFor(() => expect(leaveWorkspaceTeam).toHaveBeenCalledWith("t1"));
    // 退出后列表为空：落到「还没有团队」，而不是继续显示刚退出的团队。
    expect(await screen.findByText("还没有团队")).toBeTruthy();
  });

  it("owner 没有「退出团队」按钮：团队不能无主，只能转让或解散", async () => {
    render(<TeamWorkspace />);
    await screen.findByRole("button", { name: "刷新团队数据" });
    expect(screen.queryByRole("button", { name: "退出团队" })).toBeNull();
  });

  it("owner 把队长转让给成员：调用转让接口，之后角色互换", async () => {
    const before = snapshot();
    const after = snapshot({
      team: team({ ownerId: bob.id }),
      members: [
        { user: bob, role: "owner", joinedAt: iso },
        { user: me, role: "member", joinedAt: iso },
      ],
    });
    vi.mocked(transferWorkspaceTeamOwner).mockResolvedValue(after);
    vi.mocked(fetchWorkspaceTeam).mockResolvedValueOnce(before).mockResolvedValue(after);

    render(<TeamWorkspace />);
    fireEvent.click(await screen.findByRole("button", { name: "转让队长给 鲍勃" }));
    fireEvent.click(screen.getByRole("button", { name: "转让" }));

    await waitFor(() =>
      expect(transferWorkspaceTeamOwner).toHaveBeenCalledWith("t1", bob.id),
    );
    // 转让后自己降为成员：出现「退出团队」，且不再能转让给别人。
    expect(await screen.findByRole("button", { name: "退出团队" })).toBeTruthy();
    expect(screen.queryByRole("button", { name: "转让队长给 鲍勃" })).toBeNull();
  });
});

describe("组长才派得动别人（d.249）", () => {
  it("非组长：能给自己派活，不能派给别人，并看到说明", async () => {
    useAuthStore.setState({ token: "t2", user: bob, status: "authed", error: null });
    render(<TeamWorkspace />);
    fireEvent.click(await screen.findByRole("button", { name: "派任务" }));
    expect(screen.getByTestId("team-assign-hint")).toHaveTextContent("只有组长能把任务派给别人");
    expect(screen.getAllByRole("option", { name: "鲍勃" })[0]).toBeEnabled();
    expect(screen.getAllByRole("option", { name: /阿鸣（组长）/ })[0]).toBeDisabled();
  });

  it("组长：下拉里看得出谁是组长，任务行说明对方智能体会看到", async () => {
    render(<TeamWorkspace />);
    fireEvent.click(await screen.findByRole("button", { name: "派任务" }));
    expect(screen.queryByTestId("team-assign-hint")).toBeNull();
    expect(screen.getAllByRole("option", { name: /阿鸣（组长）/ })[0]).toBeEnabled();
    expect(screen.getByTestId("assignee-agent-hint")).toHaveTextContent(
      "鲍勃 的智能体会在下一轮对话里看到这条任务",
    );
  });
});

describe("按人看任务（d.250）", () => {
  it("点成员 chip 只看他的活，再点一次恢复", async () => {
    const base = snapshot().tasks[0]!;
    vi.mocked(fetchWorkspaceTeam).mockResolvedValue(
      snapshot({
        tasks: [
          { ...base, id: "k-bob", title: "鲍勃的活", assigneeId: bob.id },
          { ...base, id: "k-leader", title: "组长的活", assigneeId: me.id },
        ],
      }),
    );
    render(<TeamWorkspace />);
    const chips = await screen.findByTestId("task-assignee-chips");
    expect(screen.getByText("鲍勃的活")).toBeInTheDocument();

    fireEvent.click(within(chips).getByRole("button", { name: /阿鸣/ }));
    expect(screen.queryByText("鲍勃的活")).toBeNull();
    expect(screen.getByText("组长的活")).toBeInTheDocument();

    fireEvent.click(within(chips).getByRole("button", { name: /阿鸣/ }));
    expect(await screen.findByText("鲍勃的活")).toBeInTheDocument();
  });
});

describe("多久没动（d.251）", () => {
  function taskWithUpdatedAt(updatedAt: string) {
    const base = snapshot().tasks[0]!;
    return { ...base, id: "k-age", title: "该催一下的任务", updatedAt };
  }

  it("超过三天没动：任务行标出来并提醒", async () => {
    const old = new Date(Date.now() - 5 * 86_400_000).toISOString();
    vi.mocked(fetchWorkspaceTeam).mockResolvedValue(snapshot({ tasks: [taskWithUpdatedAt(old)] }));
    render(<TeamWorkspace />);
    const marker = await screen.findByTestId("task-age");
    expect(marker).toHaveTextContent("5 天没动了");
    expect(marker.className).toContain("warn");
  });

  it("今天动过的任务只说「今天更新」，不报警", async () => {
    vi.mocked(fetchWorkspaceTeam).mockResolvedValue(
      snapshot({ tasks: [taskWithUpdatedAt(new Date().toISOString())] }),
    );
    render(<TeamWorkspace />);
    const marker = await screen.findByTestId("task-age");
    expect(marker).toHaveTextContent("今天更新");
    expect(marker.className).not.toContain("warn");
  });
});

describe("完成留痕（d.252）", () => {
  it("已完成的任务显示结论、提交人与完成时间", async () => {
    const base = snapshot().tasks[0]!;
    vi.mocked(fetchWorkspaceTeam).mockResolvedValue(
      snapshot({
        tasks: [
          {
            ...base,
            id: "k-done",
            title: "整理接口文档",
            status: "done",
            assigneeId: "bob",
            result: "按新接口重写了文档，pnpm test 全绿。",
            completedAt: "2026-11-17T09:30:00.000Z",
          },
        ],
      }),
    );
    render(<TeamWorkspace />);
    // 任务板默认只看「未完成」，已完成的任务要先切到「已完成」档。
    const filters = await screen.findByRole("group", { name: "任务筛选" });
    fireEvent.click(within(filters).getByRole("button", { name: "已完成" }));
    const note = await screen.findByTestId("task-result");
    expect(note).toHaveTextContent("结论：按新接口重写了文档，pnpm test 全绿。");
    expect(note.getAttribute("title")).toBe("按新接口重写了文档，pnpm test 全绿。");
  });
});

describe("任务级权限：别人名下的活改不动（d.254）", () => {
  it("成员视角：自己的任务能改，组长名下的按钮都禁用并说明原因", async () => {
    useAuthStore.setState({ token: "t1", user: bob, status: "authed", error: null });
    const base = snapshot().tasks[0];
    vi.mocked(fetchWorkspaceTeam).mockResolvedValue(
      snapshot({
        tasks: [
          { ...base, id: "k1", title: "我自己的活", assigneeId: bob.id },
          { ...base, id: "k2", title: "组长的活", assigneeId: me.id },
        ],
      }),
    );

    render(<TeamWorkspace />);
    const mineRow = (await screen.findByText("我自己的活")).closest("li") as HTMLElement;
    const bossRow = screen.getByText("组长的活").closest("li") as HTMLElement;

    expect(within(mineRow).getByRole("button", { name: "待开始" })).toBeEnabled();
    expect(within(bossRow).getByRole("button", { name: "待开始" })).toBeDisabled();
    const deleteBoss = within(bossRow).getByRole("button", { name: "删除任务 组长的活" });
    expect(deleteBoss).toBeDisabled();
    expect(deleteBoss.getAttribute("title")).toContain("别人名下的任务");
    expect(within(mineRow).getByRole("button", { name: "删除任务 我自己的活" })).toBeEnabled();
  });
});

describe("任务依赖：后置要等前置（d.255）", () => {
  it("前置还没做完：任务行点名它，并标成警示", async () => {
    const base = snapshot().tasks[0]!;
    vi.mocked(fetchWorkspaceTeam).mockResolvedValue(
      snapshot({
        tasks: [
          { ...base, id: "k-pre", title: "先定接口契约", status: "todo", assigneeId: me.id, blockedBy: [] },
          {
            ...base,
            id: "k-post",
            title: "按契约写实现",
            status: "todo",
            assigneeId: me.id,
            blockedBy: ["k-pre"],
          },
        ],
      }),
    );
    render(<TeamWorkspace />);
    const marker = await screen.findByTestId("task-blocked-by");
    expect(marker).toHaveTextContent("等「先定接口契约」做完");
    expect(marker.getAttribute("data-open")).toBe("true");
    expect(marker.className).toContain("warn");
  });

  it("前置已完成：只说明，不再报警", async () => {
    const base = snapshot().tasks[0]!;
    vi.mocked(fetchWorkspaceTeam).mockResolvedValue(
      snapshot({
        tasks: [
          { ...base, id: "k-pre", title: "先定接口契约", status: "done", assigneeId: me.id, blockedBy: [] },
          {
            ...base,
            id: "k-post",
            title: "按契约写实现",
            status: "todo",
            assigneeId: me.id,
            blockedBy: ["k-pre"],
          },
        ],
      }),
    );
    render(<TeamWorkspace />);
    const marker = await screen.findByTestId("task-blocked-by");
    expect(marker).toHaveTextContent("前置「先定接口契约」已完成");
    expect(marker.getAttribute("data-open")).toBe("false");
    expect(marker.className).not.toContain("warn");
  });

  it("派活时能选前置任务，并把它带进请求", async () => {
    vi.mocked(createTeamTask).mockResolvedValue(snapshot().tasks[0]!);
    const base = snapshot().tasks[0]!;
    vi.mocked(fetchWorkspaceTeam).mockResolvedValue(
      snapshot({
        tasks: [{ ...base, id: "k-pre", title: "先定接口契约", status: "todo", assigneeId: me.id }],
      }),
    );
    render(<TeamWorkspace />);
    fireEvent.click(await screen.findByRole("button", { name: "派任务" }));
    fireEvent.change(screen.getByLabelText("任务标题"), { target: { value: "按契约写实现" } });
    const picker = await screen.findByLabelText("前置任务");
    await waitFor(() => expect(within(picker).getByRole("option", { name: "先定接口契约" })).toBeInTheDocument());
    fireEvent.change(picker, { target: { value: "k-pre" } });
    fireEvent.click(screen.getByRole("button", { name: "发布任务" }));
    await waitFor(() =>
      expect(createTeamTask).toHaveBeenCalledWith(
        "t1",
        expect.objectContaining({ title: "按契约写实现", blockedBy: ["k-pre"] }),
      ),
    );
  });
});

describe("团队概览：顶部一行把进度说清（d.257）", () => {
  it("数出未完成、逾期、待认领、被前置卡住与已完成", async () => {
    const now = Date.now();
    vi.mocked(fetchWorkspaceTeam).mockResolvedValue(
      snapshot({
        tasks: [
          {
            id: "k1",
            teamId: "t1",
            planId: null,
            title: "过期还没人认领",
            detail: "",
            assigneeId: null,
            status: "todo",
            createdBy: me.id,
            createdAt: iso,
            updatedAt: iso,
            dueAt: new Date(now - 86_400_000).toISOString(),
            attachmentFileId: null,
          },
          {
            id: "k2",
            teamId: "t1",
            planId: null,
            title: "等前置",
            detail: "",
            assigneeId: bob.id,
            status: "todo",
            blockedBy: ["k1"],
            createdBy: me.id,
            createdAt: iso,
            updatedAt: iso,
            dueAt: null,
            attachmentFileId: null,
          },
          {
            id: "k3",
            teamId: "t1",
            planId: null,
            title: "已经做完",
            detail: "",
            assigneeId: bob.id,
            status: "done",
            createdBy: me.id,
            createdAt: iso,
            updatedAt: iso,
            dueAt: null,
            attachmentFileId: null,
          },
        ],
      }),
    );

    render(<TeamWorkspace />);
    const summary = await screen.findByTestId("team-summary");
    expect(summary).toHaveTextContent(
      "进度：2 项未完成（逾期 1、待认领 1、被前置卡住 1） · 已完成 1",
    );
    expect(summary).toHaveAttribute("data-overdue", "true");
  });

  it("没有逾期时不标红", async () => {
    render(<TeamWorkspace />);
    const summary = await screen.findByTestId("team-summary");
    expect(summary).toHaveTextContent("进度：1 项未完成");
    expect(summary).toHaveAttribute("data-overdue", "false");
  });
});

describe("退回任务：填一句原因就放回待认领（d.261）", () => {
  it("点「退回」→ 写原因 → 确认，发的是 assigneeId: null + returnNote", async () => {
    vi.mocked(updateTeamTask).mockResolvedValue({
      ...snapshot().tasks[0],
      assigneeId: null,
      status: "todo",
    });
    render(<TeamWorkspace />);
    await screen.findByText("产出本周周报初稿");

    fireEvent.click(screen.getByRole("button", { name: "退回任务 产出本周周报初稿" }));
    const form = await screen.findByTestId("task-return-form");
    fireEvent.change(within(form).getByLabelText("退回原因 产出本周周报初稿"), {
      target: { value: "这周排满了，下周再接" },
    });
    fireEvent.click(within(form).getByRole("button", { name: "确认退回" }));

    await waitFor(() =>
      expect(updateTeamTask).toHaveBeenCalledWith(
        "t1",
        "k1",
        { assigneeId: null, returnNote: "这周排满了，下周再接" },
      ),
    );
  });

  it("被退回过的任务在行里能看到「谁、为什么、什么时候」", async () => {
    vi.mocked(fetchWorkspaceTeam).mockResolvedValue(
      snapshot({
        tasks: [
          {
            ...snapshot().tasks[0],
            assigneeId: null,
            returnedAt: "2026-11-17T08:00:00.000Z",
            returnedBy: bob.id,
            returnNote: "没有发布权限，需要管理员来做",
          },
        ],
      }),
    );
    render(<TeamWorkspace />);
    const badge = await screen.findByTestId("task-returned");
    expect(badge).toHaveTextContent("退回过");
    expect(badge).toHaveTextContent("没有发布权限");
    expect(badge).toHaveAttribute("title", expect.stringContaining("退回过"));
  });
});

describe("进展：任务行里能看到做到哪了（d.262）", () => {
  it("有进展时显示「进展（谁，时间）：内容」", async () => {
    vi.mocked(fetchWorkspaceTeam).mockResolvedValue(
      snapshot({
        tasks: [
          {
            ...snapshot().tasks[0],
            status: "doing",
            progress: "接口契约已对齐，正在写 handler",
            progressAt: "2026-11-17T08:00:00.000Z",
            progressBy: bob.id,
          },
        ],
      }),
    );
    render(<TeamWorkspace />);
    const line = await screen.findByTestId("task-progress");
    expect(line).toHaveTextContent("进展（鲍勃，");
    expect(line).toHaveTextContent("正在写 handler");
  });
});

describe("催办痕迹（d.265）", () => {
  it("被催过的任务显示「催过几次、谁催的、最近一次什么时候」", async () => {
    vi.mocked(fetchWorkspaceTeam).mockResolvedValue({
      team: { id: "t1", name: "产品组", goal: "", ownerId: "u1", createdAt: iso, updatedAt: iso },
      members: [
        { user: { id: "u1", username: "boss", displayName: "阿鸣" }, role: "owner", joinedAt: iso },
        { user: { id: "u2", username: "mate", displayName: "小李" }, role: "member", joinedAt: iso },
      ],
      plans: [],
      tasks: [
        {
          id: "k9",
          teamId: "t1",
          planId: null,
          title: "交周报",
          detail: "",
          assigneeId: "u2",
          status: "todo",
          createdBy: "u1",
          createdAt: iso,
          updatedAt: iso,
          dueAt: null,
          attachmentFileId: null,
          nudgedAt: iso,
          nudgedBy: "u1",
          nudgeCount: 2,
        },
      ],
    });
    render(<TeamWorkspace />);
    const badge = await screen.findByTestId("task-nudged");
    expect(badge.textContent).toContain("催过 2 次");
    expect(badge.textContent).toContain("阿鸣");
  });
});

describe("催一下 / 写进展：在任务行里直接推进（1.5）", () => {
  it("组长点「催一下」→ 发 nudge:true（只记催办不动状态）", async () => {
    vi.mocked(updateTeamTask).mockResolvedValue(snapshot().tasks[0]);
    render(<TeamWorkspace />);
    await screen.findByText("产出本周周报初稿");
    fireEvent.click(screen.getByRole("button", { name: "催一下 产出本周周报初稿" }));
    await waitFor(() =>
      expect(updateTeamTask).toHaveBeenCalledWith("t1", "k1", { nudge: true }),
    );
  });

  it("非组长看不到「催一下」按钮", async () => {
    // owner 换成 bob（不是 me），me 只是普通成员
    vi.mocked(fetchWorkspaceTeam).mockResolvedValue(snapshot({ team: team({ ownerId: bob.id }) }));
    render(<TeamWorkspace />);
    await screen.findByText("产出本周周报初稿");
    expect(screen.queryByRole("button", { name: "催一下 产出本周周报初稿" })).toBeNull();
  });

  it("点「写进展」→ 填内容 → 保存，发 progress（覆盖式一条）", async () => {
    vi.mocked(updateTeamTask).mockResolvedValue(snapshot().tasks[0]);
    render(<TeamWorkspace />);
    await screen.findByText("产出本周周报初稿");
    fireEvent.click(screen.getByRole("button", { name: "写进展 产出本周周报初稿" }));
    const form = await screen.findByTestId("task-progress-form");
    fireEvent.change(within(form).getByLabelText("进展内容 产出本周周报初稿"), {
      target: { value: "接口已对齐，正在写 handler" },
    });
    fireEvent.click(within(form).getByRole("button", { name: "保存进展" }));
    await waitFor(() =>
      expect(updateTeamTask).toHaveBeenCalledWith("t1", "k1", { progress: "接口已对齐，正在写 handler" }),
    );
  });

  it("进展内容为空时不发请求，提示先写一句", async () => {
    render(<TeamWorkspace />);
    await screen.findByText("产出本周周报初稿");
    fireEvent.click(screen.getByRole("button", { name: "写进展 产出本周周报初稿" }));
    const form = await screen.findByTestId("task-progress-form");
    fireEvent.click(within(form).getByRole("button", { name: "保存进展" }));
    expect(updateTeamTask).not.toHaveBeenCalled();
  });
});

describe("按关键词找任务（d.266）", () => {
  it("输入关键词只留命中的活，清空恢复", async () => {
    const base = snapshot().tasks[0]!;
    vi.mocked(fetchWorkspaceTeam).mockResolvedValue(
      snapshot({
        tasks: [
          { ...base, id: "k-api", title: "接口联调", detail: "按契约接上" },
          { ...base, id: "k-report", title: "写周报", detail: "" },
        ],
      }),
    );
    render(<TeamWorkspace />);
    expect(await screen.findByText("接口联调")).toBeInTheDocument();

    fireEvent.change(screen.getByTestId("task-search"), { target: { value: "接口" } });
    expect(screen.getByText("接口联调")).toBeInTheDocument();
    expect(screen.queryByText("写周报")).toBeNull();
    expect(screen.getByTestId("task-search-count").textContent).toContain("命中 1 条");

    fireEvent.click(screen.getByRole("button", { name: "清空" }));
    expect(await screen.findByText("写周报")).toBeInTheDocument();
  });
});

describe("优先级（d.268）", () => {
  it("新建任务可以选「高」：请求带上 priority，卡片出现高徽标", async () => {
    vi.mocked(fetchWorkspaceTeam).mockResolvedValue(
      snapshot({
        tasks: [
          { ...snapshot().tasks[0]!, id: "k-urgent", title: "线上故障排查", priority: "high" },
        ],
      }),
    );
    render(<TeamWorkspace />);
    expect(await screen.findByText("线上故障排查")).toBeInTheDocument();
    const card = screen.getByText("线上故障排查").closest("li") as HTMLElement;
    expect(within(card).getByTestId("task-priority-high")).toBeInTheDocument();
  });

  it("任务卡片上能直接改优先级", async () => {
    render(<TeamWorkspace />);
    expect(await screen.findByText("产出本周周报初稿")).toBeInTheDocument();
    fireEvent.change(screen.getByLabelText("任务优先级 产出本周周报初稿"), {
      target: { value: "high" },
    });
    await waitFor(() =>
      expect(updateTeamTask).toHaveBeenCalledWith("t1", "k1", { priority: "high" }),
    );
  });
});

describe("周报（d.269）", () => {
  it("生成周报：弹窗里能看到成稿，复制与导出 .md 走同一份文本", async () => {
    const writeText = vi.fn().mockResolvedValue(undefined);
    Object.defineProperty(navigator, "clipboard", {
      value: { writeText },
      configurable: true,
    });
    const write = vi.fn().mockResolvedValue({
      ok: true,
      path: "D:\\Heming\\exports\\团队周报-增长小组-20261118.md",
    });
    (window as unknown as { __heming_exports?: unknown }).__heming_exports = { write };

    try {
      render(<TeamWorkspace />);
      fireEvent.click(await screen.findByRole("button", { name: "生成团队周报" }));
      const dialog = await screen.findByRole("dialog", { name: "团队周报" });
      const report = within(dialog).getByTestId("weekly-report");
      expect(report.textContent).toContain("# 团队周报 · 增长小组");
      expect(report.textContent).toContain("## 成员负荷");
      expect(report.textContent).toContain("## 下周建议");

      fireEvent.click(within(dialog).getByRole("button", { name: "复制" }));
      await waitFor(() => expect(writeText).toHaveBeenCalledTimes(1));
      expect(writeText.mock.calls[0]![0]).toBe(report.textContent);

      fireEvent.click(within(dialog).getByRole("button", { name: "导出 .md" }));
      await waitFor(() => expect(write).toHaveBeenCalledTimes(1));
      const [fileName, content] = write.mock.calls[0]!;
      expect(String(fileName)).toMatch(/^团队周报-增长小组-\d{8}\.md$/);
      expect(content).toBe(report.textContent);
      expect(await screen.findByText(/周报已保存到/)).toBeInTheDocument();

      fireEvent.click(within(dialog).getByRole("button", { name: "关闭" }));
      await waitFor(() => expect(screen.queryByRole("dialog", { name: "团队周报" })).toBeNull());
    } finally {
      delete (window as unknown as { __heming_exports?: unknown }).__heming_exports;
    }
  });

  it("切换回看天数会重算成稿（痛点 10：不再固定 7 天）", async () => {
    render(<TeamWorkspace />);
    fireEvent.click(await screen.findByRole("button", { name: "生成团队周报" }));
    const dialog = await screen.findByRole("dialog", { name: "团队周报" });
    const report = within(dialog).getByTestId("weekly-report");
    expect(report.textContent).toContain("（7 天）");

    fireEvent.change(within(dialog).getByLabelText("周报回看天数"), {
      target: { value: "30" },
    });
    expect(report.textContent).toContain("（30 天）");
    expect(report.textContent).not.toContain("（7 天）");
    expect(within(dialog).getByLabelText("周报回看天数")).toHaveValue("30");

    // 复制的仍是同一份新文本（成稿只算一次、切档后重算）。
    const writeText = vi.fn().mockResolvedValue(undefined);
    Object.defineProperty(navigator, "clipboard", {
      value: { writeText },
      configurable: true,
    });
    fireEvent.click(within(dialog).getByRole("button", { name: "复制" }));
    await waitFor(() => expect(writeText).toHaveBeenCalledTimes(1));
    expect(writeText.mock.calls[0]![0]).toBe(report.textContent);
  });
});
describe("任务讨论（d.271）", () => {
  beforeEach(() => {
    vi.mocked(fetchTeamTaskComments).mockReset().mockResolvedValue({ comments: [] });
    vi.mocked(createTeamTaskComment).mockReset().mockResolvedValue({
      id: "cm1",
      teamId: "t1",
      taskId: "k1",
      authorId: me.id,
      text: "口径按 v2 来",
      createdAt: iso,
    });
  });

  it("展开讨论能拉到留言，发出的一句立刻出现在时间线里", async () => {
    vi.mocked(fetchTeamTaskComments).mockResolvedValue({
      comments: [
        {
          id: "cm0",
          teamId: "t1",
          taskId: "k1",
          authorId: bob.id,
          text: "这个接口按 v1 还是 v2？",
          createdAt: iso,
        },
      ],
    });
    render(<TeamWorkspace />);
    const panel = await screen.findByRole("region", { name: "团队任务" });
    fireEvent.click(within(panel).getByRole("button", { name: /任务讨论/ }));

    const box = await within(panel).findByTestId("task-comments");
    expect(within(box).getByText(/这个接口按 v1 还是 v2？/)).toBeInTheDocument();
    expect(vi.mocked(fetchTeamTaskComments)).toHaveBeenCalledWith("t1", "k1");

    fireEvent.change(within(box).getByTestId("task-comment-input"), {
      target: { value: "口径按 v2 来" },
    });
    fireEvent.click(within(box).getByTestId("task-comment-send"));

    expect(await within(box).findByText("口径按 v2 来")).toBeInTheDocument();
    expect(vi.mocked(createTeamTaskComment)).toHaveBeenCalledWith("t1", "k1", "口径按 v2 来");
    expect(within(box).getByText(/阿鸣/)).toBeInTheDocument();
  });
});

describe("验收（d.272）", () => {
  const doneTask = (over: Record<string, unknown> = {}) => ({
    ...snapshot().tasks[0]!,
    id: "k1",
    title: "产出本周周报初稿",
    status: "done" as const,
    result: "初稿在共享文件库里。",
    ...over,
  });

  it("组长看到「待验收」徽标与验收入口：打回会带上原因", async () => {
    vi.mocked(fetchWorkspaceTeam).mockResolvedValue(
      snapshot({ tasks: [doneTask({ reviewState: "pending" })] }),
    );
    vi.mocked(updateTeamTask).mockResolvedValue(
      doneTask({ reviewState: "changes", status: "doing" }) as never,
    );
    render(<TeamWorkspace />);
    // 任务板默认只看未完成；验收看的是已完成的活，先切到「已完成」。
    const filters = await screen.findByRole("group", { name: "任务筛选" });
    fireEvent.click(within(filters).getByRole("button", { name: "已完成" }));
    expect(await screen.findByText("产出本周周报初稿")).toBeInTheDocument();
    const card = screen.getByText("产出本周周报初稿").closest("li") as HTMLElement;
    expect(within(card).getByTestId("task-review-state").textContent).toContain("待验收");

    fireEvent.change(within(card).getByLabelText("验收意见 产出本周周报初稿"), {
      target: { value: "少了回滚步骤，补上再交。" },
    });
    fireEvent.click(within(card).getByLabelText("要求修改 产出本周周报初稿"));
    await waitFor(() =>
      expect(updateTeamTask).toHaveBeenCalledWith("t1", "k1", {
        review: "changes",
        reviewNote: "少了回滚步骤，补上再交。",
      }),
    );
  });

  it("打回不写原因：只提示，不发请求", async () => {
    vi.mocked(fetchWorkspaceTeam).mockResolvedValue(snapshot({ tasks: [doneTask()] }));
    render(<TeamWorkspace />);
    const filters = await screen.findByRole("group", { name: "任务筛选" });
    fireEvent.click(within(filters).getByRole("button", { name: "已完成" }));
    const card = (await screen.findByText("产出本周周报初稿")).closest("li") as HTMLElement;
    fireEvent.click(within(card).getByLabelText("要求修改 产出本周周报初稿"));
    expect(await screen.findByText(/打回重做要写一句原因/)).toBeInTheDocument();
    expect(updateTeamTask).not.toHaveBeenCalled();
  });

  it("已验收的任务只留徽标，不再给验收按钮", async () => {
    vi.mocked(fetchWorkspaceTeam).mockResolvedValue(
      snapshot({ tasks: [doneTask({ reviewState: "approved", reviewNote: "看过，可以。" })] }),
    );
    render(<TeamWorkspace />);
    const filters = await screen.findByRole("group", { name: "任务筛选" });
    fireEvent.click(within(filters).getByRole("button", { name: "已完成" }));
    const card = (await screen.findByText("产出本周周报初稿")).closest("li") as HTMLElement;
    expect(within(card).getByTestId("task-review-state").textContent).toContain("已验收");
    expect(within(card).queryByLabelText("要求修改 产出本周周报初稿")).toBeNull();
  });
});

describe("任务流水（d.273，原「团队动态」按方案 1.1 消歧）", () => {
  it("展开动态能拉到时间线：时间、谁、做了什么", async () => {
    vi.mocked(fetchTeamEvents).mockResolvedValue({
      events: [
        {
          id: "e2",
          teamId: "t1",
          taskId: "k1",
          taskTitle: "改落地页",
          actorId: bob.id,
          kind: "task_updated",
          summary: "把「改落地页」从进行中改成已完成",
          createdAt: iso,
        },
        {
          id: "e1",
          teamId: "t1",
          taskId: null,
          taskTitle: "",
          actorId: me.id,
          kind: "plan_added",
          summary: "新增方案「拉新」",
          createdAt: iso,
        },
      ],
    });

    render(<TeamWorkspace />);
    const panel = await screen.findByRole("region", { name: "任务流水" });
    fireEvent.click(within(panel).getByRole("button", { name: "看动态" }));

    const box = await within(panel).findByTestId("team-events");
    expect(within(box).getByText(/把「改落地页」从进行中改成已完成/)).toBeInTheDocument();
    expect(within(box).getByText(/新增方案「拉新」/)).toBeInTheDocument();
    expect(within(box).getByText("鲍勃")).toBeInTheDocument();
    expect(within(box).getByText("改动")).toBeInTheDocument();
    expect(within(box).getByText("新方案")).toBeInTheDocument();
    expect(vi.mocked(fetchTeamEvents)).toHaveBeenCalledWith("t1", undefined, 20);
  });

  it("按「方案 / 成员」筛动态（d.274）", async () => {
    vi.mocked(fetchTeamEvents).mockResolvedValue({
      events: [
        {
          id: "e3",
          teamId: "t1",
          taskId: "k1",
          taskTitle: "改落地页",
          actorId: bob.id,
          kind: "task_updated",
          summary: "把「改落地页」从进行中改成已完成",
          createdAt: iso,
        },
        {
          id: "e2",
          teamId: "t1",
          taskId: null,
          taskTitle: "",
          actorId: me.id,
          kind: "plan_added",
          summary: "新建方案「拉新」",
          createdAt: iso,
        },
        {
          id: "e1",
          teamId: "t1",
          taskId: null,
          taskTitle: "",
          actorId: me.id,
          kind: "member_added",
          summary: "把 鲍勃 加进了团队",
          createdAt: iso,
        },
      ],
    });

    render(<TeamWorkspace />);
    const panel = await screen.findByRole("region", { name: "任务流水" });
    fireEvent.click(within(panel).getByRole("button", { name: "看动态" }));
    const box = await within(panel).findByTestId("team-events");
    expect(within(box).getByText(/新建方案「拉新」/)).toBeInTheDocument();

    const filters = within(box).getByRole("group", { name: "动态筛选" });
    fireEvent.click(within(filters).getByRole("button", { name: "方案" }));
    expect(within(box).getByText(/新建方案「拉新」/)).toBeInTheDocument();
    expect(within(box).queryByText(/把「改落地页」从进行中改成已完成/)).toBeNull();
    expect(within(box).queryByText(/加进了团队/)).toBeNull();

    fireEvent.click(within(filters).getByRole("button", { name: "成员" }));
    expect(within(box).getByText(/加进了团队/)).toBeInTheDocument();

    fireEvent.click(within(filters).getByRole("button", { name: "全部" }));
    expect(within(box).getByText(/把「改落地页」从进行中改成已完成/)).toBeInTheDocument();
  });

  it("按「待验收」筛任务板（d.275）", async () => {
    vi.mocked(fetchWorkspaceTeam).mockResolvedValue(
      snapshot({
        tasks: [
          {
            ...snapshot().tasks[0]!,
            id: "k-review",
            title: "交上来的周报",
            status: "done",
            reviewState: "pending",
            assigneeId: bob.id,
            result: "初稿",
          },
          {
            ...snapshot().tasks[0]!,
            id: "k-approved",
            title: "早就验收过的",
            status: "done",
            reviewState: "approved",
            assigneeId: bob.id,
          },
          {
            ...snapshot().tasks[0]!,
            id: "k-open",
            title: "还没做的",
            status: "todo",
          },
        ],
      }),
    );

    render(<TeamWorkspace />);
    const filters = await screen.findByRole("group", { name: "任务筛选" });
    fireEvent.click(within(filters).getByRole("button", { name: "待验收" }));
    expect(await screen.findByText("交上来的周报")).toBeInTheDocument();
    expect(screen.queryByText("早就验收过的")).toBeNull();
    expect(screen.queryByText("还没做的")).toBeNull();
  });

  it("没有动态时说清楚，不显示空列表", async () => {
    vi.mocked(fetchTeamEvents).mockResolvedValue({ events: [] });
    render(<TeamWorkspace />);
    const panel = await screen.findByRole("region", { name: "任务流水" });
    fireEvent.click(within(panel).getByRole("button", { name: "看动态" }));
    expect(await within(panel).findByText(/还没有动态/)).toBeInTheDocument();
  });

  it("动态可搜索：按关键词过滤摘要/人/类型", async () => {
    vi.mocked(fetchTeamEvents).mockResolvedValue({
      events: [
        {
          id: "e2",
          teamId: "t1",
          taskId: "k1",
          taskTitle: "",
          actorId: bob.id,
          kind: "task_updated",
          summary: "把状态改成已完成",
          createdAt: iso,
        },
        {
          id: "e1",
          teamId: "t1",
          taskId: null,
          taskTitle: "",
          actorId: me.id,
          kind: "plan_added",
          summary: "新增方案「拉新」",
          createdAt: iso,
        },
      ],
    });
    render(<TeamWorkspace />);
    const panel = await screen.findByRole("region", { name: "任务流水" });
    fireEvent.click(within(panel).getByRole("button", { name: "看动态" }));
    const box = await within(panel).findByTestId("team-events");
    const search = within(box).getByRole("searchbox", { name: "搜索动态" });

    fireEvent.change(search, { target: { value: "拉新" } });
    expect(within(box).getByText(/新增方案「拉新」/)).toBeInTheDocument();
    expect(within(box).queryByText(/改成已完成/)).toBeNull();

    fireEvent.change(search, { target: { value: "鲍勃" } });
    expect(within(box).getByText(/改成已完成/)).toBeInTheDocument();
    expect(within(box).queryByText(/新增方案「拉新」/)).toBeNull();

    fireEvent.change(search, { target: { value: "不存在的词" } });
    expect(within(box).getByText(/没有匹配的动态/)).toBeInTheDocument();
  });

  it("动态可加载更早：逐档提高 limit 再拉一次", async () => {
    const makeEvents = (n: number) =>
      Array.from({ length: n }, (_, i) => ({
        id: `e${i}`,
        teamId: "t1",
        taskId: null,
        taskTitle: "",
        actorId: me.id,
        kind: "task_updated" as const,
        summary: `第 ${i} 条动态`,
        createdAt: iso,
      }));
    vi.mocked(fetchTeamEvents).mockResolvedValueOnce({ events: makeEvents(20) });
    render(<TeamWorkspace />);
    const panel = await screen.findByRole("region", { name: "任务流水" });
    fireEvent.click(within(panel).getByRole("button", { name: "看动态" }));
    const box = await within(panel).findByTestId("team-events");
    expect(vi.mocked(fetchTeamEvents)).toHaveBeenLastCalledWith("t1", undefined, 20);

    const more = within(box).getByRole("button", { name: /加载更早/ });
    vi.mocked(fetchTeamEvents).mockResolvedValueOnce({ events: makeEvents(40) });
    fireEvent.click(more);
    await waitFor(() => expect(vi.mocked(fetchTeamEvents)).toHaveBeenLastCalledWith("t1", undefined, 40));
  });
});

describe("单件任务的历史（d.276）", () => {
  it("点「历史」只拉这一条活的流水，别人改的不混进来", async () => {
    vi.mocked(fetchTeamEvents).mockReset().mockResolvedValue({
      events: [
        {
          id: "ev2",
          teamId: "t1",
          taskId: "k1",
          taskTitle: "写落地页",
          actorId: bob.id,
          kind: "task_updated",
          summary: "把「写落地页」从进行中改成已完成",
          createdAt: iso,
        },
        {
          id: "ev1",
          teamId: "t1",
          taskId: "k1",
          taskTitle: "写落地页",
          actorId: me.id,
          kind: "task_added",
          summary: "新建任务「写落地页」",
          createdAt: iso,
        },
      ],
    });

    render(<TeamWorkspace />);
    const panel = await screen.findByRole("region", { name: "团队任务" });
    fireEvent.click(within(panel).getByRole("button", { name: /任务历史/ }));

    const box = await within(panel).findByTestId("task-history");
    expect(within(box).getByText(/从进行中改成已完成/)).toBeInTheDocument();
    expect(within(box).getByText(/新建任务「写落地页」/)).toBeInTheDocument();
    expect(vi.mocked(fetchTeamEvents)).toHaveBeenCalledWith("t1", undefined, 20, "k1");

    // 再点一次收起，不重复请求。
    fireEvent.click(within(panel).getByRole("button", { name: /任务历史/ }));
    expect(within(panel).queryByTestId("task-history")).toBeNull();
    expect(vi.mocked(fetchTeamEvents)).toHaveBeenCalledTimes(1);
  });
});

describe("团队发现 + 加入申请（社交化加入）", () => {
  const directoryTeam = {
    id: "t2",
    name: "课程组",
    goal: "一起做课",
    memberCount: 3,
    createdAt: iso,
  };

  it("搜索目录只展示元数据，申请后调用 createJoinRequest", async () => {
    vi.mocked(discoverTeams).mockResolvedValue({ teams: [directoryTeam] });
    render(<TeamWorkspace />);
    await screen.findByRole("heading", { name: "增长小组" });

    fireEvent.click(screen.getByRole("button", { name: "找团队" }));
    const dialog = await screen.findByRole("dialog", { name: "找团队" });
    // 打开即自动拉一次目录
    await waitFor(() => expect(within(dialog).getByText("课程组")).toBeInTheDocument());
    expect(within(dialog).getByText(/3 名成员/)).toBeInTheDocument();

    fireEvent.change(within(dialog).getByLabelText("搜索团队"), { target: { value: "课程" } });
    fireEvent.click(within(dialog).getByRole("button", { name: "搜索" }));
    await waitFor(() => expect(discoverTeams).toHaveBeenCalledWith("课程"));

    fireEvent.click(within(dialog).getByRole("button", { name: "申请加入" }));
    fireEvent.change(within(dialog).getByLabelText("申请附言"), { target: { value: "想加入" } });
    vi.mocked(createJoinRequest).mockResolvedValue({
      id: "jr1", teamId: "t2", userId: me.id, message: "想加入",
      status: "pending", createdAt: iso, reviewedAt: null,
    });
    vi.mocked(fetchMyJoinRequests).mockResolvedValue({
      requests: [{ id: "jr1", teamId: "t2", userId: me.id, message: "想加入",
        status: "pending", createdAt: iso, reviewedAt: null }],
    });
    fireEvent.click(within(dialog).getByRole("button", { name: "提交申请" }));
    await waitFor(() =>
      expect(createJoinRequest).toHaveBeenCalledWith("t2", "想加入"),
    );
    expect(await within(dialog).findByText(/已申请加入「课程组」/)).toBeInTheDocument();
  });

  it("队长看到待审申请并通过，调用 reviewJoinRequest(approve)", async () => {
    vi.mocked(fetchJoinRequests).mockResolvedValue({
      requests: [{ id: "jr2", teamId: "t1", userId: "u3", message: "请通过",
        status: "pending", createdAt: iso, reviewedAt: null }],
    });
    vi.mocked(reviewJoinRequest).mockResolvedValue({
      id: "jr2", teamId: "t1", userId: "u3", message: "请通过",
      status: "approved", createdAt: iso, reviewedAt: iso,
    });
    render(<TeamWorkspace />);
    await screen.findByRole("heading", { name: "增长小组" });
    const pending = await screen.findByText(/待审加入申请（1）/);
    const box = pending.parentElement!;
    fireEvent.click(within(box).getByRole("button", { name: "通过" }));
    await waitFor(() =>
      expect(reviewJoinRequest).toHaveBeenCalledWith("t1", "jr2", "approve"),
    );
  });

  it("非队长看不到待审申请区", async () => {
    // 快照里 ownerId 改成别人，我作为普通成员
    vi.mocked(fetchWorkspaceTeam).mockResolvedValue(
      snapshot({ team: team({ ownerId: bob.id }) }),
    );
    render(<TeamWorkspace />);
    await screen.findByRole("heading", { name: "增长小组" });
    expect(screen.queryByText(/待审加入申请/)).toBeNull();
    expect(fetchJoinRequests).not.toHaveBeenCalled();
  });
});
