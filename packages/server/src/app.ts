import express, { type Request, type Response, type NextFunction } from "express";
import { scryptSync, randomBytes, randomUUID, timingSafeEqual, createHash } from "node:crypto";
import { join } from "node:path";
import {
  RegisterBodySchema,
  LoginBodySchema,
  UpdateProfileBodySchema,
  AgentConversationBodySchema,
  UpdateConversationBodySchema,
  UpdateConversationWorkspaceBodySchema,
  AddWorkspaceBodySchema,
  CreateFileBodySchema,
  PutE2eKeysBodySchema,
  ReencryptBodySchema,
  CreateTeamActivitiesBodySchema,
  CreateTeamUsageBodySchema,
  TeamUsageRangeSchema,
  CreateWorkspaceTeamBodySchema,
  UpdateWorkspaceTeamBodySchema,
  AddTeamMemberBodySchema,
  TransferTeamOwnerBodySchema,
  CreateTeamPlanBodySchema,
  UpdateTeamPlanBodySchema,
  CreateTeamTaskBodySchema,
  CreateTeamTaskCommentBodySchema,
  UpdateTeamTaskBodySchema,
  SYSTEM_AGENT_ID,
  type SharedFileMeta,
  type TeamEvent,
  type TeamPlanItem,
  type TeamTask,
} from "@heming/shared";
import type { Store } from "./store.js";
import {
  issueToken,
  userIdFromToken,
  revokeToken,
  revokeUserSessions,
  sessionExpiryFromNow,
} from "./auth.js";
import { createObservability } from "./obs.js";
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

/**
 * 读一个「正整数才启用」的环境变量：未设置 / 空串 / 非数字 / 0 / 负数 / 小数 → null（不启用）。
 * 用于动向保留期这类开关——todo 默认不设 = 行为零变化，写错成 "7天" 也不能意外开启。
 */
function parsePositiveIntEnv(raw: string | undefined): number | null {
  if (raw === undefined || raw.trim() === "") return null;
  const n = Number(raw);
  return Number.isInteger(n) && n > 0 ? n : null;
}

/**
 * 任务类动向的展示标题（只有这一个值）。
 *
 * 与 `packages/shared/src/schemas.ts` 的 `TASK_ACTIVITY_TITLES` 及 web 的
 * `lib/team/labels.ts` 一字不差。读侧投影用它兜住**收紧前入库的历史行**（T2-02）。
 */
const TASK_ACTIVITY_TITLE = "任务";

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
  // 前端/桌面端要能从 JS 读到服务端分配的请求 id（排障时把浏览器报错对上服务端日志）。
  res.setHeader("Access-Control-Expose-Headers", "x-request-id");
  if (req.method === "OPTIONS") {
    res.status(204).end();
    return;
  }
  next();
}

/** 会话内容搜索：查询词长度下限（1 个字符会把几乎所有消息都搜出来，等于没有搜索）。 */
const SEARCH_QUERY_MIN = 2;

/** 会话内容搜索：查询词长度上限（再长就是粘贴整段文档，不是搜索）。 */
const SEARCH_QUERY_MAX = 80;

/** 会话内容搜索：一次最多回多少条命中。 */
const SEARCH_LIMIT_DEFAULT = 20;
const SEARCH_LIMIT_MAX = 50;

/**
 * 会话内容搜索的扫描边界（线性扫描回退路径的预算）。
 *
 * SQLite 下优先走 FTS5（见 store.searchMessages）；内存 store、<3 字符查询与
 * 「FTS 建不起来」的环境走这里的朴素做法：扫最近若干个会话 × 每个会话最近若干条，
 * 命中全部由 `listMessages` 的既有口径算出来。代价是更老的消息搜不到——所以响应里带
 * `truncated`，前端要如实告诉用户「只搜了最近这么多」。
 */
const SEARCH_MAX_CONVERSATIONS = 200;
const SEARCH_MAX_MESSAGES = 4000;
const SEARCH_MESSAGES_PER_CONVERSATION = 200;

/**
 * 命中片段：把消息正文压成一行，截匹配位置前后一小段。
 *
 * 必须压空白：工具输出/代码里大量换行与缩进，原样回给侧栏会把行高撑成一屏。
 * 返回 `null` 表示「这条不该算命中」（正文为空，或只有 E2E 加密后的空占位）。
 */
export function searchSnippet(text: string, query: string, pad = 30): string | null {
  const flat = text.replace(/\s+/g, " ").trim();
  if (!flat) return null;
  const at = flat.toLowerCase().indexOf(query.toLowerCase());
  if (at < 0) return null;
  const start = Math.max(0, at - pad);
  const end = Math.min(flat.length, at + query.length + pad * 2);
  return `${start > 0 ? "…" : ""}${flat.slice(start, end)}${end < flat.length ? "…" : ""}`;
}

/**
 * 登录失败限流：15 分钟滑动窗口内同一 `ip|username` 失败 10 次 → 429。
 * 注册按 IP：1 小时 20 次（注册更重，且注册成功才计数）。
 *
 * 为什么在内存里：单机单进程的部署形态，重启后清零可接受；不引入 Redis 一类依赖。
 */
const LOGIN_FAILURE_WINDOW_MS = 15 * 60 * 1000;
const LOGIN_FAILURE_MAX = 10;
const REGISTER_WINDOW_MS = 60 * 60 * 1000;
const REGISTER_MAX = 20;

export interface SlidingWindowLimiter {
  /** 已超限时返回建议的 Retry-After 秒数（>=1）；未超限返回 0。 */
  retryAfterSeconds(key: string, now?: number): number;
  /** 记一次失败（成功路径调用 reset）。 */
  record(key: string, now?: number): void;
  /** 成功登录后清零，不让「偶尔输错几次」长期粘在账上。 */
  reset(key: string): void;
}

/**
 * 内存滑动窗口限流器。
 * 键由调用方拼（登录是 `ip|username`，注册是 `ip`）；时间点用毫秒时间戳数组，
 * 每次访问时把滑出窗口的删掉——量级很小，不必上环形缓冲。
 */
export function createSlidingWindowLimiter(windowMs: number, max: number): SlidingWindowLimiter {
  const hits = new Map<string, number[]>();

  function live(key: string, now: number): number[] {
    const list = (hits.get(key) ?? []).filter((t) => now - t < windowMs);
    if (list.length > 0) hits.set(key, list);
    else hits.delete(key);
    return list;
  }

  return {
    retryAfterSeconds(key, now = Date.now()) {
      const list = live(key, now);
      if (list.length < max) return 0;
      // 最早一次失败滑出窗口后才能再试；向上取整到秒，至少 1。
      return Math.max(1, Math.ceil((windowMs - (now - list[0])) / 1000));
    },
    record(key, now = Date.now()) {
      const list = live(key, now);
      list.push(now);
      hits.set(key, list);
      // 攻击者可以用无限 username 撑爆 Map：超过阈值时整体清扫一次过期键。
      // O(n) 清理只在阈值以上触发，正常使用永远走不到。
      if (hits.size > 10_000) {
        for (const k of [...hits.keys()]) live(k, now);
      }
    },
    reset(key) {
      hits.delete(key);
    },
  };
}

/** 请求里的 Bearer token（没有则空串）。 */
function bearerToken(req: Request): string {
  const header = req.header("authorization") ?? "";
  return header.startsWith("Bearer ") ? header.slice(7) : "";
}

