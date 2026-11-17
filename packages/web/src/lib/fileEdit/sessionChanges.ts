/**
 * 会话改动台账（d.210）。
 *
 * 为什么另开一份记录：`turnWrites`（d.176/d.185）只活到「本轮可撤回」被关掉为止，
 * 而用户真正想回顾的是「这个会话到底动过哪些文件」——尤其是跑了几十轮的长任务，
 * 上一轮的清单早就被下一轮覆盖了。
 *
 * 口径：
 * - 只记「哪个文件在什么时间被改过几次」，不存内容（内容对照仍走写盘备份通道）；
 * - 按会话隔离，每会话最多 100 个文件、最多记 30 个会话，超出按最近一次改动时间淘汰；
 * - 只记成功落盘的路径（由调用方保证）；
 * - localStorage 不可用 / 坏数据一律静默降级成空表，绝不抛异常打断收口。
 */

export interface SessionChange {
  /** 绝对路径（与 file_write / file_edit 写盘时一致）。 */
  path: string;
  /** 最近一次改动时间（ms）。 */
  at: number;
  /** 这个会话里被改过的次数（同一文件多次改动累加）。 */
  writes: number;
}

export const SESSION_CHANGES_KEY = "heming.sessionChanges.v1";

/** 每个会话最多记多少个文件；再多就淘汰最久没动过的。 */
export const SESSION_CHANGES_MAX_FILES = 100;

/** 最多记多少个会话；再多就淘汰最近改动时间最老的会话。 */
export const SESSION_CHANGES_MAX_SESSIONS = 30;

type Store = Record<string, SessionChange[]>;

const listeners = new Set<() => void>();
/** 每个会话一份快照，保证 `getSessionChanges()` 在没变化时返回同一引用（useSyncExternalStore 要求）。 */
const snapshots = new Map<string, readonly SessionChange[]>();
let loaded = false;
let store: Store = {};

function isChange(value: unknown): value is SessionChange {
  if (!value || typeof value !== "object") return false;
  const item = value as Partial<SessionChange>;
  return (
    typeof item.path === "string" &&
    item.path.length > 0 &&
    typeof item.at === "number" &&
    Number.isFinite(item.at) &&
    typeof item.writes === "number" &&
    Number.isFinite(item.writes) &&
    item.writes > 0
  );
}

function readStorage(): Store {
  if (typeof localStorage === "undefined") return {};
  try {
    const raw = localStorage.getItem(SESSION_CHANGES_KEY);
    if (!raw) return {};
    const parsed: unknown = JSON.parse(raw);
    if (!parsed || typeof parsed !== "object") return {};
    const out: Store = {};
    for (const [conversationId, list] of Object.entries(parsed as Record<string, unknown>)) {
      if (!conversationId || !Array.isArray(list)) continue;
      const changes = list.filter(isChange).map((item) => ({ path: item.path, at: item.at, writes: item.writes }));
      if (changes.length > 0) out[conversationId] = changes;
    }
    return out;
  } catch {
    return {};
  }
}

function writeStorage(value: Store): void {
  if (typeof localStorage === "undefined") return;
  try {
    if (Object.keys(value).length === 0) localStorage.removeItem(SESSION_CHANGES_KEY);
    else localStorage.setItem(SESSION_CHANGES_KEY, JSON.stringify(value));
  } catch {
    // 配额满 / 隐私模式：内存里仍然对，只是重启后丢。
  }
}

function ensureLoaded(): void {
  if (loaded) return;
  loaded = true;
  store = readStorage();
}

function emit(): void {
  snapshots.clear();
  for (const listener of [...listeners]) {
    try {
      listener();
    } catch {
      // 单个订阅者抛错不该影响其他界面。
    }
  }
}

/** 按最近改动时间裁剪会话数与每会话文件数（会就地改 store 的引用，不改入参）。 */
function prune(value: Store, keepConversationId?: string): Store {
  const sessions = Object.entries(value);
  if (sessions.length > SESSION_CHANGES_MAX_SESSIONS) {
    const sorted = [...sessions].sort((a, b) => latestAt(b[1]) - latestAt(a[1]));
    const keep = new Set(sorted.slice(0, SESSION_CHANGES_MAX_SESSIONS).map(([id]) => id));
    if (keepConversationId) keep.add(keepConversationId);
    for (const [id] of sessions) if (!keep.has(id)) delete value[id];
  }
  for (const [id, list] of Object.entries(value)) {
    if (list.length <= SESSION_CHANGES_MAX_FILES) continue;
    const trimmed = [...list].sort((a, b) => b.at - a.at).slice(0, SESSION_CHANGES_MAX_FILES);
    value[id] = trimmed;
  }
  return value;
}

function latestAt(list: readonly SessionChange[]): number {
  let latest = 0;
  for (const item of list) if (item.at > latest) latest = item.at;
  return latest;
}

export function subscribeSessionChanges(listener: () => void): () => void {
  ensureLoaded();
  listeners.add(listener);
  return () => {
    listeners.delete(listener);
  };
}

/** 某会话的改动文件清单：最近改过的排在最前。没有记录时返回空数组（引用稳定）。 */
export function getSessionChanges(conversationId: string): readonly SessionChange[] {
  ensureLoaded();
  if (!conversationId) return EMPTY;
  const cached = snapshots.get(conversationId);
  if (cached) return cached;
  const list = store[conversationId] ?? [];
  const sorted = [...list].sort((a, b) => b.at - a.at);
  const snapshot = Object.freeze(sorted);
  snapshots.set(conversationId, snapshot);
  return snapshot;
}

const EMPTY: readonly SessionChange[] = Object.freeze([]);

/**
 * 记一次落盘（可一次传多个路径）。返回该会话现在的文件数。
 * 同一路径重复出现只算一次，但 `writes` 会累加——「改了几次」对用户是有用的信号。
 */
export function recordSessionChanges(
  conversationId: string,
  paths: readonly string[],
  now = Date.now(),
): number {
  ensureLoaded();
  const unique = [...new Set(paths.filter((path) => typeof path === "string" && path.length > 0))];
  if (!conversationId || unique.length === 0) return getSessionChanges(conversationId).length;
  const current = store[conversationId] ?? [];
  const next = new Map(current.map((item) => [item.path, item]));
  for (const path of unique) {
    const seen = next.get(path);
    if (seen) next.set(path, { path, at: now, writes: seen.writes + 1 });
    else next.set(path, { path, at: now, writes: 1 });
  }
  store = prune({ ...store, [conversationId]: [...next.values()] }, conversationId);
  writeStorage(store);
  emit();
  return getSessionChanges(conversationId).length;
}

/** 清掉某个会话的台账（不影响文件本身，也不影响写盘备份）。 */
export function clearSessionChanges(conversationId: string): void {
  ensureLoaded();
  if (!store[conversationId]) return;
  const next = { ...store };
  delete next[conversationId];
  store = next;
  writeStorage(store);
  emit();
}

/** 清空全部（测试与「重置本地数据」用）。 */
export function resetSessionChanges(): void {
  loaded = true;
  store = {};
  snapshots.clear();
  writeStorage(store);
  for (const listener of [...listeners]) {
    try {
      listener();
    } catch {
      // 同上：单个订阅者抛错不影响其他界面。
    }
  }
  listeners.clear();
}
