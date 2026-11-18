/**
 * 子代理（d.331）的骨架测试。
 *
 * 这里钉的是**程序侧的红线**，不是提示词：
 * - 名单外的工具（`file_write` / `run_command`）一律不执行，回一条明确的「没有执行」；
 * - 轮次到了上限就收口，不会把终端拖住；
 * - 结论与工具结果都有长度上限（它该给结论，不该把搜到的原文全搬回来）。
 *
 * 全部用注入的 chat，一个请求都不发。
 */

import { mkdtempSync, rmSync } from "node:fs";
import os from "node:os";
import path from "node:path";
import { afterAll, describe, expect, it, vi } from "vitest";
import {
  SUBAGENT_MAX_ROUNDS_DEFAULT,
  SUBAGENT_MAX_ROUNDS_LIMIT,
  SUBAGENT_READ_ONLY_TOOLS,
  SUBAGENT_RESULT_MAX,
  SUBAGENT_TASK_MAX_CHARS,
  SUBAGENT_TOOL,
  createSubagentRunner,
  parseSubagentArgs,
  subagentResultText,
  subagentSpec,
} from "./subagent.js";
import { createCliTooling } from "./tooling.js";

import type { ChatMessage, StreamChatOpts, ToolCall } from "../../../packages/web/src/lib/llmClient.js";
import type { LlmProfile } from "../../../packages/web/src/store/llm.js";

const PROFILE: LlmProfile = {
  id: "test",
  label: "测试",
  provider: "openai",
  baseUrl: "http://127.0.0.1:1",
  apiKey: "sk-test",
  model: "test-model",
  temperature: 0,
};

const TMP: string[] = [];

function tmpDir(): string {
  const dir = mkdtempSync(path.join(os.tmpdir(), "heming-cli-subagent-"));
  TMP.push(dir);
  return dir;
}

afterAll(() => {
  for (const dir of TMP) rmSync(dir, { recursive: true, force: true });
});

/** 一轮脚本化回答：文本 + 这一轮要调的工具。 */
interface Turn {
  text: string;
  calls?: { name: string; arguments?: string }[];
}

/** 造一个按顺序作答的 chat，并记录每轮收到的消息（方便断言回灌了什么）。 */
function scriptedChat(turns: Turn[]) {
  const seen: ChatMessage[][] = [];
  let index = 0;
  const chat = async (
    _profile: LlmProfile,
    messages: ChatMessage[],
    opts: StreamChatOpts,
  ): Promise<string> => {
    seen.push(messages.map((message) => ({ ...message })));
    const turn = turns[index] ?? { text: "（没词了）" };
    index += 1;
    for (const char of turn.text) opts.onDelta?.(char);
    if (turn.calls && turn.calls.length > 0) {
      const calls: ToolCall[] = turn.calls.map((call, i) => ({
        id: `c${index}-${i}`,
        type: "function" as const,
        function: { name: call.name, arguments: call.arguments ?? "{}" },
      }));
      opts.onToolCalls?.(calls);
    }
    return turn.text;
  };
  return { chat, seen, turns: () => index };
}

