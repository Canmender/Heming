import { describe, expect, it } from "vitest";
import type { TeamTask } from "@heming/shared";
import {
  FIND_TASK_LIMIT_DEFAULT,
  FIND_TASK_LIMIT_MAX,
  describeFindResult,
  findTeamTasks,
  isOverdue,
  matchesTaskQuery,
  sortTaskHits,
} from "./findTasks.js";

const NOW = Date.parse("2026-11-17T12:00:00.000Z");

function task(overrides: Partial<TeamTask> = {}): TeamTask {
  return {
    id: "k1",
    teamId: "t1",
    planId: null,
    title: "接口联调",
    detail: "按契约把 /api/team 接上",
    assigneeId: null,
    status: "todo",
    createdBy: "u1",
    createdAt: "2026-11-10T09:00:00.000Z",
    updatedAt: "2026-11-10T09:00:00.000Z",
    dueAt: null,
    attachmentFileId: null,
    ...overrides,
  } as TeamTask;
}

describe("关键词匹配（d.266）", () => {
  it("空查询全中；单关键词命中标题", () => {
    expect(matchesTaskQuery(task(), "")).toBe(true);
    expect(matchesTaskQuery(task(), "   ")).toBe(true);
    expect(matchesTaskQuery(task(), "接口")).toBe(true);
    expect(matchesTaskQuery(task(), "周报")).toBe(false);
  });

  it("多个词必须都出现（AND），且不区分大小写", () => {
    expect(matchesTaskQuery(task(), "接口 契约")).toBe(true);
    expect(matchesTaskQuery(task(), "接口 周报")).toBe(false);
    expect(matchesTaskQuery(task({ title: "Fix Login" }), "fix")).toBe(true);
  });

  it("需求 / 结论 / 进展 / 任务 id 都算命中范围", () => {
    expect(matchesTaskQuery(task(), "按契约")).toBe(true);
    expect(matchesTaskQuery(task({ status: "done", result: "已上线灰度" }), "灰度")).toBe(true);
    expect(matchesTaskQuery(task({ progress: "卡在权限" }), "权限")).toBe(true);
    expect(matchesTaskQuery(task({ id: "k-abc" }), "k-abc")).toBe(true);
  });
});

describe("逾期判定与排序（d.266）", () => {
  it("只看未完成的：已完成 / 没有截止 / 坏时间都不算逾期", () => {
    expect(isOverdue(task({ dueAt: "2026-11-16T00:00:00.000Z" }), NOW)).toBe(true);
    expect(isOverdue(task({ dueAt: "2026-11-18T00:00:00.000Z" }), NOW)).toBe(false);
    expect(isOverdue(task({ status: "done", dueAt: "2026-11-16T00:00:00.000Z" }), NOW)).toBe(false);
    expect(isOverdue(task({ dueAt: null }), NOW)).toBe(false);
    expect(isOverdue(task({ dueAt: "不是时间" }), NOW)).toBe(false);
  });

  it("逾期优先，其次按截止升序，没有截止的靠后、按更新时间降序", () => {
    const late = task({ id: "k-late", dueAt: "2026-11-15T00:00:00.000Z" });
    const soon = task({ id: "k-soon", dueAt: "2026-11-18T00:00:00.000Z" });
    const far = task({ id: "k-far", dueAt: "2026-11-25T00:00:00.000Z" });
    const noneOld = task({ id: "k-none-old", updatedAt: "2026-11-01T00:00:00.000Z" });
    const noneNew = task({ id: "k-none-new", updatedAt: "2026-11-16T00:00:00.000Z" });
    const sorted = sortTaskHits([noneOld, far, soon, noneNew, late], NOW).map((t) => t.id);
    expect(sorted).toEqual(["k-late", "k-soon", "k-far", "k-none-new", "k-none-old"]);
  });
});

