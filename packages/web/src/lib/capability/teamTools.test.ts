import { describe, it, expect, beforeEach, vi } from "vitest";
import type { TeamTask, TeamWorkspaceSnapshot } from "@heming/shared";

/**
 * 团队工作台工具的接线测试：不碰真实网络。
 *
 * 只 mock `lib/api.js`——工具层本身没有网络逻辑，它只负责
 * 参数校验 / 调用哪个 API / 文本怎么给模型 / 错误怎么透出。
 * URL 与 method 的正确性由 `lib/api.test.ts` 用 fetch spy 断言。
 */
const apiMock = vi.hoisted(() => ({
  fetchWorkspaceTeams: vi.fn(),
  fetchWorkspaceTeam: vi.fn(),
  createWorkspaceTeam: vi.fn(),
  updateWorkspaceTeam: vi.fn(),
  addWorkspaceMember: vi.fn(),
  createTeamPlan: vi.fn(),
  updateTeamPlan: vi.fn(),
  createTeamTask: vi.fn(),
  updateTeamTask: vi.fn(),
}));
vi.mock("../api.js", () => apiMock);

import { TEAM_TOOLS, buildTeamToolBridge, formatTeamSnapshot, teamProvider } from "./teamTools.js";

const CTX = { agentId: "a1", conversationId: "c1" };

const T0 = "2026-11-07T10:00:00.000Z";
const team = {
  id: "t1",
  name: "增长小组",
  goal: "把周活提升 10%",
  ownerId: "u1",
  createdAt: T0,
  updatedAt: T0,
};
const members = [
  {
    user: { id: "u1", username: "admin", displayName: "管理员" },
    role: "owner" as const,
    joinedAt: T0,
  },
  {
    user: { id: "u2", username: "linxiao", displayName: "林晓" },
    role: "member" as const,
    joinedAt: T0,
  },
];
const plans = [
  {
    id: "p1",
    teamId: "t1",
    title: "拉新",
    detail: "先做落地页",
    status: "todo" as const,
    orderIndex: 0,
    createdBy: "u1",
    createdAt: T0,
    updatedAt: T0,
  },
];
const task: TeamTask = {
  id: "k1",
  teamId: "t1",
  planId: "p1",
  title: "写落地页",
  detail: "",
  assigneeId: "u2",
  status: "doing",
  createdBy: "u1",
  createdAt: T0,
  updatedAt: T0,
  dueAt: null,
  attachmentFileId: null,
};
const snapshot: TeamWorkspaceSnapshot = { team, members, plans, tasks: [task] };

function bridge() {
  const b = buildTeamToolBridge();
  return {
    names: b.tools.map((t) => (t as { function: { name: string } }).function.name),
    meta: b.meta!,
    run: (name: string, args: Record<string, unknown>) =>
      b.execute({ name, arguments: JSON.stringify(args) }),
  };
}

beforeEach(() => {
  vi.clearAllMocks();
  apiMock.fetchWorkspaceTeams.mockResolvedValue({ teams: [team] });
  apiMock.fetchWorkspaceTeam.mockResolvedValue(snapshot);
  apiMock.createWorkspaceTeam.mockResolvedValue(snapshot);
  apiMock.updateWorkspaceTeam.mockResolvedValue(snapshot);
  apiMock.addWorkspaceMember.mockResolvedValue(snapshot);
  apiMock.createTeamPlan.mockResolvedValue(plans[0]);
  apiMock.updateTeamPlan.mockResolvedValue({ ...plans[0], status: "doing" });
  apiMock.createTeamTask.mockResolvedValue(task);
  apiMock.updateTeamTask.mockResolvedValue({ ...task, status: "done" });
});

describe("团队工具清单", () => {
  it("9 个工具：2 读 + 7 写，名字唯一且都带 team_ 前缀", () => {
    expect(TEAM_TOOLS).toHaveLength(9);
    const reads = TEAM_TOOLS.filter((t) => t.riskHint === "read").map((t) => t.name);
    const writes = TEAM_TOOLS.filter((t) => t.riskHint === "write").map((t) => t.name);
    expect(reads).toEqual(["team_list", "team_get"]);
    expect(writes).toEqual([
      "team_create",
      "team_update",
      "team_member_add",
      "team_plan_add",
      "team_plan_update",
      "team_task_add",
      "team_task_update",
    ]);
    expect(new Set(TEAM_TOOLS.map((t) => t.name)).size).toBe(TEAM_TOOLS.length);
    expect(TEAM_TOOLS.every((t) => t.name.startsWith("team_"))).toBe(true);
  });

  it("工具描述点明「用户自建的团队工作台」、未知 id 先 team_list、写操作会确认", () => {
    for (const spec of TEAM_TOOLS) {
      expect(spec.description).toContain("用户自建的团队工作台");
      expect(spec.description).toContain("不是团队页");
    }
    expect(TEAM_TOOLS.find((t) => t.name === "team_list")!.description).toContain("先调用它");
    expect(TEAM_TOOLS.find((t) => t.name === "team_get")!.description).toContain("先调用 team_list");
    for (const spec of TEAM_TOOLS.filter((t) => t.riskHint === "write")) {
      expect(spec.description).toContain("请用户确认");
    }
  });

  it("meta 给出风险分级：读不打断、写走 HITL", () => {
    const b = bridge();
    expect(b.meta("team_list")).toEqual({ risk: "read" });
    expect(b.meta("team_get")).toEqual({ risk: "read" });
    expect(b.meta("team_task_add")).toEqual({ risk: "write" });
    expect(b.meta("team_task_update")).toEqual({ risk: "write" });
    expect(b.meta("not_a_tool")).toBeUndefined();
  });

  it("team 提供者始终可用（不依赖桌面桥/模块开关）", () => {
    const built = teamProvider.build(CTX);
    expect(built).not.toBeNull();
    expect(built!.tools).toHaveLength(9);
  });
});

