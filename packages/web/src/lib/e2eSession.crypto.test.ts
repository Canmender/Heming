/**
 * P0-5b · P1 热路径加密的集成测试（有桥 / 无桥两条路径）。
 *
 * 与 `e2eSession.test.ts` 的分工：那个文件保持「无桥 = 浏览器」的既有回归面；
 * 这里专门覆盖**桌面桥可用**时的落盘形态、迁移、自校验与失败降级，
 * 外加一条「无桥时存储形态与今天逐字等价」的反向断言。
 *
 * 桥是可控桩：密文 = `enc:` + base64（真的看不出原文，`not.toContain` 断言才有意义）。
 */
import { describe, it, expect, beforeEach, afterEach, vi } from "vitest";
import type { WsClientEvent } from "@heming/shared";
import {
  IDENTITY_KEY,
  initSession,
  sealMessage,
  openMessage,
  handleChainDist,
  recvChainOwners,
  resetChainsView,
  resetMsgCacheState,
  msgCache,
  msgCacheEncryptionState,
  migrateMsgCache,
  resetMsgCacheLru,
  exportOwnDeviceKeys,
  type E2eDeps,
  type PeerKeys,
  type SealedEnvelope,
} from "./e2eSession.js";
import {
  PLAINTEXT_BACKUP_SUFFIX,
  UNDECRYPTABLE_BACKUP_SUFFIX,
  resetSecureStorageState,
  secureStorageStatus,
} from "./secureStorage.js";

type SendEvent = Extract<WsClientEvent, { type: "send_message" }>;

const CACHE_KEY = (convId: string) => `heming.msgCache.${convId}`;
const CHAINS_KEY = (convId: string) => `heming.e2e.chains.${convId}`;

const b64 = (s: string) => Buffer.from(s, "utf8").toString("base64");
const fakeEncrypt = (plain: string) => `enc:${b64(plain)}`;
const fakeDecrypt = (data: string) => (data.startsWith("enc:") ? Buffer.from(data.slice(4), "base64").toString("utf8") : null);

interface BridgeCalls {
  encrypt: number;
  decrypt: number;
}

/** 装一个可控桥；返回调用计数（本轮的「纯函数层基准」断言就靠它）。 */
function installBridge(
  opts: {
    available?: boolean;
    encrypt?: (plain: string) => string | null;
    decrypt?: (data: string) => string | null;
  } = {},
): BridgeCalls {
  const calls: BridgeCalls = { encrypt: 0, decrypt: 0 };
  (window as unknown as { __heming_secrets?: unknown }).__heming_secrets = {
    available: opts.available !== false,
    encrypt: (plain: string) => {
      calls.encrypt += 1;
      return opts.encrypt ? opts.encrypt(plain) : fakeEncrypt(plain);
    },
    decrypt: (data: string) => {
      calls.decrypt += 1;
      return opts.decrypt ? opts.decrypt(data) : fakeDecrypt(data);
    },
  };
  return calls;
}

function uninstallBridge(): void {
  delete (window as unknown as { __heming_secrets?: unknown }).__heming_secrets;
}

function cachedMsg(id: string, text = id) {
  return { id, senderId: "alice", at: 1, plain: { kind: "text" as const, text } };
}

beforeEach(() => {
  localStorage.clear();
  uninstallBridge();
  resetSecureStorageState();
  resetMsgCacheState();
  resetChainsView();
  resetMsgCacheLru();
});

afterEach(() => {
  uninstallBridge();
  resetSecureStorageState();
  resetMsgCacheState();
  resetChainsView();
});

// —— 有桥 · 消息缓存容器 ——

