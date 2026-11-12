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

/**
 * 权限 → 签名用的确定性形状（d.113 口径）。
 *
 * ★ 与 scripts/sign-plugin.mjs 一致：`permissions.chat` **只在 true 时进入文本**。
 *   应用归一化后的 v5 权限对象恒有 `chat: false`，若原样签进去，脚本签出的 v5 包
 *   在应用里会因多一个 `"chat":false` 而验签失败（历史遗留口径陷阱，d.124 顺手对齐）。
 *
 * d.125：widget 桥新域 `infohub` / `notify` 沿用同一条口径——归一化清单恒有这两个
 * false 字段，而签名脚本不认识它们；只让 true 进文本，才能保证「旧脚本签的包」在
 * 新应用里仍然验得过。签名脚本与桌面侧 canonicalizer 需同步这条规则（遗留跟进）。
 */
function canonicalPermissions(permissions: PluginManifest["permissions"]): Record<string, unknown> {
  const record = permissions as unknown as Record<string, unknown>;
  const { chat, infohub, notify, ...rest } = record;
  return {
    ...rest,
    ...(chat === true ? { chat: true } : {}),
    ...(infohub === true ? { infohub: true } : {}),
    ...(notify === true ? { notify: true } : {}),
  };
}

/** 签名文本里统一用 trim 后的纯文本（数字/缺失一律空串）。 */
function trimText(value: unknown): string {
  return typeof value === "string" ? value.trim() : "";
}

function stringListOf(value: unknown): string[] {
  return Array.isArray(value) ? value.map((item) => trimText(item)) : [];
}

/** 命令/页面动作的 target → 与 `scripts/sign-plugin.mjs` 完全一致的形状。 */
function canonicalTarget(target: unknown): Record<string, unknown> {
  const record = target && typeof target === "object" ? (target as Record<string, unknown>) : {};
  const kind = typeof record.kind === "string" ? record.kind : "";
  if (kind === "page") return { kind, page: trimText(record.page) };
  if (kind === "skill") return { kind, name: trimText(record.name) };
  if (kind === "settings") return { kind, card: trimText(record.card) };
  if (kind === "unit") return { kind, unitId: trimText(record.unitId) };
  return { kind };
}

/**
 * 页面块 → 签名用的确定性形状（d.124）。
 *
 * ★ 与 `scripts/sign-plugin.mjs` / `packages/desktop/plugin-signature.js` 的同名函数
 *   逐字段一致：三方 canonicalizer 必须对同一份清单产出同一串字节，否则
 *   「脚本签的包在应用里验不过」。这里输入是**应用归一化后**的清单形状
 *   （list 项已有 `description` 缺省 "" 等），所以只做 trim/投影，不补默认值。
 */
function canonicalPageBlock(block: unknown): Record<string, unknown> {
  const record = block && typeof block === "object" ? (block as Record<string, unknown>) : {};
  const type = typeof record.type === "string" ? record.type : "";
  const title = trimText(record.title);
  const head: Record<string, unknown> = title ? { type, title } : { type };
  if (type === "markdown") return { ...head, text: trimText(record.text) };
  if (type === "stats") {
    return {
      ...head,
      items: (Array.isArray(record.items) ? record.items : []).map((item) => {
        const entry = item && typeof item === "object" ? (item as Record<string, unknown>) : {};
        return { label: trimText(entry.label), value: trimText(entry.value) };
      }),
    };
  }
  if (type === "table") {
    return {
      ...head,
      columns: stringListOf(record.columns),
      rows: (Array.isArray(record.rows) ? record.rows : []).map((row) => stringListOf(row)),
    };
  }
  if (type === "list") {
    return {
      ...head,
      items: (Array.isArray(record.items) ? record.items : []).map((item) => {
        const entry = item && typeof item === "object" ? (item as Record<string, unknown>) : {};
        return {
          title: trimText(entry.title),
          description: trimText(entry.description),
          ...(trimText(entry.badge) ? { badge: trimText(entry.badge) } : {}),
        };
      }),
    };
  }
  if (type === "actions") {
    return {
      ...head,
      items: (Array.isArray(record.items) ? record.items : []).map((item) => {
        const entry = item && typeof item === "object" ? (item as Record<string, unknown>) : {};
        return { label: trimText(entry.label), target: canonicalTarget(entry.target) };
      }),
    };
  }
  if (type === "contributions") return { ...head, kind: trimText(record.kind) };
  return head;
}

