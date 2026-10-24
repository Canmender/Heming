import { describe, it, expect } from "vitest";
import {
  TIME_SEPARATOR_GAP_MS,
  formatClock,
  formatDayClock,
  needsTimeSeparator,
} from "./formatTime.js";

/** 本地时区构造（避免用 Z 字面量在 CI 不同时区下漂移）。 */
const at = (y: number, mo: number, d: number, h = 0, mi = 0) =>
  new Date(y, mo - 1, d, h, mi).toISOString();
const now = new Date(2026, 9, 24, 18, 30); // 2026-10-24 18:30 本地

describe("formatClock", () => {
  it("当天 → HH:mm", () => {
    expect(formatClock(at(2026, 10, 24, 9, 5), now)).toBe("09:05");
  });
  it("跨天 → MM-DD HH:mm", () => {
    expect(formatClock(at(2026, 10, 23, 9, 5), now)).toBe("10-23 09:05");
  });
  it("非法时间 → 空串（不显示 NaN）", () => {
    expect(formatClock("not-a-date", now)).toBe("");
  });
});

describe("formatDayClock", () => {
  it("今天 / 昨天 / 同年 / 跨年 四级口径", () => {
    expect(formatDayClock(at(2026, 10, 24, 8, 0), now)).toBe("今天 08:00");
    expect(formatDayClock(at(2026, 10, 23, 8, 0), now)).toBe("昨天 08:00");
    expect(formatDayClock(at(2026, 10, 20, 8, 0), now)).toBe("10月20日 08:00");
    expect(formatDayClock(at(2025, 12, 31, 8, 0), now)).toBe("2025年12月31日 08:00");
  });
});

describe("needsTimeSeparator", () => {
  it("首条必插", () => {
    expect(needsTimeSeparator(undefined, at(2026, 10, 24, 9, 0))).toBe(true);
  });
  it("5 分钟内的连续消息不插", () => {
    expect(
      needsTimeSeparator(at(2026, 10, 24, 9, 0), at(2026, 10, 24, 9, 4)),
    ).toBe(false);
  });
  it("间隔达到 5 分钟插入", () => {
    expect(
      needsTimeSeparator(at(2026, 10, 24, 9, 0), at(2026, 10, 24, 9, 5)),
    ).toBe(true);
    expect(TIME_SEPARATOR_GAP_MS).toBe(5 * 60 * 1000);
  });
  it("跨天必插（即便只隔一分钟）", () => {
    expect(
      needsTimeSeparator(at(2026, 10, 23, 23, 59), at(2026, 10, 24, 0, 0)),
    ).toBe(true);
  });
});
