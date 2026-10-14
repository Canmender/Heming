import type { User, SharedFileMeta, Message } from "@heming/shared";

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
  if (token) headers.set("Authorization", `Bearer ${token}`);
  const res = await fetch(path, { ...init, headers });
  const body = (await res.json().catch(() => ({}))) as { error?: string };
  if (!res.ok) {
    if (res.status === 401 && onUnauthorized) onUnauthorized();
    throw new ApiError(res.status, body.error ?? `http ${res.status}`);
  }
  return body as T;
}

type AuthResponse = { token: string; user: User };

export const register = (username: string, password: string, displayName: string) =>
  api<AuthResponse>("/api/auth/register", {
    method: "POST",
    body: JSON.stringify({ username, password, displayName }),
  });

export const login = (username: string, password: string) =>
  api<AuthResponse>("/api/auth/login", {
    method: "POST",
    body: JSON.stringify({ username, password }),
  });

export const fetchMe = () => api<User>("/api/me");
export const fetchFriends = () =>
  api<{ id: string; user: User }[]>("/api/friends");
export const requestFriend = (username: string) =>
  api("/api/friends/request", { method: "POST", body: JSON.stringify({ username }) });
export const fetchIncomingRequests = () =>
  api<{ id: string; from: User }[]>("/api/friends/requests");
export const acceptFriend = (id: string) =>
  api(`/api/friends/${id}/accept`, { method: "POST", body: "{}" });
export const fetchConversations = () =>
  api<{ id: string; type: "direct"; peer: User }[]>("/api/conversations");
export const createConversation = (peerId: string) =>
  api<{ id: string; type: "direct"; peer: User }>("/api/conversations", {
    method: "POST",
    body: JSON.stringify({ peerId }),
  });
export const fetchMessages = (convId: string) =>
  api<Message[]>(`/api/conversations/${convId}/messages`);
export const fetchFiles = () => api<SharedFileMeta[]>("/api/files");
