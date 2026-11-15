import { create } from "zustand";
import type { TeamActivityInput, TeamUsageInput } from "@heming/shared";
import { useTaskStore, type TaskRecord, type TaskStatus } from "../tasks/store.js";
import { useInfohubStore } from "../infohub/store.js";
import type { InfohubAgendaItem } from "../infohub/client.js";
import { dayKeyOf, useTokenUsageStore, type UsageRecord } from "../../store/tokenUsage.js";
import { createDefaultStorage, readJson, writeJson } from "../memory/storage.js";
import type { StorageLike } from "../memory/types.js";
import { agendaBucket, type AgendaBucket } from "../agendaBucket.js";

/**
 * 团队共享设置与本机摘要采集（设计 §7）。
 *
 * 三条边界：
 * - 默认对**同队成员**共享白名单摘要（任务 / 日程 / 用量三类，可逐类关闭）；
 *   名册、动向、用量排行都只在同队成员之间可见（服务端按队收口）；
 * - 只上报白名单字段（标题/状态/时间），正文、提示词、工具参数、
 *   任务结果、日程证据与发送人一律不出本机；
 * - `sourceId` 由来源与更新时刻确定性生成，重复同步按幂等键跳过。
 *
 * 注意「标题」这一栏对任务类不是自由度：本机任务标题就是用户那句提问的第一行
 * （`tasks/store.ts` 的 `taskTitle`），所以任务动向只发固定占位词
 * `TASK_ACTIVITY_TITLE`，服务端也把 task 的 title 钉成同一个值。
 */

/**
 * 任务动向的标题：**固定占位词**，不得携带任何任务内容。
 *
 * 本站点原有实现直接发 `task.title`，而那个标题是从提示词首行裁出来的，
 * 等于把用户的问题交给同队同事（违反 HANDOFF「提示词一律不出本机」）。
 */
export const TASK_ACTIVITY_TITLE = "任务";

/**
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
 * 共享开关：任务 / 日程 / 用量三类（②-3 新增 `usage`）。
 * **默认全开**：加入团队即默认与同队成员共享这三类白名单摘要，可逐类手动关闭；
 * 提示词、对话正文与工具参数始终不出本机。
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
  /**
   * 「清除我的共享记录」的**动向水位**（epoch ms，默认 null）。
   *
   * 动向和用量一样是从本机记录派生出来的：只删服务端行的话，下一次同步会把
   * 同一批任务/日程按同一个 `sourceId` 原样传回去（服务端只剩 INSERT OR IGNORE），
   * 用户会看到自己刚清掉的摘要在一分钟内复活，而确认框写的是「不可恢复」。
   * 水位之后**改动过**的任务、之后**采集到**的日程才允许再上传。
   */
  activitiesClearedAt: number | null;
  lastSyncAt: number | null;
}

export const DEFAULT_TEAM_SHARE: TeamShareSettings = {
  tasks: true,
  agenda: true,
  usage: true,
  usageClearedAt: null,
  activitiesClearedAt: null,
  lastSyncAt: null,
};

/**
 * 开关字段读取：缺失（旧版本没有这个字段）时回落到当前默认值，
 * 显式存成 `true` 才算开；其它脏值一律按关处理（不因为坏数据擅自共享）。
 */
function readShareFlag(raw: unknown, fallback: boolean): boolean {
  if (raw === undefined) return fallback;
  return raw === true;
}

/** 水位统一解析：正有限数 → 取整毫秒；其它（含 0/NaN/字符串）→ null。 */
function normalizeWatermark(raw: unknown): number | null {
  return typeof raw === "number" && Number.isFinite(raw) && raw > 0 ? Math.floor(raw) : null;
}

