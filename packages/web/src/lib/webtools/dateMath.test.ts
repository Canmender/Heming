import { describe, expect, it } from "vitest";
import { describeDifference, formatLocal, parseDateInput, shiftDate } from "./dateMath.js";

const NOW = new Date("2026-11-15T09:20:33.000Z");

describe("parseDateInput", () => {
  it("空串/now/今天 都表示此刻", () => {
    for (const raw of [undefined, "", "now", "今天", "现在"]) {
      const outcome = parseDateInput(raw, NOW);
      expect(outcome.ok, String(raw)).toBe(true);
      if (outcome.ok) expect(outcome.date.getTime()).toBe(NOW.getTime());
    }
  });

  it("纯日期按本机零点解析，带时间的按本机时区解析", () => {
    const date = parseDateInput("2026-11-15", NOW);
    expect(date.ok).toBe(true);
    if (date.ok) {
      expect(date.date.getFullYear()).toBe(2026);
      expect(date.date.getMonth()).toBe(10);
      expect(date.date.getDate()).toBe(15);
      expect(date.date.getHours()).toBe(0);
    }
    const withTime = parseDateInput("2026-11-15 09:30", NOW);
    expect(withTime.ok).toBe(true);
    if (withTime.ok) {
      expect(withTime.date.getHours()).toBe(9);
      expect(withTime.date.getMinutes()).toBe(30);
    }
    const iso = parseDateInput("2026-11-15T09:30:00Z", NOW);
    expect(iso.ok).toBe(true);
  });

  it("中文日期写法也能解析", () => {
    const outcome = parseDateInput("2026年11月15日", NOW);
    expect(outcome.ok).toBe(true);
    if (outcome.ok) expect(outcome.date.getFullYear()).toBe(2026);
  });

  it("看不懂的时间返回中文错误", () => {
    const outcome = parseDateInput("不是时间", NOW);
    expect(outcome.ok).toBe(false);
    if (!outcome.ok) expect(outcome.error).toContain("看不懂的时间");
  });
});

describe("shiftDate", () => {
  const base = new Date(2026, 0, 31, 10, 0, 0);

  it("天/小时/周按固定时长平移", () => {
    const plusDays = shiftDate(base, "3d");
    expect(plusDays.ok).toBe(true);
    if (plusDays.ok) expect(plusDays.date.getTime() - base.getTime()).toBe(3 * 86_400_000);
    const minusHours = shiftDate(base, "-2h");
    expect(minusHours.ok).toBe(true);
    if (minusHours.ok) expect(base.getTime() - minusHours.date.getTime()).toBe(2 * 3_600_000);
    const mixed = shiftDate(base, "1w 2d");
    expect(mixed.ok).toBe(true);
    if (mixed.ok) expect(mixed.date.getTime() - base.getTime()).toBe(9 * 86_400_000);
  });

  it("月按日历进位：1 月 31 日 + 1 个月 = 2 月 28 日（平年）", () => {
    const outcome = shiftDate(base, "1个月");
    expect(outcome.ok).toBe(true);
    if (outcome.ok) {
      expect(outcome.date.getMonth()).toBe(1);
      expect(outcome.date.getDate()).toBe(28);
    }
  });

  it("年按日历进位：2 月 29 日 + 1 年 = 2 月 28 日", () => {
    const leap = new Date(2024, 1, 29, 12, 0, 0);
    const outcome = shiftDate(leap, "1年");
    expect(outcome.ok).toBe(true);
    if (outcome.ok) {
      expect(outcome.date.getFullYear()).toBe(2025);
      expect(outcome.date.getMonth()).toBe(1);
      expect(outcome.date.getDate()).toBe(28);
    }
  });

  it("空规格原样返回，看不懂的单位/多余内容报错", () => {
    const same = shiftDate(base, "");
    expect(same.ok).toBe(true);
    if (same.ok) expect(same.date.getTime()).toBe(base.getTime());
    const badUnit = shiftDate(base, "3x");
    expect(badUnit.ok).toBe(false);
    const noNumber = shiftDate(base, "三天");
    expect(noNumber.ok).toBe(false);
    const junk = shiftDate(base, "3d 后来");
    expect(junk.ok).toBe(false);
  });
});

describe("describeDifference / formatLocal", () => {
  it("相差文本带方向与单位", () => {
    const later = new Date(2026, 10, 15, 12, 0, 0);
    const earlier = new Date(2026, 10, 10, 9, 0, 0);
    expect(describeDifference(earlier, later)).toContain("相差 5 天 3 小时");
    expect(describeDifference(earlier, later)).toContain("晚");
    expect(describeDifference(later, earlier)).toContain("早");
  });

  it("本机时间格式带时区偏移、星期与 UTC", () => {
    const formatted = formatLocal(new Date(2026, 10, 15, 9, 5, 3));
    expect(formatted.iso).toMatch(/^2026-11-15T09:05:03[+-]\d{2}:\d{2}$/);
    expect(formatted.pretty).toContain("2026年11月15日");
    expect(formatted.weekday).toContain("星期");
    expect(formatted.utc).toMatch(/Z$/);
  });
});
