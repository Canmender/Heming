/**
 * E2E 会话层：链管理、封解密、乱序暂挂与本地明文缓存。
 * 规格：docs/superpowers/specs/2026-10-17-e2e-encryption-design.md §3.2/§5/§6。
 *
 * - 密码原语一律 import ./e2eCrypto.js（X3DH/hkdfChain/GCM，Task 1 已评审），本文件禁止重实现。
 * - 纯逻辑 + E2eDeps 注入（fetchPeerKeys/sendRaw/now），测试不碰真实网络。
 * - 持久化全在 localStorage（密钥不出设备、无备份无恢复）：
 *     heming.e2e.identity              设备身份（IK 双键 JWK + 签名预键 SPK）——d.36 起走安全存储
 *     heming.e2e.chains.<convId>       会话链：我的发送链 + 收到的对端链（P0-5b 起有桥时整值信封）
 *     heming.msgCache.<convId>         解密后消息缓存（截尾 500 条/会话；P0-5b 起有桥时逐条密文容器）
 *     heming.e2e.deferred.<convId>     缺链/超窗暂挂信封（上限 50 条，内容已是 E2E 密文，不加密）
 *
 * 加密口径（P0-5b）：桌面桥可用 → chains 走 d.36 信封 + 写入自校验、msgCache 走 v2 容器
 * 逐条密文；浏览器（无桥）→ 两者都保持明文，行为与 P0-5b 之前**逐字等价**。
 *
 * 链分发（chaindist）走 X3DH 成对封装（§3.2「用对方 §3.1 会话加密」）：
 * 外层公参 ek/ik/to（服务端可见的引导材料），内层 GCM 密文装 {kind:"chaindist", dist}；
 * 归属由 outer.ik 解密认证（不信 env.senderId），按认证设备定位/删链（多设备不互删），
 * 每设备记最后接受分发的新鲜度拒旧重放，正文按 (chainKid,n) 去重拒同会话重放。
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
import { secureGetItem, secureSetItem, secureBridge, secureSetItemVerified, readSecureValue, backupRawOnce, markSecureUndecryptable, onSecureHydrated, PLAINTEXT_BACKUP_SUFFIX, UNDECRYPTABLE_BACKUP_SUFFIX } from "./secureStorage.js";
import {
  MIGRATE_BATCH,
  decodeEntries,
  decodeEnvelopeItems,
  decodeEntry,
  encodeCacheContainer,
  encryptEntry,
  findEntryById,
  isMsgCacheAuxKey,
  migratePlainEntries,
  parseCacheRaw,
  toPlainEntries,
  truncateEntries,
  type EntryCrypto,
  type RawEntry,
} from "./e2e/cacheEnvelope.js";

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

/** 密文内 JSON（§3.3）：kind 判别 + 各类载荷；chaindist 携带 dist 链材料。
 *  mentions 随正文进密文（§3.3「payload/replyTo/mentions 全进密文」）；
 *  kind="chunk" 为 agent 流式增量（§5.3，AAD 绑定 streamId+index，不落明文缓存）。 */
export interface PlainEnvelope {
  kind: "text" | "file" | "forward" | "reaction" | "chaindist" | "chunk" | "error";
  text?: string;
  file?: { id: string; name: string; mime: string; size: number; key?: string };
  forward?: { from: string; source: string };
  reaction?: { target: string; emoji: string; op: "add" | "remove" };
  mentions?: { agentId: string; name: string }[];
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
  /** 只读缓存视图：不触碰 LRU、不写盘、不淘汰任何会话（列表预览用）。 */
  peek(convId: string): CachedMsg[];
  /** 按消息 id 删一条（撤回时清明文，防止预览回显已撤回正文）；不触碰 LRU、不淘汰。 */
  remove(convId: string, msgId: string): void;
  list(convId: string): CachedMsg[];
  /**
   * 按消息 id 定点取一条明文（P0-5b：有桥时只解这一条，不做全量解密）。
   * 语义等价于 `list(convId).find((m) => m.id === msgId) ?? null`；无桥时就是这条路径。
   */
  get(convId: string, msgId: string): CachedMsg | null;
}

/**
 * openMessage 结果：明文 / "defer"（缺链超窗，已入暂挂队列）/
 * "duplicate"（(chainKid,n) 已解开过——同会话密文重放，调用方忽略，不落缓存）。
 */
export type OpenResult = PlainEnvelope | "defer" | "duplicate";

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
  /** 认证发送设备标识（identity kid，由 outer.ik 解密认证得出——非 env.senderId） */
  from?: string;
  msgKeys: Record<string, string>; // 乱序窗口内已缓存的 msgKey（key 为 n）
  opened?: Record<string, true>; // 已成功解开的 (chainKid,n)——密文重放去重
}

