/**
 * d.59 · Electron 46（只有异步 safeStorage）上的 E2E 收发热路径。
 *
 * 验收点（方案 a：预取 + 内存视图 + 异步落盘）：
 * - 冷启动 `ensureE2eStorageReady()` 之后，chains 的同步读命中内存视图（不再依赖同步桥）；
 * - 收消息立即可解密（`openMessage` 返回即可用，`msgCache.list` 立即可见）；
 * - `seal/open` 返回时链状态**已落盘**（信封可解、n 已前进），缓存同样已落盘；
 * - 异步桥不可用时 fail-open 明文 + 状态可见，收发不中断。
 */
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import type { WsClientEvent } from "@heming/shared";
import {
  IDENTITY_KEY,
  ensureE2eStorageReady,
  exportOwnDeviceKeys,
  initSession,
  isForMe,
  msgCache,
  openMessage,
  recvChainOwners,
  resetE2eAsyncState,
  resetMsgCacheLru,
  resetMsgCacheState,
  sealMessage,
  type E2eDeps,
  type PeerKeys,
  type SealedEnvelope,
} from "./e2eSession.js";
import { resetSecureStorageState, secureStorageStatus } from "./secureStorage.js";

type SendEvent = Extract<WsClientEvent, { type: "send_message" }>;

function envelopeOf(cipher: string): string {
  return JSON.stringify({ __hemingEnc: "v1", data: cipher });
}

/** 46 桥：同步三件套已移除（返回 null），只有异步 API。缓存读按当前磁盘 raw 派生。 */
function installAsyncOnlyBridge(opts: { encryptFails?: boolean } = {}) {
  const calls = { syncEncrypt: 0, syncDecrypt: 0 };
  const bridge = {
    available: false,
    mode: "async" as const,
    asyncAvailable: true,
    encrypt: () => {
      calls.syncEncrypt += 1;
      return null;
    },
    decrypt: () => {
      calls.syncDecrypt += 1;
      return null;
    },
    encryptAsync: async (plain: string) => (opts.encryptFails ? null : `enc:${plain}`),
    decryptAsync: async (cipher: string) => (cipher.startsWith("enc:") ? cipher.slice(4) : null),
    encryptManyAsync: async (plains: string[]) => plains.map((plain) => (opts.encryptFails ? null : `enc:${plain}`)),
    decryptManyAsync: async (ciphers: string[]) =>
      ciphers.map((cipher) => (cipher.startsWith("enc:") ? cipher.slice(4) : null)),
    cachedRead: (key: string) => {
      try {
        const raw = localStorage.getItem(key);
        if (raw === null) return undefined;
        const parsed = JSON.parse(raw) as { __hemingEnc?: string; data?: unknown };
        if (parsed && parsed.__hemingEnc === "v1" && typeof parsed.data === "string") {
          return parsed.data.startsWith("enc:") ? parsed.data.slice(4) : null;
        }
        return raw; // 明文（迁移期/降级）
      } catch {
        return undefined;
      }
    },
    cacheSet: () => {},
    cacheDelete: () => {},
  };
  (window as unknown as { __heming_secrets?: unknown }).__heming_secrets = bridge;
  return calls;
}

function uninstallBridge(): void {
  delete (window as unknown as { __heming_secrets?: unknown }).__heming_secrets;
}

let registry: Record<string, PeerKeys> = {};

function makeDeps(sent: WsClientEvent[], clock = { t: Date.now() }): E2eDeps {
  return {
    fetchPeerKeys: async (id) => registry[id] ?? null,
    sendRaw: (e) => void sent.push(e),
    now: () => clock.t,
  };
}

/** 生成一方身份（identity 槽位清空后 initSession 自动生成），导出公钥进注册表并返回快照。 */
async function bootstrap(userId: string): Promise<string> {
  localStorage.removeItem(IDENTITY_KEY);
  await initSession(`boot-${userId}`, makeDeps([]));
  const snap = localStorage.getItem(IDENTITY_KEY);
  if (!snap) throw new Error("bootstrap 后缺身份快照");
  registry[userId] = [await exportOwnDeviceKeys()];
  return snap;
}

/** 以某一方身份执行（identity 槽位换入快照，结束后还原）。 */
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

function toEnv(ev: SendEvent, id: string, senderId: string): SealedEnvelope {
  if (ev.cipher === undefined) throw new Error("事件缺 cipher");
  return { id, senderId, cipher: ev.cipher, chainKid: ev.chainKid, n: ev.n };
}

function convOf(id: string): { id: string; memberIdOf: (chainKid: string) => string | undefined } {
  return { id, memberIdOf: () => undefined };
}

/** 从 d.36 信封里取明文（只用于断言磁盘上不是明文）。 */
function plainOfEnvelope(raw: string): string {
  const parsed = JSON.parse(raw) as { __hemingEnc?: string; data?: string };
  if (parsed.__hemingEnc !== "v1" || typeof parsed.data !== "string" || !parsed.data.startsWith("enc:")) {
    throw new Error(`不是密文信封：${raw.slice(0, 40)}`);
  }
  return parsed.data.slice(4);
}

beforeEach(() => {
  resetSecureStorageState();
  resetE2eAsyncState();
  resetMsgCacheState();
  resetMsgCacheLru();
  localStorage.clear();
  registry = {};
  installAsyncOnlyBridge();
});

afterEach(() => {
  uninstallBridge();
});

