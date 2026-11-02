/**
 * 消息缓存容器编解码（P0-5b · P1 · 方案 A'）。
 *
 * `heming.msgCache.<convId>` 在**有桌面桥**时的磁盘形态：
 *
 *   {"__hemingMsgCache":"v2","items":[
 *     {"id":"m-1","d":"<base64(safeStorage.encryptString(JSON(CachedMsg)))>"},
 *     {"id":"m-2","m":{...迁移期明文条目...}}
 *   ]}
 *
 * 为什么是「容器 + 逐条密文」而不是整数组一封：`append` 每条消息都会整数组重写
 * （见 e2eSession.appendCache）。整数组一封会把每次 append 变成「重加密全量 200–600KB」；
 * 逐条只加密新增那一条，O(1)。`id` 刻意留明文，让读侧能按 id 定点解密（`msgCache.get`）。
 *
 * 本文件只做**纯函数**：不碰 localStorage、不碰 window、不抛异常。
 * 加解密通过入参 `EntryCrypto`（生产环境 = `window.__heming_secrets` 的包装）。
 *
 * 失败口径（见设计稿 §4.4 / 需求 4）：
 * - 容器 JSON 坏 / 版本不认识 / 条目结构不合法 → `foreign`，由调用方返回空并保留原始数据；
 * - 单条密文解不开 → 只跳过该条（返回的 rawEntries 里原样保留），其余照常；
 * - 所有函数**绝不 throw**——解析失败是返回值，不是异常，不能打断发消息路径。
 */
import {
  ENVELOPE_MARK,
  ENVELOPE_VERSION,
  PLAINTEXT_BACKUP_SUFFIX,
  UNDECRYPTABLE_BACKUP_SUFFIX,
} from "../secureStorage.js";
import type { CachedMsg } from "../e2eSession.js";

/** 容器外壳标记（与 d.36 的整值信封 `__hemingEnc` 平行，互不嵌套）。 */
export const MSG_CACHE_MARK = "__hemingMsgCache";
/** 容器版本。换版本必须保留旧版本可读（或走迁移），不要就地改数字。 */
export const MSG_CACHE_VERSION = "v2";
/** 单批迁移条数上限（设计稿 §4.2：50 条约 10–25KB，一次 setItem）。 */
export const MIGRATE_BATCH = 50;

/** 消息缓存键的辅助后缀：LRU/统计遍历时必须排除，否则会被当成一个「会话」。 */
export const MSG_CACHE_AUX_SUFFIXES = [PLAINTEXT_BACKUP_SUFFIX, UNDECRYPTABLE_BACKUP_SUFFIX] as const;

/** 是否某缓存主键的辅助键（备份/临时），不是会话本身。 */
export function isMsgCacheAuxKey(key: string): boolean {
  return MSG_CACHE_AUX_SUFFIXES.some((suffix) => key.endsWith(suffix));
}

/** 编解码需要的加解密能力（生产 = 桌面桥；测试 = 桩）。 */
export interface EntryCrypto {
  encrypt(plain: string): string | null;
  decrypt(cipherB64: string): string | null;
}

/** 磁盘条目：密文条目 `{id,d}` 或迁移期明文条目 `{id,m}`。 */
export interface RawCipherEntry {
  id: string;
  d: string;
}
export interface RawPlainEntry {
  id: string;
  m: CachedMsg;
}
export type RawEntry = RawCipherEntry | RawPlainEntry;

/** `parseCacheRaw` 的四种结果：三态 + 不认识的原始数据。 */
export type CacheRawShape =
  | { kind: "empty" }
  | { kind: "container"; entries: RawEntry[] }
  /** 整值信封（`{__hemingEnc:"v1",data}`）：兼容壳，解密后应为 CachedMsg 数组。 */
  | { kind: "envelope"; data: string }
  /** 旧明文数组（触发懒迁移）。 */
  | { kind: "plain"; items: CachedMsg[] }
  /** 未知版本容器 / 坏 JSON / 结构不合法：**保留 raw**，由调用方备份后再决定是否重写。 */
  | { kind: "foreign"; raw: string };

function isRecord(value: unknown): value is Record<string, unknown> {
  return !!value && typeof value === "object" && !Array.isArray(value);
}