describe("msgCache · 有桥容器（逐条密文 / 明文 id 索引）", () => {
  it("新建 → 追加 → 按 id 查：磁盘是 v2 容器，API 仍返回明文", () => {
    const calls = installBridge();
    const m1 = cachedMsg("m-1", "第一条正文");
    msgCache.append("conv-cache", m1);

    const raw1 = localStorage.getItem(CACHE_KEY("conv-cache"))!;
    const parsed1 = JSON.parse(raw1) as { __hemingMsgCache: string; items: { id: string; d: string }[] };
    expect(parsed1.__hemingMsgCache).toBe("v2");
    expect(parsed1.items).toHaveLength(1);
    expect(parsed1.items[0].id).toBe("m-1"); // id 明文是刻意设计：定点解密用
    expect(typeof parsed1.items[0].d).toBe("string");
    expect(raw1).not.toContain("第一条正文");
    expect(calls.encrypt).toBe(1); // 新建一条只 1 次加密
    expect(calls.decrypt).toBe(0); // 写缓存不做自校验解密（预算 M8 = 2 次 IPC/消息）

    msgCache.append("conv-cache", cachedMsg("m-2", "第二条正文"));
    const parsed2 = JSON.parse(localStorage.getItem(CACHE_KEY("conv-cache"))!) as {
      items: { id: string; d: string }[];
    };
    expect(calls.encrypt).toBe(2); // 追加一条只多 1 次：**不重加密整个数组**
    expect(parsed2.items[0].d).toBe(parsed1.items[0].d); // 已有条目密文原样保留

    expect(msgCache.list("conv-cache")).toEqual([m1, cachedMsg("m-2", "第二条正文")]);
    expect(msgCache.peek("conv-cache")).toEqual(msgCache.list("conv-cache"));
    expect(msgCache.get("conv-cache", "m-2")).toEqual(cachedMsg("m-2", "第二条正文"));
  });

  it("冷启动按 id 定点解密：get 只解命中的 1 条（M2 不解全量）", () => {
    installBridge();
    msgCache.append("conv-cold", cachedMsg("m-1", "一"));
    msgCache.append("conv-cold", cachedMsg("m-2", "二"));
    msgCache.append("conv-cold", cachedMsg("m-3", "三"));
    resetMsgCacheState(); // 模拟重载：内存视图清空，只剩磁盘
    installBridge(); // 计数清零

    const calls = { decrypt: 0 };
    const bridge = (window as unknown as { __heming_secrets: { decrypt(d: string): string | null } }).__heming_secrets;
    const original = bridge.decrypt;
    (window as unknown as { __heming_secrets: { decrypt(d: string): string | null } }).__heming_secrets.decrypt = (
      d: string,
    ) => {
      calls.decrypt += 1;
      return original(d);
    };
    try {
      expect(msgCache.get("conv-cold", "m-2")).toEqual(cachedMsg("m-2", "二"));
      expect(calls.decrypt).toBe(1); // 只解这一条
    } finally {
      (window as unknown as { __heming_secrets: { decrypt(d: string): string | null } }).__heming_secrets.decrypt =
        original;
    }
  });

  it("每会话 500 条截尾：容器条目按最旧淘汰", () => {
    installBridge();
    for (let i = 0; i <= 500; i += 1) msgCache.append("conv-cap", cachedMsg(`m-${i}`));
    const list = msgCache.list("conv-cap");
    expect(list).toHaveLength(500);
    expect(list[0].id).toBe("m-1"); // m-0 被淘汰（今天的行为保持）
  });

  it("坏 JSON 容器：不抛、返回空、原始数据原样备份；之后的 append 正常", () => {
    installBridge();
    const key = CACHE_KEY("conv-bad");
    localStorage.setItem(key, "{ 这不是 json");

    expect(() => msgCache.list("conv-bad")).not.toThrow();
    expect(msgCache.list("conv-bad")).toEqual([]);
    expect(localStorage.getItem(key + UNDECRYPTABLE_BACKUP_SUFFIX)).toBe("{ 这不是 json");

    msgCache.append("conv-bad", cachedMsg("m-1"));
    expect((JSON.parse(localStorage.getItem(key)!) as { __hemingMsgCache: string }).__hemingMsgCache).toBe("v2");
  });

  it("未知版本容器：按空缓存处理、**不改写**原始数据", () => {
    installBridge();
    const key = CACHE_KEY("conv-future");
    const future = JSON.stringify({ __hemingMsgCache: "v9", items: [{ id: "m-1", d: "x" }] });
    localStorage.setItem(key, future);

    expect(msgCache.list("conv-future")).toEqual([]);
    expect(localStorage.getItem(key)).toBe(future); // 读侧绝不因为不认识就写回去

    msgCache.append("conv-future", cachedMsg("m-2"));
    expect(localStorage.getItem(key + UNDECRYPTABLE_BACKUP_SUFFIX)).toBe(future);
    expect(msgCache.list("conv-future").map((m) => m.id)).toEqual(["m-2"]);
  });

  it("单条密文解不开：跳过该条、其余可见；重写时密文原样保留（不丢数据）", () => {
    installBridge();
    const key = CACHE_KEY("conv-broken");
    localStorage.setItem(
      key,
      JSON.stringify({
        __hemingMsgCache: "v2",
        items: [
          { id: "m-1", d: fakeEncrypt(JSON.stringify(cachedMsg("m-1", "好的一条"))) },
          { id: "m-2", d: "broken-cipher" },
        ],
      }),
    );

    expect(msgCache.list("conv-broken")).toEqual([cachedMsg("m-1", "好的一条")]);
    expect(msgCache.get("conv-broken", "m-2")).toBeNull(); // 解不开 → null，不抛
    msgCache.append("conv-broken", cachedMsg("m-3"));
    const items = (JSON.parse(localStorage.getItem(key)!) as { items: { id: string; d?: string }[] }).items;
    expect(items.find((i) => i.id === "m-2")?.d).toBe("broken-cipher"); // 原始密文仍在
    expect(msgCache.list("conv-broken").map((m) => m.id)).toEqual(["m-1", "m-3"]);
  });
});

