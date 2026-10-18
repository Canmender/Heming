/**
 * E2E 密码核心（纯函数，仅 WebCrypto，零新依赖）。
 * 规格：docs/superpowers/specs/2026-10-17-e2e-encryption-design.md
 *   §1 算法红线：P-256 ECDH + ECDSA、HKDF-SHA256、AES-256-GCM
 *   §3.1 设备身份与 X3DH 简化版（首版免 OPK）
 *   §3.2 会话棘轮：msgKey = HKDF(CK_n, "msg")，CK_{n+1} = HKDF(CK_n, "chain")
 */

export interface DeviceIdentity {
  ikEcdh: CryptoKey;
  ikSign: CryptoKey;
  kid: string;
}

export function hasSubtle(): boolean {
  return !!globalThis.crypto?.subtle;
}

export function toB64(buf: ArrayBuffer | Uint8Array): string {
  const bytes = buf instanceof Uint8Array ? buf : new Uint8Array(buf);
  let bin = "";
  for (let i = 0; i < bytes.length; i++) bin += String.fromCharCode(bytes[i]);
  return btoa(bin);
}

export function fromB64(s: string): Uint8Array {
  const bin = atob(s);
  const out = new Uint8Array(bin.length);
  for (let i = 0; i < bin.length; i++) out[i] = bin.charCodeAt(i);
  return out;
}

