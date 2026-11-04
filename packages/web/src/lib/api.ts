import type {
  User,
  SharedFileMeta,
  Message,
  Conversation,
  E2eKeysResponse,
  PutE2eKeysBody,
  ReencryptBody,
  TeamActivityInput,
  TeamActivityList,
  TeamActivityWriteResult,
  TeamRoster,
  TeamUsageInput,
  TeamUsageRange,
  TeamUsageResponse,
  TeamUsageWriteResult,
  TeamUsageClearResult,
} from "@heming/shared";
import { hasSubtle, toB64, fromB64 } from "./e2eCrypto.js";

/**
 * API 直连地址：构建时由 VITE_API_BASE 注入（vite 对 VITE_ 前缀 env 天然内联，无需 define）。
 * 留空 = 同源相对路径（本地 dev 由 vite 代理 /api）；公网部署/桌面 file:// 页面必须配置绝对地址。
 */
export const API_BASE = (import.meta.env.VITE_API_BASE as string | undefined) ?? "";

/** VITE_API_BASE 形状不合法（无法解析 / 缺 http(s) 协议）时的统一错误文案。 */
export const INVALID_API_BASE_ERROR =
  "VITE_API_BASE 配置无效，需形如 http://host（不含末尾斜杠）";

/** 校验并解析非空 base：必须是可解析的 http(s) 绝对地址（可测纯函数）。 */
export function parseApiBase(base: string): URL {
  let u: URL;
  try {
    u = new URL(base);
  } catch {
    throw new Error(INVALID_API_BASE_ERROR);
  }
  if (u.protocol !== "http:" && u.protocol !== "https:") {
    throw new Error(INVALID_API_BASE_ERROR);
  }
  return u;
}

/**
 * 拼接请求 URL（可测纯函数）：
 * - base 非空 → 先做形状校验（http(s) 绝对地址），再 `${base}${path}` 直连；
 * - base 为空且页面 host 非空 → 保持同源相对路径；
 * - base 为空且 host 为空（file:// 桌面页未配置）→ 抛清晰错误。
 */
export function resolveUrl(
  path: string,
  base: string = API_BASE,
  host: string = typeof location !== "undefined" ? location.host : "",
): string {
  if (base) {
    parseApiBase(base);
    return `${base}${path}`;
  }
  if (!host) throw new Error("未配置 VITE_API_BASE：file:// 页面需指向服务端绝对地址");
  return path;
}

let token: string | null = localStorage.getItem("heming.token");

export function setToken(t: string | null): void {
  token = t;
  if (t) localStorage.setItem("heming.token", t);
  else localStorage.removeItem("heming.token");
}

export function getToken(): string | null {
  return token;
}

export class ApiError extends Error {
  status: number;
  constructor(status: number, message: string) {
    super(message);
    this.status = status;
  }
}

/** 运行中收到 401（token 失效/被撤销）时的全局回调，由 auth store 注册为 logout。 */
let onUnauthorized: (() => void) | null = null;

export function setOnUnauthorized(fn: (() => void) | null): void {
  onUnauthorized = fn;
}

export async function api<T>(path: string, init: RequestInit = {}): Promise<T> {
  const headers = new Headers(init.headers);
  headers.set("Content-Type", "application/json");
  // 模块级 token 优先；为空时回退 localStorage（测试环境 setToken 未先行、模块加载早于写入的场景）
  const t = token ?? localStorage.getItem("heming.token");
  if (t) headers.set("Authorization", `Bearer ${t}`);
  const res = await fetch(resolveUrl(path), { ...init, headers });
  const body = (await res.json().catch(() => ({}))) as { error?: string };
  if (!res.ok) {
    if (res.status === 401 && onUnauthorized) onUnauthorized();
    throw new ApiError(res.status, body.error ?? `http ${res.status}`);
  }
  return body as T;
}

type AuthResponse = { token: string; user: User };

