import { describe, it, expect } from "vitest";
import {
  ASSIGNED_TASK_LINES_MAX,
  ASSIGNED_TASK_TITLE_MAX,
  describeAssignedTasks,
  CLAIMABLE_TASK_LINES_MAX,
  describeBlockers,
  describeClaimableTasks,
  describeDue,
  formatClaimableTask,
  formatAssignedTask,
  type AssignedTeamTask,
} from "./assignedTasks.js";

const NOW = Date.parse("2026-11-17T10:00:00+08:00");

function item(over: Partial<AssignedTeamTask["task"]> = {}, teamName = "研发组"): AssignedTeamTask {
  return {
    teamId: "t1",
    teamName,
    task: {
      id: "task-1",
      title: "整理接口文档",
      detail: "",
      status: "todo",
      dueAt: null,
      assigneeId: "u1",
      ...over,
    },
  };
}

describe("团队任务说人话（d.248）", () => {
  it("截止时间：今天 / 明天 / N 天后 / 已过期 / 没定", () => {
    expect(describeDue(null, NOW)).toBe("");
    expect(describeDue("", NOW)).toBe("");
    expect(describeDue("不是时间", NOW)).toBe("");
    expect(describeDue(new Date(NOW).toISOString(), NOW)).toBe("今天截止");
    expect(describeDue(new Date(NOW + 24 * 3600_000).toISOString(), NOW)).toBe("明天截止");
    expect(describeDue(new Date(NOW + 3 * 24 * 3600_000).toISOString(), NOW)).toBe("3 天后截止");
    expect(describeDue(new Date(NOW - 2 * 24 * 3600_000).toISOString(), NOW)).toBe("已过期 2 天");
  });

  it("截止按日历日算，不按满 24 小时（今早刚过 1 分钟不算逾期 1 天）", () => {
    // 用本地时间构造，避免不同时区下 ISO 串跨日导致断言漂移。
    const localNoon = (y: number, m: number, d: number, h: number, min: number) =>
      new Date(y, m - 1, d, h, min).getTime();
    const now = localNoon(2026, 11, 17, 22, 0);
    // 同一天早上 8 点的截止：已经过了 14 小时，但仍是「今天」，不是「已过期 1 天」。
    expect(describeDue(new Date(localNoon(2026, 11, 17, 8, 0)).toISOString(), now)).toBe("今天截止");
    // 明天早上 8 点：现在 22 点，只差 10 小时，但跨了日历日 → 明天截止。
    expect(describeDue(new Date(localNoon(2026, 11, 18, 8, 0)).toISOString(), now)).toBe("明天截止");
    // 大后天早上：差不到 72 小时，但跨了 2 个日历日 → 2 天后截止。
    expect(describeDue(new Date(localNoon(2026, 11, 19, 8, 0)).toISOString(), now)).toBe("2 天后截止");
    // 1 分钟前刚过（同一天）：不算逾期 1 天。
    expect(describeDue(new Date(now - 60_000).toISOString(), now)).toBe("今天截止");
  });

  it("一行：团队 · 标题（状态，截止）", () => {
    expect(formatAssignedTask(item(), NOW)).toBe("研发组 · 整理接口文档（未开始）");
    expect(
      formatAssignedTask(
        item({ status: "doing", dueAt: new Date(NOW).toISOString() }),
        NOW,
      ),
    ).toBe("研发组 · 整理接口文档（在做，今天截止）");
  });

  it("没团队名时给占位词，不写空字符串", () => {
    expect(formatAssignedTask(item({}, "   "), NOW)).toContain("未命名团队");
  });

  it("标题过长按码点截断（不会劈开 emoji）", () => {
    const title = "😀".repeat(ASSIGNED_TASK_TITLE_MAX + 5);
    const line = formatAssignedTask(item({ title }), NOW);
    // 恰好保留 ASSIGNED_TASK_TITLE_MAX 个码点（emoji 不会被劈成半个替换字符）。
    expect(line).toContain("😀".repeat(ASSIGNED_TASK_TITLE_MAX) + "…");
    expect(line.includes("\uFFFD")).toBe(false);
  });

  it("空清单返回空数组（调用方据此决定不写这一段）", () => {
    expect(describeAssignedTasks([], NOW)).toEqual([]);
  });

  it("超过上限只列前 N 项，并交代还有几项", () => {
    const many = Array.from({ length: ASSIGNED_TASK_LINES_MAX + 2 }, (_, i) =>
      item({ id: `task-${i}`, title: `第 ${i + 1} 项` }),
    );
    const lines = describeAssignedTasks(many, NOW);
    expect(lines).toHaveLength(ASSIGNED_TASK_LINES_MAX + 1);
    expect(lines[0]).toContain("第 1 项");
    expect(lines[lines.length - 1]).toBe(
      `还有 2 项没列出来（用 team_get 看完整清单）。`,
    );
  });
});

describe("前置没做完的活儿要点名（d.255）", () => {
  const base = {
    teamId: "t1",
    teamName: "产品组",
    task: {
      id: "k-post",
      title: "按契约写实现",
      detail: "",
      status: "todo" as const,
      dueAt: null,
      assigneeId: "u2",
    },
  };

  it("有未完成前置时缀一句「前置还没完成」", () => {
    const line = formatAssignedTask(
      { ...base, openBlockers: [{ id: "k-pre", title: "先定接口契约" }] },
      Date.parse("2026-11-17T08:00:00.000Z"),
    );
    expect(line).toContain("前置还没完成：等「先定接口契约」做完");
  });

  it("没有前置（或缺字段）时不缀这句", () => {
    expect(formatAssignedTask({ ...base, openBlockers: [] })).not.toContain("前置");
    expect(formatAssignedTask(base)).not.toContain("前置");
    expect(describeBlockers(undefined)).toBe("");
  });

  it("前置多于两个时压成「等 N 项」", () => {
    const text = describeBlockers([
      { id: "a", title: "一" },
      { id: "b", title: "二" },
      { id: "c", title: "三" },
    ]);
    expect(text).toContain("等「一」「二」等 3 项");
  });
});

describe("待认领的活说人话（d.260）", () => {
  it("一项一行：团队 · 标题（待认领，截止）；有前置再缀一句", () => {
    expect(formatClaimableTask(item(), NOW)).toBe("研发组 · 整理接口文档（待认领）");
    expect(
      formatClaimableTask(item({ dueAt: "2026-11-18T10:00:00+08:00" }), NOW),
    ).toBe("研发组 · 整理接口文档（待认领，明天截止）");
    expect(
      formatClaimableTask({ ...item(), openBlockers: [{ id: "b1", title: "先定接口" }] }, NOW),
    ).toContain("前置还没完成");
  });

  it("最多列 ${CLAIMABLE_TASK_LINES_MAX} 项，多出来的用一句话交代；空数组不写这一段", () => {
    expect(describeClaimableTasks([], NOW)).toEqual([]);
    const many = Array.from({ length: CLAIMABLE_TASK_LINES_MAX + 1 }, (_, i) =>
      item({ id: `k${i}`, title: `活 ${i}` }),
    );
    const lines = describeClaimableTasks(many, NOW);
    expect(lines).toHaveLength(CLAIMABLE_TASK_LINES_MAX + 1);
    expect(lines[lines.length - 1]).toContain("还有 1 项待认领的活");
  });
});
