import type { StorageLike } from "./types.js";

/**
 * 本机存储层（设计 §8）：键名带 `.v1` 便于后续迁移；损坏数据回退空集、
 * 写入异常静默——记忆/技能失败绝不影响聊天主链路。
 */

/** 记忆四键：三层各一键 + 设置。 */
export const MEMORY_KEYS = {
  working: "heming.memory.working.v1",
  episodic: "heming.memory.episodic.v1",
  semantic: "heming.memory.semantic.v1",
  settings: "heming.memory.settings.v1",
} as const;

/** 单键 JSON 上限 1.2MB（设计 §8）：超限先淘汰，仍写不下就放弃落盘（仅内存可用）。 */
export const KEY_SIZE_LIMIT = Math.floor(1.2 * 1024 * 1024);

const encoder: TextEncoder | null = typeof TextEncoder !== "undefined" ? new TextEncoder() : null;

/** 文本 UTF-8 字节数（配额按字节算：中文一字三字节）。 */
export function utf8Length(text: string): number {
  return encoder ? encoder.encode(text).length : text.length;
}

export function isPlainObject(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

/** 纯内存 StorageLike：localStorage 不可用或配额爆掉时的兜底（仅本次会话可读）。 */
export function createMemoryStorage(): StorageLike {
  const map = new Map<string, string>();
  return {
    getItem: (k) => (map.has(k) ? (map.get(k) as string) : null),
    setItem: (k, v) => {
      map.set(k, v);
    },
    removeItem: (k) => {
      map.delete(k);
    },
  };
}

/**
 * 默认存储：浏览器/Electron 走 localStorage；不可用（SSR、隐私模式抛错、
 * 配额已满到连探针都写不进）时降级为纯内存，绝不抛出。
 */
export function createDefaultStorage(): StorageLike {
  try {
    if (typeof localStorage !== "undefined" && localStorage) {
      const probe = "heming.memory.probe";
      localStorage.setItem(probe, "1");
      localStorage.removeItem(probe);
      return localStorage;
    }
  } catch {
    /* 隐私模式/配额异常 → 降级纯内存 */
  }
  return createMemoryStorage();
}

/** 读取 JSON：缺键、损坏、结构不符一律回退 fallback（与 store/llm.ts 同策略）。 */
export function readJson<T>(
  storage: StorageLike,
  key: string,
  fallback: T,
  pick?: (raw: unknown) => T,
): T {
  try {
    const raw = storage.getItem(key);
    if (raw == null) return fallback;
    const parsed: unknown = JSON.parse(raw);
    return pick ? pick(parsed) : (parsed as T);
  } catch {
    return fallback;
  }
}

/**
 * 写入 JSON：序列化失败、超配额、storage 抛错一律返回 false（调用方静默降级）。
 * 返回 false 表示「本次只留在内存里」，不表示数据损坏。
 */
export function writeJson(
  storage: StorageLike,
  key: string,
  value: unknown,
  limit: number = KEY_SIZE_LIMIT,
): boolean {
  let text: string;
  try {
    text = JSON.stringify(value);
  } catch {
    return false;
  }
  if (utf8Length(text) > limit) return false;
  try {
    storage.setItem(key, text);
    return true;
  } catch {
    return false;
  }
}