export const login = (username: string, password: string) =>
  api<AuthResponse>("/api/auth/login", {
    method: "POST",
    body: JSON.stringify({ username, password }),
  });

export const fetchMe = () => api<User>("/api/me");
/** 更新个人资料：avatar 为 data URL base64 字符串；省略 avatar 时服务端保留原头像。 */
export const updateProfile = (displayName: string, avatar?: string) =>
  api<User>("/api/me", {
    method: "PUT",
    body: JSON.stringify({ displayName, ...(avatar !== undefined ? { avatar } : {}) }),
  });
export const fetchConversations = () => api<Conversation[]>("/api/conversations");
/**
 * 建智能体一对一会话（幂等：服务端已存在则返回原会话）。
 * 走同一个 POST /api/conversations，靠 body 的 agentId 分支区分——不新开路由，
 * 免得「会话列表刷新后新会话不在其中」这类口径分叉。
 */
export const createAgentConversation = (agentId: string) =>
  api<Conversation>("/api/conversations", {
    method: "POST",
    body: JSON.stringify({ agentId }),
  });
export const fetchMessages = (convId: string) =>
  api<Message[]>(`/api/conversations/${convId}/messages`);
export const fetchFiles = () => api<SharedFileMeta[]>("/api/files");

/** 团队名册：本实例全部注册用户 + 在线态 + 最近活跃。 */
export const fetchTeam = () => api<TeamRoster>("/api/team");

/** 团队动向流：默认 50 条，`before` 按 occurredAt 倒序翻页。 */
export const fetchTeamActivities = (opts: {
  limit?: number;
  before?: string;
  actorId?: string;
} = {}) => {
  const q = new URLSearchParams();
  if (opts.limit !== undefined) q.set("limit", String(opts.limit));
  if (opts.before) q.set("before", opts.before);
  if (opts.actorId) q.set("actorId", opts.actorId);
  const suffix = q.toString() ? `?${q.toString()}` : "";
  return api<TeamActivityList>(`/api/team/activities${suffix}`);
};

/** 上报本机摘要（≤50 条/次，按 sourceId 幂等去重）。 */
export const uploadTeamActivities = (items: TeamActivityInput[]) =>
  api<TeamActivityWriteResult>("/api/team/activities", {
    method: "POST",
    body: JSON.stringify({ items }),
  });

/** 撤回本人已上传的全部动向。 */
export const clearMyTeamActivities = () =>
  api<void>("/api/team/activities/mine", { method: "DELETE" });

/**
 * 团队用量（②-3）：只上报白名单摘要（自然日/模型名/连接名/token 数/未上报轮数），
 * 按 `(actor, date, model)` 覆盖式幂等——重复同步同一份数据不会翻倍。
 */
export const uploadTeamUsage = (items: TeamUsageInput[]) =>
  api<TeamUsageWriteResult>("/api/team/usage", {
    method: "POST",
    body: JSON.stringify({ items }),
  });

/** 本人用量明细 + 全站排行；`to` 传本地今天（服务端不猜时区）。 */
export const fetchTeamUsage = (
  opts: { range?: TeamUsageRange; to?: string } = {},
) => {
  const q = new URLSearchParams();
  if (opts.range) q.set("range", opts.range);
  if (opts.to) q.set("to", opts.to);
  const suffix = q.toString() ? `?${q.toString()}` : "";
  return api<TeamUsageResponse>(`/api/team/usage${suffix}`);
};

/** 删除本人已上传的全部用量行（关闭共享不删数据，删除必须是显式动作）。 */
export const clearMyTeamUsage = () =>
  api<TeamUsageClearResult>("/api/team/usage/mine", { method: "DELETE" });

/**
 * E2E 公钥分发与明文重加密（Task 2 契约，设计 §3.1/§7）：
 * - fetchE2eKeys：GET 全部用户设备公钥 {userId: [devices]}（X3DH 发起侧取对端 IK/SPK；
 *   会话层 E2eDeps.fetchPeerKeys 由接线层包一层按 userId 取值）。
 * - putE2eKeys：PUT 登记本人设备公钥（服务端 204 无响应体）。
 * - reencryptMessage：PUT 把本人 plain 消息原子重封为 e2e 信封。
 */