// —— 有桥 · 明文迁移 ——

describe("msgCache · 明文 → 密文迁移（非破坏性 / 幂等）", () => {
  it("迁移幂等：备份键只写一次、重复读不重复加密、字节不变", () => {
    const calls = installBridge();
    const key = CACHE_KEY("conv-migrate");
    const seeded = [cachedMsg("m-1", "一"), cachedMsg("m-2", "二")];
    const plainRaw = JSON.stringify(seeded);
    localStorage.setItem(key, plainRaw);

    expect(msgCache.list("conv-migrate")).toEqual(seeded); // 本次读仍按明文返回
    const migratedRaw = localStorage.getItem(key)!;
    expect((JSON.parse(migratedRaw) as { __hemingMsgCache: string }).__hemingMsgCache).toBe("v2");
    expect(calls.encrypt).toBe(2); // 两条各加密一次
    expect(localStorage.getItem(key + PLAINTEXT_BACKUP_SUFFIX)).toBe(plainRaw); // Q3 原样备份

    const encryptsAfter = calls.encrypt;
    expect(msgCache.list("conv-migrate")).toEqual(seeded);
    expect(msgCache.list("conv-migrate")).toEqual(seeded);
    expect(calls.encrypt).toBe(encryptsAfter); // 重复迁移不重复加密
    expect(localStorage.getItem(key)).toBe(migratedRaw); // 幂等：字节完全不变

    msgCache.append("conv-migrate", cachedMsg("m-3"));
    expect(localStorage.getItem(key + PLAINTEXT_BACKUP_SUFFIX)).toBe(plainRaw); // 备份只保留第一份
  });

  it("迁移批大小 ≤50：60 条分两批迁完（显式入口与 list 各触发一批）", () => {
    const calls = installBridge();
    const key = CACHE_KEY("conv-batch");
    const seeded = Array.from({ length: 60 }, (_, i) => cachedMsg(`m-${i}`));
    localStorage.setItem(key, JSON.stringify(seeded));

    expect(migrateMsgCache("conv-batch")).toBe(50); // 显式入口：一批 ≤50
    expect(calls.encrypt).toBe(50);
    expect(localStorage.getItem(key + PLAINTEXT_BACKUP_SUFFIX)).not.toBeNull();
    expect(msgCache.list("conv-batch")).toHaveLength(60); // list 触发剩余 10 条
    expect(calls.encrypt).toBe(60);
    const items = (JSON.parse(localStorage.getItem(key)!) as { items: { d?: string; m?: unknown }[] }).items;
    expect(items.every((i) => typeof i.d === "string" && i.m === undefined)).toBe(true);
  });

  it("迁移中途加密失败：旧明文一个字节不变、消息照常可读；恢复后可重试", () => {
    installBridge({ encrypt: () => null }); // DPAPI 抖动
    const key = CACHE_KEY("conv-fail");
    const plainRaw = JSON.stringify([cachedMsg("m-1", "一"), cachedMsg("m-2", "二")]);
    localStorage.setItem(key, plainRaw);

    expect(msgCache.list("conv-fail")).toEqual([cachedMsg("m-1", "一"), cachedMsg("m-2", "二")]);
    expect(localStorage.getItem(key)).toBe(plainRaw); // 任一步失败保留旧明文
    expect(msgCacheEncryptionState("conv-fail").reason).toBe("encrypt-failed");

    installBridge(); // 恢复
    resetMsgCacheState();
    expect(msgCache.list("conv-fail")).toHaveLength(2);
    expect((JSON.parse(localStorage.getItem(key)!) as { __hemingMsgCache: string }).__hemingMsgCache).toBe("v2");
    expect(localStorage.getItem(key + PLAINTEXT_BACKUP_SUFFIX)).toBe(plainRaw);
  });

  it("备份键写失败：不覆盖旧明文（迁移非破坏性）", () => {
    installBridge();
    const key = CACHE_KEY("conv-backup-fail");
    const plainRaw = JSON.stringify([cachedMsg("m-1")]);
    localStorage.setItem(key, plainRaw);

    const realSetItem = Storage.prototype.setItem;
    const spy = vi.spyOn(Storage.prototype, "setItem").mockImplementation(function (this: Storage, k: string, v: string) {
      if (k.endsWith(PLAINTEXT_BACKUP_SUFFIX)) throw new DOMException("QuotaExceededError", "QuotaExceededError");
      realSetItem.call(this, k, v);
    });
    try {
      expect(msgCache.list("conv-backup-fail")).toEqual([cachedMsg("m-1")]);
      expect(localStorage.getItem(key)).toBe(plainRaw); // 没备份就不迁
      expect(msgCacheEncryptionState("conv-backup-fail").reason).toBe("backup-failed");
    } finally {
      spy.mockRestore();
    }
  });

  it("配额不足（Q2）：保持明文、不截短缓存、只标记未加密", () => {
    installBridge();
    const key = CACHE_KEY("conv-quota");
    const seeded = [cachedMsg("m-1", "一"), cachedMsg("m-2", "二")];
    const plainRaw = JSON.stringify(seeded);
    localStorage.setItem(key, plainRaw);

    const realSetItem = Storage.prototype.setItem;
    const spy = vi.spyOn(Storage.prototype, "setItem").mockImplementation(function (this: Storage, k: string, v: string) {
      // 只让加密容器写失败（配额语义）：明文兜底照常写入
      if (v.startsWith('{"__hemingMsgCache')) throw new DOMException("QuotaExceededError", "QuotaExceededError");
      realSetItem.call(this, k, v);
    });
    try {
      expect(msgCache.list("conv-quota")).toEqual(seeded); // 迁移失败但消息一条不少
      const fallbackRaw = localStorage.getItem(key)!;
      expect(fallbackRaw.startsWith("[")).toBe(true); // Q2：保持明文
      expect(JSON.parse(fallbackRaw)).toEqual(seeded); // 不截短

      msgCache.append("conv-quota", cachedMsg("m-3", "三"));
      expect(msgCache.list("conv-quota")).toHaveLength(3);
      expect((JSON.parse(localStorage.getItem(key)!) as unknown[]).length).toBe(3); // 新消息照样落盘
      expect(msgCacheEncryptionState("conv-quota")).toMatchObject({ encrypted: false, reason: "quota" });
    } finally {
      spy.mockRestore();
    }
  });
});

