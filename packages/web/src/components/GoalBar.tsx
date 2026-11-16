import { Button } from "./ui/Button.js";
import type { SessionGoal } from "../lib/agentRuntime/goal.js";

/**
 * 当前目标条（d.201）。
 *
 * 只在这个会话**有目标**时出现：它是一条「别忘了终点」的提醒，不是常驻控件；
 * 没有目标时整条不渲染（目标靠输入框的 `/goal` 设定）。
 *
 * 为什么给「完成」按钮：目标写进提示词后模型会一直看到它，达成了一个还留着，
 * 它就会继续围着旧目标转。用户点一下「完成」= 从提示词里摘掉，比让模型自己
 * 判断「我算做完了吗」可靠。
 */
export function GoalBar({
  goal,
  onDone,
  onClear,
}: {
  goal: SessionGoal | null;
  onDone: () => void;
  onClear: () => void;
}) {
  if (!goal) return null;
  return (
    <div
      role="status"
      aria-label="当前目标"
      data-testid="goal-bar"
      className="mx-4 mb-1 flex flex-wrap items-center gap-x-3 gap-y-1 rounded-md border border-line bg-subtle-2 px-3 py-1.5 text-ui-sm text-body"
    >
      <span className="shrink-0 font-medium">目标</span>
      <span className="min-w-0 flex-1 truncate" title={goal.text}>
        {goal.text}
      </span>
      <Button variant="ghost" size="sm" onClick={onDone}>
        完成
      </Button>
      <Button variant="ghost" size="sm" onClick={onClear}>
        清除
      </Button>
    </div>
  );
}
