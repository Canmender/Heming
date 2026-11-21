/**
 * 工作流编排（d.203.4.109）：`workflow_run` 工具。
 *
 * 为什么需要它：
 * `agent_task`（d.162/d.200）能一次派 2–3 个**互不相干**的子代理。但真实的检索任务
 * 常常是有先后的：「先看仓库结构，再按结构决定去读哪几个目录」——串行派两次，中间
 * 那一步的结论要经过主对话转述一遍（既费 token，又可能被压缩掉）。工作流把「步骤 +
 * 依赖」直接交给应用执行：上游步骤的结论自动接在下游步骤的任务里，中间不回流主对话。
 *
 * 红线与 `agent_task` 完全一致（也复用它的执行体）：
 * - **只读**：每个步骤都是一个只读子代理，不写盘、不跑命令、不联网。
 * - **有界**：最多 `WORKFLOW_MAX_STEPS` 步、每批最多 `WORKFLOW_MAX_CONCURRENT` 个并行、
 *   单步轮次有硬上限；上游结论注入下游时还会截断（不能靠它把原文一路搬下去）。
 * - **依赖必须成立**：id 重复、引用不存在的步骤、自己依赖自己、成环——一律在**执行前**
 *   就拒绝，并把能照着改的错误文案还给主模型；不允许跑到一半才发现顺序不对。
 * - **小步快跑**：批与批之间是整个工作流的同步点（下游确实需要上游结论时才有意义）；
 *   同一批里互不依赖的步骤才并行。
 */
import type { ToolBridge } from "../agentStream.js";
import { resolveBoundProfile, streamChatRouted } from "../llmRoute.js";
import {
  SUBAGENT_MAX_ROUNDS_DEFAULT,
  SUBAGENT_MAX_ROUNDS_LIMIT,
  runSubagentTask,
  type SubagentDeps,
} from "./subagent.js";

/** 工具名：模型看到的就是这个名字。 */
export const WORKFLOW_TOOL = "workflow_run";

/** 一个工作流最多几步：再多就说明该拆成两次了（每一步都是一次子会话）。 */
export const WORKFLOW_MAX_STEPS = 6;

/** 同一批最多并行几个步骤：与 `agent_task` 的口径一致，不做无上限并发。 */
export const WORKFLOW_MAX_CONCURRENT = 3;

/** 单步任务的字符上限：步骤之间靠「结论」传递，不该往任务里塞整段上下文。 */
export const WORKFLOW_STEP_TASK_MAX_CHARS = 600;

/** 目标的字符上限：一句话说清终点，写长了是计划书不是目标。 */
export const WORKFLOW_GOAL_MAX_CHARS = 400;

/** 注入下游步骤时，每条上游结论最多带多少字符。 */
export const WORKFLOW_UPSTREAM_CONTEXT_MAX = 1200;

/** 步骤 id 的合法形状：字母开头，只允许字母/数字/下划线/短横线。 */
const STEP_ID_RE = /^[a-zA-Z][a-zA-Z0-9_-]{0,23}$/;

/** 工作流里的一个步骤（`needs` 是它依赖的上游步骤 id）。 */
export interface WorkflowStep {
  id: string;
  task: string;
  needs: string[];
}

/** 解析并校验后的工作流计划。 */
export interface WorkflowPlan {
  goal: string;
  steps: WorkflowStep[];
  /** 每一步最多跑几轮工具。 */
  maxRounds: number;
}

export type WorkflowParseResult =
  | { ok: true; plan: WorkflowPlan }
  | { ok: false; error: string };

/** 单个步骤的执行结果（`text` 是这个子代理的结论）。 */
export interface WorkflowStepResult {
  id: string;
  task: string;
  ok: boolean;
  rounds: number;
  toolCalls: number;
  text: string;
}

/** 整次工作流的结果：`text` 是回给主模型的汇总（含每步结论）。 */
export interface WorkflowResult {
  ok: boolean;
  text: string;
  /** 执行用到的批次（每批里的步骤互不依赖）。 */
  waves: string[][];
  steps: WorkflowStepResult[];
}

export type WavePlanResult =
  | { ok: true; waves: string[][] }
  | { ok: false; error: string };

/** 步骤 id 列表的展示形状：`a, b → c`。 */
function stepList(ids: readonly string[]): string {
  return ids.join("、");
}

