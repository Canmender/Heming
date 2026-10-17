import { describe, it, expect } from "vitest";
import {
  hasSubtle,
  toB64,
  fromB64,
  generateIdentity,
  exportPub,
  importPub,
  signPrekeyPayload,
  verifyPrekey,
  x3dh,
  hkdfChain,
  encryptMsg,
  decryptMsg,
} from "./e2eCrypto.js";

function hex(buf: ArrayBuffer | Uint8Array): string {
  const bytes = buf instanceof Uint8Array ? buf : new Uint8Array(buf);
  let s = "";
  for (let i = 0; i < bytes.length; i++) s += bytes[i].toString(16).padStart(2, "0");
  return s;
}

function bytes(seed: number, len: number): Uint8Array {
  const out = new Uint8Array(len);
  for (let i = 0; i < len; i++) out[i] = (seed + i) & 0xff;
  return out;
}

function toArrayBuffer(u8: Uint8Array): ArrayBuffer {
  return u8.buffer.slice(u8.byteOffset, u8.byteOffset + u8.byteLength) as ArrayBuffer;
}

describe("hkdfChain", () => {
  // 固定 32B 链键 0x00..0x1f；期望值由 node:crypto hkdfSync 独立算出（非本实现自产）
  const chainKey = toArrayBuffer(bytes(0, 32));

  it("确定性：固定输入 → 固定向量输出，跑两次同值", async () => {
    const a = await hkdfChain(chainKey, "test");
    const b = await hkdfChain(chainKey, "test");
    expect(hex(a.msgKey)).toBe("175b493d24edd9dd90c8650d02253db6ff1e846aee0f25eda5086d424a5456d6");
    expect(hex(a.next)).toBe("ce66b0d79edbd2c8e189eea1423b0f46866c8773857566cfde4fcd86368d266f");
    expect(hex(b.msgKey)).toBe(hex(a.msgKey));
    expect(hex(b.next)).toBe(hex(a.next));
  });

  it("单向性：next ≠ msgKey 且两者都不等于原链键（无法原样复用）", async () => {
    const { next, msgKey } = await hkdfChain(chainKey, "test");
    expect(hex(next)).not.toBe(hex(msgKey));
    expect(hex(next)).not.toBe(hex(chainKey));
    expect(hex(msgKey)).not.toBe(hex(chainKey));
  });

  it("label 命名空间隔离：不同 label → 不同派生（agent chunk 走独立命名空间）", async () => {
    const a = await hkdfChain(chainKey, "test");
    const b = await hkdfChain(chainKey, "agent");
    expect(hex(b.msgKey)).not.toBe(hex(a.msgKey));
    expect(hex(b.next)).not.toBe(hex(a.next));
  });
});

describe("encryptMsg/decryptMsg", () => {
  const msgKey = toArrayBuffer(bytes(7, 32));
  const nonce12 = bytes(3, 12);
  const plain = new TextEncoder().encode("和鸣 E2E 往返");
  const aad = new TextEncoder().encode("conv-1|msg-9");

  it("往返：encryptMsg → base64 → decryptMsg 还原原文", async () => {
    const b64 = await encryptMsg(msgKey, nonce12, plain, aad);
    expect(typeof b64).toBe("string");
    const pt = await decryptMsg(msgKey, nonce12, fromB64(b64), aad);
    expect(new TextDecoder().decode(pt)).toBe("和鸣 E2E 往返");
  });

  it("AAD 篡改一位 → 解密拒绝（防信封搬移）", async () => {
    const cipher = fromB64(await encryptMsg(msgKey, nonce12, plain, aad));
    const badAad = Uint8Array.from(aad);
    badAad[0] ^= 1;
    await expect(decryptMsg(msgKey, nonce12, cipher, badAad)).rejects.toThrow();
  });

  it("toB64/fromB64：256 字节随机模式往返无损", () => {
    const b = bytes(9, 256);
    expect(hex(fromB64(toB64(b)))).toBe(hex(b));
  });
});

