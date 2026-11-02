/**
 * 常驻幕僚的数据模型与纯函数（d.48）。
 *
 * 本文件不读存储、不调模型、不碰 React：采集 → 规则简报 → 去重决策全在这里，
 * 便于用固定时间戳把「晨报只跑一次」「静默时段延后」「事件冷却」逐条钉死。
 *
 * 红线：议程条目里的 `conversationId` 是**归档库**的会话 id，不是和鸣会话 id，
 * 不能拿去 `openConversation`。所以事实里只保留日程 id，动作统一跳日程页。
 */

export const STAFF_SETTINGS_KEY = "heming.staff.v1";
export const STAFF_RUNS_KEY = "heming.staff.runs.v1";
export const STAFF_SEEN_KEY = "heming.staff.seen.v1";

// 日程临期判据与桌宠事件派生共用，已抽到 `lib/agendaBucket.ts`（避免 petEvent 拖进整个幕僚模型）。
// 这里 re-export 保持既有导入路径不变：`import { agendaBucket } from "./model.js"` 仍可用。
import { AGENDA_LOOKAHEAD_MS, agendaBucket, type AgendaBucket } from "../agendaBucket.js";
export { AGENDA_LOOKAHEAD_MS, agendaBucket };
export type { AgendaBucket };

/** 保留的简报份数（超出按开始时间淘汰最旧）。 */
export const MAX_STAFF_RUNS = 30;
/** 历史单键字节上限：localStorage 同源约 5MB，给任务/记忆留余量。 */
export const STAFF_RUNS_BYTE_LIMIT = 192 * 1024;
/** 去重账本每类上限（议程/任务各一份）。 */
export const MAX_SEEN = 200;

/** 任务「卡住」阈值：与任务区 `TASK_STALE_MS` 同口径（10 分钟无更新）。 */
export const TASK_STUCK_MS = 10 * 60 * 1000;
/** 失败任务只在最近 24 小时内提醒。 */
export const TASK_FAIL_WINDOW_MS = 24 * 60 * 60 * 1000;

/** 事件触发之间的冷却：避免同一批变化连续刷屏。 */
export const AUTO_COOLDOWN_MS = 10 * 60 * 1000;
/** 巡检 tick 与议程采集间隔。 */
export const STAFF_TICK_MS = 60_000;
export const STAFF_AGENDA_REFRESH_MS = 15 * 60 * 1000;
/** 单次模型总结的上限时间（超时回退规则模式）。 */
export const STAFF_LLM_TIMEOUT_MS = 25_000;

export const MAX_SUMMARY_CHARS = 200;
export const MAX_FINDING_TITLE_CHARS = 60;
export const MAX_FINDING_DETAIL_CHARS = 240;
export const MAX_LLM_TITLE_CHARS = 40;
export const MAX_LLM_DETAIL_CHARS = 160;
export const MAX_RULE_FINDINGS = 8;
export const MAX_STORED_FINDINGS = 12;
export const MAX_MERGED_FINDINGS = 10;
export const MAX_DAILY_RUN_CAP = 24;
export const MAX_DAILY_TOKEN_CAP = 1_000_000;

export type StaffTrigger = "manual" | "daily" | "agenda" | "task";
export type StaffRunMode = "rules" | "llm" | "fallback";
export type StaffSeverity = "urgent" | "warn" | "info";
export type TaskIssue = "stuck" | "failed";

export interface StaffSettings {
  enabled: boolean;
  dailyAt: string;
  quietFrom: string;
  quietTo: string;
  sources: { daily: boolean; agenda: boolean; task: boolean };
  profileId: string | null;
  dailyRunCap: number;
  dailyTokenCap: number;
  lastDailyDate: string | null;
}

export interface StaffEvidence {
  label: string;
  kind: "agenda" | "task";
  refId: string;
}

export interface StaffAction {
  kind: "open-infohub" | "open-task";
  targetId?: string;
  conversationId?: string;
}

export interface StaffFinding {
  id: string;
  severity: StaffSeverity;
  title: string;
  detail: string;
  evidence: StaffEvidence[];
  action?: StaffAction;
}

