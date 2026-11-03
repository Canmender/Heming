import type { PluginManifest } from "./manifest.js";
import { canonicalJsonText } from "./integrity.js";
import type { StorageLike } from "../skills/index.js";

/**
 * 插件签名与发布者信任（d.67，TOFU 模型）。
 *
 * 设计边界，必须先读：
 * - 这里**没有 PKI / 证书链 / 联网取公钥**。发布者只是一个自带的 Ed25519 公钥；
 *   用户首次安装时确认「我信任这个发布者 id 的这把公钥」，之后同 id 换钥必须显式复核。
 * - 签名能证明「清单内容确实由这把私钥的持有者签过、且签名后没被改」，
 *   但**不证明发布者是谁**：任何人都能自造一对密钥并自称 `acme`。
 *   要证明身份需要公开 CA / 分发链 / 吊销机制，本轮不做（见规格 §5 红线）。
 * - 验签失败**绝不放行**；环境不支持（无 WebCrypto/无 Ed25519）如实报 `unsupported`，
 *   不假装验过。
 */

/** 发布者信任记录（TOFU）的存储键。 */
export const PUBLISHERS_KEY = "heming.plugin.publishers.v1";

export type SignatureStatus = "none" | "valid" | "invalid" | "unsupported";

export interface SignatureCheck {
  status: SignatureStatus;
  /** 失败/不支持时的人读原因（成功时无）。 */
  reason?: string;
}

/** 已信任发布者：公钥原文 + 指纹（`sha256:…`），换钥判定用公钥原文比对。 */
export interface PublisherRecord {
  id: string;
  publicKey: string;
  fingerprint: string;
}

interface PublisherData {
  version: 1;
  publishers: Record<string, PublisherRecord>;
}

/** 规范化签名文本：与内容指纹同款排序，但**包含 publisher、排除 signature**。 */
export function signedManifestText(manifest: PluginManifest): string {
  return canonicalJsonText({
    id: manifest.id,
    version: manifest.version,
    name: manifest.name,
    description: manifest.description,
    author: manifest.author,
    publisher: manifest.publisher ?? null,
    permissions: manifest.permissions,
    contributions: manifest.contributions,
  });
}

function decodeBase64Url(value: string): Uint8Array<ArrayBuffer> {
  const normalized = value.replace(/-/g, "+").replace(/_/g, "/");
  const padded = normalized + "=".repeat((4 - (normalized.length % 4)) % 4);
  const binary = atob(padded);
  const bytes = new Uint8Array(binary.length);
  for (let i = 0; i < binary.length; i += 1) bytes[i] = binary.charCodeAt(i);
  return bytes;
}

