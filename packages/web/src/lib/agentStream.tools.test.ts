import { describe, expect, it, vi } from "vitest";
import {
  MAX_TOOL_ROUNDS,
  MAX_VISIBLE_TOOLS,
  TOOL_SEARCH_NAME,
  runAgentMentions,
} from "./agentStream.js";
import type { ChatMessage } from "./llmClient.js";
import type { LlmProfile } from "../store/llm.js";
import { toHitlCall } from "./hitl/classify.js";

/**
 * 工具执行层的行为契约（G1/G3/G5）。
 *
 * 这些用例只覆盖**调度语义**：谁先谁后、什么时候收口、超预算时折的是什么。
 * 内容正确性（HITL 拒绝、来源脚注）在 `agentStream.test.ts` 里。
 */

const profile: LlmProfile = { id: "p1", label: "l", provider: "openai", apiKey: "k", model: "m" };

type Round = { text: string; calls: { id: string; name: string; args?: string }[] };

function makeDeps(rounds: Round[], opts: {
  execute: (call: { name: string; arguments: string }, o?: { signal?: AbortSignal }) => Promise<{
    text: string;
    ok: boolean;
  }>;
  risk?: (name: string) => "read" | "write" | "danger";
  rollout?: (item: { type: string; [k: string]: unknown }) => void;
  /** 工具目录（名字列表）；缺省只有一个 `srv__x`。 */
  toolNames?: string[];
}) {
  let index = 0;
  const requests: ChatMessage[][] = [];
  /** 每轮请求携带的 tools 声明（发现模式靠它断言）。 */
  const toolOptions: unknown[][] = [];
  const streamChat = vi.fn(async (_p: unknown, messages: ChatMessage[], o: {
    onDelta: (t: string) => void;
    onToolCalls?: (c: unknown[]) => void;
    tools?: unknown[];
  }) => {
    requests.push(messages);
    toolOptions.push(o.tools ?? []);
    const round = rounds[Math.min(index, rounds.length - 1)];
    index += 1;
    if (!round) return "";
    if (round.calls.length) {
      o.onToolCalls?.(
        round.calls.map((c) => ({
          id: c.id,
          type: "function",
          function: { name: c.name, arguments: c.args ?? "{}" },
        })),
      );
    }
    if (round.text) o.onDelta(round.text);
    return round.text;
  });
  const send = vi.fn();
  return {
    send,
    requests,
    toolOptions,
    streamChat,
    deps: {
      getProfile: () => profile,
      getPrompt: () => "sys",
      fetchHistory: async () => [],
      streamChat: streamChat as never,
      send,
      onLocalDelta: vi.fn(),
      onRollout: opts.rollout,
      getTools: () => ({
        tools: (opts.toolNames ?? ["srv__x"]).map((name) => ({
          type: "function",
          function: { name, description: `${name} 的说明` },
        })),
        meta: opts.risk ? (name: string) => ({ risk: opts.risk!(name) }) : undefined,
        execute: opts.execute,
      }),
    },
  };
}

function finishText(send: ReturnType<typeof vi.fn>): string {
  const event = (send.mock.calls as unknown[][])
    .map(([e]) => e as { type: string; text?: string })
    .find((e) => e.type === "agent_finish");
  return event?.text ?? "";
}

