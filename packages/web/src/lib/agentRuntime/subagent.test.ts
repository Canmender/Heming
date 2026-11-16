import { beforeEach, describe, expect, it, vi } from "vitest";
import type { ChatMessage } from "../llmClient.js";
import type { SubagentToolCall } from "./subagent.js";
import {
  SUBAGENT_MAX_ROUNDS_DEFAULT,
  SUBAGENT_MAX_ROUNDS_LIMIT,
  SUBAGENT_READ_ONLY_TOOLS,
  SUBAGENT_TASK_MAX_CHARS,
  SUBAGENT_TOOL,
  clipSubagentResult,
  parseSubagentArgs,
  runSubagent,
  subagentSpec,
  withSubagentTool,
} from "./subagent.js";

/** 从 OpenAI spec 里取函数定义，省得每处都做类型断言。 */
function fnOf(spec: unknown): {
  name: string;
  description: string;
  parameters: {
    required?: string[];
    properties?: Record<string, { maximum?: number; minimum?: number }>;
    additionalProperties?: boolean;
  };
} {
  return (spec as { function: ReturnType<typeof fnOf> }).function;
}

describe("subagentSpec", () => {
  it("工具名是 agent_task，只要求 task 一个必填参数", () => {
    const fn = fnOf(subagentSpec());
    expect(fn.name).toBe(SUBAGENT_TOOL);
    expect(fn.name).toBe("agent_task");
    expect(fn.parameters.required).toEqual(["task"]);
    expect(fn.parameters.additionalProperties).toBe(false);
    expect(fn.parameters.properties?.max_rounds?.maximum).toBe(SUBAGENT_MAX_ROUNDS_LIMIT);
    expect(fn.parameters.properties?.max_rounds?.minimum).toBe(1);
  });

  it("描述里说清「只读」——模型据此才不会指望它写文件", () => {
    const fn = fnOf(subagentSpec());
    expect(fn.description).toContain("只读");
  });
});

describe("parseSubagentArgs", () => {
  it("缺参数时给出可照做的错误文案", () => {
    const result = parseSubagentArgs("");
    expect(result.ok).toBe(false);
    if (result.ok) throw new Error("unreachable");
    expect(result.error).toContain("task");
  });

  it("JSON 坏掉时提示正确形状", () => {
    const result = parseSubagentArgs("{task: 查日志}");
    expect(result.ok).toBe(false);
    if (result.ok) throw new Error("unreachable");
    expect(result.error).toContain("JSON");
  });

  it("参数必须是对象，数组也拒绝", () => {
    expect(parseSubagentArgs("[1,2]").ok).toBe(false);
    expect(parseSubagentArgs('"查一下"').ok).toBe(false);
  });

  it("task 为空或只有空白时拒绝（空任务会让子代理空转）", () => {
    expect(parseSubagentArgs('{"task":"   "}').ok).toBe(false);
    expect(parseSubagentArgs('{"task":123}').ok).toBe(false);
  });

  it("task 过长时拒绝并说明上限（防止主模型把整段上下文倒过来）", () => {
    const result = parseSubagentArgs(JSON.stringify({ task: "x".repeat(SUBAGENT_TASK_MAX_CHARS + 1) }));
    expect(result.ok).toBe(false);
    if (result.ok) throw new Error("unreachable");
    expect(result.error).toContain(String(SUBAGENT_TASK_MAX_CHARS));
  });

  it("max_rounds 缺省用默认值，超上限钳到硬上限", () => {
    const dflt = parseSubagentArgs('{"task":"查 docs"}');
    expect(dflt.ok).toBe(true);
    if (!dflt.ok) throw new Error("unreachable");
    expect(dflt.args.maxRounds).toBe(SUBAGENT_MAX_ROUNDS_DEFAULT);

    const huge = parseSubagentArgs('{"task":"查 docs","max_rounds":99}');
    expect(huge.ok).toBe(true);
    if (!huge.ok) throw new Error("unreachable");
    expect(huge.args.maxRounds).toBe(SUBAGENT_MAX_ROUNDS_LIMIT);
  });

  it("max_rounds 非正整数时报错（0 / 小数 / 字符串都不行）", () => {
    for (const value of [0, -1, 1.5, "4"]) {
      const result = parseSubagentArgs(JSON.stringify({ task: "查", max_rounds: value }));
      expect(result.ok).toBe(false);
    }
  });
});

