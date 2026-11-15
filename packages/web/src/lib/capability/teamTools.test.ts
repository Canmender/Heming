import { describe, it, expect, beforeEach, vi } from "vitest";
import type { TeamTask, TeamWorkspaceSnapshot } from "@heming/shared";

/**
 * 团队工作台工具的接线测试：不碰真实网络。
 *
 * 只 mock `lib/api.js` 里的 9 个网络函数——工具层本身没有网络逻辑，它负责
 * 参数校验（snake_case / camelCase 别名、未知键拒绝）/ 调用哪个 API / 文本怎么给模型 /
 * 错误怎么透出（含中断与超时）。URL 与 method 的正确性由 `lib/api.test.ts` 用 fetch spy 断言。
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
// 只替换网络函数：ApiError / isApiAbort / isApiTimeout 必须是真实实现，
// 否则「超时/中断」分支会测到假货（真实实现里取消是 status=0 的 ApiError）。
vi.mock("../api.js", async (importOriginal) => {
  const actual = await importOriginal<typeof import("../api.js")>();
  return { ...actual, ...apiMock };
});

import { API_CANCELLED_STATUS, API_TIMEOUT_STATUS, ApiError } from "../api.js";
import { fmtLocalDateTime } from "../format/datetime.js";
import {
  TEAM_TOOLS,
  buildTeamToolBridge,
  formatTeamSnapshot,
  normalizeTeamArgs,
  teamProvider,
} from "./teamTools.js";

const CTX = { agentId: "a1", conversationId: "c1" };

/** 团队工具每次请求都带 15s 超时（B4）；断言只看这个字段，别把实现细节写死。 */
const REQ = { timeoutMs: 15_000 };

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
    run: (
      name: string,
      args: Record<string, unknown>,
      opts?: { signal?: AbortSignal },
    ) => b.execute({ name, arguments: JSON.stringify(args) }, opts),
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
    // 工具总数 >20 时 team_* 可能被 tool_search 隐藏，描述里必须给出可发现性提示
    for (const spec of TEAM_TOOLS) {
      expect(spec.description).toContain("tool_search");
      expect(spec.description).toContain("团队");
    }
    for (const spec of TEAM_TOOLS.filter((t) => t.riskHint === "write")) {
      expect(spec.description).toContain("请用户确认");
    }
  });

  it("参数描述写清 snake_case / camelCase 两种写法都接受（B3）", () => {
    const add = TEAM_TOOLS.find((t) => t.name === "team_task_add")!;
    const addProps = (add.parameters as { properties: Record<string, { description: string }> })
      .properties;
    expect(addProps.assigneeId.description).toContain("assignee_id");
    expect(addProps.planId.description).toContain("plan_id");
    expect(addProps.dueAt.description).toContain("due_at");
    expect(addProps.attachmentFileId.description).toContain("attachment_file_id");
    // 描述里明确「未知参数会报错」，避免模型以为会被静默忽略
    expect(add.description).toContain("不会静默忽略");
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

describe("参数归一化（B3）", () => {
  const spec = (name: string) => TEAM_TOOLS.find((t) => t.name === name)!;

  it("snake_case 别名归一化成内部 camelCase 规范键", () => {
    const r = normalizeTeamArgs(spec("team_task_add"), {
      team_id: "t1",
      title: "写落地页",
      plan_id: "p1",
      assignee_id: "u2",
      due_at: "2026-11-10T18:00:00.000Z",
      attachment_file_id: "f9",
    });
    expect(r).toEqual({
      args: {
        teamId: "t1",
        title: "写落地页",
        planId: "p1",
        assigneeId: "u2",
        dueAt: "2026-11-10T18:00:00.000Z",
        attachmentFileId: "f9",
      },
    });
  });

  it("camelCase 写法同样可用（teamId / planId / taskId）", () => {
    expect(normalizeTeamArgs(spec("team_get"), { teamId: "t1" })).toEqual({
      args: { teamId: "t1" },
    });
    expect(
      normalizeTeamArgs(spec("team_plan_update"), { teamId: "t1", planId: "p1", order_index: 2 }),
    ).toEqual({ args: { teamId: "t1", planId: "p1", orderIndex: 2 } });
    expect(
      normalizeTeamArgs(spec("team_task_update"), { team_id: "t1", task_id: "k1", status: "done" }),
    ).toEqual({ args: { teamId: "t1", taskId: "k1", status: "done" } });
  });

  it("不认识的参数显式报错，并列出可用参数（不再静默丢弃）", () => {
    const r = normalizeTeamArgs(spec("team_task_add"), {
      team_id: "t1",
      title: "写落地页",
      plan: "p1",
    });
    expect("error" in r).toBe(true);
    const msg = (r as { error: string }).error;
    expect(msg).toContain("不认识的参数");
    expect(msg).toContain("plan");
    expect(msg).toContain("planId");
    expect(msg).toContain("team_task_add");
  });

  it("同一个参数给了两种写法 → 报冲突，不猜哪个为准", () => {
    const r = normalizeTeamArgs(spec("team_get"), { team_id: "t1", teamId: "t1" });
    expect("error" in r).toBe(true);
    expect((r as { error: string }).error).toContain("参数重复");
  });

  it("team_list 不接受任何参数", () => {
    expect(normalizeTeamArgs(spec("team_list"), {})).toEqual({ args: {} });
    const r = normalizeTeamArgs(spec("team_list"), { whatever: 1 });
    expect("error" in r).toBe(true);
    expect((r as { error: string }).error).toContain("不接受任何参数");
  });

  it("snake_case 参数真的传到 api 层（不是只在工具内部自洽）", async () => {
    const r = await bridge().run("team_task_add", {
      team_id: "t1",
      title: "写落地页",
      plan_id: "p1",
      assignee_id: "u2",
      due_at: "2026-11-10T18:00:00.000Z",
      attachment_file_id: "f9",
    });
    expect(r.ok).toBe(true);
    // 关键断言：api 收到的是 camelCase body，字段一个不少（以前 plan_id 会被静默丢掉）
    expect(apiMock.createTeamTask).toHaveBeenCalledWith(
      "t1",
      {
        title: "写落地页",
        planId: "p1",
        assigneeId: "u2",
        dueAt: "2026-11-10T18:00:00.000Z",
        attachmentFileId: "f9",
      },
      expect.objectContaining(REQ),
    );

    const up = await bridge().run("team_plan_update", {
      team_id: "t1",
      planId: "p1",
      status: "doing",
    });
    expect(up.ok).toBe(true);
    expect(apiMock.updateTeamPlan).toHaveBeenCalledWith(
      "t1",
      "p1",
      { status: "doing" },
      expect.objectContaining(REQ),
    );
  });

  it("拼错的参数直接拒绝，不发请求（旧行为是照建任务还回「已创建」）", async () => {
    const r = await bridge().run("team_task_add", { team_id: "t1", title: "写落地页", plan: "p1" });
    expect(r.ok).toBe(false);
    expect(r.text).toContain("不认识的参数");
    expect(apiMock.createTeamTask).not.toHaveBeenCalled();
  });

  it("参数不是合法 JSON 时明确报错，不当成空对象执行", async () => {
    const b = buildTeamToolBridge();
    const r = await b.execute({ name: "team_create", arguments: "{name: 增长小组" });
    expect(r.ok).toBe(false);
    expect(r.text).toContain("不是合法 JSON");
    expect(apiMock.createWorkspaceTeam).not.toHaveBeenCalled();
  });
});

describe("读工具", () => {
  it("team_list：列团队 + 成员/任务数，不发任何写请求", async () => {
    const b = bridge();
    const r = await b.run("team_list", {});
    expect(r.ok).toBe(true);
    expect(r.text).toContain("增长小组");
    expect(r.text).toContain("teamId：t1");
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
    expect(apiMock.fetchWorkspaceTeam).toHaveBeenCalledWith("t1", expect.objectContaining(REQ));
    expect(r.text).toContain("目标：把周活提升 10%");
    expect(r.text).toContain("planId：p1");
    expect(r.text).toContain("taskId：k1");
    expect(r.text).toContain("负责人：林晓（linxiao）");
    expect(r.text).toContain("· 队长");
    expect(r.sources?.[0]).toMatchObject({ id: "t1" });
  });

  it("team_get：截图里的 id 是可回传的 camelCase（B3 ③）", async () => {
    const r = await bridge().run("team_get", { teamId: "t1" });
    expect(r.ok).toBe(true);
    expect(r.text).toContain("teamId：t1");
    expect(r.text).toContain("planId：p1");
    expect(r.text).toContain("taskId：k1");
    expect(r.text).toContain("team_id");
  });

  it("team_get：可按名字精确匹配；重名时给 teamId 列表", async () => {
    apiMock.fetchWorkspaceTeams.mockResolvedValue({
      teams: [team, { ...team, id: "t9", name: "增长小组" }],
    });
    const r = await bridge().run("team_get", { name: "增长小组" });
    expect(r.ok).toBe(false);
    expect(r.text).toContain("t1");
    expect(r.text).toContain("t9");
    expect(r.text).toContain("请改用 teamId");
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
    // 真实服务端文案是「团队不存在」（app.ts:538），不是「…或你不在团队里」。
    apiMock.fetchWorkspaceTeam.mockRejectedValue(new ApiError(404, "团队不存在"));
    const r = await bridge().run("team_get", { team_id: "nope" });
    expect(r.ok).toBe(false);
    expect(r.text).toBe("团队工具执行失败：团队不存在");
  });
});

describe("写工具", () => {
  it("team_create：传 name/goal，返回 teamId 与下一步", async () => {
    const r = await bridge().run("team_create", { name: "增长小组", goal: "把周活提升 10%" });
    expect(r.ok).toBe(true);
    expect(apiMock.createWorkspaceTeam).toHaveBeenCalledWith(
      {
        name: "增长小组",
        goal: "把周活提升 10%",
      },
      expect.objectContaining(REQ),
    );
    expect(r.text).toContain("已创建团队「增长小组」");
    expect(r.text).toContain("teamId：t1");
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
    expect(apiMock.updateWorkspaceTeam).toHaveBeenCalledWith(
      "t1",
      { goal: "新目标" },
      expect.objectContaining(REQ),
    );

    const none = await bridge().run("team_update", { team_id: "t1" });
    expect(none.ok).toBe(false);
    expect(none.text).toContain("没有要修改的字段");
  });

  it("team_member_add：按 username 拉人，回显成员列表", async () => {
    const r = await bridge().run("team_member_add", { team_id: "t1", username: "linxiao" });
    expect(r.ok).toBe(true);
    expect(apiMock.addWorkspaceMember).toHaveBeenCalledWith(
      "t1",
      "linxiao",
      expect.objectContaining(REQ),
    );
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
    expect(apiMock.createTeamPlan).toHaveBeenCalledWith(
      "t1",
      {
        title: "拉新",
        detail: "先做落地页",
      },
      expect.objectContaining(REQ),
    );
    expect(add.text).toContain("planId：p1");

    const up = await bridge().run("team_plan_update", {
      team_id: "t1",
      plan_id: "p1",
      status: "doing",
      orderIndex: 3,
    });
    expect(up.ok).toBe(true);
    expect(apiMock.updateTeamPlan).toHaveBeenCalledWith(
      "t1",
      "p1",
      {
        status: "doing",
        orderIndex: 3,
      },
      expect.objectContaining(REQ),
    );

    const bad = await bridge().run("team_plan_update", {
      team_id: "t1",
      plan_id: "p1",
      status: "running",
    });
    expect(bad.ok).toBe(false);
    expect(bad.text).toContain("status 不合法");
    expect(apiMock.updateTeamPlan).toHaveBeenCalledTimes(1);
  });

  it("team_task_add：派任务（标题/方案/负责人/截止/交付物），回显负责人名字", async () => {
    // 参数契约：交付物是可选参数 attachmentFileId（d.109 D2，与 team_task_update 同名）
    const spec = TEAM_TOOLS.find((t) => t.name === "team_task_add")!;
    const props = (spec.parameters as { properties: Record<string, unknown> }).properties;
    expect(props).toHaveProperty("attachmentFileId");
    expect(props.attachmentFileId).toMatchObject({ type: "string" });
    expect((spec.parameters as { required: string[] }).required).toEqual(["team_id", "title"]);

    const r = await bridge().run("team_task_add", {
      team_id: "t1",
      title: "写落地页",
      planId: "p1",
      assigneeId: "u2",
      dueAt: "2026-11-10T18:00:00.000Z",
      attachmentFileId: "f9",
    });
    expect(r.ok).toBe(true);
    expect(apiMock.createTeamTask).toHaveBeenCalledWith(
      "t1",
      {
        title: "写落地页",
        planId: "p1",
        assigneeId: "u2",
        dueAt: "2026-11-10T18:00:00.000Z",
        attachmentFileId: "f9",
      },
      expect.objectContaining(REQ),
    );
    expect(r.text).toContain("taskId：k1");
    expect(r.text).toContain("负责人：林晓");

    // 不传交付物时字段不出现（不把 undefined 传给 API）
    await bridge().run("team_task_add", { team_id: "t1", title: "无交付物" });
    expect(apiMock.createTeamTask).toHaveBeenLastCalledWith(
      "t1",
      { title: "无交付物" },
      expect.objectContaining(REQ),
    );
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
    expect(apiMock.updateTeamTask).toHaveBeenCalledWith(
      "t1",
      "k1",
      {
        status: "done",
        assigneeId: null,
        attachmentFileId: "f9",
      },
      expect.objectContaining(REQ),
    );
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

describe("中断与超时（B4）", () => {
  it("每次请求都带中断信号与 15s 超时（信号真的传到 api 层）", async () => {
    const ac = new AbortController();
    const r = await bridge().run("team_plan_add", { team_id: "t1", title: "拉新" }, { signal: ac.signal });
    expect(r.ok).toBe(true);
    expect(apiMock.createTeamPlan).toHaveBeenCalledWith(
      "t1",
      { title: "拉新" },
      { signal: ac.signal, timeoutMs: 15_000 },
    );
  });

  it("在途请求被中断：回「用户已中断」，不说成「团队操作失败」", async () => {
    apiMock.createTeamPlan.mockRejectedValue(new ApiError(API_CANCELLED_STATUS, "操作已取消"));
    const r = await bridge().run("team_plan_add", { team_id: "t1", title: "拉新" });
    expect(r.ok).toBe(false);
    expect(r.text).toContain("用户已中断");
    expect(r.text).not.toContain("团队操作失败");
  });

  it("超时：回「团队操作超时」并带上可重试的说明", async () => {
    apiMock.createTeamPlan.mockRejectedValue(
      new ApiError(API_TIMEOUT_STATUS, "请求超时（15 秒），请稍后重试"),
    );
    const r = await bridge().run("team_plan_add", { team_id: "t1", title: "拉新" });
    expect(r.ok).toBe(false);
    expect(r.text).toContain("团队操作超时");
    expect(r.text).toContain("请求超时");
  });

  it("读工具在途被中断也回可读文案（不是 http 0）", async () => {
    apiMock.fetchWorkspaceTeam.mockRejectedValue(new ApiError(API_CANCELLED_STATUS, "操作已取消"));
    const r = await bridge().run("team_get", { team_id: "t1" });
    expect(r.ok).toBe(false);
    expect(r.text).toContain("用户已中断");
    expect(r.text).not.toContain("http 0");
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
    expect(text).toContain("teamId：t1");
  });

  it("截止时间按本地可读格式打印，不再原样吐 UTC ISO（B3 ③）", () => {
    const iso = "2026-11-10T18:00:00.000Z";
    const text = formatTeamSnapshot({
      team,
      members,
      plans,
      tasks: [{ ...task, dueAt: iso }],
    });
    expect(text).not.toContain(iso);
    expect(text).toContain(fmtLocalDateTime(iso));
  });
});

describe("参数类型校验与宽转（T2-04）", () => {
  it("dueAt 接受毫秒/秒级 epoch 数字，规范成 ISO 后真的传给 createTeamTask", async () => {
    const ms = 1_762_776_000_000;
    const r = await bridge().run("team_task_add", {
      team_id: "t1",
      title: "带截止",
      dueAt: ms,
    });
    expect(r.ok).toBe(true);
    expect(apiMock.createTeamTask).toHaveBeenCalledWith(
      "t1",
      expect.objectContaining({ dueAt: new Date(ms).toISOString() }),
      expect.objectContaining(REQ),
    );

    // 10 位秒级时间戳按秒解释（不乘两次 1000）
    const sec = 1_762_776_000;
    await bridge().run("team_task_add", { team_id: "t1", title: "秒级", dueAt: sec });
    expect(apiMock.createTeamTask).toHaveBeenLastCalledWith(
      "t1",
      expect.objectContaining({ dueAt: new Date(sec * 1000).toISOString() }),
      expect.objectContaining(REQ),
    );
  });

  it("number 字段收到纯数字串 → 转成数字（orderIndex: \"3\"）", async () => {
    const r = await bridge().run("team_plan_add", {
      team_id: "t1",
      title: "拉新",
      orderIndex: "3",
    });
    expect(r.ok).toBe(true);
    expect(apiMock.createTeamPlan).toHaveBeenCalledWith(
      "t1",
      expect.objectContaining({ orderIndex: 3 }),
      expect.objectContaining(REQ),
    );
  });

  it("string 字段收到数字 → 明确报错且**不发任何请求**（旧行为是静默丢字段）", async () => {
    const r = await bridge().run("team_get", { team_id: 1 });
    expect(r.ok).toBe(false);
    expect(r.text).toContain("参数类型不对");
    expect(r.text).toContain("teamId 需要字符串");
    expect(r.text).toContain("收到 number");
    expect(apiMock.fetchWorkspaceTeams).not.toHaveBeenCalled();
    expect(apiMock.fetchWorkspaceTeam).not.toHaveBeenCalled();
  });

  it("坏 dueAt / 非数字 orderIndex → 报错且零请求", async () => {
    const badDue = await bridge().run("team_task_add", {
      team_id: "t1",
      title: "坏时间",
      dueAt: "下周三",
    });
    expect(badDue.ok).toBe(false);
    expect(badDue.text).toContain("截止时间格式不对");
    expect(apiMock.createTeamTask).not.toHaveBeenCalled();

    const badOrder = await bridge().run("team_plan_add", {
      team_id: "t1",
      title: "拉新",
      orderIndex: "三",
    });
    expect(badOrder.ok).toBe(false);
    expect(badOrder.text).toContain("orderIndex 需要数字");
    expect(apiMock.createTeamPlan).not.toHaveBeenCalled();
  });

  it("空串 dueAt 仍是「清空」语义（不被当成非法时间）", async () => {
    const r = await bridge().run("team_task_update", {
      team_id: "t1",
      task_id: "k1",
      dueAt: "",
    });
    expect(r.ok).toBe(true);
    expect(apiMock.updateTeamTask).toHaveBeenCalledWith(
      "t1",
      "k1",
      expect.objectContaining({ dueAt: null }),
      expect.objectContaining(REQ),
    );
  });
});

describe("快照限长（T2-05：不让 8000 字符截断吃掉中间任务）", () => {
  it("30 条任务只列前 20 条 + 明确提示「另有 10 条任务未显示」，且总长 < 8000", () => {
    const longDetail = "细节".repeat(900); // 1800 字（schema 允许 2000）
    const many: TeamTask[] = Array.from({ length: 30 }, (_, i) => ({
      ...task,
      id: `k${i + 1}`,
      title: `任务${i + 1}`,
      detail: longDetail,
    }));
    const text = formatTeamSnapshot({ team, members, plans, tasks: many });
    expect(text.length).toBeLessThan(8000);
    expect(text).toContain("另有 10 条任务未显示");
    expect(text).toContain("[taskId：k1]");
    expect(text).not.toContain("[taskId：k21]");
    expect(text).not.toContain("[taskId：k30]");
  });

  it("单条说明截到 200 字并加省略号（一条说明不再吃掉整个快照）", () => {
    const text = formatTeamSnapshot({
      team,
      members,
      plans: [{ ...plans[0], detail: "长".repeat(2000) }],
      tasks: [{ ...task, detail: "长".repeat(2000) }],
    });
    const detailLines = text.split("\n").filter((line) => line.startsWith("  说明："));
    expect(detailLines).toHaveLength(2);
    for (const line of detailLines) {
      expect(line.length).toBeLessThanOrEqual("  说明：".length + 201);
      expect(line.endsWith("…")).toBe(true);
    }
  });
});
