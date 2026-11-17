import type { TeamBriefCounts, TeamTask } from "@heming/shared";

/**
 * 团队任务概览（d.256）。
 *
 * 为什么放在服务端：组长的智能体每次被问「进度怎么样」都要先 team_get 翻一遍快照，
 * 一个团队一圈下来就是好几次工具调用；这里算好一次，随团队简报一起给。
 *
 * 口径：
 * - 只统计「未完成」与「已完成」两类，不猜别的状态；
 * - 逾期 = 未完成且截止时间已过（没定截止的不算）；
 * - 待认领 = 未完成且没人认领；
 * - 被前置卡住 = 未完成且前置里还有没做完的（前置被删的情况已在删除时清掉）。
 */
export function summarizeTeamTasks(
  tasks: readonly TeamTask[],
  now: number = Date.now(),
): { counts: TeamBriefCounts; perMember: Map<string, number> } {
  let open = 0;
  let done = 0;
  let overdue = 0;
  let unassigned = 0;
  let blocked = 0;
  const perMember = new Map<string, number>();
  const byId = new Map(tasks.map((task) => [task.id, task]));
  for (const task of tasks) {
    if (task.status === "done") {
      done += 1;
      continue;
    }
    open += 1;
    if (task.assigneeId === null) {
      unassigned += 1;
    } else {
      perMember.set(task.assigneeId, (perMember.get(task.assigneeId) ?? 0) + 1);
    }
    if (task.dueAt !== null) {
      const at = Date.parse(task.dueAt);
      if (!Number.isNaN(at) && at < now) overdue += 1;
    }
    if ((task.blockedBy ?? []).some((id) => byId.get(id)?.status !== "done")) {
      blocked += 1;
    }
  }
  return { counts: { open, done, overdue, unassigned, blocked }, perMember };
}
