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
