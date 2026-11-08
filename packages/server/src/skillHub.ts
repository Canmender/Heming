import { Router, type Request, type Response } from "express";
import { createHash } from "node:crypto";
import {
  SKILL_HUB_SOURCES,
  type SkillHubDetail,
  type SkillHubDownload,
  type SkillHubPage,
  type SkillHubRegisterResult,
  type SkillHubSkill,
  type SkillHubStatus,
} from "@heming/shared";
import { MAX_ZIP_BYTES, ZipError, readZipEntries } from "./zip.js";

/**
 * 技能社区（d.109）：把国内技能社区「虾评」代理成和鸣自己的 HTTP 接口。
 *
 * ## 为什么必须服务端代理
 * 虾评没有 CORS 响应头，浏览器直连会被拦；而且下载/注册需要用户自己的 API Key，
 * Key 只能从「当前用户的请求头」透传到上游——**不落库、不写日志、不共享**。
 *
 * ## 边界（与 shared 契约一致）
 * - 只处理**文本技能**：下载 zip 后解包，只交回 `SKILL.md` 正文与文件清单（path/size）；
 *   和鸣不执行包内脚本，也不把 zip 落盘；
 * - 上游字段在这里归一化成 `SkillHubSkill/Page/Detail` 形状，web 不接触上游 JSON；
 * - 上游失败翻译成中文可读错误（401/402/403 分类透传），不把上游英文栈暴露给用户。
 *
 * ## 可测性
 * 上游 base URL 用 `HEMING_SKILL_HUB_BASE` 覆盖；`HEMING_SKILL_HUB=off` 关闭入口。
 * 测试通过 `fetchImpl` 注入假上游，不打真实网络。
 */

const DEFAULT_BASE_URL = "https://xiaping.coze.com";
/** 列表/详情/注册/分类的上游超时。 */
const UPSTREAM_TIMEOUT_MS = 10_000;
/** 下载链接请求与 zip 下载的上游超时。 */
const DOWNLOAD_TIMEOUT_MS = 15_000;
/** 单次下载 zip 上限（与 shared `SkillHubDownload.size` 上限一致）。 */
const MAX_DOWNLOAD_BYTES = MAX_ZIP_BYTES;
/** SKILL.md 上限（契约 128KB）。 */
const MAX_SKILL_MD_BYTES = 128 * 1024;
const DEFAULT_PAGE_SIZE = 20;
const MAX_PAGE_SIZE = 30;

/** 技能 id：上游是 uuid，但只按「URL 段安全」校验，不绑死格式（换源也能用）。 */
const SKILL_ID_RE = /^[A-Za-z0-9][A-Za-z0-9_-]{0,127}$/;
/** 用户 API Key：`sk_xxx` / 旧 `agent-world-xxx` 都能过；只校验字符与长度，不校验语义。 */
const API_KEY_RE = /^[A-Za-z0-9._-]{8,200}$/;
/** 注册用户名白名单：中英文、数字、空格、下划线、连字符（防控制字符/HTML/路径注入）。 */
const REGISTER_NAME_RE = /^[\p{L}\p{N}_ -]{1,128}$/u;
/** 资源 id 只允许简单字符，避免拼 URL 时的编码歧义。 */
const UPSTREAM_SORT_RE = /^[a-z_]{1,20}$/;

const SOURCE = SKILL_HUB_SOURCES[0];

const UNAVAILABLE = "技能社区暂时不可用，请稍后重试";
const CLOSED = "技能社区已关闭（HEMING_SKILL_HUB=off）";

export interface SkillHubRouterOptions {
  /** 覆盖上游地址（测试注入）；缺省读 `HEMING_SKILL_HUB_BASE`。 */
  baseUrl?: string;
  /** 覆盖开关（测试注入）；缺省读 `HEMING_SKILL_HUB`。 */
  enabled?: boolean;
  /** 注入 fetch（测试注入）；缺省用全局 fetch。 */
  fetchImpl?: typeof fetch;
}

/** 只接受 http(s) 的 base URL；非法值回落到默认（不抛，避免配置错误把服务打挂）。 */
function resolveBaseUrl(raw: string | undefined): string {
  const text = (raw ?? "").trim() || DEFAULT_BASE_URL;
  try {
    const url = new URL(text);
    if (url.protocol !== "http:" && url.protocol !== "https:") return DEFAULT_BASE_URL;
    return `${url.origin}${url.pathname}`.replace(/\/+$/, "");
  } catch {
    return DEFAULT_BASE_URL;
  }
}