/** 解析 `workflow_run` 的参数；错误文案要能让主模型自己改对并重试。 */
export function parseWorkflowArgs(raw: string | undefined): WorkflowParseResult {
  const text = (raw ?? "").trim();
  const example = `{"goal":"弄清登录链路","steps":[{"id":"scan","task":"列出 auth 相关文件"},{"id":"read","task":"读 auth 的核心实现","needs":["scan"]}]}`;
  if (!text) {
    return {
      ok: false,
      error: `workflow_run 缺少参数：需要 ${example}（max_rounds 可选，1–${SUBAGENT_MAX_ROUNDS_LIMIT}）。`,
    };
  }
  let parsed: unknown;
  try {
    parsed = JSON.parse(text);
  } catch {
    return {
      ok: false,
      error: `workflow_run 的参数不是合法 JSON：应当形如 ${example}。`,
    };
  }
  if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) {
    return { ok: false, error: `workflow_run 的参数必须是 JSON 对象：形如 ${example}。` };
  }
  const obj = parsed as { goal?: unknown; steps?: unknown; max_rounds?: unknown };
  const goal = typeof obj.goal === "string" ? obj.goal.trim() : "";
  if (!goal) {
    return {
      ok: false,
      error: "workflow_run 缺少 goal：用一句话写清这一串步骤最终要回答什么（例：\"弄清登录链路\"）。",
    };
  }
  if (goal.length > WORKFLOW_GOAL_MAX_CHARS) {
    return {
      ok: false,
      error: `workflow_run 的 goal 太长了（${goal.length} 字，上限 ${WORKFLOW_GOAL_MAX_CHARS}）：一句话说清终点即可，过程写进 steps。`,
    };
  }
  if (!Array.isArray(obj.steps) || obj.steps.length === 0) {
    return {
      ok: false,
      error: `workflow_run 缺少 steps：至少要一步，形如 [{"id":"scan","task":"列出相关文件"}]（最多 ${WORKFLOW_MAX_STEPS} 步）。`,
    };
  }
  if (obj.steps.length > WORKFLOW_MAX_STEPS) {
    return {
      ok: false,
      error: `workflow_run 最多 ${WORKFLOW_MAX_STEPS} 步（收到 ${obj.steps.length} 步）：请合并步骤，或拆成两次工作流。`,
    };
  }
  const steps: WorkflowStep[] = [];
  const ids = new Set<string>();
  for (const [index, item] of obj.steps.entries()) {
    if (!item || typeof item !== "object" || Array.isArray(item)) {
      return { ok: false, error: `workflow_run 的 steps 第 ${index + 1} 步不是对象：每一步要写成 {"id":"…","task":"…"}` };
    }
    const step = item as { id?: unknown; task?: unknown; needs?: unknown };
    const id = typeof step.id === "string" ? step.id.trim() : "";
    if (!id || !STEP_ID_RE.test(id)) {
      return {
        ok: false,
        error: `workflow_run 的 steps 第 ${index + 1} 步 id 不合法（收到 ${JSON.stringify(step.id)}）：要用字母开头的短标识，例如 "scan"、"read-auth"，最长 24 个字符。`,
      };
    }
    if (ids.has(id)) {
      return { ok: false, error: `workflow_run 的 steps 里 id 重复了："${id}"。每个步骤要有一个能互相引用的唯一 id。` };
    }
    ids.add(id);
    const task = typeof step.task === "string" ? step.task.trim() : "";
    if (!task) {
      return { ok: false, error: `workflow_run 的 steps 第 ${index + 1} 步（${id}）缺少 task：写清这一步要查什么、回答什么。` };
    }
    if (task.length > WORKFLOW_STEP_TASK_MAX_CHARS) {
      return {
        ok: false,
        error: `workflow_run 的步骤 ${id} 的 task 太长了（${task.length} 字，上限 ${WORKFLOW_STEP_TASK_MAX_CHARS}）：只写这一步的目标，上下文靠 needs 传。`,
      };
    }
    steps.push({ id, task, needs: [] });
  }
  // 依赖要在**所有 id 都收齐之后**再校验，否则「先引用了后面的步骤」会被误判。
  for (const [index, item] of obj.steps.entries()) {
    const rawNeeds = (item as { needs?: unknown }).needs;
    if (rawNeeds === undefined || rawNeeds === null) continue;
    if (!Array.isArray(rawNeeds)) {
      return { ok: false, error: `workflow_run 的步骤 ${steps[index]?.id} 的 needs 必须是 id 数组，例如 ["scan"]。` };
    }
    const needs: string[] = [];
    for (const need of rawNeeds) {
      const id = typeof need === "string" ? need.trim() : "";
      if (!id) {
        return { ok: false, error: `workflow_run 的步骤 ${steps[index]?.id} 的 needs 里有空值：每一项都要是别的步骤的 id。` };
      }
      if (id === steps[index]?.id) {
        return { ok: false, error: `workflow_run 的步骤 ${id} 依赖了自己：needs 里要去掉它自己。` };
      }
      if (!ids.has(id)) {
        return {
          ok: false,
          error: `workflow_run 的步骤 ${steps[index]?.id} 依赖了不存在的步骤 "${id}"：needs 只能引用本工作流里定义过的 id（${stepList([...ids])}）。`,
        };
      }
      if (!needs.includes(id)) needs.push(id);
    }
    const step = steps[index];
    if (step) step.needs = needs;
  }
  let maxRounds = SUBAGENT_MAX_ROUNDS_DEFAULT - 1;
  if (maxRounds < 1) maxRounds = 1;
  if (obj.max_rounds !== undefined && obj.max_rounds !== null) {
    const value = obj.max_rounds;
    if (typeof value !== "number" || !Number.isInteger(value) || value < 1) {
      return {
        ok: false,
        error: `workflow_run 的 max_rounds 必须是 1–${SUBAGENT_MAX_ROUNDS_LIMIT} 的整数（收到 ${JSON.stringify(value)}）。`,
      };
    }
    maxRounds = Math.min(value, SUBAGENT_MAX_ROUNDS_LIMIT);
  }
  return { ok: true, plan: { goal, steps, maxRounds } };
}