/** base64url（无填充）——kid 等指纹字段用 */
function toB64url(buf: ArrayBuffer): string {
  return toB64(buf).replace(/\+/g, "-").replace(/\//g, "_").replace(/=+$/, "");
}

function toArrayBuffer(u8: Uint8Array): ArrayBuffer {
  return u8.buffer.slice(u8.byteOffset, u8.byteOffset + u8.byteLength) as ArrayBuffer;
}

/**
 * 每设备身份：IK 的 ECDH 键（密钥协商）+ ECDSA 键（签名链，规格 §3.1 双键方案）。
 * 两字段存**私钥半边**（x3dh.ikEcdh / signPrekeyPayload 均按私钥使用）；
 * 发布公钥走 exportPub（支持私钥半边 → SPKI）。kid = ECDH 公钥 SPKI 的 sha256 base64url。
 */
export async function generateIdentity(): Promise<DeviceIdentity> {
  const ecdh = await crypto.subtle.generateKey({ name: "ECDH", namedCurve: "P-256" }, true, [
    "deriveBits",
  ]);
  const sign = await crypto.subtle.generateKey(
    { name: "ECDSA", namedCurve: "P-256" },
    true,
    ["sign", "verify"],
  );
  const spki = await crypto.subtle.exportKey("spki", ecdh.publicKey);
  const thumbprint = await crypto.subtle.digest("SHA-256", spki);
  return { ikEcdh: ecdh.privateKey, ikSign: sign.privateKey, kid: toB64url(thumbprint) };
}

export async function exportPub(k: CryptoKey): Promise<string> {
  let pub = k;
  if (k.type === "private") {
    // WebCrypto 禁止私钥直接导出 SPKI：经 JWK 取公有分量重建公钥（DeviceIdentity 存私钥半边）
    const jwk = await crypto.subtle.exportKey("jwk", k);
    const alg = k.algorithm as EcKeyAlgorithm;
    const pubJwk: JsonWebKey = { kty: jwk.kty, crv: jwk.crv, x: jwk.x, y: jwk.y };
    const usages: KeyUsage[] = alg.name === "ECDSA" ? ["verify"] : [];
    pub = await crypto.subtle.importKey(
      "jwk",
      pubJwk,
      { name: alg.name, namedCurve: alg.namedCurve },
      true,
      usages,
    );
  }
  return toB64(await crypto.subtle.exportKey("spki", pub));
}

export async function importPub(spki: string, usages: KeyUsage[]): Promise<CryptoKey> {
  // 注：W3C WebCrypto 下 ECDH 公钥 usages 为空集，调用方应传 []（传非空抛 DataError）
  return crypto.subtle.importKey("spki", toArrayBuffer(fromB64(spki)), { name: "ECDH", namedCurve: "P-256" }, true, usages);
}

export async function signPrekeyPayload(signKey: CryptoKey, pub: string): Promise<string> {
  const sig = await crypto.subtle.sign(
    { name: "ECDSA", hash: "SHA-256" },
    signKey,
    toArrayBuffer(fromB64(pub)),
  );
  return toB64(sig);
}

export async function verifyPrekey(signPub: CryptoKey, pub: string, sig: string): Promise<boolean> {
  return crypto.subtle.verify(
    { name: "ECDSA", hash: "SHA-256" },
    signPub,
    toArrayBuffer(fromB64(sig)),
    toArrayBuffer(fromB64(pub)),
  );
}

async function dh(priv: CryptoKey, pub: CryptoKey): Promise<ArrayBuffer> {
  return crypto.subtle.deriveBits({ name: "ECDH", public: pub }, priv, 256);
}

async function hkdf(ikm: ArrayBuffer, salt: BufferSource, info: string): Promise<ArrayBuffer> {
  const key = await crypto.subtle.importKey("raw", ikm, "HKDF", false, ["deriveBits"]);
  return crypto.subtle.deriveBits(
    { name: "HKDF", hash: "SHA-256", salt, info: new TextEncoder().encode(info) },
    key,
    256,
  );
}

/**
 * X3DH 简化（首版免 OPK，规格 §3.1：DH1=EK×IK, DH2=EK×SPK, DH3=SK×IK, DH4=SK×SPK）。
 * 双端对称公式（ECDH 可交换——双方各用「己方私钥 × 对方公钥」，四个 DH 逐一配对相等）：
 *
 *   DH1 = EK_initiator × IK_responder
 *   DH2 = EK_initiator × SPK_responder
 *   DH3 = IK_initiator × IK_responder      （SK = 发起方静态身份键）
 *   DH4 = IK_initiator × SPK_responder
 *   OPK 预留（规格裁定首版砍掉）：opkPub 字段保留签名兼容，不参与计算；
 *   将来启用时在四者之后追加 DH5 = EK_initiator × OPK_responder，双端同序拼接。
 *
 *   initiator：DH1=dh(ekPriv,peerIK) DH2=dh(ekPriv,spkPub) DH3=dh(ikEcdh,peerIK) DH4=dh(ikEcdh,spkPub)
 *   responder：DH1=dh(ikEcdh,ekPub)  DH2=dh(spkPriv,ekPub) DH3=dh(ikEcdh,peerIK) DH4=dh(spkPriv,peerIK)
 *
 *   RK = HKDF-SHA256(ikm = DH1||DH2||DH3||DH4, salt = ∅, info = "heming.x3dh.v1", 256bit)
 */
export async function x3dh(params: {
  role: "initiator" | "responder";
  ikEcdh: CryptoKey;
  ekPub?: CryptoKey;
  ekPriv?: CryptoKey;
  peerIK: CryptoKey;
  spkPub: CryptoKey;
  spkPriv?: CryptoKey;
  opkPub?: CryptoKey;
}): Promise<ArrayBuffer> {
  const { role, ikEcdh, ekPub, ekPriv, peerIK, spkPub, spkPriv } = params;
  let dhs: ArrayBuffer[];
  if (role === "initiator") {
    if (!ekPriv) throw new Error("x3dh initiator 缺 ekPriv");
    dhs = [
      await dh(ekPriv, peerIK),
      await dh(ekPriv, spkPub),
      await dh(ikEcdh, peerIK),
      await dh(ikEcdh, spkPub),
    ];
  } else {
    if (!ekPub || !spkPriv) throw new Error("x3dh responder 缺 ekPub/spkPriv");
    dhs = [
      await dh(ikEcdh, ekPub),
      await dh(spkPriv, ekPub),
      await dh(ikEcdh, peerIK),
      await dh(spkPriv, peerIK),
    ];
  }
  const ikm = new Uint8Array(32 * dhs.length);
  dhs.forEach((d, i) => ikm.set(new Uint8Array(d), i * 32));
  return hkdf(toArrayBuffer(ikm), new ArrayBuffer(0), "heming.x3dh.v1");
}

/**
 * 链键推进（规格 §3.2）：msgKey 与 next 各用不同 info label 派生（单向、互不相等）；
 * label 是命名空间——会话链与 agent chunk 链走不同 label 防交叉派生。
 */
export async function hkdfChain(
  chainKey: ArrayBuffer,
  label: string,
): Promise<{ next: ArrayBuffer; msgKey: ArrayBuffer }> {
  const [msgKey, next] = await Promise.all([
    hkdf(chainKey, chainKey, `${label}:msg`),
    hkdf(chainKey, chainKey, `${label}:chain`),
  ]);
  return { next, msgKey };
}

/** AES-256-GCM 加密 → base64 密文（含 GCM tag）；aad 绑定信封字段防搬移 */
export async function encryptMsg(
  msgKey: ArrayBuffer,
  nonce12: Uint8Array,
  plaintext: Uint8Array,
  aad: Uint8Array,
): Promise<string> {
  const key = await crypto.subtle.importKey("raw", msgKey, { name: "AES-GCM" }, false, ["encrypt"]);
  const cipher = await crypto.subtle.encrypt(
    { name: "AES-GCM", iv: toArrayBuffer(nonce12), additionalData: toArrayBuffer(aad) },
    key,
    toArrayBuffer(plaintext),
  );
  return toB64(cipher);
}

/** 解密失败（密钥错/aad 改）→ WebCrypto 抛 OperationError，调用方按「无法解密」占位处理 */
export async function decryptMsg(
  msgKey: ArrayBuffer,
  nonce12: Uint8Array,
  cipher: Uint8Array,
  aad: Uint8Array,
): Promise<Uint8Array> {
  const key = await crypto.subtle.importKey("raw", msgKey, { name: "AES-GCM" }, false, ["decrypt"]);
  const plain = await crypto.subtle.decrypt(
    { name: "AES-GCM", iv: toArrayBuffer(nonce12), additionalData: toArrayBuffer(aad) },
    key,
    toArrayBuffer(cipher),
  );
  return new Uint8Array(plain);
}
