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

  it("截断按码点算，不把 emoji 代理对劈开（回放面板不出现乱码方块）", () => {
    const { log } = makeLog({ maxTextChars: 10 });
    // 第 10 个码点正好是 emoji，旧实现 slice(0,10) 会切在代理对中间，留下孤立高位代理
    log.append({ type: "tool_result", streamId: "s1", id: "t1", name: "x", ok: true, text: "字".repeat(9) + "😀" + "尾" });
    const item = log.read("s1")[0] as { text: string };
    expect(item.text.endsWith("…")).toBe(true);
    // 码点迭代器下，完整 emoji 是单个 length===2 的字符；孤立代理是 length===1 且落在 D800–DFFF
    const lone = Array.from(item.text).some(
      (ch) => ch.length === 1 && (ch.charCodeAt(0) & 0xfc00) === 0xd800,
    );
    expect(lone).toBe(false);
    expect(item.text).toContain("😀"); // emoji 完整保留
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

  it("写入的是当前版本：版本号进存储，读取端据此判断可分叉", () => {
    const { log, storage } = makeLog();
    log.append({ type: "turn_start", conversationId: "c1", streamId: "s1", agentId: "a1", userText: "hi" });
    const stored = JSON.parse(storage.getItem("heming.rollout.v1.s1") ?? "{}") as { version?: number };
    expect(stored.version).toBe(5);
    expect(log.readStream("s1")).toMatchObject({ version: 5, count: 1 });
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

describe("rollout v3：回合用量与工具耗时（P0-T1）", () => {
  it("turn_end 的 usage 原样往返：拆分、缓存的 0 也要保留", () => {
    const { log } = makeLog();
    log.append({
      type: "turn_end",
      streamId: "s1",
      status: "ok",
      usage: { input: 1200, output: 340, cacheRead: 900, cacheWrite: 0, rounds: 3 },
    });
    const end = log.read("s1")[0];
    expect(end).toMatchObject({
      type: "turn_end",
      usage: { input: 1200, output: 340, cacheRead: 900, cacheWrite: 0, rounds: 3 },
    });
  });

  it("没有 usage 的老回合照旧：不写这个字段，读回也没有", () => {
    const { log } = makeLog();
    log.append({ type: "turn_end", streamId: "s1", status: "ok" });
    const end = log.read("s1")[0]!;
    expect(end.type).toBe("turn_end");
    expect((end as { usage?: unknown }).usage).toBeUndefined();
  });

  it("坏 usage 不拖垮整条记录：rounds 不合法就整块丢掉，回合状态仍在", () => {
    const storage = createMemoryStorage();
    storage.setItem(
      "heming.rollout.v1.s1",
      JSON.stringify({
        version: 3,
        items: [
          { type: "turn_end", seq: 0, at: fixedNow(), streamId: "s1", status: "ok", usage: { rounds: "3" } },
          { type: "turn_end", seq: 1, at: fixedNow(), streamId: "s1", status: "error", usage: { rounds: 0 } },
          { type: "turn_end", seq: 2, at: fixedNow(), streamId: "s1", status: "ok", usage: { rounds: 2, input: -5 } },
        ],
      }),
    );
    const log = createRolloutLog({ storage, now: fixedNow });
    const items = log.read("s1");
    expect(items.every((it) => it.type === "turn_end")).toBe(true);
    expect((items[0] as { usage?: unknown }).usage).toBeUndefined();
    expect((items[1] as { usage?: unknown }).usage).toBeUndefined();
    // 负数不是合法计数：这一项被省略，其余字段保留（宁可少列，不写负值）。
    expect((items[2] as { usage?: unknown }).usage).toEqual({ rounds: 2 });
  });

  it("tool_result 的 ms 往返；负数/NaN 不认", () => {
    const storage = createMemoryStorage();
    storage.setItem(
      "heming.rollout.v1.s1",
      JSON.stringify({
        version: 3,
        items: [
          { type: "tool_result", seq: 0, at: fixedNow(), streamId: "s1", id: "t1", name: "x", ok: true, text: "r", ms: 132 },
          { type: "tool_result", seq: 1, at: fixedNow(), streamId: "s1", id: "t2", name: "x", ok: true, text: "r", ms: -1 },
          { type: "tool_result", seq: 2, at: fixedNow(), streamId: "s1", id: "t3", name: "x", ok: true, text: "r" },
        ],
      }),
    );
    const log = createRolloutLog({ storage, now: fixedNow });
    const items = log.read("s1") as { ms?: number }[];
    expect(items[0].ms).toBe(132);
    expect(items[1].ms).toBeUndefined();
    expect(items[2].ms).toBeUndefined();
  });

  it("v2 老日志不需要迁移：读起来就是没有 usage/ms，别把兼容性写成错误", () => {
    const storage = createMemoryStorage();
    storage.setItem(
      "heming.rollout.v1.s1",
      JSON.stringify({
        version: 2,
        items: [
          { type: "turn_start", seq: 0, at: fixedNow(), conversationId: "c1", streamId: "s1", agentId: "a1", userText: "hi" },
          { type: "tool_result", seq: 1, at: fixedNow(), streamId: "s1", id: "t1", name: "x", ok: true, text: "r" },
          { type: "turn_end", seq: 2, at: fixedNow(), streamId: "s1", status: "ok" },
        ],
      }),
    );
    const log = createRolloutLog({ storage, now: fixedNow });
    const items = log.read("s1");
    expect(items).toHaveLength(3);
    expect((items[1] as { ms?: number }).ms).toBeUndefined();
    expect((items[2] as { usage?: unknown }).usage).toBeUndefined();
    // 旧数据回放后仍能继续追加（升级不要求用户清日志）。
    expect(log.append({ type: "turn_end", streamId: "s1", status: "ok", usage: { rounds: 1 } })).toBe(true);
  });
});

describe("rollout v4：失败归因（P3-T16）", () => {
  it("turn_end.failure 原样往返：六类都认", () => {
    const { log } = makeLog();
    const codes = [
      "context_overflow",
      "tool_error",
      "model_refusal",
      "hitl_denied",
      "max_rounds",
      "provider_error",
    ] as const;
    codes.forEach((failure, i) => {
      log.append({ type: "turn_end", streamId: `s${i}`, status: "ok", failure });
    });
    codes.forEach((failure, i) => {
      expect(log.read(`s${i}`)[0]).toMatchObject({ type: "turn_end", failure });
    });
  });

  it("成功回合不写 failure；中断回合也不写（中断不是失败）", () => {
    const { log } = makeLog();
    log.append({ type: "turn_end", streamId: "s1", status: "ok" });
    log.append({ type: "turn_end", streamId: "s2", status: "aborted" });
    expect((log.read("s1")[0] as { failure?: unknown }).failure).toBeUndefined();
    expect((log.read("s2")[0] as { failure?: unknown }).failure).toBeUndefined();
  });

  it("坏归因码丢掉字段但不丢整条回合（旧版本/手改数据都可能是别的字符串）", () => {
    const storage = createMemoryStorage();
    storage.setItem(
      "heming.rollout.v1.s1",
      JSON.stringify({
        version: 4,
        items: [
          { type: "turn_end", seq: 0, at: fixedNow(), streamId: "s1", status: "error", failure: "boom" },
          { type: "turn_end", seq: 1, at: fixedNow(), streamId: "s1", status: "error", failure: 42 },
        ],
      }),
    );
    const log = createRolloutLog({ storage, now: fixedNow });
    const items = log.read("s1");
    expect(items).toHaveLength(2);
    expect(items.every((it) => (it as { failure?: unknown }).failure === undefined)).toBe(true);
  });

  it("v3 旧日志照常读：没有 failure 就是没记归因，不当成失败", () => {
    const storage = createMemoryStorage();
    storage.setItem(
      "heming.rollout.v1.s1",
      JSON.stringify({
        version: 3,
        items: [
          { type: "turn_end", seq: 0, at: fixedNow(), streamId: "s1", status: "ok", usage: { rounds: 2 } },
        ],
      }),
    );
    const log = createRolloutLog({ storage, now: fixedNow });
    const end = log.read("s1")[0];
    expect(end).toMatchObject({ type: "turn_end", status: "ok" });
    expect((end as { failure?: unknown }).failure).toBeUndefined();
  });
});

describe("rollout v5：完成证据（P3-T15）", () => {
  it("assistant_final.evidence 原样往返：文件、命令、输出摘要", () => {
    const { log } = makeLog();
    log.append({
      type: "assistant_final",
      streamId: "s1",
      text: "已改好",
      evidence: {
        files: ["notes/待办.md"],
        commands: ["file_patch: notes/待办.md"],
        outputDigest: "已写入磁盘：notes/待办.md",
      },
    });
    expect(log.read("s1")[0]).toMatchObject({
      type: "assistant_final",
      evidence: {
        files: ["notes/待办.md"],
        commands: ["file_patch: notes/待办.md"],
        outputDigest: "已写入磁盘：notes/待办.md",
      },
    });
  });

  it("没有证据时整块省略：空数组不等于「查过没副作用」", () => {
    const { log } = makeLog();
    log.append({ type: "assistant_final", streamId: "s1", text: "只是回答" });
    expect((log.read("s1")[0] as { evidence?: unknown }).evidence).toBeUndefined();
  });

  it("坏证据丢掉字段、保住回合：用户仍能看到回答，不会因证据脏而丢整条", () => {
    const storage = createMemoryStorage();
    storage.setItem(
      "heming.rollout.v1.s1",
      JSON.stringify({
        version: 5,
        items: [
          { type: "assistant_final", seq: 0, at: fixedNow(), streamId: "s1", text: "已改好", evidence: "oops" },
          { type: "assistant_final", seq: 1, at: fixedNow(), streamId: "s1", text: "已改好", evidence: { files: [], commands: [] } },
        ],
      }),
    );
    const log = createRolloutLog({ storage, now: fixedNow });
    const items = log.read("s1");
    expect(items).toHaveLength(2);
    expect(items[0]).toMatchObject({ type: "assistant_final", text: "已改好" });
    expect((items[0] as { evidence?: unknown }).evidence).toBeUndefined();
    expect((items[1] as { evidence?: unknown }).evidence).toBeUndefined();
  });

  it("证据条目与文本有上限：手改数据撑不爆存储，也不会让面板渲染超长行", () => {
    const storage = createMemoryStorage();
    storage.setItem(
      "heming.rollout.v1.s1",
      JSON.stringify({
        version: 5,
        items: [
          {
            type: "assistant_final",
            seq: 0,
            at: fixedNow(),
            streamId: "s1",
            text: "已改好",
            evidence: {
              files: Array.from({ length: 40 }, (_, i) => `f${i}.md`),
              commands: ["x".repeat(500)],
              outputDigest: "y".repeat(900),
            },
          },
        ],
      }),
    );
    const log = createRolloutLog({ storage, now: fixedNow });
    const evidence = (log.read("s1")[0] as { evidence: { files: string[]; commands: string[]; outputDigest: string } })
      .evidence;
    expect(evidence.files).toHaveLength(20);
    expect(evidence.commands[0]).toHaveLength(300);
    expect(evidence.outputDigest).toHaveLength(500);
  });

  it("v4 旧日志照常读：没有 evidence 就是没记证据", () => {
    const storage = createMemoryStorage();
    storage.setItem(
      "heming.rollout.v1.s1",
      JSON.stringify({
        version: 4,
        items: [{ type: "assistant_final", seq: 0, at: fixedNow(), streamId: "s1", text: "已改好" }],
      }),
    );
    const log = createRolloutLog({ storage, now: fixedNow });
    expect(log.read("s1")[0]).toMatchObject({ type: "assistant_final", text: "已改好" });
    expect((log.read("s1")[0] as { evidence?: unknown }).evidence).toBeUndefined();
  });
});