export const fetchE2eKeys = () => api<E2eKeysResponse>("/api/e2e/keys");
export const putE2eKeys = (body: PutE2eKeysBody) =>
  api("/api/e2e/keys", { method: "PUT", body: JSON.stringify(body) });
export const reencryptMessage = (messageId: string, body: ReencryptBody) =>
  api<Message>(`/api/messages/${encodeURIComponent(messageId)}/reencrypt`, {
    method: "PUT",
    body: JSON.stringify(body),
  });

/** 右栏用量：当前用户已用字节 + 每用户配额字节（服务端读 HEMING_FILE_QUOTA_MB）。 */
export const fetchFileUsage = () => api<{ used: number; quota: number }>("/api/files/usage");

/** Uint8Array → base64（逐字节拼二进制串，与既有 uploadFile 同法）。 */
function btoaBytes(bytes: Uint8Array): string {
  let binary = "";
  for (const b of bytes) binary += String.fromCharCode(b);
  return btoa(binary);
}

/** POST /api/files 与 413 配额映射（uploadFile / uploadEncryptedFile 共用一条通道）。 */
async function postFileJson(payload: {
  name: string;
  mime: string;
  contentBase64: string;
}): Promise<SharedFileMeta> {
  try {
    return await api<SharedFileMeta>("/api/files", {
      method: "POST",
      body: JSON.stringify(payload),
    });
  } catch (e) {
    // 服务端每用户配额超限（api() 把 body.error 作为 message 抛出）→ 换成用户可读文案；
    // 网关等非 JSON 体的 413（message 形如 "http 413"）保持原 ApiError 不动。
    if (e instanceof ApiError && e.status === 413 && e.message === "quota_exceeded") {
      throw new Error("超出存储配额");
    }
    throw e;
  }
}

/**
 * 上传共享库文件（右栏「上传」与右栏投递共用同一路径）：
 * 浏览器 File → ArrayBuffer → 手工逐字节拼二进制串 → btoa（TextEncoder 不必引入，
 * 文件名/类型走 JSON 字段，contentBase64 只承载原始字节）。上限由服务端 8MB json 上限兜底。
 * 明文语义（规格 §2.4）：显式共享=明文是既定产品语义——右栏上传/投递**保持明文**；
 * 消息附件的加密走 uploadEncryptedFile（同一 base64 通道，先加密再 POST）。
 */
export async function uploadFile(file: File): Promise<SharedFileMeta> {
  const buf = await file.arrayBuffer();
  return postFileJson({
    name: file.name,
    mime: file.type || "application/octet-stream",
    contentBase64: btoaBytes(new Uint8Array(buf)),
  });
}

// —— E2E Task 5：消息附件加密（规格 §2.4 文件边界——消息附件加密，右栏共享保持明文）——

/**
 * 附件密文 AAD（固定上下文串）：AES-GCM 的 additionalData 不随密文传输，上传与解密两侧
 * 必须同源同值——本常量即两侧唯一口径（api.test 与 ChatPage.test 各自独立拼一份做锁定，
 * 改动此处不同步改测试 → 解密即红）。IV 12B 随机、**前置于密文字节**：
 * contentBase64 = base64(iv(12) || ciphertext||tag(16))，解密时按同布局切分。
 */
const FILE_ENC_AAD = new TextEncoder().encode("heming.e2e.file.v1");
const FILE_IV_LEN = 12;
const FILE_KEY_LEN = 32;

/** 无 subtle 的附件拦截文案（与 ChatPage NO_E2E_NOTICE 同语义；api 层不 import 组件防环）。 */
/**
 * 无安全上下文（file:// 或 http 非回环）时统一的加密不可用文案。
 * 聊天页横幅与附件上传失败共用这一句，避免同一条件两种说法。
 */