/** 限流用的客户端地址；取不到时用固定串（宁可全局限流，也不要意外放行）。 */
function clientIp(req: Request): string {
  return req.ip || req.socket.remoteAddress || "unknown";
}

export interface CreateAppOptions {
  /** 覆盖注册开关（优先于 HEMING_ALLOW_REGISTER），测试注入用；缺省读环境变量。 */
  allowRegister?: boolean;
  /** 云端插件目录（测试注入；缺省 HEMING_PLUGIN_DIR 或 <cwd>/plugins-catalog）。 */
  pluginDir?: string;
  /** 观测日志落点（测试注入）；缺省写 stdout（vitest 下静默）。 */
  logger?: (line: string) => void;
  /** 指标令牌覆盖（缺省读 HEMING_METRICS_TOKEN，调用时读取）。 */
  metricsToken?: string;
  /** 登录失败限流覆盖（测试用小窗口/小上限，不必真打十几次请求）。 */
  loginRateLimit?: { windowMs: number; max: number };
  /** 注册按 IP 限流覆盖。 */
  registerRateLimit?: { windowMs: number; max: number };
}

export function createApp(store: Store, opts?: CreateAppOptions): express.Express {
  // 环境变量在 createApp 调用时读取（非 module 级缓存），便于测试内 set/delete 后注入。
  const allowRegister = opts?.allowRegister ?? envFlagEnabled(process.env.HEMING_ALLOW_REGISTER);
  const loginLimiter = createSlidingWindowLimiter(
    opts?.loginRateLimit?.windowMs ?? LOGIN_FAILURE_WINDOW_MS,
    opts?.loginRateLimit?.max ?? LOGIN_FAILURE_MAX,
  );
  const registerLimiter = createSlidingWindowLimiter(
    opts?.registerRateLimit?.windowMs ?? REGISTER_WINDOW_MS,
    opts?.registerRateLimit?.max ?? REGISTER_MAX,
  );
  /**
   * 用户不存在时也跑一次等价的 scrypt：否则「不存在」明显更快，
   * 攻击者能用响应时间枚举账号（响应体文案一致还不够）。
   */
  const dummyPasswordHash = hashPassword(randomBytes(16).toString("hex"));
  const obs = createObservability({ sink: opts?.logger, metricsToken: opts?.metricsToken });
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
  // 最外层：先定/透传 x-request-id，finish 时统一落一行结构化日志与指标。
  // 放在 CORS 之前，预检 204 也有 request id 与计数。
  app.use(obs.middleware);
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
    const token = bearerToken(req);
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
   * 运行指标（d.236）：请求总数、状态码段、归一化路由计数、p50/p95、5xx 错误数。
   *
   * 访问控制（不暴露接口存在性）：
   * - 配置了 HEMING_METRICS_TOKEN → 一律要求 `Authorization: Bearer <token>`；
   * - 未配置 → 仅回环地址可读（本机运维/探针）；
   * - 其余一律 404，响应体与「路由不存在」完全相同。
   */
  app.get("/api/metrics", (req, res) => {
    if (!obs.metricsAllowed(req)) {
      res.status(404).json({ error: "接口不存在" });
      return;
    }
    res.json(obs.snapshot());
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
    // 注册按 IP 限流：放在解析 body 之前，恶意批量注册连 JSON 解析都不必做。
    const ipKey = clientIp(req);
    const registerRetry = registerLimiter.retryAfterSeconds(ipKey);
    if (registerRetry > 0) {
      res.setHeader("Retry-After", String(registerRetry));
      res.status(429).json({ error: "too many registrations" });
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
      // 只有真正建号成功才消耗 IP 配额：参数错/重名不该把人锁在门外。
      registerLimiter.record(ipKey);
      // 注册即视为一次活跃：名册「最近活跃」不应让刚注册的人显示为从未出现。
      store.touchUser(user.id);
      const expiresAt = sessionExpiryFromNow();
      res.status(201).json({ token: issueToken(store, user.id, expiresAt), expiresAt, user });
    } catch (e) {
      res.status(400).json({ error: (e as Error).message });
    }
  });

  /**
   * 登录失败限流：同一 `ip|username` 15 分钟内失败 10 次 → 429 + Retry-After。
   * 成功登录清零；失败响应统一 401 `invalid credentials`，不区分「用户不存在 / 密码错」。
   */
  app.post("/api/auth/login", (req, res) => {
    const parsed = LoginBodySchema.safeParse(req.body);
    if (!parsed.success) {
      res.status(400).json({ error: "invalid body" });
      return;
    }
    const limitKey = `${clientIp(req)}|${parsed.data.username}`;
    const retryAfter = loginLimiter.retryAfterSeconds(limitKey);
    if (retryAfter > 0) {
      // 超限时也不再透露账号是否存在——只看频率说话。
      res.setHeader("Retry-After", String(retryAfter));
      res.status(429).json({ error: "too many login attempts" });
      return;
    }
    const row = store.findUserByUsername(parsed.data.username);
    // 用户不存在也验证一次假哈希（等时）；两种失败走同一条记录与同一条响应。
    const passwordOk = verifyPassword(
      parsed.data.password,
      row?.passwordHash ?? dummyPasswordHash,
    );
    if (!row || !passwordOk) {
      loginLimiter.record(limitKey);
      res.status(401).json({ error: "invalid credentials" });
      return;
    }
    loginLimiter.reset(limitKey);
    store.touchUser(row.user.id);
    const expiresAt = sessionExpiryFromNow();
    res.json({ token: issueToken(store, row.user.id, expiresAt), expiresAt, user: row.user });
  });

  /**
   * 刷新 token（滑动续期）：旧 token 立即失效，新 token 重新计 30 天。
   *
   * 客户端在「剩余 <2 分钟」或收到 401 时调用（web `lib/api.ts` 单飞刷新）。
   * 先签新再吊销旧：任何一步异常都不会把用户留在「旧的已失效、新的没拿到」。
   */
  app.post("/api/auth/refresh", authOnly, (req, res) => {
    const current = bearerToken(req);
    const expiresAt = sessionExpiryFromNow();
    const token = issueToken(store, userId(req), expiresAt);
    revokeToken(store, current);
    res.json({ token, expiresAt });
  });

  /** 登出：吊销当前 token。客户端即使这次请求失败也会清本地（失败不阻断登出）。 */
  app.post("/api/auth/logout", authOnly, (req, res) => {
    revokeToken(store, bearerToken(req));
    res.status(204).end();
  });

  /** 退出所有设备：吊销该用户全部会话（含当前这条），返回吊销数量。 */
  app.delete("/api/auth/sessions", authOnly, (req, res) => {
    res.json({ revoked: revokeUserSessions(store, userId(req)) });
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

  // —— d.54 团队系统：名册 + 动向摘要（只在「同队成员」之间可见）——
  // 口径变更（用户反馈）：以前是「全站一个团队」，没建团队的人也能看到所有注册用户。
  // 现在可见集合 = 自己 + 与自己至少同属一个工作台团队的人（`listTeamCollaborators`）。

  /**
   * 把「同队可见」再收口到**某一个团队**（多团队支持）。
   *
   * 一个人可以同时属于多个团队；请求带 `teamId` 时，页面只应看到这个团队的人与摘要。
   * - 返回 `null`：不是该团队成员 / 团队不存在 —— 调用方按 404 处理（不泄露团队是否存在）；
   * - 否则返回该团队全部成员的用户 id（含自己）。
   * 不带 `teamId` 时调用方沿用旧口径（所有同队成员的并集），保证旧客户端不破。
   */
  const teamScopeIds = (viewerId: string, teamId: string): string[] | null => {
    const snapshot = store.getWorkspaceTeam(teamId, viewerId);
    if (!snapshot) return null;
    return snapshot.members.map((m) => m.user.id);
  };

  /** 读 `?teamId=`：缺失 / 空串 / 非字符串都按「未指定」处理。 */
  const queryTeamId = (req: Request): string => {
    const raw = req.query.teamId;
    return typeof raw === "string" ? raw.trim() : "";
  };

  app.get("/api/team", authOnly, (req, res) => {
    const teamId = queryTeamId(req);
    const scope = teamId ? teamScopeIds(userId(req), teamId) : null;
    if (teamId && scope === null) {
      res.status(404).json({ error: "团队不存在" });
      return;
    }
    const members = store
      .listTeamCollaborators(userId(req))
      // 多团队：带了 teamId 就只留这个团队的人；不带 = 所有同队成员的并集（旧口径）。
      .filter((m) => (scope ? scope.includes(m.user.id) : true))
      .map((m) => ({
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

  /**
   * 动向写入护栏（此前写侧零护栏）。
   *
   * 动向是「主动推送」型写入，共享摘要每 60s 同步一次就可能发一批（≤50 条）：
   * 失控的客户端循环会让全站动向被一个人刷屏。这里加两道闸：
   * - 频控：每人 60s 内最多 120 次上报（正常使用远低于此，只挡失控循环）；
   * - 存量上限：每人最多 500 条，超出 429 让用户显式清除，而不是静默丢新动向。
   */
  const ACTIVITY_RATE_WINDOW_MS = 60_000;
  const ACTIVITY_RATE_MAX = 120;
  const ACTIVITY_MAX_PER_ACTOR = 500;
  const activityRate = new Map<string, number[]>();
  const takeActivityRateToken = (actorId: string): boolean => {
    const now = Date.now();
    const recent = (activityRate.get(actorId) ?? []).filter((t) => now - t < ACTIVITY_RATE_WINDOW_MS);
    if (recent.length >= ACTIVITY_RATE_MAX) {
      activityRate.set(actorId, recent);
      return false;
    }
    recent.push(now);
    activityRate.set(actorId, recent);
    return true;
  };

  /**
   * 严格整型查询参数：只接受纯数字串。
   *
   * 之前用 Number.parseInt("5x") → 5、"abc" → NaN 回退默认值，
   * 等于把非法输入当合法参数静默吃掉（分页/截断都受影响）。
   */
  const parseIntStrict = (raw: unknown): number | null => {
    if (typeof raw !== "string" || !/^\d+$/.test(raw)) return null;
    const n = Number.parseInt(raw, 10);
    return Number.isFinite(n) ? n : null;
  };

  app.get("/api/team/activities", authOnly, (req, res) => {
    let limit = 50;
    if (req.query.limit !== undefined) {
      const parsedLimit = parseIntStrict(req.query.limit);
      if (parsedLimit === null || parsedLimit < 1) {
        res.status(400).json({ error: "limit 不合法" });
        return;
      }
      limit = Math.min(100, parsedLimit);
    }
    const before = typeof req.query.before === "string" ? req.query.before : undefined;
    const actorId = typeof req.query.actorId === "string" ? req.query.actorId : undefined;
    if (before !== undefined && !Number.isFinite(Date.parse(before))) {
      res.status(400).json({ error: "invalid before" });
      return;
    }
    // 唯一游标：before 只有毫秒精度，同一时间戳的剩余条目靠 beforeId 继续翻
    //（客户端传上一页最后一条的 id）。只传 before = 旧语义；给了值但不合法 → 400。
    const rawBeforeId = req.query.beforeId;
    let beforeId: string | undefined;
    if (rawBeforeId !== undefined) {
      if (typeof rawBeforeId !== "string" || !rawBeforeId.trim()) {
        res.status(400).json({ error: "beforeId 不合法" });
        return;
      }
      beforeId = rawBeforeId.trim();
    }
    // beforeId 必须配合 before：单传 beforeId 在旧实现里被静默忽略（返回第一页），
    // 客户端以为翻到了下一页、实际是原地重读——显式 400 好过静默错位。
    if (beforeId !== undefined && before === undefined) {
      res.status(400).json({ error: "beforeId 需要配合 before 使用" });
      return;
    }
    // 可见范围：同队成员；带 `?teamId=` 时再收口到该团队（多团队）。
    // actorId 若指定了不可见的人，直接给空列表——
    // 不返回 404/403，否则等于告诉对方「这个 user id 存在」。
    const teamId = queryTeamId(req);
    const scope = teamId ? teamScopeIds(userId(req), teamId) : null;
    if (teamId && scope === null) {
      res.status(404).json({ error: "团队不存在" });
      return;
    }
    const collaborators = store.listTeamCollaborators(userId(req));
    const visibleActorIds = collaborators
      .map((m) => m.user.id)
      .filter((id) => (scope ? scope.includes(id) : true));
    if (actorId !== undefined && !visibleActorIds.includes(actorId)) {
      res.json({ activities: [] });
      return;
    }
    // T2-02：收紧写侧之前入库的 task 行，title 仍是用户提问首行（隐私红线残留）。
    // db.ts 的迁移已清存量，这里再按 kind 强制投影一次兜底——旧库恢复、第三方导入、
    // 迁移没跑到的新建库都不该让 API 吐出提示词。与 web `labels.ts` 的 activityTitle() 同口径。
    const activities = store
      .listTeamActivities({ limit, before, beforeId, actorId, actorIds: visibleActorIds })
      .map((a) => (a.kind === "task" ? { ...a, title: TASK_ACTIVITY_TITLE } : a));
    res.json({ activities });
  });

  app.post("/api/team/activities", authOnly, (req, res) => {
    const parsed = CreateTeamActivitiesBodySchema.safeParse(req.body);
    if (!parsed.success) {
      res.status(400).json({ error: parsed.error.issues[0]?.message ?? "invalid body" });
      return;
    }
    if (!takeActivityRateToken(userId(req))) {
      res.status(429).json({ error: "上报太频繁，请稍后再试" });
      return;
    }
    if (store.countTeamActivities(userId(req)) >= ACTIVITY_MAX_PER_ACTOR) {
      res.status(429).json({ error: "动向摘要已达上限，请先清除" });
      return;
    }
    const actorId = userId(req);
    // T2-03：清除水位。挡住的是「清除前就已经存在的事件」——另一台设备/清了 localStorage
    // 的同一浏览器会用**相同 sourceId** 把它们原样重传，撤回会被无声撤销。
    // 清除之后新完成的任务 occurredAt=now > 清除时刻，仍然可以正常上报（这是对的）。
    const clearedAt = store.getTeamActivityClearedAt(actorId);
    let inserted = 0;
    let skipped = 0;
    for (const item of parsed.data.items) {
      if (clearedAt !== null && Date.parse(item.occurredAt) <= clearedAt) {
        skipped += 1;
        continue;
      }
      if (store.addTeamActivity(actorId, item)) inserted += 1;
      else skipped += 1;
    }
    res.status(inserted > 0 ? 201 : 200).json({ inserted, skipped });
  });

  app.delete("/api/team/activities/mine", authOnly, (req, res) => {
    const actorId = userId(req);
    store.clearTeamActivities(actorId);
    // 与用量侧同构：删行之外还要落服务端水位，否则「清除」只在执行清除的那台设备成立。
    store.setTeamActivityClearedAt(actorId, Date.now());
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
    const actorId = userId(req);
    // 清除水位过滤（P2-7）：清过之后旧日数据不许再传回来。
    // `date` 是**客户端本地自然日**，服务端没有时区信息，只能用 UTC 日键做粗判：
    // 严格小于「清除日」才丢，清除当天的聚合仍允许（客户端会按毫秒过滤，当天可能还有新用量）；
    // 宁可多丢一天，也不能放过整段回流（多设备 / 清了 localStorage 的那台会原样重传 30 天）。
    const clearedAt = store.getTeamUsageClearedAt(actorId);
    const clearedDay = clearedAt === null ? null : dayKeyUtc(new Date(clearedAt));
    const accepted =
      clearedDay === null
        ? parsed.data.items
        : parsed.data.items.filter((item) => item.date >= clearedDay);
    for (const item of accepted) store.upsertTeamUsage(actorId, item);
    // `written` = 实际入批条数（被水位拦下的不算）；`stored` = 该批去重后的行数。
    const stored = new Set(accepted.map((it) => `${it.date}\0${it.model}`)).size;
    res.status(200).json({ written: accepted.length, stored });
  });

  /**
   * 本人明细 + 同队排行。
   *
   * `range` 只接受 7d/30d；`to` 可选（客户端本地今天）——不传则用服务端 UTC 今天。
   * 排行只回聚合数与显示名，模型/连接名等明细只在 `self` 里出现。
   * 可见范围 = 同队成员：陌生人的用量行不参与聚合，`names` 也不查全站（否则泄漏显示名）。
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
    // 多团队：带 `?teamId=` 时排行只含该团队成员（不是成员 → 404，口径同名册）。
    const teamId = queryTeamId(req);
    const scope = teamId ? teamScopeIds(userId(req), teamId) : null;
    if (teamId && scope === null) {
      res.status(404).json({ error: "团队不存在" });
      return;
    }
    const collaborators = store
      .listTeamCollaborators(userId(req))
      .filter((m) => (scope ? scope.includes(m.user.id) : true));
    const rows = store.listTeamUsage({ ...bounds, actorIds: collaborators.map((m) => m.user.id) });
    const names = new Map(collaborators.map((m) => [m.user.id, m.user.displayName]));
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
    const actorId = userId(req);
    const deleted = store.clearTeamUsage(actorId);
    // 同步写服务端水位：客户端那份 `usageClearedAt` 只在 localStorage，换设备/清缓存就没了，
    // 另一台设备下一轮轮询会把刚删掉的 30 天数据原样传回来，等于没删。POST 侧按它丢弃旧日条目。
    store.setTeamUsageClearedAt(actorId, Date.now());
    res.json({ deleted });
  });

  // —— d.92 团队工作台：用户自建团队 / 目标 / 方案 / 任务 ——
  //
  // 接口口径（智能体侧走同一套 REST，权限只在服务端判一处）：
  // - 非成员访问团队 → 一律 404「团队不存在」：返回 403 等于告诉对方「这个 id 存在」；
  // - 成员但不是创建者做 owner-only 动作（改/删团队、加/移除成员、转让队长）→ 403；
  // - 成员可以自己退出团队（POST /leave）——被误拉进来的人必须能自救；
  // - owner 不能直接退出（409），先转让（POST /owner）或解散，团队不能无主；
  // - 方案与任务：团队成员都能写（任务可指派给成员、可挂到本团队的方案下）。

  /**
   * 派到我名下、还没完成的团队任务（队员的智能体靠它知道该干什么）；
   * `claimable`（d.260）是我所在团队里还没人认领的活——留空的派活不该只躺在团队页上。
   */
  app.get("/api/team/my-tasks", authOnly, (req, res) => {
    const id = userId(req);
    res.json({
      tasks: store.listAssignedTeamTasks(id),
      claimable: store.listClaimableTeamTasks(id),
    });
  });

  /** 我所在团队的简报（成员名单 + 我的角色），让组长的智能体能直接把活派到具体的人（d.253）。 */
  app.get("/api/team/my-teams", authOnly, (req, res) => {
    res.json({ teams: store.listTeamBriefs(userId(req)) });
  });

  /**
   * 团队动态（d.273）：只记一句「谁做了什么」，不存字段快照。
   *
   * 快照回答「现在是什么样」，动态回答「为什么会变成这样」；
   * 写入点放在路由层：内存实现与 SQLite 实现共用同一段拼句逻辑，不会两边说法不一致。
   */
  const clipEventText = (text: string, max = 60): string =>
    text.length > max ? `${text.slice(0, max)}…` : text;

  /**
   * 成员离开后，名下未完成的任务会被解绑成「待认领」（store 里保证）。
   * 这一步只补事件：否则团队动态只说「谁走了」，单件任务的历史里看不到
   * 「这件活为什么突然变成待认领」（d.278）。最多逐件记 10 条，其余写一条汇总。
   */
  const pushUnassignedTaskEvents = (
    teamId: string,
    actorId: string,
    before: Awaited<ReturnType<typeof store.getWorkspaceTeam>>,
    targetUserId: string,
    who: string,
  ): void => {
    const orphaned = (before?.tasks ?? []).filter(
      (task) => task.assigneeId === targetUserId && task.status !== "done",
    );
    for (const task of orphaned.slice(0, 10)) {
      pushTeamEvent(teamId, actorId, "task_updated", `因为 ${who} 离开团队，这件活回到「待认领」`, {
        id: task.id,
        title: task.title,
      });
    }
    if (orphaned.length > 10) {
      pushTeamEvent(
        teamId,
        actorId,
        "task_updated",
        `因为 ${who} 离开团队，另有 ${orphaned.length - 10} 件任务回到「待认领」`,
      );
    }
  };

  const pushTeamEvent = (
    teamId: string,
    actorId: string,
    kind: TeamEvent["kind"],
    summary: string,
    task?: { id: string; title: string } | null,
  ): void => {
    store.addTeamEvent({
      id: randomUUID(),
      teamId,
      taskId: task?.id ?? null,
      taskTitle: task?.title ?? "",
      actorId,
      kind,
      summary: clipEventText(summary, 500),
      createdAt: new Date().toISOString(),
    });
  };

  const TASK_STATUS_TEXT: Record<TeamTask["status"], string> = {
    todo: "未开始",
    doing: "进行中",
    done: "已完成",
    blocked: "有卡点",
  };
  const TASK_PRIORITY_TEXT: Record<NonNullable<TeamTask["priority"]>, string> = {
    low: "低",
    normal: "普通",
    high: "高",
  };

  const memberNameIn = (
    snapshot: ReturnType<Store["getWorkspaceTeam"]>,
    id: string | null,
  ): string => {
    if (id === null) return "待认领";
    const hit = snapshot?.members.find((m) => m.user.id === id);
    return hit ? hit.user.displayName : id;
  };
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
    // 团队动态（d.274）：添加成员也进时间线。
    const addedMember = result.members.find((m) => m.user.username === parsed.data.username);
    pushTeamEvent(
      req.params.id,
      userId(req),
      "member_added",
      `把 ${addedMember?.user.displayName ?? parsed.data.username} 加进了团队`,
    );
    res.json(result);
  });

  app.delete("/api/teams/:id/members/:userId", authOnly, (req, res) => {
    // 移除之后就拿不到名字了，先取快照（d.274）。
    const beforeRemove = store.getWorkspaceTeam(req.params.id, userId(req));
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
    const removedName = memberNameIn(beforeRemove, req.params.userId);
    pushTeamEvent(req.params.id, userId(req), "member_removed", `把 ${removedName} 移出了团队`);
    pushUnassignedTaskEvents(req.params.id, userId(req), beforeRemove, req.params.userId, removedName);
    res.json(result);
  });

  // 自己退出团队（P1-4）。刻意不用 DELETE /members/:userId —— 会被「移除别人」那条路由吃掉，
  // 而且语义是「我走」不是「owner 踢人」，单独一个动词更清楚。
  app.post("/api/teams/:id/leave", authOnly, (req, res) => {
    const beforeLeave = store.getWorkspaceTeam(req.params.id, userId(req));
    const result = store.leaveWorkspaceTeam(req.params.id, userId(req));
    if (result === null) {
      res.status(404).json({ error: "团队不存在" });
      return;
    }
    if (result === "owner") {
      res.status(409).json({ error: "队长请先转让团队再退出" });
      return;
    }
    const leaverName = memberNameIn(beforeLeave, userId(req));
    pushTeamEvent(req.params.id, userId(req), "member_removed", `${leaverName} 退出了团队`);
    pushUnassignedTaskEvents(req.params.id, userId(req), beforeLeave, userId(req), leaverName);
    res.status(204).end();
  });

  // 转让队长（P1-4）：owner 换号/离职前必须能把团队交出去，否则团队永久僵尸
  // （没有任何人能改名、加成员、删团队，也没人能移除这个 owner）。
  app.post("/api/teams/:id/owner", authOnly, (req, res) => {
    const parsed = TransferTeamOwnerBodySchema.safeParse(req.body);
    if (!parsed.success) {
      res.status(400).json({ error: parsed.error.issues[0]?.message ?? "invalid body" });
      return;
    }
    // 「转让给自己」是无意义动作：与其静默成功，不如明确告诉调用方。
    if (parsed.data.userId === userId(req)) {
      res.status(400).json({ error: "不能转让给自己" });
      return;
    }
    const beforeTransfer = store.getWorkspaceTeam(req.params.id, userId(req));
    const result = store.transferTeamOwnership(
      req.params.id,
      userId(req),
      parsed.data.userId,
    );
    if (result === null) {
      res.status(404).json({ error: "团队不存在" });
      return;
    }
    if (result === "forbidden") {
      res.status(403).json({ error: "只有团队创建者可以转让团队" });
      return;
    }
    if (result === "not_member") {
      res.status(400).json({ error: "只能转让给团队成员" });
      return;
    }
    pushTeamEvent(
      req.params.id,
      userId(req),
      "owner_transferred",
      `把队长转给了 ${memberNameIn(beforeTransfer, parsed.data.userId)}`,
    );
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
    // createTeamPlan 还会回 "not_found"（团队没了）；以前这里没接住，会 201 回一个字符串。
    if (result === "not_found") {
      res.status(404).json({ error: "团队不存在" });
      return;
    }
    // 团队动态（d.274）：方案也是团队里的一等公民，改动要留痕。
    pushTeamEvent(
      req.params.id,
      userId(req),
      "plan_added",
      `新建方案「${result.title}」${result.detail ? `：${clipEventText(result.detail, 40)}` : ""}`,
    );
    res.status(201).json(result);
  });

  app.patch("/api/teams/:id/plans/:planId", authOnly, (req, res) => {
    const parsed = UpdateTeamPlanBodySchema.safeParse(req.body);
    if (!parsed.success) {
      res.status(400).json({ error: parsed.error.issues[0]?.message ?? "invalid body" });
      return;
    }
    const planBefore = store
      .getWorkspaceTeam(req.params.id, userId(req))
      ?.plans.find((item) => item.id === req.params.planId);
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
    const changedLabels: string[] = [];
    if (parsed.data.title !== undefined) changedLabels.push("标题");
    if (parsed.data.detail !== undefined) changedLabels.push("说明");
    if (parsed.data.status !== undefined) changedLabels.push("状态");
    if (parsed.data.orderIndex !== undefined) changedLabels.push("排序");
    pushTeamEvent(
      req.params.id,
      userId(req),
      "plan_updated",
      `改了方案「${result.title}」${changedLabels.length > 0 ? `（${changedLabels.join("、")}）` : ""}`,
    );
    res.json(result);
  });

  app.delete("/api/teams/:id/plans/:planId", authOnly, (req, res) => {
    const planRemoved = store
      .getWorkspaceTeam(req.params.id, userId(req))
      ?.plans.find((item) => item.id === req.params.planId);
    const result = store.deleteTeamPlan(req.params.id, req.params.planId, userId(req));
    if (result === "not_found") {
      res.status(404).json({ error: "方案不存在" });
      return;
    }
    if (result === "forbidden") {
      res.status(403).json({ error: "只有团队成员可以删方案" });
      return;
    }
    if (planRemoved !== undefined) {
      pushTeamEvent(
        req.params.id,
        userId(req),
        "plan_removed",
        `删除了方案「${planRemoved.title}」`,
      );
    }
    res.status(204).end();
  });

  /**
   * 交付物必须指向共享文件库里的真实文件。
   *
   * 只存 id 不校验的后果：任务卡上「交付物」点开 404，而任务本身没有换附件的入口，
   * 用户只能删任务重派。共享库是「全站登录可见」口径（GET /api/files），
   * 所以这里只校验存在性、不校验属主。
   */
  const attachmentMissing = (fileId: string | null | undefined): boolean =>
    typeof fileId === "string" && store.getFile(fileId) === null;

  app.post("/api/teams/:id/tasks", authOnly, (req, res) => {
    const parsed = CreateTeamTaskBodySchema.safeParse(req.body);
    if (!parsed.success) {
      res.status(400).json({ error: parsed.error.issues[0]?.message ?? "invalid body" });
      return;
    }
    if (attachmentMissing(parsed.data.attachmentFileId)) {
      res.status(400).json({ error: "交付物文件不存在，请先在共享文件库上传" });
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
    if (result === "not_leader") {
      res.status(403).json({ error: "只有组长可以把任务派给别人（成员只能认领或做自己的）" });
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
    if (result === "blocker_not_found") {
      res.status(400).json({ error: "前置任务不存在或不属于这个团队" });
      return;
    }
    if (result === "blocker_cycle") {
      res.status(400).json({ error: "任务依赖不能成环，也不能依赖自己" });
      return;
    }
    const created = result as TeamTask;
    const createdSnap = store.getWorkspaceTeam(req.params.id, userId(req));
    const assignee =
      created.assigneeId === null ? null : memberNameIn(createdSnap, created.assigneeId);
    pushTeamEvent(
      req.params.id,
      userId(req),
      "task_added",
      `新建任务「${created.title}」${assignee ? `，派给 ${assignee}` : ""}${created.priority === "high" ? "（高优先级）" : ""}${created.dueAt ? `，截止 ${created.dueAt.slice(0, 10)}` : ""}`,
      created,
    );
    res.status(201).json(result);
  });

  app.get("/api/teams/:id/tasks/:taskId/comments", authOnly, (req, res) => {
    const snapshot = store.getWorkspaceTeam(req.params.id, userId(req));
    if (!snapshot) {
      res.status(404).json({ error: "团队不存在" });
      return;
    }
    if (!snapshot.tasks.some((t) => t.id === req.params.taskId)) {
      res.status(404).json({ error: "任务不存在" });
      return;
    }
    res.json({ comments: store.listTeamTaskComments(req.params.id, req.params.taskId) });
  });

  app.post("/api/teams/:id/tasks/:taskId/comments", authOnly, (req, res) => {
    const parsed = CreateTeamTaskCommentBodySchema.safeParse(req.body);
    if (!parsed.success) {
      res.status(400).json({ error: parsed.error.issues[0]?.message ?? "invalid body" });
      return;
    }
    const result = store.addTeamTaskComment(
      req.params.id,
      req.params.taskId,
      userId(req),
      parsed.data.text,
    );
    if (result === "forbidden") {
      res.status(403).json({ error: "只有团队成员可以在任务下留言" });
      return;
    }
    if (result === "not_found") {
      res.status(404).json({ error: "任务不存在" });
      return;
    }
    const commentSnap = store.getWorkspaceTeam(req.params.id, userId(req));
    const commentTask = commentSnap?.tasks.find((x) => x.id === req.params.taskId) ?? null;
    pushTeamEvent(
      req.params.id,
      userId(req),
      "task_comment",
      `在「${commentTask?.title ?? "任务"}」下留言：${clipEventText(parsed.data.text, 80)}`,
      commentTask,
    );
    res.status(201).json(result);
  });

  app.patch("/api/teams/:id/tasks/:taskId", authOnly, (req, res) => {
    const parsed = UpdateTeamTaskBodySchema.safeParse(req.body);
    if (!parsed.success) {
      res.status(400).json({ error: parsed.error.issues[0]?.message ?? "invalid body" });
      return;
    }
    if (attachmentMissing(parsed.data.attachmentFileId)) {
      res.status(400).json({ error: "交付物文件不存在，请先在共享文件库上传" });
      return;
    }
    const patchBeforeSnap = store.getWorkspaceTeam(req.params.id, userId(req));
    const patchBeforeTask = patchBeforeSnap?.tasks.find((x) => x.id === req.params.taskId) ?? null;
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
      res.status(403).json({
        error: "只能改自己名下的任务（还没人认领的可以先认领）；别人的任务请让组长改派或调整",
      });
      return;
    }
    if (result === "not_leader") {
      res.status(403).json({ error: "只有组长可以把任务派给别人（成员只能认领或做自己的）" });
      return;
    }
    if (result === "blocker_not_found") {
      res.status(400).json({ error: "前置任务不存在或不属于这个团队" });
      return;
    }
    if (result === "blocker_cycle") {
      res.status(400).json({ error: "任务依赖不能成环，也不能依赖自己" });
      return;
    }
    if (result === "not_nudgeable") {
      res.status(400).json({ error: "只能催办派给别人、还没完成的任务：自己的活不用催，没人认领的先派人，已完成的不用催" });
      return;
    }
    if (result === "not_reviewable") {
      res.status(400).json({ error: "只有已完成的任务可以验收：先让它把任务标完成，再点验收" });
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
    const patchAfter = result as TeamTask;
    const body = parsed.data;
    const parts: string[] = [];
    const label = patchAfter.title;
    if (body.nudge === true) parts.push(`催了「${label}」一次（第 ${patchAfter.nudgeCount ?? 1} 次）`);
    if (body.review !== undefined) {
      parts.push(
        body.review === "approve"
          ? `验收通过「${label}」`
          : `把「${label}」打回重做：${patchAfter.reviewNote || "（没写原因）"}` ,
      );
    }
    if (body.assigneeId === null && patchBeforeTask?.assigneeId) {
      parts.push(`把「${label}」退回待认领${body.returnNote ? `：${clipEventText(body.returnNote, 60)}` : ""}`);
    } else if (body.assigneeId !== undefined && body.assigneeId !== null && body.assigneeId !== patchBeforeTask?.assigneeId) {
      const who = memberNameIn(patchBeforeSnap, body.assigneeId);
      parts.push(body.assigneeId === userId(req) ? `认领了「${label}」` : `把「${label}」派给 ${who}`);
    }
    if (body.status !== undefined && patchBeforeTask && body.status !== patchBeforeTask.status) {
      parts.push(`把「${label}」从${TASK_STATUS_TEXT[patchBeforeTask.status]}改成${TASK_STATUS_TEXT[body.status]}`);
    }
    if (body.priority !== undefined && patchBeforeTask && body.priority !== patchBeforeTask.priority) {
      parts.push(`把「${label}」的优先级改成${TASK_PRIORITY_TEXT[body.priority]}`);
    }
    if (body.progress !== undefined) parts.push(body.progress === "" ? `清掉了「${label}」的进展` : `更新了「${label}」的进展`);
    if (body.result !== undefined) parts.push(`更新了「${label}」的交付结论`);
    if (body.title !== undefined && patchBeforeTask && body.title !== patchBeforeTask.title) {
      parts.push(`把「${patchBeforeTask.title}」改名为「${body.title}」`);
    }
    if (body.detail !== undefined) parts.push(`改了「${label}」的需求说明`);
    if (body.dueAt !== undefined) {
      parts.push(patchAfter.dueAt ? `把「${label}」的截止改成 ${patchAfter.dueAt.slice(0, 10)}` : `去掉了「${label}」的截止`);
    }
    if (body.planId !== undefined) parts.push(`调整了「${label}」的归属方案`);
    if (body.blockedBy !== undefined) parts.push(`调整了「${label}」的前置依赖`);
    if (body.attachmentFileId !== undefined) parts.push(`换了「${label}」的交付物`);
    if (parts.length > 0) {
      pushTeamEvent(req.params.id, userId(req), "task_updated", parts.join("；"), patchAfter);
    }
    res.json(result);
  });

  app.delete("/api/teams/:id/tasks/:taskId", authOnly, (req, res) => {
    const removedSnap = store.getWorkspaceTeam(req.params.id, userId(req));
    const removedTask = removedSnap?.tasks.find((x) => x.id === req.params.taskId) ?? null;
    const result = store.deleteTeamTask(req.params.id, req.params.taskId, userId(req));
    if (result === "not_found") {
      res.status(404).json({ error: "任务不存在" });
      return;
    }
    if (result === "forbidden") {
      res.status(403).json({
        error: "只能删自己名下的任务（或自己创建、还没人认领的）；别人的任务请让组长处理",
      });
      return;
    }
    if (removedTask) {
      pushTeamEvent(req.params.id, userId(req), "task_removed", `删除了任务「${removedTask.title}」`, removedTask);
    }
    res.status(204).end();
  });

  app.get("/api/teams/:id/events", authOnly, (req, res) => {
    const snapshot = store.getWorkspaceTeam(req.params.id, userId(req));
    if (!snapshot) {
      res.status(404).json({ error: "团队不存在" });
      return;
    }
    const raw = Number(req.query.limit);
    const limit = Number.isFinite(raw) ? Math.min(100, Math.max(1, Math.trunc(raw))) : 30;
    // taskId（d.276）：可选，只看某一件活的流水（任务卡片里的「这件活的历史」）。
    const taskId = typeof req.query.taskId === "string" ? req.query.taskId : null;
    res.json({ events: store.listTeamEvents(req.params.id, limit, taskId) });
  });

  app.get("/api/conversations", authOnly, (req, res) => {
    const all = store.listConversations(userId(req));
    // d.130：客户端按页拉取（limit/offset）；不传 limit 保持旧行为返回全部，
    // 供旧客户端与测试使用。服务端先按最近活跃排序再切片——分页必须按同一序，
    // 否则「第一页」会随插入顺序变，翻页会漏/重。
    if (req.query.limit === undefined) {
      res.json(all);
      return;
    }
    const rawLimit = Number(req.query.limit);
    const rawOffset = Number(req.query.offset);
    const limit = Number.isFinite(rawLimit) ? Math.min(100, Math.max(1, Math.trunc(rawLimit))) : 30;
    const offset = Number.isFinite(rawOffset) ? Math.max(0, Math.trunc(rawOffset)) : 0;
    const sorted = [...all].sort((a, b) => {
      const at = a.lastMessageAt ? Date.parse(a.lastMessageAt) : 0;
      const bt = b.lastMessageAt ? Date.parse(b.lastMessageAt) : 0;
      return bt - at;
    });
    res.json(sorted.slice(offset, offset + limit));
  });

  // d.54：人类私聊/群聊已删除，会话入口只剩「与某个助手的一对一」。
  app.post("/api/conversations", authOnly, (req, res) => {
    const parsed = AgentConversationBodySchema.safeParse(req.body);
    if (!parsed.success) {
      res.status(400).json({ error: "invalid body" });
      return;
    }
    try {
      // 产品只有一个内置智能体：agentId 缺省/遗留值都归一到这里（store 内部也只认这一个）。
      const created = store.createAgentConversation(
        userId(req),
        parsed.data.agentId ?? SYSTEM_AGENT_ID,
        {
          fresh: parsed.data.fresh,
          title: parsed.data.title,
          workspace: parsed.data.workspace,
        },
      );
      const row = store.listConversations(userId(req)).find((c) => c.id === created.id);
      res.status(201).json(row ?? { ...created, unreadCount: 0 });
    } catch (e) {
      res.status(400).json({ error: (e as Error).message });
    }
  });

  // d.128：改会话标题（客户端在首条消息后写入；空串 = 清除）。成员之外一律 403。
  app.patch("/api/conversations/:id", authOnly, (req, res) => {
    const parsed = UpdateConversationBodySchema.safeParse(req.body);
    if (!parsed.success) {
      res.status(400).json({ error: "invalid body" });
      return;
    }
    if (!store.isMember(req.params.id, userId(req))) {
      res.status(403).json({ error: "forbidden" });
      return;
    }
    if (!store.updateConversationTitle(req.params.id, userId(req), parsed.data.title)) {
      res.status(404).json({ error: "conversation not found" });
      return;
    }
    const row = store.listConversations(userId(req)).find((c) => c.id === req.params.id);
    if (!row) {
      res.status(404).json({ error: "conversation not found" });
      return;
    }
    res.json(row);
  });

  // d.147.4.91.11：左栏工作区（本机文件夹）。分组只存路径；d.153.4.95.11 起这个路径
  // 在渲染层同时被当作该会话智能体的可写根（服务端仍只做分组，不做任何读写）。
  app.get("/api/workspaces", authOnly, (req, res) => {
    res.json(store.listWorkspaces(userId(req)));
  });

  app.post("/api/workspaces", authOnly, (req, res) => {
    const parsed = AddWorkspaceBodySchema.safeParse(req.body);
    if (!parsed.success) {
      res.status(400).json({ error: "invalid body" });
      return;
    }
    try {
      // 同一路径幂等：已存在就刷新 updated_at，前端不必先查再建。
      res.status(201).json(store.addWorkspace(userId(req), parsed.data.path));
    } catch (e) {
      res.status(400).json({ error: (e as Error).message });
    }
  });

  // 删工作区不删会话：还有会话挂在它下面时拒绝（409），调用方先让用户挪走或确认整组移出。
  app.delete("/api/workspaces", authOnly, (req, res) => {
    const path = typeof req.query.path === "string" ? req.query.path : "";
    if (!path) {
      res.status(400).json({ error: "path required" });
      return;
    }
    try {
      store.removeWorkspace(userId(req), path);
      res.status(204).end();
    } catch (e) {
      const msg = (e as Error).message;
      res.status(msg === "workspace in use" ? 409 : 400).json({ error: msg });
    }
  });

  // 把会话挪到工作区（null/空串 = 未分组）。成员之外一律 403。
  app.patch("/api/conversations/:id/workspace", authOnly, (req, res) => {
    const parsed = UpdateConversationWorkspaceBodySchema.safeParse(req.body);
    if (!parsed.success) {
      res.status(400).json({ error: "invalid body" });
      return;
    }
    if (!store.isMember(req.params.id, userId(req))) {
      res.status(403).json({ error: "forbidden" });
      return;
    }
    try {
      store.updateConversationWorkspace(req.params.id, userId(req), parsed.data.workspace);
    } catch (e) {
      res.status(404).json({ error: (e as Error).message });
      return;
    }
    const row = store.listConversations(userId(req)).find((c) => c.id === req.params.id);
    if (!row) {
      res.status(404).json({ error: "conversation not found" });
      return;
    }
    res.json(row);
  });

  // d.128：删除整段会话（消息一并删）。非成员 403、不存在 404。
  app.delete("/api/conversations/:id", authOnly, (req, res) => {
    try {
      store.deleteConversation(req.params.id, userId(req));
      res.status(204).end();
    } catch (e) {
      const msg = (e as Error).message;
      res.status(msg === "forbidden" ? 403 : msg === "conversation not found" ? 404 : 400).json({ error: msg });
    }
  });

  /**
   * d.197：会话内容搜索。
   *
   * 左栏原来的搜索只匹配会话名——长任务跑几十轮之后，用户记得的是「那句话在哪个会话
   * 里说过」，而不是会话标题。这里按消息正文搜，只搜「你所在的会话」（`listConversations`
   * 已按成员关系收口），不区分发送方。
   *
   * 三条口径：
   * - 只回**命中片段**，不回整条消息：侧栏要的是「哪段会话说过」，点进去再看原文；
   * - E2E 加密消息的 `payload.text` 在出站时已是空占位，天然搜不到，不额外报错；
   * - 扫描有上限，`truncated=true` 时前端必须说明「只搜了最近的部分」。
   */
  app.get("/api/conversations/search", authOnly, (req, res) => {
    const q = typeof req.query.q === "string" ? req.query.q.trim() : "";
    if (q.length < SEARCH_QUERY_MIN) {
      res.status(400).json({ error: `搜索词至少 ${SEARCH_QUERY_MIN} 个字符` });
      return;
    }
    if (q.length > SEARCH_QUERY_MAX) {
      res.status(400).json({ error: `搜索词最多 ${SEARCH_QUERY_MAX} 个字符` });
      return;
    }
    const rawLimit = Number(req.query.limit);
    const limit = Number.isFinite(rawLimit)
      ? Math.min(SEARCH_LIMIT_MAX, Math.max(1, Math.trunc(rawLimit)))
      : SEARCH_LIMIT_DEFAULT;

    const conversations = [...store.listConversations(userId(req))]
      .sort((a, b) => {
        const at = a.lastMessageAt ? Date.parse(a.lastMessageAt) : 0;
        const bt = b.lastMessageAt ? Date.parse(b.lastMessageAt) : 0;
        return bt - at;
      })
      .slice(0, SEARCH_MAX_CONVERSATIONS);

    type Hit = {
      conversationId: string;
      conversationTitle: string | null;
      lastMessageAt: string | null;
      messageId: string;
      senderType: string;
      createdAt: string;
      snippet: string;
    };

    /**
     * 快路径：SQLite 的 FTS5 索引（trigram）。同一会话只回最新一条、输出按会话最近
     * 活跃排序、limit/truncated 语义与下面的线性扫描完全一致。
     * 返回 null 表示「没有加速通道」（内存 store / 查询 <3 字符 / FTS 建不起来），
     * 此时原样走旧扫描——行为与以前完全相同。
     */
    const fts = store.searchMessages(q, {
      conversationIds: conversations.map((c) => c.id),
      limit,
      maxScanned: SEARCH_MAX_MESSAGES,
    });
    if (fts) {
      const byId = new Map(conversations.map((c) => [c.id, c]));
      const ftsHits: Hit[] = [];
      for (const h of fts.hits) {
        const conv = byId.get(h.conversationId);
        if (!conv) continue; // 理论不可达：索引查询已按会话集合收口
        const snippet = searchSnippet(h.text, q);
        if (!snippet) continue;
        ftsHits.push({
          conversationId: conv.id,
          conversationTitle: conv.title ?? null,
          lastMessageAt: conv.lastMessageAt ?? null,
          messageId: h.messageId,
          senderType: h.senderType,
          createdAt: h.createdAt,
          snippet,
        });
      }
      res.json({ hits: ftsHits, truncated: fts.truncated, scanned: fts.scanned });
      return;
    }

    const hits: Hit[] = [];
    let scanned = 0;
    let truncated = false;

    outer: for (const conv of conversations) {
      const messages = store.listMessages(conv.id, SEARCH_MESSAGES_PER_CONVERSATION);
      // 会话内从新往旧找：同一会话里只回一条（最新那条），列表上一行一个会话才不重复。
      for (let i = messages.length - 1; i >= 0; i -= 1) {
        scanned += 1;
        if (scanned > SEARCH_MAX_MESSAGES) {
          truncated = true;
          break outer;
        }
        const message = messages[i];
        const text = typeof message.payload?.text === "string" ? message.payload.text : "";
        const snippet = searchSnippet(text, q);
        if (!snippet) continue;
        hits.push({
          conversationId: conv.id,
          conversationTitle: conv.title ?? null,
          lastMessageAt: conv.lastMessageAt ?? null,
          messageId: message.id,
          senderType: message.senderType,
          createdAt: message.createdAt,
          snippet,
        });
        if (hits.length >= limit) break outer;
        break;
      }
    }

    res.json({ hits, truncated, scanned });
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
    // 文件删了但任务还指着它就是悬空引用：点开永远 404，用户也无处可修。
    store.detachTeamAttachment(req.params.id);
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

  // —— 智能体名册：产品只有唯一内置智能体（不可创建/修改/删除，对齐 Codex/Claude Code）——
  // 旧版的 POST /api/agents 与 PUT/DELETE /api/agents/:id 已随自建智能体功能删除，未匹配路由 → 404。

  app.get("/api/agents", authOnly, (_req, res) => {
    res.json(store.listAgents());
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

  // 未匹配路由兜底：必须是 JSON（T2-12）。
  // 以前落到 Express 默认 404 页（HTML `Cannot GET /api/xxx`），客户端 api() 用 JSON.parse
  // 解析失败后只能给英文兜底 `http 404`，排障时分不清「路由写错」还是「服务没起」。
  app.use((_req: Request, res: Response) => {
    if (res.headersSent) return;
    res.status(404).json({ error: "接口不存在" });
  });

  // 兜底错误处理：任何没被路由自己 catch 的异常都回中文 JSON。
  // 以前一律 500：body-parser 的坏 JSON（err.status=400）与超大 body（413）被改写成
  // 「服务器内部错误」，客户端/模型会以为是服务端故障。现在尊重 err.status，
  // 4xx 且带中文 message 的原样透出；body-parser 的两类技术文案映射成中文。
  app.use((err: unknown, _req: Request, res: Response, _next: NextFunction) => {
    if (res.headersSent) return;
    const status =
      typeof (err as { status?: unknown }).status === "number"
        ? (err as { status: number }).status
        : 500;
    const type = (err as { type?: unknown }).type;
    const bodyParserMessage =
      type === "entity.parse.failed"
        ? "请求体不是合法 JSON"
        : type === "entity.too.large"
          ? "请求体太大"
          : null;
    if (bodyParserMessage !== null) {
      res.status(status).json({ error: bodyParserMessage });
      return;
    }
    const errMessage = (err as { message?: unknown }).message;
    if (
      status >= 400 &&
      status < 500 &&
      typeof errMessage === "string" &&
      errMessage.trim() !== ""
    ) {
      // 4xx 是调用方问题：依赖抛出的中文 message 原样透出，不记成服务端故障。
      res.status(status).json({ error: errMessage });
      return;
    }
    console.error("[api] unhandled error", err);
    res.status(500).json({ error: "服务器内部错误" });
  });

  // 动向保留期（可选）：默认不设 HEMING_TEAM_ACTIVITY_RETENTION_DAYS = 永远保留（行为零变化）。
  // 设成正整数才启用：启动先清一次（别让刚部署的实例等一小时），之后每小时按
  // `occurredAt < now - N 天` 清一次。setInterval(...).unref() 必须：定时器不能挂住事件循环，
  // 否则 vitest worker / 优雅退出的进程会一直等它。
  const activityRetentionDays = parsePositiveIntEnv(process.env.HEMING_TEAM_ACTIVITY_RETENTION_DAYS);
  if (activityRetentionDays !== null) {
    const purgeExpiredActivities = (): void => {
      const cutoff = new Date(
        Date.now() - activityRetentionDays * 24 * 60 * 60 * 1000,
      ).toISOString();
      try {
        const removed = store.purgeTeamActivities(cutoff);
        if (removed > 0) {
          console.log(
            `[team] 清理过期动向 ${removed} 条（保留 ${activityRetentionDays} 天）`,
          );
        }
      } catch (err) {
        // 后台维护动作：失败只记日志，不能让保活的服务因为清理失败崩掉。
        console.error("[team] 清理过期动向失败", err);
      }
    };
    purgeExpiredActivities();
    setInterval(purgeExpiredActivities, 60 * 60 * 1000).unref();
  }

  // d.54：语音/视频通话随人类 IM 一并删除，不再提供 ICE 配置接口。
  return app;
}
