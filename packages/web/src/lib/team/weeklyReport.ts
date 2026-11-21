import type { TeamTask, TeamWorkspaceSnapshot } from "@heming/shared";
import { blockingTask } from "./digest.js";
import { isOverdue } from "./findTasks.js";
import { memberLoads } from "./load.js";

/**
 * 团队周报成稿（d.269）.
 *
 * 与 `digest.ts` 的分工：digest 是**给模型看的**事实清单（「先调这个再组织话」），
 * 这里是**给人看的**成稿——组长要把这一周汇报上去、发到群里、贴进周会材料，
 * 需要一份能直接复制走的 Markdown，而不是一串待组织的要点。
 *
 * 口径（与 digest 一致，避免同一个团队两套数字）：
 * - 「N 天」是自然时间窗：完成看 `completedAt`、新增看 `createdAt`；
 * - 已完成的任务不再算逾期（拖延统计与风险统计分开）；
 * - 被前置挡住只数**未完成的前置**；
 * - 只陈述事实与可执行的建议，不替组长决定派给谁、也不编造进度。
 */
export const REPORT_DEFAULT_DAYS = 7;
export const REPORT_MAX_DAYS = 30;
/** 每个清单最多列几条，超出用「还有 N 项」收口（周报要能扫完，不是全量台账）。 */
export const REPORT_LIST_MAX = 8;

export interface WeeklyReportOptions {
  /** 当前时刻，默认 `Date.now()`；测试里固定它。 */
  now?: number;
  /** 回看天数：默认 7，夹在 1–30。 */
  days?: number;
  /** 把 userId 变成「林晓（@linxiao）」；缺省直接用 id。 */
  memberName?: (userId: string) => string;
  /** 报告大标题里的团队名；缺省取 `snapshot.team.name`。 */
  title?: string;
}

const PRIORITY_MARK: Record<string, string> = { high: "【高】", normal: "", low: "【低】" };

function oneLine(text: string | undefined | null, max = 60): string {
  const flat = (text ?? "").replace(/\s+/g, " ").trim();
  if (flat === "") return "";
  return flat.length > max ? `${flat.slice(0, max)}…` : flat;
}

function dateText(iso: string | null | undefined): string {
  if (!iso) return "—";
  const time = Date.parse(iso);
  if (Number.isNaN(time)) return "—";
  const d = new Date(time);
  const mm = String(d.getMonth() + 1).padStart(2, "0");
  const dd = String(d.getDate()).padStart(2, "0");
  return `${mm}-${dd}`;
}

function fullDateText(time: number): string {
  const d = new Date(time);
  const yyyy = d.getFullYear();
  const mm = String(d.getMonth() + 1).padStart(2, "0");
  const dd = String(d.getDate()).padStart(2, "0");
  const hh = String(d.getHours()).padStart(2, "0");
  const mi = String(d.getMinutes()).padStart(2, "0");
  return `${yyyy}-${mm}-${dd} ${hh}:${mi}`;
}

const DAY_MS = 86_400_000;

/** 当天 0 点（本地时区）：与 schedule 同口径，按日历日而不是满 24 小时。 */
function startOfDay(ms: number): number {
  const d = new Date(ms);
  d.setHours(0, 0, 0, 0);
  return d.getTime();
}

function dueText(task: TeamTask, now: number): string {
  if (!task.dueAt) return "";
  const time = Date.parse(task.dueAt);
  if (Number.isNaN(time)) return "";
  // 是否已过期用原始时间戳判断：Math.ceil(-1h/24h) === -0，而 -0 < 0 为 false，
  // 旧实现会把「几小时前刚过截止」误标成「今天到期」，与 isOverdue 口径矛盾。
  if (time <= now) {
    // 逾期天数按日历日算（与 schedule.bucketOf 一致）：16 号到期、18 号生成 → 2 天。
    // 不再用滚动 24 小时向上取整（那样 51 小时会被算成 3 天，和 digest 对不上）。
    const days = Math.round((startOfDay(now) - startOfDay(time)) / DAY_MS);
    return `（已逾期 ${Math.max(1, days)} 天）`;
  }
  // 未过期也按日历日算（与上面的逾期口径一致）：今天晚些时候到期就是「今天到期」。
  // 旧写法 Math.ceil((time-now)/DAY_MS) 对正数恒 ≥1，「今天到期」是永不可达的死分支；
  // 且滚动 24 小时会跨本地零点多报一天（明天 09:00 到期、今天 08:00 生成 → 3 天）。
  // Math.round 让 DST 的 23/25 小时日仍落回整数天。
  const left = Math.round((startOfDay(time) - startOfDay(now)) / DAY_MS);
  if (left <= 0) return "（今天到期）";
  return `（还剩 ${left} 天）`;
}

