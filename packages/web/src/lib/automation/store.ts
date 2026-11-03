import { create } from "zustand";
import { useNotificationStore } from "../../store/notifications.js";
import { createDefaultStorage, readJson, writeJson } from "../memory/storage.js";
import type { StorageLike } from "../memory/types.js";
import {
  MAX_AUTOMATIONS,
  clipText,
  MAX_DETAIL_CHARS,
  nextRunAt,
  normalizeDraft,
  normalizeTask,
  validateDraft,
  type AutomationDraft,
  type AutomationRunStatus,
  type AutomationTask,
} from "./model.js";
import { useAutomationRunsStore, type AutomationRunTrigger } from "./runs.js";

/**
 * 自动化任务（本机）：只存 localStorage，不上云、不进消息库。
 *
 * `runningId` 只活在内存里——应用重启后不可能还有任务在跑；落盘会让页面
 * 永远停在「运行中」。调度与手动运行共用它做串行保护。
 *
 * 运行流水存在独立的 `heming.automations.runs.v1` 键里（见 runs.ts）：
 * 收尾时顺带写一条、失败时推一条通知，但不把流水塞进任务对象。
 */

export const AUTOMATIONS_KEY = "heming.automations.v1";
export const AUTOMATIONS_BYTE_LIMIT = 256 * 1024;

/** 读取与归一：损坏条目逐条丢弃，最多保留 MAX_AUTOMATIONS 条。 */
export function readAutomations(
  storage: StorageLike = createDefaultStorage(),
  now: number = Date.now(),
): AutomationTask[] {
  return readJson(storage, AUTOMATIONS_KEY, [] as AutomationTask[], (raw) => {
    if (!Array.isArray(raw)) return [];
    const seen = new Set<string>();
    const tasks: AutomationTask[] = [];
    for (const item of raw) {
      const task = normalizeTask(item, now);
      if (!task || seen.has(task.id)) continue;
      seen.add(task.id);
      tasks.push(task);
      if (tasks.length >= MAX_AUTOMATIONS) break;
    }
    return tasks;
  });
}

let storage: StorageLike | null = null;

function getStorage(): StorageLike {
  return (storage ??= createDefaultStorage());
}

/** 测试注入点：传 null 恢复默认（jsdom 的 localStorage）。 */
export function setAutomationStorage(next: StorageLike | null): void {
  storage = next;
}

function persist(tasks: AutomationTask[]): void {
  writeJson(getStorage(), AUTOMATIONS_KEY, tasks, AUTOMATIONS_BYTE_LIMIT);
}

let seq = 0;

function newTaskId(now: number): string {
  seq += 1;
  return `auto-${now.toString(36)}-${seq.toString(36)}-${Math.random().toString(36).slice(2, 6)}`;
}

/**
 * 运行记录 id：同一任务、同一收尾时刻只该有一条。
 *
 * 这里刻意不用随机后缀：调度器若因重试/重复 tick 把同一次收尾调用两遍，
 * 随机会插出两条重复记录，确定性 id 让 runs store 按 id 去重掉（通知那边同理，
 * 由 `automation:<taskId>:error:<now>` 这个 key 保证）。
 */
function newRunId(taskId: string, now: number): string {
  return `auto-run-${taskId}-${now.toString(36)}`;
}

export interface AutomationResult {
  status: AutomationRunStatus;
  detail: string;
}

export type AutomationMutation =
  | { ok: true; id: string }
  | { ok: false; error: string };

interface AutomationState {
  tasks: AutomationTask[];
  /** 正在执行的任务 id（内存态；null = 空闲）。 */
  runningId: string | null;
  runningSince: number;
  /** 本次运行的来源（内存态，与 runningId 同生命周期）：调度器到点 / 用户手动。 */
  runningTrigger: AutomationRunTrigger;
  create: (draft: AutomationDraft, now?: number) => AutomationMutation;
  update: (id: string, draft: AutomationDraft, now?: number) => AutomationMutation;
  remove: (id: string) => void;
  setEnabled: (id: string, enabled: boolean, now?: number) => void;
  /** 抢占执行权；已有任务在跑时返回 false。`trigger` 由调用方指明是调度还是手动。 */
  beginRun: (id: string, now?: number, trigger?: AutomationRunTrigger) => boolean;
  /** 收尾并顺延下一次；任务已被删除时只释放执行权。 */
  finishRun: (id: string, result: AutomationResult, now?: number) => void;
  /**
   * 应用启动时把「本次启动之前就到点」的任务顺延到下一周期。
   * 不补跑、不改最近结果（错过的时刻本来就没发生）。
   */
  rescheduleMissed: (since: number, now?: number) => number;
}

