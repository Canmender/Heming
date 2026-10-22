import { describe, it, expect } from "vitest";
import { RecallRecorder } from "./runRecorder.js";
import { RecallLog } from "./recallLog.js";
import type { MemoryObservability } from "./format.js";
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

function trace(overrides: Partial<MemoryObservability> = {}): MemoryObservability {
  return {
    injected: [{ id: "s1", layer: "semantic", content: "部署端口：默认 8787", truncated: false }],
    dropped: [{ id: "s2", layer: "semantic", reason: "budget" }],
    scores: { s1: 0.8765 },
    superseded: [{ key: "称呼", loserId: "s9", winnerId: "s1" }],
    counts: { semantic: 2, episodic: 0, working: 0 },
    ...overrides,
  };
}

const MIN = 60_000;

/** 走一步看一步的时钟：用完最后一个值就停住，方便精确控制过期判定。 */
function clampClock(times: number[]): () => number {
  let i = 0;
  return () => times[Math.min(i++, times.length - 1)];
}

function make(now: () => number): { recorder: RecallRecorder; log: RecallLog; storage: FakeStorage } {
  const storage = new FakeStorage();
  const log = new RecallLog(storage, now);
  return { recorder: new RecallRecorder(log, now), log, storage };
}

describe("RecallRecorder：把注入旁路接到轮次收尾", () => {
  it("零注入不留档，收尾返回 null 且不写日志", () => {
    const { recorder, log } = make(clampClock([Date.now()]));
    recorder.capture("a1", "c1", "你好", trace({ injected: [] }));
    recorder.capture("a1", "c1", "你好", undefined);
    expect(recorder.pendingCount).toBe(0);
    expect(recorder.settle({ agentId: "a1", conversationId: "c1", userText: "你好", assistantText: "你好" })).toBeNull();
    expect(log.list()).toEqual([]);
  });

  it("收尾写档：分数从旁路带上，疑似引用由回答判定", () => {
    const base = Date.UTC(2026, 10, 1, 8);
    const { recorder, log } = make(clampClock([base, base + MIN]));
    recorder.capture("a1", "c1", "端口要改吗", trace());
    const run = recorder.settle({
      agentId: "a1",
      conversationId: "c1",
      userText: "端口要改吗",
      assistantText: "端口保持 8787 即可",
    });
    expect(run).not.toBeNull();
    expect(run!.recalled).toEqual({ semantic: 2, episodic: 0, working: 0 });
    expect(run!.injected).toEqual([
      { id: "s1", layer: "semantic", score: 0.8765, content: "部署端口：默认 8787", truncated: false },
    ]);
    expect(run!.dropped).toEqual([{ id: "s2", layer: "semantic", reason: "budget" }]);
    expect(run!.used).toEqual(["s1"]);
    expect(log.list().map((r) => r.id)).toEqual([run!.id]);
  });

  it("同一档只消费一次；重试会按新的注入重新登记", () => {
    const base = Date.UTC(2026, 10, 1, 8);
    const { recorder, log } = make(clampClock([base, base + MIN, base + 2 * MIN]));
    recorder.capture("a1", "c1", "端口", trace());
    expect(recorder.settle({ agentId: "a1", conversationId: "c1", userText: "端口", assistantText: "8787" })).not.toBeNull();
    expect(recorder.settle({ agentId: "a1", conversationId: "c1", userText: "端口", assistantText: "8787" })).toBeNull();
    recorder.capture("a1", "c1", "端口", trace({ scores: { s1: 0.5 } }));
    const again = recorder.settle({ agentId: "a1", conversationId: "c1", userText: "端口", assistantText: "8787" });
    expect(again).not.toBeNull();
    expect(again!.injected[0].score).toBe(0.5);
    expect(log.list()).toHaveLength(2);
  });

  it("键含 agentId 与用户原话：不同智能体/不同问话不会互相串档", () => {
    const base = Date.UTC(2026, 10, 1, 8);
    const { recorder } = make(clampClock([base, base + MIN, base + 2 * MIN]));
    recorder.capture("a1", "c1", "同一个问题", trace());
    expect(recorder.settle({ agentId: "a2", conversationId: "c1", userText: "同一个问题", assistantText: "8787" })).toBeNull();
    expect(recorder.settle({ agentId: "a1", conversationId: "c1", userText: "别的问题", assistantText: "8787" })).toBeNull();
    expect(recorder.pendingCount).toBe(1);
    expect(recorder.settle({ agentId: "a1", conversationId: "c1", userText: "同一个问题", assistantText: "8787" })).not.toBeNull();
  });

  it("超过容量只丢最旧的孤儿档，当前档一定保留", () => {
    const base = Date.UTC(2026, 10, 1, 8);
    // 慢速时钟（每次调用只走 200ms）：容量截断与过期清理是两条独立路径，这里只验前者
    let n = 0;
    const { recorder } = make(() => base + n++ * 200);
    for (let i = 0; i < 30; i++) recorder.capture("a1", "c1", `问题 ${i}`, trace());
    expect(recorder.pendingCount).toBe(24);
    // 最旧的 6 档（问题 0~5）被挤掉，最新档必须还在
    expect(recorder.settle({ agentId: "a1", conversationId: "c1", userText: "问题 5", assistantText: "8787" })).toBeNull();
    expect(
      recorder.settle({ agentId: "a1", conversationId: "c1", userText: "问题 29", assistantText: "8787" }),
    ).not.toBeNull();
  });

  it("超过 10 分钟的孤儿档在下次登记时被清掉", () => {
    const base = Date.UTC(2026, 10, 1, 8);
    const { recorder } = make(clampClock([base, base + 11 * 60_000, base + 12 * 60_000]));
    recorder.capture("a1", "c1", "旧问题", trace()); // 时刻 base
    recorder.capture("a1", "c1", "新问题", trace()); // 时刻 base+11min → 先清孤儿
    expect(recorder.pendingCount).toBe(1);
    expect(recorder.settle({ agentId: "a1", conversationId: "c1", userText: "旧问题", assistantText: "8787" })).toBeNull();
  });

  it("落盘失败不抛错：settle 返回 null，聊天主链路照常", () => {
    const base = Date.UTC(2026, 10, 1, 8);
    const boom: StorageLike = {
      getItem: () => null,
      setItem: () => {
        throw new Error("配额已满");
      },
      removeItem: () => {},
    };
    const recorder = new RecallRecorder(new RecallLog(boom, () => base), () => base);
    recorder.capture("a1", "c1", "端口", trace());
    expect(recorder.settle({ agentId: "a1", conversationId: "c1", userText: "端口", assistantText: "8787" })).toBeNull();
  });
});