export interface StaffRun {
  id: string;
  trigger: StaffTrigger;
  mode: StaffRunMode;
  startedAt: number;
  finishedAt: number;
  summary: string;
  findings: StaffFinding[];
  tokens: number | null;
  error?: string;
}

export interface StaffSeen {
  agenda: Record<string, number>;
  tasks: Record<string, number>;
}

export interface StaffAgendaFact {
  refId: string;
  agendaId: number;
  bucket: AgendaBucket;
  title: string;
  detail: string;
  dueTs: number;
  dueText: string;
  convName: string;
  senderName: string;
  source: string;
}

export interface StaffTaskFact {
  refId: string;
  taskId: string;
  conversationId: string;
  title: string;
  issue: TaskIssue;
  updatedAt: number;
  error: string;
}

export interface StaffFacts {
  agenda: StaffAgendaFact[];
  tasks: StaffTaskFact[];
  running: number;
  totals: {
    overdue: number;
    today: number;
    next24h: number;
    stuck: number;
    failed: number;
  };
}

/** 采集输入的最小形状（`InfohubAgendaItem` 可直接传入）。 */
export interface StaffAgendaLike {
  id: number;
  title: string;
  detail?: string;
  dueTs: number;
  dueText?: string;
  convName?: string;
  senderName?: string;
  source?: string;
  status?: string;
}

/** 采集输入的最小形状（`TaskRecord` 可直接传入）。 */
export interface StaffTaskLike {
  id: string;
  conversationId: string;
  title: string;
  status: string;
  updatedAt: number;
  endedAt?: number;
  error?: string;
}

export const DEFAULT_STAFF_SETTINGS: StaffSettings = {
  enabled: false,
  dailyAt: "08:00",
  quietFrom: "22:00",
  quietTo: "07:30",
  sources: { daily: true, agenda: true, task: true },
  profileId: null,
  dailyRunCap: 8,
  dailyTokenCap: 30_000,
  lastDailyDate: null,
};

/** 按码点截断，避免切坏 emoji 的代理对。 */
export function clipText(text: string, max: number): string {
  const chars = [...String(text ?? "").replace(/\s+/g, " ").trim()];
  if (chars.length <= max) return chars.join("");
  return `${chars.slice(0, Math.max(0, max - 1)).join("")}…`;
}

function oneLine(text: unknown): string {
  return typeof text === "string" ? text.replace(/\s+/g, " ").trim() : "";
}

/** `HH:MM`（24 小时制）→ 时分；非法返回 null。 */
export function parseClock(value: string): { hours: number; minutes: number } | null {
  const match = /^(\d{1,2}):(\d{2})$/.exec(String(value ?? "").trim());
  if (!match) return null;
  const hours = Number(match[1]);
  const minutes = Number(match[2]);
  if (!Number.isInteger(hours) || !Number.isInteger(minutes)) return null;
  if (hours < 0 || hours > 23 || minutes < 0 || minutes > 59) return null;
  return { hours, minutes };
}

export function clockValue(hours: number, minutes: number): string {
  return `${String(hours).padStart(2, "0")}:${String(minutes).padStart(2, "0")}`;
}

/** 归一到 `HH:MM`；非法回退 fallback（设置读盘与表单共用）。 */
export function normalizeClock(value: unknown, fallback: string): string {
  const parsed = parseClock(String(value ?? ""));
  return parsed ? clockValue(parsed.hours, parsed.minutes) : fallback;
}

/** 本地日期键 `YYYY-MM-DD`。 */
export function todayKey(now: number = Date.now()): string {
  const d = new Date(now);
  const pad = (n: number) => String(n).padStart(2, "0");
  return `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())}`;
}

/** 某天（相对 now 偏移 offset 天）的 HH:MM 时间戳。 */
function atClock(now: number, clock: string, offsetDays = 0): number {
  const parsed = parseClock(clock);
  if (!parsed) return 0;
  const base = new Date(now);
  const d = new Date(base.getFullYear(), base.getMonth(), base.getDate() + offsetDays);
  d.setHours(parsed.hours, parsed.minutes, 0, 0);
  return d.getTime();
}

