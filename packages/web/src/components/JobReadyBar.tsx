/**
 * 「后台作业跑完了」条 —— d.182。
 *
 * 和 `RoundLimitHint` 同一产品口径：**只提供入口，不偷偷替用户花 token**。
 * 模型在长任务里起了构建/测试作业后往往先收口（作业不会被 await），这条提示把
 * 「现在可以继续了」摆到眼前，点一下才发下一轮。
 */

import { Button } from "./ui/Button.js";
import { summarizeWatchedJobs, type WatchedJob } from "../lib/shell/jobWatch.js";

export interface JobReadyBarProps {
  /** 盯到的作业状态（至少一条；空数组时组件不渲染）。 */
  jobs: readonly WatchedJob[];
  /** 是否还有在跑的（超时/中断时会 true）——文案要说「还在跑」，不能假装完成。 */
  pending?: boolean;
  onContinue: () => void;
  onDismiss?: () => void;
}

export function JobReadyBar({ jobs, pending = false, onContinue, onDismiss }: JobReadyBarProps) {
  if (jobs.length === 0) return null;
  const finishedCount = jobs.filter((job) => !job.running).length;
  const summary = summarizeWatchedJobs(jobs);
  const headline = pending
    ? `后台作业还没结束（${finishedCount}/${jobs.length} 已结束）：`
    : `后台作业已结束（${finishedCount}/${jobs.length}）：`;

  return (
    <div
      role="status"
      aria-live="polite"
      className="mx-3 mb-2 flex flex-col gap-1.5 rounded-md border border-line bg-subtle-2 px-3 py-2 text-ui-md text-ink"
    >
      <div className="flex items-start justify-between gap-2">
        <div className="min-w-0">
          <div className="font-medium">{headline}</div>
          <pre className="mt-1 max-h-20 overflow-y-auto whitespace-pre-wrap break-all font-mono text-ui-sm text-muted">
            {summary}
          </pre>
        </div>
        <div className="flex shrink-0 items-center gap-1">
          <Button variant="ghost" size="sm" onClick={onContinue}>
            {pending ? "查看进展" : "继续"}
          </Button>
          {onDismiss ? (
            <Button variant="ghost" size="sm" onClick={onDismiss}>
              收起
            </Button>
          ) : null}
        </div>
      </div>
    </div>
  );
}
