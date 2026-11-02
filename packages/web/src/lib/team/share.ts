import { create } from "zustand";
import type { TeamActivityInput } from "@heming/shared";
import { useTaskStore, type TaskRecord, type TaskStatus } from "../tasks/store.js";
import { useInfohubStore } from "../infohub/store.js";
import type { InfohubAgendaItem } from "../infohub/client.js";
import { createDefaultStorage, readJson, writeJson } from "../memory/storage.js";
import type { StorageLike } from "../memory/types.js";

/**
 * 团队共享设置与本机摘要采集（设计 §7）。
 *
 * 三条边界：
 * - 默认全关，用户逐类开启；
 * - 只上报白名单字段（标题/状态/时间），正文、提示词、工具参数、
 *   任务结果、日程证据与发送人一律不出本机；
 * - `sourceId` 由来源与更新时刻确定性生成，重复同步按幂等键跳过。
 *
 * 只采「真实成员自己的任务与日程」：智能体的工作留在「智能体」页
 * （幕僚简报、对话与工具轨迹都不进团队动向），团队页不出现智能体条目。
 */

export const TEAM_SHARE_KEY = "heming.team.share.v1";
const TEAM_SHARE_BYTE_LIMIT = 4 * 1024;
/** 单次上报上限与服务端契约一致。 */
export const TEAM_UPLOAD_LIMIT = 50;
/** 每类来源最多采集多少条（防止本地积压把 50 条额度全占满）。 */
const PER_SOURCE_LIMIT = { tasks: 20, agenda: 30 } as const;

/**
 * 共享开关只有「任务 / 日程」两类。
 * 旧版本存过的 `staff` 字段读回时直接丢弃——团队页只保留真实成员的动向。
 */
export interface TeamShareSettings {
  tasks: boolean;
  agenda: boolean;
  lastSyncAt: number | null;
}

export const DEFAULT_TEAM_SHARE: TeamShareSettings = {
  tasks: false,
  agenda: false,
  lastSyncAt: null,
};

export function normalizeTeamShareSettings(raw: unknown): TeamShareSettings {
  if (!raw || typeof raw !== "object") return { ...DEFAULT_TEAM_SHARE };
  const o = raw as Record<string, unknown>;
  return {
    tasks: o.tasks === true,
    agenda: o.agenda === true,
    lastSyncAt:
      typeof o.lastSyncAt === "number" && Number.isFinite(o.lastSyncAt) ? o.lastSyncAt : null,
  };
}

export function readTeamShareSettings(
  storage: StorageLike = createDefaultStorage(),
): TeamShareSettings {
  return readJson(storage, TEAM_SHARE_KEY, { ...DEFAULT_TEAM_SHARE }, normalizeTeamShareSettings);
}

function persistTeamShareSettings(settings: TeamShareSettings): void {
  writeJson(createDefaultStorage(), TEAM_SHARE_KEY, settings, TEAM_SHARE_BYTE_LIMIT);
}

interface TeamShareState {
  settings: TeamShareSettings;
  update: (patch: Partial<Pick<TeamShareSettings, "tasks" | "agenda">>) => void;
  setLastSync: (at: number | null) => void;
}

export const useTeamShareStore = create<TeamShareState>((set, get) => ({
  settings: readTeamShareSettings(),
  update: (patch) => {
    const settings = { ...get().settings, ...patch };
    persistTeamShareSettings(settings);
    set({ settings });
  },
  setLastSync: (at) => {
    const settings = { ...get().settings, lastSyncAt: at };
    persistTeamShareSettings(settings);
    set({ settings });
  },
}));

const TASK_STATUS_LABEL: Record<TaskStatus, string> = {
  running: "进行中",
  done: "已完成",
  failed: "失败",
  cancelled: "已中断",
};

const BUCKET_LABEL: Record<string, string> = {
  overdue: "已逾期",
  today: "今天到期",
  "next24h": "24 小时内到期",
};

function iso(at: number): string {
  return new Date(at).toISOString();
}

export interface TeamShareSources {
  tasks: TaskRecord[];
  agenda: InfohubAgendaItem[];
}

/** 从本机两类来源采集摘要；关闭的来源不采集。返回按发生时间倒序的 ≤50 条。 */
export function collectTeamActivities(
  settings: TeamShareSettings,
  sources: TeamShareSources,
): TeamActivityInput[] {
  const out: TeamActivityInput[] = [];
  const seen = new Set<string>();

  const push = (item: TeamActivityInput) => {
    if (seen.has(item.sourceId)) return;
    seen.add(item.sourceId);
    out.push(item);
  };

  if (settings.tasks) {
    for (const task of [...sources.tasks]
      .sort((a, b) => b.updatedAt - a.updatedAt)
      .slice(0, PER_SOURCE_LIMIT.tasks)) {
      push({
        kind: "task",
        title: task.title,
        detail: `任务 · ${TASK_STATUS_LABEL[task.status]}`,
        status: task.status,
        sourceId: `task:${task.id}:${task.updatedAt}`,
        occurredAt: iso(task.updatedAt),
      });
    }
  }

  if (settings.agenda) {
    for (const item of [...sources.agenda]
      .sort((a, b) => b.dueTs - a.dueTs)
      .slice(0, PER_SOURCE_LIMIT.agenda)) {
      const bucket = item.dueTs < Date.now() ? "overdue" : "today";
      push({
        kind: "agenda",
        title: item.title,
        detail: `日程 · ${BUCKET_LABEL[bucket] ?? bucket}`,
        status: bucket,
        sourceId: `agenda:${item.id}:${item.dueTs}:${bucket}`,
        occurredAt: iso(item.dueTs),
      });
    }
  }

  return out
    .sort((a, b) => (a.occurredAt < b.occurredAt ? 1 : a.occurredAt > b.occurredAt ? -1 : 0))
    .slice(0, TEAM_UPLOAD_LIMIT);
}

/** 从当前 store 快照采集（团队页同步用）。 */
export function collectCurrentTeamActivities(settings: TeamShareSettings): TeamActivityInput[] {
  return collectTeamActivities(settings, {
    tasks: useTaskStore.getState().tasks,
    agenda: useInfohubStore.getState().agenda?.items ?? [],
  });
}
