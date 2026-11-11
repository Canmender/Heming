import { create } from "zustand";
import {
  createDefaultStorage,
  isPlainObject,
  readJson,
  utf8Length,
  writeJson,
} from "@heming/sdk";
import type { StorageLike } from "@heming/sdk";
import { isAutomationKind } from "./kinds.js";
import {
  MAX_DETAIL_CHARS,
  MAX_NAME_CHARS,
  clipText,
  type AutomationKind,
  type AutomationRunStatus,
} from "./model.js";

/**
 * 自动化运行记录（本机）：每次执行留一条，独立成键而不是塞进任务对象。
 *
 * 为什么独立键：
 * - 任务是「配置」，运行记录是「流水」——两者的淘汰节奏完全不同（任务最多 20 条、
 *   记录 40 条）。混在一个键里，清记录会把配置一起重写一遍，写盘失败还会连累任务；
 * - 单个任务被删除时配置没了，但「它上次为什么失败」仍值得看一眼（页面文案已承诺
 *   「运行结果也会一并移除」，所以 remove 时仍会级联删掉，键独立只是别把风险绑在一起）。
 *
 * 红线：只存本机。记录里是失败原因与同步摘要，与任务/记忆同口径，一律不上云。
 */

export const AUTOMATION_RUNS_KEY = "heming.automations.runs.v1";
/** 保留条数（超出按开始时间淘汰最旧）。 */
export const MAX_AUTOMATION_RUNS = 40;
/** 单键字节上限：localStorage 同源约 5MB，给任务/记忆留余量。 */
export const AUTOMATION_RUNS_BYTE_LIMIT = 192 * 1024;

/** 触发来源：到点调度 / 用户手动点「立即运行」。 */
export type AutomationRunTrigger = "schedule" | "manual";

export interface AutomationRun {
  id: string;
  taskId: string;
  /** 任务名快照：任务改名或删除后，历史记录仍要能读懂得是哪一条。 */
  taskName: string;
  kind: AutomationKind;
  trigger: AutomationRunTrigger;
  status: AutomationRunStatus;
  /** 单行摘要，≤ MAX_DETAIL_CHARS（与任务卡片上的 lastDetail 同口径）。 */
  detail: string;
  startedAt: number;
  finishedAt: number;
  durationMs: number;
}

function isRunStatus(value: unknown): value is AutomationRunStatus {
  return value === "ok" || value === "error" || value === "skipped";
}

function isTrigger(value: unknown): value is AutomationRunTrigger {
  return value === "schedule" || value === "manual";
}

function isFiniteNumber(value: unknown): value is number {
  return typeof value === "number" && Number.isFinite(value);
}

/**
 * 校验并归一条运行记录；不合规返回 null（读盘时逐条丢弃，不整表回退）。
 *
 * 为什么时间字段宁可丢整条也要校验：列表按 startedAt 排序、按 durationMs 显示耗时，
 * 缺字段的条目会排到最前或显示 0ms，比缺一条更容易误导。
 */
export function normalizeRun(raw: unknown): AutomationRun | null {
  if (!isPlainObject(raw)) return null;
  const id = typeof raw.id === "string" ? raw.id.trim() : "";
  const taskId = typeof raw.taskId === "string" ? raw.taskId.trim() : "";
  if (!id || !taskId) return null;
  // 没有任务名的记录在列表里无法辨认是哪一条（任务删掉后就只剩一个 id），直接丢。
  const taskName = clipText(typeof raw.taskName === "string" ? raw.taskName : "", MAX_NAME_CHARS);
  if (!taskName) return null;
  if (!isAutomationKind(raw.kind) || !isRunStatus(raw.status) || !isTrigger(raw.trigger)) return null;
  if (!isFiniteNumber(raw.startedAt) || raw.startedAt <= 0) return null;
  const finishedAt =
    isFiniteNumber(raw.finishedAt) && raw.finishedAt >= 0 ? raw.finishedAt : raw.startedAt;
  const durationMs =
    isFiniteNumber(raw.durationMs) && raw.durationMs >= 0
      ? raw.durationMs
      : Math.max(0, finishedAt - raw.startedAt);
  return {
    id,
    taskId,
    taskName,
    kind: raw.kind,
    trigger: raw.trigger,
    status: raw.status,
    detail: clipText(typeof raw.detail === "string" ? raw.detail : "", MAX_DETAIL_CHARS),
    startedAt: raw.startedAt,
    finishedAt,
    durationMs,
  };
}

/**
 * 条数 + 字节双重淘汰（最新在前）。照 lib/staff/model.ts 的 pruneRuns：
 * 先按开始时间倒序取前 N 条，再逐条弹出直到装得下；单条都装不下就清空
 * （写一个超限的大数组进去只会让整个键失效）。
 */
export function pruneRuns(
  items: AutomationRun[],
  limit = AUTOMATION_RUNS_BYTE_LIMIT,
): AutomationRun[] {
  const next = [...items]
    .sort((a, b) => b.startedAt - a.startedAt)
    .slice(0, MAX_AUTOMATION_RUNS);
  let bytes = utf8Length(JSON.stringify(next));
  while (bytes > limit && next.length > 1) {
    next.pop();
    bytes = utf8Length(JSON.stringify(next));
  }
  return bytes > limit ? [] : next;
}

let storage: StorageLike | null = null;

function getStorage(): StorageLike {
  return (storage ??= createDefaultStorage());
}

/** 测试注入点：传 null 恢复默认（jsdom 的 localStorage）。 */
export function setAutomationRunStorage(next: StorageLike | null): void {
  storage = next;
}

/** 读记录：缺键/损坏回退空，坏条目逐条丢弃，再按条数与字节淘汰。 */
export function readAutomationRuns(
  storageLike: StorageLike = createDefaultStorage(),
): AutomationRun[] {
  return readJson(storageLike, AUTOMATION_RUNS_KEY, [] as AutomationRun[], (raw) => {
    if (!Array.isArray(raw)) return [];
    return pruneRuns(raw.map(normalizeRun).filter((run): run is AutomationRun => run !== null));
  });
}

/**
 * 落盘并返回最终保留的列表。
 *
 * 写不进去（隐私模式/配额满）时仍返回内存态：本次会话里用户看得见刚跑完的记录，
 * 只是重启后没有——这与 tasks/staff 的「静默降级」一致，不能因为落盘失败就丢弃结果。
 */
function persist(runs: AutomationRun[]): AutomationRun[] {
  const pruned = pruneRuns(runs);
  writeJson(getStorage(), AUTOMATION_RUNS_KEY, pruned, AUTOMATION_RUNS_BYTE_LIMIT);
  return pruned;
}

interface AutomationRunsState {
  runs: AutomationRun[];
  /** 记一条记录（前插、按 id 去重），返回最终保留的列表。 */
  recordRun: (run: AutomationRun) => AutomationRun[];
  /** 任务被删除时级联摘掉它的全部记录。 */
  removeForTask: (taskId: string) => void;
  /** 清空全部记录（破坏性操作，UI 侧应先经确认弹窗）。 */
  clearAll: () => void;
}

export const useAutomationRunsStore = create<AutomationRunsState>((set, get) => ({
  runs: readAutomationRuns(),

  recordRun: (run) => {
    const runs = persist([run, ...get().runs.filter((item) => item.id !== run.id)]);
    set({ runs });
    return runs;
  },

  removeForTask: (taskId) => {
    const current = get().runs;
    const next = current.filter((item) => item.taskId !== taskId);
    if (next.length === current.length) return;
    set({ runs: persist(next) });
  },

  clearAll: () => set({ runs: persist([]) }),
}));
