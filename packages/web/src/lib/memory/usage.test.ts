import { describe, it, expect } from "vitest";
import {
  COLD_MIN_INJECTED,
  USAGE_BOOST_MAX,
  USAGE_KEY,
  USAGE_LEDGER_MAX,
  UsageLedger,
  isColdUsage,
  usageBoost,
} from "./usage.js";
import type { EntryUsage } from "./usage.js";
import type { RecallRun } from "./recallLog.js";
import type { StorageLike } from "./types.js";

class FakeStorage implements StorageLike {
  readonly map = new Map<string, string>();
  getItem(key: string): string | null {
    const v = this.map.get(key);
    return v === undefined ? null : v;
  }
  setItem(key: string, value: string): void {
    this.map.set(key, value);
  }
  removeItem(key: string): void {
    this.map.delete(key);
  }
}

const NOW = Date.UTC(2026, 10, 1, 8);
const ledgerOf = (storage = new FakeStorage()) => new UsageLedger(storage, () => NOW);

/** 一档召回档案：只需注入清单与引用清单，其余字段给够类型即可。 */
function runOf(
  injected: { id: string; layer: "semantic" | "episodic" | "working"; content?: string }[],
  used: string[] = [],
): RecallRun {
  return {
    id: "rr-1",
    at: new Date(NOW).toISOString(),
    agentId: "a1",
    conversationId: "c1",
    query: "端口要改吗",
    recalled: { semantic: injected.length, episodic: 0, working: 0 },
    injected: injected.map((item) => ({
      id: item.id,
      layer: item.layer,
      content: item.content ?? "内容",
      truncated: false,
    })),
    dropped: [],
    used,
  };
}

describe("usageBoost：确定性提权因子", () => {
  it("没有用量 = 不偏不倚（×1）", () => {
    expect(usageBoost(undefined)).toBe(1);
    expect(usageBoost({ injected: 9, used: 0, lastAt: "" })).toBe(1);
  });

  it("因子可手算：1 + 上限 × used/(used+平滑)", () => {
    const hand = (used: number) =>
      Math.round((1 + USAGE_BOOST_MAX * (used / (used + 3))) * 1e4) / 1e4;
    for (const used of [1, 2, 3, 7, 50]) {
      expect(usageBoost({ injected: used, used, lastAt: "" })).toBe(hand(used));
    }
  });

  it("单调递增且永远封顶在 1+25%：引用再多也不会变成热门通吃", () => {
    let prev = 1;
    for (const used of [1, 2, 5, 20, 100, 5_000, 1_000_000]) {
      const factor = usageBoost({ injected: used, used, lastAt: "" });
      expect(factor).toBeGreaterThan(prev);
      expect(factor).toBeLessThanOrEqual(1 + USAGE_BOOST_MAX);
      prev = factor;
    }
    expect(usageBoost({ injected: 1e9, used: 1e9, lastAt: "" })).toBeLessThanOrEqual(1.25);
  });
});

describe("isColdUsage：冷记忆线索（不是删除指令）", () => {
  it("注入够多次且一次都没被疑似引用才算冷", () => {
    expect(isColdUsage({ injected: COLD_MIN_INJECTED, used: 0, lastAt: "" })).toBe(true);
  });
  it("样本不足 / 被引用过 / 没有计数 → 都不是冷", () => {
    expect(isColdUsage({ injected: COLD_MIN_INJECTED - 1, used: 0, lastAt: "" })).toBe(false);
    expect(isColdUsage({ injected: 500, used: 1, lastAt: "" })).toBe(false);
    expect(isColdUsage(undefined)).toBe(false);
  });
});

