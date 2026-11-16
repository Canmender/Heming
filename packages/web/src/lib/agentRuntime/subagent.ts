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
 *
 * d.200：一次可以派 2–3 个并行子代理（`tasks` 数组）。长任务里「翻三个目录」这类
 * 工作本来在主对话里只能串行做：每轮一次工具、每轮都等模型回来。并行派出去之后，
 * 主对话只花一次工具调用的时间。并发的上限写死在 `SUBAGENT_PARALLEL_DEFAULT` /
 * `SUBAGENT_MAX_PARALLEL`——不做无限并发，否则一个请求能把模型配额打满。
 * 同时把进度上报给界面（`onProgress`）：用户要能看见「两个子代理在读什么」，
 * 也能一键停掉（`createSignal`）。
 *
 * d.202：子代理可以被**显式授权写盘**。默认仍然是只读——`writable` 只能由用户
 * 在界面里打开（会话级开关，见 `subagentWrite.ts`），不能让模型自己开。
 * 授权后子代理也只拿到 `file_write` / `file_edit` 两件，且仍然走主桥同一套
 * 工作区根校验（写不到根外）；每次落盘通过 `onWrite` 交给主对话记进「本轮可撤回」，
 * 用户点一下就能整体回滚。执行命令、网络、HITL 依旧不给：子代理没有交互通道，
 * 一旦允许它跑命令，就没有任何人能在它乱跑之前拦下来。
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

/**
 * 用户显式授权写盘后，子代理额外能用的工具（d.202）。
 *
 * 故意只有「整文件写」与「锚点替换」两件：`file_undo`（回滚别人的备份）、
 * `run_command`（跑任意命令）、`file_image` 都不给——前两件超出「改这个文件」的
 * 最小授权，后一件子代理用不上。
 */
export const SUBAGENT_WRITE_TOOLS: ReadonlySet<string> = new Set([
  "file_write",
  "file_edit",
]);

/** 单次工具结果回灌给子代理的最大字符数：截断是防止一个巨型文件打爆子会话。 */
export const SUBAGENT_TOOL_RESULT_MAX = 4000;

/** 任务描述的长度上限：太长说明主模型在把整段上下文倒过来，不如自己读。 */
export const SUBAGENT_TASK_MAX_CHARS = 2000;

/** 一次最多能派几个并行子代理：再多人就不是「省轮次」而是打满配额了。 */
export const SUBAGENT_MAX_PARALLEL = 3;

/** 并行子代理的默认并发数（模型不指定时）。 */
export const SUBAGENT_PARALLEL_DEFAULT = 2;

/** 进度阶段：开始 / 一轮对话 / 一次工具 / 结束（done|failed 各一种）。 */
export type SubagentProgressPhase = "start" | "round" | "tool" | "done" | "failed";

/** 子代理进度事件：界面据此显示「哪个子代理在第几轮、正在读什么」。 */
export interface SubagentProgressEvent {
  /** 本次派遣内的任务 id（`sub-1` / `sub-2`），界面用来区分行。 */
  taskId: string;
  task: string;
  phase: SubagentProgressPhase;
  round: number;
  /** `phase === "tool"` 时的工具名。 */
  tool?: string;
  /** `phase` 为 done/failed 时的简述（失败原因 / 轮次用量）。 */
  note?: string;
}

/** 子代理的人设：短、只讲边界，不讲业务。授权写盘时多两条写规矩（d.202）。 */
function subagentSystemPrompt(writable: boolean): string {
  return [
    writable
      ? "你是一个子代理：你能读文件、列文件、搜内容，本轮用户已授权你改文件（只能用 file_write / file_edit，且只能改工作区内）。"
      : "你是一个只读子代理：你只能读文件、列文件、搜内容，不能写、不能执行命令、不能联网。",
    "你的任务是把「需要翻很多文件才能确认」的事情查清楚，然后用结论回答，不要复述文件原文。",
    "规则：",
    "- 先想清楚要找什么，再用最少的工具调用拿到证据；同一个工具别重复调。",
    "- 结论要能核对：写清依据的文件路径（必要时带行号），拿不到证据就明说「未确认」。",
    "- 只回答交给你的任务，不要扩展到别的主题，也不要问用户问题（没有人会回你）。",
    ...(writable
      ? [
          "- 只改任务点名要改的文件，别顺手重构别的文件；改完用一句话说清「改了哪个文件、改了什么」。",
          "- 拿不准要不要改的地方先别改，在结论里说明「这里可能需要你确认」。",
        ]
      : []),
  ].join("\n");
}