function encodeBase64Url(bytes: Uint8Array): string {
  let binary = "";
  for (const byte of bytes) binary += String.fromCharCode(byte);
  return btoa(binary).replace(/\+/g, "-").replace(/\//g, "_").replace(/=+$/, "");
}

function subtleCrypto(): SubtleCrypto | null {
  const cryptoApi = globalThis.crypto;
  if (!cryptoApi || typeof cryptoApi.subtle === "undefined") return null;
  return cryptoApi.subtle;
}

function isUnsupportedError(error: unknown): boolean {
  if (!error || typeof error !== "object") return false;
  const name = (error as { name?: unknown }).name;
  const message = (error as { message?: unknown }).message;
  if (name === "NotSupportedError" || name === "NotImplementedError") return true;
  return typeof message === "string" && /not supported|unsupported|unrecognized|unknown algorithm/i.test(message);
}

/**
 * 验签：`none` 未签名 / `valid` 有效 / `invalid` 不匹配 / `unsupported` 环境不支持。
 *
 * 只做纯校验，不写任何存储；信任记录由安装流程决定（见 `PublisherTrustStore`）。
 */
export async function verifyManifestSignature(manifest: PluginManifest): Promise<SignatureCheck> {
  if (!manifest.signature) return { status: "none" };
  const publisher = manifest.publisher;
  if (!publisher) {
    return { status: "invalid", reason: "有签名但缺少发布者公钥，无法验签" };
  }
  if (manifest.signature.alg !== "ed25519") {
    return { status: "unsupported", reason: `不支持的签名算法：${String(manifest.signature.alg)}` };
  }

  let publicKeyBytes: Uint8Array<ArrayBuffer>;
  let signatureBytes: Uint8Array<ArrayBuffer>;
  try {
    publicKeyBytes = decodeBase64Url(publisher.publicKey);
    signatureBytes = decodeBase64Url(manifest.signature.value);
  } catch {
    return { status: "invalid", reason: "发布者公钥或签名值不是合法的 base64url" };
  }
  if (publicKeyBytes.length !== 32) {
    return { status: "invalid", reason: "发布者公钥长度不是 32 字节（Ed25519 raw 公钥）" };
  }
  if (signatureBytes.length !== 64) {
    return { status: "invalid", reason: "签名值长度不是 64 字节（Ed25519 签名）" };
  }

  const subtle = subtleCrypto();
  if (!subtle) {
    return { status: "unsupported", reason: "当前环境不支持 WebCrypto，无法验签（不代表签名有效）" };
  }

  try {
    // DOM lib 的类型定义跟不上 Ed25519 的普及速度，这里按 WebCrypto 规范传算法名；
    // 运行时能力检测在 `subtleCrypto()` 与 catch 分支里完成，不靠类型。
    const algorithm = { name: "Ed25519" } as unknown as AlgorithmIdentifier;
    const key = await subtle.importKey("raw", publicKeyBytes, algorithm, false, ["verify"]);
    const data = new TextEncoder().encode(signedManifestText(manifest));
    const valid = await subtle.verify(
      { name: "Ed25519" } as unknown as AlgorithmIdentifier,
      key,
      signatureBytes,
      data,
    );
    return valid
      ? { status: "valid" }
      : {
          status: "invalid",
          reason: "签名与清单内容不匹配（内容可能被修改，或签名不是这把公钥签的）",
        };
  } catch (error) {
    if (isUnsupportedError(error)) {
      const detail = error instanceof Error ? error.message : String(error);
      return { status: "unsupported", reason: `当前环境不支持 Ed25519 验签：${detail}` };
    }
    const detail = error instanceof Error ? error.message : String(error);
    return { status: "invalid", reason: `验签失败：${detail}` };
  }
}

/** 公钥指纹：`sha256:` + SHA-256(raw key) 前 16 位 hex。展示用，不是信任锚。 */
export async function publicKeyFingerprint(publicKey: string): Promise<string> {
  let bytes: Uint8Array<ArrayBuffer>;
  try {
    bytes = decodeBase64Url(publicKey);
  } catch {
    throw new Error("发布者公钥不是合法的 base64url");
  }
  if (bytes.length !== 32) {
    throw new Error("发布者公钥长度不是 32 字节（Ed25519 raw 公钥）");
  }
  const subtle = subtleCrypto();
  if (!subtle) {
    throw new Error("当前环境不支持 WebCrypto，无法计算公钥指纹");
  }
  const digest = await subtle.digest("SHA-256", bytes);
  const hex = Array.from(new Uint8Array(digest))
    .map((byte) => byte.toString(16).padStart(2, "0"))
    .join("");
  return `sha256:${hex.slice(0, 16)}`;
}

function memoryStorage(): StorageLike {
  const map = new Map<string, string>();
  return {
    getItem: (key) => (map.has(key) ? (map.get(key) as string) : null),
    setItem: (key, value) => {
      map.set(key, value);
    },
    removeItem: (key) => {
      map.delete(key);
    },
  };
}

function defaultPublisherStorage(): StorageLike {
  try {
    if (typeof localStorage !== "undefined" && localStorage) return localStorage;
  } catch {
    // 隐私模式等环境下访问 localStorage 本身即抛错 → 退回内存
  }
  return memoryStorage();
}

/**
 * 发布者信任表（TOFU）。
 *
 * 只记「用户确认过的 id → 公钥」，不做任何自动信任；坏 JSON 一律回退空表，
 * 不让一条坏记录把整个插件页打挂。
 */
export class PublisherTrustStore {
  private readonly storage: StorageLike;

  constructor(storage?: StorageLike) {
    this.storage = storage ?? defaultPublisherStorage();
  }

  get(id: string): PublisherRecord | undefined {
    const record = this.read().publishers[id];
    return record ? { ...record } : undefined;
  }

  /** 记录（或更新）一个已确认的发布者；公钥变了就等于换钥，由调用方确认后再调。 */
  remember(input: PublisherRecord): void {
    const data = this.read();
    data.publishers[input.id] = {
      id: input.id,
      publicKey: input.publicKey,
      fingerprint: input.fingerprint,
    };
    this.write(data);
  }

  forget(id: string): void {
    const data = this.read();
    if (!(id in data.publishers)) return;
    delete data.publishers[id];
    this.write(data);
  }

  /** 全部已信任发布者（详情/设置页展示用），按 id 排序。 */
  list(): PublisherRecord[] {
    return Object.values(this.read().publishers)
      .map((record) => ({ ...record }))
      .sort((left, right) => left.id.localeCompare(right.id));
  }

  private read(): PublisherData {
    const empty: PublisherData = { version: 1, publishers: {} };
    let raw: string | null = null;
    try {
      raw = this.storage.getItem(PUBLISHERS_KEY);
    } catch {
      return empty;
    }
    if (!raw) return empty;
    try {
      const parsed: unknown = JSON.parse(raw);
      if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) return empty;
      const publishers = (parsed as Record<string, unknown>).publishers;
      if (!publishers || typeof publishers !== "object" || Array.isArray(publishers)) return empty;
      const out: Record<string, PublisherRecord> = {};
      for (const [id, value] of Object.entries(publishers as Record<string, unknown>)) {
        if (!value || typeof value !== "object" || Array.isArray(value)) continue;
        const record = value as Record<string, unknown>;
        if (
          typeof record.publicKey !== "string" ||
          !record.publicKey ||
          typeof record.fingerprint !== "string" ||
          !record.fingerprint
        ) {
          continue;
        }
        out[id] = { id, publicKey: record.publicKey, fingerprint: record.fingerprint };
      }
      return { version: 1, publishers: out };
    } catch {
      return empty;
    }
  }

  private write(data: PublisherData): void {
    try {
      this.storage.setItem(PUBLISHERS_KEY, JSON.stringify(data));
    } catch {
      // 写失败静默：配额/隐私模式下不影响本次会话的判断
    }
  }
}

/** 供签名脚本/测试复用的 base64url 编码（浏览器侧只需解码，这里导出便于互证）。 */
export { encodeBase64Url as base64UrlEncode, decodeBase64Url as base64UrlDecode };