describe("读工具", () => {
  it("team_list：列团队 + 成员/任务数，不发任何写请求", async () => {
    const b = bridge();
    const r = await b.run("team_list", {});
    expect(r.ok).toBe(true);
    expect(r.text).toContain("增长小组");
    expect(r.text).toContain("team_id：t1");
    expect(r.text).toContain("成员 2 人");
    expect(r.text).toContain("任务 1 个");
    expect(r.text).toContain("把周活提升 10%");
    // 读工具绝不写
    expect(apiMock.createWorkspaceTeam).not.toHaveBeenCalled();
    expect(apiMock.updateWorkspaceTeam).not.toHaveBeenCalled();
    expect(apiMock.addWorkspaceMember).not.toHaveBeenCalled();
    expect(apiMock.createTeamPlan).not.toHaveBeenCalled();
    expect(apiMock.updateTeamPlan).not.toHaveBeenCalled();
    expect(apiMock.createTeamTask).not.toHaveBeenCalled();
    expect(apiMock.updateTeamTask).not.toHaveBeenCalled();
  });

  it("team_list：没有团队时给可执行的下一步（team_create）", async () => {
    apiMock.fetchWorkspaceTeams.mockResolvedValue({ teams: [] });
    const r = await bridge().run("team_list", {});
    expect(r.ok).toBe(true);
    expect(r.text).toContain("还没有任何团队");
    expect(r.text).toContain("team_create");
  });

  it("team_get：按 team_id 取快照，带目标/方案/任务/成员与 id", async () => {
    const r = await bridge().run("team_get", { team_id: "t1" });
    expect(r.ok).toBe(true);
    expect(apiMock.fetchWorkspaceTeam).toHaveBeenCalledWith("t1");
    expect(r.text).toContain("目标：把周活提升 10%");
    expect(r.text).toContain("plan_id：p1");
    expect(r.text).toContain("task_id：k1");
    expect(r.text).toContain("负责人：林晓（linxiao）");
    expect(r.text).toContain("· 队长");
    expect(r.sources?.[0]).toMatchObject({ id: "t1" });
  });

  it("team_get：可按名字精确匹配；重名时给 team_id 列表", async () => {
    apiMock.fetchWorkspaceTeams.mockResolvedValue({
      teams: [team, { ...team, id: "t9", name: "增长小组" }],
    });
    const r = await bridge().run("team_get", { name: "增长小组" });
    expect(r.ok).toBe(false);
    expect(r.text).toContain("t1");
    expect(r.text).toContain("t9");
    expect(r.text).toContain("请改用 team_id");
  });

  it("team_get：找不到名字/没给参数时指向 team_list", async () => {
    apiMock.fetchWorkspaceTeams.mockResolvedValue({ teams: [team] });
    const miss = await bridge().run("team_get", { name: "不存在" });
    expect(miss.ok).toBe(false);
    expect(miss.text).toContain("没有找到名为「不存在」的团队");
    expect(miss.text).toContain("team_list");

    const empty = await bridge().run("team_get", {});
    expect(empty.ok).toBe(false);
    expect(empty.text).toContain("team_list");
  });

  it("team_get：服务端 404 的中文错误原样透出", async () => {
    apiMock.fetchWorkspaceTeam.mockRejectedValue(new Error("团队不存在或你不在团队里"));
    const r = await bridge().run("team_get", { team_id: "nope" });
    expect(r.ok).toBe(false);
    expect(r.text).toBe("团队工具执行失败：团队不存在或你不在团队里");
  });
});

