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
  byProfileModel,
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
    expect(rows[0]).toEqual({ day: "2026-10-01", total: 100, byModel: { a: 100 }, missing: 0 });
    expect(rows[1]).toEqual({ day: "2026-10-02", total: 0, byModel: {}, missing: 0 });
    expect(rows[2]).toEqual({
      day: "2026-10-03",
      total: 46,
      byModel: { a: 40, b: 6 },
      missing: 0,
    });
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

/**
 * 未上报（tokens:null）：既不参与求和，也不能被当成 0 悄悄吞掉——
 * 聚合结果单独给 missing 计数，界面才有素材说「未上报」。
 */
describe("tokenUsage：未上报（tokens:null）", () => {
  const missingRec = (model: string, at: string) => ({ model, tokens: null, at });
  const at = (day: number, hour = 12) => new Date(2026, 9, day, hour).toISOString();

  beforeEach(() => {
    localStorage.removeItem("heming.tokenUsage");
    useTokenUsageStore.getState().reset();
  });

  it("recordUnreported 写 tokens:null 并持久化", () => {
    useTokenUsageStore.getState().recordUnreported("claude-sonnet-5", at(13, 8));
    const s = useTokenUsageStore.getState();
    expect(s.records).toHaveLength(1);
    expect(s.records[0].tokens).toBeNull();
    expect(s.records[0].model).toBe("claude-sonnet-5");
    const saved = JSON.parse(localStorage.getItem("heming.tokenUsage")!);
    expect(saved.records[0].tokens).toBeNull();
  });

  it("summarizeMonth：total 不含 null，missing 单独计数", () => {
    const records = [
      rec("a", 100, at(1)),
      missingRec("a", at(2)),
      missingRec("b", at(3)),
      rec("b", 50, at(4)),
      missingRec("a", new Date(2026, 8, 30, 23).toISOString()), // 上月，不计
    ];
    const s = summarizeMonth(records, "2026-10");
    expect(s.total).toBe(150);
    expect(s.byModel).toEqual({ a: 100, b: 50 });
    expect(s.missing).toBe(2);
  });

  it("dailyTotals：当天只有未上报 → total 0 且 missing 计数", () => {
    const records = [rec("a", 10, at(1)), missingRec("a", at(1, 13)), missingRec("a", at(2))];
    const rows = dailyTotals(records, "2026-10");
    expect(rows[0]).toEqual({ day: "2026-10-01", total: 10, byModel: { a: 10 }, missing: 1 });
    expect(rows[1]).toEqual({ day: "2026-10-02", total: 0, byModel: {}, missing: 1 });
  });

  it("last30DaysTotals：null 不产生热度，只计 missing", () => {
    const now = new Date(2026, 9, 17, 12);
    const rows = last30DaysTotals([missingRec("a", at(17, 1)), rec("a", 10, at(16, 1))], now);
    expect(rows[29]).toEqual({ day: "2026-10-17", total: 0, missing: 1 });
    expect(rows[28]).toEqual({ day: "2026-10-16", total: 10, missing: 0 });
    expect(heatLevel(rows[29].total, 10)).toBe(0);
  });
});

/**
 * 逐连接归属（d.48 路由组）：路由组下 profile 是 `route.<gid>` 合成档，
 * 钱要落到具体 Key 才谈得上「哪个候选贵、哪个候选在烧额度」。
 */
describe("tokenUsage：逐连接用量（d.48）", () => {
  const at = (day: number, hour = 12) => new Date(2026, 9, day, hour).toISOString();

  beforeEach(() => {
    localStorage.removeItem("heming.tokenUsage");
    useTokenUsageStore.getState().reset();
  });

  it("record 带 meta → 归属与拆分入档并持久化；不带 meta 的老写法照旧", () => {
    useTokenUsageStore
      .getState()
      .record("deepseek-chat", 300, at(13, 8), { profileId: "p2", profileLabel: "备用 Key", input: 240, output: 60 });
    useTokenUsageStore.getState().record("gpt-old", 10, at(13, 9));
    const s = useTokenUsageStore.getState();
    expect(s.records[0]).toEqual({
      model: "deepseek-chat",
      tokens: 300,
      at: at(13, 8),
      profileId: "p2",
      profileLabel: "备用 Key",
      input: 240,
      output: 60,
    });
    expect(s.records[1].profileId).toBeUndefined();
    const saved = JSON.parse(localStorage.getItem("heming.tokenUsage")!);
    expect(saved.records[0].profileId).toBe("p2");
  });

  it("byProfileModel：按 连接×模型 分档，未上报轮单独计数，老记录（无归属）不进账", () => {
    const records = [
      { model: "deepseek-chat", tokens: 100, at: at(1), profileId: "p1", profileLabel: "A", input: 80, output: 20 },
      { model: "deepseek-chat", tokens: 50, at: at(2), profileId: "p1", profileLabel: "A", input: 40, output: 10 },
      { model: "kimi", tokens: 70, at: at(3), profileId: "p2", profileLabel: "B", input: 60, output: 10 },
      { model: "kimi", tokens: null, at: at(4), profileId: "p2", profileLabel: "B" },
      { model: "x", tokens: 999, at: at(5) }, // 没有归属 = 归不到具体 Key，不进这份账
      { model: "deepseek-chat", tokens: 1, at: new Date(2026, 8, 30).toISOString(), profileId: "p1" }, // 上月
    ];
    const rows = byProfileModel(records, "2026-10");
    expect(rows).toEqual([
      {
        profileId: "p1",
        profileLabel: "A",
        model: "deepseek-chat",
        total: 150,
        input: 120,
        output: 30,
        runs: 2,
        unreported: 0,
        lastAt: at(2),
      },
      {
        profileId: "p2",
        profileLabel: "B",
        model: "kimi",
        total: 70,
        input: 60,
        output: 10,
        runs: 2,
        unreported: 1,
        lastAt: at(4),
      },
    ]);
  });

  it("byProfileModel：缺省 monthKey = 全部历史；同连接换模型分两档（价目按模型查）", () => {
    const rows = byProfileModel([
      { model: "m1", tokens: 10, at: at(1), profileId: "p1", profileLabel: "A" },
      { model: "m2", tokens: 20, at: at(2), profileId: "p1", profileLabel: "A" },
      { model: "m1", tokens: 1, at: new Date(2026, 8, 1).toISOString(), profileId: "p1", profileLabel: "A" },
    ]);
    expect(rows.map((r) => [r.model, r.total])).toEqual([
      ["m2", 20],
      ["m1", 11],
    ]);
  });
});
