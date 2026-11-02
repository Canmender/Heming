import { randomBytes, createHash } from "node:crypto";
import type { Store } from "./store.js";

/**
 * 登录 token：只把 SHA-256 摘要落库（见 sessions 表），原文只在登录响应里出现一次。
 *
 * 之前 token 存在进程内 Map：服务一重启全部失效，所有设备被踢回登录页。
 * 现在凭据随 SQLite 持久化，重启/发版不再影响已登录会话。
 */
function digest(token: string): string {
  return createHash("sha256").update(token).digest("hex");
}

export function issueToken(store: Pick<Store, "addSession">, userId: string): string {
  const token = randomBytes(32).toString("hex");
  store.addSession(digest(token), userId);
  return token;
}

export function userIdFromToken(
  store: Pick<Store, "sessionUserId">,
  token: string,
): string | null {
  if (!token) return null;
  return store.sessionUserId(digest(token));
}