/**
 * 把步骤按依赖切成批次（Kahn 拓扑分层）。
 *
 * 同一批里的步骤互不依赖，可以并行；批与批之间是同步点。成环时返回哪几条互相等待，
 * 让主模型知道该去掉哪条 `needs`——而不是只回一句「有环」。
 */
export function planWaves(steps: readonly WorkflowStep[]): WavePlanResult {
  const pending = new Map<string, Set<string>>();
  for (const step of steps) pending.set(step.id, new Set(step.needs));
  const placed = new Set<string>();
  const waves: string[][] = [];
  while (placed.size < steps.length) {
    const wave: string[] = [];
    for (const step of steps) {
      if (placed.has(step.id)) continue;
      const needs = pending.get(step.id);
      if (!needs) continue;
      let ready = true;
      for (const need of needs) {
        if (!placed.has(need)) {
          ready = false;
          break;
        }
      }
      if (ready) wave.push(step.id);
    }
    if (wave.length === 0) {
      const stuck = steps.filter((step) => !placed.has(step.id)).map((step) => step.id);
      return {
        ok: false,
        error: `workflow_run 的 steps 依赖成环，无法排序：${stepList(stuck)} 在互相等待。请删掉其中一条 needs，或把它们的顺序改成单向。`,
      };
    }
    waves.push(wave);
    for (const id of wave) placed.add(id);
  }
  return { ok: true, waves };
}

/** 每步最多跑几轮工具（工作流的单步比单独派子代理更便宜：默认少一轮）。 */
function defaultMaxRounds(): number {
  return Math.max(1, SUBAGENT_MAX_ROUNDS_DEFAULT - 1);
}

/** 下游步骤看到的「上游结论」段落：带 id 与任务名，便于它判断该不该引用。 */
function upstreamContext(
  step: WorkflowStep,
  byId: Map<string, WorkflowStepResult>,
): string {
  const parts: string[] = [];
  for (const need of step.needs) {
    const result = byId.get(need);
    if (!result) continue;
    const body = result.text.trim();
    // 上游结论会拼进下游子代理的任务提示：按码点截断，不能在 emoji 的代理对中间
    // 劈出落单代理（那会把无效标量值喂给模型，也是 d.412 一系列截断修复的同款问题）。
    const chars = Array.from(body);
    const clipped =
      chars.length > WORKFLOW_UPSTREAM_CONTEXT_MAX
        ? `${chars.slice(0, WORKFLOW_UPSTREAM_CONTEXT_MAX).join("")}…（已截断）`
        : body;
    parts.push(`- 步骤 ${need}（${result.task}）：\n${clipped}`);
  }
  if (parts.length === 0) return "";
  return [
    "上游步骤已经查到的结论（据此继续，不要重复查同一件事）：",
    ...parts,
    "",
    "你的任务：",
  ].join("\n");
}

