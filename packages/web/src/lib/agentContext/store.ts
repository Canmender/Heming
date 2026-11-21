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
 * 一条 entry 序列化后的**结构开销**（不含 fingerprint / summary / at 本身）。
 *
 * entry 在 JSON 里的形态：`"<fp>":{"summary":<S>,"at":<N>}`
 * 固定部分 = `:`(1) + `{`(1) + `"summary"`(9) + `:`(1) + `,`(1) +
 *            `"at"`(4) + `:`(1) + `}`(1) = 19 字节。
 */
const ENTRY_OVERHEAD = 19;

/** 桶头开销：`"<conv>":{` 与末尾 `}`，即 convId JSON 长度 + `:`(1) + `{`(1) + `}`(1) = +3。 */
function bucketOverhead(convId: string): number {
  return utf8Length(JSON.stringify(convId)) + 3;
}

/** 一条 entry 的完整字节（fingerprint + 结构 + summary + at 数字文本）。 */
function entryByteLength(fingerprint: string, entry: SummaryCacheEntry): number {
  return (
    utf8Length(JSON.stringify(fingerprint)) +
    ENTRY_OVERHEAD +
    utf8Length(JSON.stringify(entry.summary)) +
    String(entry.at).length
  );
}

/**
 * 精确计算 data 序列化成 JSON 后的 UTF-8 字节数，但不真正构造大字符串。
 * 与 `utf8Length(JSON.stringify(data))` 等价（有测试锁定），供 evictGlobal 增量记账用。
 */
export function summaryDataByteLength(data: SummaryCacheData): number {
  const convs = Object.keys(data);
  if (!convs.length) return 2; // "{}"
  // 外层 `{}`(2) + 桶间逗号(C-1)
  let total = 2 + convs.length - 1;
  for (const convId of convs) {
    const bucket = data[convId] as Record<string, SummaryCacheEntry>;
    const fps = Object.keys(bucket);
    // 桶头 + entry 间逗号(M-1)
    total += bucketOverhead(convId) + fps.length - 1;
    for (const fp of fps) total += entryByteLength(fp, bucket[fp] as SummaryCacheEntry);
  }
  return total;
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
      // role 也必须进指纹：摘要按角色归类（用户意图/助手结论/工具输出），
      // 两条正文逐字相同、仅中间条 role 不同（assistant vs tool）的历史
      // 若算出同一指纹，会把旧摘要误当新历史复用。head/tail 只含首末 role，
      // 中间条目的 role 此前完全没进哈希。
      hash = hashContent(String(row?.role ?? ""), hash);
      const content = String(row?.content ?? "");
      chars += content.length;
      hash = hashContent(content, hash);
      hash = hashContent("|", hash); // 分隔，避免相邻消息拼接歧义
      // 只哈希 content 不够：两条正文相同、tool_calls 却完全不同（读文件 vs 删文件）
      // 会算出同一个指纹，导致把旧摘要当成新历史的摘要复用。工具调用的
      // id/name/arguments、tool_call_id、name、多模态内容片都必须进指纹。
      if (Array.isArray(row?.contentParts)) {
        for (const part of row.contentParts) {
          if (!part) continue;
          hash = hashContent(
            part.type === "text"
              ? `T:${String(part.text ?? "")}`
              : `I:${String(part.mime ?? "")}:${String(part.data ?? "")}`,
            hash,
          );
          hash = hashContent("|", hash);
        }
      }
      if (Array.isArray(row?.tool_calls)) {
        for (const call of row.tool_calls) {
          hash = hashContent(
            `C:${String(call?.id ?? "")}:${String(call?.function?.name ?? "")}:${String(call?.function?.arguments ?? "")}`,
            hash,
          );
          hash = hashContent("|", hash);
        }
      }
      hash = hashContent(String(row?.tool_call_id ?? ""), hash);
      hash = hashContent(String(row?.name ?? ""), hash);
      hash = hashContent("\u0000", hash); // 每条消息的强分隔
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

  /**
   * 全局淘汰：总 JSON 超 1.2MB 时按 at 最旧先走（同刻按 fingerprint 字典序）。
   *
   * d.412.4.181 前：每淘汰一条就 `JSON.stringify` 整个（可达 1.2MB 的）对象重新量一次，
   * 再全量扫描找最旧——淘汰 k 条就是 O(k × (N + 字节量))，接近 O(n²)。
   * 现在：**字节数一次算准、增量扣减**；淘汰顺序**一次排序**、顺序取用。
   * 总量 O(N log N + k)，不再反复序列化大字符串。语义（谁先被淘汰、结果字节数）不变，
   * 由「字节公式 == JSON.stringify 实测」与「淘汰顺序」两组测试锁定。
   */
  private evictGlobal(data: SummaryCacheData): SummaryCacheData {
    let total = summaryDataByteLength(data);
    if (total <= SUMMARY_CACHE_BYTES) return data;

    // 一次收集全部条目并按淘汰顺序排好（稳定排序保留 Object.entries 的插入序，
    // 与旧实现「遇到相同 at+fp 时取遍历到的第一个」一致）。
    const victims: Array<{ convId: string; fp: string; at: number; bytes: number }> = [];
    let bucketCount = 0;
    for (const [convId, bucket] of Object.entries(data)) {
      bucketCount++;
      for (const [fp, entry] of Object.entries(bucket)) {
        victims.push({ convId, fp, at: entry.at, bytes: entryByteLength(fp, entry) });
      }
    }
    victims.sort((a, b) => olderFirst({ key: a.fp, at: a.at }, { key: b.fp, at: b.at }));

    const remaining = new Map<string, number>();
    for (const [convId, bucket] of Object.entries(data)) remaining.set(convId, Object.keys(bucket).length);

    // 惰性复制：第一条真正要删时才复制，未超限时零开销。
    let out: SummaryCacheData | null = null;
    for (const v of victims) {
      if (total <= SUMMARY_CACHE_BYTES) break;
      const left = remaining.get(v.convId) ?? 0;
      if (left <= 0) continue; // 该桶已被整体删除
      if (out === null) {
        out = Object.fromEntries(Object.entries(data).map(([c, b]) => [c, { ...b }]));
      }
      delete out[v.convId]![v.fp];
      if (left > 1) {
        // 桶内还有条目：扣掉这一条 + 一个 entry 间逗号
        total -= v.bytes + 1;
        remaining.set(v.convId, left - 1);
      } else {
        // 这是桶内最后一条，整桶消失：扣掉桶头开销 + 这一条（桶内已无逗号）；
        // 若还有其他桶，再扣一个桶间逗号。注意先扣桶再减 bucketCount。
        total -= bucketOverhead(v.convId) + v.bytes;
        if (bucketCount > 1) {
          total -= 1;
          bucketCount--;
        }
        remaining.delete(v.convId);
        delete out[v.convId];
      }
    }
    return out ?? data;
  }

  private save(): void {
    try {
      writeJson(this.storage, CONTEXT_KEYS.summaries, this.data);
    } catch {
      /* 落盘失败静默：内存态仍可用 */
    }
  }
}
