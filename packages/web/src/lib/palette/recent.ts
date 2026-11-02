/**
 * 命令面板 · 最近使用（本机，≤5）。
 *
 * 边界：
 * - **只存本机**：`localStorage` 单键，不上云、不进导出、换设备不跟随；
 * - 只记「可离线复原」的三类：页面 / 设置分区 / 动作。成员、技能、归档不记
 *   （成员名与归档内容属于会变的远端/本机数据，记下来会出现「点进去找不到」）；
 * - 容量 5，按「最近一次执行」排序，同一条重复执行只前移不重复；
 * - 坏数据一律当空：JSON 坏、结构不对、未知 kind 都安全跳过，不抛错。
 */

export type RecentKind = "page" | "setting" | "action";

export interface RecentEntry {
  kind: RecentKind;
  /** page 用 Page 值、setting 用 tab、action 用 PaletteActionId。 */
  id: string;
}

export const RECENT_KEY = "heming.palette.recent.v1";
export const MAX_RECENT = 5;

/** 最小存储接口，便于单测注入。 */
export type RecentStorage = Pick<Storage, "getItem" | "setItem">;

function safeStorage(): RecentStorage | null {
  try {
    return typeof window === "undefined" ? null : window.localStorage;
  } catch {
    return null;
  }
}

function isRecentKind(value: unknown): value is RecentKind {
  return value === "page" || value === "setting" || value === "action";
}

/** 规整任意读回值：只保留合法项、去重、截断到上限。 */
export function normalizeRecent(raw: unknown, max = MAX_RECENT): RecentEntry[] {
  if (!Array.isArray(raw)) return [];
  const out: RecentEntry[] = [];
  for (const item of raw) {
    if (!item || typeof item !== "object") continue;
    const kind = (item as { kind?: unknown }).kind;
    const id = (item as { id?: unknown }).id;
    if (!isRecentKind(kind) || typeof id !== "string" || !id) continue;
    if (out.some((e) => e.kind === kind && e.id === id)) continue;
    out.push({ kind, id });
    if (out.length >= max) break;
  }
  return out;
}

/** 读最近使用；缺失/损坏 → 空数组。 */
export function loadRecent(storage: RecentStorage | null = safeStorage()): RecentEntry[] {
  if (!storage) return [];
  try {
    const raw = storage.getItem(RECENT_KEY);
    if (!raw) return [];
    return normalizeRecent(JSON.parse(raw));
  } catch {
    return [];
  }
}

/**
 * 记一次使用，返回更新后的列表（并把结果写盘）。
 * 同一条已在列表里时先移除再插到队首——这就是「最近优先」的实现。
 */
export function recordRecent(
  entry: RecentEntry,
  storage: RecentStorage | null = safeStorage(),
  max = MAX_RECENT,
): RecentEntry[] {
  const current = loadRecent(storage).filter((e) => !(e.kind === entry.kind && e.id === entry.id));
  const next = normalizeRecent([entry, ...current], max);
  if (storage) {
    try {
      storage.setItem(RECENT_KEY, JSON.stringify(next));
    } catch {
      /* 配额满/隐私模式：只在本次会话生效 */
    }
  }
  return next;
}

/** 清空最近使用（供测试与将来的「清除记录」入口）。 */
export function clearRecent(storage: RecentStorage | null = safeStorage()): void {
  if (!storage) return;
  try {
    storage.setItem(RECENT_KEY, JSON.stringify([]));
  } catch {
    /* 忽略 */
  }
}