// —— 有桥 · chains（整值信封 + 自校验）——

describe("chains · 有桥整值信封与写入自校验", () => {
  it("首读懒迁移：明文 → 信封 + 明文备份键（可解析回原链结构），重复读不重复加密", () => {
    const calls = installBridge();
    const key = CHAINS_KEY("conv-chain-migrate");
    const plaintext = JSON.stringify({
      send: { kid: "legacy-kid", ck: "AAAA", n: 5, createdAt: 1, distFor: [] },
      recv: { r1: { kid: "r1", ck: "BBBB", n: 2, createdAt: 2, from: "peer", msgKeys: {} } },
    });
    localStorage.setItem(key, plaintext);

    expect(recvChainOwners("conv-chain-migrate")).toEqual({ r1: "peer" }); // 本次读仍是明文内容
    const raw = localStorage.getItem(key)!;
    expect((JSON.parse(raw) as { __hemingEnc?: string }).__hemingEnc).toBe("v1"); // 反向断言：不再是明文
    expect(raw).not.toContain("legacy-kid");
    expect(calls.encrypt).toBe(1); // 只迁移一次
    expect(calls.decrypt).toBe(1); // 自校验解密一次（设计 M3）

    const backup = localStorage.getItem(key + PLAINTEXT_BACKUP_SUFFIX)!;
    expect(backup).toBe(plaintext); // 原样备份（Q3）
    const backupChains = JSON.parse(backup) as { send: { n: number }; recv: Record<string, { kid: string }> };
    expect(backupChains.send.n).toBe(5); // 备份内容能解析回原链结构
    expect(backupChains.recv.r1.kid).toBe("r1");

    const encryptsAfter = calls.encrypt;
    expect(recvChainOwners("conv-chain-migrate")).toEqual({ r1: "peer" });
    expect(calls.encrypt).toBe(encryptsAfter); // 内存视图命中：不重新迁移/不重复加密
  });

  it("写入自校验失败：fail-open 保留新明文值、点名声纹、下次读拿到新值且不抛", () => {
    const warn = vi.spyOn(console, "warn").mockImplementation(() => {});
    try {
      const key = CHAINS_KEY("conv-selfcheck");
      const original = JSON.stringify({ send: { kid: "old", ck: "AAAA", n: 5, createdAt: 1, distFor: [] }, recv: {} });
      localStorage.setItem(key, original);
      // 链值里带 "recv" ⇒ encrypt 返回「解不回来的密文」，模拟 DPAPI 抖动/自校验失败
      installBridge({
        encrypt: (plain) => (plain.includes('"recv"') ? `bad:${b64(plain)}` : fakeEncrypt(plain)),
        decrypt: (data) => (data.startsWith("bad:") ? "corrupted" : fakeDecrypt(data)),
      });

      expect(() =>
        handleChainDist("conv-selfcheck", "dev1", { kid: "new-kid", ck: "BBBB", n: 0, createdAt: 100 }),
      ).not.toThrow();

      const raw = localStorage.getItem(key)!;
      expect(raw).not.toContain("__hemingEnc"); // 不写坏密文
      const file = JSON.parse(raw) as { send: { n: number }; recv: Record<string, { from?: string }> };
      expect(file.recv["new-kid"].from).toBe("dev1"); // 新值（不是回退旧盘值）
      // Q1：设置区可见（点名该键）+ 一条可诊断日志
      expect(secureStorageStatus().plaintextKeys).toContain(key);
      expect(warn.mock.calls.some((c) => String(c[0]).includes("自校验失败"))).toBe(true);
      expect(localStorage.getItem(key + PLAINTEXT_BACKUP_SUFFIX)).toBe(original);

      // 下一次读取能拿到新值，且不抛
      resetChainsView();
      expect(() => recvChainOwners("conv-selfcheck")).not.toThrow();
      expect(recvChainOwners("conv-selfcheck")).toEqual({ "new-kid": "dev1" });
    } finally {
      warn.mockRestore();
    }
  });

  it("解不开的信封：不静默当空链、标记 undecryptable、覆盖前原样备份", () => {
    const warn = vi.spyOn(console, "warn").mockImplementation(() => {});
    try {
      installBridge({ decrypt: () => null }); // 换系统账户/DPAPI 不可用
      const key = CHAINS_KEY("conv-unreadable");
      const envelope = JSON.stringify({ __hemingEnc: "v1", data: "xxx" });
      localStorage.setItem(key, envelope);

      expect(() => recvChainOwners("conv-unreadable")).not.toThrow();
      expect(secureStorageStatus().undecryptableKeys).toContain(key);

      handleChainDist("conv-unreadable", "dev", { kid: "k1", ck: "CCCC", n: 0, createdAt: 5 });
      expect(secureStorageStatus().backedUpKeys).toContain(key);
      expect(localStorage.getItem(key + UNDECRYPTABLE_BACKUP_SUFFIX)).toBe(envelope); // 旧密文一个字节不丢

      resetChainsView();
      expect(recvChainOwners("conv-unreadable")).toEqual({ k1: "dev" }); // fail-open：新链可继续
    } finally {
      warn.mockRestore();
    }
  });
});

