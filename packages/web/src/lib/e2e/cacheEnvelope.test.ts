/**
 * cacheEnvelope（P0-5b P1）纯函数层测试：容器三态解析 / 逐条编解码 / 迁移幂等 / 坏数据兜底。
 *
 * 这一层不含 DOM/localStorage，也不抛异常——所有失败都是返回值。
 * 加解密用可控桩（密文 = `enc:` + base64，确保真的看不出原文）。
 */
import { describe, it, expect } from "vitest";
import type { CachedMsg } from "../e2eSession.js";
import {
  MIGRATE_BATCH,
  MSG_CACHE_MARK,
  MSG_CACHE_VERSION,
  MSG_CACHE_AUX_SUFFIXES,
  isCachedMsgLike,
  isMsgCacheAuxKey,
  parseCacheRaw,
  encodeCacheContainer,
  toPlainEntries,
  needsMigration,
  encryptEntry,
  decodeEntry,
  decodeEntries,
  findEntryById,
  getMessageById,
  migratePlainEntries,
  truncateEntries,
  decodeEnvelopeItems,
  type EntryCrypto,
  type RawEntry,
} from "./cacheEnvelope.js";

const b64 = (s: string) => Buffer.from(s, "utf8").toString("base64");
const fakeEncrypt = (plain: string) => `enc:${b64(plain)}`;
const fakeDecrypt = (data: string) => (data.startsWith("enc:") ? Buffer.from(data.slice(4), "base64").toString("utf8") : null);

function cryptoOf(overrides: Partial<EntryCrypto> = {}): EntryCrypto & { calls: { encrypt: number; decrypt: number } } {
  const calls = { encrypt: 0, decrypt: 0 };
  return {
    calls,
    encrypt: (plain) => {
      calls.encrypt += 1;
      return fakeEncrypt(plain);
    },
    decrypt: (data) => {
      calls.decrypt += 1;
      return fakeDecrypt(data);
    },
    ...overrides,
  };
}

function msg(id: string, text = id): CachedMsg {
  return { id, senderId: "u1", at: 1, plain: { kind: "text", text } };
}

describe("cacheEnvelope · 容器解析（三态 + 坏数据）", () => {
  it("空值 / 空串 → empty", () => {
    expect(parseCacheRaw(null)).toEqual({ kind: "empty" });
    expect(parseCacheRaw("")).toEqual({ kind: "empty" });
    expect(parseCacheRaw("   ")).toEqual({ kind: "empty" });
  });

  it("新建容器 → 可解析回同样的条目（id 明文 + 密文 d）", () => {
    const entries: RawEntry[] = [
      { id: "m-1", d: "cipher-1" },
      { id: "m-2", d: "cipher-2" },
    ];
    const raw = encodeCacheContainer(entries);
    const parsed = parseCacheRaw(raw);
    expect(parsed.kind).toBe("container");
    if (parsed.kind !== "container") throw new Error("unreachable");
    expect(parsed.entries).toEqual(entries);
    // 外壳版本必须写进去（读侧靠它判定，而不是猜形状）
    expect((JSON.parse(raw) as Record<string, unknown>)[MSG_CACHE_MARK]).toBe(MSG_CACHE_VERSION);
  });

  it("容器可混合 {id,d} 与迁移期 {id,m}，且 {id,m} 被识别为待迁移", () => {
    const entries: RawEntry[] = [{ id: "m-1", d: "cipher-1" }, { id: "m-2", m: msg("m-2") }];
    const parsed = parseCacheRaw(encodeCacheContainer(entries));
    if (parsed.kind !== "container") throw new Error("应当解析为容器");
    expect(parsed.entries).toHaveLength(2);
    expect(needsMigration(parsed.entries[0])).toBe(false); // 已是密文：绝不二次加密
    expect(needsMigration(parsed.entries[1])).toBe(true);
  });

  it("旧明文数组 → plain（触发懒迁移）", () => {
    const parsed = parseCacheRaw(JSON.stringify([msg("m-1"), msg("m-2")]));
    expect(parsed.kind).toBe("plain");
    if (parsed.kind !== "plain") throw new Error("unreachable");
    expect(parsed.items.map((m) => m.id)).toEqual(["m-1", "m-2"]);
  });

  it("坏 JSON / 未知版本容器 / 结构不合法 → foreign，并原样保留 raw", () => {
    for (const raw of [
      "{ 这不是 json",
      JSON.stringify({ [MSG_CACHE_MARK]: "v9", items: [] }),
      JSON.stringify({ [MSG_CACHE_MARK]: MSG_CACHE_VERSION, items: "not-array" }),
      JSON.stringify({ [MSG_CACHE_MARK]: MSG_CACHE_VERSION, items: [{ id: 1 }] }),
      JSON.stringify({ 一些: "别的对象" }),
    ]) {
      const parsed = parseCacheRaw(raw);
      expect(parsed.kind).toBe("foreign");
      if (parsed.kind !== "foreign") throw new Error("unreachable");
      expect(parsed.raw).toBe(raw); // 原始数据一个字节都不丢
    }
  });

  it("整值信封（兼容壳）可识别；版本不认识按 foreign（不能当明文再包一层）", () => {
    const ok = JSON.stringify({ __hemingEnc: "v1", data: "abc" });
    expect(parseCacheRaw(ok)).toEqual({ kind: "envelope", data: "abc" });
    expect(parseCacheRaw(JSON.stringify({ __hemingEnc: "v9", data: "abc" }))).toMatchObject({ kind: "foreign" });
  });

  it("重复 id 不抛：原样保留条目（由上层按 id 取第一条）", () => {
    const entries: RawEntry[] = [
      { id: "dup", d: "c1" },
      { id: "dup", d: "c2" },
    ];
    const parsed = parseCacheRaw(encodeCacheContainer(entries));
    if (parsed.kind !== "container") throw new Error("应当解析为容器");
    expect(parsed.entries).toHaveLength(2);
    expect(findEntryById(parsed.entries, "dup")).toEqual({ id: "dup", d: "c1" });
  });
});