/** 静默时段是否覆盖 now（支持跨零点；from == to 视为不静默）。 */
export function inQuietHours(from: string, to: string, now: number): boolean {
  const a = parseClock(from);
  const b = parseClock(to);
  if (!a || !b) return false;
  const start = a.hours * 60 + a.minutes;
  const end = b.hours * 60 + b.minutes;
  if (start === end) return false;
  const d = new Date(now);
  const minute = d.getHours() * 60 + d.getMinutes();
  return start < end ? minute >= start && minute < end : minute >= start || minute < end;
}

/** 今天的晨报时刻；已过也返回今天的时间戳（调用方自己比较）。 */
export function dailyAtToday(settings: StaffSettings, now: number): number {
  return atClock(now, normalizeClock(settings.dailyAt, DEFAULT_STAFF_SETTINGS.dailyAt));
}

/** 下一次晨报时间：今天未跑且未到点 → 今天；否则明天。 */
export function nextDailyAt(settings: StaffSettings, now: number): number {
  if (settings.lastDailyDate !== todayKey(now)) {
    const today = dailyAtToday(settings, now);
    if (today > now) return today;
  }
  return atClock(now, settings.dailyAt, 1);
}

/** 晨报是否该跑：开着、今天没跑过、且已过设定时刻。 */
export function isDailyDue(settings: StaffSettings, now: number): boolean {
  if (!settings.sources.daily) return false;
  if (settings.lastDailyDate === todayKey(now)) return false;
  return now >= dailyAtToday(settings, now);
}

/** 今天的自动事件运行次数（晨报不计入事件上限）。 */
export function countAutoRunsToday(runs: StaffRun[], now: number): number {
  const key = todayKey(now);
  return runs.filter(
    (run) => run.trigger !== "manual" && run.trigger !== "daily" && todayKey(run.startedAt) === key,
  ).length;
}

/** 今天所有运行次数（含晨报与手动，用于界面展示）。 */
export function countRunsToday(runs: StaffRun[], now: number): number {
  const key = todayKey(now);
  return runs.filter((run) => todayKey(run.startedAt) === key).length;
}

/** 今天已消耗的 token（未上报的 null 不参与求和）。 */
export function tokensToday(runs: StaffRun[], now: number): number {
  const key = todayKey(now);
  return runs.reduce(
    (sum, run) => (todayKey(run.startedAt) === key && typeof run.tokens === "number" ? sum + run.tokens : sum),
    0,
  );
}

function lastEventRunAt(runs: StaffRun[]): number {
  let latest = 0;
  for (const run of runs) {
    if (run.trigger === "agenda" || run.trigger === "task") latest = Math.max(latest, run.startedAt);
  }
  return latest;
}

export function agendaKey(fact: Pick<StaffAgendaFact, "agendaId" | "bucket">): string {
  return `${fact.agendaId}:${fact.bucket}`;
}

export function taskKey(fact: Pick<StaffTaskFact, "taskId" | "issue" | "updatedAt">): string {
  return `${fact.taskId}:${fact.issue}:${fact.updatedAt}`;
}

/** 汇总事实（选中子集后重算计数）。 */
export function totalsOf(
  agenda: StaffAgendaFact[],
  tasks: StaffTaskFact[],
): StaffFacts["totals"] {
  const totals = { overdue: 0, today: 0, next24h: 0, stuck: 0, failed: 0 };
  for (const item of agenda) totals[item.bucket] += 1;
  for (const item of tasks) totals[item.issue] += 1;
  return totals;
}