// —— 无桥（浏览器）：存储形态与今天逐字等价 ——

describe("无桥（浏览器）· 存储形态不变", () => {
  it("chains 仍是明文 JSON，msgCache 仍是明文数组，get/list 语义不变", async () => {
    await initSession("conv-nobridge", makeDeps([]));
    const chainsRaw = localStorage.getItem(CHAINS_KEY("conv-nobridge"))!;
    expect(chainsRaw.startsWith("{")).toBe(true);
    expect((JSON.parse(chainsRaw) as { send?: unknown }).send).toBeTruthy();
    expect(chainsRaw).not.toContain("__hemingEnc");

    const m1 = cachedMsg("m-1", "明文正文");
    msgCache.append("conv-nobridge", m1);
    const cacheRaw = localStorage.getItem(CACHE_KEY("conv-nobridge"))!;
    expect(cacheRaw).toBe(JSON.stringify([m1])); // 逐字等价：旧明文数组
    expect(JSON.parse(cacheRaw)).toEqual([m1]);

    expect(msgCache.list("conv-nobridge")).toEqual([m1]);
    expect(msgCache.get("conv-nobridge", "m-1")).toEqual(m1);
    msgCache.remove("conv-nobridge", "m-1");
    expect(localStorage.getItem(CACHE_KEY("conv-nobridge"))).toBe("[]");
    expect(msgCacheEncryptionState("conv-nobridge")).toMatchObject({
      desktop: false,
      encrypted: false,
      reason: "no-bridge",
    });
  });
});

