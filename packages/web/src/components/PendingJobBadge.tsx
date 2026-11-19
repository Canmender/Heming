import { useSyncExternalStore } from "react";
import {
  listSubagentJobs,
  subscribeSubagentJobs,
  undeliveredJobsOf,
} from "../lib/agentRuntime/subagentJobs.js";

/**
 * 「后台子代理有结论，但还没送进这个会话」（d.383）。
 *
 * 为什么需要它：后台作业的结论只往**当前**会话投递——你切去别的会话干活时，
 * 结论会老老实实排队等回来（`takeUndeliveredJobs`）。可侧栏一声不响，用户
 * 根本不知道该回到哪一条会话，于是那句「结论会自动送回来」就变成了空话。
 *
 * 与「正在跑」「未跑完」互不替代：
 * - 正在跑：此刻在算；
 * - 未跑完：上一轮断了；
 * - 这个：算完了，结论在排队等人回来。
 *
 * 点开会话就投递，所以徽标会在进货的同时消失，不需要额外的「已读」状态。
 */
export function PendingJobBadge({ conversationId }: { conversationId: string }) {
  // 订阅整表：交付、取消、新作业都会通知；数量很小（上限 40 条），不值得再分片。
  const jobs = useSyncExternalStore(subscribeSubagentJobs, listSubagentJobs);
  const pending = undeliveredJobsOf(conversationId);
  if (pending.length === 0) return null;
  const running = jobs.filter(
    (job) =>
      job.conversationId === conversationId && (job.status === "running" || job.status === "queued"),
  ).length;
  return (
    <span
      className="ui-chip shrink-0"
      data-testid="pending-job-badge"
      title={
        `还有 ${pending.length} 条后台子代理的结论没送进这个会话：点开会话就会送到` +
        (running > 0 ? `（另有 ${running} 条还在跑）` : "")
      }
    >
      结论
    </span>
  );
}
