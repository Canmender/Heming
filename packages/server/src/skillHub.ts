import { Router, type Request, type Response } from "express";
import { createHash } from "node:crypto";
import { isIP } from "node:net";
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
/** 下载地址最多跟随的重定向次数（初始请求之外）。 */
const MAX_DOWNLOAD_REDIRECTS = 3;
/** 分类缓存 10 分钟；列表缓存 30 秒；条目上限 50（LRU）。 */
const CATEGORIES_TTL_MS = 10 * 60 * 1000;
const LIST_TTL_MS = 30 * 1000;
const CACHE_MAX_ENTRIES = 50;
const UNSAFE_DOWNLOAD = "下载地址不安全，已拒绝";
/** 一键注册的本机限流：每 IP 10 分钟最多 5 次（内存时间窗，service 重启即清空）。 */
const REGISTER_WINDOW_MS = 10 * 60 * 1000;
const REGISTER_MAX_ATTEMPTS = 5;
/** 只允许和鸣客户端触发「上游建号」：必须带自定义头；有 Origin 时还必须来自本机/Electron。 */
const HEMING_CLIENT_HEADER = "x-heming-client";
const LOOPBACK_ORIGIN_HOSTS = new Set(["localhost", "127.0.0.1", "::1"]);

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
  /** 是否允许 http 下载地址（测试注入）；缺省读 `HEMING_SKILL_HUB_ALLOW_HTTP=1`。 */
  allowHttp?: boolean;
  /** 注入时钟（测试注入，控制 TTL 而不真的等待）。 */
  now?: () => number;
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

/** 详情页 homepage 只保留 http(s) 绝对地址：上游是第三方内容，不能让 web 渲染 `javascript:`/`data:` 链接。 */
function safeHomepage(value: unknown): string | undefined {
  const candidate = text(value, 500).trim();
  if (!candidate) return undefined;
  try {
    const url = new URL(candidate);
    return url.protocol === "http:" || url.protocol === "https:" ? candidate : undefined;
  } catch {
    return undefined;
  }
}

