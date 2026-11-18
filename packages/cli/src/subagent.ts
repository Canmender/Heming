/**
 * 终端里的子代理（d.331）：把「先去查清楚，再回来告诉我」这一手也交给 CLI。
 *
 * 为什么值得做：桌面端从 d.176 起就有 `agent_task`（只读子代理，自己去翻文件、搜代码、
 * 读几屏日志，只把结论交回来）。CLI 一直没有——于是同一个任务，在窗口里是「派一个去查、
 * 我继续想」，在终端里只能「一条一条自己搜」。查证类工作最吃上下文，把几百行搜到的原文
 * 塞回主对话，往往比不查更糟。
 *
 * 三条硬约束（与桌面端同口径，理由写在这里免得后来者放开）：
 *
 * 1. **只读**：子代理看不到写工具、也看不到 `run_command`。它唯一的作用是「看和想」；
 *    要动手必须回到主对话，由主对话过闸门。这样「子代理越权改了文件」这件事在结构上
 *    就不可能发生，不依赖提示词自觉。
 * 2. **工具白名单按名字判，且以程序侧的清单为准**：模型自己在参数里写什么工具名都不算数，
 *    名单外的一律回一条「没有执行」。新增工具不会因为忘了维护名单而被悄悄放行——那样
 *    默认是拒绝，而不是默认放行。
 * 3. **轮次和结论长度都有上限**：子代理跑飞了不能把整个终端拖住（默认 4 轮、上限 6 轮），
 *    结论截到 4000 字（它该给结论，不该把搜到的原文全搬回来）。
 *
 * 与桌面端的一处有意差异：这里**不做并行多任务**（桌面端可以一次派 2–3 个）。CLI 是单进程
 * 串行模型调用，并行只会让 stderr 的进度行互相打岔，收益抵不上复杂度。`tasks` 参数仍然
 * 接受（模型习惯这么写），但会被逐个串行执行。
 */

import type { ChatMessage, StreamChatOpts, ToolCall } from "../../../packages/web/src/lib/llmClient.js";
import type { LlmProfile } from "../../../packages/web/src/store/llm.js";

/** 工具名：与桌面端同名，模型在两边行为一致。 */
export const SUBAGENT_TOOL = "agent_task";

/** 默认/最大工具轮次：够「读几个文件 → 下结论」，又不至于跑飞。 */
export const SUBAGENT_MAX_ROUNDS_DEFAULT = 4;
export const SUBAGENT_MAX_ROUNDS_LIMIT = 6;

/** 单个任务描述的上限（超出截断：任务描述本身不该是一篇文章）。 */
export const SUBAGENT_TASK_MAX_CHARS = 2000;

/** 一次调用最多几个任务（串行执行）。 */
export const SUBAGENT_TASKS_MAX = 3;

/** 每条工具结果回灌给子代理时的上限：搜到的原文再长也只回这么多。 */
export const SUBAGENT_TOOL_TEXT_MAX = 4000;

/** 最终结论回灌给主对话时的上限。 */
export const SUBAGENT_RESULT_MAX = 4000;

/**
 * 子代理能用的工具（**只读**）。
 *
 * 用清单而不是「按 meta.risk === 'read' 过滤」：桥的 meta 是给闸门看的口径，
 * 将来某个读工具标成 write（或反过来）时，我不想让子代理的能力跟着一起漂。
 */
export const SUBAGENT_READ_ONLY_TOOLS = [
  "file_read",
  "file_glob",
  "file_grep",
  "file_image",
  "tool_output_read",
] as const;

const READ_ONLY_SET: ReadonlySet<string> = new Set(SUBAGENT_READ_ONLY_TOOLS);

/** 子代理的人设：只描述「怎么干活」，不描述权限（权限由程序控制）。 */
export function subagentSystemPrompt(): string {
  return [
    "你是和鸣派出的只读子代理，在用户的仓库里查证一件事，然后把结论交回去。",
    "",
    "规则：",
    "- 你只能读：file_read / file_glob / file_grep / file_image / tool_output_read。没有写、没有命令，也不要尝试。",
    "- 先定位再读：用 file_glob / file_grep 缩小范围，别一个目录一个目录地翻。",
    "- 读到的内容只留在你这里：最后只交结论（结论 + 依据，例如文件:行号），不要把原文大段贴回去。",
    "- 查不到就说查不到，并说清你查了哪里。不要猜、不要编造文件或行号。",
    "- 一次只做这一件事。任务里没说的事不要顺手扩展。",
  ].join("\n");
}