/** 从议程与任务里捞出「值得说」的事实；确定性、不调模型。 */
export function collectFacts(
  input: { agenda?: readonly StaffAgendaLike[] | null; tasks?: readonly StaffTaskLike[] | null },
  now: number = Date.now(),
): StaffFacts {
  const agenda: StaffAgendaFact[] = [];
  for (const item of input.agenda ?? []) {
    // 归档已经只返回 open 条目；这里再挡一次已完成/取消，避免旧库直出时误报。
    if (item.status === "done" || item.status === "cancelled") continue;
    const bucket = agendaBucket(item.dueTs, now);
    if (!bucket) continue;
    agenda.push({
      refId: `agenda:${item.id}`,
      agendaId: item.id,
      bucket,
      title: oneLine(item.title) || "未命名日程",
      detail: oneLine(item.detail),
      dueTs: item.dueTs,
      dueText: oneLine(item.dueText),
      convName: oneLine(item.convName),
      senderName: oneLine(item.senderName),
      source: oneLine(item.source),
    });
  }
  agenda.sort((a, b) => a.dueTs - b.dueTs);

  const tasks: StaffTaskFact[] = [];
  let running = 0;
  for (const task of input.tasks ?? []) {
    if (task.status === "running") running += 1;
    const endedAt = task.endedAt ?? task.updatedAt;
    if (task.status === "running" && now - task.updatedAt > TASK_STUCK_MS) {
      tasks.push({
        refId: `task:${task.id}`,
        taskId: task.id,
        conversationId: task.conversationId,
        title: oneLine(task.title) || "未命名任务",
        issue: "stuck",
        updatedAt: task.updatedAt,
        error: "",
      });
      continue;
    }
    if (task.status === "failed" && now - endedAt <= TASK_FAIL_WINDOW_MS && now >= endedAt) {
      tasks.push({
        refId: `task:${task.id}`,
        taskId: task.id,
        conversationId: task.conversationId,
        title: oneLine(task.title) || "未命名任务",
        issue: "failed",
        updatedAt: task.updatedAt,
        error: oneLine(task.error),
      });
    }
  }
  tasks.sort((a, b) => a.updatedAt - b.updatedAt);

  return { agenda, tasks, running, totals: totalsOf(agenda, tasks) };
}

/** 按触发源挑事实：晨报/手动看全部，事件只看自己那一路。 */
export function selectFactsForTrigger(
  facts: StaffFacts,
  trigger: StaffTrigger,
): StaffFacts {
  const agenda = trigger === "task" ? [] : facts.agenda;
  const tasks = trigger === "agenda" ? [] : facts.tasks;
  return {
    agenda,
    tasks,
    running: facts.running,
    totals: totalsOf(agenda, tasks),
  };
}

/** 只留未提醒过的事实（事件触发用）。 */
export function filterUnseenFacts(facts: StaffFacts, seen: StaffSeen): StaffFacts {
  const agenda = facts.agenda.filter((item) => seen.agenda[agendaKey(item)] === undefined);
  const tasks = facts.tasks.filter((item) => seen.tasks[taskKey(item)] === undefined);
  return { agenda, tasks, running: facts.running, totals: totalsOf(agenda, tasks) };
}

/**
 * 按设置里的来源开关裁事实：关掉「日程临期」就不采集、不展示日程，
 * 晨报也不会偷偷把日程带回来。
 */
export function filterFactsBySources(facts: StaffFacts, settings: StaffSettings): StaffFacts {
  const agenda = settings.sources.agenda ? facts.agenda : [];
  const tasks = settings.sources.task ? facts.tasks : [];
  return { agenda, tasks, running: facts.running, totals: totalsOf(agenda, tasks) };
}

/** 本次运行覆盖到的去重键（成功落盘后写入账本）。 */
export function seenKeysOf(facts: StaffFacts): { agenda: string[]; tasks: string[] } {
  return {
    agenda: facts.agenda.map(agendaKey),
    tasks: facts.tasks.map(taskKey),
  };
}

const SEVERITY_RANK: Record<StaffSeverity, number> = { urgent: 0, warn: 1, info: 2 };

/** 按级别排序（stable：同级保持输入顺序，议程已按到期时间排好）。 */
export function sortFindings(findings: StaffFinding[]): StaffFinding[] {
  return [...findings].sort((a, b) => SEVERITY_RANK[a.severity] - SEVERITY_RANK[b.severity]);
}

