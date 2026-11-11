/**
 * 本机自动化任务模型（d.47）。
 *
 * 自动化只做白名单里的 InfoHub 本机动作：不同步到服务端、不执行任意脚本、
 * 不携带密钥。所有时间与频率都在本地时区解释。
 */

import {
  AUTOMATION_KINDS,
  isAutomationKind,
  kindMeta,
  type AutomationKind,
} from "./kinds.js";

/** 动作白名单的唯一来源是 kinds.ts；这里 re-export 保持既有 import 路径可用。 */
export type { AutomationKind } from "./kinds.js";

export type AutomationRunStatus = "ok" | "error" | "skipped";

export interface SyncOptions {
  sources: ("qq" | "wechat")[];
  full: boolean;
  archive: boolean;
}

export type AutomationSchedule =
  | { type: "daily"; time: string; weekdays: number[] }
  | { type: "interval"; minutes: number };

export interface AutomationTask {
  id: string;
  name: string;
  kind: AutomationKind;
  enabled: boolean;
  schedule: AutomationSchedule;
  sync: SyncOptions;
  createdAt: number;
  updatedAt: number;
  nextRunAt: number;
  lastRunAt?: number;
  lastStatus?: AutomationRunStatus;
  lastDetail?: string;
  runCount: number;
}

/** 新建/编辑表单提交的形状（id 与运行态由 store 维护）。 */
export interface AutomationDraft {
  name: string;
  kind: AutomationKind;
  schedule: AutomationSchedule;
  sync: SyncOptions;
}

export const MAX_AUTOMATIONS = 20;
export const MAX_NAME_CHARS = 40;
export const MAX_DETAIL_CHARS = 160;
export const MIN_INTERVAL_MINUTES = 5;
export const MAX_INTERVAL_MINUTES = 1440;

export const ALL_WEEKDAYS = [1, 2, 3, 4, 5, 6, 0] as const;
export const WEEKDAY_LABEL: Record<number, string> = {
  1: "一",
  2: "二",
  3: "三",
  4: "四",
  5: "五",
  6: "六",
  0: "日",
};

export const DEFAULT_SYNC: SyncOptions = {
  sources: ["qq", "wechat"],
  full: false,
  archive: false,
};

export const DEFAULT_DRAFT: AutomationDraft = {
  name: "同步本机归档",
  kind: "infohub.sync",
  schedule: { type: "daily", time: "09:00", weekdays: [...ALL_WEEKDAYS] },
  sync: { ...DEFAULT_SYNC, sources: [...DEFAULT_SYNC.sources] },
};

type RecordLike = Record<string, unknown>;