/** OpenAI function spec：任务描述与可选轮次。 */
export function subagentSpec(): unknown {
  return {
    type: "function",
    function: {
      name: SUBAGENT_TOOL,
      description:
        "派一个只读子代理去仓库里查证一件事（它能读文件、搜代码，不能写、不能跑命令），只把结论交回来。" +
        "适合「这块逻辑在哪 / 这个报错是谁抛的 / 这几个文件怎么配合」这类需要翻几屏才能说清的问题。",
      parameters: {
        type: "object",
        properties: {
          task: {
            type: "string",
            description: "要它查什么：说清目标与验收口径（例如「找出 login 的限流在哪实现，给出文件与行号」）。",
          },
          tasks: {
            type: "array",
            items: { type: "string" },
            description: `并行派几件事（这里会串行执行，最多 ${SUBAGENT_TASKS_MAX} 条）。与 task 二选一。`,
          },
          max_rounds: {
            type: "number",
            description: `它最多调用几轮工具（1–${SUBAGENT_MAX_ROUNDS_LIMIT}，默认 ${SUBAGENT_MAX_ROUNDS_DEFAULT}）。`,
          },
        },
        additionalProperties: false,
      },
    },
  };
}

export interface SubagentArgs {
  /** 任务列表（`task` 与 `tasks` 合并后的结果，按顺序串行执行）。 */
  tasks: string[];
  maxRounds: number;
}

export type SubagentParseResult =
  | { ok: true; args: SubagentArgs }
  | { ok: false; error: string };

/** 解析模型给的参数：宽容（两种写法都认），但错就明确说错，别静默降级。 */
export function parseSubagentArgs(raw: string | undefined): SubagentParseResult {
  let parsed: unknown = {};
  if (raw && raw.trim()) {
    try {
      parsed = JSON.parse(raw);
    } catch {
      return { ok: false, error: "agent_task 的参数不是合法 JSON。" };
    }
  }
  if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) {
    return { ok: false, error: 'agent_task 需要 {"task":"要查什么"}（max_rounds 可选，1–6）。' };
  }
  const value = parsed as Record<string, unknown>;
  const tasks: string[] = [];
  if (typeof value.task === "string" && value.task.trim()) tasks.push(value.task.trim());
  if (Array.isArray(value.tasks)) {
    for (const item of value.tasks) {
      if (typeof item === "string" && item.trim()) tasks.push(item.trim());
    }
  }
  if (tasks.length === 0) {
    return { ok: false, error: 'agent_task 缺少参数：需要 {"task":"要查什么"}（max_rounds 可选，1–6）。' };
  }
  const unique: string[] = [];
  for (const task of tasks) {
    const clipped = task.slice(0, SUBAGENT_TASK_MAX_CHARS);
    if (!unique.includes(clipped)) unique.push(clipped);
  }
  let maxRounds = SUBAGENT_MAX_ROUNDS_DEFAULT;
  if (typeof value.max_rounds === "number" && Number.isFinite(value.max_rounds)) {
    maxRounds = Math.min(SUBAGENT_MAX_ROUNDS_LIMIT, Math.max(1, Math.trunc(value.max_rounds)));
  }
  return { ok: true, args: { tasks: unique.slice(0, SUBAGENT_TASKS_MAX), maxRounds } };
}

/** 一次子代理运行的产出。 */
export interface SubagentRunResult {
  text: string;
  rounds: number;
  toolCalls: number;
}

/** 与 `streamChat` 同形状（测试注入，绝不真发请求）。 */
export type SubagentChatFn = (
  profile: LlmProfile,
  messages: ChatMessage[],
  opts: StreamChatOpts,
) => Promise<string>;

