import { create } from "zustand";
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

/**
 * 自动化任务（本机）：只存 localStorage，不上云、不进消息库。
 *
 * `runningId` 只活在内存里——应用重启后不可能还有任务在跑；落盘会让页面
 * 永远停在「运行中」。调度与手动运行共用它做串行保护。
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
  create: (draft: AutomationDraft, now?: number) => AutomationMutation;
  update: (id: string, draft: AutomationDraft, now?: number) => AutomationMutation;
  remove: (id: string) => void;
  setEnabled: (id: string, enabled: boolean, now?: number) => void;
  /** 抢占执行权；已有任务在跑时返回 false。 */
  beginRun: (id: string, now?: number) => boolean;
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

  beginRun: (id, now = Date.now()) => {
    if (get().runningId) return false;
    if (!get().tasks.some((task) => task.id === id)) return false;
    set({ runningId: id, runningSince: now });
    return true;
  },

  finishRun: (id, result, now = Date.now()) => {
    const detail = clipText(result.detail, MAX_DETAIL_CHARS);
    const tasks = get().tasks.map((task) =>
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
      runningId: get().runningId === id ? null : get().runningId,
      runningSince: get().runningId === id ? 0 : get().runningSince,
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