export const NO_E2E_MESSAGE =
  "当前环境无法加密消息，请在桌面端打开，或使用以 https 开头的网址访问";

const NO_E2E_FILE_ERROR = `${NO_E2E_MESSAGE}（附件未处理）`;

/** 解密失败的可读文案（密钥不匹配/密文损坏/AAD 漂移统一口径，气泡占位直接展示）。 */
const FILE_DECRYPT_ERROR = "附件解密失败（密钥不匹配或数据已损坏）";

/**
 * 加密上传消息附件：随机 32B fileKey → AES-256-GCM 加密原字节 → POST /api/files。
 * 服务端只见密文：mime 置 application/octet-stream、name 加 `.enc` 前缀（共享库列表里
 * 也能一眼认出密文项，且不落明文类型供嗅探）；**fileKey 不上行**，由调用方随消息进密文
 * （payload.file.key，见 shared MessagePayload.file）。返回的 name/mime/size 是服务端
 * 密文形态；消息 payload 请用原文件的 name/mime/size + 本返回的 id/key（气泡按原 mime
 * 路由 image/audio、按原名展示与下载）。
 * 无 subtle 拦截：不发任何请求、不发明文（规格 §2.1 拒绝不降级）。
 */
export async function uploadEncryptedFile(file: File): Promise<{
  id: string;
  name: string;
  mime: string;
  size: number;
  key: string;
}> {
  if (!hasSubtle()) throw new Error(NO_E2E_FILE_ERROR);
  const plain = new Uint8Array(await file.arrayBuffer());
  const keyBytes = crypto.getRandomValues(new Uint8Array(FILE_KEY_LEN));
  const iv = crypto.getRandomValues(new Uint8Array(FILE_IV_LEN));
  const cryptoKey = await crypto.subtle.importKey(
    "raw",
    toArrayBuffer(keyBytes),
    { name: "AES-GCM" },
    false,
    ["encrypt"],
  );
  const ct = new Uint8Array(
    await crypto.subtle.encrypt(
      { name: "AES-GCM", iv, additionalData: toArrayBuffer(FILE_ENC_AAD) },
      cryptoKey,
      toArrayBuffer(plain),
    ),
  );
  const sealed = new Uint8Array(iv.length + ct.length);
  sealed.set(iv, 0);
  sealed.set(ct, iv.length);
  // CreateFileBody.name 上限 255：前缀后超长截断（原名尾段丢失属极端边界，服务端契约优先）
  const meta = await postFileJson({
    name: (".enc" + file.name).slice(0, 255),
    mime: "application/octet-stream",
    contentBase64: btoaBytes(sealed),
  });
  return { id: meta.id, name: meta.name, mime: meta.mime, size: meta.size, key: toB64(keyBytes) };
}

/**
 * 解密下载附件（uploadEncryptedFile 的逆向）：与 fetchFileBlobUrl 同鉴权同错误口径
 * （Bearer 头、401 触发全局 onUnauthorized 并抛 ApiError），差异在拿到密文后用 fileKey
 * 做 AES-GCM 解密再打包 Blob。objectURL 由调用方按既有模式创建与 revoke（AttachmentPreview/
 * AudioBubble 的晚到即销 + cleanup 销仍成立）——本函数只负责取回明文 Blob。
 * mime 决定 Blob type（<img>/<audio> 对 blob: URL 的类型嗅探依据）；调用方通常传 payload.file.mime。
 * 解密失败抛 FILE_DECRYPT_ERROR（HTTP 错误保持原 ApiError 不吞）。
 */
