import { Button } from "./ui/Button.js";
import { LONG_TASK_MAX_ROUNDS, LONG_TASK_MAX_SEGMENTS } from "../lib/agentRuntime/longTask.js";

/**
 * 「这一轮被上限截断了」的可见落点（d.167.4.103，d.176.4.105 扩到预算收口）。
 *
 * 为什么要把它做在界面上，而不是只让模型在气泡里写一句「回复『继续』可以接着做」：
 * 到了上限的那一轮，模型被要求先给当前结论，用户看到的是**一个看起来答完了的回答**，
 * 只有气泡最后一行小字提到「继续」。要接着做就得自己打字，而且得打对——
 * 而长任务恰恰是「用户不想一直盯着、也不想背口令」的场景。
 *
 * 所以：收口状态由编排层给出（`RunSettled.maxRounds` / `RunSettled.budgetStop`），
 * 界面只负责把它变成一次点击。两种收口的**入口相同、原因不同**：
 * 一种是工具轮次用完，一种是这一轮的上下文预算先满了（后者说「模型笨」是冤枉它）。
 */
export type ContinueReason = "rounds" | "budget";

export interface RoundLimitHintProps {
  /** 为什么给这个入口：轮次到顶，还是工具结果吃到预算上限（d.176.4.105）。 */
  reason?: ContinueReason;
  /** 点「继续」：走与错误行重试同一个续写入口（不重发原提问）。 */
  onContinue: () => void;
  /** 点「收起」：用户已经知道，不想让提示占着输入区。 */
  onDismiss?: () => void;
}

export function RoundLimitHint({ reason = "rounds", onContinue, onDismiss }: RoundLimitHintProps) {
  const text =
    reason === "budget"
      ? "这一轮工具返回的内容太多，先到了上下文预算的上限，任务可能还没做完。"
      : `这一轮已用满 ${LONG_TASK_MAX_ROUNDS} 轮工具调用（${LONG_TASK_MAX_SEGMENTS} 段），任务可能还没做完。`;
  return (
    <div
      role="status"
      aria-live="polite"
      className="mx-4 mt-1.5 flex flex-wrap items-center gap-x-2 gap-y-1 rounded-md border border-subtle-3 bg-subtle-1 px-2.5 py-1.5 text-ui-sm text-muted"
    >
      <span>{text}</span>
      <span className="inline-flex items-center gap-1.5">
        <Button variant="ghost" size="sm" onClick={onContinue}>
          继续
        </Button>
        {onDismiss ? (
          <Button variant="ghost" size="sm" onClick={onDismiss}>
            收起
          </Button>
        ) : null}
      </span>
    </div>
  );
}
