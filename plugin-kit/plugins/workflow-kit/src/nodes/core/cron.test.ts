import { describe, expect, it } from "vitest";
import { isValidCron, nextCronRun, parseCron } from "./cron.js";

/**
 * Cron 是定时触发里最容易出错的纯函数：解析边界（越界、步长 0、段数）与
 * 「下一次」的推进语义（严格大于 from、秒截断、日/周同时限制取或）都要钉住。
 * 所有日期都用本地时间构造，与实现口径一致（不涉及时区换算）。
 */

function at(
  year: number,
  month: number,
  day: number,
  hour: number,
  minute: number,
  second = 0,
): Date {
  return new Date(year, month - 1, day, hour, minute, second);
}

function iso(date: Date | null): string {
  return date ? date.toISOString() : "null";
}

describe("cron 解析", () => {
  it("接受通配、数字、范围、列表与步长", () => {
    expect(parseCron("* * * * *")).not.toBeNull();
    expect(parseCron("0 9 * * 1-5")).not.toBeNull();
    expect(parseCron("*/15 8-18/2 1,15 * *")).not.toBeNull();
    expect(parseCron("0 0 * * mon-fri")).not.toBeNull();
    expect(parseCron("0 0 1 jan,jul *")).not.toBeNull();
  });

  it("拒绝非法输入（段数、越界、步长 0、垃圾字符）", () => {
    expect(parseCron("")).toBeNull();
    expect(parseCron("* * * *")).toBeNull();
    expect(parseCron("* * * * * *")).toBeNull();
    expect(parseCron("60 * * * *")).toBeNull();
    expect(parseCron("* 24 * * *")).toBeNull();
    expect(parseCron("* * 32 * *")).toBeNull();
    expect(parseCron("* * * 13 *")).toBeNull();
    expect(parseCron("*/0 * * * *")).toBeNull();
    expect(parseCron("a * * * *")).toBeNull();
    expect(parseCron("5-1 * * * *")).toBeNull();
    expect(isValidCron("0 9 * * *")).toBe(true);
    expect(isValidCron("0 9 * *")).toBe(false);
  });

  it("周字段 7 与 0 都表示周日", () => {
    const parsed = parseCron("0 0 * * 7");
    expect(parsed?.daysOfWeek.has(0)).toBe(true);
    expect(parsed?.daysOfWeek.has(7)).toBe(false);
  });
});

describe("cron 下一次触发", () => {
  it("每分钟：严格大于 from，并截断秒", () => {
    const next = nextCronRun("* * * * *", at(2026, 11, 7, 10, 0, 30));
    expect(iso(next)).toBe(iso(at(2026, 11, 7, 10, 1)));
  });

  it("每 15 分钟对齐到下一个刻度", () => {
    expect(iso(nextCronRun("*/15 * * * *", at(2026, 11, 7, 10, 7)))).toBe(
      iso(at(2026, 11, 7, 10, 15)),
    );
    expect(iso(nextCronRun("*/15 * * * *", at(2026, 11, 7, 10, 45)))).toBe(
      iso(at(2026, 11, 7, 11, 0)),
    );
  });

  it("每天固定时刻：今天已过就顺延到明天", () => {
    expect(iso(nextCronRun("0 9 * * *", at(2026, 11, 7, 20, 31)))).toBe(
      iso(at(2026, 11, 8, 9, 0)),
    );
    expect(iso(nextCronRun("0 9 * * *", at(2026, 11, 7, 8, 0)))).toBe(
      iso(at(2026, 11, 7, 9, 0)),
    );
  });

  it("工作日 08:30：周六触发下一次是周一", () => {
    // 2026-11-07 是周六。
    expect(iso(nextCronRun("30 8 * * 1-5", at(2026, 11, 7, 20, 31)))).toBe(
      iso(at(2026, 11, 9, 8, 30)),
    );
  });

  it("日与周同时限制时取或（传统 cron 语义）", () => {
    // 从 2026-11-07（周六）看：11-09 周一先到，12-01 每月 1 号后到。
    expect(iso(nextCronRun("0 0 1 * 1", at(2026, 11, 7, 20, 31)))).toBe(
      iso(at(2026, 11, 9, 0, 0)),
    );
  });

  it("只限制日：等到下个月 1 号", () => {
    expect(iso(nextCronRun("0 0 1 * *", at(2026, 11, 7, 20, 31)))).toBe(
      iso(at(2026, 12, 1, 0, 0)),
    );
  });

  it("不可能命中的表达式在 366 天后返回 null", () => {
    expect(nextCronRun("0 0 31 2 *", at(2026, 11, 7, 20, 31))).toBeNull();
  });

  it("非法表达式与非法 from 都返回 null", () => {
    expect(nextCronRun("not a cron", at(2026, 11, 7, 0, 0))).toBeNull();
    expect(nextCronRun("* * * * *", new Date(Number.NaN))).toBeNull();
  });
});