/** 详情：在列表字段上补 created/version/security/homepage。 */
function normalizeDetail(raw: Record<string, unknown>, skill: SkillHubSkill): SkillHubDetail {
  const securityStatus = text(raw.security_status, 32);
  const securityReport = text(raw.security_report, 20_000);
  const homepage = safeHomepage(raw.homepage);
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

/** 下载地址校验结果：`ok=false` 时 reason 只描述类别，不回显主机信息。 */
export type DownloadUrlCheck = { ok: true; url: URL } | { ok: false; reason: string };

function ipv4Parts(host: string): number[] | null {
  const items = host.split(".");
  if (items.length !== 4) return null;
  const numbers = items.map((item) => (/^\d{1,3}$/.test(item) ? Number(item) : NaN));
  if (numbers.some((value) => !Number.isInteger(value) || value < 0 || value > 255)) return null;
  return numbers;
}

/** 拒绝回环 / 私网 / 链路本地 / 未指定地址（169.254.169.254 云元数据也在这段）。 */
function ipv4Blocked(parts: number[]): boolean {
  const [a, b] = parts;
  if (a === 0) return true; // 0.0.0.0/8
  if (a === 10) return true; // 10/8
  if (a === 127) return true; // 回环
  if (a === 169 && b === 254) return true; // 链路本地（含元数据地址）
  if (a === 172 && b >= 16 && b <= 31) return true; // 172.16/12
  if (a === 192 && b === 168) return true; // 192.168/16
  return false;
}

const HEXTET_RE = /^[0-9a-f]{1,4}$/;

/** 展开 IPv6 为 8 个 16 位段；支持 `::` 压缩与内嵌 IPv4（URL 会把内嵌 IPv4 规范化成 hex）。 */
function parseIpv6(host: string): number[] | null {
  let text = host.toLowerCase();
  const zone = text.indexOf("%");
  if (zone >= 0) text = text.slice(0, zone);
  let tail: number[] = [];
  const embedded = /(\d{1,3}\.\d{1,3}\.\d{1,3}\.\d{1,3})$/.exec(text);
  if (embedded) {
    const parts = ipv4Parts(embedded[1]);
    if (!parts) return null;
    tail = [(parts[0] << 8) | parts[1], (parts[2] << 8) | parts[3]];
    text = text.slice(0, text.length - embedded[1].length).replace(/:+$/, "");
    if (!text) text = "::";
  }
  const halves = text.split("::");
  if (halves.length > 2) return null;
  const toHextets = (value: string): number[] | null => {
    if (!value) return [];
    const items = value.split(":");
    return items.every((item) => HEXTET_RE.test(item)) ? items.map((item) => parseInt(item, 16)) : null;
  };
  const left = toHextets(halves[0]);
  const right = halves.length === 2 ? toHextets(halves[1]) : [];
  if (!left || !right) return null;
  if (halves.length === 1) {
    const all = [...left, ...tail];
    return all.length === 8 ? all : null;
  }
  const missing = 8 - left.length - right.length - tail.length;
  if (missing < 0) return null;
  return [...left, ...Array.from({ length: missing }, () => 0), ...right, ...tail];
}

function ipv6Blocked(hextets: number[]): boolean {
  const allZero = (values: number[]) => values.every((value) => value === 0);
  if (allZero(hextets)) return true; // ::
  if (allZero(hextets.slice(0, 7)) && hextets[7] === 1) return true; // ::1
  // IPv4-mapped（::ffff:a.b.c.d）与已废弃的 IPv4-compatible（::a.b.c.d）：按内嵌 IPv4 再判一次
  const firstFiveZero = allZero(hextets.slice(0, 5));
  if (firstFiveZero && (allZero(hextets.slice(0, 6)) || hextets[5] === 0xffff)) {
    const mapped = [hextets[6] >> 8, hextets[6] & 0xff, hextets[7] >> 8, hextets[7] & 0xff];
    if (ipv4Blocked(mapped)) return true;
  }
  if ((hextets[0] & 0xfe00) === 0xfc00) return true; // fc00::/7（唯一本地）
  if ((hextets[0] & 0xffc0) === 0xfe80) return true; // fe80::/10（链路本地）
  return false;
}

/**
 * 下载地址安全检查（SSRF 第一道闸）：协议 / 账号信息 / 内网字面量。
 *
 * 只检查 host 的**字面量**（不做 DNS 解析：解析结果本身不可控，且测试环境不能联网）。
 * 残余面：DNS 重绑定（域名解析到内网）仍需要部署侧出口防火墙兜底。
 */
export function checkDownloadUrl(raw: string, opts: { allowHttp?: boolean } = {}): DownloadUrlCheck {
  let url: URL;
  try {
    url = new URL(raw);
  } catch {
    return { ok: false, reason: "地址无法解析" };
  }
  const allowHttp = opts.allowHttp ?? false;
  const protocol = url.protocol.toLowerCase();
  if (protocol !== "https:" && !(protocol === "http:" && allowHttp)) {
    return { ok: false, reason: allowHttp ? "只允许 http(s) 下载地址" : "只允许 HTTPS 下载地址" };
  }
  if (url.username || url.password) return { ok: false, reason: "地址不允许包含账号信息" };
  const rawHost = url.hostname.toLowerCase().replace(/\.$/, "");
  const host = rawHost.startsWith("[") && rawHost.endsWith("]") ? rawHost.slice(1, -1) : rawHost;
  if (!host) return { ok: false, reason: "地址缺少主机名" };
  if (host === "localhost" || host.endsWith(".localhost")) {
    return { ok: false, reason: "不允许访问本机地址" };
  }
  const family = isIP(host);
  if (family === 4) {
    const parts = ipv4Parts(host);
    if (!parts || ipv4Blocked(parts)) return { ok: false, reason: "不允许访问内网地址" };
  } else if (family === 6) {
    const hextets = parseIpv6(host);
    if (!hextets) return { ok: false, reason: "地址无法解析" };
    if (ipv6Blocked(hextets)) return { ok: false, reason: "不允许访问内网地址" };
  }
  return { ok: true, url };
}

const REDIRECT_STATUSES = new Set([301, 302, 303, 307, 308]);

type DownloadFetchResult = { ok: true; bytes: Buffer } | { ok: false; status: number; error: string };

/**
 * 下载 zip：`redirect: "manual"` + 每一跳重新做 SSRF 校验 + 最多 3 次跟随。
 *
 * 不用 `redirect: "follow"`：fetch 的自动重定向会绕开第一跳校验（上游/攻击者只要 302 到内网）。
 */
async function fetchZipBytes(
  fetchImpl: typeof fetch,
  initial: URL,
  allowHttp: boolean,
): Promise<DownloadFetchResult> {
  let target = initial;
  for (let redirects = 0; ; redirects += 1) {
    let response: Awaited<ReturnType<typeof fetch>>;
    try {
      response = await fetchImpl(target.toString(), {
        redirect: "manual",
        signal: AbortSignal.timeout(DOWNLOAD_TIMEOUT_MS),
      });
    } catch {
      return { ok: false, status: 502, error: "下载技能包超时，请稍后重试" };
    }
    if (REDIRECT_STATUSES.has(response.status)) {
      const location = String(response.headers?.get?.("location") ?? "").trim();
      if (!location) return { ok: false, status: 502, error: "下载地址重定向缺少目标" };
      if (redirects >= MAX_DOWNLOAD_REDIRECTS) {
        return { ok: false, status: 502, error: "下载地址重定向次数过多，已拒绝" };
      }
      let next: URL;
      try {
        next = new URL(location, target);
      } catch {
        return { ok: false, status: 502, error: `${UNSAFE_DOWNLOAD}（重定向地址无法解析）` };
      }
      const checked = checkDownloadUrl(next.toString(), { allowHttp });
      if (!checked.ok) {
        return { ok: false, status: 502, error: `${UNSAFE_DOWNLOAD}（${checked.reason}）` };
      }
      target = checked.url;
      continue;
    }
    if (!response.ok) {
      return { ok: false, status: 502, error: `下载技能包失败（虾评返回 ${response.status}）` };
    }
    const declaredLength = Number(response.headers?.get?.("content-length") ?? "0");
    if (Number.isFinite(declaredLength) && declaredLength > MAX_DOWNLOAD_BYTES) {
      return {
        ok: false,
        status: 413,
        error: `技能包超过 ${MAX_DOWNLOAD_BYTES / 1024 / 1024}MB 上限，无法安装`,
      };
    }
    let bytes: Buffer;
    try {
      bytes = Buffer.from(await response.arrayBuffer());
    } catch {
      return { ok: false, status: 502, error: "读取技能包内容失败，请稍后重试" };
    }
    if (bytes.length === 0) return { ok: false, status: 502, error: "技能包内容为空" };
    if (bytes.length > MAX_DOWNLOAD_BYTES) {
      return {
        ok: false,
        status: 413,
        error: `技能包超过 ${MAX_DOWNLOAD_BYTES / 1024 / 1024}MB 上限，无法安装`,
      };
    }
    return { ok: true, bytes };
  }
}

interface CacheEntry<T> {
  value: T;
  expiresAt: number;
}

/** 极简 TTL + LRU 缓存：只放公开只读数据（下载/注册/带 Key 的请求永不经过它）。 */
function createTtlCache<T>(options: { ttlMs: number; max: number; now: () => number }) {
  const entries = new Map<string, CacheEntry<T>>();
  return {
    get(key: string): T | null {
      const hit = entries.get(key);
      if (!hit) return null;
      if (hit.expiresAt <= options.now()) {
        entries.delete(key);
        return null;
      }
      entries.delete(key); // 命中即刷新 LRU 顺序（Map 迭代顺序 = 插入顺序）
      entries.set(key, hit);
      return hit.value;
    },
    set(key: string, value: T): void {
      entries.delete(key);
      if (entries.size >= options.max) {
        const oldest = entries.keys().next().value;
        if (oldest !== undefined) entries.delete(oldest);
      }
      entries.set(key, { value, expiresAt: options.now() + options.ttlMs });
    },
    get size(): number {
      return entries.size;
    },
  };
}

function queryText(value: unknown, max: number): string {
  return typeof value === "string" ? value.trim().slice(0, max) : "";
}

/**
 * 「是否和鸣客户端」的最小防线（P1-5）：自定义头 + Origin 约束。
 *
 * 不能只靠 CORS：`/register` 会**在上游真的建号**，一旦被任意网页/脚本直接打，
 * 就是替别人刷账号。自定义头能挡住浏览器里的跨站表单/图片请求；Origin 再收一道到本机。
 */
function isHemingClient(req: Request): boolean {
  if (String(req.header(HEMING_CLIENT_HEADER) ?? "").trim() !== "1") return false;
  const origin = String(req.header("origin") ?? "").trim();
  if (!origin) return true; // 非浏览器客户端（curl/桌面主进程）没有 Origin
  if (origin === "null") return true; // Electron file:// / 沙箱页面
  try {
    const url = new URL(origin);
    if (url.protocol === "app:") return true;
    if (url.protocol !== "http:" && url.protocol !== "https:") return false;
    if (LOOPBACK_ORIGIN_HOSTS.has(url.hostname.replace(/^\[|\]$/g, ""))) return true;
    // 同源（部署在远端域名/端口的 Web 版）：Origin 与本次请求的 Host 一致即视为已知来源。
    const host = String(req.header("host") ?? "").trim().toLowerCase();
    return Boolean(host) && url.host.toLowerCase() === host;
  } catch {
    return false;
  }
}

/** 限流键：请求方 IP（supertest/本机是 `::ffff:127.0.0.1`，归一化成 IPv4 便于测试与日志）。 */
function clientKeyOf(req: Request): string {
  const raw = String(req.ip ?? req.socket.remoteAddress ?? "unknown");
  return raw.startsWith("::ffff:") ? raw.slice("::ffff:".length) : raw;
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
  /** 上游 `Retry-After`（429 时可能带；只透传数值/HTTP-date 文本，不回显英文栈）。 */
  retryAfter: string | null;
}

export function createSkillHubRouter(opts: SkillHubRouterOptions = {}): Router {
  const baseUrl = resolveBaseUrl(opts.baseUrl ?? process.env.HEMING_SKILL_HUB_BASE);
  const enabled =
    opts.enabled ?? (process.env.HEMING_SKILL_HUB ?? "").trim().toLowerCase() !== "off";
  const fetchImpl: typeof fetch = opts.fetchImpl ?? fetch;
  const allowHttp = opts.allowHttp ?? (process.env.HEMING_SKILL_HUB_ALLOW_HTTP ?? "").trim() === "1";
  const now = opts.now ?? (() => Date.now());
  /** 只缓存公开只读接口：分类 10 分钟、列表 30 秒（LRU 50 条）。 */
  const categoriesCache = createTtlCache<string[]>({ ttlMs: CATEGORIES_TTL_MS, max: 1, now });
  const listCache = createTtlCache<SkillHubPage>({ ttlMs: LIST_TTL_MS, max: CACHE_MAX_ENTRIES, now });
  /** register 的本机限流窗口（P1-5）：只服务这一个接口，不波及列表/详情/下载。 */
  const registerAttempts = new Map<string, number[]>();
  const router = Router();

  function fail(res: Response, status: number, error: string): void {
    res.status(status).json({ error });
  }

  /** 上游限流：中文文案 + 保留 Retry-After（不把上游英文错误体透给用户）。 */
  function failRateLimited(res: Response, retryAfter: string | null, message = "上游限流，请稍后重试"): void {
    res.status(429).json({ error: message, ...(retryAfter ? { retryAfter } : {}) });
  }

  /**
   * 本机限流：每 IP 10 分钟最多 5 次；命中返回 true（调用方 429）。
   * 只统计通过客户端校验的 register 调用，正常用一次不会影响其它接口。
   */
  function registerLimited(req: Request): boolean {
    const key = clientKeyOf(req);
    const windowStart = now() - REGISTER_WINDOW_MS;
    const history = (registerAttempts.get(key) ?? []).filter((at) => at > windowStart);
    if (history.length >= REGISTER_MAX_ATTEMPTS) {
      registerAttempts.set(key, history);
      return true;
    }
    history.push(now());
    registerAttempts.set(key, history);
    return false;
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
    const retryAfter = String(response.headers?.get?.("retry-after") ?? "").trim().slice(0, 64);
    const raw = await response.text();
    let body: unknown = null;
    if (raw) {
      try {
        body = JSON.parse(raw);
      } catch {
        body = null;
      }
    }
    return { status: response.status, body, retryAfter: retryAfter || null };
  }

  /** 上游连通性探测：分类接口成功才认为 reachable（成功结果缓存 10 分钟）。 */
  async function fetchCategories(): Promise<string[] | null> {
    const cached = categoriesCache.get("categories");
    if (cached) return cached;
    try {
      const upstream = await callUpstream("/api/categories", { timeoutMs: 8_000 });
      if (upstream.status !== 200 || !isObject(upstream.body) || upstream.body.success !== true) return null;
      const categories = textList(upstream.body.data, 40, 32);
      categoriesCache.set("categories", categories);
      return categories;
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
    const search = queryText(req.query.search, 100);
    const category = queryText(req.query.category, 32);
    const rawSort = queryText(req.query.sort, 20);
    const sort = rawSort && UPSTREAM_SORT_RE.test(rawSort) ? rawSort : "";
    const cacheKey = JSON.stringify([page, limit, search, category, sort]);
    const cached = listCache.get(cacheKey);
    if (cached) {
      // 命中缓存时 fetchedAt 保持「数据实际拉取时间」，不刷新成 now。
      res.json(cached);
      return;
    }
    const params = new URLSearchParams({ page: String(page), limit: String(limit) });
    if (search) params.set("search", search);
    if (category) params.set("category", category);
    if (sort) params.set("sort", sort);

    let upstream: UpstreamResponse;
    try {
      upstream = await callUpstream(`/api/skills?${params.toString()}`);
    } catch {
      fail(res, 502, UNAVAILABLE);
      return;
    }
    if (upstream.status === 429) {
      failRateLimited(res, upstream.retryAfter);
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
      fetchedAt: new Date(now()).toISOString(),
    };
    listCache.set(cacheKey, result);
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
    if (upstream.status === 429) {
      failRateLimited(res, upstream.retryAfter);
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
      failRateLimited(res, upstream.retryAfter, "虾评上游限流，请稍后重试");
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
    if (!downloadUrl) {
      fail(res, 502, "虾评返回的下载地址不合法");
      return;
    }
    // SSRF 第一道闸：协议只允许 https（http 需显式开启）、禁账号信息、禁内网字面量。
    const urlCheck = checkDownloadUrl(downloadUrl, { allowHttp });
    if (!urlCheck.ok) {
      fail(res, 502, `${UNSAFE_DOWNLOAD}（${urlCheck.reason}）`);
      return;
    }
    const version = text(data?.version, 32);
    const coinsSpent = count(data?.coins_spent);
    void coinsSpent; // 只用于日志脱敏后的信息，不返回给客户端（避免误导「和鸣扣费」）

    // 解包前先安全下载：manual 重定向 + 每跳复检 + 上限/超时都在 fetchZipBytes 里。
    const zipResult = await fetchZipBytes(fetchImpl, urlCheck.url, allowHttp);
    if (!zipResult.ok) {
      fail(res, zipResult.status, zipResult.error);
      return;
    }
    const bytes = zipResult.bytes;

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
    // P1-5：上游会真的建号，先确认调用方是和鸣客户端（自定义头 + 本机 Origin）。
    if (!isHemingClient(req)) {
      fail(res, 403, "仅限和鸣客户端调用");
      return;
    }
    const body = isObject(req.body) ? req.body : null;
    const name = typeof body?.name === "string" ? body.name.trim() : "";
    if (!name || name.length > 128 || !REGISTER_NAME_RE.test(name)) {
      fail(res, 400, "名称不合法：1–128 个字符，只能包含中英文、数字、空格、下划线或连字符");
      return;
    }
    if (registerLimited(req)) {
      fail(res, 429, "创建账号过于频繁，请稍后再试");
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
      failRateLimited(res, upstream.retryAfter, "虾评注册太频繁（上游限流，请稍后重试）");
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
