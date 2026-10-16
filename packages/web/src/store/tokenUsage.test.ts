import { describe, it, expect, beforeEach } from "vitest";
import {
  useTokenUsageStore,
  monthKeyOf,
  dayKeyOf,
  summarizeMonth,
  daysOfMonth,
  dailyTotals,
  last30DaysTotals,
  heatLevel,
} from "./tokenUsage.js";

const rec = (model: string, tokens: number, at: string) => ({ model, tokens, at });

describe("tokenUsage：按天/按月重算，不存累计总值", () => {
  beforeEach(() => {
    localStorage.removeItem("heming.tokenUsage");
    useTokenUsageStore.getState().reset();
  });

  it("record 只追加原始记录，不存 total 字段", () => {
    useTokenUsageStore
      .getState()
      .record("claude-sonnet-5", 1000, new Date(2026, 9, 13, 10).toISOString());
    useTokenUsageStore
      .getState()
      .record("deepseek-v3", 200, new Date(2026, 9, 13, 11).toISOString());
    const s = useTokenUsageStore.getState();
    expect(s.records).toHaveLength(2);
    expect("total" in s).toBe(false);
  });

  it("monthKeyOf/dayKeyOf 提取本地自然月与自然日", () => {
    expect(monthKeyOf(new Date(2026, 9, 13, 23, 59, 59).toISOString())).toBe("2026-10");
    expect(dayKeyOf(new Date(2026, 9, 13, 0, 0, 1).toISOString())).toBe("2026-10-13");
  });

  it("summarizeMonth 只统计当月、跨月不串", () => {
    const records = [
      rec("a", 100, new Date(2026, 9, 1, 1).toISOString()),
      rec("a", 50, new Date(2026, 9, 31, 23).toISOString()),
      rec("b", 999, new Date(2026, 8, 30, 23).toISOString()),
    ];
    const s = summarizeMonth(records, "2026-10");
    expect(s.total).toBe(150);
    expect(s.byModel).toEqual({ a: 150 });
  });

  it("daysOfMonth 列出当月每一天", () => {
    const days = daysOfMonth("2026-10");
    expect(days).toHaveLength(31);
    expect(days[0]).toBe("2026-10-01");
    expect(days[30]).toBe("2026-10-31");
    expect(daysOfMonth("2026-02")).toHaveLength(28);
    expect(daysOfMonth("2028-02")).toHaveLength(29);
  });

  it("dailyTotals 零值天不跳过，且每行自带按模型明细", () => {
    const records = [
      rec("a", 100, new Date(2026, 9, 1, 1).toISOString()),
      rec("a", 40, new Date(2026, 9, 3, 1).toISOString()),
      rec("b", 6, new Date(2026, 9, 3, 5).toISOString()),
    ];
    const rows = dailyTotals(records, "2026-10");
    expect(rows).toHaveLength(31);
    expect(rows[0]).toEqual({ day: "2026-10-01", total: 100, byModel: { a: 100 } });
    expect(rows[1]).toEqual({ day: "2026-10-02", total: 0, byModel: {} });
    expect(rows[2]).toEqual({ day: "2026-10-03", total: 46, byModel: { a: 40, b: 6 } });
  });

  it("持久化写入 records 数组", () => {
    useTokenUsageStore.getState().record("qwen", 42, new Date(2026, 9, 13, 8).toISOString());
    const saved = JSON.parse(localStorage.getItem("heming.tokenUsage")!);
    expect(saved.records).toHaveLength(1);
    expect(saved.records[0].tokens).toBe(42);
  });

  it("reset 清空记录", () => {
    useTokenUsageStore.getState().record("qwen", 42, new Date(2026, 9, 13, 8).toISOString());
    useTokenUsageStore.getState().reset();
    expect(useTokenUsageStore.getState().records).toEqual([]);
  });
});

describe("last30DaysTotals", () => {
  it("30 项、零值天不跳过、末项为今天", () => {
    const now = new Date(2026, 9, 17, 12); // 本地 2026-10-17
    const rows = last30DaysTotals([], now);
    expect(rows).toHaveLength(30);
    expect(rows[29].day).toBe("2026-10-17");
    expect(rows.every((r) => r.total === 0)).toBe(true);
  });
  it("按本地日聚合命中对应格", () => {
    const now = new Date(2026, 9, 17, 12);
    const recs = [
      { model: "m", tokens: 10, at: new Date(2026, 9, 17, 1).toISOString() },
      { model: "m", tokens: 5, at: new Date(2026, 9, 16, 23).toISOString() },
      { model: "m", tokens: 999, at: new Date(2026, 8, 1, 1).toISOString() }, // 窗外
    ];
    const rows = last30DaysTotals(recs, now);
    expect(rows[29].total).toBe(10);
    expect(rows[28].total).toBe(5);
    expect(rows.reduce((s, r) => s + r.total, 0)).toBe(15);
  });
});

describe("heatLevel", () => {
  it("零/无 max → 0；四档相对刻度", () => {
    expect(heatLevel(0, 100)).toBe(0);
    expect(heatLevel(10, 0)).toBe(0);
    expect(heatLevel(25, 100)).toBe(1);
    expect(heatLevel(26, 100)).toBe(2);
    expect(heatLevel(50, 100)).toBe(2);
    expect(heatLevel(51, 100)).toBe(3);
    expect(heatLevel(75, 100)).toBe(3);
    expect(heatLevel(76, 100)).toBe(4);
  });
});
