/**
 * 派到我名下、还没完成的团队任务（d.248）。
 *
 * 为什么需要它：团队任务的 `assigneeId` 之前只是一行数据——组长把活儿派给谁，
 * 谁的智能体完全不知道，得用户自己想起来去团队页看一眼。这一段把「被派的活儿」
 * 直接写进对方智能体的提示词：一开口就知道自己名下有什么、先看哪件。
 *
 * 这里只做「读 + 说人话」，不做权限判断：能不能派给别人、能不能改状态
 * 由服务端（组长才能派别人）与 `capability/teamTools.ts` 负责。
 */

export interface AssignedTeamTask {
  teamId: string;
  teamName: string;
  /** 还没完成的前置任务（d.255）：非空说明这条活儿现在还不该开始。 */
  openBlockers?: { id: string; title: string }[];
  task: {
    id: string;
    title: string;
    detail: string;
    status: "todo" | "doing" | "done";
    dueAt: string | null;
    assigneeId: string | null;
    /** 退回原因与退回时刻（d.261）：非空说明这条活是被退回来的，认领前先看看为什么。 */
    returnNote?: string;
    returnedAt?: string | null;
    returnedBy?: string | null;
    /** 最新进展（d.262）：接着做之前先看看做到哪了。 */
    progress?: string;
    progressAt?: string | null;
    progressBy?: string | null;
  /** 催办痕迹（d.265）：最近一次催办的时刻、催办人、累计次数。 */
  nudgedAt?: string | null;
  nudgedBy?: string | null;
  nudgeCount?: number;
    /** 验收（d.272）：changes = 被组长打回，reviewNote 里写着要改什么。 */
    reviewState?: "pending" | "approved" | "changes";
    reviewNote?: string;
  };
}

/** 提示词里最多列几项（再多就换一句话说「还有 N 项」）。 */
export const ASSIGNED_TASK_LINES_MAX = 6;
/** 标题上限（按码点，超了补省略号）：提示词要短，详情让它自己 `team_get`。 */
export const ASSIGNED_TASK_TITLE_MAX = 48;
/** 可用状态文案（模型看的是「在做」还是「没开始」，决定先干什么）。 */
export const ASSIGNED_TASK_STATUS_TEXT: Record<"todo" | "doing", string> = {
  todo: "未开始",
  doing: "在做",
};

const DAY_MS = 24 * 60 * 60 * 1000;

function clip(text: string, max: number): string {
  const chars = [...text];
  return chars.length <= max ? text : `${chars.slice(0, max).join("")}…`;
}

/** 截止时间的说法：今天 / 明天 / N 天后 / 已过期 N 天；没定或认不出返回空串。 */
export function describeDue(dueAt: string | null, now: number = Date.now()): string {
  if (dueAt === null || dueAt === "") return "";
  const at = Date.parse(dueAt);
  if (Number.isNaN(at)) return "";
  const days = Math.floor((at - now) / DAY_MS);
  if (days < 0) return `已过期 ${-days} 天`;
  if (days === 0) return "今天截止";
  if (days === 1) return "明天截止";
  return `${days} 天后截止`;
}

/** 还没完成的前置任务怎么说（d.255）：空数组/缺省 → 空串。 */
export function describeBlockers(blockers: readonly { id: string; title: string }[] | undefined): string {
  if (blockers === undefined || blockers.length === 0) return "";
  const names = blockers.map((item) => `「${clip(item.title, ASSIGNED_TASK_TITLE_MAX)}」`);
  const listed = names.slice(0, 2).join("");
  const rest = names.length > 2 ? `等 ${names.length} 项` : "";
  return `前置还没完成：等${listed}${rest}做完`;
}

/** 一项一行：`团队名 · 标题（在做，明天截止）`，有未完成前置时再缀一句。 */
export function formatAssignedTask(item: AssignedTeamTask, now: number = Date.now()): string {
  const status = item.task.status === "doing" ? ASSIGNED_TASK_STATUS_TEXT.doing : ASSIGNED_TASK_STATUS_TEXT.todo;
  const due = describeDue(item.task.dueAt, now);
  const tail = due === "" ? status : `${status}，${due}`;
  const team = item.teamName.trim() === "" ? "未命名团队" : item.teamName.trim();
  const blocked = describeBlockers(item.openBlockers);
  const line = `${team} · ${clip(item.task.title, ASSIGNED_TASK_TITLE_MAX)}（${tail}）`;
  return blocked === "" ? line : `${line}；${blocked}`;
}

/** 待认领段落最多列几项（d.260）：只提示「有活可以接」，不替用户排优先级。 */
export const CLAIMABLE_TASK_LINES_MAX = 4;

/** 提示词用的行：最多 6 项，多出来的用一句话交代清楚。 */
export function describeAssignedTasks(
  tasks: readonly AssignedTeamTask[],
  now: number = Date.now(),
): string[] {
  if (tasks.length === 0) return [];
  const lines = tasks.slice(0, ASSIGNED_TASK_LINES_MAX).map((item) => formatAssignedTask(item, now));
  if (tasks.length > ASSIGNED_TASK_LINES_MAX) {
    lines.push(`还有 ${tasks.length - ASSIGNED_TASK_LINES_MAX} 项没列出来（用 team_get 看完整清单）。`);
  }
  return lines;
}

/** 待认领一项一行：`团队名 · 标题（待认领，明天截止）`，有未完成前置时再缀一句。 */
export function formatClaimableTask(item: AssignedTeamTask, now: number = Date.now()): string {
  const due = describeDue(item.task.dueAt, now);
  const tail = due === "" ? "待认领" : `待认领，${due}`;
  const team = item.teamName.trim() === "" ? "未命名团队" : item.teamName.trim();
  const blocked = describeBlockers(item.openBlockers);
  const line = `${team} · ${clip(item.task.title, ASSIGNED_TASK_TITLE_MAX)}（${tail}）`;
  return blocked === "" ? line : `${line}；${blocked}`;
}

/** 待认领段落：最多 4 项，多出来的用一句话交代清楚。 */
export function describeClaimableTasks(
  tasks: readonly AssignedTeamTask[],
  now: number = Date.now(),
): string[] {
  if (tasks.length === 0) return [];
  const lines = tasks
    .slice(0, CLAIMABLE_TASK_LINES_MAX)
    .map((item) => formatClaimableTask(item, now));
  if (tasks.length > CLAIMABLE_TASK_LINES_MAX) {
    lines.push(`还有 ${tasks.length - CLAIMABLE_TASK_LINES_MAX} 项待认领的活（用 team_get 看完整清单）。`);
  }
  return lines;
}