/**
 * 页面 → 签名用的确定性形状（d.124）。
 *
 * 空 icon/summary/entry/blocks 不进文本（与 shared 的「缺省即空」口径一致）。
 */
function canonicalPage(page: unknown): Record<string, unknown> | undefined {
  if (!page || typeof page !== "object") return undefined;
  const record = page as Record<string, unknown>;
  const title = trimText(record.title);
  if (!title) return undefined;
  const out: Record<string, unknown> = { title };
  const icon = trimText(record.icon);
  if (icon) out.icon = icon;
  const summary = trimText(record.summary);
  if (summary) out.summary = summary;
  const entry = trimText(record.entry);
  if (entry) out.entry = entry;
  const blocks = Array.isArray(record.blocks) ? record.blocks.map(canonicalPageBlock) : [];
  if (blocks.length > 0) out.blocks = blocks;
  return out;
}

/**
 * 首页卡片 → 签名用的确定性形状（d.125）。
 *
 * 首页卡片是插件声明给主窗口的入口数据，改 title/跳转页/文案属于可感知变更，
 * 所以必须绑进签名；但空 summary/icon/primary 不进文本，保持与 shared 的
 * 「缺省即空」口径一致（键顺序无所谓：canonicalJsonText 会按键排序）。
 */
function canonicalHomeCard(card: unknown): Record<string, unknown> | undefined {
  if (!card || typeof card !== "object") return undefined;
  const record = card as Record<string, unknown>;
  const id = trimText(record.id);
  const title = trimText(record.title);
  const page = trimText(record.page);
  if (!id || !title || !page) return undefined;
  const out: Record<string, unknown> = { id, title, page };
  const summary = trimText(record.summary);
  if (summary) out.summary = summary;
  const icon = trimText(record.icon);
  if (icon) out.icon = icon;
  const primary = trimText(record.primary);
  if (primary) out.primary = primary;
  return out;
}

/** 后台页入口 → 签名用的确定性形状（d.125）：入口换了等于换了要执行的页面。 */
function canonicalBackground(background: unknown): Record<string, unknown> | undefined {
  if (!background || typeof background !== "object") return undefined;
  const entry = trimText((background as Record<string, unknown>).entry);
  return entry ? { entry } : undefined;
}

/** 规范化签名文本：与内容指纹同款排序，但**包含 publisher、排除 signature**。 */
export function signedManifestText(manifest: PluginManifest): string {
  // d.124：页面（title/icon/summary/entry/blocks）必须进签名，否则「签名后换页面入口/
  // 换标题」验不出来。仅声明页面时才出现该键——旧包 canonical 字节逐字不变。
  // d.125：homeCards / background 同理，只在真的声明了内容时才进文本；
  // 归一化清单恒有 `homeCards: []`，若原样签进去，所有既有签名会一起失效。
  const { page, homeCards, background, ...restContributions } = manifest.contributions;
  const signedPage = canonicalPage(page);
  // 落盘的旧记录可能没有 homeCards（类型是新的，数据是旧的），按空数组兜底。
  const signedHomeCards = (Array.isArray(homeCards) ? homeCards : [])
    .map(canonicalHomeCard)
    .filter((card) => card !== undefined);
  const signedBackground = canonicalBackground(background);
  return canonicalJsonText({
    id: manifest.id,
    version: manifest.version,
    name: manifest.name,
    description: manifest.description,
    author: manifest.author,
    publisher: manifest.publisher ?? null,
    permissions: canonicalPermissions(manifest.permissions),
    contributions: {
      ...restContributions,
      ...(signedHomeCards.length > 0 ? { homeCards: signedHomeCards } : {}),
      ...(signedBackground ? { background: signedBackground } : {}),
      ...(signedPage ? { page: signedPage } : {}),
    },
    // 界面插件（bundle）把 files/** 摘要绑进清单，签名因此覆盖代码字节。
    // 声明式包没有该字段 → canonicalJsonText 丢弃 undefined，旧包签名逐字节不变。
    packageSha256: manifest.packageSha256,
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
