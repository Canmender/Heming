import type { TeamTask, TeamWorkspaceSnapshot } from "@heming/shared";
import { isOverdue } from "./findTasks.js";
import { memberLoads } from "./load.js";

/**
 * 团队复盘摘要（d.267）.
 *
 * 问题：团队功能到 d.266 已经能派、能认领、能退、能催、能找，但「这周团队到底怎么样」仍然要人一条条看：
 * 界面上有进度行与徽标，却拼不出「完成了什么、谁在忙、什么卡住了」；智能体要对周报类问题作答，
 * 只能自己把整份任务清单读一遍再手工统计，既费上下文又容易算错。
 *
 * 做法：把统计放在纯函数里（可测、不会编），智能体只负责把算好的事实组织成话。
 * 口径：
 * - 「N 天」按自然时间窗，只看 `completedAt` 落在窗口内的完成、`createdAt` 落在窗口内的新增；
 * - 已完成的任务不再算逾期（避免「拖延统计」和「风险统计」混在一起）；
 * - 被前置任务挡着的判断只数**未完成的前置**，前置本身完成了就不算挡；
 * - 摘要只陈述事实 + 给可执行的下一步，不替组长决定派给谁。
 */

export const DIGEST_DEFAULT_DAYS = 7;
export const DIGEST_MAX_DAYS = 30;
/** 每个列表最多列几条，超出的用「还有 N 件」收口（给模型省上下文，也让人扫得完）。 */
export const DIGEST_LIST_MAX = 6;

export interface DigestOptions {
  /** 当前时刻，默认 `Date.now()`；测试里固定它。 */
  now?: number;
  /** 回看天数：默认 7，夹在 1–30。 */
  days?: number;
  /** 把 userId 变成「林晓（@linxiao）」；缺省直接用 id。 */
  memberName?: (userId: string) => string;
}

function oneLine(text: string | undefined | null, max = 60): string {
  const flat = (text ?? "").replace(/\s+/g, " ").trim();
  if (flat === "") return "";
  return flat.length > max ? `${flat.slice(0, max)}…` : flat;
}

function dayText(iso: string | null | undefined): string {
  if (!iso) return "—";
  const time = Date.parse(iso);
  if (Number.isNaN(time)) return "—";
  const d = new Date(time);
  const mm = String(d.getMonth() + 1).padStart(2, "0");
  const dd = String(d.getDate()).padStart(2, "0");
  return `${mm}-${dd}`;
}

function daysBetween(from: string | null | undefined, now: number): number | null {
  if (!from) return null;
  const time = Date.parse(from);
  if (Number.isNaN(time)) return null;
  return Math.max(0, Math.floor((now - time) / 86_400_000));
}

function nameOf(userId: string | null | undefined, options: DigestOptions): string {
  if (!userId) return "未指派";
  return options.memberName ? options.memberName(userId) : userId;
}

/** 这条任务是否被未完成的前置任务挡着；返回挡人的任务标题（取第一条）。 */
export function blockingTask(task: TeamTask, byId: Map<string, TeamTask>): TeamTask | null {
  for (const id of task.blockedBy ?? []) {
    const blocker = byId.get(id);
    if (blocker && blocker.status !== "done") return blocker;
  }
  return null;
}

/** 近 N 天被标记完成、且带交付结论的任务（给复盘当证据）。 */
export function completedInWindow(
  tasks: readonly TeamTask[],
  { now = Date.now(), days = DIGEST_DEFAULT_DAYS }: DigestOptions = {},
): TeamTask[] {
  const span = Math.max(1, Math.min(DIGEST_MAX_DAYS, Math.floor(days))) * 86_400_000;
  return tasks
    .filter((task) => {
      if (task.status !== "done") return false;
      const at = Date.parse(task.completedAt ?? task.updatedAt);
      if (Number.isNaN(at)) return false;
      return now - at <= span && at <= now;
    })
    .sort((a, b) => Date.parse(b.completedAt ?? b.updatedAt) - Date.parse(a.completedAt ?? a.updatedAt));
}

