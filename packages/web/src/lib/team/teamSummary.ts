import type { TeamTask } from "@heming/shared";

/**
 * 团队概览（d.257）：把「这个团队现在压着多少活」算成一行字，放在团队页顶部。
 *
 * 为什么需要：d.256 已经把这组数字写进了智能体的团队简报（`TeamBrief.counts`），
 * 但界面这边组长仍然要逐条读任务行、自己在脑子里数「几件逾期、几件没人认领、几件还卡在前置上」。
 * 同口径的数字既然服务器已经会算一次，界面这侧也按同一套规则再算一次（不额外发请求）。
 *
 * 口径与 d.256 服务端完全一致：
 * - `done` 只数已完成；其余四项只在**未完成**的任务里数。
 * - 「逾期」要求 `dueAt` 能被解析且早于现在（没截止时间的不算逾期）。
 * - 「被前置卡住」＝至少一个前置任务还没完成（前置不存在时按「不卡」处理，避免脏数据把人卡死）。
 * - 只给事实，不评优劣、不催办。
 */

export interface TeamSummary {
  open: number;
  done: number;
  /**
   * 已交上来、组长还没看过的活（d.275）。
   *
   * 验收（d.272）之后「做完」不再等于「交付完成」，但概览只数未完成，
   * 组长会看到「0 项未完成」而漏掉「三件交上来等我验收」。
   */
  pendingReview: number;
  overdue: number;
  unassigned: number;
  blocked: number;
}

export function summarizeTeamTasks(
  tasks: readonly TeamTask[],
  now: number = Date.now(),
): TeamSummary {
  const byId = new Map(tasks.map((task) => [task.id, task]));
  const summary: TeamSummary = {
    open: 0,
    done: 0,
    pendingReview: 0,
    overdue: 0,
    unassigned: 0,
    blocked: 0,
  };
  for (const task of tasks) {
    if (task.status === "done") {
      summary.done += 1;
      // 只有显式的 pending 才算（d.275）：验收上线（d.272）之前完成的老任务没有这个字段，
      // 把它们算成「待验收」会让每个团队一进来就顶着几十条历史噪音。
      if (task.reviewState === "pending") summary.pendingReview += 1;
      continue;
    }
    summary.open += 1;
    if (task.assigneeId === null) summary.unassigned += 1;
    const due = task.dueAt === null || task.dueAt === undefined ? Number.NaN : Date.parse(task.dueAt);
    if (Number.isFinite(due) && due < now) summary.overdue += 1;
    const blocked = (task.blockedBy ?? []).some((id) => {
      const blocker = byId.get(id);
      return blocker !== undefined && blocker.status !== "done";
    });
    if (blocked) summary.blocked += 1;
  }
  return summary;
}

/** 一行字的概览；全清时也要说出来（「没有未完成」本身是有用信息）。 */
export function describeTeamSummary(summary: TeamSummary): string {
  const review = summary.pendingReview > 0 ? ` · 待验收 ${summary.pendingReview}` : "";
  if (summary.open === 0) {
    return summary.done === 0
      ? "还没有任务"
      : `没有未完成任务（已完成 ${summary.done} 项）${review}`;
  }
  const parts: string[] = [];
  if (summary.overdue > 0) parts.push(`逾期 ${summary.overdue}`);
  if (summary.unassigned > 0) parts.push(`待认领 ${summary.unassigned}`);
  if (summary.blocked > 0) parts.push(`被前置卡住 ${summary.blocked}`);
  const detail = parts.length === 0 ? "" : `（${parts.join("、")}）`;
  return `${summary.open} 项未完成${detail}${summary.done > 0 ? ` · 已完成 ${summary.done}` : ""}${review}`;
}