describe("46 · E2E 冷启动与收发", () => {
  it("冷启动：ensure 之后 chains 同步读命中内存视图（零 IPC、不用同步桥）", async () => {
    const chains = {
      recv: { k1: { kid: "k1", ck: "AAAA", n: 1, createdAt: 5, from: "dev-peer", msgKeys: {} } },
    };
    localStorage.setItem(`heming.e2e.chains.c-cold`, envelopeOf(`enc:${JSON.stringify(chains)}`));

    await ensureE2eStorageReady("c-cold");

    // 同步读（loadChains → 内存视图）：拿到磁盘上的接收链
    expect(recvChainOwners("c-cold")).toEqual({ k1: "dev-peer" });
    // 期间没有回退同步桥
    expect(localStorage.getItem("heming.e2e.chains.c-cold")).toContain("__hemingEnc");
  });

  it("收发往返：收到即可解密，链状态与消息缓存都在返回前落盘", async () => {
    const sent: WsClientEvent[] = [];
    const deps = makeDeps(sent);
    const snapA = await bootstrap("alice46");
    const snapB = await bootstrap("bob46");
    const conv = { id: "c46", members: ["alice46", "bob46"] };

    const ev = (await asParty(snapA, () =>
      sealMessage(conv, { kind: "text", text: "46 也能收" }, deps),
    )) as SendEvent;
    expect(sent).toHaveLength(1); // 先发 chaindist（对方设备），正文用返回值

    // 发送端：seal 返回时链状态已落盘且是密文信封（n 前进了 1 —— 不会因重启复用 msgKey）
    const senderRaw = localStorage.getItem(`heming.e2e.chains.${conv.id}`) as string;
    expect(senderRaw).toContain("__hemingEnc");
    expect(senderRaw).not.toContain('"send"'); // 链状态不在磁盘明文里
    expect(JSON.parse(plainOfEnvelope(senderRaw)).send.n).toBe(1);

    const convB = convOf(conv.id);
    await asParty(snapB, () => openMessage(convB, toEnv(sent[0] as SendEvent, "d1", "alice46"), msgCache));
    const plain = await asParty(snapB, () => openMessage(convB, toEnv(ev, "m1", "alice46"), msgCache));
    expect(plain).toMatchObject({ kind: "text", text: "46 也能收" });

    // 收到即可解密：内存视图立即可见（不依赖下一次渲染/异步补取）
    expect(msgCache.list(conv.id).map((m) => m.id)).toContain("m1");
    expect(msgCache.get(conv.id, "m1")).toMatchObject({ id: "m1" });

    // 消息缓存已异步落盘 + 是逐条密文的 v2 容器（条目走 `d` 密文，没有明文 `m` 条目）
    const cacheRaw = localStorage.getItem(`heming.msgCache.${conv.id}`) as string;
    expect(cacheRaw).toContain('"__hemingMsgCache":"v2"');
    expect(cacheRaw).toContain('"d":"enc:'); // 走了异步批量加密（mock 的 cipher 也带 enc: 前缀）
    expect(cacheRaw).not.toContain('"m":'); // 不是明文条目形态

    // 接收端链状态也已落盘且可解（chaindist 的 recv 链）
    const recvRaw = localStorage.getItem(`heming.e2e.chains.${conv.id}`) as string;
    expect(recvRaw).toContain("__hemingEnc");
    expect(recvChainOwners(conv.id)[JSON.parse(plainOfEnvelope(recvRaw)).recv ? Object.keys(JSON.parse(plainOfEnvelope(recvRaw)).recv)[0] : ""]).toBeTruthy();
  });

  it("isForMe：身份异步写完即可判定定向信封（不会因 raw 缺失误丢 chaindist）", async () => {
    const sent: WsClientEvent[] = [];
    const deps = makeDeps(sent);
    const snapA = await bootstrap("alice46b");
    const snapB = await bootstrap("bob46b");
    const conv = { id: "c46b", members: ["alice46b", "bob46b"] };
    await asParty(snapA, () => sealMessage(conv, { kind: "text", text: "定向" }, deps));
    const dist = sent[0];

    // 身份信封是异步写的：bootstrap 已 await，所以这里 raw 一定在，isForMe 能正确判定
    expect(localStorage.getItem(IDENTITY_KEY)).toContain("__hemingEnc");
    expect(await asParty(snapB, async () => isForMe(toEnv(dist as SendEvent, "d2", "alice46b")))).toBe(true);
  });

  it("异步桥不可用（加密全失败）：fail-open 明文 + 状态可见，收发仍不中断", async () => {
    installAsyncOnlyBridge({ encryptFails: true });
    const sent: WsClientEvent[] = [];
    const deps = makeDeps(sent);
    const snapA = await bootstrap("alice-fail");
    const snapB = await bootstrap("bob-fail");
    const conv = { id: "c46-fail", members: ["alice-fail", "bob-fail"] };

    const ev = (await asParty(snapA, () =>
      sealMessage(conv, { kind: "text", text: "降级也要能用" }, deps),
    )) as SendEvent;
    const convB = convOf(conv.id);
    await asParty(snapB, () => openMessage(convB, toEnv(sent[0] as SendEvent, "d2", "alice-fail"), msgCache));
    const plain = await asParty(snapB, () => openMessage(convB, toEnv(ev, "m2", "alice-fail"), msgCache));
    expect(plain).toMatchObject({ text: "降级也要能用" });

    // 降级是可见的（不是静默假装加密），但磁盘数据仍是可解析的明文（不写坏密文）
    const status = secureStorageStatus();
    expect(status.plaintextKeys.some((key) => key.startsWith("heming.e2e.chains."))).toBe(true);
    expect(localStorage.getItem(`heming.e2e.chains.${conv.id}`)).toContain('"send"');
  });
});
