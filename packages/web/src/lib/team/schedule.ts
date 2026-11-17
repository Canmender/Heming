import type { TeamTask } from "@heming/shared";

/**
 * 按截止日看团队任务（d.277）。
 *
 * 任务板是按状态和负责人分的（未完成/待验收/按人看），回答的是「谁在做什么」；
 * 组长每天真正要问的是「今天谁该交什么、哪件已经拖了」。这两件事不是一回事：
 * 未完成的任务里既有今天到期的，也有下周以后的。
 *
 * 这里只做分组，不改任务本身；`done` 的任务不进来（已交的不该占「今天要交」的位置，
 * 待验收请走任务板的「待验收」筛选，那里带结论摘要更方便看）。
 */

export type ScheduleBucketKey = "overdue" | "today" | "tomorrow" | "week" | "later" | "none";

export interface ScheduleBucket {
  key: ScheduleBucketKey;
  label: string;
  hint: string;
  tasks: TeamTask[];
}

/** 分组展示顺序：先看已经拖的，再看今天，最后才是「没定截止」这种要靠自觉的。 */
export const SCHEDULE_BUCKET_ORDER: readonly ScheduleBucketKey[] = [
  "overdue",
  "today",
  "tomorrow",
  "week",
  "later",
  "none",
];

export const SCHEDULE_LABEL: Record<ScheduleBucketKey, string> = {
  overdue: "已逾期",
  today: "今天到期",
  tomorrow: "明天到期",
  week: "本周内到期",
  later: "下周以后",
  none: "没定截止",
};

export const SCHEDULE_HINT: Record<ScheduleBucketKey, string> = {
  overdue: "先补一句真实进展，或者跟组长说清楚要不要调整时间",
  today: "今天要交的，别等被催",
  tomorrow: "明天到期，今天收个尾比较稳",
  week: "这周内到期",
  later: "不那么急，但别忘",
  none: "没有截止日期的活容易被无限往后拖：约个时间再去掉这一档",
};

const DAY_MS = 24 * 60 * 60 * 1000;

/** 当天 0 点（本地时区）：按「日历日」比较，而不是按满 24 小时。 */
export function startOfDay(ms: number): number {
  const date = new Date(ms);
  date.setHours(0, 0, 0, 0);
  return date.getTime();
}

/** 一件任务属于哪一档；`done` 返回 null（不进这个视图），截止日无效算「没定截止」。 */
export function bucketOf(task: TeamTask, now: number = Date.now()): ScheduleBucketKey | null {
  if (task.status === "done") return null;
  const due = task.dueAt ? Date.parse(task.dueAt) : Number.NaN;
  if (!Number.isFinite(due)) return "none";
  const days = Math.round((startOfDay(due) - startOfDay(now)) / DAY_MS);
  if (days < 0) return "overdue";
  if (days === 0) return "today";
  if (days === 1) return "tomorrow";
  if (days <= 7) return "week";
  return "later";
}

/** 分组（空档不出现，顺序固定）。 */
export function scheduleBuckets(tasks: readonly TeamTask[], now: number = Date.now()): ScheduleBucket[] {
  const grouped = new Map<ScheduleBucketKey, TeamTask[]>();
  for (const task of tasks) {
    const key = bucketOf(task, now);
    if (key === null) continue;
    const list = grouped.get(key);
    if (list === undefined) grouped.set(key, [task]);
    else list.push(task);
  }
  return SCHEDULE_BUCKET_ORDER.flatMap((key) => {
    const list = grouped.get(key);
    if (list === undefined || list.length === 0) return [];
    return [{ key, label: SCHEDULE_LABEL[key], hint: SCHEDULE_HINT[key], tasks: list }];
  });
}

/** 一行摘要：「2 件已逾期 · 3 件今天到期 · 1 件没定截止」。 */
export function describeSchedule(buckets: readonly ScheduleBucket[]): string {
  if (buckets.length === 0) return "";
  return buckets.map((bucket) => `${bucket.tasks.length} 件${bucket.label}`).join(" · ");
}

/** 单个任务的截止说明：逾期按天算，近期给「今天/明天」，远期给月日。 */
export function dueText(task: TeamTask, now: number = Date.now()): string {
  const due = task.dueAt ? Date.parse(task.dueAt) : Number.NaN;
  if (!Number.isFinite(due)) return "没定截止";
  const key = bucketOf(task, now);
  const days = Math.round((startOfDay(due) - startOfDay(now)) / DAY_MS);
  if (key === "overdue") return `逾期 ${Math.abs(days)} 天`;
  if (key === "today") return "今天到期";
  if (key === "tomorrow") return "明天到期";
  const date = new Date(due);
  return `${date.getMonth() + 1} 月 ${date.getDate()} 日`;
}
