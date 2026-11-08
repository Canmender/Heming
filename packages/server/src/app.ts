import express, { type Request, type Response, type NextFunction } from "express";
import { scryptSync, randomBytes, randomUUID, timingSafeEqual, createHash } from "node:crypto";
import { join } from "node:path";
import {
  RegisterBodySchema,
  LoginBodySchema,
  UpdateProfileBodySchema,
  AgentConversationBodySchema,
  CreateFileBodySchema,
  AgentBodySchema,
  PutE2eKeysBodySchema,
  ReencryptBodySchema,
  CreateTeamActivitiesBodySchema,
  CreateTeamUsageBodySchema,
  TeamUsageRangeSchema,
  CreateWorkspaceTeamBodySchema,
  UpdateWorkspaceTeamBodySchema,
  AddTeamMemberBodySchema,
  CreateTeamPlanBodySchema,
  UpdateTeamPlanBodySchema,
  CreateTeamTaskBodySchema,
  UpdateTeamTaskBodySchema,
  type SharedFileMeta,
} from "@heming/shared";
import type { Store } from "./store.js";
import { issueToken, userIdFromToken } from "./auth.js";
import { presence } from "./presence.js";
import { dayKeyUtc, parseDayKey, summarizeTeamUsage, usageRangeBounds } from "./teamUsage.js";
import { createPluginCatalog } from "./pluginCatalog.js";
import { createPluginMarketRouter } from "./pluginMarket.js";
import { createSkillHubRouter } from "./skillHub.js";

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
  res.setHeader("Access-Control-Allow-Headers", "Authorization,Content-Type,x-heming-client");
  if (req.method === "OPTIONS") {
    res.status(204).end();
    return;
  }
  next();
}

export interface CreateAppOptions {
  /** 覆盖注册开关（优先于 HEMING_ALLOW_REGISTER），测试注入用；缺省读环境变量。 */
  allowRegister?: boolean;
  /** 云端插件目录（测试注入；缺省 HEMING_PLUGIN_DIR 或 <cwd>/plugins-catalog）。 */
  pluginDir?: string;
}

