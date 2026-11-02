import { create } from "zustand";
import type { TeamActivityInput, TeamUsageInput } from "@heming/shared";
import { useTaskStore, type TaskRecord, type TaskStatus } from "../tasks/store.js";
import { useInfohubStore } from "../infohub/store.js";
import type { InfohubAgendaItem } from "../infohub/client.js";
import { dayKeyOf, useTokenUsageStore, type UsageRecord } from "../../store/tokenUsage.js";
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
 * 共享开关：任务 / 日程 / 用量三类（②-3 新增 `usage`，默认关）。
 * 旧版本存过的 `staff` 字段读回时直接丢弃——团队页只保留真实成员的动向。
 */
export interface TeamShareSettings {
  tasks: boolean;
  agenda: boolean;
  /** 用量排行共享：关闭时**不上传、不采集**，团队页只显示本人本机统计。 */
  usage: boolean;
  /**
   * 「清除我的用量」的时间水位（epoch ms，默认 null）。
   *
   * 为什么需要它：用量是**从本机账本派生**的，清掉服务端旧行之后如果立刻再同步，
   * 同一个窗口的数据会原样传回去（等于没删）。水位之后产生的用量才允许再上传。
   */
  usageClearedAt: number | null;
  lastSyncAt: number | null;
}

export const DEFAULT_TEAM_SHARE: TeamShareSettings = {
  tasks: false,
  agenda: false,
  usage: false,
  usageClearedAt: null,
  lastSyncAt: null,
};