describe("parseSubagentArgs", () => {
  it("只给 task：一个任务，默认轮次", () => {
    const parsed = parseSubagentArgs(JSON.stringify({ task: "找出限流在哪" }));
    expect(parsed.ok).toBe(true);
    if (!parsed.ok) return;
    expect(parsed.args.tasks).toEqual(["找出限流在哪"]);
    expect(parsed.args.maxRounds).toBe(SUBAGENT_MAX_ROUNDS_DEFAULT);
  });

  it("tasks 数组：与 task 合并、去重、最多 3 条", () => {
    const parsed = parseSubagentArgs(
      JSON.stringify({ task: "a", tasks: ["a", "b", "c", "d", " "] }),
    );
    expect(parsed.ok).toBe(true);
    if (!parsed.ok) return;
    expect(parsed.args.tasks).toEqual(["a", "b", "c"]);
  });

  it("单条任务太长就截断（任务描述不该是一篇文章）", () => {
    const parsed = parseSubagentArgs(JSON.stringify({ task: "x".repeat(5000) }));
    expect(parsed.ok).toBe(true);
    if (!parsed.ok) return;
    expect(parsed.args.tasks[0]!.length).toBe(SUBAGENT_TASK_MAX_CHARS);
  });

  it("max_rounds 越界夹到 1–6，小数取整", () => {
    const high = parseSubagentArgs(JSON.stringify({ task: "a", max_rounds: 99 }));
    const low = parseSubagentArgs(JSON.stringify({ task: "a", max_rounds: 0 }));
    const frac = parseSubagentArgs(JSON.stringify({ task: "a", max_rounds: 2.7 }));
    expect(high.ok && high.args.maxRounds).toBe(SUBAGENT_MAX_ROUNDS_LIMIT);
    expect(low.ok && low.args.maxRounds).toBe(1);
    expect(frac.ok && frac.args.maxRounds).toBe(2);
  });

  it("坏 JSON / 空参数 / 没有任务：明确报错，不静默降级", () => {
    expect(parseSubagentArgs("{不是 JSON").ok).toBe(false);
    expect(parseSubagentArgs("").ok).toBe(false);
    expect(parseSubagentArgs(JSON.stringify({ tasks: [] })).ok).toBe(false);
    const empty = parseSubagentArgs(undefined);
    expect(empty.ok).toBe(false);
    if (!empty.ok) expect(empty.error).toContain("agent_task 缺少参数");
  });
});

describe("subagentSpec", () => {
  it("声明 task / tasks / max_rounds，且不声明必填（模型可以只给 task）", () => {
    const spec = subagentSpec() as {
      function: { name: string; parameters: { properties: Record<string, unknown>; required?: unknown; additionalProperties: boolean } };
    };
    expect(spec.function.name).toBe(SUBAGENT_TOOL);
    expect(Object.keys(spec.function.parameters.properties).sort()).toEqual([
      "max_rounds",
      "task",
      "tasks",
    ]);
    expect(spec.function.parameters.required).toBeUndefined();
    expect(spec.function.parameters.additionalProperties).toBe(false);
  });
});

