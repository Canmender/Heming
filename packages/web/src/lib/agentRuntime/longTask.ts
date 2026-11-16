/**
 * 长任务续跑（d.157）：撞到工具轮次上限时，**先问「有没有没干完的活」再决定停不停**。
 *
 * 为什么需要这一层：
 * `agentStream` 原本每回合最多 {@link MAX_TOOL_ROUNDS} 轮工具往返（12 轮），到顶就收口并
 * 在回答末尾提示「回复『继续』可以接着做」。问题是用户投诉的正是「无法进行长任务处理」——
 * 一个真正的多步任务（读十几个文件、改几处、跑验证）本来就超过 12 轮，而**让用户手动敲
 * 「继续」是把这个续跑责任推回给人**：他得盯着、得判断「这次是不是真没做完」，多敲几次
 * 就会以为智能体能力到头了。
 *
 * 判定口径刻意保守（宁可停也不无限跑）：
 * 1. 只在**边界**（正好走满一个 12 轮段）才考虑续跑，不是每轮都算；
 * 2. 只有**任务清单里真的还有 pending / in_progress 项**才续——清单是模型自己写的，等于
 *    「它自己承认没干完」；没有清单/清单全绿就按原样收口，不会替模型脑补任务；
 * 3. 总量有硬上限 {@link LONG_TASK_MAX_ROUNDS}（3 段 = 36 轮），到顶照样收口——避免
 *    一个循环工具把整轮对话拖到用户按不了停止；
 * 4. 用户中断优先：中断了就不再续，哪怕清单还有未完成项。
 *
 * 与 DSH 的差别：DSH 的 agent loop 没有轮次硬顶，靠 token 预算与中断收口；和鸣面向的是
 * 桌面端小白用户，**静默跑 80 轮工具**比「跑 36 轮就说得清清楚楚」更糟，所以保留上限，
 * 只是把「续跑」从用户动作变成系统动作。
 */
import { MAX_TODOS, getTodos } from "../todo/store.js";

/**
 * 每一段允许的工具轮次数。
 *
 * 必须与 `lib/agentStream.ts` 的 `MAX_TOOL_ROUNDS` 相等——那边是循环的一次「充电」，
 * 这边是决定「要不要再充一次」的判据。写成独立常量而不是互相 import，是因为
 * `agentStream` 会 import 本模块（依赖方向）：再反过来 import 就成环了。
 * `longTask.test.ts` 里有一条断言把两个值钉死（改了一个忘了另一个会立刻红）。
 */
export const LONG_TASK_ROUNDS_PER_SEGMENT = 12;

/** 单次用户输入最多允许多少段（3 段 × 12 轮 = 36 轮），到顶照样收口。 */
export const LONG_TASK_MAX_SEGMENTS = 3;

/** 单次用户输入的工具轮次硬上限（含自动续跑）。 */
export const LONG_TASK_MAX_ROUNDS = LONG_TASK_ROUNDS_PER_SEGMENT * LONG_TASK_MAX_SEGMENTS;

/** 续跑判定的结果。`continue` 为 false 时 `reason` 说明为什么停（只进日志与测试，不改文案）。 */
export interface LongTaskVerdict {
  continue: boolean;
  reason: "continue" | "no-unfinished" | "limit" | "aborted" | "not-boundary";
}

export interface LongTaskInput {
  /** 本次用户输入开始以来**已经走完**的工具轮次数（不跨用户输入累计）。 */
  roundsDone: number;
  /** 任务清单里还没做完的条数（pending + in_progress）。 */
  unfinished: number;
  /** 用户是否已经按了停止。 */
  aborted?: boolean;
}

/**
 * 是否该在轮次边界续跑。
 *
 * 注意「边界」的定义是 `roundsDone` 正好是每段轮数的整数倍：调用方在
 * `round >= MAX_TOOL_ROUNDS` 的分支里传 `round + 1`，所以第一次是 12、第二次是 24。
 */
export function longTaskVerdict(input: LongTaskInput): LongTaskVerdict {
  const roundsDone = Math.max(0, Math.floor(input.roundsDone));
  if (input.aborted) return { continue: false, reason: "aborted" };
  if (roundsDone === 0 || roundsDone % LONG_TASK_ROUNDS_PER_SEGMENT !== 0) {
    return { continue: false, reason: "not-boundary" };
  }
  if (input.unfinished <= 0) return { continue: false, reason: "no-unfinished" };
  if (roundsDone >= LONG_TASK_MAX_ROUNDS) return { continue: false, reason: "limit" };
  return { continue: true, reason: "continue" };
}

/**
 * 本会话任务清单里未完成（pending / in_progress）的条数。
 *
 * 读不到清单（没有会话 id、存储坏了）一律返回 0 —— 续跑是「锦上添花」，
 * 判据不明时必须选择**不续**：错误地续跑会让一轮对话莫名变长。
 */
export function unfinishedTodoCount(conversationId: string | null | undefined): number {
  const id = conversationId?.trim();
  if (!id) return 0;
  try {
    return getTodos(id).filter((t) => t.status !== "completed").slice(0, MAX_TODOS).length;
  } catch {
    return 0;
  }
}

/**
 * 续跑时插进正文的提示。
 *
 * 必须**显式告诉用户发生了什么**：同一轮里又跑了 12 轮工具是件反常的事，不解释的话
 * 用户只能看到「转了 40 秒才回话」，会以为界面卡住。也不写「回复『继续』」——这里不需要
 * 用户动手，说了反而误导。
 */
export function longTaskNotice(roundsDone: number): string {
  const segments = Math.max(1, Math.round(roundsDone / LONG_TASK_ROUNDS_PER_SEGMENT));
  const left = LONG_TASK_MAX_SEGMENTS - segments;
  return (
    `\n\n（任务清单还有未完成项，正在自动接着做：已完成 ${roundsDone} 轮工具调用，` +
    `最多可再做 ${left} 段 × ${LONG_TASK_ROUNDS_PER_SEGMENT} 轮。）`
  );
}

/** 到顶时给用户的收口说明（与 `agentStream` 原来的文案同义，但把总量说清楚）。 */
export function longTaskLimitNotice(): string {
  return (
    `\n\n（本次已连续调用 ${LONG_TASK_MAX_ROUNDS} 轮工具（${LONG_TASK_MAX_SEGMENTS} 段），` +
    `达到单次上限，先给出当前结论。任务清单里未完成的项还在，回复「继续」可以接着做。）`
  );
}