export function normalizeTeamShareSettings(raw: unknown): TeamShareSettings {
  if (!raw || typeof raw !== "object") return { ...DEFAULT_TEAM_SHARE };
  const o = raw as Record<string, unknown>;
  return {
    tasks: readShareFlag(o.tasks, DEFAULT_TEAM_SHARE.tasks),
    agenda: readShareFlag(o.agenda, DEFAULT_TEAM_SHARE.agenda),
    usage: readShareFlag(o.usage, DEFAULT_TEAM_SHARE.usage),
    usageClearedAt: normalizeWatermark(o.usageClearedAt),
    activitiesClearedAt: normalizeWatermark(o.activitiesClearedAt),
    lastSyncAt:
      typeof o.lastSyncAt === "number" && Number.isFinite(o.lastSyncAt) ? o.lastSyncAt : null,
  };
}

export function readTeamShareSettings(
  storage: StorageLike = createDefaultStorage(),
): TeamShareSettings {
  return readJson(storage, TEAM_SHARE_KEY, { ...DEFAULT_TEAM_SHARE }, normalizeTeamShareSettings);
}

function persistTeamShareSettings(
  settings: TeamShareSettings,
  storage: StorageLike = createDefaultStorage(),
): void {
  writeJson(storage, TEAM_SHARE_KEY, settings, TEAM_SHARE_BYTE_LIMIT);
}

/**
 * 共享设置的「归属账号」键。
 *
 * 共享开关和清除水位都是**这个人的决定**，不是这台机器的：同一台电脑换账号登录时
 * 如果沿用上一个人的设置，新账号会在从未同意的情况下把本机任务、日程、用量
 * 上报给同队成员；上一个人的水位对新账号也没有意义（会莫名吞掉新账号自己的摘要）。
 */
export const TEAM_SHARE_OWNER_KEY = "heming.team.share.owner.v1";

export function readTeamShareOwner(storage: StorageLike = createDefaultStorage()): string | null {
  return readJson<string | null>(storage, TEAM_SHARE_OWNER_KEY, null, (raw) =>
    typeof raw === "string" && raw.length > 0 ? raw : null,
  );
}

/**
 * 把共享设置绑定到当前登录账号（`AppShell` 在登录成功 / 恢复会话后调用）。
 *
 * 三种情形：
 * - 首次绑定（旧版本没有归属键）：**认领**现有设置而不是清空——老用户升级后开关不丢；
 * - 同一账号：no-op（每次渲染都调用也不会写盘）；
 * - 换账号：清回默认设置（当前默认=三类全开）并落盘，水位一起清空，同时把内存里的
 *   store 同步过来（TeamPage / HomeTeamUsage 读的是 store，只改 localStorage 会等到刷新才生效）。
 */
export function bindTeamShareUser(
  userId: string,
  storage: StorageLike = createDefaultStorage(),
): void {
  if (!userId) return;
  const owner = readTeamShareOwner(storage);
  if (owner === userId) return;
  if (owner === null) {
    writeJson(storage, TEAM_SHARE_OWNER_KEY, userId);
    return;
  }
  const settings = { ...DEFAULT_TEAM_SHARE };
  persistTeamShareSettings(settings, storage);
  writeJson(storage, TEAM_SHARE_OWNER_KEY, userId);
  useTeamShareStore.setState({ settings });
}