export interface SubagentRunnerDeps {
  chat: SubagentChatFn;
  profile: LlmProfile;
  /** 只读工具声明（调用方传 `SUBAGENT_READ_ONLY_TOOLS` 过滤后的桥工具）。 */
  tools: readonly unknown[];
  /** 执行一次工具调用（调用方已限死在白名单内）。 */
  execute: (call: { name: string; arguments: string }) => Promise<{ text: string; ok: boolean }>;
}

/** 把长文本截断成「还能看懂」的短文本。 */
function clip(text: string, max: number): string {
  const value = text ?? "";
  if (value.length <= max) return value;
  return `${value.slice(0, max)}\n…（后面还有 ${value.length - max} 字，没有全部带回来）`;
}

/**
 * 造一个子代理执行器。
 *
 * 循环很朴素：问一次 → 有工具调用就执行并回灌 → 再问。它的价值不在循环，而在
 * **它手里只有只读工具**这件事由程序保证（白名单 + 调用方只传只读工具）。
 */
export function createSubagentRunner(deps: SubagentRunnerDeps) {
  return async function run(task: string, maxRounds: number, signal?: AbortSignal): Promise<SubagentRunResult> {
    const messages: ChatMessage[] = [
      { role: "system", content: subagentSystemPrompt() },
      { role: "user", content: task },
    ];
    const controller = new AbortController();
    const abort = signal ? signal : controller.signal;
    let toolCalls = 0;
    let text = "";
    let round = 0;

    for (round = 1; round <= maxRounds; round += 1) {
      let roundText = "";
      let calls: ToolCall[] = [];
      let sawCalls = false;
      const opts: StreamChatOpts = {
        signal: abort,
        tools: [...deps.tools],
        onDelta: (delta) => {
          roundText += delta;
        },
        onToolCalls: (value) => {
          calls = value;
          sawCalls = true;
        },
      };
      await deps.chat(deps.profile, messages, opts);
      text = roundText;
      messages.push({
        role: "assistant",
        content: roundText,
        ...(sawCalls && calls.length > 0 ? { tool_calls: calls } : {}),
      });
      if (!sawCalls || calls.length === 0) {
        return { text: clip(roundText.trim(), SUBAGENT_RESULT_MAX), rounds: round, toolCalls };
      }
      for (const call of calls) {
        const name = call.function.name;
        if (!READ_ONLY_SET.has(name)) {
          messages.push({
            role: "tool",
            tool_call_id: call.id,
            name,
            content: `子代理只能调用只读工具（${SUBAGENT_READ_ONLY_TOOLS.join("、")}），${name} 没有执行。`,
          });
          continue;
        }
        toolCalls += 1;
        let content = "";
        try {
          const result = await deps.execute({ name, arguments: call.function.arguments });
          content = clip(result.text, SUBAGENT_TOOL_TEXT_MAX);
          if (!result.ok) content += "\n（这次调用失败了——换个查法，或直接把查不到写进结论。）";
        } catch (error) {
          content = `工具调用出错：${error instanceof Error ? error.message : String(error)}`;
        }
        messages.push({ role: "tool", tool_call_id: call.id, name, content });
      }
    }

    return {
      text: clip(
        [text.trim(), `（子代理到了 ${maxRounds} 轮上限还没有收口，上面是它最后的说法。）`].filter(Boolean).join("\n\n"),
        SUBAGENT_RESULT_MAX,
      ),
      rounds: Math.max(1, round - 1),
      toolCalls,
    };
  };
}

/** 回灌给主对话的结果文案：说清「谁查的、查了几轮、用了多少次工具」。 */
export function subagentResultText(results: readonly SubagentRunResult[], tasks: readonly string[]): string {
  if (results.length === 1) {
    const one = results[0]!;
    return [
      `子代理（只读，${one.rounds} 轮 / ${one.toolCalls} 次工具调用）结论：`,
      "",
      one.text || "（它没有给出结论。）",
    ].join("\n");
  }
  const lines: string[] = [`并行子代理（只读，${results.length} 个任务，串行执行）：`];
  results.forEach((result, index) => {
    lines.push("");
    lines.push(`【任务 ${index + 1}】${tasks[index] ?? ""}`);
    lines.push(`（${result.rounds} 轮 / ${result.toolCalls} 次工具调用）`);
    lines.push(result.text || "（它没有给出结论。）");
  });
  return lines.join("\n");
}