/** 模型给 `agent_task` 的参数（解析后）。 */
export interface SubagentArgs {
  /** 兼容单任务写法：等于 `tasks[0]`。 */
  task: string;
  /** 并行任务列表（1–`SUBAGENT_MAX_PARALLEL` 条）。 */
  tasks: string[];
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
  /** 主桥的工具清单（子代理会从里面挑只读三件；授权写盘时再加两件写工具）。 */
  tools: unknown[];
  /** 执行工具（走主桥，参数形状一致）。 */
  execute: (
    call: { name: string; arguments: string },
    opts?: { signal?: AbortSignal },
  ) => Promise<{ text: string; ok: boolean; writes?: string[] }>;
  /** 一次对话请求；`onToolCalls` 在本轮收尾时回调。 */
  chat: (
    messages: ChatMessage[],
    tools: unknown[],
    signal: AbortSignal | undefined,
    onToolCalls: (calls: SubagentToolCall[]) => void,
  ) => Promise<string>;
  /** 用户中断信号；缺省视为不可中断。 */
  signal?: AbortSignal;
  /** 进度回调（d.200）：界面据此显示并行子代理正在做什么。 */
  onProgress?: (event: SubagentProgressEvent) => void;
  /** 用户是否显式授权了子代理写盘（d.202）：缺省 false，即只读。 */
  writable?: boolean;
  /** 子代理每落盘一个文件回调一次，主对话据此把路径记进「本轮可撤回」。 */
  onWrite?: (path: string) => void;
}

/** 子代理的结果：`text` 永远是给主模型看的结论（失败也带原因）。 */
export interface SubagentResult {
  ok: boolean;
  text: string;
  rounds: number;
  toolCalls: number;
}

