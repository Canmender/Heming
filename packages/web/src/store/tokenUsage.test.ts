import { describe, it, expect, beforeEach } from "vitest";
import {
  useTokenUsageStore,
  monthKeyOf,
  dayKeyOf,
  summarizeMonth,
  daysOfMonth,
  dailyTotals,
} from "./tokenUsage.js";

const rec = (model: string, tokens: number, at: string) => ({ model, tokens, at });

describe("tokenUsage：按天/按月重算，不存累计总值", () => {
  beforeEach(() => {
    localStorage.removeItem("heming.tokenUsage");
    useTokenUsageStore.getState().reset();
  });

  it("record 只追加原始记录，不存 total 字段", () => {
    useTokenUsageStore.getState().record("claude-sonnet-5", 1000, "2026-10-13T10:00:00.000Z");
    useTokenUsageStore.getState().record("deepseek-v3", 200, "2026-10-13T11:00:00.000Z");
    const s = useTokenUsageStore.getState();
    expect(s.records).toHaveLength(2);
    expect("total" in s).toBe(false);
  });

  it("monthKeyOf/dayKeyOf 提取自然月与自然日", () => {
    expect(monthKeyOf("2026-10-13T23:59:59.000Z")).toBe("2026-10");
    expect(dayKeyOf("2026-10-13T00:00:01.000Z")).toBe("2026-10-13");
  });

  it("summarizeMonth 只统计当月、跨月不串", () => {
    const records = [
      rec("a", 100, "2026-10-01T01:00:00.000Z"),
      rec("a", 50, "2026-10-31T23:00:00.000Z"),
      rec("b", 999, "2026-09-30T23:00:00.000Z"),
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
      rec("a", 100, "2026-10-01T01:00:00.000Z"),
      rec("a", 40, "2026-10-03T01:00:00.000Z"),
      rec("b", 6, "2026-10-03T05:00:00.000Z"),
    ];
    const rows = dailyTotals(records, "2026-10");
    expect(rows).toHaveLength(31);
    expect(rows[0]).toEqual({ day: "2026-10-01", total: 100, byModel: { a: 100 } });
    expect(rows[1]).toEqual({ day: "2026-10-02", total: 0, byModel: {} });
    expect(rows[2]).toEqual({ day: "2026-10-03", total: 46, byModel: { a: 40, b: 6 } });
  });

  it("持久化写入 records 数组", () => {
    useTokenUsageStore.getState().record("qwen", 42, "2026-10-13T08:00:00.000Z");
    const saved = JSON.parse(localStorage.getItem("heming.tokenUsage")!);
    expect(saved.records).toHaveLength(1);
    expect(saved.records[0].tokens).toBe(42);
  });

  it("reset 清空记录", () => {
    useTokenUsageStore.getState().record("qwen", 42, "2026-10-13T08:00:00.000Z");
    useTokenUsageStore.getState().reset();
    expect(useTokenUsageStore.getState().records).toEqual([]);
  });
});
