import { describe, it, expect } from "vitest";
import { RECALL_LOG_KEY, RECALL_LOG_MAX, RecallLog, buildTouchIndex, type RecallRunInput } from "./recallLog.js";
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

/** 按 offset 造时间戳，让「新旧」在测试里可控（list 应按时间升序）。 */
function input(offsetMs: number, agentId = "agent-1"): RecallRunInput {
  return {
    agentId,
    conversationId: "conv-1",
    query: `第 ${offsetMs} 轮问题`,
    recalled: { semantic: 2, episodic: 1, working: 3 },
    injected: [
      { id: "s1", layer: "semantic", content: "称呼：阿和", truncated: false },
      { id: "e1", layer: "episodic", content: "讨论了发布计划", score: 0.42, truncated: true },
    ],
    dropped: [{ id: "s2", layer: "semantic", reason: "budget" }],
    used: ["s1"],
  };
}

const HOUR = 3_600_000;
const at = (i: number) => new Date(Date.UTC(2026, 9, 20, 0, 0, 0) + i * HOUR).toISOString();

function logAt(times: number[]): { log: RecallLog; storage: FakeStorage } {
  const storage = new FakeStorage();
  let i = 0;
  const log = new RecallLog(storage, () => times[Math.min(i++, times.length - 1)]);
  return { log, storage };
}

