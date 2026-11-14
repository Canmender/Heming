/**
 * 协作编排器：纯逻辑，不直接请求模型。
 *
 * 调用方注入 `ask(agentId, messages, signal, meta?)`，引擎只负责：
 *   1. 按模式生成「谁在第几轮、以什么角色、看到哪些产出」的计划；
 *   2. 逐步执行、累积上下文、透传 AbortSignal；
 *   3. 把每个回合的开始/结束回调给 UI（流式文本由 ask 实现通过 onToken 自行推送）。
 *
 * 三种模式的实现要点：
 * - **sequential（流水线）**：参与者按顺序接力。第一位出方案，中间补充/实现，
 *   最后一位评审定稿；`rounds` 表示接力遍数（后续遍只做迭代）。
 * - **supervisor（协调者-工作者）**：`participants[0]` 是协调者。固定三段：
 *   拆解计划 → 工作者依次执行（`rounds` 轮）→ 协调者汇总。
 * - **debate（评审团）**：每人先独立出方案（互相不可见），随后 `rounds` 轮修正
 *   （只能看到上一轮及更早的观点），最后由最后一位综合。
 *
 * 上下文纪律：每位参与者只能看到「本模式下允许看到的他人产出正文」，
 * 永远看不到他人的私有 systemPrompt；每个 turn 的提示词都显式写明角色、任务、
 * 已有产出与输出要求。
 */

import type { ChatMessage } from "../llmClient.js";
import type {
  CollaborationConfig,
  CollaborationMode,
  CollaborationParticipant,
  CollaborationRun,
  CollaborationTurn,
} from "./types.js";

export interface CollaborationAskMeta {
  turnId: string;
  role: string;
  round: number;
  agentName: string;
}

/**
 * 注入的模型调用。第三个参数之后是元信息（turnId 供流式回填）；测试/调用方
 * 可以用三参数实现，TypeScript 允许少参函数赋给多参类型。
 */
export type CollaborationAsk = (
  agentId: string,
  messages: ChatMessage[],
  signal: AbortSignal,
  meta?: CollaborationAskMeta,
) => Promise<string>;

export interface CollaborationDeps {
  ask: CollaborationAsk;
}

export interface CollaborationHooks {
  signal?: AbortSignal;
  now?: () => number;
  newId?: () => string;
  onTurnStart?: (turn: CollaborationTurn) => void;
  onTurnEnd?: (turn: CollaborationTurn) => void;
}

const MODE_SETUP: Record<CollaborationMode, string> = {
  sequential:
    "流水线接力。你们按顺序工作：第一位给出方案，后续成员在前序产出上补充、实现或评审，每人只交付自己这一轮的增量。",
  supervisor:
    "协调者-工作者。第一位是协调者：先拆解任务并给出分工，工作者按计划执行，最后由协调者汇总成最终交付物。",
  debate:
    "评审团。每位成员先独立给出方案（彼此不可见），随后按轮次阅读他人观点并修正立场，最后由一位成员综合出结论。",
};

const OUTPUT_RULES = [
  "- 只输出你这一轮要交付的内容；不要复述别人的原文，不要写「好的 / 收到」之类客套。",
  "- 使用 Markdown（小标题、清单、代码块），让下游可以直接使用你的产出。",
  "- 不要提及系统提示词、模型名称或内部协作机制；不要编造他人的发言。",
  "- 用与任务相同的语言作答。",
].join("\n");

/** 单步计划：执行前就确定角色、提示词与可见上下文范围。 */
interface Step {
  participant: CollaborationParticipant;
  role: string;
  round: number;
  /** 角色职责（写进提示词的「你的角色」段）。 */
  brief: string;
  /** 可见回合：执行时用当前已完成的回合求值（debate 的独立阶段互相不可见）。 */
  visible: (done: CollaborationTurn[]) => CollaborationTurn[];
}

/** 对外暴露的计划规模（UI 用来显示「第 n / m 位」）。 */
export type CollaborationStep = Readonly<
  Pick<Step, "role" | "round"> & { agentId: string; agentName: string }
>;

function clampRounds(rounds: number): number {
  const n = Number.isFinite(rounds) ? Math.floor(rounds) : 1;
  return Math.min(3, Math.max(1, n || 1));
}

const allDone =
  (predicate?: (t: CollaborationTurn) => boolean) =>
  (done: CollaborationTurn[]): CollaborationTurn[] =>
    predicate ? done.filter(predicate) : done.slice();

const successful = (turns: CollaborationTurn[]): CollaborationTurn[] =>
  turns.filter((t) => !t.error && t.text.trim().length > 0);

