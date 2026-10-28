/**
 * 本机会话偏好（d.39）：目前只有「免打扰」。
 *
 * 不跟设备、不上云：这是本机的提醒偏好，不是会话数据。
 * 免打扰只抑制提醒，不抑制未读——消息照常计数，只是不响。
 */
export const CONV_PREFS_KEY = "heming.convPrefs.v1";

export interface ConvPref {
  muted?: boolean;
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
        if (value && typeof value === "object" && (value as ConvPref).muted === true) {
          out[id] = { muted: true };
        }
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

export function setMuted(convId: string, muted: boolean): void {
  const current = read();
  const next = { ...current };
  if (muted) next[convId] = { muted: true };
  else delete next[convId];
  persist(next);
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
