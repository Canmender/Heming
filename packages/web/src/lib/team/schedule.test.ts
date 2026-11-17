import { describe, expect, it } from "vitest";
import type { TeamTask } from "@heming/shared";
import { bucketOf, describeSchedule, dueText, scheduleBuckets, startOfDay } from "./schedule.js";

const DAY = 24 * 60 * 60 * 1000;
/** 固定一个本地上午 10 点，避免「按小时算还是按日历日算」被时区/时刻带偏。 */
const NOW = new Date(2026, 10, 18, 10, 0, 0).getTime();

function task(over: Partial<TeamTask> & { id: string }): TeamTask {
  return {
    teamId: "t1",
    title: over.id,
    detail: "",
    status: "todo",
    assigneeId: null,
    planId: null,
    dueAt: null,
    priority: "normal",
    createdBy: "u1",
    createdAt: new Date(NOW - DAY).toISOString(),
    updatedAt: new Date(NOW - DAY).toISOString(),
    ...over,
  } as TeamTask;
}

const iso = (daysFromNow: number, hour = 18) =>
  new Date(startOfDay(NOW) + daysFromNow * DAY + hour * 60 * 60 * 1000).toISOString();

describe("按截止日分组（d.277）", () => {
  it("今天、明天、本周、下周以后各归各档，按日历日算而不是按满 24 小时", () => {
    expect(bucketOf(task({ id: "a", dueAt: iso(0) }), NOW)).toBe("today");
    expect(bucketOf(task({ id: "b", dueAt: iso(1) }), NOW)).toBe("tomorrow");
    expect(bucketOf(task({ id: "c", dueAt: iso(5) }), NOW)).toBe("week");
    expect(bucketOf(task({ id: "d", dueAt: iso(7) }), NOW)).toBe("week");
    expect(bucketOf(task({ id: "e", dueAt: iso(8) }), NOW)).toBe("later");
  });

  it("截止日早于今天就是逾期，哪怕只差几小时", () => {
    // 昨天 23:00 的截止，在「今天上午 10 点」看已经是逾期
    expect(bucketOf(task({ id: "a", dueAt: iso(-1, 23) }), NOW)).toBe("overdue");
  });

  it("已完成的任务不进这个视图；没有/写坏截止日期的算「没定截止」", () => {
    expect(bucketOf(task({ id: "a", status: "done", dueAt: iso(0) }), NOW)).toBeNull();
    expect(bucketOf(task({ id: "b", dueAt: null }), NOW)).toBe("none");
    expect(bucketOf(task({ id: "c", dueAt: "不是时间" }), NOW)).toBe("none");
  });

  it("空档不出现，顺序固定：逾期 → 今天 → 明天 → 本周 → 下周以后 → 没定截止", () => {
    const buckets = scheduleBuckets(
      [
        task({ id: "no-due" }),
        task({ id: "later", dueAt: iso(10) }),
        task({ id: "today", dueAt: iso(0) }),
        task({ id: "overdue", dueAt: iso(-2) }),
        task({ id: "done", status: "done", dueAt: iso(-3) }),
      ],
      NOW,
    );
    expect(buckets.map((b) => b.key)).toEqual(["overdue", "today", "later", "none"]);
    expect(buckets[0]!.label).toBe("已逾期");
    expect(buckets[0]!.tasks.map((t) => t.id)).toEqual(["overdue"]);
  });

  it("同一档里保持传入顺序（调用方按快照顺序给，别在这里再排一遍）", () => {
    const buckets = scheduleBuckets(
      [task({ id: "b", dueAt: iso(0) }), task({ id: "a", dueAt: iso(0) })],
      NOW,
    );
    expect(buckets[0]!.tasks.map((t) => t.id)).toEqual(["b", "a"]);
  });

  it("摘要一行说清各档件数", () => {
    const buckets = scheduleBuckets(
      [
        task({ id: "o1", dueAt: iso(-1) }),
        task({ id: "o2", dueAt: iso(-3) }),
        task({ id: "t1", dueAt: iso(0) }),
        task({ id: "n1" }),
      ],
      NOW,
    );
    expect(describeSchedule(buckets)).toBe("2 件已逾期 · 1 件今天到期 · 1 件没定截止");
    expect(describeSchedule([])).toBe("");
  });

  it("单个任务的截止说明：逾期按天、近期说今天/明天、远期给月日", () => {
    expect(dueText(task({ id: "a", dueAt: iso(-3) }), NOW)).toBe("逾期 3 天");
    expect(dueText(task({ id: "b", dueAt: iso(0) }), NOW)).toBe("今天到期");
    expect(dueText(task({ id: "c", dueAt: iso(1) }), NOW)).toBe("明天到期");
    const far = new Date(startOfDay(NOW) + 12 * DAY);
    expect(dueText(task({ id: "d", dueAt: far.toISOString() }), NOW)).toBe(
      `${far.getMonth() + 1} 月 ${far.getDate()} 日`,
    );
    expect(dueText(task({ id: "e", dueAt: null }), NOW)).toBe("没定截止");
  });
});
