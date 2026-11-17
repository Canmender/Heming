/**
 * 任务多久没动过（d.251）：边界都在「自然日」与「未完成」这两件事上。
 */

import { describe, expect, it } from "vitest";

import { daysSince, describeTaskAge, STALE_TASK_DAYS, taskAge } from "./taskAge.js";

const NOW = Date.parse("2026-11-17T10:00:00");

describe("任务多久没动过（d.251）", () => {
  it("自然日差：同一天是 0，跨一天是 1，未来时间夹成 0", () => {
    expect(daysSince("2026-11-17T01:00:00", NOW)).toBe(0);
    expect(daysSince("2026-11-17T23:00:00", NOW)).toBe(0);
    expect(daysSince("2026-11-16T23:00:00", NOW)).toBe(1);
    expect(daysSince("2026-11-10T23:00:00", NOW)).toBe(7);
    expect(daysSince("2026-11-20T00:00:00", NOW)).toBe(0);
    expect(daysSince(null, NOW)).toBeNull();
    expect(daysSince("不是时间", NOW)).toBeNull();
  });

  it("超过阈值且未完成才算 stale", () => {
    expect(taskAge({ status: "todo", updatedAt: "2026-11-17T09:00:00" }, NOW)).toEqual({
      days: 0,
      stale: false,
    });
    expect(taskAge({ status: "doing", updatedAt: "2026-11-14T09:00:00" }, NOW)).toEqual({
      days: 3,
      stale: true,
    });
    // 差一天就不到阈值
    expect(taskAge({ status: "doing", updatedAt: "2026-11-15T09:00:00" }, NOW).stale).toBe(false);
  });

  it("已完成的任务不催，时间认不出也不催", () => {
    expect(taskAge({ status: "done", updatedAt: "2026-11-01T00:00:00" }, NOW).stale).toBe(false);
    expect(describeTaskAge({ status: "done", updatedAt: "2026-11-01T00:00:00" }, NOW)).toBeNull();
    expect(describeTaskAge({ status: "todo", updatedAt: "不是时间" }, NOW)).toBeNull();
  });

  it("文案分三档：今天、N 天前、N 天没动", () => {
    expect(describeTaskAge({ status: "todo", updatedAt: "2026-11-17T01:00:00" }, NOW)).toBe("今天更新");
    expect(describeTaskAge({ status: "doing", updatedAt: "2026-11-16T01:00:00" }, NOW)).toBe(
      "1 天前更新",
    );
    expect(describeTaskAge({ status: "todo", updatedAt: "2026-11-13T01:00:00" }, NOW)).toBe(
      "4 天没动了",
    );
    expect(STALE_TASK_DAYS).toBe(3);
  });
});
