import { describe, it, expect, beforeEach, vi } from "vitest";
import type { TeamTask, TeamWorkspaceSnapshot } from "@heming/shared";

/**
 * 团队工作台工具的接线测试：不碰真实网络。
 *
 * 只 mock `lib/api.js` 里的 11 个网络函数——工具层本身没有网络逻辑，它负责
 * 参数校验（snake_case / camelCase 别名、未知键拒绝）/ 调用哪个 API / 文本怎么给模型 /
 * 错误怎么透出（含中断与超时）。URL 与 method 的正确性由 `lib/api.test.ts` 用 fetch spy 断言。
 */
const apiMock = vi.hoisted(() => ({
  fetchWorkspaceTeams: vi.fn(),
  fetchWorkspaceTeam: vi.fn(),
  createWorkspaceTeam: vi.fn(),
  updateWorkspaceTeam: vi.fn(),
  addWorkspaceMember: vi.fn(),
  removeWorkspaceMember: vi.fn(),
  transferWorkspaceTeamOwner: vi.fn(),
  createTeamPlan: vi.fn(),
  updateTeamPlan: vi.fn(),
  createTeamTask: vi.fn(),
  updateTeamTask: vi.fn(),
  fetchTeamTaskComments: vi.fn(),
  fetchTeamEvents: vi.fn(),
  createTeamTaskComment: vi.fn(),
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
  // 移出成员后只剩 owner；转让队长后 u2 变 owner、u1 变 member。
  apiMock.removeWorkspaceMember.mockResolvedValue({ ...snapshot, members: [members[0]] });
  apiMock.transferWorkspaceTeamOwner.mockResolvedValue({
    ...snapshot,
    team: { ...team, ownerId: "u2" },
    members: [{ ...members[0], role: "member" }, { ...members[1], role: "owner" }],
  });
  apiMock.createTeamPlan.mockResolvedValue(plans[0]);
  apiMock.updateTeamPlan.mockResolvedValue({ ...plans[0], status: "doing" });
  apiMock.createTeamTask.mockResolvedValue(task);
  apiMock.fetchTeamTaskComments.mockResolvedValue({ comments: [] });
  apiMock.fetchTeamEvents.mockResolvedValue({ events: [] });
  apiMock.createTeamTaskComment.mockResolvedValue({
    id: "cm1",
    teamId: "t1",
    taskId: "k1",
    authorId: "u2",
    text: "这个接口按 v2 口径",
    createdAt: T0,
  });
  apiMock.updateTeamTask.mockResolvedValue({ ...task, status: "done" });
});

describe("团队工具清单", () => {
  it("19 个工具：7 读 + 10 写 + 2 danger，名字唯一且都带 team_ 前缀", () => {
    expect(TEAM_TOOLS).toHaveLength(19);
    const reads = TEAM_TOOLS.filter((t) => t.riskHint === "read").map((t) => t.name);
    const writes = TEAM_TOOLS.filter((t) => t.riskHint === "write").map((t) => t.name);
    expect(reads).toEqual([
      "team_list",
      "team_get",
      "team_task_find",
      "team_task_comments",
      "team_events",
      "team_task_history",
      "team_digest",
    ]);
    expect(writes).toEqual([
      "team_create",
      "team_update",
      "team_member_add",
      "team_task_nudge",
      "team_task_review",
      "team_task_comment",
      "team_plan_add",
      "team_plan_update",
      "team_task_add",
      "team_task_update",
    ]);
    const dangers = TEAM_TOOLS.filter((t) => t.riskHint === "danger").map((t) => t.name);
    expect(dangers).toEqual(["team_member_remove", "team_owner_transfer"]);
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
    expect(built!.tools).toHaveLength(19);
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

describe("找活（d.266）", () => {
  it("team_task_find 是只读工具，描述里写明按关键词/负责人/逾期找", () => {
    const spec = TEAM_TOOLS.find((t) => t.name === "team_task_find")!;
    expect(spec.riskHint).toBe("read");
    expect(spec.description).toContain("关键词");
    expect(spec.description).toContain("逾期");
  });

  it("按关键词找活：命中标题/需求里的词，未命中的不出现", async () => {
    apiMock.fetchWorkspaceTeam.mockResolvedValue({
      ...snapshot,
      tasks: [
        { ...task, id: "k-api", title: "接口联调", detail: "按契约把接口接上", status: "todo" },
        { ...task, id: "k-report", title: "写周报", detail: "", status: "todo" },
      ],
    });
    const r = await bridge().run("team_task_find", { team_id: "t1", query: "接口" });
    expect(r.ok).toBe(true);
    expect(r.text).toContain("接口联调");
    expect(r.text).not.toContain("写周报");
    expect(r.text).toContain("关键词「接口」");
    expect(r.sources?.[0]).toMatchObject({ id: "t1" });
  });

  it("负责人写错时直接说清，而不是返回一堆不相关的活", async () => {
    const r = await bridge().run("team_task_find", { team_id: "t1", assignee: "查无此人" });
    expect(r.ok).toBe(false);
    expect(r.text).toContain("团队里没有叫");
    expect(r.text).toContain("林晓");
  });
});

describe("团队复盘（d.267）", () => {
  it("team_digest 是只读工具，描述里写明算完再总结", () => {
    const spec = TEAM_TOOLS.find((t) => t.name === "team_digest")!;
    expect(spec.riskHint).toBe("read");
    expect(spec.description).toContain("复盘");
    expect(spec.description).toContain("不要自己对着任务清单手工统计");
  });

  it("调 team_digest 会带出概况、按人与需要关注，days 越界直接说清", async () => {
    apiMock.fetchWorkspaceTeam.mockResolvedValue({
      ...snapshot,
      tasks: [{ ...task, title: "写落地页", status: "doing" }],
    });
    const r = await bridge().run("team_digest", { team_id: "t1", days: "7" });
    expect(r.ok).toBe(true);
    expect(r.text).toContain("团队「增长小组」");
    expect(r.text).toContain("任务 1 件");
    expect(r.text).toContain("按人看：");
    expect(r.text).toContain("team_task_update");

    const bad = await bridge().run("team_digest", { team_id: "t1", days: "999" });
    expect(bad.ok).toBe(false);
    expect(bad.text).toContain("days");
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
    // d.270：title 与 tasks 二选一，所以 required 只留 team_id（运行时会校验两者必居其一）。
    expect((spec.parameters as { required: string[] }).required).toEqual(["team_id"]);
    expect(props).toHaveProperty("tasks");

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
      result: "改完了，构建通过。",
    });
    expect(r.ok).toBe(true);
    expect(apiMock.updateTeamTask).toHaveBeenCalledWith(
      "t1",
      "k1",
      {
        status: "done",
        assigneeId: null,
        attachmentFileId: "f9",
        result: "改完了，构建通过。",
      },
      expect.objectContaining(REQ),
    );
    // d.261：assigneeId 传空串现在是「退回待认领」，文案单独说，不再笼统写「已更新任务」。
    expect(r.text).toContain("已把「写落地页」退回待认领");

    const none = await bridge().run("team_task_update", { team_id: "t1", task_id: "k1" });
    expect(none.ok).toBe(false);
    expect(none.text).toContain("没有要修改的字段");

    // d.252：标完成必须留一句结论——组长看到的只是状态位，没有结论等于没交待。
    const bare = await bridge().run("team_task_update", {
      team_id: "t1",
      task_id: "k1",
      status: "done",
    });
    expect(bare.ok).toBe(false);
    expect(bare.text).toContain("标完成前请用 result");
    expect(apiMock.updateTeamTask).toHaveBeenLastCalledWith(
      "t1",
      "k1",
      expect.objectContaining({ status: "done" }),
      expect.objectContaining(REQ),
    );
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

describe("成员治理：移出成员与转让队长（d.258）", () => {
  it("team_member_remove：按 username 找人（忽略大小写与 @），回显剩余成员", async () => {
    const r = await bridge().run("team_member_remove", { team_id: "t1", username: "@LinXiao" });
    expect(r.ok).toBe(true);
    expect(apiMock.removeWorkspaceMember).toHaveBeenCalledWith(
      "t1",
      "u2",
      expect.objectContaining(REQ),
    );
    expect(r.text).toContain("已把 林晓（@linxiao）移出团队「增长小组」");
    expect(r.text).toContain("当前成员 1 人");
    expect(r.text).toContain("管理员（@admin）");
  });

  it("team_member_remove：找不到人时不发请求，并把现有成员报出来", async () => {
    const r = await bridge().run("team_member_remove", { team_id: "t1", username: "nobody" });
    expect(r.ok).toBe(false);
    expect(r.text).toContain("团队里没有 @nobody");
    expect(r.text).toContain("管理员（@admin）");
    expect(apiMock.removeWorkspaceMember).not.toHaveBeenCalled();
  });

  it("team_member_remove：不能把队长移出（要先转让或解散）", async () => {
    const r = await bridge().run("team_member_remove", { team_id: "t1", username: "admin" });
    expect(r.ok).toBe(false);
    expect(r.text).toContain("不能把队长移出团队");
    expect(apiMock.removeWorkspaceMember).not.toHaveBeenCalled();
  });

  it("team_owner_transfer：转让后如实说明「你现在是普通成员」", async () => {
    const r = await bridge().run("team_owner_transfer", { team_id: "t1", username: "linxiao" });
    expect(r.ok).toBe(true);
    expect(apiMock.transferWorkspaceTeamOwner).toHaveBeenCalledWith(
      "t1",
      "u2",
      expect.objectContaining(REQ),
    );
    expect(r.text).toContain("队长已转让给 林晓（@linxiao）");
    expect(r.text).toContain("你现在是普通成员");
  });

  it("team_owner_transfer：目标本来就是队长时直接说明，不发请求", async () => {
    const r = await bridge().run("team_owner_transfer", { team_id: "t1", username: "admin" });
    expect(r.ok).toBe(false);
    expect(r.text).toContain("已经是队长了");
    expect(apiMock.transferWorkspaceTeamOwner).not.toHaveBeenCalled();
  });

  it("两条工具的风险都是 danger：影响别人的权限，每次都要人看一眼", () => {
    expect(bridge().meta("team_member_remove")).toEqual({ risk: "danger" });
    expect(bridge().meta("team_owner_transfer")).toEqual({ risk: "danger" });
  });
});

describe("退回任务（d.261）：做不了就退回去，并说清为什么", () => {
  it("assigneeId 传空串 + return_note：退回并带上原因，文案说清组长会看到", async () => {
    apiMock.updateTeamTask.mockResolvedValueOnce({
      id: "k1",
      teamId: "t1",
      title: "写落地页",
      status: "todo",
      assigneeId: null,
    });
    const r = await bridge().run("team_task_update", {
      team_id: "t1",
      task_id: "k1",
      assigneeId: "",
      return_note: "这个仓库没有发布权限，需要管理员来做",
    });
    expect(r.ok).toBe(true);
    expect(apiMock.updateTeamTask).toHaveBeenLastCalledWith(
      "t1",
      "k1",
      { assigneeId: null, returnNote: "这个仓库没有发布权限，需要管理员来做" },
      expect.objectContaining(REQ),
    );
    expect(r.text).toContain("退回待认领");
    expect(r.text).toContain("这个仓库没有发布权限");
  });

  it("退回时没写原因：仍然放行，但提醒下次说明", async () => {
    apiMock.updateTeamTask.mockResolvedValueOnce({
      id: "k1",
      teamId: "t1",
      title: "写落地页",
      status: "todo",
      assigneeId: null,
    });
    const r = await bridge().run("team_task_update", { team_id: "t1", task_id: "k1", assigneeId: "" });
    expect(r.ok).toBe(true);
    expect(r.text).toContain("没写原因");
    expect(apiMock.updateTeamTask).toHaveBeenLastCalledWith(
      "t1",
      "k1",
      { assigneeId: null },
      expect.objectContaining(REQ),
    );
  });

  it("工具描述与参数里讲清「退回」这条路：模型不用猜", () => {
    const spec = TEAM_TOOLS.find((item) => item.name === "team_task_update");
    expect(spec?.description).toContain("做不了就退回");
    const props = (spec?.parameters as { properties?: Record<string, unknown> }).properties ?? {};
    expect(props).toHaveProperty("returnNote");
    expect(bridge().meta("team_task_update")).toEqual({ risk: "write" });
  });
});

describe("任务进展（d.262）：做到一半留一句话", () => {
  it("只传 progress 也算一次更新，payload 里带 progress", async () => {
    apiMock.updateTeamTask.mockResolvedValueOnce({
      id: "k1",
      teamId: "t1",
      title: "写落地页",
      status: "doing",
      assigneeId: "u2",
    });
    const r = await bridge().run("team_task_update", {
      team_id: "t1",
      task_id: "k1",
      progress: "首屏已经搭好，接下来接接口",
    });
    expect(r.ok).toBe(true);
    expect(apiMock.updateTeamTask).toHaveBeenLastCalledWith(
      "t1",
      "k1",
      { progress: "首屏已经搭好，接下来接接口" },
      expect.objectContaining(REQ),
    );
    expect(r.text).toContain("已更新任务「写落地页」");
  });

  it("工具描述与参数里说明「进展」和「结论」是两件事", () => {
    const spec = TEAM_TOOLS.find((item) => item.name === "team_task_update");
    expect(spec?.description).toContain("progress");
    expect(spec?.description).toContain("result（完成时的交付结论）");
    const props = (spec?.parameters as { properties?: Record<string, unknown> }).properties ?? {};
    expect(props).toHaveProperty("progress");
  });
});

describe("派活时看得见对方手上的活（d.264）", () => {
  it("team_get 的成员行带未完成数：谁手上还有活一眼看得出", async () => {
    const r = await bridge().run("team_get", { team_id: "t1" });
    expect(r.ok).not.toBe(false);
    // k1 派给林晓且未完成 → 她手上 1 项；管理员手上没有。
    expect(r.text).toContain("林晓（@linxiao，userId：u2）· 成员 · 手上1 项未完成");
    expect(r.text).toContain("管理员（@admin，userId：u1）· 队长 · 手上没有未完成的任务");
  });

  it("team_task_add 指派给别人后，结果里说明这个人手上还有多少活", async () => {
    apiMock.createTeamTask.mockResolvedValue({ ...task, id: "k2", title: "补文案", status: "todo" });
    const r = await bridge().run("team_task_add", {
      team_id: "t1",
      title: "补文案",
      assignee_id: "u2",
    });
    expect(r.ok).not.toBe(false);
    expect(r.text).toContain("林晓（@linxiao）手上1 项未完成。");
  });

  it("改派给别人时也把新负责人的负载说清", async () => {
    apiMock.updateTeamTask.mockResolvedValue({ ...task, assigneeId: "u2" });
    const r = await bridge().run("team_task_update", {
      team_id: "t1",
      task_id: "k2",
      assignee_id: "u2",
    });
    expect(r.ok).not.toBe(false);
    expect(r.text).toContain("已更新任务「写落地页」");
    expect(r.text).toContain("林晓（@linxiao）手上1 项未完成。");
  });
});

describe("催办：组长让智能体去提醒一下（d.265）", () => {
  it("team_task_nudge 存在且是写操作；执行时只发 { nudge: true }", async () => {
    const spec = TEAM_TOOLS.find((tool) => tool.name === "team_task_nudge");
    expect(spec).toBeDefined();
    expect(spec!.riskHint).toBe("write");
    expect(spec!.description).toContain("不改状态");

    apiMock.updateTeamTask.mockResolvedValue({ ...task, nudgeCount: 1, nudgedAt: new Date().toISOString(), nudgedBy: "u1" });
    const r = await bridge().run("team_task_nudge", { team_id: "t1", task_id: "k1" });
    expect(r.ok).not.toBe(false);
    expect(apiMock.updateTeamTask).toHaveBeenCalledWith("t1", "k1", { nudge: true }, expect.anything());
    expect(r.text).toContain("已催办「写落地页」");
    expect(r.text).toContain("第 1 次");
  });

  it("任务不在这个团队里时直接说清，不发请求", async () => {
    apiMock.updateTeamTask.mockClear();
    const r = await bridge().run("team_task_nudge", { team_id: "t1", task_id: "no-such" });
    expect(r.ok).toBe(false);
    expect(r.text).toContain("没有任务 no-such");
    expect(apiMock.updateTeamTask).not.toHaveBeenCalled();
  });
});

describe("优先级：模型能把轻重缓急说清楚（d.268）", () => {
  it("派活时带 priority=high：透传给 API，回执里写明优先级", async () => {
    apiMock.createTeamTask.mockResolvedValue({ ...task, priority: "high" });
    const r = await bridge().run("team_task_add", {
      team_id: "t1",
      title: "线上故障排查",
      priority: "high",
    });
    expect(r.ok).toBe(true);
    expect(apiMock.createTeamTask).toHaveBeenCalledWith(
      "t1",
      expect.objectContaining({ title: "线上故障排查", priority: "high" }),
      expect.objectContaining(REQ),
    );
    expect(r.text).toContain("优先级：高");
  });

  it("priority 只认三档：写错直接说清，不带着错值发请求", async () => {
    const r = await bridge().run("team_task_add", {
      team_id: "t1",
      title: "临时插队",
      priority: "urgent",
    });
    expect(r.ok).toBe(false);
    expect(r.text).toContain("priority 不合法");
    expect(apiMock.createTeamTask).not.toHaveBeenCalled();
  });

  it("改优先级：team_task_update 只传 priority，不误改别的字段", async () => {
    const r = await bridge().run("team_task_update", {
      team_id: "t1",
      task_id: "k1",
      priority: "low",
    });
    expect(r.ok).toBe(true);
    expect(apiMock.updateTeamTask).toHaveBeenCalledWith(
      "t1",
      "k1",
      { priority: "low" },
      expect.objectContaining(REQ),
    );
  });
});

describe("批量派活（d.270）", () => {
  const mk = (title: string, index: number) => ({
    ...task,
    id: `k-batch-${index}`,
    title,
  });

  beforeEach(() => {
    let call = 0;
    apiMock.createTeamTask.mockImplementation(async (_teamId: string, body: { title: string }) => {
      call += 1;
      return mk(body.title, call);
    });
  });

  it("tasks 一次派三件：逐件调 API，回执一次说清派了什么", async () => {
    const r = await bridge().run("team_task_add", {
      team_id: "t1",
      tasks: [{ title: "改接口" }, { title: "补测试" }, { title: "更新文档" }],
    });
    expect(r.ok).toBe(true);
    expect(apiMock.createTeamTask).toHaveBeenCalledTimes(3);
    expect(r.text).toContain("已派 3 件任务");
    expect(r.text).toContain("改接口");
    expect(r.text).toContain("补测试");
    expect(r.text).toContain("更新文档");
  });

  it("中途一件缺 title：前面照建，失败的那件点名，不装作全成", async () => {
    const r = await bridge().run("team_task_add", {
      team_id: "t1",
      tasks: [{ title: "改接口" }, { title: "   " }, { title: "更新文档" }],
    });
    expect(r.ok).toBe(true);
    expect(apiMock.createTeamTask).toHaveBeenCalledTimes(2);
    expect(r.text).toContain("派了 2 件，另有 1 件没成");
    expect(r.text).toContain("第 2 件：没有 title");
  });

  it("超过 8 件直接拒：不偷偷只建前 8 件", async () => {
    const r = await bridge().run("team_task_add", {
      team_id: "t1",
      tasks: Array.from({ length: 9 }, (_, i) => ({ title: `任务 ${i + 1}` })),
    });
    expect(r.ok).toBe(false);
    expect(r.text).toContain("一次最多派 8 件");
    expect(r.text).toContain("9 件");
    expect(apiMock.createTeamTask).not.toHaveBeenCalled();
  });

  it("title 与 tasks 同时给：说清二选一，不发请求", async () => {
    const r = await bridge().run("team_task_add", {
      team_id: "t1",
      title: "改接口",
      tasks: [{ title: "补测试" }],
    });
    expect(r.ok).toBe(false);
    expect(r.text).toContain("只能二选一");
    expect(apiMock.createTeamTask).not.toHaveBeenCalled();
  });

  it("单件模式不变：仍然只建一件并带上负责人负载", async () => {
    const r = await bridge().run("team_task_add", {
      team_id: "t1",
      title: "写落地页",
      assigneeId: "u2",
    });
    expect(r.ok).toBe(true);
    expect(apiMock.createTeamTask).toHaveBeenCalledTimes(1);
    expect(r.text).toContain("写落地页");
  });
});
describe("任务讨论（d.271）", () => {
  const comments = [
    {
      id: "cm1",
      teamId: "t1",
      taskId: "k1",
      authorId: "u2",
      text: "这个接口按 v2 口径做吗？",
      createdAt: "2026-11-18T00:32:00.000Z",
    },
    {
      id: "cm2",
      teamId: "t1",
      taskId: "k1",
      authorId: "u1",
      text: "按 v2，旧字段留兼容。",
      createdAt: "2026-11-18T00:40:00.000Z",
    },
  ];

  it("读讨论：按时间升序、带作者与时间；没有留言就说没有", async () => {
    apiMock.fetchTeamTaskComments.mockResolvedValue({ comments });
    const out = await bridge().run("team_task_comments", { team_id: "t1", task_id: "k1" });
    const text = out.text ?? "";
    expect(text).toContain("「写落地页」的讨论（共 2 条）");
    expect(text.indexOf("这个接口按 v2 口径做吗？")).toBeLessThan(text.indexOf("按 v2，旧字段留兼容。"));
    expect(text).toContain("林晓");
    expect(text).toContain("管理员");
    expect(apiMock.fetchTeamTaskComments).toHaveBeenCalledWith("t1", "k1", REQ);

    apiMock.fetchTeamTaskComments.mockResolvedValue({ comments: [] });
    const empty = await bridge().run("team_task_comments", { team_id: "t1", task_id: "k1" });
    expect(empty.text ?? "").toContain("还没有留言");
  });

  it("写讨论：留言进任务时间线，回执说明谁也不能改别人写的", async () => {
    apiMock.fetchTeamTaskComments.mockResolvedValue({ comments: [{ ...comments[0], text: "这个接口按 v2 口径" }] });
    const out = await bridge().run("team_task_comment", {
      team_id: "t1",
      task_id: "k1",
      text: "这个接口按 v2 口径",
    });
    const text = out.text ?? "";
    expect(apiMock.createTeamTaskComment).toHaveBeenCalledWith("t1", "k1", "这个接口按 v2 口径", REQ);
    expect(text).toContain("已在任务下留言");
    expect(text).toContain("谁也不能改别人写的话");
  });

  it("写讨论：空留言不落库、直接说清要写什么", async () => {
    const out = await bridge().run("team_task_comment", { team_id: "t1", task_id: "k1", text: "   " });
    expect(out.text ?? "").toContain("要留的话不能为空");
    expect(apiMock.createTeamTaskComment).not.toHaveBeenCalled();
  });
});

describe("验收（d.272）：只有组长能验收，打回必须写原因", () => {
  it("打回时不写原因直接拒：不发请求，并说清为什么", async () => {
    const r = await bridge().run("team_task_review", {
      team_id: "t1",
      task_id: "k1",
      verdict: "changes",
    });
    expect(r.ok).toBe(false);
    expect(r.text).toContain("打回重做要写一句原因");
    expect(apiMock.updateTeamTask).not.toHaveBeenCalled();
  });

  it("打回带原因：把 review=changes 与 reviewNote 一起发给服务端，文案说清状态回了进行中", async () => {
    apiMock.updateTeamTask.mockResolvedValueOnce({
      id: "k1",
      teamId: "t1",
      title: "写部署脚本",
      status: "doing",
      assigneeId: "u2",
      reviewState: "changes",
      reviewNote: "少了回滚步骤，补上再交。",
    });
    const r = await bridge().run("team_task_review", {
      team_id: "t1",
      task_id: "k1",
      verdict: "changes",
      note: "少了回滚步骤，补上再交。",
    });
    expect(r.ok).toBe(true);
    expect(apiMock.updateTeamTask).toHaveBeenLastCalledWith(
      "t1",
      "k1",
      { review: "changes", reviewNote: "少了回滚步骤，补上再交。" },
      expect.objectContaining(REQ),
    );
    expect(r.text).toContain("打回重做");
    expect(r.text).toContain("少了回滚步骤");
  });

  it("验收通过：只发 review=approve，不硬塞空意见", async () => {
    apiMock.updateTeamTask.mockResolvedValueOnce({
      id: "k1",
      teamId: "t1",
      title: "写部署脚本",
      status: "done",
      assigneeId: "u2",
      reviewState: "approved",
    });
    const r = await bridge().run("team_task_review", {
      team_id: "t1",
      task_id: "k1",
      verdict: "approve",
    });
    expect(r.ok).toBe(true);
    expect(apiMock.updateTeamTask).toHaveBeenLastCalledWith(
      "t1",
      "k1",
      { review: "approve" },
      expect.objectContaining(REQ),
    );
    expect(r.text).toContain("已验收通过");
  });

  it("verdict 只认两个值：模型自己编别名要直接拒，别误发请求", async () => {
    const r = await bridge().run("team_task_review", {
      team_id: "t1",
      task_id: "k1",
      verdict: "pass",
    });
    expect(r.ok).toBe(false);
    expect(apiMock.updateTeamTask).not.toHaveBeenCalled();
  });
});

describe("团队动态（d.273）", () => {

  it("team_events 列出最近动态：新的在前、动作者与类型读得懂", async () => {
    apiMock.fetchWorkspaceTeam.mockResolvedValue(snapshot);
    apiMock.fetchTeamEvents.mockResolvedValue({
      events: [
        {
          id: "e2",
          teamId: "t1",
          taskId: "k1",
          taskTitle: "改落地页",
          actorId: "u2",
          kind: "task_updated",
          summary: "把「改落地页」从进行中改成已完成",
          createdAt: "2026-11-18T02:00:00.000Z",
        },
        {
          id: "e1",
          teamId: "t1",
          taskId: null,
          taskTitle: "",
          actorId: "u1",
          kind: "plan_added",
          summary: "新增方案「拉新」",
          createdAt: "2026-11-18T01:00:00.000Z",
        },
      ],
    });

    const out = await bridge().run("team_events", { team_id: "t1" });
    expect(out.ok).toBe(true);
    expect(apiMock.fetchTeamEvents).toHaveBeenCalledWith("t1", REQ, 20);
    expect(out.text).toContain("团队动态（最近 2 条，新的在前）");
    expect(out.text).toContain("林晓【改动】");
    expect(out.text).toContain("管理员【新方案】");
    // 新的在前：改动那条出现在新方案之前。
    expect(out.text.indexOf("改动")).toBeLessThan(out.text.indexOf("新方案"));
  });

  it("没有动态时说清「还没有记录」，limit 越界直接拒", async () => {
    apiMock.fetchWorkspaceTeam.mockResolvedValue(snapshot);
    apiMock.fetchTeamEvents.mockResolvedValue({ events: [] });

    const empty = await bridge().run("team_events", { team_id: "t1" });
    expect(empty.ok).toBe(true);
    expect(empty.text).toContain("还没有记录");

    const tooMany = await bridge().run("team_events", { team_id: "t1", limit: "80" });
    expect(tooMany.ok).toBe(false);
    expect(tooMany.text).toContain("limit 要给 1–50");
    expect(apiMock.fetchTeamEvents).toHaveBeenCalledTimes(1);
  });
});

describe("单件任务的历史（d.276）", () => {
  it("team_task_history 只拉这一条活的流水，任务不存在时说清", async () => {
    apiMock.fetchWorkspaceTeam.mockResolvedValue(snapshot);
    apiMock.fetchTeamEvents.mockResolvedValue({
      events: [
        {
          id: "e1",
          teamId: "t1",
          taskId: "k1",
          taskTitle: "改落地页",
          actorId: "u1",
          kind: "task_added",
          summary: "新建任务「改落地页」，派给 林晓",
          createdAt: "2026-11-18T01:00:00.000Z",
        },
        {
          id: "e2",
          teamId: "t1",
          taskId: "k1",
          taskTitle: "改落地页",
          actorId: "u2",
          kind: "task_updated",
          summary: "把「改落地页」从进行中改成已完成",
          createdAt: "2026-11-18T02:00:00.000Z",
        },
      ],
    });

    const out = await bridge().run("team_task_history", { team_id: "t1", task_id: "k1" });
    expect(out.ok).toBe(true);
    expect(apiMock.fetchTeamEvents).toHaveBeenCalledWith("t1", REQ, 20, "k1");
    expect(out.text).toContain("「写落地页」的历史（最近 2 条，新的在前）");
    expect(out.text).toContain("管理员【派活】");
    expect(out.text).toContain("林晓【改动】");

    const missing = await bridge().run("team_task_history", { team_id: "t1", task_id: "nope" });
    expect(missing.ok).toBe(false);
    expect(missing.text).toContain("这个团队里没有任务 nope");

    const noId = await bridge().run("team_task_history", { team_id: "t1" });
    expect(noId.ok).toBe(false);
    expect(noId.text).toContain("要给 task_id");
  });

  it("没有历史时说清「还没有历史」，limit 越界直接拒", async () => {
    apiMock.fetchWorkspaceTeam.mockResolvedValue(snapshot);
    apiMock.fetchTeamEvents.mockResolvedValue({ events: [] });

    const empty = await bridge().run("team_task_history", { team_id: "t1", task_id: "k1" });
    expect(empty.ok).toBe(true);
    expect(empty.text).toContain("还没有历史");

    const bad = await bridge().run("team_task_history", { team_id: "t1", task_id: "k1", limit: "99" });
    expect(bad.ok).toBe(false);
    expect(bad.text).toContain("1–50");
  });
});