describe("cacheEnvelope · 逐条编解码", () => {
  it("加密一条：密文看不出原文；解回来与原文一致", () => {
    const crypto = cryptoOf();
    const { entry, ok } = encryptEntry(msg("m-1", "机密正文"), crypto);
    expect(ok).toBe(true);
    if (!("d" in entry)) throw new Error("应当是密文条目");
    expect(entry.d).not.toContain("机密正文");
    expect(decodeEntry(entry, crypto)).toEqual({ ok: true, msg: msg("m-1", "机密正文") });
  });

  it("加密失败：不抛、退回 {id,m} 明文条目（由上层标记未加密）", () => {
    const crypto = cryptoOf({ encrypt: () => null });
    const result = encryptEntry(msg("m-1"), crypto);
    expect(result.ok).toBe(false);
    expect(result.reason).toBe("encrypt-failed");
    expect(result.entry).toEqual({ id: "m-1", m: msg("m-1") });
  });

  it("单条解密失败：只跳过该条，其余照常；两条都报 unreadable 时 id 仍在", () => {
    const crypto = cryptoOf();
    const good = encryptEntry(msg("good"), crypto).entry;
    const entries: RawEntry[] = [good, { id: "broken", d: "garbage" }, { id: "moved", m: msg("moved") }];
    const decoded = decodeEntries(entries, crypto);
    expect(decoded.messages.map((m) => m.id)).toEqual(["good", "moved"]);
    expect(decoded.unreadableIds).toEqual(["broken"]);
    // 重写时密文条目原样保留（绝不因解不开就把数据删掉）
    expect(encodeCacheContainer(entries)).toContain("garbage");
  });

  it("按 id 定点取：只解密命中的那一条（冷读不解全量）", () => {
    const crypto = cryptoOf();
    const entries: RawEntry[] = ["a", "b", "c"].map((id) => encryptEntry(msg(id), crypto).entry);
    const before = crypto.calls.decrypt;
    expect(getMessageById(entries, "b", crypto)).toEqual(msg("b"));
    expect(crypto.calls.decrypt - before).toBe(1);
    expect(getMessageById(entries, "missing", crypto)).toBeNull();
    expect(crypto.calls.decrypt - before).toBe(1); // 不存在时零解密
  });

  it("明文条目解码不需要密钥（无桥降级时仍可读迁移期条目）", () => {
    const crypto = cryptoOf({ decrypt: () => null });
    expect(decodeEntry({ id: "m", m: msg("m") }, crypto)).toEqual({ ok: true, msg: msg("m") });
  });
});

