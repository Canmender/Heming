/**
 * E2E 会话层：链管理、封解密、乱序暂挂与本地明文缓存。
 * 规格：docs/superpowers/specs/2026-10-17-e2e-encryption-design.md §3.2/§5/§6。
 *
 * - 密码原语一律 import ./e2eCrypto.js（X3DH/hkdfChain/GCM，Task 1 已评审），本文件禁止重实现。
 * - 纯逻辑 + E2eDeps 注入（fetchPeerKeys/sendRaw/now），测试不碰真实网络。
 * - 持久化全在 localStorage（密钥不出设备、无备份无恢复）：
 *     heming.e2e.identity              设备身份（IK 双键 JWK + 签名预键 SPK）
 *     heming.e2e.chains.<convId>       会话链：我的发送链 + 收到的对端链
 *     heming.msgCache.<convId>         解密后明文缓存（截尾 500 条/会话）
 *     heming.e2e.deferred.<convId>     缺链/超窗暂挂信封（上限 50 条）
 *
 * 链分发（chaindist）走 X3DH 成对封装（§3.2「用对方 §3.1 会话加密」）：
 * 外层公参 ek/ik/to（服务端可见的引导材料），内层 GCM 密文装 {kind:"chaindist", dist}。
 * 正文消息走本会话发送链逐条 KDF（msgKey + 链推进），AAD 绑定 convId+chainKid+n 防搬移。
 */
import type { WsClientEvent, E2eDeviceKeys } from "@heming/shared";
import {
  generateIdentity,
  exportPub,
  importPub,
  signPrekeyPayload,
  verifyPrekey,
  x3dh,
  hkdfChain,
  encryptMsg,
  decryptMsg,
  toB64,
  fromB64,
} from "./e2eCrypto.js";

// —— 存储键（导出供测试/接线层定位）——
export const IDENTITY_KEY = "heming.e2e.identity";
const CHAINS_PREFIX = "heming.e2e.chains.";
const DEFERRED_PREFIX = "heming.e2e.deferred.";
const MSGCACHE_PREFIX = "heming.msgCache.";

// —— 协议常量（设计 §3.2 乱序窗/轮换周期、§6 缓存截尾、brief 暂挂上限）——
export const WINDOW = 1000; // 乱序窗口：缓存最近 1000 个 msgKey
export const DEFERRED_CAP = 50; // 暂挂队列上限
export const CACHE_CAP = 500; // 明文缓存截尾（条/会话）
const SWEEP_BATCH = 5; // sweepDeferred 单次重扫条数
const ROTATE_N = 100; // 链滚动：条数阈值
const ROTATE_MS = 24 * 60 * 60 * 1000; // 链滚动：24h

const AAD_PREFIX = "heming.e2e.v1"; // AAD 命名空间前缀
const MSG_LABEL = "msg"; // 正文链 KDF label（agent chunk 等走独立 label，见 e2eCrypto.hkdfChain）
const DIST_LABEL = "chaindist"; // X3DH 链分发封装 KDF label

const DECRYPT_FAILED = "e2e_decrypt_failed";
const NOT_FOR_DEVICE = "e2e_not_for_device";

const textEnc = new TextEncoder();
const textDec = new TextDecoder();

// —— 公开类型（brief 接口签名）——

/** 对端某用户的设备公钥列表（GET /api/e2e/keys 的 per-user 值；首版单设备为主）。 */
export type PeerKeys = E2eDeviceKeys[];

export interface E2eDeps {
  fetchPeerKeys(userId: string): Promise<PeerKeys | null>;
  sendRaw(e: WsClientEvent): void;
  now(): number;
}

/** 链状态（brief）；持久化时附 createdAt（轮换判据）与 distFor/recv 附加字段。 */
export interface ChainState {
  kid: string;
  ck: string; // 链键 base64
  n: number; // 下一个待用链索引
}