export function createApp(store: Store, opts?: CreateAppOptions): express.Express {
  // 环境变量在 createApp 调用时读取（非 module 级缓存），便于测试内 set/delete 后注入。
  const allowRegister = opts?.allowRegister ?? envFlagEnabled(process.env.HEMING_ALLOW_REGISTER);
  /**
   * 云端插件目录（d.86）：插件包是**独立产物**，不随安装包分发；这里只读发布目录。
   * 缺省 `<cwd>/plugins-catalog`——部署时把该目录同步到服务器，或用 HEMING_PLUGIN_DIR 指定。
   */
  const pluginCatalog = createPluginCatalog({
    dir:
      opts?.pluginDir ??
      process.env.HEMING_PLUGIN_DIR ??
      join(process.cwd(), "plugins-catalog"),
  });

  const app = express();
  app.use(cors);
  /**
   * 发布密钥：仓库写操作只认它，不认用户登录态（目录本身是公开的）。
   * 提前声明：市场索引路由挂在 `express.json` 之前，也要用同一份密钥逻辑。
   */
  const publishKey = (process.env.HEMING_PLUGIN_PUBLISH_KEY ?? "").trim();
  /**
   * 市场索引 v2（d.105）：索引是发布工具生成的静态 JSON，服务端只原样分发。
   * 必须挂在 `express.json` **之前**——PUT 的 body 要原样落盘，全局 json 解析会重排字节。
   */
  app.use("/api/plugin-market", createPluginMarketRouter({ dir: pluginCatalog.dir, publishKey }));
  app.use(express.json({ limit: "8mb" }));
  /**
   * 技能社区（d.109）：服务端代理虾评（上游没有 CORS 头，浏览器不能直连）。
   * 挂在 `express.json` 之后：`POST /api/skill-hub/register` 需要解析 JSON body。
   * 上游 base / 开关由 `HEMING_SKILL_HUB_BASE` / `HEMING_SKILL_HUB` 控制（见 skillHub.ts）。
   */
  app.use("/api/skill-hub", createSkillHubRouter());

  // 注：req 参数类型不能用默认的 Request（P=ParamsDictionary，值为 string|string[]），
  // 否则会作为 P 的推断候选把路由参数拖成 string|string[]，导致 req.params.id 类型报错。
  // 会话按 store 查（sqlite 侧持久化），服务重启后 token 仍有效。
  function authOnly(req: Request<{ [key: string]: string }>, res: Response, next: NextFunction): void {
    const header = req.header("authorization") ?? "";
    const token = header.startsWith("Bearer ") ? header.slice(7) : "";
    const authedUserId = userIdFromToken(store, token);
    if (!authedUserId) {
      res.status(401).json({ error: "unauthorized" });
      return;
    }
    (req as Request & { userId: string }).userId = authedUserId;
    next();
  }

  app.get("/api/health", (_req, res) => {
    res.json({ ok: true });
  });

  /**
   * 插件目录：公开（包内容本就是公开产物，不含用户数据），不要求登录态。
   * 只返回元数据；真正的 plugin.json 走下面那条原样分发路由，客户端自行校验 sha256。
   */
  app.get("/api/plugins", (_req, res) => {
    res.json({ plugins: pluginCatalog.list(), generatedAt: new Date().toISOString() });
  });

  app.get("/api/plugins/:id/:version/manifest", (req, res) => {
    const found = pluginCatalog.read(req.params.id, req.params.version);
    if (!found) {
      res.status(404).json({ error: "插件不存在" });
      return;
    }
    res.setHeader("Content-Type", "application/json; charset=utf-8");
    res.setHeader("X-Plugin-Sha256", found.sha256);
    res.send(found.bytes);
  });

  /**
   * 插件仓库（d.95）：单个插件的全部版本。
   * 目录只给「最新版」，这里给「历史版本 + 指纹」，客户端据此判断更新与回看旧版。
   */
  app.get("/api/plugins/:id", (req, res) => {
    const detail = pluginCatalog.detail(req.params.id);
    if (!detail) {
      res.status(404).json({ error: "插件不存在" });
      return;
    }
    res.json(detail);
  });

  /** 发布密钥：仓库写操作只认它，不认用户登录态（目录本身是公开的）。 */
  function publishAuthorized(req: Request<{ [key: string]: string }>): boolean {
    if (!publishKey) return false; // 未配置 = 关闭发布接口
    const given = String(req.header("x-publish-key") ?? "");
    return given.length === publishKey.length && given === publishKey;
  }

  /**
   * 发布清单到仓库（运维/CI 用；界面不走这条路）。
   *
   * `PUT /api/plugins/:id/:version`：路径写 id/版本、body 是 plugin.json 全文。
   * 服务端不解析权限、不执行代码，只做「id/版本字符集 + 大小 + 清单内 id/version 与路径一致」
   * 三条校验，然后原样落盘；同版本重复 PUT = 覆盖（200，created=false），首次发布 201。
   */
  app.put("/api/plugins/:id/:version", (req, res) => {
    if (!publishKey) {
      res.status(503).json({ error: "云端插件仓库未开启发布接口（未配置 HEMING_PLUGIN_PUBLISH_KEY）" });
      return;
    }
    if (!publishAuthorized(req)) {
      res.status(401).json({ error: "发布密钥不正确" });
      return;
    }
    const body = req.body as unknown;
    if (!body || typeof body !== "object" || Array.isArray(body)) {
      res.status(400).json({ error: "请求体必须是 plugin.json 对象" });
      return;
    }
    const manifest = body as Record<string, unknown>;
    const id = req.params.id;
    const version = req.params.version;
    if (manifest.id !== id || manifest.version !== version) {
      res.status(400).json({ error: "plugin.json 里的 id/version 必须与发布路径一致" });
      return;
    }
    const bytes = Buffer.from(JSON.stringify(body, null, 2), "utf8");
    /**
     * 版本内容不可变（N15，学 MCP Registry）：同 id+版本已存在时，内容必须完全一致。
     * 内容变了就要求提升版本号——否则已安装用户记录的 sha256 会和目录里同一版本的字节对不上，
     * 更新/回滚判定全部失效。
     *
     * 比较分两层：字节 sha256 相同 → 幂等；字节不同但 JSON 内容相同（缩进/换行差异）→ 也幂等，
     * 且**保留已存字节不重写**（否则服务端会把同一版本改成另一份字节，sha256 反而变了）。
     */
    const existing = pluginCatalog.read(id, version);
    if (existing) {
      const sha256 = createHash("sha256").update(bytes).digest("hex");
      if (existing.sha256 !== sha256) {
        let sameContent = false;
        try {
          sameContent = JSON.stringify(JSON.parse(existing.bytes.toString("utf8"))) === JSON.stringify(body);
        } catch {
          sameContent = false;
        }
        if (!sameContent) {
          res.status(409).json({
            error: "版本内容不可变：同 id/版本已发布且内容不同，请提升版本号后重新发布",
          });
          return;
        }
        res.status(200).json({
          id,
          version,
          sha256: existing.sha256,
          size: existing.bytes.length,
          created: false,
        });
        return;
      }
    }
    const result = pluginCatalog.publish(id, version, bytes);
    if (result === "invalid_id" || result === "invalid_version") {
      res.status(400).json({ error: "插件 id 或版本号格式不正确" });
      return;
    }
    if (result === "too_large") {
      res.status(413).json({ error: "plugin.json 过大（上限 256KB）" });
      return;
    }
    if (result === "mismatch") {
      res.status(400).json({ error: "plugin.json 里的 id/version 与路径不一致或无法解析" });
      return;
    }
    res.status(result.created ? 201 : 200).json(result);
  });

  /** 下线某个版本（运维/CI 用）。 */
  app.delete("/api/plugins/:id/:version", (req, res) => {
    if (!publishKey) {
      res.status(503).json({ error: "云端插件仓库未开启发布接口（未配置 HEMING_PLUGIN_PUBLISH_KEY）" });
      return;
    }
    if (!publishAuthorized(req)) {
      res.status(401).json({ error: "发布密钥不正确" });
      return;
    }
    const result = pluginCatalog.remove(req.params.id, req.params.version);
    if (result === "not_found") {
      res.status(404).json({ error: "插件版本不存在" });
      return;
    }
    res.status(204).end();
  });
  /**
   * 发布界面插件包（d.98）：`PUT /api/plugins/:id/:version/package`，body 是 package.tgz 原始字节。
   *
   * 与清单分成两次 PUT（先清单、再包）：包必须能找到同 id/版本的清单，避免「有包没清单」的孤儿；
   * 服务端只校验 id/版本字符集、大小（≤40MB）与清单已存在，**不解析包内容**——
   * 解包配额、清单结构、entry 存在性都由客户端安装时再校验。
   */
  app.put(
    "/api/plugins/:id/:version/package",
    express.raw({ type: ["application/gzip", "application/x-gzip", "application/octet-stream"], limit: "40mb" }),
    (req, res) => {
      if (!publishKey) {
        res.status(503).json({ error: "云端插件仓库未开启发布接口（未配置 HEMING_PLUGIN_PUBLISH_KEY）" });
        return;
      }
      if (!publishAuthorized(req)) {
        res.status(401).json({ error: "发布密钥不正确" });
        return;
      }
      const bytes = Buffer.isBuffer(req.body) ? req.body : Buffer.alloc(0);
      if (bytes.length === 0) {
        res.status(400).json({ error: "请求体必须是 package.tgz 原始字节" });
        return;
      }
      const result = pluginCatalog.publishPackage(req.params.id, req.params.version, bytes);
      if (result === "invalid_id" || result === "invalid_version") {
        res.status(400).json({ error: "插件 id 或版本号格式不正确" });
        return;
      }
      if (result === "too_large") {
        res.status(413).json({ error: "插件包过大（上限 40MB）或为空" });
        return;
      }
      if (result === "missing_manifest") {
        res.status(409).json({ error: "先发布 plugin.json 再发布 package.tgz（同 id/版本）" });
        return;
      }
      if (result === "conflict") {
        res.status(409).json({ error: "同版本包内容不可变，请提升版本号" });
        return;
      }
      res.status(result.created ? 201 : 200).json(result);
    },
  );

  /**
   * 界面插件包（d.98）：`package.tgz` 原样分发，客户端先比目录里的 sha256 再解包。
   * 纯声明式插件没有这个文件，返回 404（客户端据此按「只装清单」处理）。
   */
  app.get("/api/plugins/:id/:version/package", (req, res) => {
    const found = pluginCatalog.readPackage(req.params.id, req.params.version);
    if (!found) {
      res.status(404).json({ error: "插件包不存在" });
      return;
    }
    res.setHeader("Content-Type", "application/gzip");
    res.setHeader("X-Plugin-Package-Sha256", found.sha256);
    res.send(found.bytes);
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
      // 注册即视为一次活跃：名册「最近活跃」不应让刚注册的人显示为从未出现。
      store.touchUser(user.id);
      res.status(201).json({ token: issueToken(store, user.id), user });
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
    store.touchUser(row.user.id);
    res.json({ token: issueToken(store, row.user.id), user: row.user });
  });

  app.get("/api/me", authOnly, (req, res) => {
    const user = store.findUserById(userId(req));
    if (!user) {
      res.status(401).json({ error: "unauthorized" });
      return;
    }
    store.touchUser(user.id);
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

  // —— d.54 团队系统：单团队名册 + 动向摘要（全站登录可见）——

  app.get("/api/team", authOnly, (_req, res) => {
    const members = store.listTeamMembers().map((m) => ({
      ...m,
      online: presence.isOnline(m.user.id),
    }));
    // 在线优先 → 最近活跃倒序 → 显示名；null 活跃时间排最后。
    members.sort((a, b) => {
      if (a.online !== b.online) return a.online ? -1 : 1;
      if (a.lastSeenAt !== b.lastSeenAt) {
        if (a.lastSeenAt === null) return 1;
        if (b.lastSeenAt === null) return -1;
        return a.lastSeenAt < b.lastSeenAt ? 1 : -1;
      }
      return a.user.displayName.localeCompare(b.user.displayName, "zh-Hans-CN");
    });
    res.json({ members, onlineCount: members.filter((m) => m.online).length });
  });

  app.get("/api/team/activities", authOnly, (req, res) => {
    const rawLimit = Number.parseInt(String(req.query.limit ?? ""), 10);
    const limit = Number.isFinite(rawLimit) ? Math.min(100, Math.max(1, rawLimit)) : 50;
    const before = typeof req.query.before === "string" ? req.query.before : undefined;
    const actorId = typeof req.query.actorId === "string" ? req.query.actorId : undefined;
    if (before !== undefined && !Number.isFinite(Date.parse(before))) {
      res.status(400).json({ error: "invalid before" });
      return;
    }
    res.json({ activities: store.listTeamActivities({ limit, before, actorId }) });
  });

  app.post("/api/team/activities", authOnly, (req, res) => {
    const parsed = CreateTeamActivitiesBodySchema.safeParse(req.body);
    if (!parsed.success) {
      res.status(400).json({ error: parsed.error.issues[0]?.message ?? "invalid body" });
      return;
    }
    let inserted = 0;
    let skipped = 0;
    for (const item of parsed.data.items) {
      if (store.addTeamActivity(userId(req), item)) inserted += 1;
      else skipped += 1;
    }
    res.status(inserted > 0 ? 201 : 200).json({ inserted, skipped });
  });

  app.delete("/api/team/activities/mine", authOnly, (req, res) => {
    store.clearTeamActivities(userId(req));
    res.status(204).end();
  });

  // —— ②-3 团队用量：白名单摘要的服务端聚合（不含任何正文/提示词/参数） ——

  /**
   * 上报本人用量摘要（≤50 条/次，按 `(actor, date, model)` 覆盖式幂等）。
   *
   * body 里只有「自然日 / 模型名 / 连接名 / token 数 / 未上报轮数」五类，
   * schema 之外的字段会被剥掉——客户端即使误传正文也进不了库。
   */
  app.post("/api/team/usage", authOnly, (req, res) => {
    const parsed = CreateTeamUsageBodySchema.safeParse(req.body);
    if (!parsed.success) {
      res.status(400).json({ error: parsed.error.issues[0]?.message ?? "invalid body" });
      return;
    }
    for (const item of parsed.data.items) store.upsertTeamUsage(userId(req), item);
    // `written` = 本次提交条数；`stored` = 服务端该批去重后的行数（重复上报不增长）。
    const stored = new Set(parsed.data.items.map((it) => `${it.date}\0${it.model}`)).size;
    res.status(200).json({ written: parsed.data.items.length, stored });
  });

  /**
   * 本人明细 + 全站排行。
   *
   * `range` 只接受 7d/30d；`to` 可选（客户端本地今天）——不传则用服务端 UTC 今天。
   * 排行只回聚合数与显示名，模型/连接名等明细只在 `self` 里出现。
   */
  app.get("/api/team/usage", authOnly, (req, res) => {
    const rawRange = typeof req.query.range === "string" ? req.query.range : "7d";
    const parsedRange = TeamUsageRangeSchema.safeParse(rawRange);
    if (!parsedRange.success) {
      res.status(400).json({ error: "invalid range" });
      return;
    }
    const rawTo = typeof req.query.to === "string" ? req.query.to : undefined;
    if (rawTo !== undefined && parseDayKey(rawTo) === null) {
      res.status(400).json({ error: "invalid to" });
      return;
    }
    const bounds = usageRangeBounds(parsedRange.data, rawTo ?? dayKeyUtc());
    const rows = store.listTeamUsage(bounds);
    const names = new Map(store.listTeamMembers().map((m) => [m.user.id, m.user.displayName]));
    res.json(
      summarizeTeamUsage(rows, {
        viewerId: userId(req),
        range: parsedRange.data,
        from: bounds.from,
        to: bounds.to,
        names,
      }),
    );
  });

  /**
   * 清除本人已上传的全部用量行（对称团队动向的清除）。
   *
   * 为什么需要它：关闭共享只停「未来上传」，旧行仍在服务端、人仍出现在排行里——
   * 删除必须由用户显式发起，不能拿「关开关」暗示「已删除」。
   */
  app.delete("/api/team/usage/mine", authOnly, (req, res) => {
    res.json({ deleted: store.clearTeamUsage(userId(req)) });
  });

  // —— d.92 团队工作台：用户自建团队 / 目标 / 方案 / 任务 ——
  //
  // 接口口径（智能体侧走同一套 REST，权限只在服务端判一处）：
  // - 非成员访问团队 → 一律 404「团队不存在」：返回 403 等于告诉对方「这个 id 存在」；
  // - 成员但不是创建者做 owner-only 动作（改/删团队、加/移除成员）→ 403；
  // - 方案与任务：团队成员都能写（任务可指派给成员、可挂到本团队的方案下）。

  app.get("/api/teams", authOnly, (req, res) => {
    res.json({ teams: store.listWorkspaceTeams(userId(req)) });
  });

  app.post("/api/teams", authOnly, (req, res) => {
    const parsed = CreateWorkspaceTeamBodySchema.safeParse(req.body);
    if (!parsed.success) {
      res.status(400).json({ error: parsed.error.issues[0]?.message ?? "invalid body" });
      return;
    }
    res.status(201).json(store.createWorkspaceTeam(userId(req), parsed.data));
  });

  app.get("/api/teams/:id", authOnly, (req, res) => {
    const snapshot = store.getWorkspaceTeam(req.params.id, userId(req));
    if (!snapshot) {
      res.status(404).json({ error: "团队不存在" });
      return;
    }
    res.json(snapshot);
  });

  app.patch("/api/teams/:id", authOnly, (req, res) => {
    const parsed = UpdateWorkspaceTeamBodySchema.safeParse(req.body);
    if (!parsed.success) {
      res.status(400).json({ error: parsed.error.issues[0]?.message ?? "invalid body" });
      return;
    }
    const result = store.updateWorkspaceTeam(req.params.id, userId(req), parsed.data);
    if (result === null) {
      res.status(404).json({ error: "团队不存在" });
      return;
    }
    if (result === "forbidden") {
      res.status(403).json({ error: "只有团队创建者可以修改团队信息" });
      return;
    }
    res.json(result);
  });

  app.delete("/api/teams/:id", authOnly, (req, res) => {
    const result = store.deleteWorkspaceTeam(req.params.id, userId(req));
    if (result === null) {
      res.status(404).json({ error: "团队不存在" });
      return;
    }
    if (result === "forbidden") {
      res.status(403).json({ error: "只有团队创建者可以删除团队" });
      return;
    }
    res.status(204).end();
  });

  app.post("/api/teams/:id/members", authOnly, (req, res) => {
    const parsed = AddTeamMemberBodySchema.safeParse(req.body);
    if (!parsed.success) {
      res.status(400).json({ error: parsed.error.issues[0]?.message ?? "invalid body" });
      return;
    }
    const result = store.addWorkspaceMember(req.params.id, userId(req), parsed.data.username);
    if (result === null) {
      res.status(404).json({ error: "团队不存在" });
      return;
    }
    if (result === "forbidden") {
      res.status(403).json({ error: "只有团队创建者可以添加成员" });
      return;
    }
    if (result === "user_not_found") {
      res.status(404).json({ error: "该用户不存在" });
      return;
    }
    if (result === "already_member") {
      res.status(409).json({ error: "该用户已在团队里" });
      return;
    }
    res.json(result);
  });

  app.delete("/api/teams/:id/members/:userId", authOnly, (req, res) => {
    const result = store.removeWorkspaceMember(req.params.id, userId(req), req.params.userId);
    if (result === null) {
      res.status(404).json({ error: "成员不存在" });
      return;
    }
    if (result === "forbidden") {
      res.status(403).json({ error: "只有团队创建者可以移除成员" });
      return;
    }
    if (result === "owner") {
      res.status(409).json({ error: "不能移除团队创建者" });
      return;
    }
    res.json(result);
  });

  app.post("/api/teams/:id/plans", authOnly, (req, res) => {
    const parsed = CreateTeamPlanBodySchema.safeParse(req.body);
    if (!parsed.success) {
      res.status(400).json({ error: parsed.error.issues[0]?.message ?? "invalid body" });
      return;
    }
    const result = store.createTeamPlan(req.params.id, userId(req), parsed.data);
    if (result === null) {
      res.status(404).json({ error: "团队不存在" });
      return;
    }
    if (result === "forbidden") {
      res.status(403).json({ error: "只有团队成员可以编排方案" });
      return;
    }
    res.status(201).json(result);
  });

  app.patch("/api/teams/:id/plans/:planId", authOnly, (req, res) => {
    const parsed = UpdateTeamPlanBodySchema.safeParse(req.body);
    if (!parsed.success) {
      res.status(400).json({ error: parsed.error.issues[0]?.message ?? "invalid body" });
      return;
    }
    const result = store.updateTeamPlan(req.params.id, req.params.planId, userId(req), parsed.data);
    if (result === null) {
      res.status(404).json({ error: "团队不存在" });
      return;
    }
    if (result === "forbidden") {
      res.status(403).json({ error: "只有团队成员可以改方案" });
      return;
    }
    if (result === "not_found") {
      res.status(404).json({ error: "方案不存在" });
      return;
    }
    res.json(result);
  });

  app.delete("/api/teams/:id/plans/:planId", authOnly, (req, res) => {
    const result = store.deleteTeamPlan(req.params.id, req.params.planId, userId(req));
    if (result === "not_found") {
      res.status(404).json({ error: "方案不存在" });
      return;
    }
    if (result === "forbidden") {
      res.status(403).json({ error: "只有团队成员可以删方案" });
      return;
    }
    res.status(204).end();
  });

  app.post("/api/teams/:id/tasks", authOnly, (req, res) => {
    const parsed = CreateTeamTaskBodySchema.safeParse(req.body);
    if (!parsed.success) {
      res.status(400).json({ error: parsed.error.issues[0]?.message ?? "invalid body" });
      return;
    }
    const result = store.createTeamTask(req.params.id, userId(req), parsed.data);
    if (result === null) {
      res.status(404).json({ error: "团队不存在" });
      return;
    }
    if (result === "forbidden") {
      res.status(403).json({ error: "只有团队成员可以派任务" });
      return;
    }
    if (result === "assignee_not_member") {
      res.status(400).json({ error: "只能把任务指派给团队成员" });
      return;
    }
    if (result === "plan_not_found") {
      res.status(400).json({ error: "方案不属于该团队" });
      return;
    }
    res.status(201).json(result);
  });

  app.patch("/api/teams/:id/tasks/:taskId", authOnly, (req, res) => {
    const parsed = UpdateTeamTaskBodySchema.safeParse(req.body);
    if (!parsed.success) {
      res.status(400).json({ error: parsed.error.issues[0]?.message ?? "invalid body" });
      return;
    }
    const result = store.updateTeamTask(
      req.params.id,
      req.params.taskId,
      userId(req),
      parsed.data,
    );
    if (result === null) {
      res.status(404).json({ error: "团队不存在" });
      return;
    }
    if (result === "forbidden") {
      res.status(403).json({ error: "只有团队成员可以改任务" });
      return;
    }
    if (result === "not_found") {
      res.status(404).json({ error: "任务不存在" });
      return;
    }
    if (result === "assignee_not_member") {
      res.status(400).json({ error: "只能把任务指派给团队成员" });
      return;
    }
    if (result === "plan_not_found") {
      res.status(400).json({ error: "方案不属于该团队" });
      return;
    }
    res.json(result);
  });

  app.delete("/api/teams/:id/tasks/:taskId", authOnly, (req, res) => {
    const result = store.deleteTeamTask(req.params.id, req.params.taskId, userId(req));
    if (result === "not_found") {
      res.status(404).json({ error: "任务不存在" });
      return;
    }
    if (result === "forbidden") {
      res.status(403).json({ error: "只有团队成员可以删任务" });
      return;
    }
    res.status(204).end();
  });

  app.get("/api/conversations", authOnly, (req, res) => {
    res.json(store.listConversations(userId(req)));
  });

  // d.54：人类私聊/群聊已删除，会话入口只剩「与某个助手的一对一」。
  app.post("/api/conversations", authOnly, (req, res) => {
    const parsed = AgentConversationBodySchema.safeParse(req.body);
    if (!parsed.success) {
      res.status(400).json({ error: "invalid body" });
      return;
    }
    try {
      const created = store.createAgentConversation(userId(req), parsed.data.agentId);
      const row = store.listConversations(userId(req)).find((c) => c.id === created.id);
      res.status(201).json(row ?? { ...created, unreadCount: 0 });
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

  // d.54：语音/视频通话随人类 IM 一并删除，不再提供 ICE 配置接口。
  return app;
}