describe("cacheEnvelope · 迁移（幂等 / 批大小 / 失败保留明文）", () => {
  it("迁移幂等：第二次迁移零加密、零改动", () => {
    const crypto = cryptoOf();
    const plain = toPlainEntries([msg("m-1"), msg("m-2")]);
    const first = migratePlainEntries(plain, crypto);
    expect(first.migrated).toBe(2);
    const encryptsAfterFirst = crypto.calls.encrypt;

    const second = migratePlainEntries(first.entries, crypto);
    expect(second.migrated).toBe(0);
    expect(crypto.calls.encrypt).toBe(encryptsAfterFirst); // 绝不二次加密（会把密文当明文）
    expect(second.entries).toEqual(first.entries);
  });

  it("单批上限 MIGRATE_BATCH：超出部分保持明文，下一批再迁", () => {
    const crypto = cryptoOf();
    const plain = toPlainEntries(Array.from({ length: MIGRATE_BATCH + 7 }, (_, i) => msg(`m-${i}`)));
    const first = migratePlainEntries(plain, crypto);
    expect(first.migrated).toBe(MIGRATE_BATCH);
    expect(first.entries.filter(needsMigration)).toHaveLength(7);
    const second = migratePlainEntries(first.entries, crypto);
    expect(second.migrated).toBe(7);
    expect(second.entries.some(needsMigration)).toBe(false);
  });

  it("迁移中加密失败：该条保留明文，可下一轮重试", () => {
    let fail = true;
    const crypto: EntryCrypto = {
      encrypt: (plain) => (fail ? null : fakeEncrypt(plain)),
      decrypt: fakeDecrypt,
    };
    const plain = toPlainEntries([msg("m-1"), msg("m-2")]);
    const failed = migratePlainEntries(plain, crypto);
    expect(failed.migrated).toBe(0);
    expect(failed.failed).toBe(2);
    expect(failed.entries.every(needsMigration)).toBe(true);

    fail = false;
    const retried = migratePlainEntries(failed.entries, crypto);
    expect(retried.migrated).toBe(2);
    expect(retried.entries.some(needsMigration)).toBe(false);
  });

  it("淘汰从最旧开始：truncate 只留最近 cap 条", () => {
    const entries: RawEntry[] = ["1", "2", "3"].map((id) => ({ id, d: `c-${id}` }));
    expect(truncateEntries(entries, 2).map((e) => e.id)).toEqual(["2", "3"]);
    expect(truncateEntries(entries, 0)).toEqual([]);
    expect(truncateEntries(entries, 10)).toBe(entries); // 未超上限不复制
  });

  it("整值信封解不开 / 非数组 → null（上层按 unreadable 处理），不抛", () => {
    const crypto = cryptoOf();
    expect(decodeEnvelopeItems("garbage", crypto)).toBeNull();
    const okData = fakeEncrypt(JSON.stringify([msg("m-1")]));
    expect(decodeEnvelopeItems(okData, crypto)).toEqual([msg("m-1")]);
    const notArray = fakeEncrypt(JSON.stringify({ a: 1 }));
    expect(decodeEnvelopeItems(notArray, crypto)).toBeNull();
  });
});

describe("cacheEnvelope · 辅助判定", () => {
  it("辅助键后缀（备份/临时）不被当成会话", () => {
    for (const suffix of MSG_CACHE_AUX_SUFFIXES) {
      expect(isMsgCacheAuxKey(`heming.msgCache.c1${suffix}`)).toBe(true);
    }
    expect(isMsgCacheAuxKey("heming.msgCache.c1")).toBe(false);
    expect(isMsgCacheAuxKey("heming.msgCache.lru.v1")).toBe(false);
  });

  it("CachedMsg 形状校验：缺字段/坏字段都判 false", () => {
    expect(isCachedMsgLike(msg("m"))).toBe(true);
    expect(isCachedMsgLike(null)).toBe(false);
    expect(isCachedMsgLike([])).toBe(false);
    expect(isCachedMsgLike({ ...msg("m"), id: "" })).toBe(false);
    expect(isCachedMsgLike({ ...msg("m"), at: Number.NaN })).toBe(false);
    expect(isCachedMsgLike({ ...msg("m"), plain: {} })).toBe(false);
  });
});