/** 条目形状校验：宁可把不认识的当坏数据，也不把密文/垃圾当明文渲染。 */
export function isCachedMsgLike(value: unknown): value is CachedMsg {
  if (!isRecord(value)) return false;
  if (typeof value.id !== "string" || !value.id) return false;
  if (typeof value.senderId !== "string") return false;
  if (typeof value.at !== "number" || !Number.isFinite(value.at)) return false;
  if (!isRecord(value.plain) || typeof value.plain.kind !== "string") return false;
  return true;
}

function parseRawEntry(value: unknown): RawEntry | null {
  if (!isRecord(value)) return null;
  const id = value.id;
  if (typeof id !== "string" || !id) return null;
  if (typeof value.d === "string" && value.d) return { id, d: value.d };
  if (isCachedMsgLike(value.m)) return { id, m: value.m };
  return null;
}

/**
 * 解析一个缓存键的原始值（**不写盘、不解密、不抛**）。
 *
 * 判定顺序照设计稿 §4.4：容器 → 整值信封 → 旧明文数组 → 无法识别。
 * 注意：单条密文解不开不在这里判（那需要密钥），交给 `decodeEntries`。
 */
export function parseCacheRaw(raw: string | null): CacheRawShape {
  if (raw === null) return { kind: "empty" };
  const trimmed = raw.trim();
  if (!trimmed) return { kind: "empty" };

  let parsed: unknown;
  try {
    parsed = JSON.parse(trimmed);
  } catch {
    return { kind: "foreign", raw };
  }

  if (Array.isArray(parsed)) {
    // 旧明文（迁移动力）。任一条不是 CachedMsg 形状 → 不猜、按坏数据处理（保留 raw）。
    if (!parsed.every(isCachedMsgLike)) return { kind: "foreign", raw };
    return { kind: "plain", items: parsed as CachedMsg[] };
  }

  if (isRecord(parsed)) {
    if (MSG_CACHE_MARK in parsed) {
      if (parsed[MSG_CACHE_MARK] !== MSG_CACHE_VERSION) return { kind: "foreign", raw };
      const items = parsed.items;
      if (!Array.isArray(items)) return { kind: "foreign", raw };
      const entries: RawEntry[] = [];
      for (const item of items) {
        const entry = parseRawEntry(item);
        if (!entry) return { kind: "foreign", raw }; // 结构不合法：整键按坏数据兜底
        entries.push(entry);
      }
      return { kind: "container", entries };
    }
    if (ENVELOPE_MARK in parsed) {
      // 整值信封兼容：不认识的版本同样按坏数据处理（不能当明文再包一层）。
      if (parsed[ENVELOPE_MARK] !== ENVELOPE_VERSION) return { kind: "foreign", raw };
      const data = parsed.data;
      if (typeof data !== "string" || !data) return { kind: "foreign", raw };
      return { kind: "envelope", data };
    }
  }

  return { kind: "foreign", raw };
}

/** 序列化容器（`{id,d}` 条目保持原密文，不重加密）。 */
export function encodeCacheContainer(entries: RawEntry[]): string {
  const items = entries.map((entry) =>
    "d" in entry ? { id: entry.id, d: entry.d } : { id: entry.id, m: entry.m },
  );
  return JSON.stringify({ [MSG_CACHE_MARK]: MSG_CACHE_VERSION, items });
}

/** 旧明文条目 → 待迁移的 `{id,m}` 条目（迁移前的中性表示）。 */
export function toPlainEntries(items: CachedMsg[]): RawPlainEntry[] {
  return items.map((m) => ({ id: m.id, m }));
}

/** 该条目是否还需要迁移（`{id,m}` 要迁；`{id,d}` 幂等跳过——重复迁移绝不二次加密）。 */
export function needsMigration(entry: RawEntry): entry is RawPlainEntry {
  return "m" in entry;
}

/** 单条加密：失败**不抛**，退回明文条目并由调用方标记「未加密」。 */
export function encryptEntry(
  m: CachedMsg,
  crypto: EntryCrypto,
): { entry: RawEntry; ok: boolean; reason?: "encrypt-failed" } {
  let cipher: string | null = null;
  try {
    cipher = crypto.encrypt(JSON.stringify(m));
  } catch {
    cipher = null;
  }
  if (cipher) return { entry: { id: m.id, d: cipher }, ok: true };
  return { entry: { id: m.id, m }, ok: false, reason: "encrypt-failed" };
}

