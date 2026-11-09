import { describe, expect, it } from "vitest";
import { createWorkflowDate, WorkflowDateImpl } from "./date.js";

/**
 * `$now` / `$today` 的最小日期能力测试。
 *
 * 全部用**本地时区**断言（date.ts 的既定口径）：`new Date(2026, 10, 7, …)` 与
 * `format()` 的本地字段一致，测试机器换时区也不会错位。跨时区的精确边界不在本版承诺内。
 */

const NOW = new Date(2026, 10, 7, 9, 30, 5, 42); // 2026-11-07 周六

describe("WorkflowDate.format", () => {
  it("默认格式与自定义 token", () => {
    const date = createWorkflowDate(NOW);
    expect(date.format()).toBe("2026-11-07 09:30:05");
    expect(date.format("yyyy/MM/dd")).toBe("2026/11/07");
    expect(date.format("HH:mm:ss.SSS")).toBe("09:30:05.042");
    expect(date.format("yyyy年MM月dd日")).toBe("2026年11月07日");
    // 不认识的字符原样输出
    expect(date.format("yyyy-MM-dd（周）")).toBe("2026-11-07（周）");
  });
});

describe("WorkflowDate 加减与取整", () => {
  it("加减不修改原对象", () => {
    const date = createWorkflowDate(NOW);
    const plusDay = date.plus(1, "day");
    const minusWeek = date.minus(1, "week");
    expect(plusDay.format("yyyy-MM-dd HH:mm:ss")).toBe("2026-11-08 09:30:05");
    expect(minusWeek.format("yyyy-MM-dd")).toBe("2026-10-31");
    expect(date.format("yyyy-MM-dd HH:mm:ss")).toBe("2026-11-07 09:30:05");
    expect(plusDay).not.toBe(date);
    expect(plusDay).toBeInstanceOf(WorkflowDateImpl);
  });

  it("month / year 按日历进位，不按毫秒累加", () => {
    const date = createWorkflowDate(NOW);
    expect(date.plus(1, "month").format("yyyy-MM-dd")).toBe("2026-12-07");
    expect(date.plus(1, "year").format("yyyy-MM-dd")).toBe("2027-11-07");
    // 1 月 31 日 +1 月：setMonth 会溢出到 3 月，这里只钉住「不抛错、返回新对象」
    const jan31 = createWorkflowDate(new Date(2026, 0, 31));
    expect(jan31.plus(1, "month").format("yyyy-MM")).toBe("2026-03");
  });

  it("startOf 取各单位起点（周从周一开始）", () => {
    const date = createWorkflowDate(NOW);
    expect(date.startOf("second").format("HH:mm:ss.SSS")).toBe("09:30:05.000");
    expect(date.startOf("minute").format("HH:mm:ss")).toBe("09:30:00");
    expect(date.startOf("hour").format("HH:mm:ss")).toBe("09:00:00");
    expect(date.startOf("day").format("yyyy-MM-dd HH:mm:ss")).toBe("2026-11-07 00:00:00");
    expect(date.startOf("week").format("yyyy-MM-dd")).toBe("2026-11-02");
    expect(date.startOf("month").format("yyyy-MM-dd")).toBe("2026-11-01");
    expect(date.startOf("year").format("yyyy-MM-dd")).toBe("2026-01-01");
  });
});

describe("WorkflowDate 与 Date 的边界", () => {
  it("toISO 是带本地偏移的 ISO8601", () => {
    const iso = createWorkflowDate(NOW).toISO();
    expect(iso.startsWith("2026-11-07T09:30:05.042")).toBe(true);
    expect(iso).toMatch(/[+-]\d{2}:\d{2}$/);
  });

  it("toMillis / toDate 是稳定快照", () => {
    const date = createWorkflowDate(NOW);
    expect(date.toMillis()).toBe(NOW.getTime());
    const native = date.toDate();
    expect(native.getTime()).toBe(NOW.getTime());
    native.setFullYear(2000);
    expect(date.format("yyyy")).toBe("2026");
  });

  it("接受 number / string 构造", () => {
    expect(createWorkflowDate(NOW.getTime()).format("yyyy-MM-dd")).toBe("2026-11-07");
    expect(createWorkflowDate(NOW.toISOString()).toMillis()).toBe(NOW.getTime());
  });

  it("toString / toJSON 走 ISO 形式，便于文本拼接", () => {
    const date = createWorkflowDate(NOW);
    expect(String(date)).toBe(date.toISO());
    expect(JSON.stringify({ at: date })).toBe(`{"at":"${date.toISO()}"}`);
  });
});