describe("clipSubagentResult", () => {
  it("短结果原样返回；长结果保头保尾（结论常在末尾）", () => {
    expect(clipSubagentResult("短")).toBe("短");
    const long = `${"头".repeat(3000)}结论在最后`;
    const clipped = clipSubagentResult(long, 1000);
    expect(clipped.length).toBeLessThanOrEqual(1020);
    expect(clipped.startsWith("头")).toBe(true);
    expect(clipped.endsWith("结论在最后")).toBe(true);
    expect(clipped).toContain("省略");
  });
});

describe("runSubagent", () => {
  const readTool = { type: "function", function: { name: "file_read" } };
  const writeTool = { type: "function", function: { name: "file_write" } };

  it("模型直接给结论（没有工具调用）时，一轮就收口", async () => {
    const chat = vi.fn(async () => "答案是 42");
    const execute = vi.fn();
    const result = await runSubagent(
      { task: "查答案", maxRounds: 4 },
      { tools: [readTool, writeTool], execute, chat },
    );
    expect(result).toMatchObject({ ok: true, text: "答案是 42", rounds: 1, toolCalls: 0 });
    expect(execute).not.toHaveBeenCalled();
    // 下发给子代理的只有只读工具：写工具不该出现（否则它可能以为自己能写）
    const sentTools = (chat.mock.calls[0] as unknown[])[1] as Array<{ function: { name: string } }>;
    expect(sentTools.map((tool) => tool.function.name)).toEqual(["file_read"]);
  });

  it("带一次工具调用时执行工具、把结果回灌，再收口", async () => {
    let round = 0;
    const chat = vi.fn(
      async (messages: ChatMessage[], _tools: unknown[], _signal: AbortSignal | undefined, onToolCalls: (calls: SubagentToolCall[]) => void) => {
        round += 1;
        if (round === 1) {
          onToolCalls([{ name: "file_read", arguments: '{"path":"a.md"}' }]);
          return "我先读一下 a.md";
        }
        // 第二轮应该能看到上一轮的工具结果
        const toolMessage = messages.find((m) => m.role === "tool");
        expect(toolMessage?.content).toContain("文件内容");
        return "a.md 里写的是文件内容";
      },
    );
    const execute = vi.fn(async () => ({ text: "文件内容", ok: true }));
    const result = await runSubagent(
      { task: "读 a.md", maxRounds: 4 },
      { tools: [readTool], execute, chat },
    );
    expect(result).toMatchObject({ ok: true, rounds: 2, toolCalls: 1 });
    expect(result.text).toContain("文件内容");
    expect(execute).toHaveBeenCalledWith({ name: "file_read", arguments: '{"path":"a.md"}' }, undefined);
  });

  it("模型凭空调用白名单外的工具（file_write）时拒绝执行，只回一条说明", async () => {
    let round = 0;
    const chat = vi.fn(async (_messages: ChatMessage[], _tools: unknown[], _signal: AbortSignal | undefined, onToolCalls: (calls: SubagentToolCall[]) => void) => {
      round += 1;
      if (round === 1) {
        onToolCalls([{ name: "file_write", arguments: '{"path":"x.md"}' }]);
        return "我写点东西";
      }
      return "算了，只读就好";
    });
    const execute = vi.fn(async () => ({ text: "已写入", ok: true }));
    const result = await runSubagent(
      { task: "写 x.md", maxRounds: 3 },
      { tools: [readTool, writeTool], execute, chat },
    );
    expect(execute).not.toHaveBeenCalled();
    expect(result.toolCalls).toBe(0);
    expect(result.text).toContain("只读");
  });

  it("中断信号已触发时直接返回，不发起请求", async () => {
    const chat = vi.fn(async () => "不该跑");
    const controller = new AbortController();
    controller.abort();
    const result = await runSubagent(
      { task: "查", maxRounds: 3 },
      { tools: [readTool], execute: vi.fn(), chat, signal: controller.signal },
    );
    expect(result.ok).toBe(false);
    expect(result.text).toContain("中断");
    expect(chat).not.toHaveBeenCalled();
  });

  it("跑满轮次预算时如实说可能不完整（不硬编结论）", async () => {
    const chat = vi.fn(async (_messages: ChatMessage[], _tools: unknown[], _signal: AbortSignal | undefined, onToolCalls: (calls: SubagentToolCall[]) => void) => {
      onToolCalls([{ name: "file_glob", arguments: '{"pattern":"**/*.md"}' }]);
      return "继续找";
    });
    const execute = vi.fn(async () => ({ text: "命中 3 个文件", ok: true }));
    const result = await runSubagent(
      { task: "找文件", maxRounds: 2 },
      { tools: [readTool], execute, chat },
    );
    expect(result.rounds).toBe(2);
    expect(result.toolCalls).toBe(2);
    expect(result.text).toContain("预算");
    expect(result.text).toContain("可能不完整");
  });

  it("只读白名单就是文件读/列/搜三件（多一件都算放开写能力）", () => {
    expect([...SUBAGENT_READ_ONLY_TOOLS].sort()).toEqual(["file_glob", "file_grep", "file_read"]);
  });
});

