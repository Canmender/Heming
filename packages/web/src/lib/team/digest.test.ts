import { describe, expect, it } from "vitest";
import type { TeamTask, TeamWorkspaceSnapshot } from "@heming/shared";
import {
  DIGEST_DEFAULT_DAYS,
  DIGEST_LIST_MAX,
  DIGEST_MAX_DAYS,
  blockingTask,
  buildTeamDigest,
  completedInWindow,
  createdInWindow,
} from "./digest.js";

const NOW = Date.parse("2026-11-17T12:00:00.000Z");
const DAY = 86_400_000;

function task(overrides: Partial<TeamTask> = {}): TeamTask {
  return {
    id: "k1",
    teamId: "t1",
    planId: null,
    title: "写落地页",
    detail: "",
    assigneeId: "u2",
    status: "todo",
    createdBy: "u1",
    createdAt: new Date(NOW - 10 * DAY).toISOString(),
    updatedAt: new Date(NOW - 10 * DAY).toISOString(),
    dueAt: null,
    attachmentFileId: null,
    ...overrides,
  } as TeamTask;
}

function snap(tasks: TeamTask[]): TeamWorkspaceSnapshot {
  return {
    team: {
      id: "t1",
      name: "增长小组",
      goal: "把周活提升 10%",
      ownerId: "u1",
      createdAt: new Date(NOW - 30 * DAY).toISOString(),
      updatedAt: new Date(NOW - DAY).toISOString(),
    },
    members: [
      {
        user: { id: "u1", username: "admin", displayName: "管理员" },
        role: "owner" as const,
        joinedAt: new Date(NOW - 30 * DAY).toISOString(),
      },
      {
        user: { id: "u2", username: "linxiao", displayName: "林晓" },
        role: "member" as const,
        joinedAt: new Date(NOW - 20 * DAY).toISOString(),
      },
    ],
    plans: [],
    tasks,
  } as TeamWorkspaceSnapshot;
}

const name = (id: string) => (id === "u2" ? "林晓（@linxiao）" : id === "u1" ? "管理员（@admin）" : id);

describe("窗口统计（d.267）", () => {
  it("只数窗口内完成的任务，坏的完成时间不算", () => {
    const tasks = [
      task({ id: "k1", status: "done", completedAt: new Date(NOW - 2 * DAY).toISOString() }),
      task({ id: "k2", status: "done", completedAt: new Date(NOW - 20 * DAY).toISOString() }),
      task({ id: "k3", status: "done", completedAt: "不是时间" }),
      task({ id: "k4", status: "doing" }),
    ];
    expect(completedInWindow(tasks, { now: NOW }).map((t) => t.id)).toEqual(["k1"]);
  });

  it("刚落完成的任务排前面；新建数按 createdAt 落在窗口内算", () => {
    const tasks = [
      task({ id: "old", status: "done", completedAt: new Date(NOW - 6 * DAY).toISOString() }),
      task({ id: "new", status: "done", completedAt: new Date(NOW - DAY).toISOString() }),
      task({ id: "made", createdAt: new Date(NOW - 3 * DAY).toISOString() }),
      task({ id: "ancient", createdAt: new Date(NOW - 60 * DAY).toISOString() }),
    ];
    expect(completedInWindow(tasks, { now: NOW }).map((t) => t.id)).toEqual(["new", "old"]);
    expect(createdInWindow(tasks, { now: NOW })).toBe(1);
  });
});

describe("前置任务（d.267）", () => {
  it("只数未完成的前置；前置完成了就不算挡", () => {
    const blocker = task({ id: "k0", title: "先定接口", status: "todo" });
    const doneBlocker = task({ id: "k9", title: "已经做完的", status: "done" });
    const byId = new Map([
      [blocker.id, blocker],
      [doneBlocker.id, doneBlocker],
    ]);
    expect(blockingTask(task({ blockedBy: ["k0"] }), byId)?.title).toBe("先定接口");
    expect(blockingTask(task({ blockedBy: ["k9"] }), byId)).toBeNull();
    expect(blockingTask(task({ blockedBy: ["不存在"] }), byId)).toBeNull();
    expect(blockingTask(task(), byId)).toBeNull();
  });
});