export async function downloadEncryptedFile(
  id: string,
  key: string,
  mime = "application/octet-stream",
): Promise<Blob> {
  if (!hasSubtle()) throw new Error(NO_E2E_FILE_ERROR);
  const headers = new Headers();
  const t = token ?? localStorage.getItem("heming.token");
  if (t) headers.set("Authorization", `Bearer ${t}`);
  const res = await fetch(resolveUrl(`/api/files/${id}/content`), { headers });
  if (!res.ok) {
    const body = (await res.json().catch(() => ({}))) as { error?: string };
    if (res.status === 401 && onUnauthorized) onUnauthorized();
    throw new ApiError(res.status, body.error ?? `http ${res.status}`);
  }
  const sealed = new Uint8Array(await (await res.blob()).arrayBuffer());
  if (sealed.length <= FILE_IV_LEN) throw new Error(FILE_DECRYPT_ERROR);
  try {
    const cryptoKey = await crypto.subtle.importKey(
      "raw",
      toArrayBuffer(fromB64(key)),
      { name: "AES-GCM" },
      false,
      ["decrypt"],
    );
    const plain = await crypto.subtle.decrypt(
      { name: "AES-GCM", iv: toArrayBuffer(sealed.slice(0, FILE_IV_LEN)), additionalData: toArrayBuffer(FILE_ENC_AAD) },
      cryptoKey,
      toArrayBuffer(sealed.slice(FILE_IV_LEN)),
    );
    return new Blob([plain], { type: mime });
  } catch {
    // WebCrypto OperationError（密钥错/AAD 变）与 atob 坏 key 统一成可读文案，不吐栈
    throw new Error(FILE_DECRYPT_ERROR);
  }
}

/** Uint8Array → ArrayBuffer 背书（TS 5.9 BufferSource 收紧，同 e2eCrypto 的同名工具）。 */
function toArrayBuffer(u8: Uint8Array): ArrayBuffer {
  return u8.buffer.slice(u8.byteOffset, u8.byteOffset + u8.byteLength) as ArrayBuffer;
}

/**
 * 附件内容取 objectURL（气泡缩略图 <img> / 文件卡 <a download> 共用）：
 * content 路由 authOnly 只认 Authorization 头，而浏览器裸 <img src>/<a href> 的标签页
 * 请求带不上鉴权（实测 401 断图）→ 带 token fetch 取 blob 后 URL.createObjectURL。
 * 401 与 api() 同口径触发全局 onUnauthorized 并抛 ApiError；不设 Content-Type（GET 取二进制）。
 * 调用方负责在组件卸载/换附件时 URL.revokeObjectURL（见 ChatPage 的 AttachmentPreview）。
 */
export async function fetchFileBlobUrl(id: string): Promise<string> {
  const headers = new Headers();
  const t = token ?? localStorage.getItem("heming.token");
  if (t) headers.set("Authorization", `Bearer ${t}`);
  const res = await fetch(resolveUrl(`/api/files/${id}/content`), { headers });
  if (!res.ok) {
    const body = (await res.json().catch(() => ({}))) as { error?: string };
    if (res.status === 401 && onUnauthorized) onUnauthorized();
    throw new ApiError(res.status, body.error ?? `http ${res.status}`);
  }
  return URL.createObjectURL(await res.blob());
}

/**
 * 附件内容取纯文本（预览文本/Markdown 内嵌用）：与 fetchFileBlobUrl 同鉴权（content 路由
 * authOnly 只认 Authorization 头），差异只在返回 res.text() 而非 objectURL——先取 blob URL
 * 再二次 fetch 解码绕了一圈，文本路径独立函数更直白。401 同口径触发全局 onUnauthorized。
 */
export async function fetchFileBlobText(id: string): Promise<string> {
  const headers = new Headers();
  const t = token ?? localStorage.getItem("heming.token");
  if (t) headers.set("Authorization", `Bearer ${t}`);
  const res = await fetch(resolveUrl(`/api/files/${id}/content`), { headers });
  if (!res.ok) {
    const body = (await res.json().catch(() => ({}))) as { error?: string };
    if (res.status === 401 && onUnauthorized) onUnauthorized();
    throw new ApiError(res.status, body.error ?? `http ${res.status}`);
  }
  return res.text();
}
