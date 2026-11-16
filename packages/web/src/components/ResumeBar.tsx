import { Button } from "./ui/Button.js";

export type ResumeReason = "aborted" | "interrupted";

/**
 * 「这一轮没跑完，继续吗？」（d.189）。
 *
 * 两种来源共用一个条：
 * - `aborted`：用户**自己点了停止**。以前停止之后就没有「接着做」的入口，只能重新打一遍；
 * - `interrupted`：应用重启/窗口关闭后发现上一轮没收口——这种情况用户往往已经忘了它在干嘛。
 *
 * 为什么不自动继续：续跑会立刻产生一次真实请求和一堆工具调用，用户可能只是想停下看看。
 * 这里只给入口，按一下才动。
 */
export function ResumeBar({
  reason,
  onContinue,
  onDismiss,
}: {
  reason: ResumeReason;
  onContinue: () => void;
  onDismiss?: () => void;
}) {
  const headline =
    reason === "aborted"
      ? "这一轮被你停下了，任务可能还没做完。"
      : "上次这一轮没有跑完（窗口关闭或应用重启过），任务可能还没做完。";
  return (
    <div
      role="status"
      aria-live="polite"
      aria-label="继续上次的任务"
      className="mx-4 mb-1 flex flex-wrap items-center gap-2 rounded-md border border-line bg-subtle-2 px-3 py-1.5 text-ui-sm text-body"
    >
      <span className="min-w-0 flex-1">{headline}</span>
      <Button variant="ghost" size="sm" onClick={onContinue}>
        继续
      </Button>
      {onDismiss ? (
        <Button variant="ghost" size="sm" onClick={onDismiss}>
          收起
        </Button>
      ) : null}
    </div>
  );
}