describe("createSubagentRunner", () => {
  it("一问就答：1 轮、0 次工具调用", async () => {
    const { chat } = scriptedChat([{ text: "限流在 rate.ts:42。" }]);
    const run = createSubagentRunner({ chat, profile: PROFILE, tools: [], execute: vi.fn() });
    const result = await run("找出限流实现", 4);
    expect(result.rounds).toBe(1);
    expect(result.toolCalls).toBe(0);
    expect(result.text).toBe("限流在 rate.ts:42。");
  });

  it("读一次再答：工具结果回灌给子代理，轮次计 2", async () => {
    const { chat, seen } = scriptedChat([
      { text: "先找找", calls: [{ name: "file_grep", arguments: '{"query":"rateLimit"}' }] },
      { text: "结论：在 rate.ts:42" },
    ]);
    const execute = vi.fn(async () => ({ text: "rate.ts:42: export function rateLimit()", ok: true }));
    const run = createSubagentRunner({ chat, profile: PROFILE, tools: [], execute });
    const result = await run("找出限流实现", 4);
    expect(execute).toHaveBeenCalledWith({ name: "file_grep", arguments: '{"query":"rateLimit"}' });
    expect(result.rounds).toBe(2);
    expect(result.toolCalls).toBe(1);
    expect(result.text).toContain("rate.ts:42");
    // 第二轮发出去的 messages 里必须有那条 role=tool 的结果（否则模型无从下结论）。
    const second = seen[1]!;
    const toolMessage = second.find((message) => message.role === "tool");
    expect(toolMessage?.content).toContain("rate.ts:42");
  });

  it("名单外的工具不执行：回「只能调用只读工具」，并继续把结论要出来", async () => {
    const { chat } = scriptedChat([
      {
        text: "我改一下",
        calls: [
          { name: "file_write", arguments: '{"path":"a.txt","content":"x"}' },
          { name: "run_command", arguments: '{"command":"rm -rf /"}' },
        ],
      },
      { text: "不让改就算了，结论：这里没有限流。" },
    ]);
    const execute = vi.fn(async () => ({ text: "不该跑到这里", ok: true }));
    const run = createSubagentRunner({ chat, profile: PROFILE, tools: [], execute });
    const result = await run("看看有没有限流", 4);
    expect(execute).not.toHaveBeenCalled();
    expect(result.toolCalls).toBe(0);
    expect(result.text).toContain("没有限流");
  });

  it("到了轮次上限就收口，并说明「还没收口」", async () => {
    const { chat, turns } = scriptedChat([
      { text: "r1", calls: [{ name: "file_read", arguments: '{"path":"a"}' }] },
      { text: "r2", calls: [{ name: "file_read", arguments: '{"path":"b"}' }] },
      { text: "r3", calls: [{ name: "file_read", arguments: '{"path":"c"}' }] },
      { text: "r4", calls: [{ name: "file_read", arguments: '{"path":"d"}' }] },
      { text: "r5" },
    ]);
    const execute = vi.fn(async () => ({ text: "内容", ok: true }));
    const run = createSubagentRunner({ chat, profile: PROFILE, tools: [], execute });
    const result = await run("一直读", 3);
    expect(turns()).toBe(3);
    expect(result.rounds).toBe(3);
    expect(result.text).toContain("轮上限");
  });

  it("工具执行抛错：变成一条可读的 tool 消息，不让整次运行炸掉", async () => {
    const { chat, seen } = scriptedChat([
      { text: "读一下", calls: [{ name: "file_read", arguments: '{"path":"a"}' }] },
      { text: "结论：读不了" },
    ]);
    const execute = vi.fn(async () => {
      throw new Error("磁盘炸了");
    });
    const run = createSubagentRunner({ chat, profile: PROFILE, tools: [], execute });
    const result = await run("读 a", 4);
    expect(result.text).toContain("读不了");
    const toolMessage = seen[1]!.find((message) => message.role === "tool");
    expect(toolMessage?.content).toContain("工具调用出错");
    expect(toolMessage?.content).toContain("磁盘炸了");
  });

  it("工具结果太长就截断（不把原文全搬回主对话）", async () => {
    const { chat, seen } = scriptedChat([
      { text: "读一下", calls: [{ name: "file_read", arguments: '{"path":"big"}' }] },
      { text: "结论" },
    ]);
    const execute = vi.fn(async () => ({ text: "x".repeat(9000), ok: true }));
    const run = createSubagentRunner({ chat, profile: PROFILE, tools: [], execute });
    await run("读大文件", 4);
    const toolMessage = seen[1]!.find((message) => message.role === "tool")!;
    expect(toolMessage.content.length).toBeLessThan(4200);
    expect(toolMessage.content).toContain("后面还有");
  });

  it("结论太长也截断到 4000 字上限", async () => {
    const { chat } = scriptedChat([{ text: "y".repeat(SUBAGENT_RESULT_MAX + 500) }]);
    const run = createSubagentRunner({ chat, profile: PROFILE, tools: [], execute: vi.fn() });
    const result = await run("说一大堆", 4);
    expect(result.text.length).toBeLessThan(SUBAGENT_RESULT_MAX + 200);
    expect(result.text).toContain("后面还有");
  });

  it("把中断信号传下去：取消后不再继续", async () => {
    const controller = new AbortController();
    const seenSignals: AbortSignal[] = [];
    const chat = async (_p: LlmProfile, _m: ChatMessage[], opts: StreamChatOpts) => {
      seenSignals.push(opts.signal);
      opts.onDelta?.("半截");
      return "半截";
    };
    const run = createSubagentRunner({ chat, profile: PROFILE, tools: [], execute: vi.fn() });
    controller.abort();
    await run("随便", 4, controller.signal);
    expect(seenSignals[0]).toBe(controller.signal);
  });
});

describe("subagentResultText", () => {
  it("单任务：一行头 + 结论", () => {
    const text = subagentResultText([{ text: "在 a.ts:1", rounds: 2, toolCalls: 3 }], ["查一下"]);
    expect(text).toContain("子代理（只读，2 轮 / 3 次工具调用）结论：");
    expect(text).toContain("在 a.ts:1");
  });

  it("多任务：逐个点名任务与它的轮次", () => {
    const text = subagentResultText(
      [
        { text: "结论一", rounds: 1, toolCalls: 0 },
        { text: "结论二", rounds: 3, toolCalls: 5 },
      ],
      ["查一", "查二"],
    );
    expect(text).toContain("【任务 1】查一");
    expect(text).toContain("【任务 2】查二");
    expect(text).toContain("结论二");
  });

  it("子代理什么都没说：明确写「没有给出结论」而不是留空", () => {
    const text = subagentResultText([{ text: "", rounds: 1, toolCalls: 0 }], ["查一下"]);
    expect(text).toContain("没有给出结论");
  });
});

