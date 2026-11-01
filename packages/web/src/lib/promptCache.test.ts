/**
 * 前缀缓存断点规划的测试（d.49）。
 *
 * 三条不变量各有一组用例，其中「幂等」那条是变异护栏：去掉「先剥旧标记」必须立刻红。
 */
import { describe, it, expect } from "vitest";
import {
  CACHE_TTL,
  MAX_CACHE_BREAKPOINTS,
  countCacheMarkers,
  planCache,
  stripCacheMarkers,
} from "./promptCache.js";
import type { AnthropicMessage, AnthropicTool, TextBlock, ToolResultBlock } from "./llmAnthropic.js";

const sys = (n = 1): TextBlock[] =>
  Array.from({ length: n }, (_, i) => ({ type: "text", text: `s${i}` }));
const tool = (n: number): AnthropicTool[] =>
  Array.from({ length: n }, (_, i) => ({ name: `t${i}`, description: "", input_schema: {} }));
const resultMsgs = (n: number): { messages: AnthropicMessage[]; ends: { index: number; blockIndex: number }[] } => {
  const messages: AnthropicMessage[] = [];
  const ends: { index: number; blockIndex: number }[] = [];
  for (let i = 0; i < n; i++) {
    const block: ToolResultBlock = { type: "tool_result", tool_use_id: `c${i}`, content: "r" };
    messages.push({ role: "user", content: [block] });
    ends.push({ index: messages.length - 1, blockIndex: 0 });
  }
  return { messages, ends };
};

describe("常量", () => {
  it("断点上限是供应商硬上限 4，TTL 用缺省 5m", () => {
    expect(MAX_CACHE_BREAKPOINTS).toBe(4);
    expect(CACHE_TTL).toBe("5m");
  });
});