interface TeamShareState {
  settings: TeamShareSettings;
  update: (patch: Partial<Pick<TeamShareSettings, "tasks" | "agenda" | "usage">>) => void;
  setLastSync: (at: number | null) => void;
  /** 「清除我的用量」成功后落水位：水位之前的用量不再重新上传。 */
  setUsageClearedAt: (at: number | null) => void;
  /** 「清除我的共享记录」成功后落水位：水位之前的任务/日程摘要不再重新上传。 */
  setActivitiesClearedAt: (at: number | null) => void;
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
  setActivitiesClearedAt: (at) => {
    const settings = { ...get().settings, activitiesClearedAt: at };
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

const BUCKET_LABEL: Record<AgendaBucket, string> = {
  overdue: "已逾期",
  today: "今天到期",
  "next24h": "24 小时内到期",
};

/** 采集排序用的档位优先级：逾期最急，其次今天，再次 24 小时内。 */
const BUCKET_ORDER: Record<AgendaBucket, number> = { overdue: 0, today: 1, next24h: 2 };

/**
 * 日程的「采集时刻」（epoch ms）：信息中枢里的 `msgTs` 是 **Unix 秒**（`datetime.fromtimestamp`），
 * 这里归一成毫秒好和清除水位比较；缺失/非法按 0（当作很久以前）。
 */
function agendaCreatedMs(item: InfohubAgendaItem): number {
  const raw = Number(item.msgTs);
  if (!Number.isFinite(raw) || raw <= 0) return 0;
  return raw > 1e12 ? raw : raw * 1000;
}

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
  now = Date.now(),
): TeamActivityInput[] {
  const out: TeamActivityInput[] = [];
  const seen = new Set<string>();
  /** 清除水位：水位之前的任务改动 / 日程不采集，避免「清除」后被同一批数据填回来。 */
  const clearedAt = settings.activitiesClearedAt ?? 0;

  const push = (item: TeamActivityInput) => {
    if (seen.has(item.sourceId)) return;
    seen.add(item.sourceId);
    out.push(item);
  };

  if (settings.tasks) {
    for (const task of [...sources.tasks]
      .filter((task) => clearedAt === 0 || task.updatedAt > clearedAt)
      .sort((a, b) => b.updatedAt - a.updatedAt)
      .slice(0, PER_SOURCE_LIMIT.tasks)) {
      push({
        kind: "task",
        // 只发改动与状态：标题从提示词首行裁出来，不是可以共享的信息。
        title: TASK_ACTIVITY_TITLE,
        detail: `任务 · ${TASK_STATUS_LABEL[task.status]}`,
        status: task.status,
        sourceId: `task:${task.id}:${task.updatedAt}`,
        occurredAt: iso(task.updatedAt),
      });
    }
  }

  if (settings.agenda) {
    // 只采「逾期 / 今天 / 24 小时内」：更远的日程不是摘要，传上去只会显示成
    // 「今天到期」（B2 的根因是这里自己抄了一份两档判据，现在直接用 agendaBucket 真源）。
    const live = sources.agenda
      .filter((item) => clearedAt === 0 || agendaCreatedMs(item) > clearedAt)
      .map((item) => ({ item, bucket: agendaBucket(item.dueTs, now) }))
      .filter(
        (entry): entry is { item: InfohubAgendaItem; bucket: AgendaBucket } => entry.bucket !== null,
      );
    // 逾期：最近逾期的在前（还来得及补）；今天/24 小时内：到期越近越前。
    // 排序必须在 slice 之前：原实现按 dueTs 倒序 slice(30)，远期条目会把临期的挤掉。
    live.sort(
      (a, b) =>
        BUCKET_ORDER[a.bucket] - BUCKET_ORDER[b.bucket] ||
        (a.bucket === "overdue" ? b.item.dueTs - a.item.dueTs : a.item.dueTs - b.item.dueTs),
    );
    for (const { item, bucket } of live.slice(0, PER_SOURCE_LIMIT.agenda)) {
      push({
        kind: "agenda",
        title: item.title,
        detail: `日程 · ${BUCKET_LABEL[bucket]}`,
        status: bucket,
        // sourceId 只认日程本身：把档位/到期时间拼进去，会让「今天到期 → 已逾期」变成
        // 一条新记录（同一条日程在团队页出现两行）。服务端按 (actor, sourceId) 幂等，
        // 因此换档不重发；档位文案以首次上报时为准。
        sourceId: `agenda:${item.id}`,
        // 未来日程的到期时间不能当成「刚刚发生」的时刻，否则动向会把它排到最上面；
        // 首次上报时刻即 now（行靠 sourceId 幂等，后续同步不会改变这一行）。
        occurredAt: iso(Math.min(item.dueTs, now)),
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
