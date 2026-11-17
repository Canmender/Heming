/**
 * 主对话进度行（d.214，d.218 起收口后留下小结）。
 *
 * 跑着的时候：`第 3 轮 · 正在执行 file_grep · 已跑 42 秒`。
 * 收口之后：`上一轮：3 轮 · 5 次工具 · 用时 1 分 12 秒`——一行说清这一轮干了多少。
 *
 * 只显示模型真实做过的事：轮次（它确实在跑第 N 轮）、工具名（它确实在调这个工具）、
 * 工具次数（真数出来的）。不显示百分比、不显示「预计还剩」——没人知道，编出来只会让用户误判。
 * 没有进度（没跑过）就整个不渲染，不留空白条。
 */
import type { TurnProgress } from "../lib/agentRuntime/turnProgress.js";
import { describeTurnProgress, formatElapsed } from "../lib/agentRuntime/turnProgress.js";

export interface TurnProgressLineProps {
  progress: TurnProgress | null;
  /** 当前时间（由上层每秒推进一次；缺省用渲染时刻，便于单独测文案）。 */
  now?: number;
}

export function TurnProgressLine({ progress, now }: TurnProgressLineProps) {
  if (!progress) return null;
  // 收口后不再走秒：小结里的「用时」是固定的，左边那个呼吸点也该停（否则像还在跑）
  const running = !progress.done;
  const elapsed = formatElapsed((now ?? Date.now()) - progress.at);
  return (
    <div
      role="status"
      aria-live="polite"
      data-testid="turn-progress"
      data-done={progress.done ? "true" : "false"}
      className={`mx-4 mb-1 flex items-center gap-2 rounded-md border px-3 py-1 text-ui-sm ${
        running ? "border-line-soft bg-subtle text-muted" : "border-line-soft bg-subtle-2 text-muted"
      }`}
    >
      <span
        className={`h-1.5 w-1.5 shrink-0 rounded-full ${running ? "animate-pulse bg-accent" : "bg-muted"}`}
        aria-hidden="true"
      />
      <span className="min-w-0 flex-1 truncate">{describeTurnProgress(progress)}</span>
      {running ? <span className="shrink-0 tabular-nums">已跑 {elapsed}</span> : null}
    </div>
  );
}