/** 单条解密结果：解不开只影响这一条（id 保留，便于诊断与「未落盘」对齐）。 */
export type DecodedEntry = { ok: true; msg: CachedMsg } | { ok: false; id: string };

/** 解一条：密文解不开 / 明文 JSON 坏 / 形状不合法 → `{ok:false,id}`，**不抛**。 */
export function decodeEntry(entry: RawEntry, crypto: EntryCrypto): DecodedEntry {
  if ("m" in entry) {
    return isCachedMsgLike(entry.m) ? { ok: true, msg: entry.m } : { ok: false, id: entry.id };
  }
  let plain: string | null = null;
  try {
    plain = crypto.decrypt(entry.d);
  } catch {
    plain = null;
  }
  if (plain === null) return { ok: false, id: entry.id };
  let parsed: unknown;
  try {
    parsed = JSON.parse(plain);
  } catch {
    return { ok: false, id: entry.id };
  }
  return isCachedMsgLike(parsed) ? { ok: true, msg: parsed } : { ok: false, id: entry.id };
}

/**
 * 解全部条目（list/peek 用）。返回**可渲染的明文**，解不开的跳过；
 * `unreadableIds` 供状态卡与诊断使用（原始密文仍由调用方保留在 rawEntries 里）。
 */
export function decodeEntries(
  entries: RawEntry[],
  crypto: EntryCrypto,
): { messages: CachedMsg[]; unreadableIds: string[] } {
  const messages: CachedMsg[] = [];
  const unreadableIds: string[] = [];
  for (const entry of entries) {
    const decoded = decodeEntry(entry, crypto);
    if (decoded.ok) messages.push(decoded.msg);
    else unreadableIds.push(decoded.id);
  }
  return { messages, unreadableIds };
}

/** 按消息 id 查条目（id 明文，O(n) 只比字符串；不解密）。 */
export function findEntryById(entries: RawEntry[], msgId: string): RawEntry | undefined {
  return entries.find((entry) => entry.id === msgId);
}

/**
 * 按 id 定点取一条明文：命中密文条目时**只解密这一条**（M2：冷读不解全量）。
 * 同 id 重复时取第一条（与 Array.find 语义一致）。
 */
export function getMessageById(entries: RawEntry[], msgId: string, crypto: EntryCrypto): CachedMsg | null {
  const entry = findEntryById(entries, msgId);
  if (!entry) return null;
  const decoded = decodeEntry(entry, crypto);
  return decoded.ok ? decoded.msg : null;
}

/**
 * 迁移一批明文条目（≤`limit` 条）：已是 `{id,d}` 的条目原样返回（幂等，绝不二次加密）。
 * 返回新的 entries 数组，只有 `migrated > 0` 时才需要写盘。
 */
export function migratePlainEntries(
  entries: RawEntry[],
  crypto: EntryCrypto,
  limit = MIGRATE_BATCH,
): { entries: RawEntry[]; migrated: number; failed: number } {
  let migrated = 0;
  let failed = 0;
  const next = entries.map((entry) => {
    if (!needsMigration(entry)) return entry;
    if (migrated >= limit) return entry; // 本批上限：剩下的下次再迁
    const result = encryptEntry(entry.m, crypto);
    if (!result.ok) {
      failed += 1;
      return entry; // 加密失败保留明文（Q1 fail-open），下轮可重试
    }
    migrated += 1;
    return result.entry;
  });
  return { entries: next, migrated, failed };
}

/** 截尾到最近 `cap` 条（淘汰从最旧开始；条目级，不解密）。 */
export function truncateEntries(entries: RawEntry[], cap: number): RawEntry[] {
  if (cap <= 0) return [];
  return entries.length > cap ? entries.slice(-cap) : entries;
}

/**
 * 整值信封解密（兼容壳）：解不开 / 非数组 / 形状不对 → null（调用方按 unreadable 处理）。
 * 不抛。
 */
export function decodeEnvelopeItems(data: string, crypto: EntryCrypto): CachedMsg[] | null {
  let plain: string | null = null;
  try {
    plain = crypto.decrypt(data);
  } catch {
    plain = null;
  }
  if (plain === null) return null;
  let parsed: unknown;
  try {
    parsed = JSON.parse(plain);
  } catch {
    return null;
  }
  if (!Array.isArray(parsed) || !parsed.every(isCachedMsgLike)) return null;
  return parsed as CachedMsg[];
}
