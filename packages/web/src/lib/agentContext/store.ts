import type { ChatMessage, StorageLike, SummaryCacheData, SummaryCacheEntry } from "./types.js";
import { CONTEXT_KEYS } from "./settings.js";
import { createDefaultStorage, isPlainObject, readJson, utf8Length, writeJson } from "../memory/storage.js";

/**
 * 摘要缓存（设计 §3.3）：键 `heming.contextSummaries.v1`，按会话 + older 指纹存摘要，
 * 命中即复用（避免每轮重复花 token）。全部本机、损坏回退空集、写入异常静默。
 */

/** 每会话最多缓存条数。 */
export const SUMMARY_CACHE_LIMIT = 20;
/** 全量 JSON 上限：超过即全局淘汰最旧（与既有单键配额一致）。 */
export const SUMMARY_CACHE_BYTES = Math.floor(1.2 * 1024 * 1024);

/** djb2（逐字符），只用于指纹去重，不做安全用途。 */
function hashContent(text: string, seed: number): number {
  let hash = seed;
  for (let i = 0; i < text.length; i++) {
    hash = (hash * 33 + text.charCodeAt(i)) | 0;
  }
  return hash;
}

function pickEntry(raw: unknown): SummaryCacheEntry | undefined {
  if (!isPlainObject(raw)) return undefined;
  if (typeof raw.summary !== "string") return undefined;
  const at = typeof raw.at === "number" && Number.isFinite(raw.at) ? raw.at : 0;
  return { summary: raw.summary, at };
}

function pickData(raw: unknown): SummaryCacheData {
  if (!isPlainObject(raw)) return {};
  const out: SummaryCacheData = {};
  for (const [conversationId, bucket] of Object.entries(raw)) {
    if (!isPlainObject(bucket)) continue;
    const entries: Record<string, SummaryCacheEntry> = {};
    for (const [fingerprint, entry] of Object.entries(bucket)) {
      const picked = pickEntry(entry);
      if (picked) entries[fingerprint] = picked;
    }
    if (Object.keys(entries).length) out[conversationId] = entries;
  }
  return out;
}

/** 淘汰排序：at 小的先走，同刻按键名字典序（确定性，便于测试锁定）。 */
function olderFirst(
  a: { key: string; at: number },
  b: { key: string; at: number },
): number {
  return a.at - b.at || (a.key < b.key ? -1 : a.key > b.key ? 1 : 0);
}

/**
 * 摘要缓存入口。构造时可注入 `StorageLike` 与 `now()`：
 * 前者便于测试断言落盘/模拟配额异常，后者让 `at` 与淘汰顺序可被确定性验证。
 */
export class SummaryCache {
  private readonly storage: StorageLike;
  private readonly now: () => number;
  private data: SummaryCacheData;

  constructor(storage?: StorageLike, now?: () => number) {
    this.storage = storage ?? createDefaultStorage();
    this.now = now ?? (() => Date.now());
    this.data = this.load();
  }

  private load(): SummaryCacheData {
    try {
      return readJson(this.storage, CONTEXT_KEYS.summaries, {}, pickData);
    } catch {
      return {};
    }
  }

  /**
   * older 指纹：会话 + 条数 + 首末条的 role/长度 + 各条 content 长度之和 + 内容哈希。
   * 消息没有 id（`ChatMessage` 只有 role/content），故用 role + 长度作首末标识，
   * 并额外加一段内容哈希——条数与总长相同但内容变了（编辑过历史）时不至于复用过期摘要。
   */
  fingerprint(conversationId: string, older: ChatMessage[]): string {
    const list = Array.isArray(older) ? older : [];
    const head = list.length ? `${list[0]?.role ?? ""}:${String(list[0]?.content ?? "").length}` : "-";
    const tail = list.length
      ? `${list[list.length - 1]?.role ?? ""}:${String(list[list.length - 1]?.content ?? "").length}`
      : "-";
    let chars = 0;
    let hash = 5381;
    for (const row of list) {
      const content = String(row?.content ?? "");
      chars += content.length;
      hash = hashContent(content, hash);
      hash = hashContent("|", hash); // 分隔，避免相邻消息拼接歧义
    }
    return [
      String(conversationId ?? ""),
      list.length,
      head,
      tail,
      chars,
      (hash >>> 0).toString(36),
    ].join("|");
  }

  /**
   * 取摘要：未命中返回 undefined。`at` 只在写入时刷新（get 不落盘），
   * 淘汰即「写入时刻最早的先走」。
   */
  get(conversationId: string, fingerprint: string): string | undefined {
    try {
      return this.data[conversationId]?.[fingerprint]?.summary;
    } catch {
      return undefined;
    }
  }

  /** 写摘要：每会话超 20 条按 at 淘汰最旧；总 JSON 超 1.2MB 再全局淘汰最旧。 */
  set(conversationId: string, fingerprint: string, summary: string): void {
    try {
      const bucket: Record<string, SummaryCacheEntry> = {
        ...(this.data[conversationId] ?? {}),
        [fingerprint]: { summary: String(summary ?? ""), at: this.now() },
      };
      const trimmed = this.evictConversation(bucket);
      const next = { ...this.data };
      if (Object.keys(trimmed).length) next[conversationId] = trimmed;
      else delete next[conversationId];
      this.data = this.evictGlobal(next);
      this.save();
    } catch {
      /* 缓存失败静默：摘要照常返回，只是下次不命中 */
    }
  }

  /** 清缓存：给 conversationId 只清该会话，缺省清空全部（连键一起删）。 */
  clear(conversationId?: string): void {
    try {
      if (conversationId === undefined) {
        this.data = {};
        this.storage.removeItem(CONTEXT_KEYS.summaries);
        return;
      }
      const next = { ...this.data };
      delete next[conversationId];
      this.data = next;
      this.save();
    } catch {
      /* 静默 */
    }
  }

  private evictConversation(bucket: Record<string, SummaryCacheEntry>): Record<string, SummaryCacheEntry> {
    const keys = Object.keys(bucket);
    if (keys.length <= SUMMARY_CACHE_LIMIT) return bucket;
    const drop = new Set(
      keys
        .map((key) => ({ key, at: bucket[key].at }))
        .sort(olderFirst)
        .slice(0, keys.length - SUMMARY_CACHE_LIMIT)
        .map((item) => item.key),
    );
    const kept: Record<string, SummaryCacheEntry> = {};
    for (const key of keys) if (!drop.has(key)) kept[key] = bucket[key];
    return kept;
  }

  private evictGlobal(data: SummaryCacheData): SummaryCacheData {
    let out = data;
    while (utf8Length(JSON.stringify(out)) > SUMMARY_CACHE_BYTES) {
      let victim: { conversationId: string; fingerprint: string; at: number } | null = null;
      for (const [conversationId, bucket] of Object.entries(out)) {
        for (const [fingerprint, entry] of Object.entries(bucket)) {
          if (!victim || olderFirst({ key: fingerprint, at: entry.at }, { key: victim.fingerprint, at: victim.at }) < 0) {
            victim = { conversationId, fingerprint, at: entry.at };
          }
        }
      }
      if (!victim) break;
      const kept = { ...out[victim.conversationId] };
      delete kept[victim.fingerprint];
      const next = { ...out };
      if (Object.keys(kept).length) next[victim.conversationId] = kept;
      else delete next[victim.conversationId];
      out = next;
    }
    return out;
  }

  private save(): void {
    try {
      writeJson(this.storage, CONTEXT_KEYS.summaries, this.data);
    } catch {
      /* 落盘失败静默：内存态仍可用 */
    }
  }
}
