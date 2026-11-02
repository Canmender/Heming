import { createDefaultStorage, readJson, writeJson } from "../memory/storage.js";
import type { StorageLike } from "../memory/types.js";
import { ROLLOUT_VERSION, type RolloutInput, type RolloutItem, type RolloutSummary } from "./types.js";

/**
 * 回合事件日志的**记录器**（纯逻辑 + 可注入存储，便于单测）。
 *
 * 三条硬约束，与项目其它本机数据同口径：
 * 1. **永不抛**：记录失败绝不能反噬对话（写入异常 → 返回 false，静默）；
 * 2. **有界**：单回合最多 `maxItems` 条、单条文本有上限、最多保留 `maxStreams` 个回合——
 *    日志是排查用的，不是第二个消息存储，不该把配额吃满；
 * 3. **可丢弃**：`clear()` 一次清干净，不提供「部分删除」这种说不清的语义。
 */

export const ROLLOUT_KEY_PREFIX = "heming.rollout.v1";
export const ROLLOUT_INDEX_KEY = "heming.rollout.index.v1";

/** 单回合最多保留的条目数：再长就不是排查问题，而是数据堆积。 */
export const MAX_ITEMS_PER_STREAM = 200;
/** 最多保留多少个回合（按最近写入淘汰）。 */
export const MAX_STREAMS = 20;
/** 单条文本上限：工具结果/答案/触发文本都按它截断。 */
export const MAX_TEXT_CHARS = 2000;

interface StoredStream {
  version: number;
  items: RolloutItem[];
}

interface StoredIndex {
  version: number;
  streamIds: string[];
}

export interface RolloutLogOptions {
  storage?: StorageLike;
  /** 时间源（测试注入固定时钟；缺省 `new Date().toISOString()`）。 */
  now?: () => string;
  maxItems?: number;
  maxStreams?: number;
  maxTextChars?: number;
}

export interface RolloutLog {
  /** 追加一条记录。`at` 由记录器填，调用方不必传。 */
  append(item: RolloutInput): boolean;
  /** 读一个回合的完整序列（未知回合返回空数组）。 */
  read(streamId: string): RolloutItem[];
  /** 列出已记录的回合（最近写入在前）。 */
  list(): RolloutSummary[];
  /** 清空（不传 streamId 则连索引一起清）。 */
  clear(streamId?: string): void;
}

function clip(text: string, max: number): string {
  const raw = String(text ?? "");
  return raw.length > max ? `${raw.slice(0, max)}…` : raw;
}

/** 按类型给各自的文本字段封顶：日志只保留够复盘的信息量。 */
function trimItem(item: RolloutItem, maxTextChars: number): RolloutItem {
  switch (item.type) {
    case "turn_start":
      return { ...item, userText: clip(item.userText, maxTextChars) };
    case "tool_call":
      return { ...item, args: clip(item.args, maxTextChars) };
    case "tool_result":
      return { ...item, text: clip(item.text, maxTextChars) };
    case "assistant_final":
      return { ...item, text: clip(item.text, maxTextChars) };
    case "turn_end":
      return { ...item, ...(item.error ? { error: clip(item.error, maxTextChars) } : {}) };
    default:
      return item;
  }
}

export function createRolloutLog(options: RolloutLogOptions = {}): RolloutLog {
  const storage = options.storage ?? createDefaultStorage();
  const now = options.now ?? (() => new Date().toISOString());
  const maxItems = Math.max(1, Math.floor(options.maxItems ?? MAX_ITEMS_PER_STREAM));
  const maxStreams = Math.max(1, Math.floor(options.maxStreams ?? MAX_STREAMS));
  const maxTextChars = Math.max(1, Math.floor(options.maxTextChars ?? MAX_TEXT_CHARS));

  const streamKey = (streamId: string) => `${ROLLOUT_KEY_PREFIX}.${streamId}`;

  const readStream = (streamId: string): StoredStream =>
    readJson<StoredStream>(storage, streamKey(streamId), { version: ROLLOUT_VERSION, items: [] }, (raw) => {
      const value = raw as Partial<StoredStream> | null;
      if (!value || !Array.isArray(value.items)) return { version: ROLLOUT_VERSION, items: [] };
      return { version: ROLLOUT_VERSION, items: value.items as RolloutItem[] };
    });

  const readIndex = (): StoredIndex =>
    readJson<StoredIndex>(storage, ROLLOUT_INDEX_KEY, { version: ROLLOUT_VERSION, streamIds: [] }, (raw) => {
      const value = raw as Partial<StoredIndex> | null;
      if (!value || !Array.isArray(value.streamIds)) {
        return { version: ROLLOUT_VERSION, streamIds: [] };
      }
      return { version: ROLLOUT_VERSION, streamIds: value.streamIds.filter((x) => typeof x === "string") };
    });

  const touchIndex = (streamId: string): void => {
    const index = readIndex();
    const next = [streamId, ...index.streamIds.filter((id) => id !== streamId)];
    const kept = next.slice(0, maxStreams);
    // 被挤出索引的回合连同正文一起删：留着正文却不在索引里，等于占着配额找不到。
    for (const dropped of next.slice(maxStreams)) {
      try {
        storage.removeItem(streamKey(dropped));
      } catch {
        /* 删不掉就留着，不影响本次写入 */
      }
    }
    writeJson(storage, ROLLOUT_INDEX_KEY, { version: ROLLOUT_VERSION, streamIds: kept });
  };

  return {
    append(item) {
      try {
        const streamId = item.streamId;
        if (!streamId) return false;
        const stream = readStream(streamId);
        const withTime = { ...trimItem({ ...item, at: now() } as RolloutItem, maxTextChars) };
        const items = [...stream.items, withTime].slice(-maxItems);
        const ok = writeJson(storage, streamKey(streamId), { version: ROLLOUT_VERSION, items });
        if (ok) touchIndex(streamId);
        return ok;
      } catch {
        return false; // 日志失败绝不影响对话
      }
    },

    read(streamId) {
      try {
        return readStream(streamId).items;
      } catch {
        return [];
      }
    },

    list() {
      try {
        return readIndex()
          .streamIds.map((streamId) => {
            const items = readStream(streamId).items;
            const last = items[items.length - 1];
            const end = items.find((it) => it.type === "turn_end") as
              | { status: "ok" | "aborted" | "error" }
              | undefined;
            return {
              streamId,
              items: items.length,
              lastAt: last?.at ?? null,
              ...(end ? { status: end.status } : {}),
            };
          })
          .filter((s) => s.items > 0);
      } catch {
        return [];
      }
    },

    clear(streamId) {
      try {
        if (streamId) {
          storage.removeItem(streamKey(streamId));
          const index = readIndex();
          writeJson(storage, ROLLOUT_INDEX_KEY, {
            version: ROLLOUT_VERSION,
            streamIds: index.streamIds.filter((id) => id !== streamId),
          });
          return;
        }
        for (const id of readIndex().streamIds) storage.removeItem(streamKey(id));
        storage.removeItem(ROLLOUT_INDEX_KEY);
      } catch {
        /* 清理失败不抛：下次写入会覆盖 */
      }
    },
  };
}
