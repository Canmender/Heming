/**
 * 只读子代理（d.162）：`agent_task` 工具。
 *
 * 为什么需要它：
 * 主对话的上下文窗口是稀缺资源。让主模型「先读二十个文件再回答」有两个代价——
 * 每次读到的原文都留在主历史里（之后每轮都要重新付一遍 token，压缩后还会丢），
 * 而且主对话的工具轮次上限（`MAX_TOOL_ROUNDS`）是给整轮任务用的，翻文件的几轮
 * 会挤掉真正干活的轮次。子代理把这些「过程」放到一个独立的短会话里，只把结论
 * 带回主对话——这正是 opencode / DSH 一类应用里 subagent / Task 的作用。
 *
 * 红线（都写死在这里，不交给模型自觉）：
 * - **只读**：子代理只拿 `file_read` / `file_glob` / `file_grep` 三件。写盘、执行命令、
 *   网络、HITL 一律不给——子代理没有副作用，才敢让它自己跑几轮。
 * - **执行时二次校验**：模型可能凭空写出 `file_write`，这里按白名单再拦一次
 *   （光靠「只下发这三件工具」不够：模型可以手写任意名字的 tool call）。
 * - **有界**：`max_rounds` 默认 4、硬上限 6；每次工具结果截断到 4000 字符。
 *   跑满预算时如实说「可能不完整」，而不是硬编一个结论。
 * - **不流式**：子代理的中间输出不进主界面（会污染阅读），只回最终结论。
 */
import type { ToolBridge } from "../agentStream.js";
import type { ChatMessage } from "../llmClient.js";
import { resolveBoundProfile, streamChatRouted } from "../llmRoute.js";

/** 工具名：模型看到的就是这个名字。 */
export const SUBAGENT_TOOL = "agent_task";

/** 子代理默认跑几轮工具往返。 */
export const SUBAGENT_MAX_ROUNDS_DEFAULT = 4;

/** 子代理轮次硬上限：再大就等于把主对话的预算搬进子代理，失控。 */
export const SUBAGENT_MAX_ROUNDS_LIMIT = 6;

/** 子代理可以用的工具：只有只读检索三件。 */
export const SUBAGENT_READ_ONLY_TOOLS: ReadonlySet<string> = new Set([
  "file_read",
  "file_glob",
  "file_grep",
]);

/** 单次工具结果回灌给子代理的最大字符数：截断是防止一个巨型文件打爆子会话。 */
export const SUBAGENT_TOOL_RESULT_MAX = 4000;

/** 任务描述的长度上限：太长说明主模型在把整段上下文倒过来，不如自己读。 */
export const SUBAGENT_TASK_MAX_CHARS = 2000;

/** 子代理的人设：短、只讲边界，不讲业务。 */
const SUBAGENT_SYSTEM_PROMPT = [
  "你是一个只读子代理：你只能读文件、列文件、搜内容，不能写、不能执行命令、不能联网。",
  "你的任务是把「需要翻很多文件才能确认」的事情查清楚，然后用结论回答，不要复述文件原文。",
  "规则：",
  "- 先想清楚要找什么，再用最少的工具调用拿到证据；同一个工具别重复调。",
  "- 结论要能核对：写清依据的文件路径（必要时带行号），拿不到证据就明说「未确认」。",
  "- 只回答交给你的任务，不要扩展到别的主题，也不要问用户问题（没有人会回你）。",
].join("\n");

/** 模型给 `agent_task` 的参数（解析后）。 */
export interface SubagentArgs {
  task: string;
  maxRounds: number;
}

export type SubagentParseResult =
  | { ok: true; args: SubagentArgs }
  | { ok: false; error: string };

/** 子代理内部的一次工具调用（与 `ToolCall` 同形，但不带 id 也允许）。 */
export interface SubagentToolCall {
  id?: string;
  name: string;
  arguments: string;
}

/** 跑子代理需要的外部能力；ChatPage / 评测都可以注入。 */
export interface SubagentDeps {
  /** 主桥的工具清单（子代理会从里面挑只读三件）。 */
  tools: unknown[];
  /** 执行工具（走主桥，参数形状一致）。 */
  execute: (
    call: { name: string; arguments: string },
    opts?: { signal?: AbortSignal },
  ) => Promise<{ text: string; ok: boolean }>;
  /** 一次对话请求；`onToolCalls` 在本轮收尾时回调。 */
  chat: (
    messages: ChatMessage[],
    tools: unknown[],
    signal: AbortSignal | undefined,
    onToolCalls: (calls: SubagentToolCall[]) => void,
  ) => Promise<string>;
  /** 用户中断信号；缺省视为不可中断。 */
  signal?: AbortSignal;
}

/** 子代理的结果：`text` 永远是给主模型看的结论（失败也带原因）。 */
export interface SubagentResult {
  ok: boolean;
  text: string;
  rounds: number;
  toolCalls: number;
}

