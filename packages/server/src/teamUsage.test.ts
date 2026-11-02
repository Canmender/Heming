import { describe, expect, it } from "vitest";
import type { TeamUsageRow } from "./store.js";
import {
  addDays,
  buildSelfUsage,
  buildUsageRanking,
  dayKeyUtc,
  daysBetween,
  parseDayKey,
  summarizeTeamUsage,
  usageRangeBounds,
} from "./teamUsage.js";

/**
 * 团队用量聚合（纯逻辑）：日期边界、未上报口径、排行只给聚合数。
 *
 * 这些判定双实现共用——store 只存行，口径只在这里，换存储不该换结论。
 */

function row(over: Partial<TeamUsageRow> & Pick<TeamUsageRow, "actorId" | "date">): TeamUsageRow {
  return {
    model: "gpt-x",
    tokens: 100,
    unreported: 0,
    connections: [],
    ...over,
  };
}

const NAMES = new Map([
  ["u1", "爱丽丝"],
  ["u2", "鲍勃"],
]);

describe("日期键与区间", () => {
  it("dayKeyUtc 按 UTC 补零；非法日期键返回 null（不静默改写）", () => {
    expect(dayKeyUtc(new Date("2026-11-02T23:30:00.000Z"))).toBe("2026-11-02");
    expect(parseDayKey("2026-11-02")).toBe(Date.UTC(2026, 10, 2));
    expect(parseDayKey("2026-02-31")).toBeNull(); // 滚月：必须判非法
    expect(parseDayKey("2026-1-1")).toBeNull();
    expect(parseDayKey("not-a-day")).toBeNull();
  });

  it("addDays 跨月跨年；区间含今天共 N 天", () => {
    expect(addDays("2026-11-02", -1)).toBe("2026-11-01");
    expect(addDays("2026-03-01", -1)).toBe("2026-02-28");
    expect(addDays("2026-01-01", -1)).toBe("2025-12-31");
    expect(usageRangeBounds("7d", "2026-11-02")).toEqual({ from: "2026-10-27", to: "2026-11-02" });
    expect(usageRangeBounds("30d", "2026-11-02")).toEqual({ from: "2026-10-04", to: "2026-11-02" });
    expect(daysBetween("2026-11-01", "2026-11-03")).toEqual([
      "2026-11-01",
      "2026-11-02",
      "2026-11-03",
    ]);
  });

  it("区间倒置/坏键给出空列表，不抛", () => {
    expect(daysBetween("2026-11-03", "2026-11-01")).toEqual([]);
    expect(daysBetween("bad", "2026-11-01")).toEqual([]);
  });
});

describe("本人明细", () => {
  it("按模型聚合并区分「未上报」：null 不进合计，单独计数", () => {
    const self = buildSelfUsage(
      [
        row({ actorId: "u1", date: "2026-11-02", tokens: 300 }),
        row({ actorId: "u1", date: "2026-11-02", tokens: null, unreported: 2 }),
        row({ actorId: "u1", date: "2026-11-01", model: "claude-y", tokens: 50 }),
      ],
      "2026-10-27",
      "2026-11-02",
    );
    expect(self.total).toBe(350);
    expect(self.unreported).toBe(2);
    expect(self.byModel).toEqual([
      { model: "gpt-x", tokens: 300, unreported: 2, connections: [] },
      { model: "claude-y", tokens: 50, unreported: 0, connections: [] },
    ]);
    // 逐日铺满区间（零值天也在），窗口外的不出现
    expect(self.byDay).toHaveLength(7);
    expect(self.byDay.at(-1)).toMatchObject({ date: "2026-11-02", tokens: 300, unreported: 2 });
  });

  it("连接名去重且最多 5 个", () => {
    const self = buildSelfUsage(
      [
        row({ actorId: "u1", date: "2026-11-02", connections: ["A", "B"] }),
        row({ actorId: "u1", date: "2026-11-02", connections: ["B", "C", "D", "E", "F"] }),
      ],
      "2026-11-02",
      "2026-11-02",
    );
    expect(self.byModel[0]!.connections).toEqual(["A", "B", "C", "D", "E"]);
  });
});

describe("全站排行", () => {
  it("按成员聚合并降序排序；只给聚合数与显示名（模型/连接名不外露）", () => {
    const ranking = buildUsageRanking(
      [
        row({ actorId: "u1", date: "2026-11-02", tokens: 100, connections: ["私密连接"] }),
        row({ actorId: "u1", date: "2026-11-01", tokens: 200, model: "私密模型" }),
        row({ actorId: "u2", date: "2026-11-02", tokens: null, unreported: 3 }),
      ],
      "2026-10-27",
      "2026-11-02",
      NAMES,
    );
    expect(ranking).toEqual([
      { userId: "u1", displayName: "爱丽丝", tokens: 300, unreported: 0, days: 2 },
      { userId: "u2", displayName: "鲍勃", tokens: 0, unreported: 3, days: 1 },
    ]);
    for (const entry of ranking) {
      expect(Object.keys(entry).sort()).toEqual(
        ["days", "displayName", "tokens", "unreported", "userId"].sort(),
      );
      expect(JSON.stringify(entry)).not.toContain("私密");
    }
  });

  it("同 token 时按天数、再按显示名排序（确定性，不依赖插入序）", () => {
    const ranking = buildUsageRanking(
      [
        row({ actorId: "u2", date: "2026-11-02", tokens: 100 }),
        row({ actorId: "u1", date: "2026-11-02", tokens: 100 }),
        row({ actorId: "u1", date: "2026-11-01", tokens: 0 }),
      ],
      "2026-11-01",
      "2026-11-02",
      NAMES,
    );
    expect(ranking.map((r) => r.userId)).toEqual(["u1", "u2"]);
  });

  it("未知成员显示名回落「成员」，不抛", () => {
    const ranking = buildUsageRanking(
      [row({ actorId: "ghost", date: "2026-11-02" })],
      "2026-11-02",
      "2026-11-02",
      NAMES,
    );
    expect(ranking[0]!.displayName).toBe("成员");
  });
});

describe("summarizeTeamUsage", () => {
  it("本人只汇总自己；排行含全部成员", () => {
    const res = summarizeTeamUsage(
      [
        row({ actorId: "u1", date: "2026-11-02", tokens: 100 }),
        row({ actorId: "u2", date: "2026-11-02", tokens: 900 }),
      ],
      { viewerId: "u1", range: "7d", from: "2026-10-27", to: "2026-11-02", names: NAMES },
    );
    expect(res.self.total).toBe(100);
    expect(res.ranking.map((r) => r.userId)).toEqual(["u2", "u1"]);
    expect(res).toMatchObject({ range: "7d", from: "2026-10-27", to: "2026-11-02" });
  });

  it("响应里的 self 只含本人行（别人的模型/连接名不进 self）", () => {
    const res = summarizeTeamUsage(
      [row({ actorId: "u2", date: "2026-11-02", model: "别人的模型", connections: ["别人的连接"] })],
      { viewerId: "u1", range: "7d", from: "2026-10-27", to: "2026-11-02", names: NAMES },
    );
    expect(res.self.total).toBe(0);
    expect(res.self.byModel).toEqual([]);
    expect(JSON.stringify(res.self)).not.toContain("别人的");
  });
});