describe("RecallLog：环形日志", () => {
  it("空库返回空表；键不存在与损坏数据都回退空表", () => {
    const { log } = logAt([Date.UTC(2026, 9, 20)]);
    expect(log.list()).toEqual([]);
    const storage = new FakeStorage();
    storage.map.set(RECALL_LOG_KEY, "{不是 JSON");
    expect(new RecallLog(storage).list()).toEqual([]);
    storage.map.set(RECALL_LOG_KEY, JSON.stringify([{ 坏: 1 }, null, "x"]));
    expect(new RecallLog(storage).list()).toEqual([]);
  });

  it("写入后能原样读回，字段齐全", () => {
    const base = Date.UTC(2026, 9, 20, 8);
    const { log } = logAt([base]);
    const run = log.record(input(0));
    expect(run).not.toBeNull();
    const list = log.list();
    expect(list).toHaveLength(1);
    expect(list[0]).toMatchObject({
      agentId: "agent-1",
      conversationId: "conv-1",
      query: "第 0 轮问题",
      recalled: { semantic: 2, episodic: 1, working: 3 },
      injected: [
        { id: "s1", layer: "semantic", content: "称呼：阿和", truncated: false },
        { id: "e1", layer: "episodic", content: "讨论了发布计划", score: 0.42, truncated: true },
      ],
      dropped: [{ id: "s2", layer: "semantic", reason: "budget" }],
      used: ["s1"],
    });
    expect(list[0].at).toBe(new Date(base).toISOString());
  });

  it("按时间升序保存，超过环形上限时丢最旧的", () => {
    const base = Date.UTC(2026, 9, 20);
    const times = Array.from({ length: RECALL_LOG_MAX + 5 }, (_, i) => base + i * HOUR);
    const { log } = logAt(times);
    for (let i = 0; i < RECALL_LOG_MAX + 5; i++) log.record(input(i * HOUR));
    const list = log.list();
    expect(list).toHaveLength(RECALL_LOG_MAX);
    // 最旧的前 5 档被挤掉
    expect(list[0].query).toBe(`第 ${5 * HOUR} 轮问题`);
    expect(list[list.length - 1].query).toBe(`第 ${(RECALL_LOG_MAX + 4) * HOUR} 轮问题`);
  });

  it("超字节护栏时拒绝写入并返回 null（旧档保持不动）", () => {
    const base = Date.UTC(2026, 9, 20);
    const { log, storage } = logAt([base, base + HOUR]);
    const keep = log.record(input(0));
    expect(keep).not.toBeNull();
    // 单档就超过 256KB 护栏：query/content 各自有截断，但条目数没有上限，靠字节护栏兜底
    const huge: RecallRunInput = {
      ...input(0),
      injected: Array.from({ length: 4000 }, (_, i) => ({
        id: `s${i}`,
        layer: "semantic" as const,
        content: "内".repeat(120),
        truncated: false,
      })),
    };
    expect(log.record(huge)).toBeNull();
    expect(log.list()).toHaveLength(1);
    expect(storage.map.get(RECALL_LOG_KEY)).toContain(keep!.id);
  });

  it("入参不符契约（injected/dropped 不是数组）直接拒绝，不抛", () => {
    const { log } = logAt([Date.UTC(2026, 9, 20)]);
    expect(log.record(null as unknown as RecallRunInput)).toBeNull();
    expect(
      log.record({ ...input(0), injected: undefined as unknown as RecallRunInput["injected"] }),
    ).toBeNull();
    expect(log.list()).toEqual([]);
  });

  it("clear 清空日志", () => {
    const { log, storage } = logAt([Date.UTC(2026, 9, 20)]);
    log.record(input(0));
    expect(storage.map.has(RECALL_LOG_KEY)).toBe(true);
    log.clear();
    expect(storage.map.has(RECALL_LOG_KEY)).toBe(false);
    expect(log.list()).toEqual([]);
  });

  it("水合时逐条剔除结构不符的档案与字段，而不是整库作废", () => {
    const storage = new FakeStorage();
    storage.map.set(
      RECALL_LOG_KEY,
      JSON.stringify([
        { id: "good", at: at(1), agentId: "a", conversationId: "c", query: "q" },
        { id: 123, at: at(2), agentId: "a", conversationId: "c" }, // id 不是字符串
        {
          id: "partial",
          at: at(0),
          agentId: "a",
          conversationId: "c",
          injected: [
            { id: "s1", layer: "semantic", content: "很长".repeat(200), truncated: true },
            { id: "s2", layer: "未知层", content: "x" },
            "坏项",
          ],
          dropped: [{ id: "s9", layer: "semantic", reason: "乱七八糟" }],
          recalled: { semantic: -3, episodic: "x", working: 2 },
          used: ["s1", 42],
        },
      ]),
    );
    const list = new RecallLog(storage).list();
    expect(list.map((run) => run.id)).toEqual(["good", "partial"]);
    const partial = list[1];
    expect(partial.injected.map((item) => item.id)).toEqual(["s1"]); // 未知层与坏项被丢
    expect(partial.injected[0].content).toHaveLength(120); // 内容按上限截断
    expect(partial.dropped).toEqual([]); // 非法 reason 丢弃
    expect(partial.recalled).toEqual({ semantic: 0, episodic: 0, working: 2 });
    expect(partial.used).toEqual(["s1"]);
    expect(partial.query).toBe(""); // 缺字段回退空串
  });

  it("buildTouchIndex 给出每个 id 最后一次注入/最后一次命中的时间", () => {
    const storage = new FakeStorage();
    const runs = [
      { id: "r3", at: at(3), agentId: "a", conversationId: "c", query: "", recalled: { semantic: 0, episodic: 0, working: 0 }, injected: [{ id: "s2", layer: "semantic" as const, content: "", truncated: false }], dropped: [], used: [] },
      { id: "r2", at: at(2), agentId: "a", conversationId: "c", query: "", recalled: { semantic: 0, episodic: 0, working: 0 }, injected: [{ id: "s1", layer: "semantic" as const, content: "", truncated: false }], dropped: [], used: ["s1"] },
      { id: "r1", at: at(1), agentId: "a", conversationId: "c", query: "", recalled: { semantic: 0, episodic: 0, working: 0 }, injected: [{ id: "s1", layer: "semantic" as const, content: "", truncated: false }, { id: "s2", layer: "semantic" as const, content: "", truncated: false }], dropped: [], used: [] },
    ];
    storage.map.set(RECALL_LOG_KEY, JSON.stringify(runs));
    const index = buildTouchIndex(new RecallLog(storage).list());
    expect(index.get("s1")).toEqual({ injectedAt: at(2), usedAt: at(2) });
    // s2 在更早的 r3 注入过、也在更晚的 r1 注入过 → 取最近一次；从未被引用
    expect(index.get("s2")).toEqual({ injectedAt: at(3), usedAt: "" });
    expect(index.has("没见过的")).toBe(false);
  });
});