describe("工具调度：写串行 / 读并行（G3）", () => {
  it("两个写操作严格串行，且保持模型给出的顺序", async () => {
    const order: string[] = [];
    const rounds: Round[] = [
      {
        text: "我先写两个",
        calls: [
          { id: "1", name: "srv__w1" },
          { id: "2", name: "srv__w2" },
        ],
      },
      { text: "写完了", calls: [] },
    ];
    const { deps } = makeDeps(rounds, {
      risk: () => "write",
      execute: async (call) => {
        order.push(`start:${call.name}`);
        await new Promise((r) => setTimeout(r, 15));
        order.push(`end:${call.name}`);
        return { text: "ok", ok: true };
      },
    });

    await runAgentMentions("c1", [{ agentId: "a1", name: "X" }], "hi", deps);
    expect(order).toEqual(["start:srv__w1", "end:srv__w1", "start:srv__w2", "end:srv__w2"]);
  });

  it("两个只读操作并行（不以「安全」为名把整轮拖慢）", async () => {
    const order: string[] = [];
    const rounds: Round[] = [
      {
        text: "",
        calls: [
          { id: "1", name: "srv__r1" },
          { id: "2", name: "srv__r2" },
        ],
      },
      { text: "答案", calls: [] },
    ];
    const { deps } = makeDeps(rounds, {
      risk: () => "read",
      execute: async (call) => {
        order.push(`start:${call.name}`);
        await new Promise((r) => setTimeout(r, 15));
        order.push(`end:${call.name}`);
        return { text: "ok", ok: true };
      },
    });

    await runAgentMentions("c1", [{ agentId: "a1", name: "X" }], "hi", deps);
    // 并行时两个 start 必然都先于第一个 end 出现
    expect(order.slice(0, 2)).toEqual(["start:srv__r1", "start:srv__r2"]);
  });

  it("认不出风险的工具有 meta 缺失时按 write 处理（与闸门默认口径同源）", async () => {
    const order: string[] = [];
    const rounds: Round[] = [
      { text: "", calls: [{ id: "1", name: "srv__a" }, { id: "2", name: "srv__b" }] },
      { text: "ok", calls: [] },
    ];
    const { deps } = makeDeps(rounds, {
      execute: async (call) => {
        order.push(`start:${call.name}`);
        await new Promise((r) => setTimeout(r, 10));
        order.push(`end:${call.name}`);
        return { text: "ok", ok: true };
      },
    });

    await runAgentMentions("c1", [{ agentId: "a1", name: "X" }], "hi", deps);
    expect(order).toEqual(["start:srv__a", "end:srv__a", "start:srv__b", "end:srv__b"]);
  });
});

describe("轮次与预算收口（G1）", () => {
  it("模型一直要工具时，到上限会**明确告知**，而不是静默停住", async () => {
    const rounds: Round[] = [
      { text: "", calls: [{ id: "1", name: "srv__x" }] },
    ];
    const { deps, streamChat } = makeDeps(rounds, {
      risk: () => "read",
      execute: async () => ({ text: "ok", ok: true }),
    });

    await runAgentMentions("c1", [{ agentId: "a1", name: "X" }], "hi", deps);

    // 12 轮都执行了工具，第 13 次采样被上限拦住 → 共 13 次 streamChat
    expect(streamChat).toHaveBeenCalledTimes(MAX_TOOL_ROUNDS + 1);
    const text = finishText(deps.send);
    expect(text).toContain("达到上限");
    expect(text).toContain("继续");
  });

  it("工具结果超过回灌预算时提前收口，并说明可以继续", async () => {
    const rounds: Round[] = [
      { text: "", calls: [{ id: "1", name: "srv__x" }] },
      { text: "不该跑到这一轮", calls: [] },
    ];
    const { deps, streamChat } = makeDeps(rounds, {
      risk: () => "read",
      // 13000 个汉字 ≈ 13000 token，超过 12000 的回合预算
      execute: async () => ({ text: "字".repeat(13000), ok: true }),
    });

    await runAgentMentions("c1", [{ agentId: "a1", name: "X" }], "hi", deps);

    expect(streamChat).toHaveBeenCalledTimes(1);
    const text = finishText(deps.send);
    expect(text).toContain("预算上限");
    expect(text).toContain("继续");
  });
});

describe("工具结果回灌预算（G5）", () => {
  it("组装下一轮请求时折叠较早的工具结果，但保留条数与最近几条原文", async () => {
    const rounds: Round[] = [
      {
        text: "",
        calls: [
          { id: "1", name: "srv__a" },
          { id: "2", name: "srv__b" },
          { id: "3", name: "srv__c" },
          { id: "4", name: "srv__d" },
        ],
      },
      { text: "答案", calls: [] },
    ];
    const { deps, requests } = makeDeps(rounds, {
      risk: () => "read",
      // 每条 1500 token：4 条共 6000，超过 3000 的工具结果预算
      execute: async () => ({ text: "字".repeat(1500), ok: true }),
    });

    await runAgentMentions("c1", [{ agentId: "a1", name: "X" }], "hi", deps);

    const second = requests[1] ?? [];
    const tools = second.filter((m) => m.role === "tool");
    // 条数恒等于调用数：少一条，供应商直接 400
    expect(tools).toHaveLength(4);
    // 最旧的一条被折叠，最近三条原文保留
    expect(String(tools[0]?.content)).toContain("已折叠");
    for (const i of [1, 2, 3]) {
      expect(String(tools[i]?.content)).not.toContain("已折叠");
    }
  });
});