describe("UsageLedger：按档累加计数", () => {
  it("一档里注入过记一次、被引用再记一次", () => {
    const ledger = ledgerOf();
    ledger.apply(runOf([{ id: "s1", layer: "semantic" }, { id: "s2", layer: "semantic" }], ["s1"]));
    expect(ledger.get("s1")).toEqual({ injected: 1, used: 1, lastAt: new Date(NOW).toISOString() });
    expect(ledger.get("s2")).toEqual({ injected: 1, used: 0, lastAt: new Date(NOW).toISOString() });
  });

  it("同档同 id 重复出现只计一次（一轮注入不该把计数翻倍）", () => {
    const ledger = ledgerOf();
    ledger.apply(
      runOf([
        { id: "s1", layer: "semantic" },
        { id: "s1", layer: "semantic" },
      ], ["s1"]),
    );
    expect(ledger.get("s1")).toMatchObject({ injected: 1, used: 1 });
  });

  it("工作层与 focus 聚合行不进账本：那是刚才说的话，复述是必然的", () => {
    const ledger = ledgerOf();
    ledger.apply(
      runOf([{ id: "focus", layer: "working" }, { id: "w1", layer: "working" }], ["focus", "w1"]),
    );
    expect(ledger.snapshot()).toEqual({});
  });

  it("used 里出现本档没注入的 id 被忽略（引用只能落在注入过的条目上）", () => {
    const ledger = ledgerOf();
    ledger.apply(runOf([{ id: "s1", layer: "semantic" }], ["ghost"]));
    expect(ledger.get("ghost")).toBeUndefined();
    expect(ledger.get("s1")).toMatchObject({ injected: 1, used: 0 });
  });

  it("累加跨档有效：三次注入两次引用 → used/injected 各自对上", () => {
    const storage = new FakeStorage();
    const ledger = ledgerOf(storage);
    for (let i = 0; i < 3; i++) ledger.apply(runOf([{ id: "s1", layer: "semantic" }], i < 2 ? ["s1"] : []));
    expect(ledger.get("s1")).toMatchObject({ injected: 3, used: 2 });
    // 换一个实例（模拟刷新页面）读同一份存储：数字必须还在
    expect(new UsageLedger(storage, () => NOW).get("s1")).toMatchObject({ injected: 3, used: 2 });
  });

  it("boostOf 与 usageBoost 同一口径，未记过的条目返回 ×1", () => {
    const ledger = ledgerOf();
    expect(ledger.boostOf("s9")).toBe(1);
    ledger.apply(runOf([{ id: "s1", layer: "semantic" }], ["s1"]));
    expect(ledger.boostOf("s1")).toBe(usageBoost(ledger.get("s1")));
  });

  it("坏数据回退空表而不是抛错；脏字段被夹住（used 不超过 injected）", () => {
    const storage = new FakeStorage();
    storage.setItem(USAGE_KEY, "{这不是 JSON");
    expect(ledgerOf(storage).snapshot()).toEqual({});

    storage.setItem(
      USAGE_KEY,
      JSON.stringify({
        s1: { injected: 2, used: 9, lastAt: "x" }, // used > injected
        s2: { injected: -3, used: -1 }, // 负数
        s3: "不是对象",
        s4: {}, // 全零
        s5: { injected: 4, used: 1, lastAt: "2026-10-01T00:00:00.000Z" },
      }),
    );
    const ledger = ledgerOf(storage);
    expect(ledger.get("s1")).toMatchObject({ injected: 2, used: 2 });
    expect(ledger.get("s2")).toBeUndefined();
    expect(ledger.get("s3")).toBeUndefined();
    expect(ledger.get("s4")).toBeUndefined();
    expect(ledger.get("s5")).toMatchObject({ injected: 4, used: 1 });
  });

  it("满容量按最后一次计入淘汰最旧的，不无限增长", () => {
    const storage = new FakeStorage();
    const ledger = ledgerOf(storage);
    const seeds: Record<string, EntryUsage> = {};
    for (let i = 0; i < USAGE_LEDGER_MAX + 20; i++) {
      seeds[`id-${i}`] = {
        injected: 1,
        used: 0,
        lastAt: new Date(NOW - (USAGE_LEDGER_MAX + 20 - i) * 1000).toISOString(),
      };
    }
    storage.setItem(USAGE_KEY, JSON.stringify(seeds));
    ledger.apply(runOf([{ id: "fresh", layer: "semantic" }]));
    const snapshot = ledger.snapshot();
    expect(Object.keys(snapshot)).toHaveLength(USAGE_LEDGER_MAX);
    expect(snapshot["fresh"]).toBeDefined(); // 最新计入的那条一定留得住
    expect(snapshot["id-0"]).toBeUndefined(); // 最旧先丢
  });

  it("条目删除后计数同步清掉（不留孤儿 id）", () => {
    const storage = new FakeStorage();
    const ledger = ledgerOf(storage);
    ledger.apply(runOf([{ id: "s1", layer: "semantic" }, { id: "s2", layer: "semantic" }]));
    ledger.forget(["s1", "不存在"]);
    expect(ledger.get("s1")).toBeUndefined();
    expect(ledger.get("s2")).toBeDefined();
    expect(JSON.parse(storage.getItem(USAGE_KEY) as string)).not.toHaveProperty("s1");
  });

  it("clear 清键并让内存缓存一起失效", () => {
    const storage = new FakeStorage();
    const ledger = ledgerOf(storage);
    ledger.apply(runOf([{ id: "s1", layer: "semantic" }], ["s1"]));
    ledger.clear();
    expect(ledger.get("s1")).toBeUndefined();
    expect(storage.getItem(USAGE_KEY)).toBeNull();
  });

  it("null 档（本轮没记上日志）不动账本", () => {
    const ledger = ledgerOf();
    ledger.apply(null);
    expect(ledger.snapshot()).toEqual({});
  });
});