function isObject(value: unknown): value is Record<string, unknown> {
  return Boolean(value) && typeof value === "object" && !Array.isArray(value);
}

/**
 * 路由路径参数（Express 5 的 `req.params` 值类型是 `string | string[]`；路径段只会是 string）。
 */
function routeParam(req: Request, name: string): string {
  const value = (req.params as Record<string, string | string[]>)[name];
  return typeof value === "string" ? value : "";
}

function text(value: unknown, max: number): string {
  return typeof value === "string" ? value.slice(0, max) : "";
}

function textList(value: unknown, maxItems: number, maxLength: number): string[] {
  const list = Array.isArray(value) ? value : typeof value === "string" ? [value] : [];
  return list
    .filter((item): item is string => typeof item === "string" && item.trim().length > 0)
    .map((item) => item.trim().slice(0, maxLength))
    .slice(0, maxItems);
}

/** 上游数值可能是 null / 字符串 / 小数；统一成非负整数（坏值按 0）。 */
function count(value: unknown): number {
  const numeric = typeof value === "number" ? value : typeof value === "string" ? Number(value) : NaN;
  return Number.isFinite(numeric) && numeric > 0 ? Math.floor(numeric) : 0;
}

/** 上游 `requires_api_key` 实际是 nullable；只有明确的 true 才算「需要 Key」。 */
function flag(value: unknown): boolean {
  return value === true;
}

function messageOf(body: unknown): string | null {
  if (!isObject(body)) return null;
  const message = typeof body.error === "string" ? body.error.trim() : "";
  return message ? message.slice(0, 300) : null;
}

function sha256(buffer: Buffer): string {
  return createHash("sha256").update(buffer).digest("hex");
}

/** 上游一条技能 → 契约形状；id/name 缺失视为坏条目（跳过）。 */
function normalizeSkill(raw: unknown): SkillHubSkill | null {
  if (!isObject(raw)) return null;
  const id = text(raw.id, 128);
  const name = text(raw.name, 128);
  if (!id || !name) return null;
  return {
    id,
    name,
    description: text(raw.description, 2_000),
    triggers: textList(raw.trigger, 30, 64),
    categories: textList(raw.category, 8, 32),
    tags: textList(raw.tags, 20, 32),
    ownerName: text(raw.owner_name, 64),
    version: text(raw.current_version, 32),
    downloads: count(raw.downloads),
    // 契约的 stars 取「星标数」；上游 avg_stars 是加权分，不混用。
    stars: count(raw.star_count),
    status: text(raw.status, 32),
    requiresApiKey: flag(raw.requires_api_key),
    featured: flag(raw.is_featured),
    updatedAt: text(raw.updated_at, 40),
  };
}

/** 详情：在列表字段上补 created/version/security/homepage。 */
function normalizeDetail(raw: Record<string, unknown>, skill: SkillHubSkill): SkillHubDetail {
  const securityStatus = text(raw.security_status, 32);
  const securityReport = text(raw.security_report, 20_000);
  const homepage = text(raw.homepage, 500);
  return {
    ...skill,
    createdAt: text(raw.created_at, 40),
    versionCount: Math.max(1, count(raw.version_count)),
    ...(securityStatus ? { securityStatus } : {}),
    ...(securityReport ? { securityReport } : {}),
    ...(homepage ? { homepage } : {}),
  };
}