function agendaFinding(item: StaffAgendaFact): StaffFinding {
  const prefix =
    item.bucket === "overdue" ? "已逾期：" : item.bucket === "today" ? "今天：" : "24 小时内：";
  const meta = [
    item.convName,
    item.dueText ? `原定 ${item.dueText}` : "",
    item.senderName,
  ]
    .filter(Boolean)
    .join(" · ");
  const detail = [meta, item.detail].filter(Boolean).join(" · ");
  return {
    id: `f-${item.refId}`,
    severity: item.bucket === "overdue" ? "urgent" : "warn",
    title: clipText(`${prefix}${item.title}`, MAX_FINDING_TITLE_CHARS),
    detail: clipText(detail || "来自本机归档的日程", MAX_FINDING_DETAIL_CHARS),
    evidence: [
      {
        label: item.convName ? `本机归档 · ${item.convName}` : "本机归档",
        kind: "agenda",
        refId: item.refId,
      },
    ],
    action: { kind: "open-infohub" },
  };
}

function taskFinding(item: StaffTaskFact, now: number): StaffFinding {
  const minutes = Math.max(1, Math.floor((now - item.updatedAt) / 60_000));
  const detail =
    item.issue === "stuck"
      ? `已 ${minutes} 分钟无更新`
      : item.error
        ? `失败原因：${item.error}`
        : "任务执行失败，可到通用智能体查看详情";
  return {
    id: `f-${item.refId}`,
    severity: "warn",
    title: clipText(
      item.issue === "stuck" ? `任务可能卡住：${item.title}` : `任务失败：${item.title}`,
      MAX_FINDING_TITLE_CHARS,
    ),
    detail: clipText(detail, MAX_FINDING_DETAIL_CHARS),
    evidence: [{ label: "通用智能体", kind: "task", refId: item.refId }],
    action: {
      kind: "open-task",
      targetId: item.taskId,
      ...(item.conversationId ? { conversationId: item.conversationId } : {}),
    },
  };
}

/** 规则模式的摘要（确定性，不含模型发挥）。 */
export function ruleSummary(facts: StaffFacts, trigger: StaffTrigger): string {
  const agenda = facts.agenda.length;
  const tasks = facts.tasks.length;
  const running = facts.running;
  if (trigger === "agenda") return `有 ${agenda} 条日程需要留意。`;
  if (trigger === "task") return `有 ${tasks} 个任务需要留意。`;
  if (agenda === 0 && tasks === 0) {
    return running > 0
      ? `今天没有临期事项，也没有异常任务；${running} 个任务进行中。`
      : "今天没有临期事项，也没有异常任务。";
  }
  const runningPart = running > 0 ? `；${running} 个任务进行中` : "";
  return clipText(
    `今天有 ${agenda} 条日程临期、${tasks} 个任务需要留意${runningPart}。`,
    MAX_SUMMARY_CHARS,
  );
}

/** 规则简报：findings 有上限，摘要与事实一一对应。 */
export function buildRuleBrief(
  facts: StaffFacts,
  trigger: StaffTrigger,
  now: number = Date.now(),
): { summary: string; findings: StaffFinding[] } {
  // 事件触发只看自己那一路：日程事件不该把任务问题顺带说一遍。
  const selected = selectFactsForTrigger(facts, trigger);
  const findings = sortFindings([
    ...selected.agenda.map(agendaFinding),
    ...selected.tasks.map((item) => taskFinding(item, now)),
  ]).slice(0, MAX_RULE_FINDINGS);
  return { summary: ruleSummary(selected, trigger), findings };
}

/**
 * 模型简报与规则简报的安全合并（d.48 §5.3）。
 *
 * 规则算出的 urgent/warn 若未被模型 `refs` 覆盖，强制补回——模型漏掉一条逾期日程
 * 是「少说」，不是「说错」，但后果一样：用户会以为没事。
 */