describe("withSubagentTool", () => {
  const baseBridge = {
    tools: [{ type: "function", function: { name: "file_read" } }],
    meta: (name: string) => (name === "file_read" ? { risk: "read" as const, displayName: "读取文件" } : undefined),
    execute: vi.fn(async () => ({ text: "基座结果", ok: true })),
  };

  beforeEach(() => {
    vi.clearAllMocks();
  });

  it("工具清单末尾多出 agent_task，桥自带工具不受影响", () => {
    const wrapped = withSubagentTool(baseBridge, { agentId: "system-assistant", conversationId: "c1" });
    const names = (wrapped.tools as Array<{ function: { name: string } }>).map((tool) => tool.function.name);
    expect(names).toEqual(["file_read", SUBAGENT_TOOL]);
  });

  it("meta：agent_task 报只读 + 中文名，其它工具原样透传", () => {
    const wrapped = withSubagentTool(baseBridge, { agentId: "system-assistant", conversationId: "c1" });
    expect(wrapped.meta?.(SUBAGENT_TOOL)).toEqual({ risk: "read", displayName: "派子代理" });
    expect(wrapped.meta?.("file_read")).toEqual({ risk: "read", displayName: "读取文件" });
    expect(wrapped.meta?.("other")).toBeUndefined();
  });

  it("非 agent_task 的调用原样转给基座桥", async () => {
    const wrapped = withSubagentTool(baseBridge, { agentId: "system-assistant", conversationId: "c1" });
    const result = await wrapped.execute({ name: "file_read", arguments: "{}" });
    expect(result).toEqual({ text: "基座结果", ok: true });
    expect(baseBridge.execute).toHaveBeenCalledTimes(1);
  });

  it("agent_task 参数不合法时直接回错误，不去碰模型绑定", async () => {
    const wrapped = withSubagentTool(baseBridge, { agentId: "system-assistant", conversationId: "c1" });
    const result = await wrapped.execute({ name: SUBAGENT_TOOL, arguments: "{}" });
    expect(result.ok).toBe(false);
    expect(result.text).toContain("task");
    expect(baseBridge.execute).not.toHaveBeenCalled();
  });

  it("没有模型绑定时如实说「派不了」，不给一个空结论", async () => {
    const wrapped = withSubagentTool(baseBridge, {
      agentId: "no-such-agent-bindings",
      conversationId: "c1",
    });
    const result = await wrapped.execute({
      name: SUBAGENT_TOOL,
      arguments: JSON.stringify({ task: "查 docs" }),
    });
    expect(result.ok).toBe(false);
    expect(result.text).toContain("模型绑定");
  });

  it("注入 chat 时跳过模型绑定，直接用注入的子会话（评测用这条路径）", async () => {
    const chat = vi.fn(async (_messages: ChatMessage[], _tools: unknown[], _signal: AbortSignal | undefined, onToolCalls: (calls: SubagentToolCall[]) => void) => {
      // 第一轮要工具，第二轮给结论——一直要工具会跑到 max_rounds 用尽。
      if (chat.mock.calls.length === 1) onToolCalls([{ name: "file_read", arguments: '{"path":"a.md"}' }]);
      return "结论：a.md 是安装说明。";
    });
    const readBridge = {
      ...baseBridge,
      tools: [{ type: "function", function: { name: "file_read" } }],
      execute: vi.fn(async () => ({ text: "（a.md 内容）", ok: true })),
    };
    const wrapped = withSubagentTool(readBridge, {
      agentId: "没有任何绑定的智能体",
      conversationId: "c1",
      chat,
    });
    const result = await wrapped.execute({
      name: SUBAGENT_TOOL,
      arguments: JSON.stringify({ task: "读 a.md", max_rounds: 2 }),
    });
    expect(result.ok).toBe(true);
    expect(result.text).toContain("安装说明");
    expect(chat).toHaveBeenCalledTimes(2);
    expect(readBridge.execute).toHaveBeenCalledTimes(1);
  });
});