describe("planCache", () => {
  it("布局：system 末块 → 最后一个工具 → 最近两个事务末尾", () => {
    const systemBlocks = sys(2);
    const tools = tool(2);
    const { messages, ends } = resultMsgs(3);
    const used = planCache({ systemBlocks, messages, tools, transactionEnds: ends });
    expect(used).toBe(4);
    expect(systemBlocks[1].cache_control).toEqual({ type: "ephemeral", ttl: "5m" });
    expect(systemBlocks[0].cache_control).toBeUndefined();
    expect(tools[1].cache_control).toEqual({ type: "ephemeral", ttl: "5m" });
    expect(tools[0].cache_control).toBeUndefined();
    // 只留最近两个（index 2、1），最早那个不缓存：它后面的一切都会变
    expect(messages[2].content[0].cache_control).toBeDefined();
    expect(messages[1].content[0].cache_control).toBeDefined();
    expect(messages[0].content[0].cache_control).toBeUndefined();
  });

  it("没有工具时额度顺延给事务末尾", () => {
    const systemBlocks = sys(1);
    const { messages, ends } = resultMsgs(3);
    const used = planCache({ systemBlocks, messages, tools: [], transactionEnds: ends });
    expect(used).toBe(4);
    expect(messages.map((m) => (m.content[0] as ToolResultBlock).cache_control !== undefined)).toEqual([
      true,
      true,
      true,
    ]);
  });

  it("没有 system（纯对话）时也不越界", () => {
    const tools = tool(1);
    const { messages, ends } = resultMsgs(5);
    const used = planCache({ systemBlocks: [], messages, tools, transactionEnds: ends });
    expect(used).toBeLessThanOrEqual(MAX_CACHE_BREAKPOINTS);
    expect(countCacheMarkers({ systemBlocks: [], messages, tools })).toBe(4);
  });

  it("护栏（幂等）：同一份数据规划两次与规划一次等价，绝不累积成第 5 个", () => {
    const systemBlocks = sys(1);
    const tools = tool(1);
    const { messages, ends } = resultMsgs(4);
    const first = planCache({ systemBlocks, messages, tools, transactionEnds: ends });
    const snapshot = JSON.parse(JSON.stringify({ systemBlocks, messages, tools }));
    const second = planCache({ systemBlocks, messages, tools, transactionEnds: ends });
    expect(second).toBe(first);
    expect(countCacheMarkers({ systemBlocks, messages, tools })).toBe(first);
    // 两次的落点完全相同：前缀一旦漂了，缓存读取费就打水漂
    expect(JSON.parse(JSON.stringify({ systemBlocks, messages, tools }))).toEqual(snapshot);
  });

  it("不变量 1：任何组合下标记总数都 ≤ 4", () => {
    const systemBlocks = sys(3);
    const tools = tool(3);
    const { messages, ends } = resultMsgs(9);
    planCache({ systemBlocks, messages, tools, transactionEnds: ends });
    expect(countCacheMarkers({ systemBlocks, messages, tools })).toBeLessThanOrEqual(
      MAX_CACHE_BREAKPOINTS,
    );
  });

  it("不变量 3：只认传进来的已完成事务，本轮开着的不在其列", () => {
    const systemBlocks = sys(1);
    const { messages, ends } = resultMsgs(1);
    // 追加一条「还开着」的 assistant 文本块，但不作为事务末尾传入
    messages.push({ role: "assistant", content: [{ type: "text", text: "我这就去查" }] });
    planCache({ systemBlocks, messages, tools: [], transactionEnds: ends });
    const last = messages[messages.length - 1].content[0] as TextBlock;
    expect(last.cache_control).toBeUndefined();
  });

  it("事务下标越界时跳过而不是抛（上游合并消息后下标可能失效）", () => {
    const systemBlocks = sys(1);
    const { messages, ends } = resultMsgs(1);
    const used = planCache({
      systemBlocks,
      messages,
      tools: [],
      transactionEnds: [...ends, { index: 99, blockIndex: 0 }],
    });
    expect(used).toBe(2);
  });

  it("ttl 可覆盖（1h 档由调用方显式指定）", () => {
    const systemBlocks = sys(1);
    planCache({ systemBlocks, messages: [], tools: [], transactionEnds: [], ttl: "1h" });
    expect(systemBlocks[0].cache_control).toEqual({ type: "ephemeral", ttl: "1h" });
  });

  it("护栏（剥旧标记）：同一份对象换一批事务再规划，上一轮的标记必须消失", () => {
    const systemBlocks = sys(1);
    const tools = tool(1);
    const { messages, ends } = resultMsgs(4);
    planCache({ systemBlocks, messages, tools, transactionEnds: ends });
    // 窗口收窄：只剩最早两个事务（模拟上下文裁剪后重规划）
    planCache({ systemBlocks, messages, tools, transactionEnds: ends.slice(0, 2) });
    expect(countCacheMarkers({ systemBlocks, messages, tools })).toBe(4);
    expect(messages[3].content[0].cache_control).toBeUndefined();
    expect(messages[2].content[0].cache_control).toBeUndefined();
    expect(messages[1].content[0].cache_control).toBeDefined();
    expect(messages[0].content[0].cache_control).toBeDefined();
  });

  it("空输入返回 0 个断点", () => {
    expect(planCache({ systemBlocks: [], messages: [], tools: [], transactionEnds: [] })).toBe(0);
  });
});

describe("stripCacheMarkers", () => {
  it("递归剥净数组与对象里的 cache_control", () => {
    const node = {
      system: [{ type: "text", text: "a", cache_control: { type: "ephemeral" } }],
      nested: { list: [{ cache_control: { type: "ephemeral" }, x: 1 }] },
    };
    stripCacheMarkers(node);
    expect(countCacheMarkers(node)).toBe(0);
    expect(node.nested.list[0].x).toBe(1); // 只剥标记，别的字段不动
  });

  it("对 null/字符串/数字安全", () => {
    expect(() => stripCacheMarkers(null)).not.toThrow();
    expect(stripCacheMarkers("x" as unknown as object)).toBe("x");
    expect(countCacheMarkers(undefined)).toBe(0);
  });
});