export function mergeLlmBrief(
  rule: { summary: string; findings: StaffFinding[] },
  llm: { summary?: string; findings: StaffFinding[] } | null,
): { summary: string; findings: StaffFinding[] } {
  if (!llm) return rule;
  const covered = new Set<string>();
  for (const finding of llm.findings) {
    for (const evidence of finding.evidence) covered.add(evidence.refId);
  }
  const forced = rule.findings.filter(
    (finding) =>
      (finding.severity === "urgent" || finding.severity === "warn") &&
      !finding.evidence.some((evidence) => covered.has(evidence.refId)),
  );
  // 强制项放前面再排序：同级别下先占位，截断时不会被模型条目挤掉。
  const findings = sortFindings([...forced, ...llm.findings]).slice(0, MAX_MERGED_FINDINGS);
  return {
    summary: clipText(llm.summary || rule.summary, MAX_SUMMARY_CHARS),
    findings,
  };
}

/** 调度决策：本 tick 该跑哪一路（null = 不跑）。 */
export type StaffTickDecision =
  | { kind: "none"; reason: "disabled" | "quiet-daily" | "cooldown" | "cap" | "nothing" }
  | { kind: "run"; trigger: "daily" | "agenda" | "task"; facts: StaffFacts };

/**
 * 单个 tick 的确定性决策。
 *
 * 优先级：晨报 > 日程事件 > 任务事件。晨报不看事件次数上限（每天至多一次），
 * 但静默时段内不跑（延后到静默结束后的第一个 tick）；事件不因静默停跑，
 * 只是不弹系统通知（由 runner 决定）。
 */
export function decideTick(input: {
  settings: StaffSettings;
  runs: StaffRun[];
  seen: StaffSeen;
  facts: StaffFacts;
  now: number;
}): StaffTickDecision {
  const { settings, runs, seen, facts, now } = input;
  if (!settings.enabled) return { kind: "none", reason: "disabled" };

  const dailyRanToday = runs.some(
    (run) => run.trigger === "daily" && todayKey(run.startedAt) === todayKey(now),
  );
  const dailyDue = isDailyDue(settings, now);
  if (dailyDue && !dailyRanToday) {
    if (inQuietHours(settings.quietFrom, settings.quietTo, now)) {
      return { kind: "none", reason: "quiet-daily" };
    }
    return {
      kind: "run",
      trigger: "daily",
      facts: selectFactsForTrigger(facts, "daily"),
    };
  }

  const eventSources = settings.sources.agenda || settings.sources.task;
  if (!eventSources) return { kind: "none", reason: "nothing" };
  if (countAutoRunsToday(runs, now) >= settings.dailyRunCap) {
    return { kind: "none", reason: "cap" };
  }
  if (now - lastEventRunAt(runs) < AUTO_COOLDOWN_MS) {
    return { kind: "none", reason: "cooldown" };
  }

  const fresh = filterUnseenFacts(facts, seen);
  if (settings.sources.agenda && fresh.agenda.length > 0) {
    return {
      kind: "run",
      trigger: "agenda",
      facts: selectFactsForTrigger(fresh, "agenda"),
    };
  }
  if (settings.sources.task && fresh.tasks.length > 0) {
    return {
      kind: "run",
      trigger: "task",
      facts: selectFactsForTrigger(fresh, "task"),
    };
  }
  return { kind: "none", reason: "nothing" };
}

/* ------------------------------------------------------------------ 归一 */

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function clampInt(value: unknown, min: number, max: number, fallback: number): number {
  const n = typeof value === "number" ? value : Number(value);
  if (!Number.isFinite(n)) return fallback;
  return Math.min(max, Math.max(min, Math.round(n)));
}

/** 设置归一：坏 JSON/非法时间/越界上限都夹回可用值，绝不把存储里的脏值带进调度。 */
export function normalizeSettings(raw: unknown): StaffSettings {
  const d = DEFAULT_STAFF_SETTINGS;
  if (!isRecord(raw)) {
    return { ...d, sources: { ...d.sources } };
  }
  const sources = isRecord(raw.sources) ? raw.sources : {};
  const lastDailyDate =
    typeof raw.lastDailyDate === "string" && /^\d{4}-\d{2}-\d{2}$/.test(raw.lastDailyDate)
      ? raw.lastDailyDate
      : null;
  return {
    enabled: raw.enabled === true,
    dailyAt: normalizeClock(raw.dailyAt, d.dailyAt),
    quietFrom: normalizeClock(raw.quietFrom, d.quietFrom),
    quietTo: normalizeClock(raw.quietTo, d.quietTo),
    sources: {
      daily: sources.daily !== false,
      agenda: sources.agenda !== false,
      task: sources.task !== false,
    },
    profileId: typeof raw.profileId === "string" && raw.profileId.trim() ? raw.profileId : null,
    dailyRunCap: clampInt(raw.dailyRunCap, 1, MAX_DAILY_RUN_CAP, d.dailyRunCap),
    dailyTokenCap: clampInt(raw.dailyTokenCap, 0, MAX_DAILY_TOKEN_CAP, d.dailyTokenCap),
    lastDailyDate,
  };
}

