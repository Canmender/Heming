import type { TeamActivity } from "@heming/shared";

/** 任务状态 → 中文（与 `lib/team/share.ts` 上报的 detail 同源）。 */
const TASK_STATUS_TEXT: Record<string, string> = {
  running: "进行中",
  done: "已完成",
  failed: "失败",
  cancelled: "已中断",
};

/** 日程到期档位 → 中文（与 `lib/team/share.ts` 上报的 detail 同源）。 */
const AGENDA_STATUS_TEXT: Record<string, string> = {
  overdue: "已逾期",
  today: "今天到期",
  next24h: "24 小时内到期",
};

/**
 * 动向/看板/日程的摘要标签：只由 `kind + status` 派生，**绝不回显 `detail` 自由文本**。
 *
 * 为什么不用 detail：契约里 `detail` 是客户端可自填的 ≤500 字字符串，服务端在形状上
 * 无法证明「只收摘要」；显示层改为从 `status` 派生后，即使旧数据或第三方客户端夹带了
 * 正文，也不会露在团队页/看板/日程里。旧数据里认不出的状态就不显示这一行（只留标题）。
 */
export function activitySummaryLabel(
  activity: Pick<TeamActivity, "kind" | "status">,
): string {
  if (activity.kind === "task") {
    const text = activity.status ? TASK_STATUS_TEXT[activity.status] : "";
    return text ? `任务 · ${text}` : "";
  }
  if (activity.kind === "agenda") {
    const text = activity.status ? AGENDA_STATUS_TEXT[activity.status] : "";
    return text ? `日程 · ${text}` : "";
  }
  return "";
}

/** 任务类动向的标题占位词：与 `lib/team/share.ts` 的 `TASK_ACTIVITY_TITLE` 同一个词。 */
const TASK_ACTIVITY_TITLE = "任务";

/**
 * 动向的**标题列**：任务类不回显 `title`，改用状态摘要。
 *
 * 为什么：任务动向的 `title` 历史上是「用户提问的第一行」（`tasks/store.ts` 的
 * `taskTitle`），把提示词露给了全站同事。新版客户端不再上传它、服务端也把 task 的
 * title 钉成固定占位词，但**历史行**还在库里——显示层按 kind 派生，旧行同样不会上屏。
 * 其它 kind（日程等）的 title 是用户自己写的日程标题，正常显示。
 */
export function activityTitle(activity: Pick<TeamActivity, "kind" | "status" | "title">): string {
  if (activity.kind === "task") return activitySummaryLabel(activity) || TASK_ACTIVITY_TITLE;
  return activity.title;
}

/**
 * 第二行的摘要：与标题重复时返回空串（任务类的标题本身就是状态摘要，
 * 再画一行「任务 · 已完成」只是噪音）。
 */
export function activitySummaryLine(
  activity: Pick<TeamActivity, "kind" | "status" | "title">,
): string {
  const summary = activitySummaryLabel(activity);
  return summary && summary !== activityTitle(activity) ? summary : "";
}