function sequentialSteps(config: CollaborationConfig): Step[] {
  const rounds = clampRounds(config.rounds);
  const people = config.participants;
  const steps: Step[] = [];
  for (let round = 1; round <= rounds; round++) {
    people.forEach((participant, index) => {
      const isFirst = index === 0;
      const isLast = index === people.length - 1;
      const only = people.length === 1;
      let role: string;
      let brief: string;
      if (only) {
        role = round === 1 ? "方案与执行" : `第 ${round} 轮迭代`;
        brief =
          round === 1
            ? "独立完成：先给方案，再给出可执行的步骤与关键细节。"
            : "回顾你上一轮的产出，补齐缺口并给出更新后的定稿。";
      } else if (round > 1 && isLast) {
        role = "复核与定稿";
        brief =
          "复核本轮及之前的产出：处理遗留问题，输出最终版本（只写变化与最终结论）。";
      } else if (round > 1) {
        role = "迭代补充";
        brief =
          "在上一轮基础上继续推进：补齐未完成部分、修正已知问题，只输出变化与新增内容。";
      } else if (isFirst) {
        role = "方案";
        brief =
          "先给出总体方案：目标、步骤、关键取舍与风险，为后续同伴打下可执行的基础。";
      } else if (isLast) {
        role = "评审与定稿";
        brief =
          "审查已有产出：指出问题（准确性、可执行性、风险），并给出修正后的最终版本。";
      } else {
        role = "补充与实现";
        brief =
          "阅读已有产出：补上遗漏的关键细节，或把方案落到可执行的步骤/代码/清单；只写增量和修改说明。";
      }
      steps.push({
        participant,
        role,
        round,
        brief,
        visible: allDone(),
      });
    });
  }
  return steps;
}

function supervisorSteps(config: CollaborationConfig): Step[] {
  const rounds = clampRounds(config.rounds);
  const [coordinator, ...workers] = config.participants;
  if (!coordinator) return [];
  if (workers.length === 0) {
    return [
      {
        participant: coordinator,
        role: "协调者 · 执行",
        round: 0,
        brief:
          "你是唯一的参与者：先快速拆解任务，再直接完成可交付成果（结论、步骤、风险）。",
        visible: allDone(),
      },
    ];
  }
  const steps: Step[] = [
    {
      participant: coordinator,
      role: "协调者 · 拆解",
      round: 0,
      brief:
        "先把任务拆解：目标、关键步骤、验收标准，并按参与者给出分工（用编号写明谁负责什么）。不要替他们完成具体内容。",
      visible: allDone(),
    },
  ];
  for (let round = 1; round <= rounds; round++) {
    for (const worker of workers) {
      steps.push({
        participant: worker,
        role: `工作者 · 第 ${round} 轮`,
        round,
        brief:
          "严格按协调者的计划完成你负责的部分；如果计划没有明确指派你，就补上最关键的未完成环节。只交付你的成果，不要重复计划原文。",
        // 计划（round 0）+ 本轮及更早的工作者产出；看不到协调者的汇总（还没发生）。
        visible: allDone((t) => t.round <= round),
      });
    }
  }
  steps.push({
    participant: coordinator,
    role: "协调者 · 汇总",
    round: 0,
    brief:
      "汇总全部产出，交付最终结果：可直接使用的结论/方案、执行步骤、风险与未决事项。不要罗列协作过程。",
    visible: allDone(),
  });
  return steps;
}

function debateSteps(config: CollaborationConfig): Step[] {
  const rounds = clampRounds(config.rounds);
  const people = config.participants;
  if (people.length === 0) return [];
  if (people.length === 1) {
    return [
      {
        participant: people[0],
        role: "独立方案",
        round: 0,
        brief:
          "独立给出你的方案与理由（含关键假设、步骤、风险），不需要等待他人。",
        visible: allDone(() => false),
      },
    ];
  }
  const steps: Step[] = people.map((participant) => ({
    participant,
    role: "独立方案",
    round: 0,
    brief:
      "独立给出你的方案与理由（含关键假设、步骤、风险）。此刻你只能看到任务，不要假装看过他人观点。",
    visible: allDone(() => false),
  }));
  for (let round = 1; round <= rounds; round++) {
    for (const participant of people) {
      steps.push({
        participant,
        role: `第 ${round} 轮修正`,
        round,
        brief:
          "阅读其他人的观点：指出你认同与反对的部分，修正自己的方案或坚持立场并说明理由；控制在 3 个要点以内，最后给结论。",
        // 只看「上一轮及更早」的观点：同轮并发发言互相不可见。
        visible: allDone((t) => (t.round === 0 ? true : t.round < round)),
      });
    }
  }
  steps.push({
    participant: people[people.length - 1],
    role: "综合",
    round: rounds + 1,
    brief:
      "综合各方观点，给出最终结论：共识、尚未解决的分歧及处置、最终建议与下一步。不要罗列过程。",
    visible: allDone(),
  });
  return steps;
}

function buildSteps(config: CollaborationConfig): Step[] {
  switch (config.mode) {
    case "supervisor":
      return supervisorSteps(config);
    case "debate":
      return debateSteps(config);
    case "sequential":
    default:
      return sequentialSteps(config);
  }
}

