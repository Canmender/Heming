/**
 * 日程「临期」分级（纯函数）。
 *
 * 为什么单独成文件（d.58 性能收口）：同一个判据有两类消费者——
 * 幕僚巡检（`lib/staff/model.ts`）与桌宠事件派生（`lib/petEvent.ts`）。
 * 后者是**桌宠事件协议层**，只为一个 6 行函数不该把 30KB 的 `staff/model`
 * 整条依赖图拖进两个 HTML 入口（实测过 petEvent 块 261KB raw / 82.8KB gzip，
 * 被 index.html 与 pet.html 同时预载）。
 *
 * 真源仍只有这一处：判据改了这里改，调用方不要各自抄一份
 * （两边对「临期」的定义一旦分叉，幕僚说有事、桌宠说没事，用户只会觉得都不可信）。
 */

/** 日程「临期」窗口：24 小时。 */
export const AGENDA_LOOKAHEAD_MS = 24 * 60 * 60 * 1000;

/** 日程分级：逾期 / 今天 / 24 小时内。 */
export type AgendaBucket = "overdue" | "today" | "next24h";

/**
 * 本地时区里的日程分级：逾期 > 今天 > 24 小时内；更远返回 null。
 *
 * @param dueTs 到期时间戳（epoch ms）
 * @param now 当前时间戳（epoch ms）
 */
export function agendaBucket(dueTs: number, now: number): AgendaBucket | null {
  if (!Number.isFinite(dueTs) || dueTs <= 0) return null;
  if (dueTs < now) return "overdue";
  const d = new Date(dueTs);
  const n = new Date(now);
  const sameDay =
    d.getFullYear() === n.getFullYear() &&
    d.getMonth() === n.getMonth() &&
    d.getDate() === n.getDate();
  if (sameDay) return "today";
  if (dueTs <= now + AGENDA_LOOKAHEAD_MS) return "next24h";
  return null;
}
