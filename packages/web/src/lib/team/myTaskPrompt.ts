import type { AssignedTeamTask } from "./assignedTasks.js";
import {
  ASSIGNED_TASK_STATUS_TEXT,
  describeBlockers,
  describeDue,
} from "./assignedTasks.js";

/**
 * 「我的任务」入口（d.259）：把一条派到名下的团队任务变成一条用户消息。
 *
 * 为什么要有这一层：d.248 起每轮开场都会把「派到我名下的任务」写进提示词，
 * 但那只解决「它知道有活」；用户真正想干的是**点一下让和鸣接着做这一条**——
 * 不用自己复述需求，也不用怕漏了 deadline 或前置。
 *
 * 这里只负责把事实拼成话：需求原文、截止、还没做完的前置、以及 d.252 定下的
 * 交付规矩（done + result）。不替用户决定该不该做——做不了要如实说。
 */

/** 任务卡片的副标题：团队 · 状态 · 截止 · 前置（都没有时就只剩团队名）。 */
export function describeMyTaskMeta(item: AssignedTeamTask, now: number = Date.now()): string {
  const parts: string[] = [item.teamName];
  const status = item.task.status;
  if (status === "todo" || status === "doing") parts.push(ASSIGNED_TASK_STATUS_TEXT[status]);
  const due = describeDue(item.task.dueAt, now);
  if (due) parts.push(due);
  const blocked = describeBlockers(item.openBlockers);
  if (blocked) parts.push(blocked);
  return parts.join(" · ");
}

/** 把任务变成一条可以直接发送的用户消息。 */
export function buildMyTaskPrompt(item: AssignedTeamTask, now: number = Date.now()): string {
  const detail = item.task.detail.trim();
  const lines = [
    "请接着做这条团队任务：",
    `- 团队：${item.teamName}`,
    `- 任务 id：${item.task.id}`,
    `- 标题：${item.task.title}`,
    `- 需求：${detail === "" ? "（没写需求说明，先用 team_get 看完整上下文）" : detail}`,
  ];
  const due = describeDue(item.task.dueAt, now);
  if (due !== "") lines.push(`- 截止：${due}`);
  const blocked = describeBlockers(item.openBlockers);
  if (blocked !== "") lines.push(`- 注意：${blocked}（先确认前置是不是真的做完了）`);
  const returned = (item.task.returnNote ?? "").trim();
  if (item.task.returnedAt && returned !== "") {
    lines.push(`- 上一个负责人退回时说过：${returned}`);
  }
  const nudgeCount = item.task.nudgeCount ?? 0;
  if (item.task.nudgedAt && nudgeCount > 0) {
    lines.push(
      `- 组长催过 ${nudgeCount} 次（最近一次 ${new Date(item.task.nudgedAt).toLocaleString("zh-CN")}）：先说明现在进展、什么时候能交；做不动就按上面的规矩退回。`,
    );
  }
  // 验收（d.272）：被组长打回过，就把要改的地方摆在最前面，别让它当成新任务重做一遍。
  if ((item.task.reviewState ?? "") === "changes" && (item.task.reviewNote ?? "").trim() !== "") {
    lines.push(`- 组长打回了这一版：${item.task.reviewNote!.trim()}（按这个改；改完再标完成，会重新进入待验收）`);
  }
  const progress = (item.task.progress ?? "").trim();
  if (item.task.progressAt && progress !== "") {
    lines.push(`- 上次进展：${progress}（先接着它往下做，不要从头重来）`);
  }
  lines.push(
    "",
    "先用 team_get 看这条任务的完整信息，再用 team_task_comments 看任务讨论里有没有新留言（问口径、补约束都写在那边，别只看需求说明就开工）；做完用 team_task_update 把状态改成 done，并用 result 写一句结论（做成什么样、怎么验证的、交付物在哪）。",
    "中间有疑问或要补一条约束，就用 team_task_comment 在任务下留一句，不要自己猜。",
    "如果这条不该由你来做，说明原因并建议改派给谁，不要硬做。",
  );
  return lines.join("\n");
}

/**
 * 待认领的活（d.260）：先认领再动手，不能没归属就直接标完成。
 *
 * 为什么单独一条：留空的派活本来就没有负责人，直接开做会让别人同时开做、
 * 直接标 done 又让组长看不出是谁交的——所以第一步必须是认领。
 */
export function buildClaimTaskPrompt(item: AssignedTeamTask, now: number = Date.now()): string {
  const detail = item.task.detail.trim();
  const lines = [
    "队里有一条还没人认领的团队任务，请你先认领，再把它做掉：",
    `- 团队：${item.teamName}`,
    `- 任务 id：${item.task.id}`,
    `- 标题：${item.task.title}`,
    `- 需求：${detail === "" ? "（没写需求说明，先用 team_get 看完整上下文）" : detail}`,
  ];
  const due = describeDue(item.task.dueAt, now);
  if (due !== "") lines.push(`- 截止：${due}`);
  const blocked = describeBlockers(item.openBlockers);
  if (blocked !== "") lines.push(`- 注意：${blocked}（先确认前置是不是真的做完了）`);
  const returned = (item.task.returnNote ?? "").trim();
  if (item.task.returnedAt && returned !== "") {
    lines.push(`- 上一个负责人退回时说过：${returned}`);
  }
  const progress = (item.task.progress ?? "").trim();
  if (item.task.progressAt && progress !== "") {
    lines.push(`- 上次进展：${progress}（先接着它往下做，不要从头重来）`);
  }
  lines.push(
    "",
    "第一步先认领：用 team_task_update 把这条任务的 assignee_id 设成你自己——否则别人可能同时开做，而且组长看不出这条活归谁。认领失败就说明原因，不要硬做。",
    "认领之后再按团队规矩做：先 team_get 看完整信息，做完把状态改成 done 并用 result 写一句结论（做成什么样、怎么验证的、交付物在哪）。",
    "做到一半就在 progress 里留一句当前进展（做到哪、卡在哪），下一轮你自己和组长都看得到。",
    "如果这条不该由你做，说明原因并把它留给更合适的人，不要占着这条活。",
  );
  return lines.join("\n");
}