/** OpenAI function spec；`writable` 时描述里如实说明「本轮已授权改文件」。 */
export function subagentSpec(writable = false): unknown {
  return {
    type: "function",
    function: {
      name: SUBAGENT_TOOL,
      description: writable
        ? "派子代理去查资料、并在需要时改文件：它能读文件/列文件/搜内容，本轮用户已授权它用 file_write / file_edit 改工作区内的文件（改到哪几个文件要在任务里写清楚）。适合「要翻很多文件才知道答案」或「几处小改动互不相关」的活；可以一次派 2–3 个任务并行跑（`tasks` 数组），省下串行的工具轮次。"
        : "派只读子代理去查资料：它只能读文件/列文件/搜内容，会把结论带回来。适合「要翻很多文件才知道答案」的检索，避免把大量原文拉进主对话。可以一次派 2–3 个任务并行跑（`tasks` 数组），省下串行的工具轮次。",
      parameters: {
        type: "object",
        properties: {
          task: {
            type: "string",
            description: "交给子代理的任务：写清要找什么、要回答什么（一两句话）",
          },
          tasks: {
            type: "array",
            items: { type: "string", description: "一条子任务" },
            minItems: 1,
            maxItems: SUBAGENT_MAX_PARALLEL,
            description: `要并行查的 2–${SUBAGENT_MAX_PARALLEL} 件事，每件都写清目标；与 task 二选一`,
          },
          max_rounds: {
            type: "integer",
            minimum: 1,
            maximum: SUBAGENT_MAX_ROUNDS_LIMIT,
            description: `每个子代理最多跑几轮工具（默认 ${SUBAGENT_MAX_ROUNDS_DEFAULT}，上限 ${SUBAGENT_MAX_ROUNDS_LIMIT}）`,
          },
        },
        required: [],
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
  const obj = parsed as { task?: unknown; tasks?: unknown; max_rounds?: unknown };
  const tasks: string[] = [];
  if (Array.isArray(obj.tasks)) {
    if (obj.tasks.length === 0) {
      return {
        ok: false,
        error: "agent_task 的 tasks 是空数组：要么不传它、只传 task，要么写 1–3 件要并行查的事。",
      };
    }
    if (obj.tasks.length > SUBAGENT_MAX_PARALLEL) {
      return {
        ok: false,
        error: `agent_task 一次最多派 ${SUBAGENT_MAX_PARALLEL} 个子代理（收到 ${obj.tasks.length} 个）：请把任务合并/排序，先派最关键的几件。`,
      };
    }
    for (const [index, item] of obj.tasks.entries()) {
      const text = typeof item === "string" ? item.trim() : "";
      if (!text) {
        return {
          ok: false,
          error: `agent_task 的 tasks 第 ${index + 1} 条不是非空字符串：每条都要写清要查什么。`,
        };
      }
      if (text.length > SUBAGENT_TASK_MAX_CHARS) {
        return {
          ok: false,
          error: `agent_task 的 tasks 第 ${index + 1} 条太长了（${text.length} 字，上限 ${SUBAGENT_TASK_MAX_CHARS}）：只写目标，不要把整段上下文倒过来。`,
        };
      }
      tasks.push(text);
    }
  } else {
    const task = typeof obj.task === "string" ? obj.task.trim() : "";
    if (!task) {
      return {
        ok: false,
        error: `agent_task 缺少任务：用 {"task":"要查什么"}，或 {"tasks":["第一件","第二件"]} 一次派 ${SUBAGENT_PARALLEL_DEFAULT}–${SUBAGENT_MAX_PARALLEL} 个并行子代理（max_rounds 可选，1–${SUBAGENT_MAX_ROUNDS_LIMIT}）。`,
      };
    }
    if (task.length > SUBAGENT_TASK_MAX_CHARS) {
      return {
        ok: false,
        error: `agent_task 的 task 太长了（${task.length} 字，上限 ${SUBAGENT_TASK_MAX_CHARS}）：请只写目标，不要把整段上下文倒过来。`,
      };
    }
    tasks.push(task);
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
  return { ok: true, args: { task: tasks[0], tasks, maxRounds } };
}

/** 子代理这次能看见的工具名：只读三件，授权写盘时再加两件写工具（d.202）。 */
function allowedToolNames(writable: boolean): ReadonlySet<string> {
  if (!writable) return SUBAGENT_READ_ONLY_TOOLS;
  const names = new Set(SUBAGENT_READ_ONLY_TOOLS);
  for (const name of SUBAGENT_WRITE_TOOLS) names.add(name);
  return names;
}

/** 只保留白名单里的工具 specs（子代理不该看见被禁的工具）。 */
function allowedSpecs(tools: unknown[], writable: boolean): unknown[] {
  const allowed = allowedToolNames(writable);
  const out: unknown[] = [];
  for (const spec of tools) {
    const name =
      spec && typeof spec === "object"
        ? ((spec as { function?: { name?: unknown } }).function?.name ?? "")
        : "";
    if (typeof name === "string" && allowed.has(name)) out.push(spec);
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

/** 进度上报的小工具：没有回调时什么都不做（评测与单测都不传）。 */
function emitProgress(deps: SubagentDeps, event: SubagentProgressEvent): void {
  deps.onProgress?.(event);
}

/**
 * 跑一个只读子代理：最多 `maxRounds` 轮「模型 → 工具 → 模型」，直到模型不再要工具。
 *
 * 不抛异常：中断、跑满预算、白名单外调用都以文案形式回到主模型手里。
 * `taskId` 只进进度事件（并行派遣时用来区分是哪一条）。
 */
async function runOne(
  task: string,
  maxRounds: number,
  deps: SubagentDeps,
  taskId: string,
): Promise<SubagentResult> {
  const writable = deps.writable === true;
  const allowed = allowedToolNames(writable);
  const tools = allowedSpecs(deps.tools, writable);
  const messages: ChatMessage[] = [
    { role: "system", content: subagentSystemPrompt(writable) },
    { role: "user", content: task },
  ];
  let toolCalls = 0;
  let lastText = "";
  const writes: string[] = [];
  emitProgress(deps, { taskId, task, phase: "start", round: 0 });

  for (let round = 0; round < maxRounds; round++) {
    if (deps.signal?.aborted) {
      const text = writable
        ? "子代理已中断（本次运行被停止）：它已经改过的文件在本轮「可撤回」里，可以整体回滚。"
        : "子代理已中断（本次运行被停止），它没有写任何东西（它本来也只能读）。";
      emitProgress(deps, { taskId, task, phase: "failed", round, note: "已中断" });
      return { ok: false, text, rounds: round, toolCalls };
    }
    let calls: SubagentToolCall[] = [];
    const text = await deps.chat(messages, tools, deps.signal, (c) => {
      calls = c ?? [];
    });
    lastText = (text ?? "").trim();
    emitProgress(deps, {
      taskId,
      task,
      phase: "round",
      round: round + 1,
      note: calls.length ? `${calls.length} 个工具` : "给结论",
    });
    if (calls.length === 0) {
      emitProgress(deps, {
        taskId,
        task,
        phase: "done",
        round: round + 1,
        ...(lastText ? {} : { note: "没有返回内容" }),
      });
      return {
        ok: true,
        text: `${lastText || "（子代理没有返回内容）"}${writes.length ? `\n\n（本次改动：${writes.join("、")}）` : ""}`,
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
      if (!allowed.has(call.name)) {
        const hint = writable
          ? `子代理只能用 ${[...allowed].join(" / ")}；${call.name} 没有执行（执行命令与网络工具不开放给子代理）。`
          : `子代理只能调用只读工具（${[...allowed].join(" / ")}），${call.name} 没有执行${
              SUBAGENT_WRITE_TOOLS.has(call.name)
                ? "：本轮没有授权子代理写盘（要写的话先在输入框发 /subagent write on）"
                : ""
            }。`;
        messages.push({
          role: "tool",
          tool_call_id: callId,
          name: call.name,
          content: hint,
        });
        continue;
      }
      toolCalls++;
      emitProgress(deps, { taskId, task, phase: "tool", round: round + 1, tool: call.name });
      const result = await deps.execute({ name: call.name, arguments: call.arguments }, 
        deps.signal ? { signal: deps.signal } : undefined);
      if (writable && result.writes?.length) {
        for (const path of result.writes) {
          if (!path || writes.includes(path)) continue;
          writes.push(path);
          deps.onWrite?.(path);
        }
      }
      messages.push({
        role: "tool",
        tool_call_id: callId,
        name: call.name,
        content: clipSubagentResult(result.text),
      });
    }
  }

  emitProgress(deps, { taskId, task, phase: "done", round: maxRounds, note: "用完轮次预算" });
  const writeNote = writes.length ? `\n\n（本次改动：${writes.join("、")}）` : "";
  return {
    ok: true,
    text: `${lastText || "（子代理没有给出结论）"}\n\n（子代理用完 ${maxRounds} 轮工具预算，结论可能不完整；需要更完整就再派一次，把范围缩小到具体目录或关键词。）${writeNote}`,
    rounds: maxRounds,
    toolCalls,
  };
}

/**
 * 单任务入口的入参：既接受 d.162 的 `{ task, maxRounds }`（测试与评测直接这样调），
 * 也接受 `parseSubagentArgs` 产出的完整形状（带 `tasks`）。
 */
export type SubagentRunInput = { task: string; maxRounds: number } | SubagentArgs;

/** 跑一个只读子代理（单任务入口，兼容 d.162 的调用方与评测）。 */
export async function runSubagent(
  args: SubagentRunInput,
  deps: SubagentDeps,
): Promise<SubagentResult> {
  const maxRounds = Math.max(1, Math.min(args.maxRounds, SUBAGENT_MAX_ROUNDS_LIMIT));
  const task = "tasks" in args ? (args.tasks[0] ?? args.task) : args.task;
  return runOne(task, maxRounds, deps, "sub-1");
}

/**
 * 并行跑 2–3 个只读子代理（d.200）。
 *
 * 并发只用来**等 I/O**（模型请求 + 读文件），不是把额度打满：默认 2、硬上限 3。
 * 结果顺序与传入顺序一致（`results[i]` 对应 `tasks[i]`），界面也是按这个顺序显示的——
 * 完成先后不该影响「第 1 件查的是什么」。
 */
export async function runSubagentBatch(
  tasks: readonly string[],
  maxRounds: number,
  deps: SubagentDeps,
  concurrency = SUBAGENT_PARALLEL_DEFAULT,
): Promise<SubagentResult[]> {
  const list = tasks.slice(0, SUBAGENT_MAX_PARALLEL);
  if (list.length === 0) return [];
  const rounds = Math.max(1, Math.min(maxRounds, SUBAGENT_MAX_ROUNDS_LIMIT));
  const results: SubagentResult[] = new Array(list.length);
  let next = 0;
  const workers = Math.max(1, Math.min(concurrency, list.length));
  await Promise.all(
    Array.from({ length: workers }, async () => {
      for (;;) {
        const index = next;
        next += 1;
        if (index >= list.length) return;
        const task = list[index];
        if (task === undefined) return;
        results[index] = await runOne(task, rounds, deps, `sub-${index + 1}`);
      }
    }),
  );
  return results;
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
  /** 进度上报（d.200）：界面据此显示并行子代理正在做什么。 */
  onProgress?: SubagentDeps["onProgress"];
  /**
   * 界面上的「停止子代理」入口（d.200）：返回一个用户可中途中断的信号。
   *
   * 和主对话自己的停止信号（`execOpts.signal`）是**两件事**：用户可能只想停掉
   * 那两个子代理、让主对话继续——所以两个信号取或，任一触发都算中断。
   */
  createSignal?: () => AbortSignal;
  /**
   * 用户是否显式授权子代理写盘（d.202）。只能由界面上的用户开关传入，
   * **不能来自模型参数**——否则模型可以自己给自己开写权限。
   */
  writable?: boolean;
  /** 子代理落盘回调：主对话据此把路径记进「本轮可撤回」。 */
  onWrite?: (path: string) => void;
}

/** 把两个中断信号合成一个：任一方 abort 都算中断（缺一方就返回另一方）。 */
function combineSignals(first?: AbortSignal, second?: AbortSignal): AbortSignal | undefined {
  if (!first) return second;
  if (!second) return first;
  const controller = new AbortController();
  const stop = () => controller.abort();
  if (first.aborted || second.aborted) {
    controller.abort();
    return controller.signal;
  }
  first.addEventListener("abort", stop, { once: true });
  second.addEventListener("abort", stop, { once: true });
  return controller.signal;
}

/** 把 `agent_task` 包到主桥上：工具清单多一件，其余工具原样透传。 */
export function withSubagentTool(
  bridge: ToolBridge,
  opts: WithSubagentToolOptions,
): ToolBridge {
  const writable = opts.writable === true;
  return {
    ...bridge,
    tools: [...bridge.tools, subagentSpec(writable)],
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
      const signal = combineSignals(opts.createSignal?.(), execOpts?.signal);
      const results = await runSubagentBatch(parsed.args.tasks, parsed.args.maxRounds, {
        tools: bridge.tools,
        ...(signal ? { signal } : {}),
        ...(opts.onProgress ? { onProgress: opts.onProgress } : {}),
        ...(writable ? { writable: true } : {}),
        ...(opts.onWrite ? { onWrite: opts.onWrite } : {}),
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
      // 单任务保持 d.162 的文案形状（评测与既有用例都按它断言）；多任务按「【任务 N】」分段，
      // 每段都带自己的轮次用量——主模型据此判断哪一件没查完、要不要补派。
      // d.202：授权写盘时把「只读」如实改成「可写」，别让主模型以为子代理没动过文件。
      const mode = writable ? "可写" : "只读";
      const sections = results.map((result, index) => {
        const head = `子代理（${mode}，${result.rounds} 轮 / ${result.toolCalls} 次工具调用）结论：`;
        const task = parsed.args.tasks[index] ?? "";
        return results.length > 1 ? `【任务 ${index + 1}】${task}\n${head}\n${result.text}` : `${head}\n${result.text}`;
      });
      const title =
        results.length > 1
          ? `并行子代理（${mode}，共 ${results.length} 个任务，每件上限 ${parsed.args.maxRounds} 轮）\n`
          : "";
      return {
        text: `${title}${sections.join("\n\n")}`,
        ok: results.every((result) => result.ok),
      };
    },
  };
}