function nameOf(userId: string | null | undefined, options: WeeklyReportOptions): string {
  if (!userId) return "未指派";
  return options.memberName ? options.memberName(userId) : userId;
}

function clampDays(days: number | undefined): number {
  if (days === undefined || !Number.isFinite(days)) return REPORT_DEFAULT_DAYS;
  return Math.min(REPORT_MAX_DAYS, Math.max(1, Math.round(days)));
}

function rankOf(task: TeamTask): number {
  if (task.priority === "high") return 0;
  if (task.priority === "low") return 2;
  return 1;
}

function sortOpen(tasks: TeamTask[]): TeamTask[] {
  return [...tasks].sort((a, b) => {
    const byRank = rankOf(a) - rankOf(b);
    if (byRank !== 0) return byRank;
    const aDue = a.dueAt ? Date.parse(a.dueAt) : Number.POSITIVE_INFINITY;
    const bDue = b.dueAt ? Date.parse(b.dueAt) : Number.POSITIVE_INFINITY;
    if (aDue !== bDue) return aDue - bDue;
    return Date.parse(b.updatedAt) - Date.parse(a.updatedAt);
  });
}

function listCap<T>(rows: T[], render: (row: T) => string, emptyText: string): string[] {
  if (rows.length === 0) return [`- ${emptyText}`];
  const shown = rows.slice(0, REPORT_LIST_MAX).map(render);
  if (rows.length > REPORT_LIST_MAX) {
    shown.push(`- 还有 ${rows.length - REPORT_LIST_MAX} 项没列出来（在团队页的任务板里看完整清单）。`);
  }
  return shown;
}

/**
 * 把一份团队快照写成可直接复制的周报 Markdown。
 *
 * @returns 以单个换行结尾的 Markdown 文本（复制/落盘都省一次补换行）。
 */
