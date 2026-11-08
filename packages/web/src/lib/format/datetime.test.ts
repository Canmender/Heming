import { afterEach, describe, expect, it, vi } from "vitest";
import { fmtLocalDateTime, isOverdue } from "./datetime.js";

/**
 * 时区语义：这两个函数都是**本机时区**语义，测试不能假设机器在哪个时区。
 *
 * 做法：先用本地构造器造一个时间点（`new Date(2026, 10, 10, 18, 5)`），
 * 转成服务端会存的 ISO 再渲染回来——必须还原成同一个本地时刻。
 * 这样无论 CI 在 UTC 还是东八区都成立，也正好覆盖「东八区填 18:00 显示 10:00」的旧 bug。
 */
describe("fmtLocalDateTime", () => {
  afterEach(() => {
    vi.useRealTimers();
  });

  it("把 ISO 按本机时区还原成本地时刻（本地构造 → ISO → 渲染回原值）", () => {
    const local = new Date(2026, 10, 10, 18, 5, 0);
    expect(fmtLocalDateTime(local.toISOString())).toBe("2026-11-10 18:05");
  });

  it("输出格式固定为 YYYY-MM-DD HH:mm，且与 new Date 的本地取数一致", () => {
    const iso = "2026-11-10T10:00:00.000Z";
    const d = new Date(iso);
    const pad = (n: number) => String(n).padStart(2, "0");
    const expected = `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())} ${pad(
      d.getHours(),
    )}:${pad(d.getMinutes())}`;

    const shown = fmtLocalDateTime(iso);
    expect(shown).toBe(expected);
    expect(shown).toMatch(/^\d{4}-\d{2}-\d{2} \d{2}:\d{2}$/);
  });

  it("跨日也按本机时区取年月日：UTC 深夜在东八区是次日凌晨", () => {
    // 2026-11-10T16:30:00Z = 东八区 2026-11-11 00:30；UTC 机器上则仍是 11-10 16:30。
    const iso = "2026-11-10T16:30:00.000Z";
    const d = new Date(iso);
    const pad = (n: number) => String(n).padStart(2, "0");
    expect(fmtLocalDateTime(iso)).toBe(
      `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())} ${pad(
        d.getHours(),
      )}:${pad(d.getMinutes())}`,
    );
  });

  it("空值/非法值返回空串", () => {
    expect(fmtLocalDateTime(null)).toBe("");
    expect(fmtLocalDateTime(undefined)).toBe("");
    expect(fmtLocalDateTime("")).toBe("");
    expect(fmtLocalDateTime("not-a-date")).toBe("");
  });
});

describe("isOverdue", () => {
  const now = Date.parse("2026-11-10T12:00:00.000Z");

  it("过去 → true；未来 → false；正好到点算未过期", () => {
    expect(isOverdue("2026-11-10T11:59:59.000Z", now)).toBe(true);
    expect(isOverdue("2026-11-10T12:00:01.000Z", now)).toBe(false);
    expect(isOverdue("2026-11-10T12:00:00.000Z", now)).toBe(false);
  });

  it("空值/非法值 → false（不因脏数据误报逾期）", () => {
    expect(isOverdue(null, now)).toBe(false);
    expect(isOverdue(undefined, now)).toBe(false);
    expect(isOverdue("", now)).toBe(false);
    expect(isOverdue("not-a-date", now)).toBe(false);
  });

  it("默认用当前时刻（vi.setSystemTime 固定时钟）", () => {
    vi.useFakeTimers();
    vi.setSystemTime(new Date("2026-11-10T12:00:00.000Z"));
    expect(isOverdue("2026-11-10T11:00:00.000Z")).toBe(true);
    expect(isOverdue("2026-11-10T13:00:00.000Z")).toBe(false);
    vi.useRealTimers();
  });
});
