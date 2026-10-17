/**
 * Task 3 会话层测试：brief 五组用例（① 收发往返 ② 超窗 defer ③ chaindist 重扫
 * ④ 轮换前向保密 ⑤ AAD 跨会话搬移拒绝）+ 缓存/暂挂上限两组 + 评审 fix round 1 四组
 * （⑧ chaindist 新鲜度防重放回滚 ⑨ 归属取 outer.ik 认证 ⑩ 多设备不互删 ⑪ 密文去重）。
 *
 * 纯内存 E2eDeps + localStorage，不碰网络。双方共用一份 jsdom localStorage：
 * 以 asParty 切换 identity 快照模拟双端（链文件按会话隔离；多设备用例以链文件
 * 快照切换模拟同一用户的两台设备各自的发送链）。
 */
import { describe, it, expect, beforeEach } from "vitest";
import type { WsClientEvent } from "@heming/shared";
import { fromB64, toB64 } from "./e2eCrypto.js";
import {
  IDENTITY_KEY,
  initSession,
  sealMessage,
  openMessage,
  handleChainDist,
  sweepDeferred,
  deferredCount,
  recvChainOwners,
  msgCache,
  exportOwnDeviceKeys,
  type E2eDeps,
  type PeerKeys,
  type SealedEnvelope,
} from "./e2eSession.js";

type SendEvent = Extract<WsClientEvent, { type: "send_message" }>;

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

function outerOf(ev: SendEvent): Record<string, unknown> {
  if (ev.cipher === undefined) throw new Error("事件缺 cipher");
  return JSON.parse(new TextDecoder().decode(fromB64(ev.cipher))) as Record<string, unknown>;
}