export function weeklyReportMarkdown(
  snapshot: TeamWorkspaceSnapshot,
  options: WeeklyReportOptions = {},
): string {
  const now = options.now ?? Date.now();
  const days = clampDays(options.days);
  const since = now - days * 86_400_000;
  const byId = new Map(snapshot.tasks.map((t) => [t.id, t]));
  const open = snapshot.tasks.filter((t) => t.status !== "done");
  const done = snapshot.tasks.filter((t) => t.status === "done");

  const completedInWindow = done.filter((t) => {
    if (!t.completedAt) return false;
    const at = Date.parse(t.completedAt);
    return !Number.isNaN(at) && at >= since && at <= now;
  });
  const createdInWindow = snapshot.tasks.filter((t) => {
    const at = Date.parse(t.createdAt);
    return !Number.isNaN(at) && at >= since && at <= now;
  });
  const overdue = open.filter((t) => isOverdue(t, now));
  const unassigned = open.filter((t) => t.assigneeId === null);
  const highOpen = open.filter((t) => t.priority === "high");
  const blocked = open.filter((t) => blockingTask(t, byId) !== null);
  const nudged = open.filter((t) => (t.nudgeCount ?? 0) > 0 && t.nudgedAt);

  const loads = memberLoads(snapshot.tasks, now);
  const title = options.title ?? snapshot.team.name;

  const lines: string[] = [];
  lines.push(`# 团队周报 · ${title}`);
  lines.push("");
  lines.push(
    `> ${dateText(new Date(since).toISOString())} ~ ${dateText(new Date(now).toISOString())}（${days} 天） · 由和鸣生成于 ${fullDateText(now)}`,
  );
  lines.push("");
  if (snapshot.team.goal.trim() !== "") {
    lines.push(`**团队目标**：${oneLine(snapshot.team.goal, 120)}`);
    lines.push("");
  }

  lines.push("## 概况");
  lines.push("");
  lines.push(
    `- 任务：共 ${snapshot.tasks.length} 项（未完成 ${open.length} / 已完成 ${done.length}）`,
  );
  lines.push(`- 这 ${days} 天：新建 ${createdInWindow.length} 项、完成 ${completedInWindow.length} 项`);
  const flags: string[] = [];
  if (overdue.length > 0) flags.push(`逾期 ${overdue.length}`);
  if (unassigned.length > 0) flags.push(`待认领 ${unassigned.length}`);
  if (highOpen.length > 0) flags.push(`高优先级未完成 ${highOpen.length}`);
  if (blocked.length > 0) flags.push(`被前置挡着 ${blocked.length}`);
  lines.push(`- 需要盯：${flags.length > 0 ? flags.join("、") : "没有异常"}`);
  lines.push("");

  lines.push(`## 这 ${days} 天完成的（${completedInWindow.length}）`);
  lines.push("");
  lines.push(
    ...listCap(
      [...completedInWindow].sort((a, b) => Date.parse(b.completedAt ?? "") - Date.parse(a.completedAt ?? "")),
      (t) => {
        const conclusion = oneLine(t.result, 80);
        const who = nameOf(t.completedBy ?? t.assigneeId, options);
        const when = dateText(t.completedAt);
        return `- ${t.title}${conclusion === "" ? "" : ` —— 结论：${conclusion}`}（${who}，${when}）`;
      },
      "这段时间没有完成的任务。",
    ),
  );
  lines.push("");

  lines.push(`## 进行中（${open.length}）`);
  lines.push("");
  lines.push(
    ...listCap(
      sortOpen(open),
      (t) =>
        `- ${PRIORITY_MARK[t.priority ?? "normal"] ?? ""}${t.title} · ${nameOf(t.assigneeId, options)}${
          t.dueAt ? ` · 截止 ${dateText(t.dueAt)}${dueText(t, now)}` : ""
        }`,
      "没有未完成的任务。",
    ),
  );
  lines.push("");

  lines.push("## 需要关注");
  lines.push("");
  lines.push(
    "**待验收**",
    ...listCap(
      done.filter((t) => t.reviewState === "pending"),
      (t) => `- ${t.title} · ${nameOf(t.assigneeId, options)}${t.result ? ` · 结论：${oneLine(t.result, 40)}` : ""}`,
      "没有交上来待看的任务。",
    ),
    "",
    "**逾期**",
    ...listCap(
      overdue,
      (t) => `- ${t.title} · ${nameOf(t.assigneeId, options)} · 截止 ${dateText(t.dueAt)}${dueText(t, now)}`,
      "没有逾期任务。",
    ),
    "",
    "**待认领**",
    ...listCap(
      unassigned,
      (t) => `- ${t.title}（创建于 ${dateText(t.createdAt)}）`,
      "没有待认领的任务。",
    ),
    "",
    "**被前置挡住**",
    ...listCap(
      blocked,
      (t) => {
        const blocker = blockingTask(t, byId);
        return `- ${t.title} 被「${blocker?.title ?? "未完成的前置"}」挡住`;
      },
      "没有被前置挡住的任务。",
    ),
    "",
    "**催过还没动**",
    ...listCap(
      nudged,
      (t) => `- ${t.title} · ${nameOf(t.assigneeId, options)} · 组长催过 ${t.nudgeCount ?? 0} 次（最近 ${dateText(t.nudgedAt)}）`,
      "没有被催过还没动的任务。",
    ),
  );
  lines.push("");

  lines.push("## 成员负荷");
  lines.push("");
  if (snapshot.members.length === 0) {
    lines.push("- 团队还没有成员。");
  } else {
    lines.push("| 成员 | 未完成 | 其中逾期 |");
    lines.push("| --- | --- | --- |");
    for (const member of snapshot.members) {
      const load = loads.get(member.user.id) ?? { open: 0, overdue: 0 };
      lines.push(`| ${nameOf(member.user.id, options)} | ${load.open} | ${load.overdue} |`);
    }
  }
  lines.push("");

  lines.push("## 下周建议");
  lines.push("");
  const advice: string[] = [];
  if (overdue.length > 0) advice.push(`先把 ${overdue.length} 项逾期的收尾或改期，别让它继续拖着。`);
  if (unassigned.length > 0) advice.push(`${unassigned.length} 项还没人认领，派下去或让成员自己领。`);
  if (highOpen.length > 0) advice.push(`还有 ${highOpen.length} 项高优先级没完成，优先排这些。`);
  if (blocked.length > 0) advice.push(`${blocked.length} 项被前置挡着，先推进前置任务。`);
  if (nudged.length > 0) advice.push(`${nudged.length} 项催过还没动，问清是卡在哪还是需要换人。`);
  if (advice.length === 0) advice.push("这一周没有异常，保持节奏。");
  lines.push(...advice.map((text) => `- ${text}`));
  lines.push("");

  return lines.join("\n");
}

/** 周报文件名：`团队周报-团队名-20261118.md`（去非法字符，供导出桥/下载使用）。 */
export function weeklyReportFileName(title: string, at: number): string {
  const clean = title
    .replace(/[\\/:*?"<>|]/g, "-")
    // eslint-disable-next-line no-control-regex
    .replace(/[\u0000-\u001f]/g, "")
    .replace(/\s+/g, "")
    .replace(/-+/g, "-")
    .replace(/^-+|-+$/g, "")
    .slice(0, 40);
  const d = new Date(at);
  const stamp = `${d.getFullYear()}${String(d.getMonth() + 1).padStart(2, "0")}${String(d.getDate()).padStart(2, "0")}`;
  return `团队周报-${clean === "" ? "team" : clean}-${stamp}.md`;
}
