import { describe, expect, it } from "vitest";
import { createMemoryStorage } from "../memory/storage.js";
import type { StorageLike } from "../memory/types.js";
import { MAX_ITEMS_PER_STREAM, createRolloutLog } from "./log.js";

const fixedNow = () => "2026-11-02T00:00:00.000Z";

function makeLog(overrides: { maxItems?: number; maxTextChars?: number; maxStreams?: number } = {}) {
  const storage = createMemoryStorage();
  return { storage, log: createRolloutLog({ storage, now: fixedNow, ...overrides }) };
}

describe("rollout 记录器", () => {
  it("按顺序追加并读回，时间戳由记录器统一打", () => {
    const { log } = makeLog();
    expect(log.append({ type: "turn_start", conversationId: "c1", streamId: "s1", agentId: "a1", userText: "你好" })).toBe(true);
    log.append({ type: "tool_call", streamId: "s1", id: "t1", name: "srv__x", args: "{}" });
    log.append({ type: "tool_result", streamId: "s1", id: "t1", name: "srv__x", ok: true, text: "结果" });
    log.append({ type: "assistant_final", streamId: "s1", text: "答案" });
    log.append({ type: "turn_end", streamId: "s1", status: "ok" });

    const items = log.read("s1");
    expect(items.map((i) => i.type)).toEqual([
      "turn_start",
      "tool_call",
      "tool_result",
      "assistant_final",
      "turn_end",
    ]);
    expect(items.every((i) => i.at === fixedNow())).toBe(true);
  });

  it("单条文本按上限截断（日志不是消息存储，不把配额吃满）", () => {
    const { log } = makeLog({ maxTextChars: 10 });
    log.append({ type: "tool_result", streamId: "s1", id: "t1", name: "x", ok: true, text: "字".repeat(500) });
    const text = log.read("s1")[0];
    expect(text?.type).toBe("tool_result");
    expect(String((text as { text: string }).text).length).toBeLessThanOrEqual(11);
  });

  it("单回合条目数有上限，超出丢最旧的（保留最近的现场）", () => {
    const { log } = makeLog({ maxItems: 3 });
    for (let i = 0; i < 5; i++) {
      log.append({ type: "tool_call", streamId: "s1", id: `t${i}`, name: "srv__x", args: "{}" });
    }
    const items = log.read("s1");
    expect(items).toHaveLength(Math.min(3, MAX_ITEMS_PER_STREAM));
    expect((items[2] as { id: string }).id).toBe("t4");
  });

  it("list() 给出摘要：条数、最后时间、终态", () => {
    const { log } = makeLog();
    log.append({ type: "turn_start", conversationId: "c1", streamId: "s1", agentId: "a1", userText: "hi" });
    log.append({ type: "turn_end", streamId: "s1", status: "aborted" });

    const list = log.list();
    expect(list).toHaveLength(1);
    expect(list[0]).toMatchObject({ streamId: "s1", items: 2, status: "aborted" });
  });

  it("clear(streamId) 只清那一个回合；clear() 连索引一起清", () => {
    const { log } = makeLog();
    log.append({ type: "turn_start", conversationId: "c1", streamId: "s1", agentId: "a1", userText: "a" });
    log.append({ type: "turn_start", conversationId: "c1", streamId: "s2", agentId: "a1", userText: "b" });

    log.clear("s1");
    expect(log.read("s1")).toEqual([]);
    expect(log.read("s2")).toHaveLength(1);

    log.clear();
    expect(log.read("s2")).toEqual([]);
    expect(log.list()).toEqual([]);
  });

  it("存储里是坏数据时读回空数组，不抛", () => {
    const storage = createMemoryStorage();
    storage.setItem("heming.rollout.v1.s1", "{ 不是 json");
    const log = createRolloutLog({ storage, now: fixedNow });
    expect(log.read("s1")).toEqual([]);
  });

  it("存储写失败时 append 返回 false（记录失败绝不影响对话）", () => {
    const broken: StorageLike = {
      getItem: () => null,
      setItem: () => {
        throw new Error("quota");
      },
      removeItem: () => undefined,
    };
    const log = createRolloutLog({ storage: broken, now: fixedNow });
    expect(log.append({ type: "turn_start", conversationId: "c1", streamId: "s1", agentId: "a1", userText: "x" })).toBe(false);
  });
});

