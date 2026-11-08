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
