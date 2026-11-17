import { randomBytes, createHash } from "node:crypto";
import type { Store } from "./store.js";

/**
 * 登录 token：只把 SHA-256 摘要落库（见 sessions 表），原文只在登录响应里出现一次。
 *
 * 之前 token 存在进程内 Map：服务一重启全部失效，所有设备被踢回登录页。
 * 现在凭据随 SQLite 持久化，重启/发版不再影响已登录会话。
 *
 * 为什么是 30 天：token 本身是不透明随机串，泄露窗口需要边界；但桌面端的使用节奏是
 * 「装一次、天天开着」，过短会频繁把用户踢回登录页。30 天 + 401 自动刷新
 * （POST /api/auth/refresh）在安全与可用性之间取平衡。
 */
export const SESSION_TTL_MS = 30 * 24 * 60 * 60 * 1000;

/** 新会话的过期时刻（毫秒时间戳）；抽成函数是为了让「登录/注册/刷新」用同一口径。 */
export function sessionExpiryFromNow(now: number = Date.now()): number {
  return now + SESSION_TTL_MS;
}

function digest(token: string): string {
  return createHash("sha256").update(token).digest("hex");
}

/**
 * 签发新 token。`expiresAt` 缺省 = 30 天后过期（测试注入过去时刻可模拟过期会话）；
 * 摘要落库，原文只返回给调用方。
 */
export function issueToken(
  store: Pick<Store, "addSession">,
  userId: string,
  expiresAt: number = sessionExpiryFromNow(),
): string {
  const token = randomBytes(32).toString("hex");
  store.addSession(digest(token), userId, expiresAt);
  return token;
}

export function userIdFromToken(
  store: Pick<Store, "sessionUserId">,
  token: string,
): string | null {
  if (!token) return null;
  return store.sessionUserId(digest(token));
}

/** 吊销单个 token（登出 / 刷新换票）。返回是否确实删掉了一条会话。 */
export function revokeToken(store: Pick<Store, "deleteSession">, token: string): boolean {
  if (!token) return false;
  return store.deleteSession(digest(token));
}

/** 吊销某用户全部会话（「退出所有设备」）；返回吊销数量。 */
export function revokeUserSessions(
  store: Pick<Store, "deleteUserSessions">,
  userId: string,
): number {
  return store.deleteUserSessions(userId);
}
