import { createDefaultStorage, isPlainObject, readJson, writeJson } from "../memory/storage.js";
import type { StorageLike } from "../memory/types.js";
import {
  ROLLOUT_ITEM_TYPES,
  ROLLOUT_VERSION,
  type RolloutInput,
  type RolloutItem,
  type RolloutItemType,
  type RolloutStreamView,
  type RolloutSummary,
} from "./types.js";

/**
 * 回合事件日志的**记录器**（纯逻辑 + 可注入存储，便于单测）。
 *
 * 三条硬约束，与项目其它本机数据同口径：
 * 1. **永不抛**：记录失败绝不能反噬对话（写入异常 → 返回 false，静默）；
 * 2. **有界**：单回合最多 `maxItems` 条、单条文本有上限、最多保留 `maxStreams` 个回合——
 *    日志是排查用的，不是第二个消息存储，不该把配额吃满；
 * 3. **可丢弃**：`clear()` 一次清干净，不提供「部分删除」这种说不清的语义。
 *
 * v2（d.56）只加一件事：追加时给每条记录分配单调递增的 `seq`。读取端兼容 v1
 * （缺 `seq` 用数组下标补齐）；**不做批量迁移**：v1 日志随 20 回合上限自然淘汰。
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
  items: unknown[];
}

interface StoredIndex {
  version: number;
  streamIds: string[];
}

/** 从存储里读出来的原始形态（还没按版本解析）。 */
interface RawStream {
  version: number;
  items: unknown[];
  lastAt: string | null;
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
  /** 追加一条记录。`at` / `seq` 由记录器填，调用方不必传。 */
  append(item: RolloutInput): boolean;
  /** 读一个回合的完整序列（未知回合返回空数组；v1 的 seq 已按下标补齐）。 */
  read(streamId: string): RolloutItem[];
  /** 连版本一起读（界面据此决定「v1 不可分叉」「版本不认识只报数」）。 */
  readStream(streamId: string): RolloutStreamView;
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

function asString(value: unknown, fallback = ""): string {
  return typeof value === "string" ? value : fallback;
}

function knownType(value: unknown): RolloutItemType | null {
  return typeof value === "string" && (ROLLOUT_ITEM_TYPES as readonly string[]).includes(value)
    ? (value as RolloutItemType)
    : null;
}

/**
 * 存储里的一条原始记录 → 带 seq 的 item。
 *
 * 解析口径与项目其它本机数据一致：**结构不符就丢弃这一条**（不猜、不补默认业务值），
 * 只有 `seq`/`at` 这类记录器自己的元数据可以补——补的依据是它在数组里的位置。
 */
function pickItem(raw: unknown, index: number): RolloutItem | null {
  if (!isPlainObject(raw)) return null;
  const type = knownType(raw.type);
  if (!type) return null;
  const streamId = asString(raw.streamId);
  if (!streamId) return null;
  const at = asString(raw.at);
  // v1 没有 seq：用数组下标补齐（只读场景够用）；非法值同样回落，读日志绝不能因一条坏记录整段失败。
  const seq =
    typeof raw.seq === "number" && Number.isFinite(raw.seq) && raw.seq >= 0
      ? Math.floor(raw.seq)
      : index;

  switch (type) {
    case "turn_start": {
      const forked = isPlainObject(raw.forkedFrom) ? raw.forkedFrom : null;
      const forkStreamId = forked ? asString(forked.streamId) : "";
      const forkSeq = forked && typeof forked.seq === "number" ? forked.seq : -1;
      return {
        type,
        seq,
        at,
        conversationId: asString(raw.conversationId),
        streamId,
        agentId: asString(raw.agentId),
        userText: asString(raw.userText),
        ...(forkStreamId && forkSeq >= 0
          ? { forkedFrom: { streamId: forkStreamId, seq: Math.floor(forkSeq) } }
          : {}),
      };
    }
    case "tool_call":
      return {
        type,
        seq,
        at,
        streamId,
        id: asString(raw.id),
        name: asString(raw.name),
        args: asString(raw.args),
      };
    case "tool_result":
      return {
        type,
        seq,
        at,
        streamId,
        id: asString(raw.id),
        name: asString(raw.name),
        ok: raw.ok === true,
        ...(raw.denied === true ? { denied: true } : {}),
        text: asString(raw.text),
      };
    case "assistant_final":
      return { type, seq, at, streamId, text: asString(raw.text) };
    case "turn_end": {
      const status = raw.status;
      if (status !== "ok" && status !== "aborted" && status !== "error") return null;
      return {
        type,
        seq,
        at,
        streamId,
        status,
        ...(typeof raw.error === "string" && raw.error ? { error: raw.error } : {}),
      };
    }
    default:
      return null;
  }
}

/**
 * 把存储里的条目归一化成可回放的序列。
 *
 * - 未来版本（> 当前）**不解析**：只报数，不猜结构（§8）；
 * - v1 缺 seq → 按下标补；补齐后强制严格递增，避免坏数据让「按 seq 定位」指到两条。
 */
export function normalizeItems(rawItems: unknown[], storedVersion: number): RolloutItem[] {
  if (storedVersion > ROLLOUT_VERSION) return [];
  const out: RolloutItem[] = [];
  rawItems.forEach((raw, index) => {
    const item = pickItem(raw, index);
    if (item) out.push(item);
  });
  for (let i = 1; i < out.length; i += 1) {
    const prev = out[i - 1] as RolloutItem;
    const cur = out[i] as RolloutItem;
    if (cur.seq <= prev.seq) out[i] = { ...cur, seq: prev.seq + 1 } as RolloutItem;
  }
  return out;
}

/** 版本缺失时的推断：有真 seq 就是 v2，否则按 v1（老格式每条都写 version，这里是兜底）。 */
function inferVersion(rawItems: unknown[]): number {
  const hasSeq = rawItems.some(
    (raw) => isPlainObject(raw) && typeof raw.seq === "number" && Number.isFinite(raw.seq),
  );
  return hasSeq ? 2 : 1;
}

function lastAtOf(rawItems: unknown[]): string | null {
  for (let i = rawItems.length - 1; i >= 0; i -= 1) {
    const raw = rawItems[i];
    if (isPlainObject(raw) && typeof raw.at === "string") return raw.at;
  }
  return null;
}

function emptyView(streamId: string): RolloutStreamView {
  return { streamId, version: ROLLOUT_VERSION, items: [], count: 0, lastAt: null };
}

export function createRolloutLog(options: RolloutLogOptions = {}): RolloutLog {
  const storage = options.storage ?? createDefaultStorage();
  const now = options.now ?? (() => new Date().toISOString());
  const maxItems = Math.max(1, Math.floor(options.maxItems ?? MAX_ITEMS_PER_STREAM));
  const maxStreams = Math.max(1, Math.floor(options.maxStreams ?? MAX_STREAMS));
  const maxTextChars = Math.max(1, Math.floor(options.maxTextChars ?? MAX_TEXT_CHARS));

  const streamKey = (streamId: string) => `${ROLLOUT_KEY_PREFIX}.${streamId}`;

  const readRaw = (streamId: string): RawStream =>
    readJson<RawStream>(
      storage,
      streamKey(streamId),
      { version: ROLLOUT_VERSION, items: [], lastAt: null },
      (raw) => {
        if (!isPlainObject(raw)) return { version: ROLLOUT_VERSION, items: [], lastAt: null };
        const items = Array.isArray(raw.items) ? raw.items : [];
        const version =
          typeof raw.version === "number" && Number.isFinite(raw.version) && raw.version >= 1
            ? Math.floor(raw.version)
            : inferVersion(items);
        return { version, items, lastAt: lastAtOf(items) };
      },
    );

  const readIndex = (): StoredIndex =>
    readJson<StoredIndex>(storage, ROLLOUT_INDEX_KEY, { version: ROLLOUT_VERSION, streamIds: [] }, (raw) => {
      const value = raw as Partial<StoredIndex> | null;
      if (!value || !Array.isArray(value.streamIds)) {
        return { version: ROLLOUT_VERSION, streamIds: [] };
      }
      return { version: ROLLOUT_VERSION, streamIds: value.streamIds.filter((x) => typeof x === "string") };
    });

  const readStream = (streamId: string): RolloutStreamView => {
    try {
      const raw = readRaw(streamId);
      const items = normalizeItems(raw.items, raw.version);
      return { streamId, version: raw.version, items, count: raw.items.length, lastAt: raw.lastAt };
    } catch {
      return emptyView(streamId);
    }
  };

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
        const view = readStream(streamId);
        // 未来版本写的日志不覆盖：看不懂的结构，写一次就等于把新版本的数据削成本版本。
        if (view.version > ROLLOUT_VERSION) return false;
        // seq 是记录器独占的元数据：上一条 +1（空日志从 0 起，与 v1 的下标补齐口径一致）。
        const seq = view.items.length ? (view.items[view.items.length - 1] as RolloutItem).seq + 1 : 0;
        const withTime = trimItem({ ...item, at: now(), seq } as RolloutItem, maxTextChars);
        const items = [...view.items, withTime].slice(-maxItems);
        const ok = writeJson(storage, streamKey(streamId), { version: ROLLOUT_VERSION, items });
        if (ok) touchIndex(streamId);
        return ok;
      } catch {
        return false; // 日志失败绝不影响对话
      }
    },

    read(streamId) {
      return readStream(streamId).items;
    },

    readStream,

    list() {
      try {
        return readIndex()
          .streamIds.map((streamId) => {
            const view = readStream(streamId);
            const end = view.items.find((it) => it.type === "turn_end") as
              | { status: "ok" | "aborted" | "error" }
              | undefined;
            return {
              streamId,
              version: view.version,
              items: view.count,
              lastAt: view.lastAt,
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
