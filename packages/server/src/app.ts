import express, { type Request, type Response, type NextFunction } from "express";
import { scryptSync, randomBytes, randomUUID, timingSafeEqual } from "node:crypto";
import {
  RegisterBodySchema,
  LoginBodySchema,
  UpdateProfileBodySchema,
  CreateConversationBodySchema,
  CreateFriendRequestBodySchema,
  CreateFileBodySchema,
  AgentBodySchema,
  AttachAgentBodySchema,
  PutE2eKeysBodySchema,
  ReencryptBodySchema,
  ArchiveConversationBodySchema,
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
      if ("peerId" in parsed.data) {
        res.status(201).json(store.createDirectConversation(userId(req), parsed.data.peerId));
        return;
      }
      if ("agentId" in parsed.data) {
        // 智能体一对一：与 direct 同入口，靠 body 形状区分（union 分支）。
        // 创建响应按 listConversations 的行再取一次，保证 unreadCount 等字段齐备
        // ——直接返回 store 的创建结果会缺 unreadCount，前端入列时得自己补，两处易漂移。
        const created = store.createAgentConversation(userId(req), parsed.data.agentId);
        const row = store.listConversations(userId(req)).find((c) => c.id === created.id);
        res.status(201).json(row ?? { ...created, unreadCount: 0 });
        return;
      }
      const g = store.createGroup(userId(req), parsed.data.name, parsed.data.memberIds);
      const row = store.listConversations(userId(req)).find((c) => c.id === g.id);
      res.status(201).json(row ?? { ...g, memberCount: parsed.data.memberIds.length + 1, unreadCount: 0 });
    } catch (e) {
      res.status(400).json({ error: (e as Error).message });
    }
  });

  /**
   * 归档 / 取消归档（按成员独立，见 store.setConversationArchived）。
   *
   * 用 PATCH 而不是 POST/DELETE 成对：归档是「改一个状态位」，
   * 不是创建或销毁资源——两个方向一个接口，前端也不必判两次。
   */
  app.patch("/api/conversations/:id/archive", authOnly, (req, res) => {
    const parsed = ArchiveConversationBodySchema.safeParse(req.body);
    if (!parsed.success) {
      res.status(400).json({ error: "invalid body" });
      return;
    }
    try {
      store.setConversationArchived(req.params.id, userId(req), parsed.data.archived);
      res.status(204).end();
    } catch {
      // store 对「不存在」与「不是成员」抛同一种错：不区分是刻意的，
      // 免得把「这个会话存在但你不在里面」泄露给无关的人。
      res.status(403).json({ error: "forbidden" });
    }
  });

  app.get("/api/conversations/:id/messages", authOnly, (req, res) => {    if (!store.isMember(req.params.id, userId(req))) {
      res.status(403).json({ error: "forbidden" });
      return;
    }
    res.json(store.listMessages(req.params.id));
  });

  app.get("/api/conversations/:id/members", authOnly, (req, res) => {
    if (!store.isMember(req.params.id, userId(req))) {
      res.status(403).json({ error: "forbidden" });
      return;
    }
    res.json(store.listMembers(req.params.id));
  });

  app.get("/api/conversations/:id/reads", authOnly, (req, res) => {
    if (!store.isMember(req.params.id, userId(req))) {
      res.status(403).json({ error: "forbidden" });
      return;
    }
    res.json(store.listReads(req.params.id));
  });

  // —— M4：共享文件从 app.ts 闭包 Map 迁入 Store（memory/sqlite 双实现持久化）——

  /** 每用户存储配额（MB→字节）：HEMING_FILE_QUOTA_MB，缺省/解析失败/非正数回退 200MB。 */
  const quotaBytes = (): number => {
    const raw = Number.parseInt(process.env.HEMING_FILE_QUOTA_MB ?? "", 10);
    return Number.isFinite(raw) && raw > 0 ? raw * 1024 * 1024 : 200 * 1024 * 1024;
  };

  app.get("/api/files", authOnly, (_req, res) => {
    res.json(store.listFiles());
  });

  app.get("/api/files/usage", authOnly, (req, res) => {
    const user = store.findUserById(userId(req))!;
    res.json({ used: store.userFileBytes(user.username), quota: quotaBytes() });
  });

  app.post("/api/files", authOnly, (req, res) => {
    const parsed = CreateFileBodySchema.safeParse(req.body);
    if (!parsed.success) {
      res.status(400).json({ error: "invalid body" });
      return;
    }
    const user = store.findUserById(userId(req))!;
    const size =
      Math.floor((parsed.data.contentBase64.length * 3) / 4) -
      (parsed.data.contentBase64.endsWith("==")
        ? 2
        : parsed.data.contentBase64.endsWith("=")
          ? 1
          : 0);
    // 每用户总配额（按 owner username 计量，与他人文件无关），超限 413
    if (store.userFileBytes(user.username) + size > quotaBytes()) {
      res.status(413).json({ error: "quota_exceeded" });
      return;
    }
    const meta: SharedFileMeta = {
      id: randomUUID(),
      owner: user.username,
      name: parsed.data.name,
      mime: parsed.data.mime,
      size,
      updatedAt: new Date().toISOString(),
    };
    store.addFile(meta, parsed.data.contentBase64);
    res.status(201).json(meta);
  });

  app.delete("/api/files/:id", authOnly, (req, res) => {
    const stored = store.getFile(req.params.id);
    if (!stored) {
      res.status(404).json({ error: "not found" });
      return;
    }
    const user = store.findUserById(userId(req))!;
    if (stored.meta.owner !== user.username) {
      res.status(403).json({ error: "forbidden" });
      return;
    }
    store.deleteFile(req.params.id);
    res.status(204).end();
  });

  // 附件内容（气泡图片/下载）：与列表同为登录可见口径（共享库语义），无属主校验
  app.get("/api/files/:id/content", authOnly, (req, res) => {
    const stored = store.getFile(req.params.id);
    if (!stored) {
      res.status(404).json({ error: "not found" });
      return;
    }
    res.setHeader("Content-Type", stored.meta.mime);
    res.send(Buffer.from(stored.contentBase64, "base64"));
  });

  // —— M3 智能体名册：错误口径 forbidden→403、agent not found→404、其余 400 ——

  app.get("/api/agents", authOnly, (_req, res) => {
    res.json(store.listAgents());
  });

  app.post("/api/agents", authOnly, (req, res) => {
    const parsed = AgentBodySchema.safeParse(req.body);
    if (!parsed.success) {
      res.status(400).json({ error: "invalid body" });
      return;
    }
    try {
      res.status(201).json(
        store.createAgent(userId(req), {
          name: parsed.data.name,
          avatar: parsed.data.avatar ?? null,
          description: parsed.data.description,
        }),
      );
    } catch (e) {
      res.status(400).json({ error: (e as Error).message });
    }
  });

  app.put("/api/agents/:id", authOnly, (req, res) => {
    const parsed = AgentBodySchema.partial().safeParse(req.body);
    if (!parsed.success) {
      res.status(400).json({ error: "invalid body" });
      return;
    }
    try {
      res.json(store.updateAgent(req.params.id, userId(req), parsed.data));
    } catch (e) {
      const msg = (e as Error).message;
      res.status(msg === "forbidden" ? 403 : msg === "agent not found" ? 404 : 400).json({ error: msg });
    }
  });

  app.delete("/api/agents/:id", authOnly, (req, res) => {
    try {
      store.deleteAgent(req.params.id, userId(req));
      res.status(204).end();
    } catch (e) {
      const msg = (e as Error).message;
      res.status(msg === "forbidden" ? 403 : msg === "agent not found" ? 404 : 400).json({ error: msg });
    }
  });

  // —— M3 I2：自建智能体入群（挂载/卸载）。权限在此层做（Store 不校验）：
  // 非成员 403、agent 不存在 404；挂载幂等（首挂 201、已挂 200），卸载幂等 204。——

  app.post("/api/conversations/:id/agents", authOnly, (req, res) => {
    if (!store.isMember(req.params.id, userId(req))) {
      res.status(403).json({ error: "forbidden" });
      return;
    }
    const parsed = AttachAgentBodySchema.safeParse(req.body);
    if (!parsed.success) {
      res.status(400).json({ error: parsed.error.issues[0]?.message ?? "invalid body" });
      return;
    }
    const { agentId } = parsed.data;
    if (!store.listAgents().some((a) => a.id === agentId)) {
      res.status(404).json({ error: "agent not found" });
      return;
    }
    const existed = store.listAgentIds(req.params.id).includes(agentId);
    store.attachAgentToGroup(req.params.id, agentId);
    res.status(existed ? 200 : 201).json({ conversationId: req.params.id, agentId });
  });

  app.delete("/api/conversations/:id/agents/:agentId", authOnly, (req, res) => {
    if (!store.isMember(req.params.id, userId(req))) {
      res.status(403).json({ error: "forbidden" });
      return;
    }
    store.detachAgentFromGroup(req.params.id, req.params.agentId);
    res.status(204).end();
  });

  // —— E2E Task 2：设备公钥分发（设计 §3.1）与明文重封装（§7）——

  /** 登录可读全部用户设备公钥：{[userId]: devices[]}（X3DH 发起侧取对端 IK/SPK 用）。 */
  app.get("/api/e2e/keys", authOnly, (_req, res) => {
    res.json(store.listE2eKeys());
  });

  /** 登记本人设备（仅 upsert 到登录账号名下——body 无 userId 位，夹带字段被 Zod 剥除）。 */
  app.put("/api/e2e/keys", authOnly, (req, res) => {
    const parsed = PutE2eKeysBodySchema.safeParse(req.body);
    if (!parsed.success) {
      res.status(400).json({ error: parsed.error.issues[0]?.message ?? "invalid body" });
      return;
    }
    store.upsertE2eDevice(userId(req), parsed.data);
    res.status(204).end();
  });

  /**
   * 明文消息重加密（设计 §7）：本人把 plain 消息原子重封为 e2e 信封。
   * 语义：400 body 非法 / 401 未登录 / 403 非 sender / 404 消息不存在 /
   * 409 已是 e2e（或并发下先到者已换）/ 200 更新后消息。
   */
  app.put("/api/messages/:id/reencrypt", authOnly, (req, res) => {
    const parsed = ReencryptBodySchema.safeParse(req.body);
    if (!parsed.success) {
      res.status(400).json({ error: parsed.error.issues[0]?.message ?? "invalid body" });
      return;
    }
    const result = store.reencryptMessage(req.params.id, userId(req), {
      cipher: parsed.data.cipher,
      ...(parsed.data.chainKid !== undefined ? { chainKid: parsed.data.chainKid } : {}),
      ...(parsed.data.n !== undefined ? { n: parsed.data.n } : {}),
    });
    if (!result.ok) {
      const status = result.reason === "not_found" ? 404 : result.reason === "forbidden" ? 403 : 409;
      const error =
        result.reason === "not_found" ? "not found" : result.reason === "forbidden" ? "forbidden" : "already encrypted";
      res.status(status).json({ error });
      return;
    }
    res.json(result.message);
  });

  // —— 语音通话：ICE 服务器配置（STUN/TURN，从环境变量读取，不入库）——
  // 无鉴权：STUN/TURN 地址为公共基础设施，TURN 凭据由部署方按环境注入；
  // 客户端在建立 PeerConnection 前拉取，缺省回退公共 STUN。
  app.get("/api/ice-servers", (_req, res) => {
    const iceServers: { urls: string; username?: string; credential?: string }[] = [
      { urls: process.env.HEMING_STUN ?? "stun:stun.miwifi.com:3478" },
    ];
    if (process.env.HEMING_TURN_URL) {
      iceServers.push({
        urls: process.env.HEMING_TURN_URL,
        username: process.env.HEMING_TURN_USERNAME ?? "",
        credential: process.env.HEMING_TURN_CREDENTIAL ?? "",
      });
    }
    res.json({ iceServers });
  });

  return app;
}