describe("中断透传（G2）", () => {
  it("中断后，同轮后续工具拿到的信号已经是 aborted", async () => {
    const seen: boolean[] = [];
    let handle: { abortAll: () => void } | undefined;
    const rounds: Round[] = [
      { text: "", calls: [{ id: "1", name: "srv__a" }, { id: "2", name: "srv__b" }] },
      { text: "答案", calls: [] },
    ];
    const { deps } = makeDeps(rounds, {
      risk: () => "write",
      execute: async (call, o) => {
        seen.push(o?.signal?.aborted === true);
        if (call.name === "srv__a") handle?.abortAll();
        return { text: "ok", ok: true };
      },
    });

    const run = runAgentMentions("c1", [{ agentId: "a1", name: "X" }], "hi", deps);
    handle = run;
    await run;

    expect(seen).toEqual([false, true]);
    vi.restoreAllMocks();
  });
});

describe("回合事件日志（G6）", () => {
  it("一回合的工具链路被逐条记下：开始 → 调用 → 结果 → 答案 → 终态", async () => {
    const items: { type: string; [k: string]: unknown }[] = [];
    const rounds: Round[] = [
      { text: "我查一下", calls: [{ id: "t1", name: "srv__x", args: '{"q":1}' }] },
      { text: "查到了", calls: [] },
    ];
    const { deps } = makeDeps(rounds, {
      risk: () => "read",
      execute: async () => ({ text: "结果正文", ok: true }),
      rollout: (item) => items.push(item),
    });

    await runAgentMentions("c1", [{ agentId: "a1", name: "X" }], "问题", deps);

    expect(items.map((i) => i.type)).toEqual([
      "turn_start",
      "tool_call",
      "tool_result",
      "assistant_final",
      "turn_end",
    ]);
    expect(items[1]).toMatchObject({ id: "t1", name: "srv__x" });
    expect(items[2]).toMatchObject({ id: "t1", ok: true, text: "结果正文" });
    expect(items[4]).toMatchObject({ status: "ok" });
  });

  it("被拒的调用记为 denied，不是「执行失败」", async () => {
    const items: { type: string; [k: string]: unknown }[] = [];
    const rounds: Round[] = [
      { text: "", calls: [{ id: "t1", name: "srv__x" }] },
      { text: "好的", calls: [] },
    ];
    const { deps } = makeDeps(rounds, {
      risk: () => "write",
      execute: async () => ({ text: "不该执行", ok: true }),
      rollout: (item) => items.push(item),
    });
    // 闸门全拒：执行路径不该被走到
    (deps as unknown as { confirmToolCalls: unknown }).confirmToolCalls = async (
      calls: { id: string }[],
    ) =>
      calls.map((c) => ({
        kind: "deny" as const,
        call: toHitlCall({ id: c.id, function: { name: "srv__x", arguments: "{}" } }),
        reason: "用户拒绝",
        cause: "user" as const,
      }));

    await runAgentMentions("c1", [{ agentId: "a1", name: "X" }], "hi", deps);

    const result = items.find((i) => i.type === "tool_result");
    expect(result).toMatchObject({ denied: true, ok: false });
    // 被拒也必须有终态，否则日志里这一回合永远「进行中」
    expect(items[items.length - 1]?.type).toBe("turn_end");
  });

  it("日志回调抛错不影响生成与上行", async () => {
    const rounds: Round[] = [{ text: "答案", calls: [] }];
    const { deps, send } = makeDeps(rounds, {
      execute: async () => ({ text: "ok", ok: true }),
      rollout: () => {
        throw new Error("日志炸了");
      },
    });

    await runAgentMentions("c1", [{ agentId: "a1", name: "X" }], "hi", deps);
    expect(finishText(send)).toBe("答案");
  });
});