export function normalizeTeamShareSettings(raw: unknown): TeamShareSettings {
  if (!raw || typeof raw !== "object") return { ...DEFAULT_TEAM_SHARE };
  const o = raw as Record<string, unknown>;
  return {
    tasks: o.tasks === true,
    agenda: o.agenda === true,
    usage: o.usage === true,
    usageClearedAt:
      typeof o.usageClearedAt === "number" && Number.isFinite(o.usageClearedAt) && o.usageClearedAt > 0
        ? Math.floor(o.usageClearedAt)
        : null,
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
  update: (patch: Partial<Pick<TeamShareSettings, "tasks" | "agenda" | "usage">>) => void;
  setLastSync: (at: number | null) => void;
  /** 「清除我的用量」成功后落水位：水位之前的用量不再重新上传。 */
  setUsageClearedAt: (at: number | null) => void;
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
  setUsageClearedAt: (at) => {
    const settings = { ...get().settings, usageClearedAt: at };
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

/* ------------------------------------------------------------ 团队用量采集 */

/** 上报窗口：近 30 个自然日（服务端 GET 最多看 30d）。 */
export const TEAM_USAGE_DAYS = 30;
/** 一次上报的条数上限（与服务端契约一致）。 */
const TEAM_USAGE_ITEM_LIMIT = 50;
/** 单行最多带几个连接名（服务端 schema 上限 5）。 */
const MAX_USAGE_CONNECTIONS = 5;

/**
 * 采集**用量摘要**：按「本地自然日 × 模型」聚合成服务端契约的形状。
 *
 * 隐私口径（与团队动向同一条红线）：
 * - 只取 `UsageRecord` 里的白名单字段——模型名、token 数、是否未上报、连接名快照；
 * - **绝不**带提示词、对话正文、工具参数、任务结果或文件信息（这些字段本机记录里也没有）；
 * - 关闭 `usage` 开关时返回空数组：不采集、不上传。
 *
 * `tokens: null` 的语义沿用 d.32：该日该模型**一次都没上报**，与「真的用了 0」区分开。
 */
export function collectTeamUsage(
  settings: TeamShareSettings,
  records: UsageRecord[],
  now: Date = new Date(),
): TeamUsageInput[] {
  if (!settings.usage) return [];
  // 本地时区的「30 天前 00:00」：用本地日历算，避免 UTC 偏移把某一天切掉半个。
  const fromMs = new Date(
    now.getFullYear(),
    now.getMonth(),
    now.getDate() - (TEAM_USAGE_DAYS - 1),
  ).getTime();
  /**
   * 清除水位：清掉服务端旧行之后，**水位之前**的用量不再重新上传——
   * 否则下一次轮询就把刚删掉的数据原样传回去，等于没删。
   */
  const clearedAt = settings.usageClearedAt ?? 0;
  const sinceMs = Math.max(fromMs, clearedAt);

  const by = new Map<
    string,
    { date: string; model: string; tokens: number; reported: boolean; unreported: number; connections: string[] }
  >();

  for (const r of records) {
    const at = Date.parse(r.at);
    if (!Number.isFinite(at) || at < sinceMs) continue;
    const model = String(r.model ?? "").trim().slice(0, 120);
    if (!model) continue;
    const date = dayKeyOf(r.at);
    const key = `${date}\u0000${model}`;
    const entry =
      by.get(key) ??
      { date, model, tokens: 0, reported: false, unreported: 0, connections: [] };
    if (typeof r.tokens === "number") {
      entry.tokens += r.tokens;
      entry.reported = true;
    } else {
      entry.unreported += 1;
    }
    // 连接名是用户自命名的白名单字段；缺省（单连接旧记录）就不写，不拿 profileId 顶替。
    const connection = String(r.profileLabel ?? "").trim().slice(0, 64);
    if (connection && !entry.connections.includes(connection) && entry.connections.length < MAX_USAGE_CONNECTIONS) {
      entry.connections.push(connection);
    }
    by.set(key, entry);
  }

  return [...by.values()]
    .map((entry) => ({
      date: entry.date,
      model: entry.model,
      // 只有确实上报过才给数字；全都没上报 → null（未上报 ≠ 0）
      tokens: entry.reported ? entry.tokens : null,
      unreported: entry.unreported,
      connections: entry.connections,
    }))
    .sort((a, b) => (a.date < b.date ? 1 : a.date > b.date ? -1 : b.tokens === a.tokens ? 0 : (b.tokens ?? -1) - (a.tokens ?? -1)))
    .slice(0, TEAM_USAGE_ITEM_LIMIT);
}

/** 从当前本机账本采集用量摘要（团队页同步用）。 */
export function collectCurrentTeamUsage(settings: TeamShareSettings): TeamUsageInput[] {
  return collectTeamUsage(settings, useTokenUsageStore.getState().records);
}

/** 本机用量汇总的形状与服务端 `self` 一致，界面可以复用同一套渲染。 */
export interface LocalUsageSummary {
  total: number;
  unreported: number;
  byModel: { model: string; tokens: number; unreported: number; connections: string[] }[];
  byDay: { date: string; tokens: number; unreported: number }[];
}

/**
 * 仅供**本机**展示的用量汇总（关闭共享时用）：与上传无关，不产生任何请求。
 *
 * 与服务端 `self` 的口径一致：`tokens: null` 计入「未上报轮数」，不进合计。
 */
export function summarizeLocalUsage(
  records: UsageRecord[],
  days = 7,
  now: Date = new Date(),
): LocalUsageSummary {
  const fromMs = new Date(now.getFullYear(), now.getMonth(), now.getDate() - (days - 1)).getTime();
  const byModel = new Map<string, { model: string; tokens: number; unreported: number; connections: string[] }>();
  const byDay = new Map<string, { date: string; tokens: number; unreported: number }>();
  // 逐日先铺满（零值天也显示），避免图表缺格。
  for (let i = days - 1; i >= 0; i -= 1) {
    const d = new Date(now.getFullYear(), now.getMonth(), now.getDate() - i);
    const key = dayKeyOf(d.toISOString());
    byDay.set(key, { date: key, tokens: 0, unreported: 0 });
  }

  let total = 0;
  let unreported = 0;
  for (const r of records) {
    const at = Date.parse(r.at);
    if (!Number.isFinite(at) || at < fromMs) continue;
    const modelName = String(r.model ?? "").trim() || "未知模型";
    const tokens = typeof r.tokens === "number" ? r.tokens : null;
    if (tokens === null) unreported += 1;
    else total += tokens;

    const entry = byModel.get(modelName) ?? { model: modelName, tokens: 0, unreported: 0, connections: [] };
    if (tokens !== null) entry.tokens += tokens;
    else entry.unreported += 1;
    const connection = String(r.profileLabel ?? "").trim().slice(0, 64);
    if (connection && !entry.connections.includes(connection) && entry.connections.length < MAX_USAGE_CONNECTIONS) {
      entry.connections.push(connection);
    }
    byModel.set(modelName, entry);

    const date = dayKeyOf(r.at);
    const day = byDay.get(date) ?? { date, tokens: 0, unreported: 0 };
    if (tokens !== null) day.tokens += tokens;
    else day.unreported += 1;
    byDay.set(date, day);
  }

  return {
    total,
    unreported,
    byModel: [...byModel.values()].sort(
      (a, b) => b.tokens - a.tokens || a.model.localeCompare(b.model),
    ),
    byDay: [...byDay.values()].sort((a, b) => (a.date < b.date ? -1 : a.date > b.date ? 1 : 0)),
  };
}
