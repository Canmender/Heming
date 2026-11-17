/**
 * 任务多久没动过（d.251）。
 *
 * 任务板上最常见的漏网之鱼不是「逾期的任务」（有截止时间才标得出来），
 * 而是**没有截止时间、也没人碰过**的任务：它不红、不响，就一直挂在那里。
 * 这里只做一件事——根据 `updatedAt` 算出「多久没动」，超过阈值就标出来，
 * 让组长知道该去问一声，而不是每周五才发现某件事从头到尾没人接。
 *
 * 口径：
 * - 只看**未完成**的任务（做完的不用再催）；
 * - 用 `updatedAt`（服务端在状态/负责人/内容变更时都会刷新），不另存一份「最后动作」；
 * - 天数按自然日向下取整，今天改过的算 0 天。
 */

import type { TeamItemStatus, TeamTask } from "@heming/shared";

/** 超过这么多天没动，就在任务行上标一句（3 天是「一个工作周期内没人碰」的直觉线）。 */
export const STALE_TASK_DAYS = 3;

export interface TaskAge {
  /** 距离最后更新过去了几天（自然日，向下取整；认不出时间时为 null）。 */
  days: number | null;
  /** 是否超过阈值仍未完成。 */
  stale: boolean;
}

function isOpen(status: TeamItemStatus): boolean {
  return status !== "done";
}

/** 自然日差：同一自然天内为 0，跨一天为 1。 */
export function daysSince(iso: string | null | undefined, now: number): number | null {
  if (!iso) return null;
  const at = Date.parse(iso);
  if (Number.isNaN(at)) return null;
  const from = new Date(at);
  const to = new Date(now);
  const start = Date.UTC(from.getFullYear(), from.getMonth(), from.getDate());
  const end = Date.UTC(to.getFullYear(), to.getMonth(), to.getDate());
  const days = Math.round((end - start) / 86_400_000);
  return days < 0 ? 0 : days;
}

export function taskAge(task: Pick<TeamTask, "status" | "updatedAt">, now: number): TaskAge {
  const days = daysSince(task.updatedAt, now);
  return { days, stale: isOpen(task.status) && days !== null && days >= STALE_TASK_DAYS };
}

/**
 * 任务行上那句话：`今天更新` / `3 天前更新` / `6 天没动了`。
 * 返回 null 表示没什么可说的（做完的任务、或时间认不出）——不要为了占位写一句废话。
 */
export function describeTaskAge(
  task: Pick<TeamTask, "status" | "updatedAt">,
  now: number,
): string | null {
  const age = taskAge(task, now);
  if (age.days === null) return null;
  if (!isOpen(task.status)) return null;
  if (age.days === 0) return "今天更新";
  if (age.stale) return `${age.days} 天没动了`;
  return `${age.days} 天前更新`;
}