/** 把整次工作流的结果整理成回给主模型的文本（每一步都带轮次用量与成败）。 */
function formatWorkflow(
  plan: WorkflowPlan,
  waves: string[][],
  steps: WorkflowStepResult[],
): WorkflowResult {
  const ok = steps.every((step) => step.ok);
  const head = [
    `工作流（${steps.length} 步 / ${waves.length} 批；${waves.some((w) => w.length > 1) ? "同批并行，只读子代理" : "只读子代理"}）`,
    `目标：${plan.goal}`,
  ];
  const body: string[] = [];
  for (const step of steps) {
    const usage = step.ok
      ? `${step.rounds} 轮 / ${step.toolCalls} 次工具调用`
      : `未完成（${step.rounds} 轮 / ${step.toolCalls} 次工具调用）`;
    body.push(`### [${step.id}] ${step.task}\n（${usage}）\n${step.text.trim()}`);
  }
  const tail = ok
    ? ["", "以上是全部步骤的结论：据此回答用户；哪一步没查到就如实说，不要用别的步骤的结论硬凑。"]
    : ["", "有步骤没有跑完：请按失败原因决定是重试该步、换一种做法，还是先向用户说明缺什么。"];
  return { ok, text: [...head, "", ...body, ...tail].join("\n"), waves, steps };
}

/**
 * 执行一个已校验的工作流计划：按批并行，上游结论注入下游任务。
 *
 * `deps` 与 `agent_task` 完全同一套（工具、执行、对话、中断、进度），只是把
 * `onProgress` 的 taskId 换成步骤 id——界面因此能显示「在工作流的哪一步」。
 */
export async function runWorkflow(
  plan: WorkflowPlan,
  deps: SubagentDeps,
  options: { concurrency?: number; taskIdPrefix?: string } = {},
): Promise<WorkflowResult> {
  const planned = planWaves(plan.steps);
  if (!planned.ok) {
    return { ok: false, text: planned.error, waves: [], steps: [] };
  }
  const prefix = options.taskIdPrefix ?? "wf-";
  const budget = Math.max(1, Math.min(options.concurrency ?? WORKFLOW_MAX_CONCURRENT, WORKFLOW_MAX_CONCURRENT));
  const results = new Map<string, WorkflowStepResult>();
  // 进度里的 `task` 要显示**这一步原本要做什么**，而不是整段注入上下文：
  // 下游任务前面接着上游结论，直接映到面板上会变成「上游步骤已经查到的结论…」，
  // 用户看不出这一步在查什么。
  const stepById = new Map(plan.steps.map((step) => [`${prefix}${step.id}`, step]));
  const onProgress = deps.onProgress;
  const stepDeps: SubagentDeps = onProgress
    ? {
        ...deps,
        onProgress: (event) => {
          const step = stepById.get(event.taskId);
          onProgress(step ? { ...event, task: step.task } : event);
        },
      }
    : deps;
  for (const wave of planned.waves) {
    const queue = [...wave];
    const workers = Math.max(1, Math.min(budget, queue.length));
    await Promise.all(
      Array.from({ length: workers }, async () => {
        for (;;) {
          const id = queue.shift();
          if (id === undefined) return;
          const step = plan.steps.find((item) => item.id === id);
          if (!step) return;
          const context = upstreamContext(step, results);
          const task = context ? `${context}${step.task}` : step.task;
          // 一步失败不该拖垮整条流程：把失败如实记成这一步的结论，后面的步骤照跑
          // （下游会看到「这一步没查到」，从而选择换做法或如实说明缺什么）。
          try {
            const result = await runSubagentTask(task, plan.maxRounds, stepDeps, `${prefix}${step.id}`);
            results.set(step.id, {
              id: step.id,
              task: step.task,
              ok: result.ok,
              rounds: result.rounds,
              toolCalls: result.toolCalls,
              text: result.text,
            });
          } catch (error) {
            const reason = error instanceof Error ? error.message : String(error);
            results.set(step.id, {
              id: step.id,
              task: step.task,
              ok: false,
              rounds: 0,
              toolCalls: 0,
              text: `这一步执行时出错：${reason}`,
            });
          }
        }
      }),
    );
  }
  const ordered = plan.steps.map(
    (step) =>
      results.get(step.id) ?? {
        id: step.id,
        task: step.task,
        ok: false,
        rounds: 0,
        toolCalls: 0,
        text: "（这一步没有执行：被中断或内部出错）",
      },
  );
  return formatWorkflow(plan, planned.waves, ordered);
}

