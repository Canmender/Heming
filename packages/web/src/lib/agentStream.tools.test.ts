import { describe, expect, it, vi } from "vitest";
import {
  HEARTBEAT_MS,
  MAX_TOOL_ROUNDS,
  MAX_VISIBLE_TOOLS,
  TOOL_SEARCH_LIMIT,
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

type Round = { text: string; calls: { id: string; name: string; args?: string }[]; finish?: string };

function makeDeps(rounds: Round[], opts: {
  execute: (call: { name: string; arguments: string }, o?: { signal?: AbortSignal }) => Promise<{
    text: string;
    ok: boolean;
    images?: { mimeType: string; data: string }[];
  }>;
  risk?: (name: string) => "read" | "write" | "danger";
  rollout?: (item: { type: string; [k: string]: unknown }) => void;
  /** 工具目录（名字列表）；缺省只有一个 `srv__x`。 */
  toolNames?: string[];
  /** 覆盖档案（解码图片需要 vision 能力的模型）。 */
  profile?: LlmProfile;
  /** 心跳钩子（等工具/等审批期间定期回调）。 */
  onHeartbeat?: (streamId: string) => void;
}) {
  let index = 0;
  const requests: ChatMessage[][] = [];
  /** 每轮请求携带的 tools 声明（发现模式靠它断言）。 */
  const toolOptions: unknown[][] = [];
  const streamChat = vi.fn(async (_p: unknown, messages: ChatMessage[], o: {
    onDelta: (t: string) => void;
    onToolCalls?: (c: unknown[]) => void;
    onFinish?: (reason: string) => void;
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
    if (round.finish) o.onFinish?.(round.finish);
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
      getProfile: () => opts.profile ?? profile,
      getPrompt: () => "sys",
      fetchHistory: async () => [],
      streamChat: streamChat as never,
      send,
      onLocalDelta: vi.fn(),
      onRollout: opts.rollout,
      onHeartbeat: opts.onHeartbeat,
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
      // 一轮两个调用：单条结果已被截到 8000 字符上限，两条加起来才压得动回合预算。
      { text: "", calls: [{ id: "1", name: "srv__x" }, { id: "2", name: "srv__x" }] },
      { text: "不该跑到这一轮", calls: [] },
    ];
    const { deps, streamChat } = makeDeps(rounds, {
      risk: () => "read",
      // 每条 13000 个汉字（≈13000 token）→ 截到 8000；两条 16000 > 12000 的回合预算
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

  it("分叉回合：turn_start 带上 forkedFrom（从哪个回合哪一条之后来的）", async () => {
    const items: { type: string; [k: string]: unknown }[] = [];
    const { deps } = makeDeps([{ text: "答案", calls: [] }], {
      execute: async () => ({ text: "ok", ok: true }),
      rollout: (item) => items.push(item),
    });
    (deps as unknown as { forkedFrom?: { streamId: string; seq: number } }).forkedFrom = {
      streamId: "src",
      seq: 4,
    };

    await runAgentMentions("c1", [{ agentId: "a1", name: "X" }], "继续", deps);

    expect(items[0]).toMatchObject({
      type: "turn_start",
      forkedFrom: { streamId: "src", seq: 4 },
    });
    // 普通回合不带这个字段（不是分叉就别留来源）
    expect(items[0]).not.toHaveProperty("forkedFrom", undefined);
  });

  it("分叉前缀接在真实历史之后、本轮 user 之前（压缩只动前面的历史）", async () => {
    const prefix: ChatMessage[] = [
      {
        role: "assistant",
        content: "",
        tool_calls: [
          { id: "t1", type: "function", function: { name: "srv__read", arguments: '{"path":"a.md"}' } },
        ],
      },
      { role: "tool", content: "a.md 内容", tool_call_id: "t1", name: "srv__read" },
    ];
    const { deps, requests } = makeDeps([{ text: "答案", calls: [] }], {
      execute: async () => ({ text: "ok", ok: true }),
    });
    let preparedInput: ChatMessage[] = [];
    const withFork = deps as unknown as {
      forkPrefix?: ChatMessage[];
      prepareHistory?: (rows: ChatMessage[]) => Promise<ChatMessage[]>;
    };
    withFork.forkPrefix = prefix;
    withFork.prepareHistory = async (rows) => {
      preparedInput = rows;
      return rows;
    };

    await runAgentMentions("c1", [{ agentId: "a1", name: "X" }], "换个做法", deps);

    // 前缀出现在 prepareHistory 的输入末尾（置后，才不会被早期对话压缩吃掉）
    expect(preparedInput.slice(-2)).toEqual(prefix);
    // 请求顺序：system → 历史 → 重建前缀 → 本轮 user
    expect(requests[0]!.slice(-3)).toEqual([...prefix, { role: "user", content: "换个做法" }]);
  });
});

describe("重复调用提醒（原地打转的模型）", () => {
  function toolTexts(rows: ChatMessage[]): string[] {
    return rows
      .filter((row) => row.role === "tool")
      .map((row) => String(row.content ?? ""));
  }

  it("同名同参数第二次调用照常执行，但在结果前提醒它和第几次一样", async () => {
    const executed: string[] = [];
    const rounds: Round[] = [
      { text: "", calls: [{ id: "a1", name: "srv__read", args: '{"path":"a.md"}' }] },
      { text: "", calls: [{ id: "a2", name: "srv__read", args: '{"path":"a.md"}' }] },
      { text: "看完了", calls: [] },
    ];
    const { deps, requests } = makeDeps(rounds, {
      risk: () => "read",
      execute: async (call) => {
        executed.push(call.name);
        return { text: "a.md 内容", ok: true };
      },
    });

    await runAgentMentions("c1", [{ agentId: "a1", name: "X" }], "读一下 a.md", deps);

    // 仍然真的执行两次（截图/文件这类工具，同参数也可能想看最新状态）
    expect(executed).toEqual(["srv__read", "srv__read"]);
    const texts = toolTexts(requests.at(-1) ?? []);
    expect(texts[0]).toBe("a.md 内容");
    expect(texts[1]).toContain("与本轮第 1 次完全相同");
    expect(texts[1]).toContain("a.md 内容");
  });

  it("参数不同的调用不会被误判成重复", async () => {
    const rounds: Round[] = [
      { text: "", calls: [{ id: "b1", name: "srv__read", args: '{"path":"a.md"}' }] },
      { text: "", calls: [{ id: "b2", name: "srv__read", args: '{"path":"b.md"}' }] },
      { text: "好", calls: [] },
    ];
    const { deps, requests } = makeDeps(rounds, {
      risk: () => "read",
      execute: async () => ({ text: "内容", ok: true }),
    });

    await runAgentMentions("c1", [{ agentId: "a1", name: "X" }], "读两篇", deps);

    const texts = toolTexts(requests.at(-1) ?? []);
    expect(texts.every((item) => !item.includes("完全相同"))).toBe(true);
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

  it("首轮可见工具按用户原话排序：排在目录第 24 位的笔记工具也能第一轮就看见", async () => {
    const names = Array.from({ length: 24 }, (_, i) => `srv__t${String(i).padStart(2, "0")}`);
    names.push("notes__查笔记");
    const { deps, toolOptions } = makeDeps([{ text: "答案", calls: [] }], {
      toolNames: names,
      execute: async () => ({ text: "ok", ok: true }),
    });

    await runAgentMentions("c1", [{ agentId: "a1", name: "X" }], "帮我查笔记", deps);

    const firstNames = (toolOptions[0] ?? []).map(
      (t) => (t as { function: { name: string } }).function.name,
    );
    // 目录第 25 个（索引 24）的工具因为命中「笔记」被提到可见集合里
    expect(firstNames).toContain("notes__查笔记");
    expect(firstNames).toContain(TOOL_SEARCH_NAME);
    // 名额仍然有上限（不是把全量 schema 塞回去）
    expect(firstNames).toHaveLength(MAX_VISIBLE_TOOLS + 1);
  });

  it("用户原话不命中任何工具时按目录顺序取，行为与以前一致", async () => {
    const { deps, toolOptions } = makeDeps([{ text: "答案", calls: [] }], {
      toolNames: manyNames,
      execute: async () => ({ text: "ok", ok: true }),
    });

    await runAgentMentions("c1", [{ agentId: "a1", name: "X" }], "hi", deps);

    const firstNames = (toolOptions[0] ?? []).map(
      (t) => (t as { function: { name: string } }).function.name,
    );
    expect(firstNames).toEqual([TOOL_SEARCH_NAME, ...manyNames.slice(0, MAX_VISIBLE_TOOLS)]);
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

describe("上下文超限重试不重放工具（溢出重试的副作用防护）", () => {
  it("同一 call.id 的写操作在重试后只执行一次", async () => {
    const toolCall = () => ({
      id: "c1",
      type: "function",
      function: { name: "srv__write", arguments: "{}" },
    });
    let attempt = 0;
    const streamChat = vi.fn(
      async (
        _p: unknown,
        _messages: ChatMessage[],
        o: { onDelta: (t: string) => void; onToolCalls?: (c: unknown[]) => void },
      ) => {
        attempt += 1;
        if (attempt === 1) {
          o.onToolCalls?.([toolCall()]);
          return "";
        }
        if (attempt === 2) throw new Error("400 maximum context length exceeded");
        if (attempt === 3) {
          // 重试时模型重复给出同一个调用（同 id）：必须命中缓存，不能再落地一次。
          o.onToolCalls?.([toolCall()]);
          return "";
        }
        o.onDelta("完成");
        return "完成";
      },
    );
    const execute = vi.fn(async () => ({ text: "已写入", ok: true }));
    const send = vi.fn();
    const deps = {
      getProfile: () => profile,
      getPrompt: () => "sys",
      fetchHistory: async () => [] as ChatMessage[],
      prepareHistory: async (history: ChatMessage[]) => history,
      streamChat,
      send,
      onLocalDelta: vi.fn(),
      getTools: () => ({
        tools: [{ type: "function", function: { name: "srv__write", description: "写" } }],
        meta: () => ({ risk: "write" as const }),
        execute,
      }),
    };

    await runAgentMentions("c1", [{ agentId: "a1", name: "X" }], "hi", deps as never);

    expect(execute).toHaveBeenCalledTimes(1);
    expect(finishText(send)).toContain("完成");
  });
});

describe("输出被长度上限截断（P3-10 finish_reason）", () => {
  it("finish_reason=length 且没有工具调用时，收口文案说明是「截断」", async () => {
    const { deps, send } = makeDeps(
      [{ text: "说到一半", calls: [], finish: "length" }],
      { execute: async () => ({ text: "", ok: true }) },
    );
    await runAgentMentions("c1", [{ agentId: "a1", name: "X" }], "hi", deps as never);
    const text = finishText(send);
    expect(text).toContain("说到一半");
    expect(text).toContain("长度上限截断");
    expect(text).toContain("继续");
    // 文案要真的换行：曾经写成 "\\n\\n"，用户会看到一串反斜杠。
    expect(text).toContain("\n\n（回复被输出长度上限截断");
    expect(text).not.toContain("\\n");
  });
});

describe("图片回灌（MCP 审计 D1）", () => {
  const shot = { id: "1", name: "srv__shot" };
  const rounds: Round[] = [
    { text: "我先截个图", calls: [shot] },
    { text: "按钮在左上角，坐标约 (120, 240)", calls: [] },
  ];
  const png = "iVBORw0KGgoAAAANSUhEUg==";

  it("vision 模型：截图另起一条图片消息投喂，模型真的能看图", async () => {
    const h = makeDeps(rounds, {
      profile: { id: "p2", label: "l", provider: "openai", apiKey: "k", model: "gpt-4o" },
      execute: async () => ({
        text: "已截图（1280x720）",
        ok: true,
        images: [{ mimeType: "image/png", data: png }],
      }),
    });
    await runAgentMentions(
      "c1",
      [{ agentId: "a", name: "A" }],
      "截个图",
      h.deps as never,
    );
    const second = h.requests[1] ?? [];
    // 工具消息保留工具原文；图片另行作为图片消息投喂（不是占位符）
    const toolMsg = second.find((m) => m.role === "tool");
    expect(toolMsg?.content).toContain("已截图");
    expect(toolMsg?.content).not.toContain("不支持读图");
    // 图片本身作为 user 消息的 contentParts 发出
    const imageMsg = second.find((m) => m.role === "user" && (m.contentParts?.length ?? 0) > 0);
    const parts = imageMsg?.contentParts ?? [];
    expect(parts.some((p) => p.type === "image" && p.data === png)).toBe(true);
    expect(parts.some((p) => p.type === "text" && p.text.includes("看图"))).toBe(true);
  });

  it("非 vision 模型：不发图片，只在文本里说明已省略", async () => {
    const h = makeDeps(rounds, {
      profile: { id: "p3", label: "l", provider: "openai", apiKey: "k", model: "deepseek-chat" },
      execute: async () => ({
        text: "已截图",
        ok: true,
        images: [{ mimeType: "image/png", data: png }],
      }),
    });
    await runAgentMentions(
      "c1",
      [{ agentId: "a", name: "A" }],
      "截个图",
      h.deps as never,
    );
    const second = h.requests[1] ?? [];
    const toolMsg = second.find((m) => m.role === "tool");
    expect(toolMsg?.content).toContain("不支持读图");
    expect(second.some((m) => (m.contentParts?.length ?? 0) > 0)).toBe(false);
  });
});

describe("历史压缩缓存（P2-6）", () => {
  it("多轮工具循环只压一次历史，不每轮都调摘要模型", async () => {
    // 三轮工具调用 + 最后一轮回答：历史在 run 内不变，prepareHistory 应只跑一次。
    const rounds: Round[] = [
      { text: "先查一下", calls: [{ id: "c1", name: "srv__x" }] },
      { text: "再看一下", calls: [{ id: "c2", name: "srv__x" }] },
      { text: "快好了", calls: [{ id: "c3", name: "srv__x" }] },
      { text: "答案", calls: [] },
    ];
    const h = makeDeps(rounds, { execute: async () => ({ text: "ok", ok: true }) });
    const prepareHistory = vi.fn(async (rows: ChatMessage[]) => [
      { role: "system" as const, content: "（压缩过的历史摘要）" },
      ...rows,
    ]);
    (h.deps as { prepareHistory?: unknown }).prepareHistory = prepareHistory;

    await runAgentMentions("c1", [{ agentId: "a", name: "A" }], "hi", h.deps as never);

    // 4 次模型调用（3 轮工具 + 最终回答），历史压缩只有 1 次。
    expect(h.requests).toHaveLength(4);
    expect(prepareHistory).toHaveBeenCalledTimes(1);
    // 每一轮都带着同一份压缩历史（缓存命中，不是漏掉）；
    // 摘要段与主提示词合并进同一条 system。
    for (const messages of h.requests) {
      expect(messages.some((m) => String(m.content).includes("（压缩过的历史摘要）"))).toBe(true);
    }
  });
});

describe("心跳：长工具调用不被界面看成卡死", () => {
  it("工具执行挂起期间每 15 秒心跳一次，收口后自动停", async () => {
    vi.useFakeTimers();
    const beat = vi.fn();
    let release!: () => void;
    const toolDone = new Promise<void>((resolve) => {
      release = resolve;
    });
    const rounds: Round[] = [
      { text: "", calls: [{ id: "1", name: "srv__x" }] },
      { text: "好了", calls: [] },
    ];
    const { deps } = makeDeps(rounds, {
      risk: () => "read",
      execute: async () => {
        await toolDone;
        return { text: "结果", ok: true };
      },
      onHeartbeat: beat,
    });
    const run = runAgentMentions("c1", [{ agentId: "a1", name: "X" }], "hi", deps);

    // 工具卡了 46 秒：这期间界面早该判卡死了，心跳必须已经在跳。
    await vi.advanceTimersByTimeAsync(HEARTBEAT_MS * 3 + 100);
    expect(beat.mock.calls.length).toBeGreaterThanOrEqual(3);
    expect(typeof beat.mock.calls[0][0]).toBe("string");

    release();
    await run;

    // 收口之后不能再有心跳（否则界面会一直以为还在跑）。
    const settled = beat.mock.calls.length;
    await vi.advanceTimersByTimeAsync(HEARTBEAT_MS * 2);
    expect(beat.mock.calls.length).toBe(settled);
  });

  it("没接心跳钩子时行为完全不变（不会因为心跳改造引入计时器）", async () => {
    vi.useFakeTimers();
    const rounds: Round[] = [
      { text: "", calls: [{ id: "1", name: "srv__x" }] },
      { text: "好了", calls: [] },
    ];
    const { deps } = makeDeps(rounds, {
      risk: () => "read",
      execute: async () => ({ text: "结果", ok: true }),
    });
    const run = runAgentMentions("c1", [{ agentId: "a1", name: "X" }], "hi", deps);
    await vi.advanceTimersByTimeAsync(HEARTBEAT_MS * 2);
    await run;
    expect(finishText(deps.send)).toContain("好了");
  });

  it("单条工具结果超过上限会被截断，不会跟着每一轮重发", async () => {
    const huge = "log line\n".repeat(4000); // ≈ 3.6 万字符，远超单条上限
    const rounds: Round[] = [
      { text: "", calls: [{ id: "c1", name: "srv__x" }] },
      { text: "好了", calls: [] },
    ];
    const { requests, deps } = makeDeps(rounds, {
      risk: () => "read",
      execute: async () => ({ text: huge, ok: true }),
    });

    await runAgentMentions("c1", [{ agentId: "a1", name: "X" }], "hi", deps);

    // 第二轮请求里带着这条工具结果：必须已经截断，且截断标记对模型可见。
    const toolRow = requests[1].find((row) => row.role === "tool");
    const content = String(toolRow?.content ?? "");
    expect(content.length).toBeLessThan(9000);
    expect(content).toContain("中间省略");
  });
});

  it("反复 tool_search 不会把可见工具无上限地堆进请求", async () => {
    // 每轮 tool_search 都「再解锁」一些工具；以前 visible 是无限增长的 Set，
    // 12 轮下来请求里能挂 100+ 份 schema——正好毁掉「按需发现」想省的那点预算。
    const toolNames = Array.from({ length: 40 }, (_, i) => `srv__t${String(i).padStart(2, "0")}`);
    const rounds: Round[] = [
      ...Array.from({ length: 9 }, (_, i) => ({
        text: "",
        calls: [{ id: `s${i}`, name: TOOL_SEARCH_NAME, args: JSON.stringify({ query: `t${25 + i}` }) }],
      })),
      { text: "收尾", calls: [] },
    ];
    const { deps, toolOptions } = makeDeps(rounds, {
      toolNames,
      execute: async () => ({ text: "ok", ok: true }),
    });

    await runAgentMentions("c1", [{ agentId: "a1", name: "X" }], "hi", deps);

    const sizes = toolOptions.map((tools) => (tools ?? []).length);
    expect(Math.max(...sizes)).toBeLessThanOrEqual(1 + MAX_VISIBLE_TOOLS + TOOL_SEARCH_LIMIT);

    // 最早解锁的会被挤掉，最近解锁的还在（挤掉不等于禁用：真要再用会重新检索到）
    const namesOf = (i: number) =>
      (toolOptions[i] ?? []).map((t) => (t as { function: { name: string } }).function.name);
    const last = namesOf(toolOptions.length - 1);
    expect(last).toContain("srv__t33");
    expect(last).not.toContain("srv__t25");
    // 挤掉之后仍然能再检索回来
    expect(last.length).toBeLessThanOrEqual(1 + MAX_VISIBLE_TOOLS + TOOL_SEARCH_LIMIT);
  });