export function normalizeFinding(raw: unknown): StaffFinding | null {
  if (!isRecord(raw)) return null;
  const id = typeof raw.id === "string" ? raw.id.trim() : "";
  const title = clipText(oneLine(raw.title), MAX_FINDING_TITLE_CHARS);
  if (!id || !title) return null;
  const severity =
    raw.severity === "urgent" || raw.severity === "warn" || raw.severity === "info"
      ? raw.severity
      : null;
  if (!severity) return null;
  const evidence = Array.isArray(raw.evidence)
    ? raw.evidence
        .filter(isRecord)
        .filter(
          (e) =>
            typeof e.refId === "string" &&
            (e.kind === "agenda" || e.kind === "task"),
        )
        .map((e) => ({
          label: clipText(oneLine(e.label), 40),
          kind: e.kind as "agenda" | "task",
          refId: String(e.refId),
        }))
        .slice(0, 4)
    : [];
  let action: StaffAction | undefined;
  if (isRecord(raw.action)) {
    if (raw.action.kind === "open-infohub" || raw.action.kind === "open-task") {
      action = {
        kind: raw.action.kind,
        ...(typeof raw.action.targetId === "string" ? { targetId: raw.action.targetId } : {}),
        ...(typeof raw.action.conversationId === "string"
          ? { conversationId: raw.action.conversationId }
          : {}),
      };
    }
  }
  return {
    id,
    severity,
    title,
    detail: clipText(oneLine(raw.detail), MAX_FINDING_DETAIL_CHARS),
    evidence,
    ...(action ? { action } : {}),
  };
}

export function normalizeRun(raw: unknown): StaffRun | null {
  if (!isRecord(raw)) return null;
  const id = typeof raw.id === "string" ? raw.id.trim() : "";
  if (!id) return null;
  const trigger =
    raw.trigger === "manual" ||
    raw.trigger === "daily" ||
    raw.trigger === "agenda" ||
    raw.trigger === "task"
      ? raw.trigger
      : null;
  if (!trigger) return null;
  const mode =
    raw.mode === "rules" || raw.mode === "llm" || raw.mode === "fallback" ? raw.mode : null;
  if (!mode) return null;
  if (typeof raw.startedAt !== "number" || !Number.isFinite(raw.startedAt)) return null;
  const finishedAt =
    typeof raw.finishedAt === "number" && Number.isFinite(raw.finishedAt)
      ? raw.finishedAt
      : raw.startedAt;
  const findings = Array.isArray(raw.findings)
    ? raw.findings
        .map(normalizeFinding)
        .filter((f): f is StaffFinding => f !== null)
        .slice(0, MAX_STORED_FINDINGS)
    : [];
  return {
    id,
    trigger,
    mode,
    startedAt: raw.startedAt,
    finishedAt,
    summary: clipText(oneLine(raw.summary), MAX_SUMMARY_CHARS),
    findings,
    tokens: typeof raw.tokens === "number" && Number.isFinite(raw.tokens) ? raw.tokens : null,
    ...(typeof raw.error === "string" && raw.error
      ? { error: clipText(raw.error, MAX_SUMMARY_CHARS) }
      : {}),
  };
}

