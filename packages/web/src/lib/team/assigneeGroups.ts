/**
 * 按人看任务（d.250）。
 *
 * 任务板以前只有「未完成 / 全部 / 已完成」三档——组长想知道「谁手上压了几件、谁的逾期了」，
 * 只能一条条往下读负责人。这里把任务按负责人分好组，并算好每组未完成与逾期数，
 * 面板只负责画出来、按组筛。
 *
 * 口径：
 * - 组长排在最前（谁是创建者就是组长，判定见 `roles.ts`），其余按名字排，**待认领放最后**；
 * - 只列有任务的组（空组是噪音；「没人手上有活」这件事由面板自己说）；
 * - 截止时间已过且未完成才算逾期——已完成的任务不该继续标红。
 */

import type { TeamItemStatus, TeamTask } from "@heming/shared";

/** 待认领这一组在筛选项里的固定 key（真实用户 id 不会是它）。 */
export const UNASSIGNED_GROUP = "unassigned";

export type AssigneeGroupRole = "leader" | "member" | "unassigned";

export interface AssigneeGroup {
  /** 用户 id，或 `UNASSIGNED_GROUP`。 */
  key: string;
  name: string;
  role: AssigneeGroupRole;
  tasks: TeamTask[];
  /** 未完成（`todo` / `doing` / `blocked`）的条数。 */
  openCount: number;
  /** 已过期且未完成的条数。 */
  overdueCount: number;
}

export interface AssigneeMember {
  user: { id: string; displayName: string };
}

function isOpen(status: TeamItemStatus): boolean {
  return status !== "done";
}

/** 逾期：有截止时间、还没完成、且时间已经过去。 */
export function isTaskOverdue(task: Pick<TeamTask, "status" | "dueAt">, now: number): boolean {
  if (!isOpen(task.status) || !task.dueAt) return false;
  const at = Date.parse(task.dueAt);
  if (Number.isNaN(at)) return false;
  return at < now;
}

function compareTasks(a: TeamTask, b: TeamTask): number {
  const aDue = a.dueAt ? Date.parse(a.dueAt) : Number.POSITIVE_INFINITY;
  const bDue = b.dueAt ? Date.parse(b.dueAt) : Number.POSITIVE_INFINITY;
  if (aDue !== bDue) return aDue - bDue;
  return a.title.localeCompare(b.title, "zh-Hans-CN");
}

/** 任务按负责人分组；组内按截止时间由近到远。 */
export function groupTasksByAssignee(
  tasks: readonly TeamTask[],
  members: readonly AssigneeMember[],
  ownerId: string | null | undefined,
  now: number,
): AssigneeGroup[] {
  const nameOf = new Map<string, string>();
  for (const member of members) nameOf.set(member.user.id, member.user.displayName);

  const buckets = new Map<string, TeamTask[]>();
  for (const task of tasks) {
    const key = task.assigneeId ?? UNASSIGNED_GROUP;
    const list = buckets.get(key);
    if (list === undefined) buckets.set(key, [task]);
    else list.push(task);
  }

  const groups: AssigneeGroup[] = [];
  for (const [key, list] of buckets) {
    const unassigned = key === UNASSIGNED_GROUP;
    const role: AssigneeGroupRole = unassigned
      ? "unassigned"
      : ownerId !== null && ownerId !== undefined && key === ownerId
        ? "leader"
        : "member";
    const sorted = [...list].sort(compareTasks);
    groups.push({
      key,
      name: unassigned ? "待认领" : (nameOf.get(key) ?? "已退出的成员"),
      role,
      tasks: sorted,
      openCount: sorted.filter((task) => isOpen(task.status)).length,
      overdueCount: sorted.filter((task) => isTaskOverdue(task, now)).length,
    });
  }

  const rank: Record<AssigneeGroupRole, number> = { leader: 0, member: 1, unassigned: 2 };
  groups.sort((a, b) => {
    if (rank[a.role] !== rank[b.role]) return rank[a.role] - rank[b.role];
    return a.name.localeCompare(b.name, "zh-Hans-CN");
  });
  return groups;
}

/** 组头那行字：`2 项未完成 · 1 项逾期`（没有未完成的组不该出现在这里）。 */
export function describeAssigneeLoad(group: AssigneeGroup): string {
  const parts = [`${group.openCount} 项未完成`];
  if (group.overdueCount > 0) parts.push(`${group.overdueCount} 项逾期`);
  return parts.join(" · ");
}

/** 筛选项的完整标签：`韩梅梅 · 2 项未完成（1 项逾期）`。 */
export function assigneeFilterLabel(group: AssigneeGroup): string {
  const load = describeAssigneeLoad(group);
  return `${group.name} · ${load}`;
}
