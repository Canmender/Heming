import { beforeEach, describe, expect, it, vi } from "vitest";
import { fireEvent, render, screen, waitFor, within } from "@testing-library/react";
import type { TeamWorkspaceSnapshot } from "@heming/shared";
import { TeamWorkspace } from "./TeamWorkspace.js";
import {
  addWorkspaceMember,
  createTeamPlan,
  createTeamTask,
  createWorkspaceTeam,
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
  vi.mocked(updateTaskRefresh());
  useAuthStore.setState({ token: "t1", user: me, status: "authed", error: null });
});

/** create/update 之后组件会重新拉快照：默认返回带新数据的版本。 */
function updateTaskRefresh() {
  return vi.mocked(fetchWorkspaceTeam).mockResolvedValue(snapshot());
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

    fireEvent.click(screen.getByRole("button", { name: `移除成员 卡罗` }));
    await waitFor(() => expect(removeWorkspaceMember).toHaveBeenCalledWith("t1", "u3"));
    unmount();

    // 非 owner（鲍勃视角）：没有删除团队 / 添加成员 / 移除成员
    useAuthStore.setState({ token: "t2", user: bob, status: "authed", error: null });
    render(<TeamWorkspace />);
    await screen.findByText("先把周报自动化");
    expect(screen.queryByRole("button", { name: "删除团队" })).toBeNull();
    expect(screen.queryByLabelText("成员用户名")).toBeNull();
    expect(screen.queryByRole("button", { name: /移除成员/ })).toBeNull();
  });
});
