import { beforeEach, describe, expect, it, vi } from "vitest";
import { fireEvent, render, screen, waitFor, within, act } from "@testing-library/react";
import type { TeamWorkspaceSnapshot } from "@heming/shared";
import { TeamWorkspace } from "./TeamWorkspace.js";
import {
  addWorkspaceMember,
  createTeamPlan,
  createTeamTask,
  createWorkspaceTeam,
  deleteTeamPlan,
  deleteTeamTask,
  deleteWorkspaceTeam,
  fetchWorkspaceTeam,
  fetchWorkspaceTeams,
  removeWorkspaceMember,
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
    deleteWorkspaceTeam: vi.fn(),
    addWorkspaceMember: vi.fn(),
    removeWorkspaceMember: vi.fn(),
    createTeamPlan: vi.fn(),
    updateTeamPlan: vi.fn(),
    deleteTeamPlan: vi.fn(),
    createTeamTask: vi.fn(),
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
  vi.mocked(addWorkspaceMember).mockReset();
  vi.mocked(removeWorkspaceMember).mockReset();
  vi.mocked(createTeamPlan).mockReset();
  vi.mocked(updateTeamPlan).mockReset();
  vi.mocked(createTeamTask).mockReset();
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
    let planDialog = await screen.findByRole("dialog", { name: "删除方案" });
    expect(deleteTeamPlan).not.toHaveBeenCalled();
    fireEvent.click(within(planDialog).getByRole("button", { name: "取消" }));
    await waitFor(() => expect(screen.queryByRole("dialog", { name: "删除方案" })).toBeNull());
    expect(deleteTeamPlan).not.toHaveBeenCalled();

    fireEvent.click(screen.getByRole("button", { name: "删除方案 先把周报自动化" }));
    planDialog = await screen.findByRole("dialog", { name: "删除方案" });
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
    let taskDialog = await screen.findByRole("dialog", { name: "删除任务" });
    expect(deleteTeamTask).not.toHaveBeenCalled();
    fireEvent.click(within(taskDialog).getByRole("button", { name: "取消" }));
    await waitFor(() => expect(screen.queryByRole("dialog", { name: "删除任务" })).toBeNull());
    expect(deleteTeamTask).not.toHaveBeenCalled();

    fireEvent.click(screen.getByRole("button", { name: "删除任务 产出本周周报初稿" }));
    taskDialog = await screen.findByRole("dialog", { name: "删除任务" });
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
    let removeDialog = await screen.findByRole("dialog", { name: "移除成员" });
    expect(within(removeDialog).getByText(/解绑为待认领/)).toBeInTheDocument();
    expect(within(removeDialog).getByRole("button", { name: "取消" })).toHaveFocus();
    expect(removeWorkspaceMember).not.toHaveBeenCalled();
    fireEvent.click(within(removeDialog).getByRole("button", { name: "取消" }));
    await waitFor(() => expect(screen.queryByRole("dialog", { name: "移除成员" })).toBeNull());
    expect(removeWorkspaceMember).not.toHaveBeenCalled();

    fireEvent.click(screen.getByRole("button", { name: "移除成员 卡罗" }));
    removeDialog = await screen.findByRole("dialog", { name: "移除成员" });
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

  it("删除团队：先出确认框，取消不调 API，确认后调用一次", async () => {
    render(<TeamWorkspace />);
    await screen.findByRole("region", { name: "团队概况" });
    vi.mocked(deleteWorkspaceTeam).mockResolvedValue(undefined);
    const confirmSpy = vi.spyOn(window, "confirm");

    fireEvent.click(screen.getByRole("button", { name: "删除团队" }));
    let dialog = await screen.findByRole("dialog", { name: "删除团队" });
    // 初始焦点在「取消」：误按回车不会删掉团队。
    expect(within(dialog).getByRole("button", { name: "取消" })).toHaveFocus();
    expect(deleteWorkspaceTeam).not.toHaveBeenCalled();
    fireEvent.click(within(dialog).getByRole("button", { name: "取消" }));
    await waitFor(() => expect(screen.queryByRole("dialog", { name: "删除团队" })).toBeNull());
    expect(deleteWorkspaceTeam).not.toHaveBeenCalled();

    fireEvent.click(screen.getByRole("button", { name: "删除团队" }));
    dialog = await screen.findByRole("dialog", { name: "删除团队" });
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
});