/** 近 N 天新建的任务数。 */
export function createdInWindow(
  tasks: readonly TeamTask[],
  { now = Date.now(), days = DIGEST_DEFAULT_DAYS }: DigestOptions = {},
): number {
  const span = Math.max(1, Math.min(DIGEST_MAX_DAYS, Math.floor(days))) * 86_400_000;
  return tasks.filter((task) => {
    const at = Date.parse(task.createdAt);
    return !Number.isNaN(at) && now - at <= span && at <= now;
  }).length;
}

/**
 * 生成「给组长看」的团队复盘摘要。空团队也返回一段可读文本（带下一步），不返回空串。
 */
export function buildTeamDigest(
  snapshot: TeamWorkspaceSnapshot,
  options: DigestOptions = {},
): string {
  const now = options.now ?? Date.now();
  const days = Math.max(1, Math.min(DIGEST_MAX_DAYS, Math.floor(options.days ?? DIGEST_DEFAULT_DAYS)));
  const tasks = snapshot.tasks;
  const byId = new Map(tasks.map((task) => [task.id, task]));
  const lines: string[] = [];

  const open = tasks.filter((task) => task.status !== "done");
  const done = tasks.filter((task) => task.status === "done");
  const overdue = open.filter((task) => isOverdue(task, now));
  const unassigned = open.filter((task) => task.assigneeId === null);
  const blocked = open
    .map((task) => ({ task, blocker: blockingTask(task, byId) }))
    .filter((x): x is { task: TeamTask; blocker: TeamTask } => x.blocker !== null);

  lines.push(
    `团队「${snapshot.team.name}」近 ${days} 天概览（截至 ${dayText(new Date(now).toISOString())}）：任务 ${tasks.length} 件（未完成 ${open.length} / 已完成 ${done.length}）；逾期 ${overdue.length}；待认领 ${unassigned.length}；被前置任务挡着 ${blocked.length}；这 ${days} 天新建 ${createdInWindow(tasks, { now, days })} 件、完成 ${completedInWindow(tasks, { now, days }).length} 件。`,
  );

  if (snapshot.team.goal.trim() !== "") lines.push(`团队目标：${snapshot.team.goal}`);

  const finished = completedInWindow(tasks, { now, days });
  if (finished.length === 0) {
    lines.push(`\n这 ${days} 天没有任务被标记完成。`);
  } else {
    lines.push(`\n这 ${days} 天完成：`);
    for (const task of finished.slice(0, DIGEST_LIST_MAX)) {
      const conclusion = oneLine(task.result, 70);
      lines.push(`- ${task.title}（${nameOf(task.completedBy ?? task.assigneeId, options)}，${dayText(task.completedAt ?? task.updatedAt)}）${conclusion === "" ? "" : `：${conclusion}`}`);
    }
    if (finished.length > DIGEST_LIST_MAX) lines.push(`- 还有 ${finished.length - DIGEST_LIST_MAX} 件没列出来`);
  }

  const loads = memberLoads(tasks, now);
  if (snapshot.members.length > 0) {
    lines.push("\n按人看：");
    for (const member of snapshot.members) {
      const name = nameOf(member.user.id, options);
      const load = loads.get(member.user.id) ?? { open: 0, overdue: 0 };
      const mineDone = finished.filter((task) => (task.completedBy ?? task.assigneeId) === member.user.id).length;
      const mineOpen = open.filter((task) => task.assigneeId === member.user.id);
      const doing = mineOpen.filter((task) => task.status === "doing").length;
      const todo = mineOpen.filter((task) => task.status !== "doing").length;
      lines.push(
        `- ${name}${member.role === "owner" ? "（队长）" : ""}：这 ${days} 天完成 ${mineDone}，手上未完成 ${LoadText(load.open, load.overdue)}${doing > 0 ? `，其中在做 ${doing}` : ""}${todo > 0 ? `、未开始 ${todo}` : ""}`,
      );
    }
  }

  const attention: string[] = [];
  // 待验收（d.275）：交上来的活卡在「没人看」这一步，不解决就永远不算交付；排在优先级之前。
  const pendingReview = done.filter((task) => task.reviewState === "pending");
  for (const task of pendingReview.slice(0, DIGEST_LIST_MAX)) {
    attention.push(
      `- 待验收：${task.title}（${nameOf(task.assigneeId, options)}已交${task.result ? `：${oneLine(task.result, 40)}` : ""}）`,
    );
  }
  if (pendingReview.length > DIGEST_LIST_MAX) {
    attention.push(`- 另有 ${pendingReview.length - DIGEST_LIST_MAX} 件待验收`);
  }
  // 优先级（d.268）：高优先级未完成的事先摆出来——复盘时最该先看到的就是「哪些是急的」。
  const highOpen = open.filter((task) => task.priority === "high");
  for (const task of highOpen.slice(0, DIGEST_LIST_MAX)) {
    attention.push(
      `- 高优先级：${task.title}（${nameOf(task.assigneeId, options)}${task.status === "doing" ? "，在做" : ""}）`,
    );
  }
  if (highOpen.length > DIGEST_LIST_MAX) {
    attention.push(`- 另有 ${highOpen.length - DIGEST_LIST_MAX} 件高优先级任务`);
  }
  for (const task of overdue.slice(0, DIGEST_LIST_MAX)) {
    const late = daysBetween(task.dueAt, now);
    attention.push(
      `- 逾期 ${late === null ? "" : `${late} 天`}：${task.title}（${nameOf(task.assigneeId, options)}，截止 ${dayText(task.dueAt)}${task.nudgeCount ? `，已催 ${task.nudgeCount} 次` : ""}）`,
    );
  }
  if (overdue.length > DIGEST_LIST_MAX) attention.push(`- 另有 ${overdue.length - DIGEST_LIST_MAX} 件逾期`);

  const returned = open.filter((task) => (task.returnedAt ?? "") !== "" && (task.assigneeId === null || task.assigneeId === ""));
  for (const task of returned.slice(0, DIGEST_LIST_MAX)) {
    attention.push(`- 被退回待重新安排：${task.title}（原因：${oneLine(task.returnNote, 50) || "未写"}）`);
  }

  for (const { task, blocker } of blocked.slice(0, DIGEST_LIST_MAX)) {
    attention.push(`- 等前置：${task.title} 要等「${blocker.title}」完成（当前负责人：${nameOf(blocker.assigneeId, options)}）`);
  }

  const nudgedStale = open.filter(
    (task) =>
      (task.nudgeCount ?? 0) > 0 &&
      (task.nudgedAt ?? "") !== "" &&
      Date.parse(task.updatedAt) <= Date.parse(task.nudgedAt ?? ""),
  );
  for (const task of nudgedStale.slice(0, DIGEST_LIST_MAX)) {
    attention.push(`- 催过没动：${task.title}（催了 ${task.nudgeCount} 次，负责人 ${nameOf(task.assigneeId, options)}）`);
  }

  const unassignedList = unassigned.slice(0, DIGEST_LIST_MAX);
  for (const task of unassignedList) {
    if (returned.includes(task)) continue;
    attention.push(`- 待认领：${task.title}${task.dueAt ? `（截止 ${dayText(task.dueAt)}）` : ""}`);
  }

  if (attention.length === 0) {
    lines.push("\n需要关注：没有逾期、没有退回、没有被前置挡住的任务。");
  } else {
    lines.push("\n需要关注：");
    lines.push(...attention);
  }

  lines.push(
    "\n下一步（按需要选，不要一次全做）：team_task_update 指派/改派；team_task_nudge 催一下；team_task_find 找具体某条；team_task_update 写进展或结论。",
  );
  return lines.join("\n");
}

function LoadText(open: number, overdue: number): string {
  if (open === 0) return "没有";
  return overdue > 0 ? `${open} 件（${overdue} 件逾期）` : `${open} 件`;
}