describe("写工具", () => {
  it("team_create：传 name/goal，返回 team_id 与下一步", async () => {
    const r = await bridge().run("team_create", { name: "增长小组", goal: "把周活提升 10%" });
    expect(r.ok).toBe(true);
    expect(apiMock.createWorkspaceTeam).toHaveBeenCalledWith({
      name: "增长小组",
      goal: "把周活提升 10%",
    });
    expect(r.text).toContain("已创建团队「增长小组」");
    expect(r.text).toContain("team_id：t1");
    expect(r.text).toContain("team_plan_add");
  });

  it("team_create：缺 name 直接拒绝，不发请求", async () => {
    const r = await bridge().run("team_create", { name: "   " });
    expect(r.ok).toBe(false);
    expect(r.text).toContain("name 不能为空");
    expect(apiMock.createWorkspaceTeam).not.toHaveBeenCalled();
  });

  it("team_update：至少一个字段；同时传 name+goal", async () => {
    const r = await bridge().run("team_update", { team_id: "t1", goal: "新目标" });
    expect(r.ok).toBe(true);
    expect(apiMock.updateWorkspaceTeam).toHaveBeenCalledWith("t1", { goal: "新目标" });

    const none = await bridge().run("team_update", { team_id: "t1" });
    expect(none.ok).toBe(false);
    expect(none.text).toContain("没有要修改的字段");
  });

  it("team_member_add：按 username 拉人，回显成员列表", async () => {
    const r = await bridge().run("team_member_add", { team_id: "t1", username: "linxiao" });
    expect(r.ok).toBe(true);
    expect(apiMock.addWorkspaceMember).toHaveBeenCalledWith("t1", "linxiao");
    expect(r.text).toContain("已把 @linxiao 加入团队「增长小组」");
    expect(r.text).toContain("当前成员 2 人");
  });

  it("team_plan_add / team_plan_update：参数映射与状态校验", async () => {
    const add = await bridge().run("team_plan_add", {
      team_id: "t1",
      title: "拉新",
      detail: "先做落地页",
    });
    expect(add.ok).toBe(true);
    expect(apiMock.createTeamPlan).toHaveBeenCalledWith("t1", {
      title: "拉新",
      detail: "先做落地页",
    });
    expect(add.text).toContain("plan_id：p1");

    const up = await bridge().run("team_plan_update", {
      team_id: "t1",
      plan_id: "p1",
      status: "doing",
      orderIndex: 3,
    });
    expect(up.ok).toBe(true);
    expect(apiMock.updateTeamPlan).toHaveBeenCalledWith("t1", "p1", {
      status: "doing",
      orderIndex: 3,
    });

    const bad = await bridge().run("team_plan_update", {
      team_id: "t1",
      plan_id: "p1",
      status: "running",
    });
    expect(bad.ok).toBe(false);
    expect(bad.text).toContain("status 不合法");
    expect(apiMock.updateTeamPlan).toHaveBeenCalledTimes(1);
  });

  it("team_task_add：派任务（标题/方案/负责人/截止），回显负责人名字", async () => {
    const r = await bridge().run("team_task_add", {
      team_id: "t1",
      title: "写落地页",
      planId: "p1",
      assigneeId: "u2",
      dueAt: "2026-11-10T18:00:00.000Z",
    });
    expect(r.ok).toBe(true);
    expect(apiMock.createTeamTask).toHaveBeenCalledWith("t1", {
      title: "写落地页",
      planId: "p1",
      assigneeId: "u2",
      dueAt: "2026-11-10T18:00:00.000Z",
    });
    expect(r.text).toContain("task_id：k1");
    expect(r.text).toContain("负责人：林晓");
  });

  it("team_task_update：状态/负责人/交付物都能改；空串=清空为 null", async () => {
    const r = await bridge().run("team_task_update", {
      team_id: "t1",
      task_id: "k1",
      status: "done",
      assigneeId: "",
      attachmentFileId: "f9",
    });
    expect(r.ok).toBe(true);
    expect(apiMock.updateTeamTask).toHaveBeenCalledWith("t1", "k1", {
      status: "done",
      assigneeId: null,
      attachmentFileId: "f9",
    });
    expect(r.text).toContain("已更新任务「写落地页」");

    const none = await bridge().run("team_task_update", { team_id: "t1", task_id: "k1" });
    expect(none.ok).toBe(false);
    expect(none.text).toContain("没有要修改的字段");
  });

  it("服务端 403 的中文错误原样回给模型（不吞成 http 403）", async () => {
    apiMock.createTeamPlan.mockRejectedValue(new Error("只有团队 owner 可以修改方案"));
    const r = await bridge().run("team_plan_add", { team_id: "t1", title: "拉新" });
    expect(r.ok).toBe(false);
    expect(r.text).toBe("团队操作失败：只有团队 owner 可以修改方案");
  });

  it("中断信号已触发时写操作不执行", async () => {
    const b = buildTeamToolBridge();
    const ac = new AbortController();
    ac.abort();
    const r = await b.execute(
      { name: "team_create", arguments: JSON.stringify({ name: "x" }) },
      { signal: ac.signal },
    );
    expect(r.ok).toBe(false);
    expect(r.text).toContain("已中断");
    expect(apiMock.createWorkspaceTeam).not.toHaveBeenCalled();
  });
});

describe("formatTeamSnapshot", () => {
  it("空团队给可读的空态，不丢 id", () => {
    const text = formatTeamSnapshot({
      team: { ...team, goal: "" },
      members: [],
      plans: [],
      tasks: [],
    });
    expect(text).toContain("目标：（还没写）");
    expect(text).toContain("成员（0）");
    expect(text).toContain("方案（0）");
    expect(text).toContain("任务（0）");
    expect(text).toContain("team_id：t1");
  });
});