describe("按需工具发现（tool_search）", () => {
  const manyNames = Array.from({ length: 25 }, (_, i) => `srv__t${String(i).padStart(2, "0")}`);

  it("目录超过阈值：首轮只带一部分 + tool_search，而不是全量 schema", async () => {
    const rounds: Round[] = [{ text: "答案", calls: [] }];
    const { deps, toolOptions } = makeDeps(rounds, {
      toolNames: manyNames,
      execute: async () => ({ text: "ok", ok: true }),
    });

    await runAgentMentions("c1", [{ agentId: "a1", name: "X" }], "hi", deps);

    const first = toolOptions[0] ?? [];
    expect(first).toHaveLength(MAX_VISIBLE_TOOLS + 1);
    const names = first.map((t) => (t as { function: { name: string } }).function.name);
    expect(names).toContain(TOOL_SEARCH_NAME);
    // 被藏起来的工具确实不在首轮声明里
    expect(names).not.toContain(manyNames[manyNames.length - 1]);
  });

  it("检索命中后，该工具在**下一轮**请求里出现并可被调用", async () => {
    const executed: string[] = [];
    const rounds: Round[] = [
      { text: "", calls: [{ id: "s1", name: TOOL_SEARCH_NAME, args: '{"query":"t24"}' }] },
      { text: "", calls: [{ id: "t1", name: "srv__t24" }] },
      { text: "拿到结果", calls: [] },
    ];
    const { deps, toolOptions } = makeDeps(rounds, {
      toolNames: manyNames,
      execute: async (call) => {
        executed.push(call.name);
        return { text: "工具结果", ok: true };
      },
    });

    await runAgentMentions("c1", [{ agentId: "a1", name: "X" }], "hi", deps);

    const secondNames = (toolOptions[1] ?? []).map(
      (t) => (t as { function: { name: string } }).function.name,
    );
    expect(secondNames).toContain("srv__t24");
    // 检索本身不是 MCP 调用：真正执行的只有被搜出来的那个
    expect(executed).toEqual(["srv__t24"]);
    expect(finishText(deps.send)).toBe("拿到结果");
  });

  it("检索是内部只读动作：不问用户确认（确认疲劳会毁掉安全边界）", async () => {
    const asked: string[][] = [];
    const rounds: Round[] = [
      { text: "", calls: [{ id: "s1", name: TOOL_SEARCH_NAME, args: '{"query":"t24"}' }] },
      { text: "", calls: [{ id: "t1", name: "srv__t24" }] },
      { text: "好", calls: [] },
    ];
    const { deps } = makeDeps(rounds, {
      toolNames: manyNames,
      execute: async () => ({ text: "ok", ok: true }),
      rollout: () => undefined,
    });
    (deps as unknown as { confirmToolCalls: unknown }).confirmToolCalls = async (
      calls: { function: { name: string } }[],
    ) => {
      asked.push(calls.map((c) => c.function.name));
      return calls.map((c) => ({
        kind: "allow" as const,
        call: toHitlCall({ id: "x", function: { name: c.function.name, arguments: "{}" } }),
      }));
    };

    await runAgentMentions("c1", [{ agentId: "a1", name: "X" }], "hi", deps);

    // 只有第二轮的真实工具进了闸门；第一轮的 tool_search 没有被问
    expect(asked).toEqual([["srv__t24"]]);
  });

  it("检索无命中时返回可换词的提示，不静默失败", async () => {
    const rounds: Round[] = [
      { text: "", calls: [{ id: "s1", name: TOOL_SEARCH_NAME, args: '{"query":"不存在"}' }] },
      { text: "换个办法", calls: [] },
    ];
    const { deps, requests } = makeDeps(rounds, {
      toolNames: manyNames,
      execute: async () => ({ text: "ok", ok: true }),
    });

    await runAgentMentions("c1", [{ agentId: "a1", name: "X" }], "hi", deps);

    const toolMsg = (requests[1] ?? []).find((m) => m.role === "tool");
    expect(String(toolMsg?.content)).toContain("没有找到");
  });

  it("目录未超阈值：不注入 tool_search（行为与之前逐字等价）", async () => {
    const rounds: Round[] = [{ text: "答案", calls: [] }];
    const { deps, toolOptions } = makeDeps(rounds, {
      toolNames: ["srv__a", "srv__b"],
      execute: async () => ({ text: "ok", ok: true }),
    });

    await runAgentMentions("c1", [{ agentId: "a1", name: "X" }], "hi", deps);

    const names = (toolOptions[0] ?? []).map(
      (t) => (t as { function: { name: string } }).function.name,
    );
    expect(names).toEqual(["srv__a", "srv__b"]);
  });
});