// —— 全链路（有桥）：磁盘密文、内存明文 ——

type SendEventLike = Extract<WsClientEvent, { type: "send_message" }>;

function makeDeps(sent: WsClientEvent[], clock = { t: Date.now() }): E2eDeps {
  return {
    fetchPeerKeys: async (id) => registry[id] ?? null,
    sendRaw: (e) => void sent.push(e),
    now: () => clock.t,
  };
}

let registry: Record<string, PeerKeys> = {};

async function bootstrap(userId: string): Promise<string> {
  localStorage.removeItem(IDENTITY_KEY);
  await initSession(`boot-${userId}`, makeDeps([]));
  const snap = localStorage.getItem(IDENTITY_KEY);
  if (!snap) throw new Error("bootstrap 后缺身份快照");
  registry[userId] = [await exportOwnDeviceKeys()];
  return snap;
}

async function asParty<T>(snap: string, fn: () => Promise<T>): Promise<T> {
  const prev = localStorage.getItem(IDENTITY_KEY);
  localStorage.setItem(IDENTITY_KEY, snap);
  try {
    return await fn();
  } finally {
    if (prev === null) localStorage.removeItem(IDENTITY_KEY);
    else localStorage.setItem(IDENTITY_KEY, prev);
  }
}

function toEnv(ev: SendEventLike, id: string, senderId: string): SealedEnvelope {
  if (ev.cipher === undefined) throw new Error("事件缺 cipher");
  return { id, senderId, cipher: ev.cipher, chainKid: ev.chainKid, n: ev.n };
}

function convOf(id: string): { id: string; memberIdOf: (chainKid: string) => string | undefined } {
  return { id, memberIdOf: () => undefined };
}

describe("有桥全链路：收发有效，磁盘只有密文", () => {
  beforeEach(() => {
    registry = {};
  });

  it("seal → open 往返：磁盘是信封/容器，API 返回明文；重载后按 id 仍可取回", async () => {
    installBridge();
    const sent: WsClientEvent[] = [];
    const deps = makeDeps(sent);
    const snapA = await bootstrap("alice-e2e");
    const snapB = await bootstrap("bob-e2e");
    const conv = { id: "conv-e2e", members: ["alice-e2e", "bob-e2e"] };

    const ev = (await asParty(snapA, () =>
      sealMessage(conv, { kind: "text", text: "机密正文内容" }, deps),
    )) as SendEvent;
    const distEv = sent[0] as SendEvent;

    await asParty(snapB, () => openMessage(convOf(conv.id), toEnv(distEv, "dist-1", "alice-e2e"), msgCache));
    const plain = await asParty(snapB, () =>
      openMessage(convOf(conv.id), toEnv(ev, "m-1", "alice-e2e"), msgCache),
    );
    expect(plain).toEqual({ kind: "text", text: "机密正文内容" });

    // 磁盘形态：msgCache 是 v2 容器、chains 是 d.36 信封，且都看不出明文
    const cacheRaw = localStorage.getItem(CACHE_KEY(conv.id))!;
    expect((JSON.parse(cacheRaw) as { __hemingMsgCache?: string }).__hemingMsgCache).toBe("v2");
    expect(cacheRaw).not.toContain("机密正文内容");
    const chainRaw = localStorage.getItem(CHAINS_KEY(conv.id))!;
    expect((JSON.parse(chainRaw) as { __hemingEnc?: string }).__hemingEnc).toBe("v1");
    expect(chainRaw).not.toContain("msgKeys");

    // 重载（清内存视图）后仍能按 id 取回同一份明文
    resetMsgCacheState();
    resetChainsView();
    expect(msgCache.get(conv.id, "m-1")).toEqual({
      id: "m-1",
      senderId: "alice-e2e",
      at: expect.any(Number),
      plain: { kind: "text", text: "机密正文内容" },
    });
    expect(msgCache.list(conv.id)).toHaveLength(1);
  });
});
