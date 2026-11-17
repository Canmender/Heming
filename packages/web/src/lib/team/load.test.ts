import { describe, expect, it } from "vitest";

import { BUSY_OPEN, describeAssigneeLoad, describeLoad, loadOf, memberLoads } from "./load.js";

const now = Date.parse("2026-11-17T12:00:00.000Z");

const task = (
  assigneeId: string | null,
  status: string,
  dueAt: string | null = null,
): { assigneeId: string | null; status: string; dueAt: string | null } => ({
  assigneeId,
  status,
  dueAt,
});

describe("成员待办负载（d.264）", () => {
  it("只数未完成的：已完成的不构成压力", () => {
    const loads = memberLoads(
      [task("u1", "todo"), task("u1", "doing"), task("u1", "done"), task("u2", "done")],
      now,
    );
    expect(loadOf(loads, "u1").open).toBe(2);
    expect(loads.has("u2")).toBe(false);
  });

  it("逾期单独数：截止早于现在才算，坏时间不算", () => {
    const loads = memberLoads(
      [
        task("u1", "todo", "2026-11-16T00:00:00.000Z"), // 昨天 → 逾期
        task("u1", "doing", "2026-11-18T00:00:00.000Z"), // 明天 → 不逾期
        task("u1", "todo", "不是时间"), // 坏值 → 不冤枉
        task("u1", "done", "2026-11-01T00:00:00.000Z"), // 已完成 → 不数
      ],
      now,
    );
    const load = loadOf(loads, "u1");
    expect(load).toEqual({ open: 3, overdue: 1 });
  });

  it("没认领的任务不算到任何人头上", () => {
    const loads = memberLoads([task(null, "todo"), task("u1", "todo")], now);
    expect(loads.size).toBe(1);
    expect(loads.get("u1")?.open).toBe(1);
    expect(loadOf(loads, null)).toEqual({ open: 0, overdue: 0 });
  });

  it("文案：没有活 / 有活 / 有活且逾期", () => {
    expect(describeLoad({ open: 0, overdue: 0 })).toBe("没有未完成的任务");
    expect(describeLoad({ open: 3, overdue: 0 })).toBe("3 项未完成");
    expect(describeLoad({ open: 3, overdue: 1 })).toBe("3 项未完成（1 项已逾期）");
  });

  it("派活附注：普通负载只说事实，超过阈值额外提醒考虑换人", () => {
    expect(describeAssigneeLoad("阿鸣（@aming）", { open: 2, overdue: 0 })).toBe(
      "阿鸣（@aming）手上2 项未完成。",
    );
    const busy = describeAssigneeLoad("阿鸣（@aming）", { open: BUSY_OPEN + 1, overdue: 1 });
    expect(busy).toContain("已经比较满了");
    expect(busy).toContain("考虑换一个人做");
    // 阈值本身不算「比较满」：正好 5 件时只陈述事实。
    expect(describeAssigneeLoad("小李（@lx）", { open: BUSY_OPEN, overdue: 0 })).not.toContain(
      "比较满",
    );
  });
});