/** OpenAI function spec；描述里把「有依赖要写 needs」讲清楚，否则模型会并行重复查同一件事。 */
export function workflowSpec(): unknown {
  return {
    type: "function",
    function: {
      name: WORKFLOW_TOOL,
      description: `跑一条有依赖关系的只读检索流程：把要做的事拆成 1–${WORKFLOW_MAX_STEPS} 步，每步写清要查什么；有前后依赖就在 needs 里写上游步骤的 id，没依赖的步骤会同批并行。上游结论会自动接在下游任务前面，中间不消耗主对话的轮次。适合「先摸清结构、再按结构深挖」这类多段检索。`,
      parameters: {
        type: "object",
        properties: {
          goal: { type: "string", description: "这一串步骤最终要回答什么（一句话）" },
          steps: {
            type: "array",
            minItems: 1,
            maxItems: WORKFLOW_MAX_STEPS,
            description: "步骤列表；没有 needs 的步骤会先并行跑",
            items: {
              type: "object",
              properties: {
                id: { type: "string", description: "步骤的唯一短标识（字母开头），供别的步骤在 needs 里引用" },
                task: { type: "string", description: "这一步要查什么、回答什么" },
                needs: {
                  type: "array",
                  items: { type: "string", description: "依赖的上游步骤 id" },
                  description: "这一步必须在哪些步骤之后跑（省略表示不依赖任何步骤）",
                },
              },
              required: ["id", "task"],
              additionalProperties: false,
            },
          },
          max_rounds: {
            type: "integer",
            minimum: 1,
            maximum: SUBAGENT_MAX_ROUNDS_LIMIT,
            description: `每一步最多跑几轮工具（默认 ${defaultMaxRounds()}，上限 ${SUBAGENT_MAX_ROUNDS_LIMIT}）`,
          },
        },
        required: ["goal", "steps"],
        additionalProperties: false,
      },
    },
  };
}

/** 包装 `workflow_run` 时需要的依赖（与 `WithSubagentToolOptions` 同源，少写盘授权）。 */
export interface WithWorkflowToolOptions {
  agentId: string;
  conversationId: string;
  /** 覆盖子会话的对话请求（缺省走应用内的模型路由）。 */
  chat?: SubagentDeps["chat"];
  /** 进度上报：界面按步骤 id 显示「哪一步在跑、第几轮、正在用什么工具」。 */
  onProgress?: SubagentDeps["onProgress"];
  /** 界面「停止子代理」的信号：与主对话的停止信号取或。 */
  createSignal?: () => AbortSignal;
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

/** 把 `workflow_run` 包到主桥上：工具清单多一件，其余工具原样透传。 */
export function withWorkflowTool(
  bridge: ToolBridge,
  opts: WithWorkflowToolOptions,
): ToolBridge {
  return {
    ...bridge,
    tools: [...bridge.tools, workflowSpec()],
    meta: (name: string) => {
      if (name === WORKFLOW_TOOL) {
        // d.207：工作流是长任务编排的主入口，声明成核心工具。
        return { risk: "read" as const, displayName: "跑工作流", core: true };
      }
      return bridge.meta?.(name);
    },
    execute: async (call, execOpts) => {
      if (call.name !== WORKFLOW_TOOL) return bridge.execute(call, execOpts);
      const parsed = parseWorkflowArgs(call.arguments);
      if (!parsed.ok) return { text: parsed.error, ok: false };
      const profile = opts.chat ? undefined : resolveBoundProfile(opts.agentId);
      if (!opts.chat && !profile) {
        return {
          text: "没有可用的模型绑定，无法跑工作流：请先在「设置 → 模型」给这个智能体选一个模型。",
          ok: false,
        };
      }
      const signal = combineSignals(opts.createSignal?.(), execOpts?.signal);
      const result = await runWorkflow(parsed.plan, {
        tools: bridge.tools,
        ...(signal ? { signal } : {}),
        ...(opts.onProgress ? { onProgress: opts.onProgress } : {}),
        execute: (sub, subOpts) => bridge.execute(sub, subOpts),
        // 工作流里的每一步都是只读子代理：写盘授权不外溢，`agent_task` 自身的规则照旧。
        chat:
          opts.chat ??
          ((messages, subTools, subSignal, onToolCalls) => {
            if (!profile) throw new Error("工作流缺少模型绑定");
            return streamChatRouted(profile, messages, {
              signal: subSignal ?? new AbortController().signal,
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
      return { text: result.text, ok: result.ok };
    },
  };
}
