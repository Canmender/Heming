import type { User, SharedFileMeta, Message, Conversation, Member } from "@heming/shared";

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
export const fetchFriends = () =>
  api<{ id: string; user: User }[]>("/api/friends");
export const requestFriend = (username: string) =>
  api("/api/friends/request", { method: "POST", body: JSON.stringify({ username }) });
export const fetchIncomingRequests = () =>
  api<{ id: string; from: User }[]>("/api/friends/requests");
export const acceptFriend = (id: string) =>
  api(`/api/friends/${id}/accept`, { method: "POST", body: "{}" });
export const fetchConversations = () => api<Conversation[]>("/api/conversations");
/** 建直聊会话：服务端该响应体不带 unreadCount（store.createDirectConversation 原样返回），由调用方补 0。 */
export const createConversation = (peerId: string) =>
  api<{ id: string; type: "direct"; peer: User }>("/api/conversations", {
    method: "POST",
    body: JSON.stringify({ peerId }),
  });
export const fetchMessages = (convId: string) =>
  api<Message[]>(`/api/conversations/${convId}/messages`);
export const fetchMembers = (convId: string) =>
  api<Member[]>(`/api/conversations/${convId}/members`);
export const fetchFiles = () => api<SharedFileMeta[]>("/api/files");

/**
 * 上传共享库文件（App 的「上传」与聊天附件共用同一路径）：
 * 浏览器 File → ArrayBuffer → 手工逐字节拼二进制串 → btoa（TextEncoder 不必引入，
 * 文件名/类型走 JSON 字段，contentBase64 只承载原始字节）。上限由服务端 8MB json 上限兜底。
 */
export async function uploadFile(file: File): Promise<SharedFileMeta> {
  const buf = await file.arrayBuffer();
  let binary = "";
  const bytes = new Uint8Array(buf);
  for (const b of bytes) binary += String.fromCharCode(b);
  return api<SharedFileMeta>("/api/files", {
    method: "POST",
    body: JSON.stringify({
      name: file.name,
      mime: file.type || "application/octet-stream",
      contentBase64: btoa(binary),
    }),
  });
}

/** 附件内容直链（气泡缩略图 <img src> / 文件卡 <a href> 下载）。 */
export function fileContentUrl(id: string): string {
  return resolveUrl(`/api/files/${id}/content`);
}