/** OpenAI function spec。 */
export function subagentSpec(): unknown {
  return {
    type: "function",
    function: {
      name: SUBAGENT_TOOL,
      description:
        "派一个只读子代理去查资料：它只能读文件/列文件/搜内容，会把结论带回来。适合「要翻很多文件才知道答案」的检索，避免把大量原文拉进主对话。",
      parameters: {
        type: "object",
        properties: {
          task: {
            type: "string",
            description: "交给子代理的任务：写清要找什么、要回答什么（一两句话）",
          },
          max_rounds: {
            type: "integer",
            minimum: 1,
            maximum: SUBAGENT_MAX_ROUNDS_LIMIT,
            description: `子代理最多跑几轮工具（默认 ${SUBAGENT_MAX_ROUNDS_DEFAULT}，上限 ${SUBAGENT_MAX_ROUNDS_LIMIT}）`,
          },
        },
        required: ["task"],
        additionalProperties: false,
      },
    },
  };
}

/** 解析 `agent_task` 的参数；错误文案要能让主模型自己改对并重试。 */
export function parseSubagentArgs(raw: string | undefined): SubagentParseResult {
  const text = (raw ?? "").trim();
  if (!text) {
    return {
      ok: false,
      error: `agent_task 缺少参数：需要 {"task":"要查什么"}（max_rounds 可选，1–${SUBAGENT_MAX_ROUNDS_LIMIT}）。`,
    };
  }
  let parsed: unknown;
  try {
    parsed = JSON.parse(text);
  } catch {
    return {
      ok: false,
      error: `agent_task 的参数不是合法 JSON：应当形如 {"task":"…","max_rounds":${SUBAGENT_MAX_ROUNDS_DEFAULT}}。`,
    };
  }
  if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) {
    return { ok: false, error: "agent_task 的参数必须是 JSON 对象：{\"task\":\"…\"}。" };
  }
  const obj = parsed as { task?: unknown; max_rounds?: unknown };
  const task = typeof obj.task === "string" ? obj.task.trim() : "";
  if (!task) {
    return {
      ok: false,
      error: "agent_task 缺少 task：用一两句话写清要子代理查什么（例如「在 docs/ 里找出所有提到限流的文件并总结各文件的说法」）。",
    };
  }
  if (task.length > SUBAGENT_TASK_MAX_CHARS) {
    return {
      ok: false,
      error: `agent_task 的 task 太长了（${task.length} 字，上限 ${SUBAGENT_TASK_MAX_CHARS}）：请只写目标，不要把整段上下文倒过来。`,
    };
  }
  let maxRounds = SUBAGENT_MAX_ROUNDS_DEFAULT;
  if (obj.max_rounds !== undefined && obj.max_rounds !== null) {
    const value = obj.max_rounds;
    if (typeof value !== "number" || !Number.isInteger(value) || value < 1) {
      return {
        ok: false,
        error: `agent_task 的 max_rounds 必须是 1–${SUBAGENT_MAX_ROUNDS_LIMIT} 的整数（收到 ${JSON.stringify(value)}）。`,
      };
    }
    maxRounds = Math.min(value, SUBAGENT_MAX_ROUNDS_LIMIT);
  }
  return { ok: true, args: { task, maxRounds } };
}

/** 只保留白名单里的只读工具 specs（子代理不该看见写工具）。 */
function readOnlySpecs(tools: unknown[]): unknown[] {
  const out: unknown[] = [];
  for (const spec of tools) {
    const name =
      spec && typeof spec === "object"
        ? ((spec as { function?: { name?: unknown } }).function?.name ?? "")
        : "";
    if (typeof name === "string" && SUBAGENT_READ_ONLY_TOOLS.has(name)) out.push(spec);
  }
  return out;
}

/** 工具结果截断：保头保尾，中间用省略号，避免「只留开头」把结论截掉。 */
export function clipSubagentResult(text: string, limit = SUBAGENT_TOOL_RESULT_MAX): string {
  const body = text ?? "";
  if (body.length <= limit) return body;
  const head = Math.floor(limit * 0.7);
  const tail = limit - head;
  return `${body.slice(0, head)}\n…（中间省略 ${body.length - limit} 字符）…\n${body.slice(-tail)}`;
}

/**
 * 跑一个只读子代理：最多 `maxRounds` 轮「模型 → 工具 → 模型」，直到模型不再要工具。
 *
 * 不抛异常：中断、跑满预算、白名单外调用都以文案形式回到主模型手里。
 */