function isPlainObject(value: unknown): value is RecordLike {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

export function clipText(text: string, max: number): string {
  const chars = [...String(text ?? "").replace(/\s+/g, " ").trim()];
  if (chars.length <= max) return chars.join("");
  return `${chars.slice(0, Math.max(0, max - 1)).join("")}…`;
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

/** 去重、只留 0–6、升序；空集合按「每天」处理，避免永远不触发。 */
export function normalizeWeekdays(value: unknown): number[] {
  const days =
    Array.isArray(value)
      ? [...new Set(value.filter((n): n is number => Number.isInteger(n) && n >= 0 && n <= 6))]
      : [];
  return days.length ? days.sort((a, b) => a - b) : [0, 1, 2, 3, 4, 5, 6];
}

/** 本地时区的下一次每日触发；严格晚于 `from`。 */
function nextDailyRun(time: string, weekdays: number[], from: number): number {
  const parsed = parseClock(time) ?? { hours: 9, minutes: 0 };
  const days = normalizeWeekdays(weekdays);
  for (let offset = 0; offset <= 7; offset += 1) {
    const candidate = new Date(from);
    candidate.setDate(candidate.getDate() + offset);
    candidate.setHours(parsed.hours, parsed.minutes, 0, 0);
    if (candidate.getTime() > from && days.includes(candidate.getDay())) {
      return candidate.getTime();
    }
  }
  // 一周内必有匹配；理论上到不了这里，保底顺延一天。
  return from + 24 * 60 * 60 * 1000;
}

/** 下一次触发时间（毫秒）；每日按本地时区，间隔从 `from` 起算。 */
export function nextRunAt(schedule: AutomationSchedule, from: number): number {
  if (schedule.type === "daily") {
    return nextDailyRun(schedule.time, schedule.weekdays, from);
  }
  const minutes = Math.min(
    MAX_INTERVAL_MINUTES,
    Math.max(MIN_INTERVAL_MINUTES, Math.round(schedule.minutes)),
  );
  return from + minutes * 60 * 1000;
}

/** 表单校验；通过返回空串。 */
export function validateDraft(draft: AutomationDraft): string {
  const name = String(draft.name ?? "").trim();
  if (!name) return "请填写任务名称";
  if ([...name].length > MAX_NAME_CHARS) return `名称最多 ${MAX_NAME_CHARS} 字`;
  // 动作白名单走注册表：未知 kind 一律拒绝，不在模型层再抄一份字面量。
  if (!isAutomationKind(draft.kind)) return "请选择要执行的动作";
  // 只有声明了同步参数的动作才要求至少一个来源；重扫日程不涉及。
  if (kindMeta(draft.kind).hasSyncParams) {
    const sources = draft.sync?.sources ?? [];
    if (!sources.some((s) => s === "qq" || s === "wechat")) return "至少选择一个同步来源";
  }
  if (draft.schedule.type === "daily") {
    if (!parseClock(draft.schedule.time)) return "时间格式应为 HH:MM";
    if (!Array.isArray(draft.schedule.weekdays) || draft.schedule.weekdays.length === 0) {
      return "至少选择一个星期";
    }
  } else if (draft.schedule.type === "interval") {
    if (!Number.isInteger(draft.schedule.minutes)) return "间隔分钟必须是整数";
    if (draft.schedule.minutes < MIN_INTERVAL_MINUTES || draft.schedule.minutes > MAX_INTERVAL_MINUTES) {
      return `间隔需在 ${MIN_INTERVAL_MINUTES}–${MAX_INTERVAL_MINUTES} 分钟之间`;
    }
  } else {
    return "请选择触发方式";
  }
  return "";
}

export function normalizeSync(raw: unknown): SyncOptions {
  if (!isPlainObject(raw)) return { ...DEFAULT_SYNC, sources: [...DEFAULT_SYNC.sources] };
  // 缺省 sources（老数据）按双来源；显式空集合保留为空，交给校验拒绝——
  // 不能把「用户一个都没勾」静默放宽成「两个都采」。
  const sources = Array.isArray(raw.sources)
    ? [...new Set(raw.sources.filter((s): s is "qq" | "wechat" => s === "qq" || s === "wechat"))]
    : [...DEFAULT_SYNC.sources];
  return {
    sources,
    full: raw.full === true,
    archive: raw.archive === true,
  };
}

/** 归一来表单的一份草稿（名称截断、频率夹紧、星期去重）。 */
export function normalizeDraft(draft: AutomationDraft): AutomationDraft {
  const schedule: AutomationSchedule =
    draft.schedule.type === "daily"
      ? {
          type: "daily",
          time: clockValue(
            parseClock(draft.schedule.time)?.hours ?? 9,
            parseClock(draft.schedule.time)?.minutes ?? 0,
          ),
          weekdays: normalizeWeekdays(draft.schedule.weekdays),
        }
      : {
          type: "interval",
          minutes: Math.min(
            MAX_INTERVAL_MINUTES,
            Math.max(MIN_INTERVAL_MINUTES, Math.round(Number(draft.schedule.minutes) || 60)),
          ),
        };
  // 未知 kind 落回清单第一项（即原来的默认动作 infohub.sync），与改造前一致。
  const kind = isAutomationKind(draft.kind) ? draft.kind : AUTOMATION_KINDS[0];
  return {
    name: clipText(draft.name, MAX_NAME_CHARS),
    kind,
    schedule,
    sync: normalizeSync(draft.sync),
  };
}

/** 读盘归一：结构不认识、频率非法、来源为空的条目一律丢弃。 */
export function normalizeTask(raw: unknown, now: number = Date.now()): AutomationTask | null {
  if (!isPlainObject(raw)) return null;
  const id = typeof raw.id === "string" ? raw.id.trim() : "";
  const name = typeof raw.name === "string" ? clipText(raw.name, MAX_NAME_CHARS) : "";
  if (!id || !name) return null;
  // 读盘校验不能放宽：老数据里未知 kind 的条目仍旧整条丢弃。
  const kind = raw.kind;
  if (!isAutomationKind(kind)) return null;

  let schedule: AutomationSchedule;
  if (isPlainObject(raw.schedule) && raw.schedule.type === "daily") {
    if (!parseClock(String(raw.schedule.time ?? ""))) return null;
    schedule = {
      type: "daily",
      time: String(raw.schedule.time),
      weekdays: normalizeWeekdays(raw.schedule.weekdays),
    };
  } else if (isPlainObject(raw.schedule) && raw.schedule.type === "interval") {
    const minutes = Number(raw.schedule.minutes);
    if (!Number.isFinite(minutes) || minutes < MIN_INTERVAL_MINUTES || minutes > MAX_INTERVAL_MINUTES) {
      return null;
    }
    schedule = { type: "interval", minutes: Math.round(minutes) };
  } else {
    return null;
  }

  const sync = normalizeSync(raw.sync);
  // 需要同步参数的动作为空来源时丢弃；不需要的动作用不到这份占位配置。
  if (kindMeta(kind).hasSyncParams && sync.sources.length === 0) return null;

  const createdAt = typeof raw.createdAt === "number" && Number.isFinite(raw.createdAt) ? raw.createdAt : now;
  const updatedAt =
    typeof raw.updatedAt === "number" && Number.isFinite(raw.updatedAt) ? raw.updatedAt : createdAt;
  const next =
    typeof raw.nextRunAt === "number" && Number.isFinite(raw.nextRunAt) && raw.nextRunAt > 0
      ? raw.nextRunAt
      : nextRunAt(schedule, now);
  const lastStatus =
    raw.lastStatus === "ok" || raw.lastStatus === "error" || raw.lastStatus === "skipped"
      ? raw.lastStatus
      : undefined;

  return {
    id,
    name,
    kind,
    enabled: raw.enabled !== false,
    schedule,
    sync,
    createdAt,
    updatedAt,
    nextRunAt: next,
    ...(typeof raw.lastRunAt === "number" && Number.isFinite(raw.lastRunAt)
      ? { lastRunAt: raw.lastRunAt }
      : {}),
    ...(lastStatus ? { lastStatus } : {}),
    ...(typeof raw.lastDetail === "string" && raw.lastDetail
      ? { lastDetail: clipText(raw.lastDetail, MAX_DETAIL_CHARS) }
      : {}),
    runCount: Number.isInteger(raw.runCount) && (raw.runCount as number) > 0 ? (raw.runCount as number) : 0,
  };
}

export function describeSchedule(schedule: AutomationSchedule): string {
  if (schedule.type === "interval") return `每 ${schedule.minutes} 分钟`;
  const days = normalizeWeekdays(schedule.weekdays);
  if (days.length === 7) return `每天 ${schedule.time}`;
  const ordered = ALL_WEEKDAYS.filter((d) => days.includes(d));
  return `每周${ordered.map((d) => WEEKDAY_LABEL[d]).join("、")} ${schedule.time}`;
}

export function describeSync(sync: SyncOptions): string {
  const parts = [
    sync.sources.map((s) => (s === "qq" ? "QQ" : "微信")).join("、"),
    sync.full ? "全量重扫" : "",
    sync.archive ? "导出知识库" : "",
  ].filter(Boolean);
  return parts.join(" · ");
}

export function describeAction(task: Pick<AutomationTask, "kind" | "sync">): string {
  const meta = kindMeta(task.kind);
  // 同步动作的选项是动态的，必须拼进描述；其余动作直接用元数据里的说明。
  return meta.hasSyncParams ? `同步归档（${describeSync(task.sync)}）` : meta.summary;
}

export function actionLabel(kind: AutomationKind): string {
  return kindMeta(kind).label;
}

export function runStatusLabel(status: AutomationRunStatus): string {
  if (status === "ok") return "成功";
  if (status === "error") return "失败";
  return "已跳过";
}

export function formatAutomationTime(ms: number | undefined): string {
  if (!ms || !Number.isFinite(ms)) return "—";
  const d = new Date(ms);
  if (Number.isNaN(d.getTime())) return "—";
  const pad = (n: number) => String(n).padStart(2, "0");
  return `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())} ${pad(d.getHours())}:${pad(d.getMinutes())}`;
}

/** 默认新建草稿：名称随动作变化，频率保持「每天 09:00」。 */
export function draftForKind(kind: AutomationKind, sync?: SyncOptions): AutomationDraft {
  return {
    ...DEFAULT_DRAFT,
    name: kindMeta(kind).defaultName,
    kind,
    schedule: { type: "daily", time: "09:00", weekdays: [...ALL_WEEKDAYS] },
    sync: sync ? normalizeSync(sync) : { ...DEFAULT_SYNC, sources: [...DEFAULT_SYNC.sources] },
  };
}