/** 从 SKILL.md 的 YAML frontmatter 里取 `name:`（没有就回落 id）。 */
function nameFromSkillMd(markdown: string): string | null {
  const frontmatter = /^---\r?\n([\s\S]*?)\r?\n---/.exec(markdown);
  if (!frontmatter) return null;
  const match = /^name:[ \t]*(.+)$/m.exec(frontmatter[1]);
  if (!match) return null;
  const value = match[1].trim().replace(/^["']|["']$/g, "");
  return value ? value.slice(0, 128) : null;
}

/** 选 SKILL.md：优先根目录，其次最浅的 `skill.md`（大小写不敏感）。 */
function pickSkillMd(entries: Array<{ path: string; size: number; data: Buffer }>) {
  const candidates = entries.filter((entry) => {
    const base = entry.path.split("/").pop()?.toLowerCase();
    return base === "skill.md";
  });
  if (candidates.length === 0) return null;
  candidates.sort((a, b) => {
    const depth = a.path.split("/").length - b.path.split("/").length;
    return depth !== 0 ? depth : a.path.localeCompare(b.path);
  });
  return candidates[0];
}

function isHttpUrl(value: string): boolean {
  try {
    const url = new URL(value);
    return url.protocol === "http:" || url.protocol === "https:";
  } catch {
    return false;
  }
}

function queryText(value: unknown, max: number): string {
  return typeof value === "string" ? value.trim().slice(0, max) : "";
}

function positiveInt(value: unknown, fallback: number): number {
  const numeric = typeof value === "string" ? Number(value) : typeof value === "number" ? value : NaN;
  return Number.isFinite(numeric) && numeric >= 1 ? Math.floor(numeric) : fallback;
}

interface UpstreamCall {
  method?: "GET" | "POST";
  headers?: Record<string, string>;
  body?: string;
  timeoutMs?: number;
}

interface UpstreamResponse {
  status: number;
  body: unknown;
}

export function createSkillHubRouter(opts: SkillHubRouterOptions = {}): Router {
  const baseUrl = resolveBaseUrl(opts.baseUrl ?? process.env.HEMING_SKILL_HUB_BASE);
  const enabled =
    opts.enabled ?? (process.env.HEMING_SKILL_HUB ?? "").trim().toLowerCase() !== "off";
  const fetchImpl: typeof fetch = opts.fetchImpl ?? fetch;
  const router = Router();

  function fail(res: Response, status: number, error: string): void {
    res.status(status).json({ error });
  }

  /** 调上游 JSON 接口：统一超时 + 非 JSON 容错；网络错误交给调用方映射 502。 */
  async function callUpstream(path: string, call: UpstreamCall = {}): Promise<UpstreamResponse> {
    const response = await fetchImpl(`${baseUrl}${path}`, {
      method: call.method ?? "GET",
      headers: {
        accept: "application/json",
        ...(call.body ? { "content-type": "application/json" } : {}),
        ...call.headers,
      },
      ...(call.body ? { body: call.body } : {}),
      signal: AbortSignal.timeout(call.timeoutMs ?? UPSTREAM_TIMEOUT_MS),
    });
    const raw = await response.text();
    let body: unknown = null;
    if (raw) {
      try {
        body = JSON.parse(raw);
      } catch {
        body = null;
      }
    }
    return { status: response.status, body };
  }

  /** 上游连通性探测：分类接口成功才认为 reachable。 */
  async function fetchCategories(): Promise<string[] | null> {
    try {
      const upstream = await callUpstream("/api/categories", { timeoutMs: 8_000 });
      if (upstream.status !== 200 || !isObject(upstream.body) || upstream.body.success !== true) return null;
      return textList(upstream.body.data, 40, 32);
    } catch {
      return null;
    }
  }

  async function handleList(req: Request, res: Response): Promise<void> {
    if (!enabled) {
      fail(res, 503, CLOSED);
      return;
    }
    const page = positiveInt(req.query.page, 1);
    const limit = Math.min(MAX_PAGE_SIZE, Math.max(1, positiveInt(req.query.limit, DEFAULT_PAGE_SIZE)));
    const params = new URLSearchParams({ page: String(page), limit: String(limit) });
    const search = queryText(req.query.search, 100);
    const category = queryText(req.query.category, 32);
    const sort = queryText(req.query.sort, 20);
    if (search) params.set("search", search);
    if (category) params.set("category", category);
    if (sort && UPSTREAM_SORT_RE.test(sort)) params.set("sort", sort);

    let upstream: UpstreamResponse;
    try {
      upstream = await callUpstream(`/api/skills?${params.toString()}`);
    } catch {
      fail(res, 502, UNAVAILABLE);
      return;
    }
    if (upstream.status !== 200 || !isObject(upstream.body)) {
      fail(res, 502, UNAVAILABLE);
      return;
    }
    if (upstream.body.success === false) {
      fail(res, 502, messageOf(upstream.body) ?? UNAVAILABLE);
      return;
    }
    const rawSkills = Array.isArray(upstream.body.skills) ? upstream.body.skills : [];
    const skills = rawSkills
      .map(normalizeSkill)
      .filter((skill): skill is SkillHubSkill => skill !== null);
    const total = count(upstream.body.total);
    const hasMore =
      typeof upstream.body.hasMore === "boolean" ? upstream.body.hasMore : total > page * limit;
    const result: SkillHubPage = {
      skills,
      total,
      hasMore,
      fetchedAt: new Date().toISOString(),
    };
    res.json(result);
  }

  async function handleDetail(req: Request, res: Response): Promise<void> {
    if (!enabled) {
      fail(res, 503, CLOSED);
      return;
    }
    const id = routeParam(req, "id");
    if (!SKILL_ID_RE.test(id)) {
      fail(res, 400, "技能 id 不合法");
      return;
    }
    let upstream: UpstreamResponse;
    try {
      upstream = await callUpstream(`/api/skills/${encodeURIComponent(id)}`);
    } catch {
      fail(res, 502, UNAVAILABLE);
      return;
    }
    if (upstream.status === 404) {
      fail(res, 404, "技能不存在或已下架");
      return;
    }
    if (upstream.status !== 200 || !isObject(upstream.body)) {
      fail(res, 502, UNAVAILABLE);
      return;
    }
    if (upstream.body.success === false) {
      fail(res, 502, messageOf(upstream.body) ?? UNAVAILABLE);
      return;
    }
    const raw = isObject(upstream.body.data) ? upstream.body.data : null;
    const skill = raw ? normalizeSkill(raw) : null;
    if (!raw || !skill) {
      fail(res, 502, "技能数据格式不正确");
      return;
    }
    res.json(normalizeDetail(raw, skill));
  }

  async function handleDownload(req: Request, res: Response): Promise<void> {
    if (!enabled) {
      fail(res, 503, CLOSED);
      return;
    }
    const id = routeParam(req, "id");
    if (!SKILL_ID_RE.test(id)) {
      fail(res, 400, "技能 id 不合法");
      return;
    }
    // Key 只从请求头取：不进 URL（会被日志/Referer 泄漏），不落库。
    const apiKey = String(req.header("x-skill-hub-key") ?? "").trim();
    if (!API_KEY_RE.test(apiKey)) {
      fail(res, 401, "需要先在虾评注册并填写 API Key");
      return;
    }

    let upstream: UpstreamResponse;
    try {
      upstream = await callUpstream(`/api/skills/${encodeURIComponent(id)}/download`, {
        headers: { authorization: `Bearer ${apiKey}` },
        timeoutMs: DOWNLOAD_TIMEOUT_MS,
      });
    } catch {
      fail(res, 502, "获取下载地址失败，请稍后重试");
      return;
    }
    if (upstream.status === 401) {
      fail(res, 401, "虾评 API Key 无效或已过期，请重新填写");
      return;
    }
    if (upstream.status === 402) {
      fail(res, 402, "虾评平台代币不足，无法下载该技能（和鸣不代扣）");
      return;
    }
    if (upstream.status === 403) {
      fail(res, 403, "虾评拒绝了下载（账号权限不足或该技能不可下载）");
      return;
    }
    if (upstream.status === 404) {
      fail(res, 404, "技能不存在或已下架");
      return;
    }
    if (upstream.status === 429) {
      fail(res, 429, "虾评请求过于频繁，请稍后再试");
      return;
    }
    if (upstream.status !== 200 || !isObject(upstream.body)) {
      fail(res, 502, UNAVAILABLE);
      return;
    }
    if (upstream.body.success === false) {
      fail(res, 502, messageOf(upstream.body) ?? UNAVAILABLE);
      return;
    }
    const data = isObject(upstream.body.data) ? upstream.body.data : null;
    const downloadUrl = typeof data?.download_url === "string" ? data.download_url : "";
    if (!downloadUrl || !isHttpUrl(downloadUrl)) {
      fail(res, 502, "虾评返回的下载地址不合法");
      return;
    }
    const version = text(data?.version, 32);
    const coinsSpent = count(data?.coins_spent);
    void coinsSpent; // 只用于日志脱敏后的信息，不返回给客户端（避免误导「和鸣扣费」）

    let zipResponse: Awaited<ReturnType<typeof fetch>>;
    try {
      zipResponse = await fetchImpl(downloadUrl, { signal: AbortSignal.timeout(DOWNLOAD_TIMEOUT_MS) });
    } catch {
      fail(res, 502, "下载技能包超时，请稍后重试");
      return;
    }
    if (!zipResponse.ok) {
      fail(res, 502, `下载技能包失败（虾评返回 ${zipResponse.status}）`);
      return;
    }
    const declaredLength = Number(zipResponse.headers?.get?.("content-length") ?? "0");
    if (Number.isFinite(declaredLength) && declaredLength > MAX_DOWNLOAD_BYTES) {
      fail(res, 413, `技能包超过 ${MAX_DOWNLOAD_BYTES / 1024 / 1024}MB 上限，无法安装`);
      return;
    }
    let bytes: Buffer;
    try {
      bytes = Buffer.from(await zipResponse.arrayBuffer());
    } catch {
      fail(res, 502, "读取技能包内容失败，请稍后重试");
      return;
    }
    if (bytes.length === 0) {
      fail(res, 502, "技能包内容为空");
      return;
    }
    if (bytes.length > MAX_DOWNLOAD_BYTES) {
      fail(res, 413, `技能包超过 ${MAX_DOWNLOAD_BYTES / 1024 / 1024}MB 上限，无法安装`);
      return;
    }

    let entries;
    try {
      entries = readZipEntries(bytes);
    } catch (error) {
      if (error instanceof ZipError) {
        if (error.code === "too_large" || error.code === "too_many_entries") {
          fail(res, 413, `技能包超出安装上限：${error.message}`);
          return;
        }
        if (error.code === "unsafe_path") {
          fail(res, 502, `技能包包含不安全的文件路径，已拒绝安装：${error.message}`);
          return;
        }
        fail(res, 502, `技能包无法解析：${error.message}`);
        return;
      }
      fail(res, 502, "技能包无法解析");
      return;
    }

    const skillEntry = pickSkillMd(entries);
    if (!skillEntry) {
      fail(res, 502, "技能包里没有 SKILL.md，无法安装");
      return;
    }
    if (skillEntry.data.length > MAX_SKILL_MD_BYTES) {
      fail(res, 413, `SKILL.md 超过 ${MAX_SKILL_MD_BYTES / 1024}KB 上限`);
      return;
    }
    const skillMd = skillEntry.data.toString("utf8");
    if (!skillMd.trim()) {
      fail(res, 502, "SKILL.md 内容为空");
      return;
    }

    const result: SkillHubDownload = {
      skillId: id,
      name: nameFromSkillMd(skillMd) ?? id,
      version,
      skillMd,
      files: entries
        .filter((entry) => entry !== skillEntry)
        .map((entry) => ({ path: entry.path, size: entry.size }))
        .slice(0, 200),
      zipSha256: sha256(bytes),
      size: bytes.length,
    };
    res.json(result);
  }

  async function handleRegister(req: Request, res: Response): Promise<void> {
    if (!enabled) {
      fail(res, 503, CLOSED);
      return;
    }
    const body = isObject(req.body) ? req.body : null;
    const name = typeof body?.name === "string" ? body.name.trim() : "";
    if (!name || name.length > 128 || !REGISTER_NAME_RE.test(name)) {
      fail(res, 400, "名称不合法：1–128 个字符，只能包含中英文、数字、空格、下划线或连字符");
      return;
    }
    let upstream: UpstreamResponse;
    try {
      upstream = await callUpstream("/api/auth/register", {
        method: "POST",
        body: JSON.stringify({ name }),
      });
    } catch {
      fail(res, 502, "注册失败：连接技能社区超时");
      return;
    }
    const upstreamError = messageOf(upstream.body);
    if (upstream.status === 400) {
      fail(res, 400, upstreamError ?? "虾评拒绝了该用户名");
      return;
    }
    if (upstream.status === 429) {
      fail(res, 429, "虾评注册太频繁（同 IP 限流），请稍后再试");
      return;
    }
    if (upstream.status !== 200 || !isObject(upstream.body)) {
      fail(res, 502, UNAVAILABLE);
      return;
    }
    if (upstream.body.success === false) {
      fail(res, 400, upstreamError ?? "注册失败，请检查名称后重试");
      return;
    }
    const data = isObject(upstream.body.data) ? upstream.body.data : {};
    const user = isObject(data.user) ? data.user : {};
    const apiKey =
      typeof data.api_key === "string"
        ? data.api_key
        : typeof user.api_key === "string"
          ? user.api_key
          : "";
    if (!API_KEY_RE.test(apiKey)) {
      fail(res, 502, "虾评返回的 Key 格式不正确");
      return;
    }
    const upstreamName = typeof user.name === "string" ? user.name.trim().slice(0, 128) : "";
    const result: SkillHubRegisterResult = {
      apiKey,
      ...(upstreamName ? { name: upstreamName } : {}),
    };
    // 只回给当前用户；server 不持久化、不写日志。
    res.json(result);
  }

  router.get("/", async (_req, res) => {
    if (!enabled) {
      const status: SkillHubStatus = {
        enabled: false,
        source: { ...SOURCE },
        reachable: false,
        categories: [],
      };
      res.json(status);
      return;
    }
    const categories = await fetchCategories();
    const status: SkillHubStatus = {
      enabled: true,
      source: { ...SOURCE },
      reachable: categories !== null,
      categories: categories ?? [],
    };
    res.json(status);
  });

  router.get("/skills", handleList);
  router.get("/skills/:id", handleDetail);
  router.get("/skills/:id/download", handleDownload);
  router.post("/register", handleRegister);

  return router;
}