/** 密文内 JSON（§3.3）：kind 判别 + 各类载荷；chaindist 携带 dist 链材料。 */
export interface PlainEnvelope {
  kind: "text" | "file" | "forward" | "reaction" | "chaindist";
  text?: string;
  file?: { id: string; name: string; mime: string; size: number; key?: string };
  forward?: { from: string; source: string };
  reaction?: { target: string; emoji: string; op: "add" | "remove" };
  replyTo?: string;
  dist?: ChainDist;
}

/** 服务端信封（message_new 拆出的 e2e 形态）；senderId/createdAt 供缓存落盘。 */
export interface SealedEnvelope {
  id: string;
  senderId?: string;
  chainKid?: string;
  n?: number;
  cipher: string;
  createdAt?: string; // 服务端 Message.createdAt（ISO）
}

/** 链分发载荷（明文体 kind="chaindist" 的 dist 字段）。 */
export interface ChainDist {
  kid: string;
  ck: string;
  n: number;
  createdAt: number;
}

/** 解密后明文缓存条目（localStorage heming.msgCache.<convId>）。 */
export interface CachedMsg {
  id: string;
  senderId: string;
  at: number; // epoch ms
  plain: PlainEnvelope;
}

export interface MsgCache {
  append(convId: string, m: CachedMsg): void;
  list(convId: string): CachedMsg[];
}

// —— 内部持久化形状 ——

interface StoredIdentity {
  kid: string;
  ikEcdh: JsonWebKey;
  ikSign: JsonWebKey;
  spk: { priv: JsonWebKey; pub: string; sig: string; createdAt: number };
}

interface LoadedIdentity {
  kid: string;
  ikEcdh: CryptoKey;
  ikSign: CryptoKey;
  spkPriv: CryptoKey;
  spkPub: string;
  spkSig: string;
  spkCreatedAt: number;
}

interface SendChain extends ChainState {
  createdAt: number;
  distFor: string[]; // 本链已分发到的成员（轮换后清空）
}

interface RecvChain extends ChainState {
  createdAt: number;
  from?: string; // 发送者 userId（handleChainDist 登记，轮换删旧链用）
  msgKeys: Record<string, string>; // 乱序窗口内已缓存的 msgKey（key 为 n）
}

interface ChainsFile {
  send?: SendChain;
  recv: Record<string, RecvChain>;
}

/** chaindist 信封外层（cipher 内 JSON 的非加密部分）：ek/ik/to 为公开引导材料。 */
interface CipherOuter {
  v?: number;
  n?: number;
  ek?: string;
  ik?: string;
  to?: string;
  nonce?: string;
  data?: string;
}

// —— 小工具 ——

function readJson<T>(key: string): T | null {
  const raw = localStorage.getItem(key);
  if (raw === null) return null;
  try {
    return JSON.parse(raw) as T;
  } catch {
    return null;
  }
}

function writeJson(key: string, value: unknown): void {
  localStorage.setItem(key, JSON.stringify(value));
}

/** Uint8Array → ArrayBuffer（TS 5.9 BufferSource 要求 ArrayBuffer 背书，同 e2eCrypto）。 */
function ab(u8: Uint8Array): ArrayBuffer {
  return u8.buffer.slice(u8.byteOffset, u8.byteOffset + u8.byteLength) as ArrayBuffer;
}

function utf8(s: string): Uint8Array {
  return textEnc.encode(s);
}

function randomBytes(len: number): Uint8Array {
  return crypto.getRandomValues(new Uint8Array(len));
}

