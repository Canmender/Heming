/**
 * 「我的任务」角标（d.263）。
 *
 * 为什么需要：团队派活到 d.262 已经通了「组长派 → 对方智能体在下一轮看到」，
 * 但**人这边没有信号**——被派活的人只要不打开「我的任务」面板，就不知道自己名下有活；
 * 队长口头催一句才想起来。提示词里一直有这段内容，界面上却什么都没有，
 * 等于把「有没有活」这件事只交给了模型。
 *
 * 口径：
 * - 只数**未完成**的（服务端 `/api/team/my-tasks` 本来就只回未完成的）；
 * - 「派到我名下」与「队里待认领」分开显示：两件事不一样，混成一个数字会让人以为都被指派给自己；
 * - 超过 99 显示 `99+`：角标是提示，不是精确计数器（精确数字在面板里）。
 */

/** 角标最多显示到这个数，再多就是 `99+`。 */
export const MY_TASK_BADGE_MAX = 99;

export interface MyTaskBadge {
  /** 派到我名下、还没完成的条数。 */
  assigned: number;
  /** 队里还没人认领、我可以接的条数。 */
  claimable: number;
  /** 两者之和（为 0 时不显示角标）。 */
  total: number;
}

function safeCount(n: unknown): number {
  return typeof n === "number" && Number.isFinite(n) && n > 0 ? Math.floor(n) : 0;
}

/** 两个列表 → 角标数据（列表长度即条数，不解析内容）。 */
export function summarizeMyTasks(
  assigned: readonly unknown[],
  claimable: readonly unknown[],
): MyTaskBadge {
  const a = safeCount(assigned.length);
  const c = safeCount(claimable.length);
  return { assigned: a, claimable: c, total: a + c };
}

function cap(n: number): string {
  return n > MY_TASK_BADGE_MAX ? `${MY_TASK_BADGE_MAX}+` : String(n);
}

/** 角标文字：`3 项待办` / `2 项可接` / `3 项待办 · 2 项可接`；没活时空串。 */
export function myTaskBadgeText(badge: MyTaskBadge): string {
  const parts: string[] = [];
  if (badge.assigned > 0) parts.push(`${cap(badge.assigned)} 项待办`);
  if (badge.claimable > 0) parts.push(`${cap(badge.claimable)} 项可接`);
  return parts.join(" · ");
}

/**
 * 按钮的无障碍名字。
 *
 * 角标本身是 `aria-hidden`（视觉提示），所以「有几条活」这件事必须写进 label，
 * 否则读屏用户只知道有个「我的任务」按钮、不知道有事等着。
 */
export function myTaskButtonLabel(badge: MyTaskBadge | null): string {
  if (badge === null || badge.total <= 0) return "我的任务";
  const text = myTaskBadgeText(badge);
  return text === "" ? "我的任务" : `我的任务：${text}`;
}