describe("工具桥里的子代理", () => {
  const namesOf = (tools: readonly unknown[]): string[] =>
    tools
      .map((tool) => {
        const fn = (tool as { function?: { name?: unknown } }).function;
        return typeof fn?.name === "string" ? fn.name : "";
      })
      .filter(Boolean);

  it("给了 chat 就挂 agent_task，风险标成 read（只读模式也能用）", () => {
    const dir = tmpDir();
    const { chat } = scriptedChat([{ text: "好" }]);
    const tooling = createCliTooling({
      cwd: dir,
      allowDanger: false,
      conversationId: "t1",
      subagent: { chat, profile: PROFILE },
    });
    expect(namesOf(tooling.toolBridge.tools)).toContain(SUBAGENT_TOOL);
    expect(tooling.toolBridge.meta?.(SUBAGENT_TOOL)?.risk).toBe("read");
  });

  it("没给 chat 就不挂；硬调回「这次运行没有开子代理」", async () => {
    const dir = tmpDir();
    const tooling = createCliTooling({ cwd: dir, allowDanger: false, conversationId: "t2" });
    expect(namesOf(tooling.toolBridge.tools)).not.toContain(SUBAGENT_TOOL);
    const result = await tooling.toolBridge.execute({ name: SUBAGENT_TOOL, arguments: '{"task":"x"}' });
    expect(result.ok).toBe(false);
    expect(result.text).toContain("没有开子代理");
  });

  it("子代理的写调用在真实桥上也不落盘", async () => {
    const dir = tmpDir();
    // 子代理被要求「先写一个文件再回答」：写不在名单里，必须被挡在名单这一层。
    const { chat } = scriptedChat([
      { text: "先写", calls: [{ name: "file_write", arguments: '{"path":"evil.txt","content":"x"}' }] },
      { text: "结论：没写" },
    ]);
    const tooling = createCliTooling({
      cwd: dir,
      allowDanger: false,
      conversationId: "t3",
      subagent: { chat, profile: PROFILE },
    });
    const result = await tooling.toolBridge.execute({
      name: SUBAGENT_TOOL,
      arguments: JSON.stringify({ task: "写个文件" }),
    });
    expect(result.ok).toBe(true);
    expect(result.text).toContain("结论：没写");
    const { existsSync } = await import("node:fs");
    expect(existsSync(path.join(dir, "evil.txt"))).toBe(false);
  });

  it("子代理的读调用走的是真实桥：能读到工作区里的文件", async () => {
    const dir = tmpDir();
    const { writeFileSync } = await import("node:fs");
    writeFileSync(path.join(dir, "notes.md"), "限流在 rate.ts:42", "utf8");
    let sawContent = "";
    const scripted = scriptedChat([
      { text: "读", calls: [{ name: "file_read", arguments: '{"path":"notes.md"}' }] },
      { text: "结论：rate.ts:42" },
    ]);
    const chat = async (p: LlmProfile, messages: ChatMessage[], opts: StreamChatOpts) => {
      const toolMessage = messages.find((message) => message.role === "tool");
      if (toolMessage) sawContent = toolMessage.content;
      return scripted.chat(p, messages, opts);
    };
    const tooling = createCliTooling({
      cwd: dir,
      allowDanger: false,
      conversationId: "t4",
      subagent: { chat, profile: PROFILE },
    });
    const result = await tooling.toolBridge.execute({
      name: SUBAGENT_TOOL,
      arguments: JSON.stringify({ task: "找限流" }),
    });
    expect(result.ok).toBe(true);
    expect(sawContent).toContain("rate.ts:42");
    expect(SUBAGENT_READ_ONLY_TOOLS).toContain("file_read");
  });
});