describe("复盘摘要（d.267）", () => {
  const tasks = [
    task({
      id: "k1",
      title: "接口联调",
      status: "done",
      assigneeId: "u2",
      completedBy: "u2",
      completedAt: new Date(NOW - 2 * DAY).toISOString(),
      result: "按契约接上，联调通过",
    }),
    task({
      id: "k2",
      title: "写落地页",
      status: "doing",
      assigneeId: "u2",
      dueAt: new Date(NOW - 3 * DAY).toISOString(),
      nudgeCount: 2,
      nudgedAt: new Date(NOW - DAY).toISOString(),
      updatedAt: new Date(NOW - 2 * DAY).toISOString(),
    }),
    task({ id: "k3", title: "没人认领的活", assigneeId: null }),
    task({ id: "k4", title: "等接口的任务", assigneeId: "u1", blockedBy: ["k2"] }),
    task({
      id: "k5",
      title: "退回来的活",
      assigneeId: null,
      status: "todo",
      returnedAt: new Date(NOW - 4 * DAY).toISOString(),
      returnNote: "缺权限账号",
    }),
    task({ id: "k6", title: "早就做完的", status: "done", completedAt: new Date(NOW - 40 * DAY).toISOString() }),
  ];

  it("概况行给出任务数、逾期、待认领、被挡、窗口内完成/新增", () => {
    const text = buildTeamDigest(snap(tasks), { now: NOW, memberName: name });
    expect(text).toContain("团队「增长小组」近 7 天概览");
    expect(text).toContain("任务 6 件（未完成 4 / 已完成 2）");
    expect(text).toContain("逾期 1");
    expect(text).toContain("待认领 2");
    expect(text).toContain("被前置任务挡着 1");
    expect(text).toContain("完成 1 件");
    expect(text).toContain("团队目标：把周活提升 10%");
  });

  it("列出窗口内完成的结论与完成人", () => {
    const text = buildTeamDigest(snap(tasks), { now: NOW, memberName: name });
    expect(text).toContain("这 7 天完成：");
    expect(text).toContain("接口联调（林晓（@linxiao）");
    expect(text).toContain("按契约接上，联调通过");
    expect(text).not.toContain("早就做完的（");
  });

  it("按人看：完成数、手上未完成与在做/未开始", () => {
    const text = buildTeamDigest(snap(tasks), { now: NOW, memberName: name });
    expect(text).toContain("林晓（@linxiao）：这 7 天完成 1，手上未完成 1 件（1 件逾期），其中在做 1");
    expect(text).toContain("管理员（@admin）（队长）：这 7 天完成 0，手上未完成 1");
  });

  it("需要关注：逾期、退回、等前置、催过没动、待认领都能点出来", () => {
    const text = buildTeamDigest(snap(tasks), { now: NOW, memberName: name });
    expect(text).toContain("逾期 3 天：写落地页");
    expect(text).toContain("已催 2 次");
    expect(text).toContain("被退回待重新安排：退回来的活（原因：缺权限账号）");
    expect(text).toContain("等前置：等接口的任务 要等「写落地页」完成");
    expect(text).toContain("催过没动：写落地页");
    expect(text).toContain("待认领：没人认领的活");
  });

  it("空团队也给出可执行的下一步，不返回空串", () => {
    const text = buildTeamDigest(snap([]), { now: NOW });
    expect(text).toContain("任务 0 件");
    expect(text).toContain("没有逾期、没有退回、没有被前置挡住的任务");
    expect(text).toContain("team_task_update");
  });

  it("列表超长时收口成「还有 N 件」", () => {
    const many = Array.from({ length: DIGEST_LIST_MAX + 3 }, (_, i) =>
      task({
        id: `k${i}`,
        title: `完成项 ${i}`,
        status: "done",
        completedAt: new Date(NOW - DAY).toISOString(),
        assigneeId: "u2",
        completedBy: "u2",
      }),
    );
    const text = buildTeamDigest(snap(many), { now: NOW, memberName: name });
    expect(text).toContain(`还有 ${many.length - DIGEST_LIST_MAX} 件没列出来`);
  });

  it("days 会被夹在 1–30；默认 7 天", () => {
    const text = buildTeamDigest(snap(tasks), { now: NOW, days: 999, memberName: name });
    expect(text).toContain(`近 ${DIGEST_MAX_DAYS} 天概览`);
    const fallback = buildTeamDigest(snap(tasks), { now: NOW });
    expect(fallback).toContain(`近 ${DIGEST_DEFAULT_DAYS} 天概览`);
  });
});

describe("高优先级要先摆到台面上（d.268）", () => {
  it("复盘里点名高优先级未完成的任务，并注明谁在做", () => {
    const text = buildTeamDigest(
      snap([
        task({ id: "k1", title: "线上故障", priority: "high", status: "doing", assigneeId: "u2" }),
        task({ id: "k2", title: "写周报", priority: "normal" }),
      ]),
      { now: NOW, days: 7, memberName: name },
    );
    expect(text).toContain("高优先级：线上故障（林晓（@linxiao），在做）");
  });
});

describe("待验收的活要先被看见（d.275）", () => {
  it("交上来等验收的排在优先级前面，并带上一句结论", () => {
    const text = buildTeamDigest(
      snap([
        task({
          id: "k1",
          status: "done",
          reviewState: "pending",
          result: "初稿已发群里",
          completedAt: new Date(NOW - DAY).toISOString(),
        }),
        task({ id: "k2", status: "todo", priority: "high" }),
      ]),
      { now: NOW, days: 7, memberName: name },
    );
    const attention = text.slice(text.indexOf("需要关注："));
    expect(attention).toContain("待验收：写落地页");
    expect(attention).toContain("初稿已发群里");
    // 待验收卡着交付，必须排在「高优先级」之前。
    expect(attention.indexOf("待验收：")).toBeLessThan(attention.indexOf("高优先级："));
  });
});