describe("rollout v2：seq 与版本兼容", () => {
  it("追加时由记录器分配单调递增的 seq（调用方不必传）", () => {
    const { log } = makeLog();
    log.append({ type: "turn_start", conversationId: "c1", streamId: "s1", agentId: "a1", userText: "hi" });
    log.append({ type: "tool_call", streamId: "s1", id: "t1", name: "x", args: "{}" });
    log.append({ type: "tool_result", streamId: "s1", id: "t1", name: "x", ok: true, text: "r" });
    log.append({ type: "turn_end", streamId: "s1", status: "ok" });
    expect(log.read("s1").map((it) => it.seq)).toEqual([0, 1, 2, 3]);
  });

  it("写入的是 v2：版本号进存储，读取端据此判断可分叉", () => {
    const { log, storage } = makeLog();
    log.append({ type: "turn_start", conversationId: "c1", streamId: "s1", agentId: "a1", userText: "hi" });
    const stored = JSON.parse(storage.getItem("heming.rollout.v1.s1") ?? "{}") as { version?: number };
    expect(stored.version).toBe(2);
    expect(log.readStream("s1")).toMatchObject({ version: 2, count: 1 });
  });

  it("v1 日志可读不可分叉：缺 seq 用数组下标补齐，版本仍是 1", () => {
    const storage = createMemoryStorage();
    storage.setItem(
      "heming.rollout.v1.s1",
      JSON.stringify({
        version: 1,
        items: [
          { type: "turn_start", at: fixedNow(), conversationId: "c1", streamId: "s1", agentId: "a1", userText: "hi" },
          { type: "tool_call", at: fixedNow(), streamId: "s1", id: "t1", name: "x", args: "{}" },
          { type: "tool_result", at: fixedNow(), streamId: "s1", id: "t1", name: "x", ok: true, text: "r" },
        ],
      }),
    );
    const log = createRolloutLog({ storage, now: fixedNow });
    const view = log.readStream("s1");
    expect(view.version).toBe(1);
    expect(view.items.map((it) => it.seq)).toEqual([0, 1, 2]);
    expect(log.read("s1").map((it) => it.type)).toEqual(["turn_start", "tool_call", "tool_result"]);
  });

  it("未知的未来版本：只报数与时间，不猜结构", () => {
    const storage = createMemoryStorage();
    storage.setItem(
      "heming.rollout.v1.s9",
      JSON.stringify({
        version: 9,
        items: [{ type: "future_event", at: fixedNow(), streamId: "s9", whatever: true }],
      }),
    );
    storage.setItem(
      "heming.rollout.index.v1",
      JSON.stringify({ version: 9, streamIds: ["s9"] }),
    );
    const log = createRolloutLog({ storage, now: fixedNow });
    const view = log.readStream("s9");
    expect(view).toMatchObject({ version: 9, items: [], count: 1, lastAt: fixedNow() });
    expect(log.list()[0]).toMatchObject({ streamId: "s9", version: 9, items: 1 });
  });

  it("不覆盖看不懂的版本：写未来版本的日志一律拒绝（返回 false）", () => {
    const storage = createMemoryStorage();
    storage.setItem("heming.rollout.v1.s9", JSON.stringify({ version: 9, items: [{ type: "x" }] }));
    const log = createRolloutLog({ storage, now: fixedNow });
    expect(log.append({ type: "turn_start", conversationId: "c1", streamId: "s9", agentId: "a1", userText: "x" })).toBe(false);
    expect(storage.getItem("heming.rollout.v1.s9")).toContain('"version":9');
  });

  it("turn_start 的 forkedFrom 原样往返（分叉来源要能长期读回）", () => {
    const { log } = makeLog();
    log.append({
      type: "turn_start",
      conversationId: "c1",
      streamId: "s2",
      agentId: "a1",
      userText: "继续",
      forkedFrom: { streamId: "s1", seq: 4 },
    });
    const first = log.read("s2")[0];
    expect(first).toMatchObject({ type: "turn_start", forkedFrom: { streamId: "s1", seq: 4 } });
  });

  it("坏 seq 不影响整段读取：合法条目照常回放，序号被强制成递增", () => {
    const storage = createMemoryStorage();
    storage.setItem(
      "heming.rollout.v1.s1",
      JSON.stringify({
        version: 2,
        items: [
          { type: "tool_call", seq: 5, at: fixedNow(), streamId: "s1", id: "t1", name: "x", args: "{}" },
          { type: "tool_result", seq: 5, at: fixedNow(), streamId: "s1", id: "t1", name: "x", ok: true, text: "r" },
          { type: "garbage" },
        ],
      }),
    );
    const log = createRolloutLog({ storage, now: fixedNow });
    expect(log.read("s1").map((it) => it.seq)).toEqual([5, 6]);
  });

  it("截断仍按上限进行（seq 不占用文本额度，条数上限不变）", () => {
    const { log } = makeLog({ maxItems: 2 });
    for (let i = 0; i < 4; i += 1) {
      log.append({ type: "tool_call", streamId: "s1", id: `t${i}`, name: "x", args: "{}" });
    }
    expect(log.read("s1").map((it) => it.seq)).toEqual([2, 3]);
  });
});
