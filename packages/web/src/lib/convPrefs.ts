/**
 * 本机会话偏好（d.39 免打扰，d.40 置顶）。
 *
 * 不跟设备、不上云：这是本机的整理与提醒偏好，不是会话数据。
 * 免打扰只抑制提醒，不抑制未读——消息照常计数，只是不响。
 */
export const CONV_PREFS_KEY = "heming.convPrefs.v1";

export interface ConvPref {
  muted?: boolean;
  pinned?: boolean;
}

let cache: Record<string, ConvPref> | null = null;
let version = 0;
const listeners = new Set<() => void>();

function storage(): Storage | null {
  try {
    return window.localStorage;
  } catch {
    return null;
  }
}

function read(): Record<string, ConvPref> {
  if (cache) return cache;
  const out: Record<string, ConvPref> = {};
  try {
    const raw = storage()?.getItem(CONV_PREFS_KEY);
    const parsed: unknown = raw ? JSON.parse(raw) : null;
    if (parsed && typeof parsed === "object" && !Array.isArray(parsed)) {
      for (const [id, value] of Object.entries(parsed as Record<string, unknown>)) {
        if (!value || typeof value !== "object") continue;
        const src = value as ConvPref;
        const pref: ConvPref = {};
        if (src.muted === true) pref.muted = true;
        if (src.pinned === true) pref.pinned = true;
        if (pref.muted || pref.pinned) out[id] = pref;
      }
    }
  } catch {
    /* 坏 JSON / 隐私模式 → 空表 */
  }
  cache = out;
  return out;
}

function persist(next: Record<string, ConvPref>): void {
  cache = next;
  version += 1;
  try {
    storage()?.setItem(CONV_PREFS_KEY, JSON.stringify(next));
  } catch {
    /* 配额/隐私模式：本次会话生效，刷新丢失 */
  }
  for (const listener of [...listeners]) {
    try {
      listener();
    } catch {
      /* 订阅者异常不影响其它订阅 */
    }
  }
}

export function isMuted(convId: string): boolean {
  return read()[convId]?.muted === true;
}

export function isPinned(convId: string): boolean {
  return read()[convId]?.pinned === true;
}

/** 只改一个字段：另一个字段原样保留，两个都没了才删键。 */
function setFlag(convId: string, key: "muted" | "pinned", on: boolean): void {
  const current = read();
  const next = { ...current };
  const entry: ConvPref = { ...(next[convId] ?? {}) };
  if (on) entry[key] = true;
  else delete entry[key];
  if (entry.muted || entry.pinned) next[convId] = entry;
  else delete next[convId];
  persist(next);
}

export function setMuted(convId: string, muted: boolean): void {
  setFlag(convId, "muted", muted);
}

export function setPinned(convId: string, pinned: boolean): void {
  setFlag(convId, "pinned", pinned);
}

export function convPrefsVersion(): number {
  return version;
}

export function subscribeConvPrefs(listener: () => void): () => void {
  listeners.add(listener);
  return () => {
    listeners.delete(listener);
  };
}

/** 测试隔离：清掉内存缓存与版本（不动 localStorage）。 */
export function resetConvPrefsForTest(): void {
  cache = null;
  version = 0;
}