interface ChainsFile {
  send?: SendChain;
  recv: Record<string, RecvChain>;
  /** 每认证发送设备最后接受的 chaindist 新鲜度（防旧分发重放回滚接收链） */
  lastDist?: Record<string, { ct: number; kid: string }>;
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

/**
 * 身份键走 secure 层（凭据，d.36）；chains 走 secure 层的 verified 写（P0-5b），
 * deferred/lru 仍是普通 readJson 路径（内容已是 E2E 密文或纯元数据，不加密）。
 */
function readSecureJson<T>(key: string): T | null {
  const raw = secureGetItem(key);
  if (raw === null) return null;
  try {
    return JSON.parse(raw) as T;
  } catch {
    return null;
  }
}

function writeSecureJson(key: string, value: unknown): void {
  secureSetItem(key, JSON.stringify(value));
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

// —— 链状态持久化（P0-5b P1：有桥 → d.36 整值信封 + 写入自校验；无桥 → 明文，行为不变）——

interface ChainsViewEntry {
  raw: string | null;
  file: ChainsFile;
}

/**
 * 链状态内存视图（同 `cacheView` 的 raw 比对模式）：key → {raw, file}。
 *
 * 为什么必须有：`loadChains` 在收发的每条消息上被调用（open/seal/dist/sweep），
 * 有桥时每次从信封解密 = 每条消息多一次 sendSync + DPAPI；raw 不变时直接复用已解开的对象，
 * 把读侧解密次数降到 0（设计稿 §2.1 M8）。
 */
const chainsView = new Map<string, ChainsViewEntry>();

/** 测试隔离：清掉链状态内存视图，强制下次从磁盘重读。 */
export function resetChainsView(): void {
  chainsView.clear();
}

function readRaw(key: string): string | null {
  try {
    return localStorage.getItem(key);
  } catch {
    return null; // 隐私模式/存储异常：当作不存在，不打断收发
  }
}

/** 链状态不可读：置标记（设置区可见）并留一条可诊断日志；密文/原文原样留在磁盘上。 */
function markChainsUnreadable(key: string, reason: string): void {
  markSecureUndecryptable(key);
  console.warn(`[e2e] 链状态无法读取（${reason}），磁盘数据已保留，本次按空链继续：${key}`);
}

/** 解析链状态明文 JSON；坏 JSON 先原样备份再按空链继续（绝不让后续 save 静默覆盖原始数据）。 */
function parseChainsValue(key: string, raw: string, source: "plain" | "envelope"): { file: ChainsFile; ok: boolean } {
  try {
    const parsed = JSON.parse(raw) as ChainsFile;
    if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) throw new Error("bad shape");
    if (!parsed.recv || typeof parsed.recv !== "object" || Array.isArray(parsed.recv)) parsed.recv = {};
    return { file: parsed, ok: true };
  } catch {
    if (source === "plain") backupRawOnce(key, raw, UNDECRYPTABLE_BACKUP_SUFFIX);
    markChainsUnreadable(key, "bad-json");
    return { file: { recv: {} }, ok: false };
  }
}

function loadChains(convId: string): ChainsFile {
  const key = CHAINS_PREFIX + convId;
  const raw = readRaw(key);
  const hit = chainsView.get(key);
  if (hit && hit.raw === raw) return hit.file;

  let file: ChainsFile = { recv: {} };
  if (raw !== null) {
    const read = readSecureValue(key);
    if (read.kind === "plain") {
      const parsed = parseChainsValue(key, read.raw, "plain");
      file = parsed.file;
      // 首读懒迁移：**先确认可解析**再加密（坏数据不包成密文，避免把垃圾锁进信封）。
      if (parsed.ok && secureBridge()) {
        const write = secureSetItemVerified(key, read.raw);
        logChainsWrite(key, write);
      }
    } else if (read.kind === "envelope") {
      file = parseChainsValue(key, read.value, "envelope").file;
    } else if (read.kind === "unreadable") {
      // readSecureValue 已置 undecryptableKeys：不静默当空链，但仍返回空链让收发继续（fail-open）。
      markChainsUnreadable(key, read.reason);
    }
  }
  chainsView.set(key, { raw: readRaw(key), file });
  return file;
}

/** 链写入降级/失败的统一可诊断日志（不抛给用户；设置区靠 plaintextKeys/undecryptableKeys 点名）。 */
function logChainsWrite(key: string, write: ReturnType<typeof secureSetItemVerified>): void {
  if (write.reason === "verify-failed" || write.reason === "encrypt-failed") {
    // 自校验失败：不写坏密文，fail-open 写明文新值（不回退旧盘值——回退会复用 msgKey）。
    console.warn(`[e2e] 链状态加密自校验失败（${write.reason}），已 fail-open 按明文保存新值：${key}`);
  } else if (write.reason === "quota") {
    console.warn(`[e2e] 链状态因配额降级为明文（未加密）：${key}`);
  } else if (!write.ok) {
    console.warn(`[e2e] 链状态未能落盘（${write.reason}），内存态继续可用：${key}`);
  }
}

function saveChains(convId: string, file: ChainsFile): void {
  const key = CHAINS_PREFIX + convId;
  const value = JSON.stringify(file);
  if (!secureBridge()) {
    // 浏览器（无桥）：逐字保持今天的明文写盘路径（writeJson 内部 JSON.stringify 对象）。
    writeJson(key, file);
  } else {
    logChainsWrite(key, secureSetItemVerified(key, value));
  }
  // 写失败时磁盘仍是旧值，但链状态是**单调推进**的：内存视图必须指向新值，
  // 否则下一次 load 会复用已用过的 msgKey（比明文降级更危险）。下一次写入会再试。
  chainsView.set(key, { raw: readRaw(key), file });
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

/**
 * agent 流式 chunk 的 AAD（设计 §5.3：AAD=convId+streamId+index）：
 * 与正文 AAD（convId|chainKid|n）不同命名空间——把 chunk 密文搬进正文位、
 * 或调换流/片序，收端按事件里的 streamId/index 开封即 GCM 拒。
 */
export function chunkAad(convId: string, streamId: string, index: number): Uint8Array {
  return utf8(`${AAD_PREFIX}|${convId}|chunk|${streamId}|${index}`);
}

/**
 * agent_error 信封的 AAD（fix I2）：与 chunk 同款「会话+流」上下文绑定，独立 error
 * 命名空间——错误与片互换密文时 GCM 拒（每 stream 恰一条错误，无 index 位）。
 */
export function errorAad(convId: string, streamId: string): Uint8Array {
  return utf8(`${AAD_PREFIX}|${convId}|error|${streamId}`);
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

/**
 * 身份生成 in-flight 去重（fix I1）：并发 ensureIdentity（ChatPage 挂载时 initSession 与
 * 公钥上云 exportOwnDeviceKeys 在同一同步块触发）共享同一生成 promise——否则首启
 * （localStorage 无身份）会生成两套身份，落盘者与上云者错配（对端 X3DH 永久解不开、
 * distFor 已标记不重发）。
 */
let identityInFlight: Promise<StoredIdentity> | null = null;

/**
 * 身份 kid 缓存：key 为原始存储值。
 *
 * `isForMe` 在**每个入站信封**（含流式 chunk）上被调用；直接走 secure 层会让每片
 * chunk 都过一次 sendSync + DPAPI 解密——那是热路径。原始值不变时复用已算出的 kid；
 * 身份被替换（测试快照 / 重新生成）时 raw 变化，缓存自然失效。
 */
let identityKidCache: { raw: string; kid: string | null } | null = null;

function identityKidFor(raw: string): string | null {
  if (identityKidCache && identityKidCache.raw === raw) return identityKidCache.kid;
  const stored = readSecureJson<StoredIdentity>(IDENTITY_KEY);
  const kid = stored?.kid ?? null;
  identityKidCache = { raw, kid };
  return kid;
}

async function ensureIdentity(): Promise<StoredIdentity> {
  const existing = readSecureJson<StoredIdentity>(IDENTITY_KEY);
  if (existing?.kid && existing.spk?.pub) return existing;
  if (identityInFlight) return identityInFlight; // 并发首启：共享同一生成
  // 生成/载入身份：IK 双键（ECDH 协商 + ECDSA 签名链）+ 签名预键 SPK（§3.1）
  const gen = (async () => {
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
    writeSecureJson(IDENTITY_KEY, stored);
    identityKidCache = { raw: localStorage.getItem(IDENTITY_KEY) ?? "", kid: stored.kid };
    return stored;
  })();
  identityInFlight = gen;
  try {
    return await gen;
  } finally {
    // 失败清位可重试；成功后由 localStorage 命中（并发者已共享同一 promise）
    if (identityInFlight === gen) identityInFlight = null;
  }
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
    const raw = localStorage.getItem(IDENTITY_KEY); // 只读原始值：廉价，不过 IPC
    if (!raw) return false;
    return identityKidFor(raw) === outer.to;
  } catch {
    // cipher 损坏（无法解析）：无法判定定向——返回 true 交 openMessage 判定
    // （坏密文 → e2e_decrypt_failed → 接线层按「无法解密」占位，而非静默丢弃；Minor）
    return true;
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

/** 同会话 seal 串行化：链文件 load→改→save 跨 await 交错会撞 n（同 n 密文 → 收端去重误杀）。 */
const sealLocks = new Map<string, Promise<void>>();

/**
 * 封一条密文消息 → send_message{enc:"e2e"} 事件。
 * 无链/新成员 → 先经 sendRaw 分发 chaindist（X3DH 成对封装），再封正文；
 * n>=100 或 now()-createdAt>24h → 轮换新链（旧链键随覆盖删除，前向保密）。
 * opts.aad 覆盖正文 AAD（agent chunk 用 chunkAad——同链推进、不同绑定上下文）。
 * 同会话并发调用按到达序串行（chunk/finish/正文/重加密共用一条发送链，必须排队）。
 */
export function sealMessage(
  conv: { id: string; members: string[] },
  plain: PlainEnvelope,
  deps: E2eDeps,
  opts?: { aad?: Uint8Array },
): Promise<WsClientEvent> {
  const prev = sealLocks.get(conv.id) ?? Promise.resolve();
  const run = prev.then(
    () => doSealMessage(conv, plain, deps, opts),
    () => doSealMessage(conv, plain, deps, opts),
  );
  const tracked: Promise<void> = run.then(
    () => undefined,
    () => undefined,
  );
  sealLocks.set(conv.id, tracked);
  void tracked.then(() => {
    if (sealLocks.get(conv.id) === tracked) sealLocks.delete(conv.id);
  });
  return run;
}

async function doSealMessage(
  conv: { id: string; members: string[] },
  plain: PlainEnvelope,
  deps: E2eDeps,
  opts?: { aad?: Uint8Array },
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
  const aad = opts?.aad ?? aadMsg(conv.id, send.kid, send.n);
  const data = await encryptMsg(msgKey, nonce, utf8(JSON.stringify(plain)), aad);
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
 * - chaindist（外层带 ek）→ X3DH 解封，**解密上下文内自动落链**（归属=outer.ik 认证出的
 *   发送设备，不信 env.senderId），返回 {kind:"chaindist", dist}；
 * - 正文 → 发送链 msgKey 解密并写明文缓存；已解开过的 (chainKid,n) → "duplicate"；
 * - 缺链/超窗 → 入暂挂队列（上限 50）并返回 "defer"（opts.noDefer 则只返回不入队——
 *   agent chunk 走此路：流式增量不占暂挂队列）；
 * - GCM 校验失败（AAD 被搬移/密钥错）→ 抛错（接线层渲染「无法解密」占位）。
 * opts.aad 覆盖正文解密 AAD（与 sealMessage 的 opts.aad 成对，chunk 用 chunkAad）。
 */
export async function openMessage(
  conv: { id: string; memberIdOf: (chainKid: string) => string | undefined },
  env: SealedEnvelope,
  cache: MsgCache,
  opts?: { aad?: Uint8Array; noDefer?: boolean },
): Promise<OpenResult> {
  cacheByConv.set(conv.id, cache);
  if (!env.cipher) throw new Error(DECRYPT_FAILED);
  let outer: CipherOuter;
  try {
    outer = parseOuter(env.cipher);
  } catch {
    throw new Error(DECRYPT_FAILED);
  }
  if (outer.ek !== undefined) return openX3dhDist(conv, env, outer, cache);
  return openChainMsg(conv, env, outer, cache, opts);
}

/** 正文路径：发送链查键 → 去重 → msgKey 派生 → GCM 解密 → 提交链状态 → 落缓存。 */
async function openChainMsg(
  conv: { id: string; memberIdOf: (chainKid: string) => string | undefined },
  env: SealedEnvelope,
  outer: CipherOuter,
  cache: MsgCache,
  opts?: { aad?: Uint8Array; noDefer?: boolean },
): Promise<OpenResult> {
  const { chainKid, n } = env;
  const convId = conv.id;
  /** 暂挂（noDefer 时只返回不入队——chunk 缺链等链到达后由调用方重试，不占 50 条上限）。 */
  const defer = (): OpenResult => {
    if (!opts?.noDefer) pushDeferred(convId, env);
    return "defer";
  };
  if (!chainKid || n === undefined) {
    return defer(); // 形状不全（缺链索引）→ 暂挂，元数据到达后重扫可解
  }
  const chains = loadChains(convId);
  const chain = chains.recv[chainKid];
  if (!chain) {
    return defer(); // 缺链 → 暂挂等 chaindist
  }
  if (chain.opened?.[String(n)]) return "duplicate"; // (chainKid,n) 已解开过——同会话重放拒收

  // msgKey 派生（先算不解、解密成功才提交——失败不留半推进状态）
  let keyB64: string;
  let advance: { ck: string; n: number; acc: Record<string, string> } | null = null;
  if (n >= chain.n) {
    if (n - chain.n > WINDOW) {
      return defer(); // 超前超窗（>1000）→ 暂挂
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
      return defer(); // 落后超窗（键已滚掉）→ 暂挂（重扫多半仍失败，上限兜底）
    } else {
      return defer(); // 键缺失（理论不可达）→ 暂挂
    }
  }

  let plain: PlainEnvelope;
  try {
    if (outer.data === undefined || outer.nonce === undefined) throw new Error("bad cipher");
    const aad = opts?.aad ?? aadMsg(convId, chainKid, n);
    const bytes = await decryptMsg(ab(fromB64(keyB64)), fromB64(outer.nonce), fromB64(outer.data), aad);
    const parsed = JSON.parse(textDec.decode(bytes)) as PlainEnvelope;
    if (!parsed || typeof parsed !== "object" || typeof parsed.kind !== "string") throw new Error("bad plain");
    plain = parsed;
  } catch {
    throw new Error(DECRYPT_FAILED); // GCM/AAD 失败 = 永久性（键对但绑错会话/被篡改）
  }

  // 解密成功 → 提交链推进（含窗口 msgKey 缓存，保留最近 1000 个）并记 (chainKid,n) 已解开
  if (advance) {
    const floor = advance.n - WINDOW;
    const kept: Record<string, string> = {};
    for (const [k, v] of Object.entries(chain.msgKeys)) {
      if (Number(k) >= floor) kept[k] = v;
    }
    chain.msgKeys = { ...kept, ...advance.acc };
    chain.ck = advance.ck;
    chain.n = advance.n;
  }
  // 去重标记与 msgKey 窗口同窗修剪（落后超窗的重放自然落回 defer 分支）
  {
    const floor = chain.n - WINDOW;
    const opened = chain.opened ?? {};
    if (advance) {
      for (const k of Object.keys(opened)) {
        if (Number(k) < floor) delete opened[k];
      }
    }
    opened[String(n)] = true;
    chain.opened = opened;
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
    // 归属 = 解密认证出的发送设备：outer.ik 参与 X3DH 的 DH3/DH4，GCM 能解开 ⟺
    // 发送方确持该 IK 私钥（换 ik 改不了密文，伪造者算不出同一 RK）——不信 env.senderId（服务端可伪造）。
    const senderDev = await kidOfSpki(outer.ik);
    handleChainDist(conv.id, senderDev, plain.dist);
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
  if (plain.kind === "chaindist" || plain.kind === "chunk") return; // 控制消息与流式增量不进渲染缓存
  const senderId =
    env.senderId ?? (env.chainKid !== undefined ? conv.memberIdOf(env.chainKid) : undefined) ?? "unknown";
  const at = env.createdAt ? Date.parse(env.createdAt) || Date.now() : Date.now();
  cache.append(conv.id, { id: env.id, senderId, at, plain });
}

// —— handleChainDist ——

/**
 * 落链（chaindist 解开后由 openMessage 自动调用；手工调用时 from 必须是**认证发送设备
 * 标识**（identity kid），禁止传 env.senderId——服务端可伪造归属）：
 * - 同 kid 幂等（已持有更靠前的接收状态，不回退）；
 * - **新鲜度（I1）**：每个认证发送设备记录最后接受分发的 (createdAt, kid)；旧于已知链的
 *   分发（重放/过期乱序）直接丢弃——否则重放旧 chaindist 会删掉新链、回滚到旧链，
 *   后续新链消息最长 24h 解不开且 deferred 溢出丢真消息。双端约定：dist.createdAt 为
 *   链创建时刻（发送端 deps.now 单调），严格小于已知值即拒绝；同刻不同 kid 亦拒。
 * - 同发送设备旧链键整体删除（前向保密——按**设备**定位而非 userId，多设备不互删）；
 * - 落链后触发 deferred 重扫。
 */
export function handleChainDist(convId: string, from: string, dist: ChainDist): void {
  if (
    !dist ||
    !dist.kid ||
    typeof dist.ck !== "string" ||
    !Number.isInteger(dist.n) ||
    !Number.isFinite(dist.createdAt)
  ) {
    return;
  }
  const chains = loadChains(convId);
  if (chains.recv[dist.kid]) return; // 幂等：同链已在（含更靠前索引），不回退
  const last = chains.lastDist?.[from];
  if (last && (dist.createdAt < last.ct || (dist.createdAt === last.ct && dist.kid !== last.kid))) {
    return; // 旧分发重放/同刻异链 → 丢弃，不改任何状态
  }
  for (const [kid, rec] of Object.entries(chains.recv)) {
    if (rec.from === from) delete chains.recv[kid]; // 同认证设备旧链键删除（含其 msgKey/opened 窗口）
  }
  chains.recv[dist.kid] = {
    kid: dist.kid,
    ck: dist.ck,
    n: dist.n,
    createdAt: dist.createdAt,
    from,
    msgKeys: {},
  };
  chains.lastDist = { ...(chains.lastDist ?? {}), [from]: { ct: dist.createdAt, kid: dist.kid } };
  saveChains(convId, chains);
  void sweepDeferred(convId); // 落链后重扫暂挂（并发合并见 sweepDeferred）
}

/** 接收链归属（chainKid → 认证发送设备 id）——测试与诊断可观测。 */
export function recvChainOwners(convId: string): Record<string, string> {
  const out: Record<string, string> = {};
  for (const [kid, rec] of Object.entries(loadChains(convId).recv)) {
    if (rec.from !== undefined) out[kid] = rec.from;
  }
  return out;
}

// —— sweepDeferred ——

const sweeps = new Map<string, Promise<number>>();

/**
 * 重扫暂挂队列：单次最多 5 条，解开/"duplicate"/永久失败移除、仍缺链保留；
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
      // 成功 / "duplicate"（重放）/ chaindist（openMessage 内已落链）都移出队列，算进展
      saveDeferred(
        convId,
        loadDeferred(convId).filter((e) => e.id !== id),
      );
      opened += 1;
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

/**
 * 进程内明文缓存视图（fix I3）：key → {raw, parsed}。list 只在 raw 字符串变化时重新
 * JSON.parse（接收路径每个信封都 list，全量 parse 是热路径浪费）；append 写盘后同步
 * 刷新视图。外部直接改/清 localStorage（测试 setup 常见）经 raw 比对自动失效。
 * 返回的数组是缓存视图，调用方**只读**（本模块是唯一写入口）。
 */
const cacheView = new Map<string, CacheViewEntry>();

/** 进程内视图：磁盘条目 + 已解明文（`messages === null` 表示尚未解码）。 */
interface CacheViewEntry {
  raw: string | null;
  /** 磁盘条目：密文条目原样保留（含解不开的），重写时带回磁盘，绝不静默丢。 */
  entries: RawEntry[];
  /** 已解出的明文视图；null = 尚未解码（append 冷启动不为此解全量）。 */
  messages: CachedMsg[] | null;
  /** 解不开的条目 id（诊断用；条目本身仍留在 `entries` 里）。 */
  unreadableIds: string[];
  /** 磁盘外壳：决定无桥时回写哪种形态（无桥必须保持旧明文数组）。 */
  shape: "empty" | "plaintext" | "container";
}

/** 消息缓存未加密/降级的可见原因（Q1/Q2：界面要如实标注，不能假装加密）。 */
export type MsgCacheEncryptionReason =
  | "no-bridge"
  | "unavailable"
  | "encrypt-failed"
  | "quota"
  | "unreadable"
  | "backup-failed"
  /** 有桌面桥但磁盘上还是旧明文数组/明文条目，等读侧懒迁移。 */
  | "pending-migration";

/** 磁盘上消息缓存的形态（与「能不能解开」分开报，界面才不会把「已加密但本机解不开」说成未加密）。 */
export type MsgCacheStorageForm = "encrypted" | "plaintext" | "unreadable" | "absent";

export interface MsgCacheEncryptionState {
  /** 是否存在桌面桥（浏览器 false）。 */
  desktop: boolean;
  /** 桌面桥是否报告系统安全存储可用。 */
  available: boolean;
  /** 磁盘形态：密文容器/信封 = encrypted；旧明文数组 = plaintext；坏数据/无桥读不了 = unreadable。 */
  form: MsgCacheStorageForm;
  /** 磁盘上是**可读的**密文形态（`form === "encrypted"` 且能解密）。 */
  encrypted: boolean;
  /** 未加密/降级/待迁移原因。 */
  reason?: MsgCacheEncryptionReason;
}

const cacheEncryptionIssues = new Map<string, MsgCacheEncryptionReason>();

/**
 * 某会话消息缓存的落盘状态（供设置区/存储水位卡如实标注，**不谎报已加密**）。
 *
 * @param raw 该键的原始值（可选）。UI 统计时已在同一次 `getItem` 里拿到值，
 *            传进来可避免再读一遍；不传则现读 localStorage。
 *
 * 状态判定（照设计稿 §4.4 的三态）：
 * - 容器 / 整值信封 → 密文形态；桥不可用时是「无法解密」而不是「未加密」；
 * - 明文数组 → 未加密（无桥 / 安全存储不可用 / 待迁移 / 最近一次写入降级）；
 * - 坏 JSON / 未知版本 → 无法解密（原始数据已备份）。
 */
export function msgCacheEncryptionState(convId: string, raw?: string | null): MsgCacheEncryptionState {
  const b = secureBridge();
  const desktop = !!b;
  const available = !!b && b.available === true;
  const diskRaw = raw === undefined ? readRaw(MSGCACHE_PREFIX + convId) : raw;
  const shape = parseCacheRaw(diskRaw);
  const form: MsgCacheStorageForm =
    shape.kind === "empty"
      ? "absent"
      : shape.kind === "plain"
        ? "plaintext"
        : shape.kind === "foreign"
          ? "unreadable"
          : "encrypted";

  const tracked = cacheEncryptionIssues.get(convId);
  let reason = tracked;
  let encrypted = form === "encrypted";
  if (form === "unreadable") {
    reason = "unreadable";
    encrypted = false;
  } else if (form === "plaintext") {
    encrypted = false;
    // 最近一次写入的降级原因优先（配额/加密失败/备份失败），否则按能力推断。
    reason = tracked ?? (!desktop ? "no-bridge" : !available ? "unavailable" : "pending-migration");
  } else if (form === "encrypted" && !available) {
    // 磁盘是密文但本机没有可用密钥（换设备/换系统账户/桥不可用）：能加密，但读不了。
    reason = "unreadable";
    encrypted = false;
  }
  return { desktop, available, form, encrypted, reason };
}

/**
 * 本机所有会话消息缓存的状态（供存储水位卡逐会话标注）。
 *
 * @param raws 可选：键 → 原始值（来自同一次统计遍历）。不传则现读 localStorage。
 *
 * 只按**键名**枚举会话，不解析明文；辅助键（备份/账本）不参与。
 */
export function msgCacheEncryptionStates(
  raws?: ReadonlyMap<string, string | null>,
): Array<{ convId: string; state: MsgCacheEncryptionState }> {
  const keys = raws ? [...raws.keys()] : listMsgCacheKeys();
  const out: Array<{ convId: string; state: MsgCacheEncryptionState }> = [];
  for (const key of keys) {
    if (!key.startsWith(MSGCACHE_PREFIX) || key === MSG_CACHE_LRU_KEY || isMsgCacheAuxKey(key)) continue;
    const convId = key.slice(MSGCACHE_PREFIX.length);
    const raw = raws ? (raws.get(key) ?? null) : undefined;
    out.push({ convId, state: msgCacheEncryptionState(convId, raw) });
  }
  // 稳定顺序：按会话 id 排，避免每次渲染行序抖动（测试与界面都好对）。
  out.sort((a, b) => (a.convId < b.convId ? -1 : a.convId > b.convId ? 1 : 0));
  return out;
}

/** 测试隔离：清掉消息缓存的内存视图与降级标记（不动 localStorage）。 */
export function resetMsgCacheState(): void {
  cacheView.clear();
  cacheEncryptionIssues.clear();
}

function noteCacheIssue(convId: string, reason: MsgCacheEncryptionReason): void {
  cacheEncryptionIssues.set(convId, reason);
}

/** 当前可用的逐条加解密能力；无桥 / 桥报不可用 → null（走明文路径，浏览器行为不变）。 */
function cacheCrypto(): EntryCrypto | null {
  const b = secureBridge();
  if (!b || b.available !== true) return null;
  return { encrypt: (plain) => b.encrypt(plain), decrypt: (cipherB64) => b.decrypt(cipherB64) };
}

/** 解整份视图（list/peek 才付这个成本；`get` 走定点解密）。 */
function materializeMessages(view: CacheViewEntry, crypto: EntryCrypto | null): CachedMsg[] {
  if (view.messages !== null) return view.messages;
  if (crypto) {
    const decoded = decodeEntries(view.entries, crypto);
    view.messages = decoded.messages;
    view.unreadableIds = decoded.unreadableIds;
  } else {
    // 无密钥时只有迁移期明文条目可读；密文条目跳过并原样留在 entries 里（不删、不覆盖）。
    const messages: CachedMsg[] = [];
    const unreadableIds: string[] = [];
    for (const entry of view.entries) {
      if ("m" in entry) messages.push(entry.m);
      else unreadableIds.push(entry.id);
    }
    view.messages = messages;
    view.unreadableIds = unreadableIds;
  }
  return view.messages;
}

/**
 * 回写整份视图（**所有 msgCache 写路径的唯一入口**，保证 load→改→save 在一个同步块里）。
 *
 * 迁移非破坏性（需求 3）：只要会用密文容器覆盖「含明文」的旧值，先写
 * `<键>.__heming_plaintext_backup`（幂等、只保留第一份）；备份失败就不覆盖旧值。
 * 配额不足（Q2）：退回明文数组、**不截短、不删消息**，只如实标记「未加密」。
 */
function writeCacheView(
  convId: string,
  view: CacheViewEntry,
  entries: RawEntry[],
  messages: CachedMsg[] | null,
  issue?: MsgCacheEncryptionReason,
): CacheViewEntry {
  const key = MSGCACHE_PREFIX + convId;
  const crypto = cacheCrypto();
  // 无桥且磁盘原本是容器：继续写容器（密文条目原样保留，不因无密钥而丢）。
  const useContainer = crypto !== null || view.shape === "container";
  const nextRaw = useContainer ? encodeCacheContainer(entries) : JSON.stringify(messages ?? []);
  const unreadableIds = view.unreadableIds.filter((id) => entries.some((e) => e.id === id));

  const hadPlaintext =
    view.raw !== null && (view.shape === "plaintext" || view.entries.some((e) => "m" in e));
  if (useContainer && hadPlaintext) {
    if (!backupRawOnce(key, view.raw!, PLAINTEXT_BACKUP_SUFFIX)) {
      // 备份失败：旧明文一个字节都不动，内存保留新值，等下一轮再迁（迁移可重试）。
      noteCacheIssue(convId, "backup-failed");
      return { ...view, entries, messages, unreadableIds };
    }
  }

  try {
    localStorage.setItem(key, nextRaw);
    if (issue) noteCacheIssue(convId, issue);
    else cacheEncryptionIssues.delete(convId);
    return { raw: nextRaw, entries, messages, unreadableIds, shape: useContainer ? "container" : "plaintext" };
  } catch {
    // 配额：Q2 决定「保持明文、不截短缓存」。**有桥时**容器写不进就先退回明文数组（明文更小），
    // 兜底会丢掉解不开的密文条目，所以覆盖前先把旧 raw 原样备份，绝不静默销毁。
    // 无桥（拿不到明文）时不做这个兜底：写明文数组等于把还在的密文条目清空，只保留内存新值。
    if (useContainer && crypto) {
      const fallbackMessages = messages ?? decodeEntries(entries, crypto).messages;
      const backedUp = view.raw === null || backupRawOnce(key, view.raw, UNDECRYPTABLE_BACKUP_SUFFIX);
      if (backedUp) {
        try {
          const fallbackRaw = JSON.stringify(fallbackMessages);
          localStorage.setItem(key, fallbackRaw);
          noteCacheIssue(convId, "quota");
          return {
            raw: fallbackRaw,
            entries: toPlainEntries(fallbackMessages),
            messages: fallbackMessages,
            unreadableIds: [],
            shape: "plaintext",
          };
        } catch {
          /* 明文也写不进：见下，磁盘保持旧值 */
        }
      }
    }
    // 仍写不进：磁盘保持旧值，内存保留新值（未落盘），只做可见标记。
    noteCacheIssue(convId, "quota");
    return { ...view, entries, messages, unreadableIds };
  }
}

function readCacheView(convId: string): CacheViewEntry {
  const key = MSGCACHE_PREFIX + convId;
  const raw = readRaw(key);
  const hit = cacheView.get(key);
  if (hit && hit.raw === raw) return hit;

  const crypto = cacheCrypto();
  const shape = parseCacheRaw(raw);
  let view: CacheViewEntry;
  if (shape.kind === "empty") {
    view = { raw: null, entries: [], messages: [], unreadableIds: [], shape: "empty" };
  } else if (shape.kind === "plain") {
    // 旧明文（本次读仍按明文返回；有桥时下面立刻迁一批密的）。
    view = {
      raw,
      entries: toPlainEntries(shape.items),
      messages: shape.items,
      unreadableIds: [],
      shape: "plaintext",
    };
  } else if (shape.kind === "container") {
    view = { raw, entries: shape.entries, messages: null, unreadableIds: [], shape: "container" };
  } else if (shape.kind === "envelope") {
    // 兼容壳：整值信封解密后按明文条目处理，下次写盘升级为 v2 容器。
    const items = crypto ? decodeEnvelopeItems(shape.data, crypto) : null;
    if (items) {
      view = {
        raw,
        entries: toPlainEntries(items),
        messages: items,
        unreadableIds: [],
        shape: "plaintext",
      };
    } else {
      if (raw !== null) backupRawOnce(key, raw, UNDECRYPTABLE_BACKUP_SUFFIX);
      noteCacheIssue(convId, "unreadable");
      view = { raw, entries: [], messages: [], unreadableIds: [], shape: "empty" };
    }
  } else {
    // foreign（坏 JSON / 未知版本 / 结构不合法）：保留原始数据、返回空，绝不 throw。
    if (raw !== null) {
      backupRawOnce(key, raw, UNDECRYPTABLE_BACKUP_SUFFIX);
      markSecureUndecryptable(key);
      console.warn(`[e2e] 消息缓存无法识别（已原样备份），本次按空缓存继续：${key}`);
    }
    noteCacheIssue(convId, "unreadable");
    view = { raw, entries: [], messages: [], unreadableIds: [], shape: "empty" };
  }

  cacheView.set(key, view);
  return view;
}

/**
 * 读侧懒迁移（设计稿 §4.2「打开会话读到明文条目 → 每批 ≤50 条」）。
 *
 * 只由 `list`（全量读）与显式入口 `migrateMsgCache` 触发，**不在 append/get 里做**：
 * 前者要保证「append 一条只加密一条」（M1），后者要保证冷读按 id 只解一条（M2）。
 * 返回迁移后的视图；无桥 / 无可迁条目时原样返回。
 */
function maybeMigrateCache(convId: string, view: CacheViewEntry): CacheViewEntry {
  const crypto = cacheCrypto();
  if (!crypto || !view.entries.some((e) => "m" in e)) return view;
  const migrated = migratePlainEntries(view.entries, crypto, MIGRATE_BATCH);
  let next = view;
  if (migrated.migrated > 0) {
    next = writeCacheView(convId, view, migrated.entries, view.messages, undefined);
  }
  if (migrated.failed > 0) noteCacheIssue(convId, "encrypt-failed");
  if (next !== view) cacheView.set(MSGCACHE_PREFIX + convId, next);
  return next;
}

/**
 * 显式触发一次读侧迁移（≤`MIGRATE_BATCH` 条/次），返回本批迁成功的条数。
 *
 * 集成期若把 ChatPage 的 `list().find()` 全换成 `get()`，打开会话处应调一次本函数
 * （或保留一次 `list`），否则明文条目会留到 P3 全量清理阶段才迁。
 */
export function migrateMsgCache(convId: string): number {
  const view = readCacheView(convId);
  const pending = (v: CacheViewEntry) => v.entries.filter((e) => "m" in e).length;
  const before = pending(view);
  const next = maybeMigrateCache(convId, view);
  return before - pending(next);
}

/** 全量扫描迁移的结果（P3 兜底：给启动日志/诊断用，不渲染到界面）。 */
export interface MsgCacheMigrationSummary {
  /** 扫到的会话数（只统计真实存在的缓存键）。 */
  conversations: number;
  /** 本批迁成密文的条目数。 */
  migrated: number;
  /** 加密失败（fail-open 保留明文）的条目数。 */
  failed: number;
  /** 扫完仍在明文形态的条目数（等于 0 才算「全量迁完」）。 */
  remainingPlaintext: number;
}

/**
 * P0-5b P3 · msgCache 明文全量扫描兜底。
 *
 * 读侧懒迁移（`list` / `migrateMsgCache`）只覆盖「用户真的打开过的会话」；
 * 没打开过的会话里的旧明文条目会一直躺在磁盘上。启动 hydrate 完成后跑一遍本函数，
 * 把所有 `heming.msgCache.*` 逐会话迁到 v2 容器（每批 ≤`MIGRATE_BATCH` 条）。
 *
 * 幂等：已是密文的条目原样跳过（`migratePlainEntries` 保证绝不二次加密）；
 * 加密失败保留明文并标记 `encrypt-failed`（fail-open，绝不丢消息）；
 * 每会话最多跑 `maxBatchesPerConversation` 批，避免会话极多时拖慢启动
 * （剩下的下一次启动继续迁，进度单调推进）。
 */
export function migrateAllMsgCaches(maxBatchesPerConversation = 20): MsgCacheMigrationSummary {
  const summary: MsgCacheMigrationSummary = {
    conversations: 0,
    migrated: 0,
    failed: 0,
    remainingPlaintext: 0,
  };
  const crypto = cacheCrypto();
  if (!crypto) return summary; // 无桥/不可用：保持明文，等可用时再迁

  for (const key of listMsgCacheKeys()) {
    const convId = key.slice(MSGCACHE_PREFIX.length);
    let view = readCacheView(convId);
    let migrated = 0;
    let failed = 0;
    for (let batchIndex = 0; batchIndex < maxBatchesPerConversation; batchIndex += 1) {
      if (!view.entries.some((entry) => "m" in entry)) break;
      const batch = migratePlainEntries(view.entries, crypto, MIGRATE_BATCH);
      failed += batch.failed;
      if (batch.migrated === 0) break;
      view = writeCacheView(convId, view, batch.entries, view.messages, undefined);
      cacheView.set(MSGCACHE_PREFIX + convId, view);
      migrated += batch.migrated;
      if (batch.migrated < MIGRATE_BATCH) break;
    }
    if (failed > 0) noteCacheIssue(convId, "encrypt-failed");
    summary.conversations += 1;
    summary.migrated += migrated;
    summary.failed += failed;
    summary.remainingPlaintext += view.entries.filter((entry) => "m" in entry).length;
  }
  return summary;
}

/**
 * 默认消息缓存实现（jsdom/浏览器共用；测试与接线层直接引用同一实例）。
 *
 * 有桥：v2 容器 + 逐条密文；无桥：旧明文数组（**逐字等价，行为零变化**）。
 */
export const msgCache: MsgCache = {
  append(convId, m) {
    const view = readCacheView(convId);
    const crypto = cacheCrypto();
    let entry: RawEntry;
    let issue: MsgCacheEncryptionReason | undefined;
    if (crypto) {
      // 只加密**新增这一条**；已有条目保持原密文不重加密（O(1)，M1/M8）。
      const encrypted = encryptEntry(m, crypto);
      entry = encrypted.entry;
      if (!encrypted.ok) issue = "encrypt-failed"; // fail-open：这条以明文条目落盘并可见标记
    } else {
      entry = { id: m.id, m };
      issue = secureBridge() ? "unavailable" : "no-bridge";
    }
    const entries = truncateEntries([...view.entries, entry], CACHE_CAP);
    const keptIds = new Set(entries.map((e) => e.id));
    let messages: CachedMsg[] | null = null;
    if (view.messages !== null) {
      // 视图已解码时同步刷新（不重解）；否则保持 null，下一次 list/peek 再解。
      messages = [...view.messages.filter((x) => keptIds.has(x.id)), m].slice(-CACHE_CAP);
    }
    const nextView = writeCacheView(convId, view, entries, messages, issue);
    cacheView.set(MSGCACHE_PREFIX + convId, nextView);
    // 往某会话写 ⇒ 它在用。写盘是低频路径（每来一条消息一次），顺手把账本落盘。
    touchCacheConversation(convId, true);
  },
  peek(convId) {
    // 只读：列表预览会随每次 render/输入调用，不能借读刷 LRU（那会写盘、
    // 账本超 20 时还会淘汰别的会话的缓存）。
    const view = readCacheView(convId);
    return materializeMessages(view, cacheCrypto());
  },
  remove(convId, msgId) {
    // 撤回是「这条内容不该再出现在本机」：只删这一条，不刷 LRU、不淘汰别的会话。
    const view = readCacheView(convId);
    if (!view.entries.some((e) => e.id === msgId)) return;
    const entries = view.entries.filter((e) => e.id !== msgId);
    const messages = view.messages === null ? null : view.messages.filter((m) => m.id !== msgId);
    const issue = cacheCrypto() ? undefined : secureBridge() ? "unavailable" : "no-bridge";
    const nextView = writeCacheView(convId, view, entries, messages, issue);
    cacheView.set(MSGCACHE_PREFIX + convId, nextView);
  },
  list(convId) {
    // 「这个会话被看了」——但 list 是热路径（接收路径每个信封都 list），
    // 每次都写 localStorage 等于每解一个信封写一次盘。所以这里只更新内存账本，
    // 落盘走 60s 节流（`touchCacheConversation` 内部）。
    touchCacheConversation(convId, false);
    // 全量读是设计稿指定的迁移时机（「打开会话读到明文条目」，≤50 条/批）。
    const view = maybeMigrateCache(convId, readCacheView(convId));
    return materializeMessages(view, cacheCrypto());
  },
  get(convId, msgId) {
    // 定点解密：视图未解码时只解命中的这一条（M2：冷读不解全量）。
    touchCacheConversation(convId, false); // 「按 id 取」也算看过这个会话（60s 节流，不写盘）
    const view = readCacheView(convId);
    if (view.messages !== null) {
      const hit = view.messages.find((m) => m.id === msgId);
      if (hit) return hit;
    }
    const entry = findEntryById(view.entries, msgId);
    if (!entry) return null;
    if ("m" in entry) return entry.m; // 迁移期明文条目：直接可读
    const crypto = cacheCrypto();
    if (!crypto) return null;
    const decoded = decodeEntry(entry, crypto);
    return decoded.ok ? decoded.msg : null;
  },
};

// —— MsgCache 的会话数上限（d.31 · P1-1 ②）——

/**
 * 明文缓存保留的**会话数**上限。
 *
 * `CACHE_CAP` 管的是「每会话多少条」，但会话数原本不设上限 ⇒ N 个会话就是 N × 500 条，
 * 这是全仓最大的无上限块，超配额时表现为「解密过的消息渲染不出来」。
 *
 * 为什么是 20：覆盖绝大多数人的活跃范围；再多是拿存储换不来体验的。
 */
export const MAX_CACHE_CONVERSATIONS = 20;

/** LRU 账本的键：convId → 最后使用时间（毫秒）。 */
export const MSG_CACHE_LRU_KEY = "heming.msgCache.lru.v1";

/** 内存账本（懒加载；`null` = 还没读过盘）。 */
let cacheLru: Record<string, number> | null = null;
/** 上次把账本写盘的时间：`list` 是热路径，不能每次 touch 都写。 */
let cacheLruPersistedAt = 0;
/** `list` 触发的账本落盘节流窗口。 */
const LRU_PERSIST_INTERVAL_MS = 60_000;

/**
 * 列出当前实际存在的消息缓存键。
 *
 * 排除：账本键自身（它也以 `heming.msgCache.` 开头）+ 迁移/不可解密备份等辅助键。
 * 辅助键（`<键>.__heming_plaintext_backup` / `.__heming_undecryptable`）若不排除，
 * 会被当成「一个会话」污染 LRU、并可能被 `dropCachedConversation` 误删（设计稿 §4.7）。
 */
function listMsgCacheKeys(): string[] {
  const out: string[] = [];
  try {
    for (let i = 0; i < localStorage.length; i += 1) {
      const key = localStorage.key(i);
      if (key && key.startsWith(MSGCACHE_PREFIX) && key !== MSG_CACHE_LRU_KEY && !isMsgCacheAuxKey(key)) {
        out.push(key);
      }
    }
  } catch {
    /* 隐私模式：列不出来就当没有 */
  }
  return out;
}

/** 读账本：坏 JSON / 形状不符 → 空表；账本缺失时用**现有的缓存键**重建。 */
function loadCacheLru(): Record<string, number> {
  if (cacheLru) return cacheLru;
  const stored = readJson<unknown>(MSG_CACHE_LRU_KEY);
  const lru: Record<string, number> = {};
  if (stored && typeof stored === "object" && !Array.isArray(stored)) {
    for (const [convId, at] of Object.entries(stored as Record<string, unknown>)) {
      if (typeof at === "number" && Number.isFinite(at) && at >= 0) lru[convId] = at;
    }
  }
  if (Object.keys(lru).length === 0) {
    // 老用户没有这个键（或被清过）：用当前已有的缓存键重建，时间统一记 0（最旧），
    // 保证它们之后能被正常淘汰，而不是永远不进候选。
    for (const key of listMsgCacheKeys()) lru[key.slice(MSGCACHE_PREFIX.length)] = 0;
  }
  cacheLru = lru;
  return lru;
}

/** 删掉某会话的消息缓存（连同进程内视图），不动账本；备份键不在这里删（P3 清理）。 */
function dropCachedConversation(convId: string): void {
  const key = MSGCACHE_PREFIX + convId;
  try {
    localStorage.removeItem(key);
  } catch {
    /* 删不掉也只能这样 */
  }
  cacheView.delete(key);
  cacheEncryptionIssues.delete(convId);
}

/**
 * 记一次使用并做 LRU 淘汰。
 *
 * @param forcePersist 是否立刻把账本写盘。`append` 传 true（低频），`list` 传 false（热路径，走节流）。
 */
function touchCacheConversation(convId: string, forcePersist: boolean): void {
  const lru = loadCacheLru();
  // 先清掉账本里的**陈旧项**：缓存键已经不存在（别处清过/上次淘汰过），
  // 留着它们会白占名额，把真正还在用的会话挤掉。
  for (const id of Object.keys(lru)) {
    if (id !== convId && !hasCachedConversation(id)) delete lru[id];
  }
  lru[convId] = Date.now();

  const ids = Object.keys(lru);
  if (ids.length > MAX_CACHE_CONVERSATIONS) {
    // 淘汰最久未使用的；刚被 touch 的这个永远不在候选里。
    const victims = ids
      .filter((id) => id !== convId)
      .sort((a, b) => lru[a] - lru[b])
      .slice(0, ids.length - MAX_CACHE_CONVERSATIONS);
    for (const id of victims) {
      delete lru[id];
      dropCachedConversation(id);
    }
  }

  const now = Date.now();
  if (forcePersist || now - cacheLruPersistedAt >= LRU_PERSIST_INTERVAL_MS) {
    cacheLruPersistedAt = now;
    writeJson(MSG_CACHE_LRU_KEY, lru);
  }
}

/** 某会话的缓存键是否存在（只查键，不解析值）。 */
function hasCachedConversation(convId: string): boolean {
  try {
    return localStorage.getItem(MSGCACHE_PREFIX + convId) !== null;
  } catch {
    return false;
  }
}

/** 测试隔离：清掉内存账本，让下一次访问重新读盘。 */
export function resetMsgCacheLru(): void {
  cacheLru = null;
  cacheLruPersistedAt = 0;
}

// —— P0-5b P3 兜底：hydrate 完成后全量迁一次 msgCache 明文（未打开过的会话也迁）——
// 注册在模块层：`main.tsx` 的 `hydrateSecureStorage()` 完成后触发；无桥/不可用时跳过，
// 明文原样保留（绝不因迁移失败丢消息），下一次可用时继续。
onSecureHydrated((state) => {
  if (!state.available) return;
  try {
    migrateAllMsgCaches();
  } catch {
    /* 全量迁移失败不影响启动 */
  }
});