/** 条数 + 字节双重淘汰（最新在前）。 */
export function pruneRuns(
  runs: StaffRun[],
  limit = STAFF_RUNS_BYTE_LIMIT,
): StaffRun[] {
  const next = [...runs].sort((a, b) => b.startedAt - a.startedAt).slice(0, MAX_STAFF_RUNS);
  let bytes = new TextEncoder().encode(JSON.stringify(next)).length;
  while (bytes > limit && next.length > 1) {
    next.pop();
    bytes = new TextEncoder().encode(JSON.stringify(next)).length;
  }
  return bytes > limit ? [] : next;
}

function normalizeSeenBucket(raw: unknown): Record<string, number> {
  const out: Record<string, number> = {};
  if (!isRecord(raw)) return out;
  for (const [key, value] of Object.entries(raw)) {
    if (!key || typeof value !== "number" || !Number.isFinite(value) || value <= 0) continue;
    out[key] = value;
  }
  return out;
}

/** 账本淘汰：每类只留最近提醒的 200 条。 */
export function pruneSeen(seen: StaffSeen): StaffSeen {
  const keep = (bucket: Record<string, number>): Record<string, number> => {
    const entries = Object.entries(bucket)
      .sort((a, b) => b[1] - a[1])
      .slice(0, MAX_SEEN);
    return Object.fromEntries(entries);
  };
  return { agenda: keep(seen.agenda), tasks: keep(seen.tasks) };
}

/** 账本归一：键不可读/损坏 → 空账本（宁可多提醒一次，不漏）。 */
export function normalizeSeen(raw: unknown): StaffSeen {
  if (!isRecord(raw)) return { agenda: {}, tasks: {} };
  return pruneSeen({
    agenda: normalizeSeenBucket(raw.agenda),
    tasks: normalizeSeenBucket(raw.tasks),
  });
}

/** 把本次覆盖到的键写入账本（值 = 提醒时间）。 */
export function markSeenKeys(
  seen: StaffSeen,
  keys: { agenda: string[]; tasks: string[] },
  now: number,
): StaffSeen {
  const agenda = { ...seen.agenda };
  const tasks = { ...seen.tasks };
  for (const key of keys.agenda) agenda[key] = now;
  for (const key of keys.tasks) tasks[key] = now;
  return pruneSeen({ agenda, tasks });
}

/* ------------------------------------------------------------------ 展示 */

export function formatStaffTime(ms: number): string {
  if (!Number.isFinite(ms)) return "—";
  const d = new Date(ms);
  if (Number.isNaN(d.getTime())) return "—";
  const pad = (n: number) => String(n).padStart(2, "0");
  return `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())} ${pad(d.getHours())}:${pad(d.getMinutes())}`;
}

export function triggerLabel(trigger: StaffTrigger): string {
  switch (trigger) {
    case "manual":
      return "手动";
    case "daily":
      return "晨报";
    case "agenda":
      return "日程";
    case "task":
      return "任务";
  }
}

export function modeLabel(mode: StaffRunMode): string {
  if (mode === "llm") return "模型";
  if (mode === "fallback") return "回退规则";
  return "规则";
}

export function severityLabel(severity: StaffSeverity): string {
  if (severity === "urgent") return "紧急";
  if (severity === "warn") return "留意";
  return "提示";
}

/** 界面上「下次检查」的一句话。 */
export function describeNextCheck(settings: StaffSettings, now: number): string {
  if (!settings.enabled) return "已关闭";
  const parts: string[] = [];
  if (settings.sources.agenda || settings.sources.task) parts.push("每 15 分钟巡检");
  if (settings.sources.daily) {
    const quiet = inQuietHours(settings.quietFrom, settings.quietTo, now);
    if (settings.lastDailyDate === todayKey(now)) {
      parts.push(`明天 ${settings.dailyAt} 晨报`);
    } else if (quiet && isDailyDue(settings, now)) {
      parts.push(`静默结束后（${settings.quietTo}）晨报`);
    } else if (now < dailyAtToday(settings, now)) {
      parts.push(`今天 ${settings.dailyAt} 晨报`);
    } else {
      parts.push("晨报即将开始");
    }
  }
  return parts.length > 0 ? parts.join(" · ") : "没有启用的触发源";
}
