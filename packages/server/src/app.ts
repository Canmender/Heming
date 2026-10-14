import express, { type Request, type Response, type NextFunction } from "express";
import { scryptSync, randomBytes, randomUUID, timingSafeEqual } from "node:crypto";
import {
  RegisterBodySchema,
  LoginBodySchema,
  UpdateProfileBodySchema,
  CreateConversationBodySchema,
  CreateFriendRequestBodySchema,
  CreateFileBodySchema,
  type SharedFileMeta,
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

/** 环境变量开关：仅 "1" / "true"（大小写不敏感）为开，其余（含未设置）为关。 */
export function envFlagEnabled(value: string | undefined): boolean {
  if (value === undefined) return false;
  const v = value.trim().toLowerCase();
  return v === "1" || v === "true";
}

/**
 * 最小 CORS 中间件（手写，不引 cors 依赖）。
 * 鉴权走 Bearer token 而非 cookie，故 `Allow-Origin: *` 不会带来凭据泄露风险；
 * 预检 OPTIONS 直接 204 短路，不进 JSON 解析与业务路由。
 */
function cors(req: Request, res: Response, next: NextFunction): void {
  res.setHeader("Access-Control-Allow-Origin", "*");
  res.setHeader("Access-Control-Allow-Methods", "GET,POST,PUT,DELETE,OPTIONS");
  res.setHeader("Access-Control-Allow-Headers", "Authorization,Content-Type");
  if (req.method === "OPTIONS") {
    res.status(204).end();
    return;
  }
  next();
}

export interface CreateAppOptions {
  /** 覆盖注册开关（优先于 HEMING_ALLOW_REGISTER），测试注入用；缺省读环境变量。 */
  allowRegister?: boolean;
}

export function createApp(store: Store, opts?: CreateAppOptions): express.Express {
  // 环境变量在 createApp 调用时读取（非 module 级缓存），便于测试内 set/delete 后注入。
  const allowRegister = opts?.allowRegister ?? envFlagEnabled(process.env.HEMING_ALLOW_REGISTER);
  const app = express();
  app.use(cors);
  app.use(express.json({ limit: "8mb" }));

  app.get("/api/health", (_req, res) => {
    res.json({ ok: true });
  });

  app.post("/api/auth/register", (req, res) => {
    if (!allowRegister) {
      res.status(403).json({ error: "registration disabled" });
      return;
    }
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

  app.put("/api/me", authOnly, (req, res) => {
    const parsed = UpdateProfileBodySchema.safeParse(req.body);
    if (!parsed.success) {
      res.status(400).json({ error: parsed.error.issues[0]?.message ?? "invalid body" });
      return;
    }
    try {
      res.json(store.updateProfile(userId(req), parsed.data));
    } catch (e) {
      res.status(400).json({ error: (e as Error).message });
    }
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

  interface StoredFile {
    meta: SharedFileMeta;
    content: string; // base64
  }
  const files = new Map<string, StoredFile>();

  app.get("/api/files", authOnly, (_req, res) => {
    res.json([...files.values()].map((f) => f.meta));
  });

  app.post("/api/files", authOnly, (req, res) => {
    const parsed = CreateFileBodySchema.safeParse(req.body);
    if (!parsed.success) {
      res.status(400).json({ error: "invalid body" });
      return;
    }
    const user = store.findUserById(userId(req))!;
    const meta: SharedFileMeta = {
      id: randomUUID(),
      owner: user.username,
      name: parsed.data.name,
      mime: parsed.data.mime,
      size:
        Math.floor((parsed.data.contentBase64.length * 3) / 4) -
        (parsed.data.contentBase64.endsWith("==")
          ? 2
          : parsed.data.contentBase64.endsWith("=")
            ? 1
            : 0),
      updatedAt: new Date().toISOString(),
    };
    files.set(meta.id, { meta, content: parsed.data.contentBase64 });
    res.status(201).json(meta);
  });

  app.delete("/api/files/:id", authOnly, (req, res) => {
    const stored = files.get(req.params.id);
    if (!stored) {
      res.status(404).json({ error: "not found" });
      return;
    }
    const user = store.findUserById(userId(req))!;
    if (stored.meta.owner !== user.username) {
      res.status(403).json({ error: "forbidden" });
      return;
    }
    files.delete(req.params.id);
    res.status(204).end();
  });

  return app;
}