describe("找活（d.266）", () => {
  const tasks = [
    task({ id: "k1", title: "接口联调", assigneeId: "u2" }),
    task({ id: "k2", title: "写周报", assigneeId: "u1", status: "doing" }),
    task({ id: "k3", title: "接口文档", assigneeId: null, dueAt: "2026-11-16T00:00:00.000Z" }),
    task({ id: "k4", title: "接口验收", assigneeId: "u2", status: "done", result: "已验收" }),
  ];

  it("默认只看未完成，并给出命中数与扫描数", () => {
    const r = findTeamTasks({ tasks, query: "接口", now: NOW });
    expect(r.hits.map((t) => t.id)).toEqual(["k3", "k1"]);
    expect(r.total).toBe(2);
    expect(r.scanned).toBe(4);
  });

  it("status=all 时已完成也能找到；status=done 只留已完成", () => {
    expect(findTeamTasks({ tasks, query: "接口", status: "all", now: NOW }).total).toBe(3);
    expect(findTeamTasks({ tasks, status: "done", now: NOW }).hits.map((t) => t.id)).toEqual(["k4"]);
  });

  it("按负责人筛；传空串只看没人认领的", () => {
    expect(findTeamTasks({ tasks, assigneeId: "u2", now: NOW }).hits.map((t) => t.id)).toEqual([
      "k1",
    ]);
    expect(findTeamTasks({ tasks, assigneeId: null, now: NOW }).hits.map((t) => t.id)).toEqual([
      "k3",
    ]);
  });

  it("只留逾期的；limit 截断但 total 是全部命中数", () => {
    expect(findTeamTasks({ tasks, overdue: true, now: NOW }).hits.map((t) => t.id)).toEqual(["k3"]);
    const r = findTeamTasks({ tasks: [k1(tasks!), k2(tasks!)], limit: 1, now: NOW });
    expect(r.hits).toHaveLength(1);
    expect(r.total).toBe(2);
  });
});

function k1(all: TeamTask[]): TeamTask {
  return all[0]!;
}
function k2(all: TeamTask[]): TeamTask {
  return all[1]!;
}

describe("给模型看的文案（d.266）", () => {
  it("没找到时说清扫描了多少条、并能指出下一步", () => {
    const r = findTeamTasks({ tasks: [], query: "接口", now: NOW });
    const text = describeFindResult(r, { query: "接口" });
    expect(text).toContain("没有找到");
    expect(text).toContain("关键词「接口」");
    expect(text).toContain("status 放宽到 all");
  });

  it("命中时列负责人名字、截止与任务 id，并说明被截断", () => {
    const r = findTeamTasks({
      tasks: [
        task({ id: "k1", title: "接口联调", assigneeId: "u2", dueAt: "2026-11-16T00:00:00.000Z" }),
        task({ id: "k2", title: "接口文档", assigneeId: "u3" }),
      ],
      limit: 1,
      now: NOW,
    });
    const text = describeFindResult(r, {
      query: "接口",
      memberName: (id) => (id === "u2" ? "小李" : id),
      now: NOW,
      limit: FIND_TASK_LIMIT_MAX,
    });
    expect(text).toContain("关键词「接口」命中 2 条");
    expect(text).toContain("先列 1 条");
    expect(text).toContain("接口联调");
    expect(text).toContain("小李");
    expect(text).toContain("已逾期");
    expect(text).toContain("taskId k1");
    expect(text).toContain(`最多 ${FIND_TASK_LIMIT_MAX}`);
  });

  it("默认条数常量不超过上限", () => {
    expect(FIND_TASK_LIMIT_DEFAULT).toBeLessThanOrEqual(FIND_TASK_LIMIT_MAX);
  });
});

describe("排序先看轻重缓急（d.268）", () => {
  it("高优先级排在逾期之前；同档内再按逾期/截止", () => {
    const now = NOW;
    const overdueNormal = task({
      id: "late",
      priority: "normal",
      dueAt: "2026-11-01T00:00:00.000Z",
    });
    const urgent = task({ id: "urgent", priority: "high", dueAt: null });
    const sorted = sortTaskHits([overdueNormal, urgent], now).map((t) => t.id);
    expect(sorted).toEqual(["urgent", "late"]);
  });

  it("文案里给高/低加标记，普通任务不加", () => {
    const r = findTeamTasks({
      tasks: [
        task({ id: "a", title: "先做", priority: "high" }),
        task({ id: "b", title: "顺手", priority: "low" }),
        task({ id: "c", title: "常规" }),
      ],
      now: NOW,
    });
    const text = describeFindResult(r, { now: NOW, memberName: () => "林晓" });
    expect(text).toContain("【高】先做");
    expect(text).toContain("【低】顺手");
    expect(text).toContain("常规");
    expect(text).not.toContain("【高】常规");
  });
});
