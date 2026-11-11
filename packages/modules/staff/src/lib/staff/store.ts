import { create } from "zustand";
import { createDefaultStorage, readJson, writeJson } from "@heming/sdk";
import type { StorageLike } from "@heming/sdk";
import {
  STAFF_RUNS_BYTE_LIMIT,
  STAFF_RUNS_KEY,
  STAFF_SEEN_KEY,
  STAFF_SETTINGS_KEY,
  markSeenKeys,
  normalizeRun,
  normalizeSeen,
  normalizeSettings,
  pruneRuns,
  todayKey,
  type StaffRun,
  type StaffSeen,
  type StaffSettings,
} from "./model.js";

/**
 * 幕僚的本地存储（d.48）：设置、历史简报、去重账本三个键。
 *
 * 全部只在本机：简报里有日程标题、任务名与错误摘要，和任务记录同口径，
 * 不上云、不进消息库。
 */

export const STAFF_SETTINGS_BYTE_LIMIT = 16 * 1024;
export const STAFF_SEEN_BYTE_LIMIT = 32 * 1024;

export type StaffSettingsPatch = Partial<Omit<StaffSettings, "sources">> & {
  sources?: Partial<StaffSettings["sources"]>;
};

interface StaffState {
  settings: StaffSettings;
  runs: StaffRun[];
  seen: StaffSeen;
  /** 手动巡检是否正在前台运行。放在 store 里而不是页面 state：切页卸载后回来仍能显示「正在生成…」 */
  running: boolean;
  setRunning: (running: boolean) => void;
  /** 局部更新设置：落盘的是归一后的合并值，UI 与存储始终一致。 */
  updateSettings: (patch: StaffSettingsPatch) => StaffSettings;
  /** 记一份简报；晨报会自动把 `lastDailyDate` 记为今天。 */
  recordRun: (run: StaffRun) => StaffRun[];
  /** 把本次覆盖到的日程/任务键写进去重账本。 */
  markSeen: (keys: { agenda: string[]; tasks: string[] }, now?: number) => void;
  /** 清空历史简报（去重账本保留，避免清完又重新提醒一遍）。 */
  clearRuns: () => void;
  /**
   * 模块生命周期用：清空**简报 + 已见账本**，保留设置（是否常驻、来源、频率）。
   *
   * 为什么保留设置：清理的是「产生过的内容」，不是用户的配置；
   * 去重账本也一起清，是因为用户明确要「清空本机数据」，留着账本会解释不通。
   */
  clearHistory: () => void;
}

let storage: StorageLike | null = null;

function getStorage(): StorageLike {
  return (storage ??= createDefaultStorage());
}

/** 测试注入点：传 null 恢复默认（jsdom 的 localStorage）。 */
export function setStaffStorage(next: StorageLike | null): void {
  storage = next;
}

export function readStaffSettings(storageLike: StorageLike = createDefaultStorage()): StaffSettings {
  return readJson(storageLike, STAFF_SETTINGS_KEY, normalizeSettings(null), normalizeSettings);
}

export function readStaffRuns(storageLike: StorageLike = createDefaultStorage()): StaffRun[] {
  return readJson(storageLike, STAFF_RUNS_KEY, [] as StaffRun[], (raw) => {
    if (!Array.isArray(raw)) return [];
    return pruneRuns(
      raw.map(normalizeRun).filter((run): run is StaffRun => run !== null),
    );
  });
}

export function readStaffSeen(storageLike: StorageLike = createDefaultStorage()): StaffSeen {
  return readJson(storageLike, STAFF_SEEN_KEY, normalizeSeen(null), normalizeSeen);
}

function persistSettings(settings: StaffSettings): void {
  writeJson(getStorage(), STAFF_SETTINGS_KEY, settings, STAFF_SETTINGS_BYTE_LIMIT);
}

function persistRuns(runs: StaffRun[]): StaffRun[] {
  const pruned = pruneRuns(runs);
  writeJson(getStorage(), STAFF_RUNS_KEY, pruned, STAFF_RUNS_BYTE_LIMIT);
  return pruned;
}

function persistSeen(seen: StaffSeen): void {
  writeJson(getStorage(), STAFF_SEEN_KEY, seen, STAFF_SEEN_BYTE_LIMIT);
}

export const useStaffStore = create<StaffState>((set, get) => ({
  settings: readStaffSettings(),
  runs: readStaffRuns(),
  seen: readStaffSeen(),
  running: false,
  setRunning: (running) => set({ running }),

  updateSettings: (patch) => {
    const current = get().settings;
    const next = normalizeSettings({
      ...current,
      ...patch,
      sources: { ...current.sources, ...(patch.sources ?? {}) },
    });
    persistSettings(next);
    set({ settings: next });
    return next;
  },

  recordRun: (run) => {
    const runs = persistRuns([run, ...get().runs.filter((item) => item.id !== run.id)]);
    let settings = get().settings;
    if (run.trigger === "daily") {
      settings = { ...settings, lastDailyDate: todayKey(run.startedAt) };
      persistSettings(settings);
    }
    set({ runs, settings });
    return runs;
  },

  markSeen: (keys, now = Date.now()) => {
    const seen = markSeenKeys(get().seen, keys, now);
    persistSeen(seen);
    set({ seen });
  },

  clearRuns: () => {
    set({ runs: persistRuns([]) });
  },

  clearHistory: () => {
    set({ runs: persistRuns([]), seen: (() => {
      const next = normalizeSeen(null);
      persistSeen(next);
      return next;
    })() });
  },
}));