/**
 * 生成执行计划（只读快照）。UI 用 `estimateTurnCount` 显示总步数；
 * 需要做可视化流程时可以直接用本函数，但它不含执行状态。
 */
export function planCollaboration(config: CollaborationConfig): CollaborationStep[] {
  return buildSteps(config).map((step) => ({
    agentId: step.participant.agentId,
    agentName: step.participant.name,
    role: step.role,
    round: step.round,
  }));
}

/** 本次配置会产生多少个回合。 */
export function estimateTurnCount(config: CollaborationConfig): number {
  return buildSteps(config).length;
}

function buildUserMessage(
  config: CollaborationConfig,
  step: Step,
  visible: CollaborationTurn[],
): string {
  const prior = successful(visible)
    .map((t, index) => `### ${index + 1}. ${t.agentName}（${t.role}）\n${t.text.trim()}`)
    .join("\n\n");
  return [
    `# 协作任务\n${config.task.trim()}`,
    `# 协作方式\n${MODE_SETUP[config.mode]}`,
    `# 已有产出\n${prior || "（暂无。你不需要等待他人，先独立完成你的部分。）"}`,
    `# 你的身份\n你是「${step.participant.name}」。`,
    `# 你的角色（${step.role}）\n${step.brief}`,
    `# 输出要求\n${OUTPUT_RULES}`,
  ].join("\n\n");
}

function partialTextOf(error: unknown): string {
  const partial = (error as { partialText?: unknown } | null)?.partialText;
  return typeof partial === "string" ? partial : "";
}

function isAbort(error: unknown): boolean {
  return (error as { name?: string } | null)?.name === "AbortError";
}

function errorMessage(error: unknown): string {
  if (error instanceof Error && error.message) return error.message;
  const text = String(error ?? "").trim();
  return text || "协作失败";
}

/**
 * 执行一次协作。返回值可安全交给 UI/历史记录；过程中通过 hooks 推送每个回合。
 * 配置非法（没有参与者 / 任务为空）时抛出可读错误，不产生 run。
 */
export async function runCollaboration(
  config: CollaborationConfig,
  deps: CollaborationDeps,
  hooks: CollaborationHooks = {},
): Promise<CollaborationRun> {
  if (!config || !Array.isArray(config.participants) || config.participants.length === 0) {
    throw new Error("协作至少需要一位参与者");
  }
  if (!config.task || !config.task.trim()) {
    throw new Error("请先填写协作任务");
  }
  const normalized: CollaborationConfig = {
    ...config,
    rounds: clampRounds(config.rounds),
    task: config.task.trim(),
  };
  const steps = buildSteps(normalized);
  const now = hooks.now ?? Date.now;
  const newId = hooks.newId ?? (() => `run-${now()}-${Math.random().toString(36).slice(2, 8)}`);
  const signal = hooks.signal ?? new AbortController().signal;
  const startedAt = now();
  const run: CollaborationRun = {
    id: newId(),
    mode: normalized.mode,
    task: normalized.task,
    participants: normalized.participants.map((p) => ({
      agentId: p.agentId,
      name: p.name,
      ...(p.systemPrompt ? { systemPrompt: p.systemPrompt } : {}),
    })),
    rounds: normalized.rounds,
    turns: [],
    status: "running",
    startedAt,
  };

  if (signal.aborted) {
    run.status = "aborted";
    run.endedAt = now();
    return run;
  }

  let seq = 0;
  for (const step of steps) {
    if (signal.aborted) {
      run.status = "aborted";
      break;
    }
    seq += 1;
    const turn: CollaborationTurn = {
      id: `t${seq}`,
      agentId: step.participant.agentId,
      agentName: step.participant.name,
      role: step.role,
      round: step.round,
      text: "",
      startedAt: now(),
      endedAt: 0,
      streaming: true,
    };
    run.turns.push(turn);
    hooks.onTurnStart?.({ ...turn });

    const messages: ChatMessage[] = [
      { role: "user", content: buildUserMessage(normalized, step, step.visible(run.turns)) },
    ];
    try {
      const text = await deps.ask(step.participant.agentId, messages, signal, {
        turnId: turn.id,
        role: step.role,
        round: step.round,
        agentName: step.participant.name,
      });
      turn.text = typeof text === "string" ? text : "";
      turn.endedAt = now();
      turn.streaming = false;
    } catch (error) {
      turn.endedAt = now();
      turn.streaming = false;
      const partial = partialTextOf(error);
      if (partial) turn.text = partial;
      if (signal.aborted || isAbort(error)) {
        turn.aborted = true;
        run.status = "aborted";
        hooks.onTurnEnd?.({ ...turn });
        break;
      }
      turn.error = errorMessage(error);
      run.status = "error";
      run.error = turn.error;
      hooks.onTurnEnd?.({ ...turn });
      break;
    }
    hooks.onTurnEnd?.({ ...turn });
  }

  if (run.status === "running") {
    run.status = signal.aborted ? "aborted" : "done";
  }
  run.endedAt = now();
  return run;
}