/** 设备认证标识 = base64url(sha256(SPKI(ikEcdh)))——与实现的归属键同口径。 */
async function devKidOf(userId: string): Promise<string> {
  const dev = registry[userId]?.[0];
  if (!dev) throw new Error(`${userId} 无设备公钥`);
  const spki = fromB64(dev.ikEcdh);
  // TS 5.9 BufferSource 只认 ArrayBuffer 背书视图（Uint8Array<ArrayBufferLike> 不入参）
  const abuf = spki.buffer.slice(spki.byteOffset, spki.byteOffset + spki.byteLength) as ArrayBuffer;
  const digest = await crypto.subtle.digest("SHA-256", abuf);
  return toB64(digest).replace(/\+/g, "-").replace(/\//g, "_").replace(/=+$/, "");
}

describe("e2eSession 会话层", () => {
  beforeEach(() => {
    localStorage.clear();
    registry = {};
  });

  it("① 双内存 E2eDeps 收发往返：seal→open 还原且 cache 落盘", async () => {
    const sent: WsClientEvent[] = [];
    const deps = makeDeps(sent);
    const snapA = await bootstrap("alice-t1");
    const snapB = await bootstrap("bob-t1");
    const conv = { id: "t1-conv", members: ["alice-t1", "bob-t1"] };

    const ev = (await asParty(snapA, () =>
      sealMessage(conv, { kind: "text", text: "你好，和鸣" }, deps),
    )) as SendEvent;

    // 无链先 seal chaindist：先经 sendRaw 分发给对端，返回的才是正文信封
    expect(sent).toHaveLength(1); // 只发给 bob（自己设备跳过）
    expect(sent[0].type).toBe("send_message");
    expect(ev.type).toBe("send_message");
    expect(ev.enc).toBe("e2e");
    expect(typeof ev.cipher).toBe("string");
    expect(ev.payload.text).toBe(""); // 服务端只见信封
    expect(typeof ev.chainKid).toBe("string");
    expect(ev.n).toBe(0);

    // chaindist 外层公参（X3DH 引导材料，服务端可见）：ek/ik/to
    const distEv = sent[0] as SendEvent;
    const outer = outerOf(distEv);
    expect(typeof outer.ek).toBe("string");
    expect(typeof outer.ik).toBe("string");
    expect(typeof outer.to).toBe("string");

    // B 开 chaindist（解密上下文内自动落链）→ 开正文
    const distPlain = await asParty(snapB, () =>
      openMessage(convOf(conv.id), toEnv(distEv, "t1-dist", "alice-t1"), msgCache),
    );
    expect(distPlain).not.toBe("defer");
    if (typeof distPlain === "string") throw new Error("chaindist 不该 defer/duplicate");
    expect(distPlain.kind).toBe("chaindist");
    if (!distPlain.dist) throw new Error("chaindist 缺 dist");

    const plain = await asParty(snapB, () =>
      openMessage(convOf(conv.id), toEnv(ev, "t1-m1", "alice-t1"), msgCache),
    );
    expect(plain).toEqual({ kind: "text", text: "你好，和鸣" });

    // 明文缓存落盘（localStorage heming.msgCache.<convId>）
    const cached = msgCache.list(conv.id);
    expect(cached).toHaveLength(1);
    expect(cached[0].id).toBe("t1-m1");
    expect(cached[0].senderId).toBe("alice-t1");
    expect(cached[0].plain).toEqual({ kind: "text", text: "你好，和鸣" });
    expect(typeof cached[0].at).toBe("number");
  });

  it("② 缺链与超窗 n → open 返回 defer（不写明文缓存）", async () => {
    const sent: WsClientEvent[] = [];
    const deps = makeDeps(sent);
    const snapA = await bootstrap("alice-t2");
    const snapB = await bootstrap("bob-t2");
    const conv = { id: "t2-conv", members: ["alice-t2", "bob-t2"] };

    const ev = (await asParty(snapA, () =>
      sealMessage(conv, { kind: "text", text: "窗口外" }, deps),
    )) as SendEvent;
    const distEv = sent[0] as SendEvent;

    // 缺链：正文先到 → defer 进暂挂队列
    const noChain = await asParty(snapB, () =>
      openMessage(convOf(conv.id), toEnv(ev, "t2-m1", "alice-t2"), msgCache),
    );
    expect(noChain).toBe("defer");
    expect(deferredCount(conv.id)).toBe(1);
    expect(msgCache.list(conv.id)).toHaveLength(0);

    // 落链（chaindist 打开即自动落链）→ 重扫解开缺链的 t2-m1
    const distPlain = await asParty(snapB, () =>
      openMessage(convOf(conv.id), toEnv(distEv, "t2-dist", "alice-t2"), msgCache),
    );
    if (typeof distPlain === "string" || !distPlain.dist) throw new Error("chaindist 打开失败");
    await sweepDeferred(conv.id);

    // n 超出 1000 乱序窗 → 仍 defer
    const tooFar = await asParty(snapB, () =>
      openMessage(convOf(conv.id), { ...toEnv(ev, "t2-m2", "alice-t2"), n: 5000 }, msgCache),
    );
    expect(tooFar).toBe("defer");
    expect(msgCache.list(conv.id).some((m) => m.id === "t2-m2")).toBe(false);
    await sweepDeferred(conv.id); // 收尾：超窗条目重扫仍不可解
    expect(msgCache.list(conv.id).some((m) => m.id === "t2-m2")).toBe(false);
  });

  it("③ chaindist 到达后 sweepDeferred 全部解开", async () => {
    const sent: WsClientEvent[] = [];
    const deps = makeDeps(sent);
    const snapA = await bootstrap("alice-t3");
    const snapB = await bootstrap("bob-t3");
    const conv = { id: "t3-conv", members: ["alice-t3", "bob-t3"] };

    const ev = (await asParty(snapA, () =>
      sealMessage(conv, { kind: "text", text: "乱序消息" }, deps),
    )) as SendEvent;
    const distEv = sent[0] as SendEvent;

    // 正文先到（缺链）→ 暂挂
    const first = await asParty(snapB, () =>
      openMessage(convOf(conv.id), toEnv(ev, "t3-m1", "alice-t3"), msgCache),
    );
    expect(first).toBe("defer");
    expect(deferredCount(conv.id)).toBe(1);
    expect(msgCache.list(conv.id)).toHaveLength(0);

    // chaindist 到达 → 打开即落链 → 重扫暂挂
    const distPlain = await asParty(snapB, () =>
      openMessage(convOf(conv.id), toEnv(distEv, "t3-dist", "alice-t3"), msgCache),
    );
    if (typeof distPlain === "string" || !distPlain.dist) throw new Error("chaindist 打开失败");
    await sweepDeferred(conv.id);

    expect(deferredCount(conv.id)).toBe(0);
    const cached = msgCache.list(conv.id);
    expect(cached).toHaveLength(1);
    expect(cached[0].id).toBe("t3-m1");
    expect(cached[0].plain).toEqual({ kind: "text", text: "乱序消息" });
  });

  it("④ 链轮换后旧链键删除——旧密文不可再解（前向保密）", async () => {
    const clock = { t: 1_700_000_000_000 };
    const sent: WsClientEvent[] = [];
    const deps = makeDeps(sent, clock);
    const snapA = await bootstrap("alice-t4");
    const snapB = await bootstrap("bob-t4");
    const conv = { id: "t4-conv", members: ["alice-t4", "bob-t4"] };

    // 轮换前：seal→chaindist→open 还原
    const ev1 = (await asParty(snapA, () =>
      sealMessage(conv, { kind: "text", text: "轮换前" }, deps),
    )) as SendEvent;
    const dist1 = sent[0] as SendEvent;
    const p1 = await asParty(snapB, () =>
      openMessage(convOf(conv.id), toEnv(dist1, "t4-dist1", "alice-t4"), msgCache),
    );
    if (typeof p1 === "string") throw new Error("chaindist1 打开失败");
    expect(
      await asParty(snapB, () =>
        openMessage(convOf(conv.id), toEnv(ev1, "t4-m1", "alice-t4"), msgCache),
      ),
    ).toEqual({ kind: "text", text: "轮换前" });

    // 24h 后再发 → 触发轮换（新链 + 新 chaindist）
    clock.t += 25 * 3600 * 1000;
    const ev2 = (await asParty(snapA, () =>
      sealMessage(conv, { kind: "text", text: "轮换后" }, deps),
    )) as SendEvent;
    expect(sent).toHaveLength(2);
    expect(ev2.chainKid).not.toBe(ev1.chainKid); // 新链指纹
    const dist2 = sent[1] as SendEvent;
    const p2 = await asParty(snapB, () =>
      openMessage(convOf(conv.id), toEnv(dist2, "t4-dist2", "alice-t4"), msgCache),
    );
    if (typeof p2 === "string") throw new Error("chaindist2 打开失败");

    // 轮换前的密文：旧 ck 已从状态删除 → defer（不可再解）
    const again = await asParty(snapB, () =>
      openMessage(convOf(conv.id), toEnv(ev1, "t4-m1", "alice-t4"), msgCache),
    );
    expect(again).toBe("defer");

    // 新链消息正常解开
    expect(
      await asParty(snapB, () =>
        openMessage(convOf(conv.id), toEnv(ev2, "t4-m2", "alice-t4"), msgCache),
      ),
    ).toEqual({ kind: "text", text: "轮换后" });
  });

  it("⑤ AAD 绑定 convId：同一密文跨会话搬移解密失败", async () => {
    const sent: WsClientEvent[] = [];
    const deps = makeDeps(sent);
    const snapA = await bootstrap("alice-t5");
    const snapB = await bootstrap("bob-t5");
    const conv1 = { id: "t5-conv", members: ["alice-t5", "bob-t5"] };
    const devA = await devKidOf("alice-t5");

    const ev = (await asParty(snapA, () =>
      sealMessage(conv1, { kind: "text", text: "搬移测试" }, deps),
    )) as SendEvent;
    const distEv = sent[0] as SendEvent;
    const distPlain = await asParty(snapB, () =>
      openMessage(convOf(conv1.id), toEnv(distEv, "t5-dist", "alice-t5"), msgCache),
    );
    if (typeof distPlain === "string" || !distPlain.dist) throw new Error("chaindist 打开失败");
    // 同一条链分别落到两个会话（目标会话先持有链——排除「缺链」干扰，纯测 AAD）；
    // handleChainDist 的 from = 认证发送设备 id（openMessage 内由 outer.ik 算出）。
    handleChainDist("t5-conv2", devA, distPlain.dist);

    // 跨会话搬移：链在、密钥对，但 AAD 含 convId → GCM 拒绝（抛错而非 defer）
    await expect(
      asParty(snapB, () =>
        openMessage(convOf("t5-conv2"), toEnv(ev, "t5-m1x", "alice-t5"), msgCache),
      ),
    ).rejects.toThrow();
    expect(msgCache.list("t5-conv2")).toHaveLength(0);

    // 原会话不受影响，仍可正常解开
    expect(
      await asParty(snapB, () =>
        openMessage(convOf(conv1.id), toEnv(ev, "t5-m1", "alice-t5"), msgCache),
      ),
    ).toEqual({ kind: "text", text: "搬移测试" });
  });

  it("⑥ 明文缓存截尾：每会话最多保留 500 条（丢最旧）", () => {
    for (let i = 0; i <= 500; i++) {
      msgCache.append("cap-cache-conv", {
        id: `m${i}`,
        senderId: "s",
        at: i,
        plain: { kind: "text", text: `t${i}` },
      });
    }
    const list = msgCache.list("cap-cache-conv");
    expect(list).toHaveLength(500);
    expect(list[0].id).toBe("m1"); // 截掉最旧的 m0
    expect(list[499].id).toBe("m500");
  });

  it("⑦ deferred 暂挂队列上限 50 条", async () => {
    const cipher = toB64(new TextEncoder().encode(JSON.stringify({ v: 1 })));
    for (let i = 0; i < 55; i++) {
      const r = await openMessage(convOf("cap-def-conv"), {
        id: `x${i}`,
        senderId: "s",
        chainKid: `unknown-${i}`,
        n: 0,
        cipher,
      }, msgCache);
      expect(r).toBe("defer");
    }
    expect(deferredCount("cap-def-conv")).toBe(50);
  });

  it("⑧ chaindist 新鲜度：旧链分发重放被拒，不回滚新链", async () => {
    const clock = { t: 1_700_000_000_000 };
    const sent: WsClientEvent[] = [];
    const deps = makeDeps(sent, clock);
    const snapA = await bootstrap("alice-t8");
    const snapB = await bootstrap("bob-t8");
    const conv = { id: "t8-conv", members: ["alice-t8", "bob-t8"] };
    const devA = await devKidOf("alice-t8");

    const ev1 = (await asParty(snapA, () =>
      sealMessage(conv, { kind: "text", text: "轮换前" }, deps),
    )) as SendEvent;
    const dist1 = sent[0] as SendEvent;
    const p1 = await asParty(snapB, () =>
      openMessage(convOf(conv.id), toEnv(dist1, "t8-dist1", "alice-t8"), msgCache),
    );
    if (typeof p1 === "string" || !p1.dist) throw new Error("chaindist1 打开失败");
    expect(
      await asParty(snapB, () =>
        openMessage(convOf(conv.id), toEnv(ev1, "t8-m1", "alice-t8"), msgCache),
      ),
    ).toEqual({ kind: "text", text: "轮换前" });

    // 轮换 → 落新链
    clock.t += 25 * 3600 * 1000;
    const ev2 = (await asParty(snapA, () =>
      sealMessage(conv, { kind: "text", text: "轮换后" }, deps),
    )) as SendEvent;
    const dist2 = sent[1] as SendEvent;
    const p2 = await asParty(snapB, () =>
      openMessage(convOf(conv.id), toEnv(dist2, "t8-dist2", "alice-t8"), msgCache),
    );
    if (typeof p2 === "string" || !p2.dist) throw new Error("chaindist2 打开失败");

    // 重放旧 chaindist：直接 handleChainDist + 经 openMessage 整包重放两条路径都拒
    handleChainDist(conv.id, devA, p1.dist);
    await asParty(snapB, () =>
      openMessage(convOf(conv.id), toEnv(dist1, "t8-dist1-replay", "alice-t8"), msgCache),
    );

    // 新链未被回滚：m2 仍可解；旧链未复活：m1 仍 defer；状态只剩新链
    expect(
      await asParty(snapB, () =>
        openMessage(convOf(conv.id), toEnv(ev2, "t8-m2", "alice-t8"), msgCache),
      ),
    ).toEqual({ kind: "text", text: "轮换后" });
    expect(
      await asParty(snapB, () =>
        openMessage(convOf(conv.id), toEnv(ev1, "t8-m1b", "alice-t8"), msgCache),
      ),
    ).toBe("defer");
    expect(Object.keys(recvChainOwners(conv.id))).toEqual([ev2.chainKid]);
  });

  it("⑨ chaindist 归属取密码学认证的 outer.ik，不信 env.senderId", async () => {
    const sent: WsClientEvent[] = [];
    const deps = makeDeps(sent);
    const snapA = await bootstrap("alice-t9");
    const snapB = await bootstrap("bob-t9");
    const conv = { id: "t9-conv", members: ["alice-t9", "bob-t9"] };

    const ev = (await asParty(snapA, () =>
      sealMessage(conv, { kind: "text", text: "认证归属" }, deps),
    )) as SendEvent;
    const distEv = sent[0] as SendEvent;

    // 服务端谎称这条 chaindist 是 mallory 发的（env.senderId 可伪造）
    const distPlain = await asParty(snapB, () =>
      openMessage(convOf(conv.id), toEnv(distEv, "t9-dist", "mallory-t9"), msgCache),
    );
    if (typeof distPlain === "string" || !distPlain.dist) throw new Error("chaindist 打开失败");

    // 归属 = alice 设备指纹（outer.ik 经 X3DH 解密认证），不是 mallory
    const owners = recvChainOwners(conv.id);
    const devA = await devKidOf("alice-t9");
    expect(owners[distPlain.dist.kid]).toBe(devA);
    expect(owners[distPlain.dist.kid]).not.toBe("mallory-t9");

    // 链可用：正文照常解开
    expect(
      await asParty(snapB, () =>
        openMessage(convOf(conv.id), toEnv(ev, "t9-m1", "alice-t9"), msgCache),
      ),
    ).toEqual({ kind: "text", text: "认证归属" });
  });

  it("⑩ 同用户多设备：按认证设备定位链，落新链不误删他设备链", async () => {
    const sent1: WsClientEvent[] = [];
    const sent2: WsClientEvent[] = [];
    const deps1 = makeDeps(sent1);
    const deps2 = makeDeps(sent2);
    const snapD1 = await bootstrap("alice-dev1");
    const snapD2 = await bootstrap("alice-dev2");
    const snapBob = await bootstrap("bob-t10");
    registry["alice"] = [...registry["alice-dev1"], ...registry["alice-dev2"]]; // 一人双设备
    const bobKid = await devKidOf("bob-t10");
    const dev1Kid = await devKidOf("alice-dev1");
    const dev2Kid = await devKidOf("alice-dev2");
    const conv = { id: "t10-conv", members: ["alice", "bob-t10"] };
    const chainsKey = "heming.e2e.chains." + conv.id;

    // 设备1 封 m1（建立 dev1 发送链）；同一 localStorage 只能有一条 send——
    // 设备2 封 m2 前暂存 dev1 链文件，封完恢复（模拟两台设备各自的发送链）
    const m1 = (await asParty(snapD1, () =>
      sealMessage(conv, { kind: "text", text: "dev1-m1" }, deps1),
    )) as SendEvent;
    const chainsD1 = localStorage.getItem(chainsKey);
    localStorage.removeItem(chainsKey);
    const m2 = (await asParty(snapD2, () =>
      sealMessage(conv, { kind: "text", text: "dev2-m2" }, deps2),
    )) as SendEvent;
    if (chainsD1 !== null) localStorage.setItem(chainsKey, chainsD1);
    const m1b = (await asParty(snapD1, () =>
      sealMessage(conv, { kind: "text", text: "dev1-m1b" }, deps1),
    )) as SendEvent;

    // 只取发给 bob 的定向 chaindist（外层 to = bob 指纹）
    const isBobDist = (e: WsClientEvent) => {
      const se = e as SendEvent;
      return se.cipher !== undefined && outerOf(se).to === bobKid;
    };
    const bobDist1 = sent1.find(isBobDist);
    const bobDist2 = sent2.find(isBobDist);
    if (!bobDist1 || !bobDist2) throw new Error("缺 bob 定向 chaindist");

    // B 落 dev1 链 → 落 dev2 链（两者同属用户 alice，但设备不同，链必须共存）
    const p1 = await asParty(snapBob, () =>
      openMessage(convOf(conv.id), toEnv(bobDist1 as SendEvent, "t10-d1", "alice"), msgCache),
    );
    const p2 = await asParty(snapBob, () =>
      openMessage(convOf(conv.id), toEnv(bobDist2 as SendEvent, "t10-d2", "alice"), msgCache),
    );
    if (typeof p1 === "string" || typeof p2 === "string") throw new Error("chaindist 打开失败");

    const owners = recvChainOwners(conv.id);
    expect(owners[m1.chainKid!]).toBe(dev1Kid);
    expect(owners[m2.chainKid!]).toBe(dev2Kid);
    expect(new Set(Object.values(owners)).size).toBe(2); // 两台设备的链并存

    // 两台设备的消息都可解（若按 userId 删链，dev1 链会被 dev2 的分发误删 → defer）
    expect(
      await asParty(snapBob, () =>
        openMessage(convOf(conv.id), toEnv(m2, "t10-m2", "alice"), msgCache),
      ),
    ).toEqual({ kind: "text", text: "dev2-m2" });
    expect(
      await asParty(snapBob, () =>
        openMessage(convOf(conv.id), toEnv(m1b, "t10-m1b", "alice"), msgCache),
      ),
    ).toEqual({ kind: "text", text: "dev1-m1b" });
  });

  it("⑪ (chainKid, n) 去重：同密文重放第二次返回 duplicate，不重复落缓存", async () => {
    const sent: WsClientEvent[] = [];
    const deps = makeDeps(sent);
    const snapA = await bootstrap("alice-t11");
    const snapB = await bootstrap("bob-t11");
    const conv = { id: "t11-conv", members: ["alice-t11", "bob-t11"] };

    const ev = (await asParty(snapA, () =>
      sealMessage(conv, { kind: "text", text: "只收一次" }, deps),
    )) as SendEvent;
    const distEv = sent[0] as SendEvent;
    const distPlain = await asParty(snapB, () =>
      openMessage(convOf(conv.id), toEnv(distEv, "t11-dist", "alice-t11"), msgCache),
    );
    if (typeof distPlain === "string") throw new Error("chaindist 打开失败");

    const env = toEnv(ev, "t11-m1", "alice-t11");
    expect(
      await asParty(snapB, () => openMessage(convOf(conv.id), env, msgCache)),
    ).toEqual({ kind: "text", text: "只收一次" });
    // 同信封重放 → duplicate
    expect(
      await asParty(snapB, () => openMessage(convOf(conv.id), env, msgCache)),
    ).toBe("duplicate");
    // 换 id 但 (chainKid, n) 相同 → 同样拒（去重键是链索引而非消息 id）
    expect(
      await asParty(snapB, () =>
        openMessage(convOf(conv.id), { ...env, id: "t11-m1-copy" }, msgCache),
      ),
    ).toBe("duplicate");
    expect(msgCache.list(conv.id)).toHaveLength(1);
  });
});