export async function runSubagent(
  args: SubagentArgs,
  deps: SubagentDeps,
): Promise<SubagentResult> {
  const tools = readOnlySpecs(deps.tools);
  const messages: ChatMessage[] = [
    { role: "system", content: SUBAGENT_SYSTEM_PROMPT },
    { role: "user", content: args.task },
  ];
  const maxRounds = Math.max(1, Math.min(args.maxRounds, SUBAGENT_MAX_ROUNDS_LIMIT));
  let toolCalls = 0;
  let lastText = "";

  for (let round = 0; round < maxRounds; round++) {
    if (deps.signal?.aborted) {
      return {
        ok: false,
        text: "子代理已中断（本次运行被停止），它没有写任何东西（它本来也只能读）。",
        rounds: round,
        toolCalls,
      };
    }
    let calls: SubagentToolCall[] = [];
    const text = await deps.chat(messages, tools, deps.signal, (c) => {
      calls = c ?? [];
    });
    lastText = (text ?? "").trim();
    if (calls.length === 0) {
      return {
        ok: true,
        text: lastText || "（子代理没有返回内容）",
        rounds: round + 1,
        toolCalls,
      };
    }

    // assistant 消息里要原样带上工具调用，否则下一轮供应商会拒绝「tool 消息对不上」。
    messages.push({
      role: "assistant",
      content: text ?? "",
      tool_calls: calls.map((call, index) => ({
        id: call.id ?? `subagent_${round}_${index}`,
        type: "function" as const,
        function: { name: call.name, arguments: call.arguments },
      })),
    });

    for (const [index, call] of calls.entries()) {
      const callId = call.id ?? `subagent_${round}_${index}`;
      if (!SUBAGENT_READ_ONLY_TOOLS.has(call.name)) {
        messages.push({
          role: "tool",
          tool_call_id: callId,
          name: call.name,
          content: `子代理只能调用只读工具（${[...SUBAGENT_READ_ONLY_TOOLS].join(" / ")}），${call.name} 没有执行。`,
        });
        continue;
      }
      toolCalls++;
      const result = await deps.execute({ name: call.name, arguments: call.arguments }, 
        deps.signal ? { signal: deps.signal } : undefined);
      messages.push({
        role: "tool",
        tool_call_id: callId,
        name: call.name,
        content: clipSubagentResult(result.text),
      });
    }
  }

  return {
    ok: true,
    text: `${lastText || "（子代理没有给出结论）"}\n\n（子代理用完 ${maxRounds} 轮工具预算，结论可能不完整；需要更完整就再派一次，把范围缩小到具体目录或关键词。）`,
    rounds: maxRounds,
    toolCalls,
  };
}

/**
 * 包装 `agent_task` 时需要的依赖。
 *
 * `chat` 是给测试与评测用的注入点：确定性评测里没有模型绑定（`resolveBoundProfile`
 * 读的是应用内的 localStorage 绑定表），不给注入点就永远测不到子代理的真实循环。
 */
export interface WithSubagentToolOptions {
  agentId: string;
  conversationId: string;
  /** 覆盖子会话的对话请求（缺省走应用内的模型路由）。 */
  chat?: SubagentDeps["chat"];
}

/** 把 `agent_task` 包到主桥上：工具清单多一件，其余工具原样透传。 */
export function withSubagentTool(
  bridge: ToolBridge,
  opts: WithSubagentToolOptions,
): ToolBridge {
  return {
    ...bridge,
    tools: [...bridge.tools, subagentSpec()],
    meta: (name: string) => {
      if (name === SUBAGENT_TOOL) {
        return { risk: "read" as const, displayName: "派子代理" };
      }
      return bridge.meta?.(name);
    },
    execute: async (call, execOpts) => {
      if (call.name !== SUBAGENT_TOOL) return bridge.execute(call, execOpts);
      const parsed = parseSubagentArgs(call.arguments);
      if (!parsed.ok) return { text: parsed.error, ok: false };
      const profile = opts.chat ? undefined : resolveBoundProfile(opts.agentId);
      if (!opts.chat && !profile) {
        return {
          text: "没有可用的模型绑定，无法派子代理：请先在「设置 → 模型」给这个智能体选一个模型。",
          ok: false,
        };
      }
      const result = await runSubagent(parsed.args, {
        tools: bridge.tools,
        signal: execOpts?.signal,
        execute: (sub, subOpts) => bridge.execute(sub, subOpts),
        // 子代理的对话走与应用内对话同一条路由（重试、退避、候选切换都在里面）；
        // onDelta 故意丢掉：子代理的中间推理不该流进主界面。
        chat:
          opts.chat ??
          ((messages, subTools, signal, onToolCalls) => {
            if (!profile) throw new Error("子代理缺少模型绑定");
            return streamChatRouted(profile, messages, {
              signal: signal ?? new AbortController().signal,
              onDelta: () => {},
              tools: subTools,
              onToolCalls: (calls) =>
                onToolCalls(
                  calls.map((c) => ({
                    id: c.id,
                    name: c.function.name,
                    arguments: c.function.arguments,
                  })),
                ),
            });
          }),
      });
      const head = `子代理（只读，${result.rounds} 轮 / ${result.toolCalls} 次工具调用）结论：`;
      return { text: `${head}\n${result.text}`, ok: result.ok };
    },
  };
}
