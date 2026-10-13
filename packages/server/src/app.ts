import express, { type Request, type Response, type NextFunction } from "express";
import { scryptSync, randomBytes, timingSafeEqual } from "node:crypto";
import {
  RegisterBodySchema,
  LoginBodySchema,
  CreateConversationBodySchema,
  CreateFriendRequestBodySchema,
} from "@heming/shared";
import type { Store } from "./store.js";
import { issueToken, userIdFromToken } from "./auth.js";

export function hashPassword(password: string): string {
  const salt = randomBytes(16).toString("hex");
  const hash = scryptSync(password, salt, 64).toString("hex");
  return `${salt}:${hash}`;
}

export function verifyPassword(password: string, stored: string): boolean {
  const [salt, hash] = stored.split(":");
  if (!salt || !hash) return false;
  const candidate = scryptSync(password, salt, 64);
  const expected = Buffer.from(hash, "hex");
  return candidate.length === expected.length && timingSafeEqual(candidate, expected);
}

// 注：req 参数类型不能用默认的 Request（P=ParamsDictionary，值为 string|string[]），
// 否则会作为 P 的推断候选把路由参数拖成 string|string[]，导致 req.params.id 类型报错。
function authOnly(req: Request<{ [key: string]: string }>, res: Response, next: NextFunction): void {
  const header = req.header("authorization") ?? "";
  const token = header.startsWith("Bearer ") ? header.slice(7) : "";
  const userId = userIdFromToken(token);
  if (!userId) {
    res.status(401).json({ error: "unauthorized" });
    return;
  }
  (req as Request & { userId: string }).userId = userId;
  next();
}

function userId(req: Request): string {
  return (req as Request & { userId: string }).userId;
}

export function createApp(store: Store): express.Express {
  const app = express();
  app.use(express.json({ limit: "1mb" }));

  app.get("/api/health", (_req, res) => {
    res.json({ ok: true });
  });

  app.post("/api/auth/register", (req, res) => {
    const parsed = RegisterBodySchema.safeParse(req.body);
    if (!parsed.success) {
      res.status(400).json({ error: parsed.error.issues[0]?.message ?? "invalid body" });
      return;
    }
    const { username, password, displayName } = parsed.data;
    try {
      const user = store.createUser(username, hashPassword(password), displayName);
      res.status(201).json({ token: issueToken(user.id), user });
    } catch (e) {
      res.status(400).json({ error: (e as Error).message });
    }
  });

  app.post("/api/auth/login", (req, res) => {
    const parsed = LoginBodySchema.safeParse(req.body);
    if (!parsed.success) {
      res.status(400).json({ error: "invalid body" });
      return;
    }
    const row = store.findUserByUsername(parsed.data.username);
    if (!row || !verifyPassword(parsed.data.password, row.passwordHash)) {
      res.status(401).json({ error: "invalid credentials" });
      return;
    }
    res.json({ token: issueToken(row.user.id), user: row.user });
  });

  app.get("/api/me", authOnly, (req, res) => {
    const user = store.findUserById(userId(req));
    if (!user) {
      res.status(401).json({ error: "unauthorized" });
      return;
    }
    res.json(user);
  });

  app.get("/api/friends", authOnly, (req, res) => {
    res.json(store.listFriends(userId(req)));
  });

  app.get("/api/friends/requests", authOnly, (req, res) => {
    res.json(store.listIncomingRequests(userId(req)));
  });

  app.post("/api/friends/request", authOnly, (req, res) => {
    const parsed = CreateFriendRequestBodySchema.safeParse(req.body);
    if (!parsed.success) {
      res.status(400).json({ error: "invalid body" });
      return;
    }
    try {
      const result = store.createFriendRequest(userId(req), parsed.data.username);
      res.status(201).json(result);
    } catch (e) {
      res.status(400).json({ error: (e as Error).message });
    }
  });

  app.post("/api/friends/:id/accept", authOnly, (req, res) => {
    try {
      res.json(store.acceptFriendRequest(req.params.id, userId(req)));
    } catch (e) {
      res.status(400).json({ error: (e as Error).message });
    }
  });

  app.get("/api/conversations", authOnly, (req, res) => {
    res.json(store.listConversations(userId(req)));
  });

  app.post("/api/conversations", authOnly, (req, res) => {
    const parsed = CreateConversationBodySchema.safeParse(req.body);
    if (!parsed.success) {
      res.status(400).json({ error: "invalid body" });
      return;
    }
    try {
      res.status(201).json(store.createDirectConversation(userId(req), parsed.data.peerId));
    } catch (e) {
      res.status(400).json({ error: (e as Error).message });
    }
  });

  app.get("/api/conversations/:id/messages", authOnly, (req, res) => {
    if (!store.isMember(req.params.id, userId(req))) {
      res.status(403).json({ error: "forbidden" });
      return;
    }
    res.json(store.listMessages(req.params.id));
  });

  app.get("/api/files", authOnly, (_req, res) => {
    res.json([]);
  });

  return app;
}
