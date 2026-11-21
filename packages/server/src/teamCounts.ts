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
 * - 被前置卡住 = 未完成且前置里还有没做完的；前置不存在（历史/导入脏数据）不算卡住。
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
    if (
      (task.blockedBy ?? []).some((id) => {
        const blocker = byId.get(id);
        // 不存在的 blocker（历史/导入的脏数据）不算「被阻塞」：?.status !== "done"
        // 会把缺失项判成阻塞，和 web 侧 teamSummary 的口径不一致。
        return blocker !== undefined && blocker.status !== "done";
      })
    ) {
      blocked += 1;
    }
  }
  return { counts: { open, done, overdue, unassigned, blocked }, perMember };
}

/**
 * 团队简报成员名单的排序口径（d.412.4.189）：组长恒在前，同类按中文名排序。
 *
 * 为什么两个 Store 必须共用这一段：web/teamBrief.ts 把成员名单 slice(0,10) 写进提示词，
 * 组长排在后面就会被截掉，模型便看不到「谁是组长」。此前内存实现显式组长在前，
 * 而 SQLite 实现用 `ORDER BY role ASC`（BINARY 下 "member" < "owner"）让组长垫底——
 * 同一 Store 契约、两份相反的排序。把口径收敛到这一个纯函数，杜绝再次漂移。
 *
 * 泛型保留调用方的额外字段（id / open 等），只按 displayName + role 排序，不入参修改。
 */
export function sortTeamBriefMembers<T extends { displayName: string; role: "owner" | "member" }>(
  members: readonly T[],
): T[] {
  return [...members].sort((a, b) =>
    a.role === b.role
      ? a.displayName.localeCompare(b.displayName, "zh-Hans-CN")
      : a.role === "owner"
        ? -1
        : 1,
  );
}