/** base64url（无填充）——kid 指纹统一格式（同 e2eCrypto 内部 toB64url）。 */
function b64url(buf: ArrayBuffer | Uint8Array): string {
  return toB64(buf)
    .replace(/\+/g, "-")
    .replace(/\//g, "_")
    .replace(/=+$/, "");
}

/** 链指纹 kid = base64url(sha256(ck))：不可由 kid 反推 ck（sha256 原像抗性）。 */
async function chainKidOf(ck: Uint8Array): Promise<string> {
  return b64url(await crypto.subtle.digest("SHA-256", ab(ck)));
}

/** 设备身份 kid = base64url(sha256(SPKI(ECDH 公钥)))——由已发布 ikEcdh 复算收件人指纹。 */
async function kidOfSpki(spkiB64: string): Promise<string> {
  return b64url(await crypto.subtle.digest("SHA-256", ab(fromB64(spkiB64))));
}

function loadChains(convId: string): ChainsFile {
  return readJson<ChainsFile>(CHAINS_PREFIX + convId) ?? { recv: {} };
}

function saveChains(convId: string, file: ChainsFile): void {
  writeJson(CHAINS_PREFIX + convId, file);
}

function loadDeferred(convId: string): SealedEnvelope[] {
  return readJson<SealedEnvelope[]>(DEFERRED_PREFIX + convId) ?? [];
}

function saveDeferred(convId: string, list: SealedEnvelope[]): void {
  // 上限 50：溢出丢最旧（保留最新 50 条）
  writeJson(DEFERRED_PREFIX + convId, list.length > DEFERRED_CAP ? list.slice(-DEFERRED_CAP) : list);
}

/** 暂挂条目按 id 去重入队（重试 defer 不重复堆积）。 */
function pushDeferred(convId: string, env: SealedEnvelope): void {
  const list = loadDeferred(convId);
  if (list.some((e) => e.id === env.id)) return;
  list.push(env);
  saveDeferred(convId, list);
}

/** 当前暂挂条数（测试与接线层可观测）。 */
export function deferredCount(convId: string): number {
  return loadDeferred(convId).length;
}

function aadMsg(convId: string, chainKid: string, n: number): Uint8Array {
  return utf8(`${AAD_PREFIX}|${convId}|${chainKid}|${n}`);
}

function aadDist(convId: string, to: string): Uint8Array {
  return utf8(`${AAD_PREFIX}|${convId}|dist|${to}`);
}

function parseOuter(cipher: string): CipherOuter {
  const parsed = JSON.parse(textDec.decode(fromB64(cipher))) as CipherOuter;
  if (!parsed || typeof parsed !== "object") throw new Error(DECRYPT_FAILED);
  return parsed;
}

// —— 身份（heming.e2e.identity）——

async function ensureIdentity(): Promise<StoredIdentity> {
  const existing = readJson<StoredIdentity>(IDENTITY_KEY);
  if (existing?.kid && existing.spk?.pub) return existing;
  // 生成/载入身份：IK 双键（ECDH 协商 + ECDSA 签名链）+ 签名预键 SPK（§3.1）
  const id = await generateIdentity();
  const spkPair = await crypto.subtle.generateKey({ name: "ECDH", namedCurve: "P-256" }, true, [
    "deriveBits",
  ]);
  const spkPub = await exportPub(spkPair.publicKey);
  const sig = await signPrekeyPayload(id.ikSign, spkPub);
  const stored: StoredIdentity = {
    kid: id.kid,
    ikEcdh: await crypto.subtle.exportKey("jwk", id.ikEcdh),
    ikSign: await crypto.subtle.exportKey("jwk", id.ikSign),
    spk: {
      priv: await crypto.subtle.exportKey("jwk", spkPair.privateKey),
      pub: spkPub,
      sig,
      createdAt: Date.now(),
    },
  };
  writeJson(IDENTITY_KEY, stored);
  return stored;
}

async function loadIdentity(): Promise<LoadedIdentity> {
  const s = await ensureIdentity();
  const ikEcdh = await crypto.subtle.importKey("jwk", s.ikEcdh, { name: "ECDH", namedCurve: "P-256" }, true, [
    "deriveBits",
  ]);
  // 私钥 JWK 只允许 ["sign"]（["verify"] 属公钥用途，混入即 Unsupported key usage）
  const ikSign = await crypto.subtle.importKey(
    "jwk",
    s.ikSign,
    { name: "ECDSA", namedCurve: "P-256" },
    true,
    ["sign"],
  );
  const spkPriv = await crypto.subtle.importKey("jwk", s.spk.priv, { name: "ECDH", namedCurve: "P-256" }, true, [
    "deriveBits",
  ]);
  return {
    kid: s.kid,
    ikEcdh,
    ikSign,
    spkPriv,
    spkPub: s.spk.pub,
    spkSig: s.spk.sig,
    spkCreatedAt: s.spk.createdAt,
  };
}

/**
 * 导出本人设备公钥包（PUT /api/e2e/keys 上云；测试用它把公钥注入对端 fetchPeerKeys）。
 */
export async function exportOwnDeviceKeys(): Promise<E2eDeviceKeys> {
  const id = await loadIdentity();
  return {
    ikEcdh: await exportPub(id.ikEcdh),
    ikSign: await exportPub(id.ikSign),
    spk: { pub: id.spkPub, sig: id.spkSig, createdAt: id.spkCreatedAt },
  };
}

/**
 * 该信封是否为本设备封装（chaindist 按 to 收件人指纹定向）。
 * 接线层在 openMessage 前过滤他设备的 chaindist，避免渲染层收到无法解的占位。
 */
export function isForMe(env: SealedEnvelope): boolean {
  try {
    if (!env.cipher) return false;
    const outer = parseOuter(env.cipher);
    if (outer.ek === undefined || outer.to === undefined) return true; // 正文信封无定向
    const raw = localStorage.getItem(IDENTITY_KEY);
    if (!raw) return false;
    return (JSON.parse(raw) as StoredIdentity).kid === outer.to;
  } catch {
    return false;
  }
}

// —— initSession ——

/**
 * 生成/载入身份与本会话发送链（幂等），并登记本会话 deps。
 * deps 登记给接线层用（e2e_need_init 自动重发等）；Task 3 内 sealMessage 走入参 deps。
 */
export async function initSession(convId: string, deps: E2eDeps): Promise<void> {
  depsByConv.set(convId, deps);
  await ensureIdentity();
  const chains = loadChains(convId);
  if (!chains.send) {
    const ck = randomBytes(32);
    chains.send = { kid: await chainKidOf(ck), ck: toB64(ck), n: 0, createdAt: deps.now(), distFor: [] };
    saveChains(convId, chains);
  }
}

// 模块级会话登记：convId → deps（接线层自动重发 init/chaindist 用）、convId → 明文缓存（sweep 用）
const depsByConv = new Map<string, E2eDeps>();
const cacheByConv = new Map<string, MsgCache>();

/** 取 initSession 登记的会话 deps（接线层 e2e_need_init 自动重发等用）。 */
export function getE2eDeps(convId: string): E2eDeps | undefined {
  return depsByConv.get(convId);
}

// —— sealMessage ——

/**
 * 封一条密文消息 → send_message{enc:"e2e"} 事件。
 * 无链/新成员 → 先经 sendRaw 分发 chaindist（X3DH 成对封装），再封正文；
 * n>=100 或 now()-createdAt>24h → 轮换新链（旧链键随覆盖删除，前向保密）。
 */
export async function sealMessage(
  conv: { id: string; members: string[] },
  plain: PlainEnvelope,
  deps: E2eDeps,
): Promise<WsClientEvent> {
  await initSession(conv.id, deps); // 生成/载入身份 + 链（幂等）
  const identity = await loadIdentity();
  const chains = loadChains(conv.id);
  let send = chains.send!;
  const now = deps.now();

  // 链滚动（§3.2）：100 条或 24h → 新链 + 重新分发（distFor 清空触发 chaindist）
  if (send.n >= ROTATE_N || now - send.createdAt > ROTATE_MS) {
    const ck = randomBytes(32);
    send = { kid: await chainKidOf(ck), ck: toB64(ck), n: 0, createdAt: now, distFor: [] };
    chains.send = send;
    saveChains(conv.id, chains);
  }

  await distributeChain(conv, chains, send, identity, deps);

  // 正文封条：msgKey = HKDF(CK_n, "msg")，CK_{n+1} = HKDF(CK_n, "chain")
  const { msgKey, next } = await hkdfChain(ab(fromB64(send.ck)), MSG_LABEL);
  const nonce = randomBytes(12);
  const data = await encryptMsg(msgKey, nonce, utf8(JSON.stringify(plain)), aadMsg(conv.id, send.kid, send.n));
  const cipher = toB64(utf8(JSON.stringify({ v: 1, n: send.n, nonce: toB64(nonce), data })));
  const ev: WsClientEvent = {
    type: "send_message",
    conversationId: conv.id,
    payload: { text: "" }, // 占位 payload：内容只进密文（服务端 e2e 路径不读）
    enc: "e2e",
    cipher,
    chainKid: send.kid,
    n: send.n,
  };
  send.ck = toB64(next);
  send.n += 1;
  saveChains(conv.id, chains);
  return ev;
}

/** 对尚未持有本链的成员逐设备 X3DH 封装分发（自己的设备跳过；无公钥留待下次 seal 重试）。 */
async function distributeChain(
  conv: { id: string; members: string[] },
  chains: ChainsFile,
  send: SendChain,
  identity: LoadedIdentity,
  deps: E2eDeps,
): Promise<void> {
  const myPub = await exportPub(identity.ikEcdh);
  let dirty = false;
  for (const member of conv.members) {
    if (send.distFor.includes(member)) continue;
    let devices: PeerKeys | null = null;
    try {
      devices = await deps.fetchPeerKeys(member);
    } catch {
      continue; // 取公钥网络失败：不阻塞发送，该成员下次 seal 重试分发
    }
    if (!devices?.length) continue; // 尚未上云公钥：不标记，下次 seal 重试
    let ok = false;
    for (const dev of devices) {
      if (dev.ikEcdh === myPub) {
        ok = true; // 自己的设备无需分发（本链自己就有）
        continue;
      }
      deps.sendRaw(await sealChainDist(conv.id, dev, send, identity));
      ok = true;
    }
    if (ok) {
      send.distFor.push(member);
      dirty = true;
    }
  }
  if (dirty) saveChains(conv.id, chains);
}

/**
 * 单设备 chaindist：X3DH（initiator，SK=己方 IK）→ HKDF("chaindist") → GCM 封 dist。
 * 外层 {v, ek, ik, to, nonce, data}：ek/ik/to 是公开引导材料（服务端可见的公钥材料），
 * to = 收件人身份指纹（定向封装——群聊中他设备凭 isForMe 跳过）。
 */
async function sealChainDist(
  convId: string,
  dev: E2eDeviceKeys,
  send: SendChain,
  identity: LoadedIdentity,
): Promise<WsClientEvent> {
  // SPK 签名验不过 → 服务端可能替换了对端公钥，拒绝在此密钥上建立会话
  const signPub = await crypto.subtle.importKey(
    "spki",
    ab(fromB64(dev.ikSign)),
    { name: "ECDSA", namedCurve: "P-256" }, // EcKeyImportParams：带 namedCurve（hash 属验签时的算法参数）
    true,
    ["verify"],
  );
  if (!(await verifyPrekey(signPub, dev.spk.pub, dev.spk.sig))) {
    throw new Error("E2E 签名预键校验失败");
  }
  const ek = await crypto.subtle.generateKey({ name: "ECDH", namedCurve: "P-256" }, true, ["deriveBits"]);
  const rk = await x3dh({
    role: "initiator",
    ikEcdh: identity.ikEcdh,
    ekPriv: ek.privateKey,
    peerIK: await importPub(dev.ikEcdh, []),
    spkPub: await importPub(dev.spk.pub, []),
  });
  const { msgKey } = await hkdfChain(rk, DIST_LABEL);
  const to = await kidOfSpki(dev.ikEcdh);
  const nonce = randomBytes(12);
  const dist: ChainDist = { kid: send.kid, ck: send.ck, n: send.n, createdAt: send.createdAt };
  const body = utf8(JSON.stringify({ kind: "chaindist", dist }));
  const data = await encryptMsg(msgKey, nonce, body, aadDist(convId, to));
  const cipher = toB64(
    utf8(
      JSON.stringify({
        v: 1,
        ek: await exportPub(ek.publicKey),
        ik: await exportPub(identity.ikEcdh),
        to,
        nonce: toB64(nonce),
        data,
      }),
    ),
  );
  return {
    type: "send_message",
    conversationId: convId,
    payload: { text: "" },
    enc: "e2e",
    cipher,
    chainKid: identity.kid, // 定向信封用身份指纹作公开 chainKid（非发送链）
    n: 0,
  };
}

// —— openMessage ——

/**
 * 解开一条 e2e 信封。
 * - chaindist（外层带 ek）→ X3DH 解封，返回 {kind:"chaindist", dist}（落链交给 handleChainDist）；
 * - 正文 → 发送链 msgKey 解密并写明文缓存；
 * - 缺链/超窗 → 入暂挂队列（上限 50）并返回 "defer"；
 * - GCM 校验失败（AAD 被搬移/密钥错）→ 抛错（接线层渲染「无法解密」占位）。
 */
export async function openMessage(
  conv: { id: string; memberIdOf: (chainKid: string) => string | undefined },
  env: SealedEnvelope,
  cache: MsgCache,
): Promise<PlainEnvelope | "defer"> {
  cacheByConv.set(conv.id, cache);
  if (!env.cipher) throw new Error(DECRYPT_FAILED);
  let outer: CipherOuter;
  try {
    outer = parseOuter(env.cipher);
  } catch {
    throw new Error(DECRYPT_FAILED);
  }
  if (outer.ek !== undefined) return openX3dhDist(conv, env, outer, cache);
  return openChainMsg(conv, env, outer, cache);
}

/** 正文路径：发送链查键 → msgKey 派生 → GCM 解密 → 提交链状态 → 落缓存。 */
async function openChainMsg(
  conv: { id: string; memberIdOf: (chainKid: string) => string | undefined },
  env: SealedEnvelope,
  outer: CipherOuter,
  cache: MsgCache,
): Promise<PlainEnvelope | "defer"> {
  const { chainKid, n } = env;
  if (!chainKid || n === undefined) {
    pushDeferred(conv.id, env); // 形状不全（缺链索引）→ 暂挂，元数据到达后重扫可解
    return "defer";
  }
  const convId = conv.id;
  const chains = loadChains(convId);
  const chain = chains.recv[chainKid];
  if (!chain) {
    pushDeferred(convId, env); // 缺链 → 暂挂等 chaindist
    return "defer";
  }

  // msgKey 派生（先算不解、解密成功才提交——失败不留半推进状态）
  let keyB64: string;
  let advance: { ck: string; n: number; acc: Record<string, string> } | null = null;
  if (n >= chain.n) {
    if (n - chain.n > WINDOW) {
      pushDeferred(convId, env); // 超前超窗（>1000）→ 暂挂
      return "defer";
    }
    let ck = chain.ck;
    const acc: Record<string, string> = {};
    for (let i = chain.n; i <= n; i++) {
      const { msgKey, next } = await hkdfChain(ab(fromB64(ck)), MSG_LABEL);
      acc[i] = toB64(msgKey);
      ck = toB64(next);
    }
    keyB64 = acc[n];
    advance = { ck, n: n + 1, acc };
  } else {
    const cached = chain.msgKeys[String(n)];
    if (cached) {
      keyB64 = cached; // 窗口内乱序回退
    } else if (chain.n - n > WINDOW) {
      pushDeferred(convId, env); // 落后超窗（键已滚掉）→ 暂挂（重扫多半仍失败，上限兜底）
      return "defer";
    } else {
      pushDeferred(convId, env); // 键缺失（理论不可达）→ 暂挂
      return "defer";
    }
  }

  let plain: PlainEnvelope;
  try {
    if (outer.data === undefined || outer.nonce === undefined) throw new Error("bad cipher");
    const bytes = await decryptMsg(ab(fromB64(keyB64)), fromB64(outer.nonce), fromB64(outer.data), aadMsg(convId, chainKid, n));
    const parsed = JSON.parse(textDec.decode(bytes)) as PlainEnvelope;
    if (!parsed || typeof parsed !== "object" || typeof parsed.kind !== "string") throw new Error("bad plain");
    plain = parsed;
  } catch {
    throw new Error(DECRYPT_FAILED); // GCM/AAD 失败 = 永久性（键对但绑错会话/被篡改）
  }

  // 解密成功 → 提交链推进（含窗口 msgKey 缓存，保留最近 1000 个）
  if (advance) {
    const floor = advance.n - WINDOW;
    const kept: Record<string, string> = {};
    for (const [k, v] of Object.entries(chain.msgKeys)) {
      if (Number(k) >= floor) kept[k] = v;
    }
    chain.msgKeys = { ...kept, ...advance.acc };
    chain.ck = advance.ck;
    chain.n = advance.n;
    saveChains(convId, chains);
  }

  appendCache(conv, env, plain, cache);
  return plain;
}

/** chaindist 路径：X3DH 解封（外层公参 → 成对根密钥 → GCM）。 */
async function openX3dhDist(
  conv: { id: string; memberIdOf: (chainKid: string) => string | undefined },
  env: SealedEnvelope,
  outer: CipherOuter,
  cache: MsgCache,
): Promise<PlainEnvelope> {
  const identity = await loadIdentity();
  if (outer.to !== undefined && outer.to !== identity.kid) {
    throw new Error(NOT_FOR_DEVICE); // 定向给群内他设备的 chaindist（接线层先 isForMe 过滤）
  }
  if (outer.ek === undefined || outer.ik === undefined || outer.data === undefined || outer.nonce === undefined) {
    throw new Error(DECRYPT_FAILED);
  }
  let plain: PlainEnvelope;
  try {
    const rk = await x3dh({
      role: "responder",
      ikEcdh: identity.ikEcdh,
      ekPub: await importPub(outer.ek, []),
      spkPriv: identity.spkPriv,
      spkPub: await importPub(identity.spkPub, []), // 参数位必填（responder 分支不使用，语义=己方 SPK 公共分量）
      peerIK: await importPub(outer.ik, []),
    });
    const { msgKey } = await hkdfChain(rk, DIST_LABEL);
    const bytes = await decryptMsg(msgKey, fromB64(outer.nonce), fromB64(outer.data), aadDist(conv.id, outer.to ?? ""));
    const parsed = JSON.parse(textDec.decode(bytes)) as PlainEnvelope;
    if (!parsed || typeof parsed !== "object" || typeof parsed.kind !== "string") throw new Error("bad plain");
    plain = parsed;
  } catch {
    throw new Error(DECRYPT_FAILED);
  }
  if (plain.kind === "chaindist") {
    if (!plain.dist || typeof plain.dist.ck !== "string" || !Number.isInteger(plain.dist.n)) {
      throw new Error(DECRYPT_FAILED);
    }
    // dist 完整性：kid 必须是 ck 的指纹（防改写 kid 塞错链）
    if ((await chainKidOf(fromB64(plain.dist.ck))) !== plain.dist.kid) throw new Error(DECRYPT_FAILED);
  }
  appendCache(conv, env, plain, cache);
  return plain;
}

function appendCache(
  conv: { id: string; memberIdOf: (chainKid: string) => string | undefined },
  env: SealedEnvelope,
  plain: PlainEnvelope,
  cache: MsgCache,
): void {
  if (plain.kind === "chaindist") return; // 控制消息不进渲染缓存
  const senderId =
    env.senderId ?? (env.chainKid !== undefined ? conv.memberIdOf(env.chainKid) : undefined) ?? "unknown";
  const at = env.createdAt ? Date.parse(env.createdAt) || Date.now() : Date.now();
  cache.append(conv.id, { id: env.id, senderId, at, plain });
}

// —— handleChainDist ——

/**
 * 落链（chaindist 解开后调用）：
 * - 同 kid 幂等（已持有更靠前的接收状态，不回退）；
 * - 同发送者旧链键整体删除（前向保密——轮换后旧密文不可再解）；
 * - 落链后触发 deferred 重扫。
 */
export function handleChainDist(convId: string, from: string, dist: ChainDist): void {
  if (!dist || !dist.kid || typeof dist.ck !== "string" || !Number.isInteger(dist.n)) return;
  const chains = loadChains(convId);
  if (!chains.recv[dist.kid]) {
    for (const [kid, rec] of Object.entries(chains.recv)) {
      if (rec.from === from) delete chains.recv[kid]; // 旧链键删除（含其 msgKey 窗口）
    }
    chains.recv[dist.kid] = {
      kid: dist.kid,
      ck: dist.ck,
      n: dist.n,
      createdAt: dist.createdAt,
      from,
      msgKeys: {},
    };
    saveChains(convId, chains);
  }
  void sweepDeferred(convId); // 落链后重扫暂挂（并发合并见 sweepDeferred）
}

// —— sweepDeferred ——

const sweeps = new Map<string, Promise<number>>();

/**
 * 重扫暂挂队列：单次最多 5 条，解开/永久失败移除、仍缺链保留；
 * 有进展则继续下一轮（上限 50 条必然收敛）。并发调用合并到同一次扫描。
 */
export function sweepDeferred(convId: string): Promise<number> {
  const running = sweeps.get(convId);
  if (running) return running;
  let settle!: (n: number) => void;
  const merged = new Promise<number>((resolve) => {
    settle = resolve;
  });
  sweeps.set(convId, merged); // 先占位再跑：sweep 内 handleChainDist 再触发 sweep 时拿到同一 promise（不重入）
  doSweep(convId)
    .then((n) => {
      sweeps.delete(convId); // 先清占位再结算：结算回调里再调 sweepDeferred 应开新扫描而非拿旧 promise
      settle(n);
    })
    .catch(() => {
      sweeps.delete(convId);
      settle(0);
    });
  return merged;
}

async function doSweep(convId: string): Promise<number> {
  let opened = 0;
  const batch = loadDeferred(convId).slice(0, SWEEP_BATCH).map((e) => e.id);
  for (const id of batch) {
    // 每条处理前重读：避免覆盖并发入队的新条目（load→改→save 同步成段，无 await 交错）
    const env = loadDeferred(convId).find((e) => e.id === id);
    if (!env) continue;
    try {
      const chains = loadChains(convId);
      const r = await openMessage(
        {
          id: convId,
          memberIdOf: (kid) => chains.recv[kid]?.from, // 暂挂重开时从已存链推断发送者
        },
        env,
        cacheByConv.get(convId) ?? msgCache,
      );
      if (r === "defer") continue; // 仍缺链/超窗 → 留在队列
      saveDeferred(
        convId,
        loadDeferred(convId).filter((e) => e.id !== id),
      );
      opened += 1;
      if (r.kind === "chaindist" && r.dist) {
        // 暂挂里解出的链分发：链必须落否则后续永远缺链
        const from =
          env.senderId ??
          (env.chainKid !== undefined ? chains.recv[env.chainKid]?.from : undefined) ??
          "unknown";
        handleChainDist(convId, from, r.dist); // 内部 void sweep → 合并到当前扫描
      }
    } catch {
      // 永久失败（AAD 搬移/密钥失效）→ 移除，不许占满队列
      saveDeferred(
        convId,
        loadDeferred(convId).filter((e) => e.id !== id),
      );
    }
  }
  if (opened > 0) {
    const more = await doSweep(convId); // 有进展 → 继续（链到达可解开本批之外的条目）
    opened += more;
  }
  return opened;
}

// —— MsgCache（localStorage heming.msgCache.<convId>，截尾 500 条/会话）——

/** 默认明文缓存实现（jsdom/浏览器共用；测试与接线层直接引用同一实例）。 */
export const msgCache: MsgCache = {
  append(convId, m) {
    const key = MSGCACHE_PREFIX + convId;
    const list = readJson<CachedMsg[]>(key) ?? [];
    list.push(m);
    writeJson(key, list.length > CACHE_CAP ? list.slice(-CACHE_CAP) : list);
  },
  list(convId) {
    return readJson<CachedMsg[]>(MSGCACHE_PREFIX + convId) ?? [];
  },
};