describe("身份与预配对签名", () => {
  // DeviceIdentity 存私钥半边；验证公钥经 JWK 公有分量重建（发布路径同 exportPub）
  const ecdsaVerifyPubOf = async (priv: CryptoKey): Promise<CryptoKey> => {
    const jwk = await crypto.subtle.exportKey("jwk", priv);
    return crypto.subtle.importKey(
      "jwk",
      { kty: jwk.kty, crv: jwk.crv, x: jwk.x, y: jwk.y },
      { name: "ECDSA", namedCurve: "P-256" },
      true,
      ["verify"],
    );
  };

  it("generateIdentity：kid 为 ECDH SPKI sha256 的 base64url（43 字符格式），可复验", async () => {
    const id = await generateIdentity();
    expect(id.kid).toMatch(/^[A-Za-z0-9_-]{43}$/);
    const spki = fromB64(await exportPub(id.ikEcdh)); // 私钥半边 → SPKI 公钥路径
    const digest = await crypto.subtle.digest("SHA-256", toArrayBuffer(spki));
    const expectKid = toB64(digest).replace(/\+/g, "-").replace(/\//g, "_").replace(/=+$/, "");
    expect(id.kid).toBe(expectKid);
  });

  it("exportPub/importPub：SPKI base64 往返（含身份私钥半边发布路径）", async () => {
    const id = await generateIdentity();
    const pubB64 = await exportPub(id.ikEcdh);
    const imported = await importPub(pubB64, []);
    expect(await exportPub(imported)).toBe(pubB64);
  });

  it("signPrekeyPayload/verifyPrekey：往返 true；篡改签名或换签名公钥 → false", async () => {
    const id = await generateIdentity();
    const spk = await crypto.subtle.generateKey({ name: "ECDH", namedCurve: "P-256" }, true, [
      "deriveBits",
    ]);
    const spkB64 = await exportPub(spk.publicKey);
    const signPub = await ecdsaVerifyPubOf(id.ikSign);
    const sig = await signPrekeyPayload(id.ikSign, spkB64); // ikSign = 私钥半边
    expect(await verifyPrekey(signPub, spkB64, sig)).toBe(true);

    const sigBytes = fromB64(sig);
    sigBytes[0] ^= 1;
    expect(await verifyPrekey(signPub, spkB64, toB64(sigBytes))).toBe(false);

    const other = await generateIdentity();
    expect(await verifyPrekey(await ecdsaVerifyPubOf(other.ikSign), spkB64, sig)).toBe(false);
  });
});

describe("X3DH 简化（固定 P-256 测试向量，首版免 OPK）", () => {
  // 硬编码测试密钥（仅测试向量；根密钥期望值由 node:crypto 独立算出）
  const IKaPriv = {
    kty: "EC", crv: "P-256",
    x: "Y2n-ECIk99cy8XqSSq8tVsnS5mv91KTWg-3hV1VT9ns",
    y: "rabWvvAUsdDr9UeYa_ry6DSDiombx_PyJqX8E4VCn0M",
    d: "4Yx2PvUGTULhcNod3mxr16OtsocpzU8ekvwFGRDRlVc",
  };
  const IKaPub = { kty: "EC", crv: "P-256", x: IKaPriv.x, y: IKaPriv.y };
  const IKbPriv = {
    kty: "EC", crv: "P-256",
    x: "tpN9FFOfl9U8_9y3I0kEhepfXrieBa6s04m4TvnqwL0",
    y: "24dmy2ILWS2yuwv5F5hVNjptVCH7O0pApHHkp7xROXw",
    d: "NlWFUjMXKF8zPOQWBZcCrBF-T8wVjOhAior6UUJCLFY",
  };
  const IKbPub = { kty: "EC", crv: "P-256", x: IKbPriv.x, y: IKbPriv.y };
  const SPKbPriv = {
    kty: "EC", crv: "P-256",
    x: "Vn8ugEl0kUnUcVlN-TgvfFUbnVh7gxkLdpxpRKrY-OY",
    y: "3cSG2b46g_KWxJZ81Cgdms2cpBPXJ479C3k0vpzzifg",
    d: "htm-c7Up5bdC6yZeYwhEiOGJ15I8MJLgVk9LCGQk3oY",
  };
  const SPKbPub = { kty: "EC", crv: "P-256", x: SPKbPriv.x, y: SPKbPriv.y };
  const EKPriv = {
    kty: "EC", crv: "P-256",
    x: "6_xgI27WW3JU3jtHR6dC5zltqflu7T1MsLBJqdsbCnc",
    y: "NDBJirzoWm9L8pk6Yw7DDkumd9MFBIc8MwCqxtn88fc",
    d: "a__twuI6HnkQFjXIFiRhIstyS0VTKJPcykz9sdn7pv4",
  };
  const EKPub = { kty: "EC", crv: "P-256", x: EKPriv.x, y: EKPriv.y };

  const importPriv = (jwk: JsonWebKey) =>
    crypto.subtle.importKey("jwk", jwk, { name: "ECDH", namedCurve: "P-256" }, true, ["deriveBits"]);
  const importPubJwk = (jwk: JsonWebKey) =>
    crypto.subtle.importKey("jwk", jwk, { name: "ECDH", namedCurve: "P-256" }, true, []);

  it("initiator/responder 两路产出同根密钥（hex 锁定独立向量）", async () => {
    const initRoot = await x3dh({
      role: "initiator",
      ikEcdh: await importPriv(IKaPriv),
      ekPriv: await importPriv(EKPriv),
      peerIK: await importPubJwk(IKbPub),
      spkPub: await importPubJwk(SPKbPub),
    });
    const respRoot = await x3dh({
      role: "responder",
      ikEcdh: await importPriv(IKbPriv),
      spkPriv: await importPriv(SPKbPriv),
      ekPub: await importPubJwk(EKPub),
      peerIK: await importPubJwk(IKaPub),
      spkPub: await importPubJwk(SPKbPub),
    });
    const EXPECT =
      "2200fa6a6a0f9b083ee9c8bff9e9e2bb3e5505a7519d866b1b7635259e3b8588";
    expect(hex(initRoot)).toBe(EXPECT);
    expect(hex(respRoot)).toBe(EXPECT);
  });

  it("确定性：同参数重算根密钥不变", async () => {
    const init = {
      role: "initiator" as const,
      ikEcdh: await importPriv(IKaPriv),
      ekPriv: await importPriv(EKPriv),
      peerIK: await importPubJwk(IKbPub),
      spkPub: await importPubJwk(SPKbPub),
    };
    expect(hex(await x3dh(init))).toBe(hex(await x3dh(init)));
  });

  it("缺己方私钥参数 → 抛错（不静默产出不完整 DH 组合）", async () => {
    await expect(
      x3dh({
        role: "initiator",
        ikEcdh: await importPriv(IKaPriv),
        peerIK: await importPubJwk(IKbPub),
        spkPub: await importPubJwk(SPKbPub),
      }),
    ).rejects.toThrow("ekPriv");
    await expect(
      x3dh({
        role: "responder",
        ikEcdh: await importPriv(IKbPriv),
        ekPub: await importPubJwk(EKPub),
        peerIK: await importPubJwk(IKaPub),
        spkPub: await importPubJwk(SPKbPub),
      }),
    ).rejects.toThrow("spkPriv");
  });
});

describe("hasSubtle", () => {
  it("test-setup 注入 node webcrypto 后为 true", () => {
    expect(hasSubtle()).toBe(true);
  });
});