export const useAutomationStore = create<AutomationState>((set, get) => ({
  tasks: readAutomations(),
  runningId: null,
  runningSince: 0,
  runningTrigger: "schedule",

  create: (draft, now = Date.now()) => {
    const error = validateDraft(draft);
    if (error) return { ok: false, error };
    if (get().tasks.length >= MAX_AUTOMATIONS) {
      return { ok: false, error: `自动化最多 ${MAX_AUTOMATIONS} 条，请先删除不用的任务` };
    }
    const normalized = normalizeDraft(draft);
    const task: AutomationTask = {
      id: newTaskId(now),
      ...normalized,
      enabled: true,
      createdAt: now,
      updatedAt: now,
      nextRunAt: nextRunAt(normalized.schedule, now),
      runCount: 0,
    };
    const tasks = [task, ...get().tasks];
    persist(tasks);
    set({ tasks });
    return { ok: true, id: task.id };
  },

  update: (id, draft, now = Date.now()) => {
    const error = validateDraft(draft);
    if (error) return { ok: false, error };
    const current = get().tasks.find((t) => t.id === id);
    if (!current) return { ok: false, error: "任务不存在" };
    const normalized = normalizeDraft(draft);
    const tasks = get().tasks.map((task) =>
      task.id === id
        ? {
            ...task,
            ...normalized,
            updatedAt: now,
            // 改频率即重新排期，避免旧计划在下一个 tick 立刻触发
            nextRunAt: nextRunAt(normalized.schedule, now),
          }
        : task,
    );
    persist(tasks);
    set({ tasks });
    return { ok: true, id };
  },

  remove: (id) => {
    const tasks = get().tasks.filter((task) => task.id !== id);
    if (tasks.length === get().tasks.length) return;
    persist(tasks);
    set({ tasks });
    // 页面文案已承诺「删除任务时运行结果也会一并移除」，所以这里级联清记录。
    // 顺序放在任务删除之后：级联失败（存储异常）不能让用户点了删除却删不掉任务。
    try {
      useAutomationRunsStore.getState().removeForTask(id);
    } catch {
      /* 记录清理失败不影响任务删除 */
    }
  },

  setEnabled: (id, enabled, now = Date.now()) => {
    const tasks = get().tasks.map((task) =>
      task.id === id
        ? {
            ...task,
            enabled,
            updatedAt: now,
            // 重新启用从「现在」重新排期：停用一周后启用不应该立刻补跑
            nextRunAt: enabled ? nextRunAt(task.schedule, now) : task.nextRunAt,
          }
        : task,
    );
    persist(tasks);
    set({ tasks });
  },

  beginRun: (id, now = Date.now(), trigger: AutomationRunTrigger = "schedule") => {
    if (get().runningId) return false;
    if (!get().tasks.some((task) => task.id === id)) return false;
    set({ runningId: id, runningSince: now, runningTrigger: trigger });
    return true;
  },

  finishRun: (id, result, now = Date.now()) => {
    const detail = clipText(result.detail, MAX_DETAIL_CHARS);
    const { tasks: current, runningId, runningSince, runningTrigger } = get();
    const target = current.find((task) => task.id === id);
    // 收尾顺序是固定的：先记流水 → 再推失败通知 → 最后落任务状态。
    // 流水与通知都是副链路，任何一步抛错都不能把「已完成」挡在内存之外——
    // 那样 runningId 会一直挂着，后续所有调度都被串行保护挡死。
    if (target) {
      // 没经过 beginRun 就被收尾（例如调用方自己补了个终态）时用 now 兜底：
      // 记 0 会把耗时算成半个世纪，记 now 至少是「瞬时完成」。
      const startedAt = runningId === id && runningSince > 0 ? runningSince : now;
      try {
        useAutomationRunsStore.getState().recordRun({
          id: newRunId(target.id, now),
          taskId: target.id,
          taskName: target.name,
          kind: target.kind,
          trigger: runningTrigger,
          status: result.status,
          detail,
          startedAt,
          finishedAt: now,
          durationMs: Math.max(0, now - startedAt),
        });
      } catch {
        /* 流水写不进不影响任务收尾 */
      }
      // 只有 error 才推通知：skipped 表示「到点了但没条件跑」（未连接、空数据），
      // 每次到点都提醒会刷屏，用户会干脆关掉整个通知中心。重复收尾同 (taskId, now)
      // 只推一条，由 key 天然保证。
      if (result.status === "error") {
        try {
          useNotificationStore.getState().push({
            kind: "automation",
            key: `automation:${target.id}:error:${now}`,
            title: `「${target.name}」执行失败`,
            body: detail,
            automationId: target.id,
            now,
          });
        } catch {
          /* 通知失败不影响任务收尾 */
        }
      }
    }
    const tasks = current.map((task) =>
      task.id === id
        ? {
            ...task,
            lastRunAt: now,
            lastStatus: result.status,
            lastDetail: detail,
            runCount: task.runCount + 1,
            updatedAt: now,
            nextRunAt: nextRunAt(task.schedule, now),
          }
        : task,
    );
    persist(tasks);
    set({
      tasks,
      runningId: runningId === id ? null : runningId,
      runningSince: runningId === id ? 0 : runningSince,
      runningTrigger: runningId === id ? "schedule" : runningTrigger,
    });
  },

  rescheduleMissed: (since, now = Date.now()) => {
    let changed = 0;
    const tasks = get().tasks.map((task) => {
      if (!task.enabled || task.nextRunAt >= since) return task;
      changed += 1;
      return {
        ...task,
        nextRunAt: nextRunAt(task.schedule, now),
        updatedAt: now,
      };
    });
    if (changed > 0) {
      persist(tasks);
      set({ tasks });
    }
    return changed;
  },
}));
