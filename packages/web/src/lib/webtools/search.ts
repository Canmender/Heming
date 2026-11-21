/**
 * 联网搜索：必应 / DuckDuckGo 网页版端点的请求与解析。
 *
 * 为什么不用各家搜索 API：用户要求「默认接更多常用工具 + 能联网搜索」，而产品口径是
 * **不引入额外配置/密钥**。所以这里走搜索引擎给无 JS 环境用的网页版结果页，
 * 不需要 API key；代价是它们**不是公开 API**，页面结构可能改版、也可能对高频请求
 * 回反爬页——因此把「解析不出结果」和「请求失败」都当成普通失败返回，由工具层
 * 告诉模型改用 `web_read` 或让用户提供链接，绝不抛错。
 *
 * 顺序上**必应优先**：DuckDuckGo 在中国大陆网络下不可达（实测 `html/lite` 均超时），
 * 而和鸣是 Windows 中文桌面应用，默认搜索必须先在国内网络能用；DuckDuckGo 留作兜底。
 *
 * 解析刻意保持宽松（必应按 `li.b_algo` 切段；DuckDuckGo 按 `result__a` / `result-link`
 * 标题锚点切段），因为各版本页面结构不同（lite 的摘要在 `<td>` 里，必应的结果链接
 * 有时还包一层 `bing.com/ck/a` 跳转）。
 *
 * 两个「为什么」补充：
 * - **多源合并**：必应偶尔只回 1–2 条（反爬降级页就是这样），只取第一个有结果的源会让
 *   模型拿着两条结果硬答；所以不足 `min(limit, 3)` 时再问 DuckDuckGo 并按 URL 去重补足。
 * - **缓存 + 限速**：模型很容易对同一句 query 连着搜两三次，每次都打外网既慢又容易吃反爬；
 *   5 分钟缓存挡重复，1.5 秒最小间隔让请求节奏像人。两者都是模块级状态，永不抛。
 */

import { httpRequest, type HttpRequestFn } from "./http.js";

/** 一条搜索结果。 */
export interface SearchResult {
  title: string;
  url: string;
  snippet: string;
}

export type SearchOutcome =
  | { ok: true; results: SearchResult[] }
  | { ok: false; error: string };

/** 必应网页版（GET 查询串，国内网络可用）。 */
export const SEARCH_BING_ENDPOINT = "https://www.bing.com/search";
/** DuckDuckGo 网页版（POST 表单，最接近浏览器行为）。 */
export const SEARCH_HTML_ENDPOINT = "https://html.duckduckgo.com/html/";
/** lite 版（GET 查询串），html 版失败/解析空时退回。 */
export const SEARCH_LITE_ENDPOINT = "https://lite.duckduckgo.com/lite/";

/** 单次搜索最多取几条（与 `summary`/脚注的 8 条上限一致）。 */
export const MAX_SEARCH_RESULTS = 8;
/** 摘要最多留多少字：再多只会挤占模型上下文。 */
const MAX_SNIPPET_CHARS = 300;
const MAX_TITLE_CHARS = 120;

/** 必应结果少于这个条数时再问 DuckDuckGo 补足：只有 1–2 条时模型很难据此作答。 */
const SECONDARY_FILL_THRESHOLD = 3;
/** 同一 query+limit 的缓存寿命：搜索结果是时效性内容，5 分钟够挡掉连续重试又不至于过时。 */
const SEARCH_CACHE_TTL_MS = 5 * 60_000;
/** 缓存最多留几条（LRU）：桌面端内存不宽裕，也避免长会话里 Map 无限增长。 */
const SEARCH_CACHE_MAX_ENTRIES = 16;
/** 两次真实搜索的最小间隔：必应/DDG 对高频请求会直接回反爬页，宁可慢一点也不吃闭门羹。 */
export const DEFAULT_SEARCH_MIN_INTERVAL_MS = 1500;

const NAMED_ENTITIES: Record<string, string> = {
  amp: "&",
  lt: "<",
  gt: ">",
  quot: '"',
  apos: "'",
  nbsp: " ",
  ensp: " ",
  emsp: " ",
  middot: "·",
  mdash: "—",
  ndash: "–",
  hellip: "…",
  ldquo: "“",
  rdquo: "”",
  lsquo: "‘",
  rsquo: "’",
};

/** 解码 HTML 实体（命名 + 十进制 + 十六进制；认不出的原样保留）。 */
export function decodeHtmlEntities(text: string): string {
  // HTML 允许 `&#X41;`（大写 X）与 `&#x41;`，两者都要认。
  return text.replace(/&(#[xX][0-9a-fA-F]+|#[0-9]+|[a-zA-Z]+);/g, (whole, body: string) => {
    if (body.startsWith("#x") || body.startsWith("#X")) {
      const code = Number.parseInt(body.slice(2), 16);
      return isScalarValue(code) ? safeFromCodePoint(code, whole) : whole;
    }
    if (body.startsWith("#")) {
      const code = Number.parseInt(body.slice(1), 10);
      return isScalarValue(code) ? safeFromCodePoint(code, whole) : whole;
    }
    return NAMED_ENTITIES[body.toLowerCase()] ?? whole;
  });
}

/**
 * 只接受 Unicode 标量值（d.412 回归）：U+D800–U+DFFF 是代理区，不是合法码点，
 * `String.fromCodePoint(0xD83D)` 不会抛错而是返回落单高代理 —— 这些文本会进模型工具结果。
 * HTML 数字实体引用本就不该解出代理区字符，越界/代理区一律原样保留。
 */
function isScalarValue(code: number): boolean {
  return Number.isFinite(code) && code > 0 && code <= 0x10ffff && !(code >= 0xd800 && code <= 0xdfff);
}

function safeFromCodePoint(code: number, fallback: string): string {
  try {
    return String.fromCodePoint(code);
  } catch {
    return fallback;
  }
}

/** 去标签 + 解实体 + 压缩空白（标题/摘要用）。 */
export function plainText(html: string): string {
  return decodeHtmlEntities(html.replace(/<[^>]*>/g, " ")).replace(/\s+/g, " ").trim();
}

/** 空白压缩（查询串、标题、摘要共用）。 */
export function collapseWhitespace(text: string): string {
  return text.replace(/\s+/g, " ").trim();
}

/** 标题用：直接删标签（不插空格），避免把「<strong>和鸣</strong>（汉语）」变成「和鸣 （汉语）」。 */
function titleText(html: string): string {
  return collapseWhitespace(decodeHtmlEntities(html.replace(/<[^>]*>/g, "")));
}

function truncate(text: string, max: number): string {
  const chars = Array.from(text);
  if (chars.length <= max) return text;
  return `${chars.slice(0, max - 1).join("")}…`;
}

/**
 * 把 DuckDuckGo 的结果链接还原成目标地址。
 *
 * 网页版把真实地址放在 `//duckduckgo.com/l/?uddg=<percent-encoded>&rut=…`，
 * 广告/内部跳转（`y.js` 等）还原不出来——直接丢掉，不放进结果里误导模型。
 */
export function unwrapDuckDuckGoLink(href: string): string {
  let raw = decodeHtmlEntities(href).trim();
  if (!raw) return "";
  if (raw.startsWith("//")) raw = `https:${raw}`;
  let url: URL;
  try {
    url = new URL(raw, "https://duckduckgo.com");
  } catch {
    return "";
  }
  const target = url.searchParams.get("uddg");
  if (target) {
    // URLSearchParams.get() 已经解过一层 percent-encoding（uddg 的值本身就是
    // 编码过的目标地址）。再 decodeURIComponent 一次会把 URL 里的 %20/%25
    // 解成裸空格/裸 %，把目标地址改坏。这里直接用解码后的值。
    const decoded = target.trim();
    return /^https?:\/\//i.test(decoded) ? decoded : "";
  }
  // 仍是 duckduckgo.com 的（含 /y.js 广告跳转）不是目标页
  if (/(^|\.)duckduckgo\.com$/i.test(url.hostname)) return "";
  if (url.protocol !== "http:" && url.protocol !== "https:") return "";
  return url.toString();
}

/** base64url（`-` `_`、无填充）解码成 UTF-8 文本；环境不支持就返回空串。 */
function decodeBase64Url(value: string): string {
  const normalized = value.replace(/-/g, "+").replace(/_/g, "/");
  const padded = normalized + "=".repeat((4 - (normalized.length % 4)) % 4);
  if (typeof atob !== "function") return "";
  try {
    const binary = atob(padded);
    const bytes = Uint8Array.from(binary, (char) => char.charCodeAt(0));
    return new TextDecoder().decode(bytes);
  } catch {
    return "";
  }
}

/**
 * 把必应的结果链接还原成目标地址。
 *
 * 必应的自然结果多数是直链，但部分结果包一层 `https://www.bing.com/ck/a?…&u=a1<base64url>`；
 * 解不出来的（广告、站内跳转）一律丢弃。
 */
export function unwrapBingLink(href: string): string {
  let raw = decodeHtmlEntities(href).trim();
  if (!raw) return "";
  if (raw.startsWith("//")) raw = `https:${raw}`;
  let url: URL;
  try {
    url = new URL(raw, "https://www.bing.com");
  } catch {
    return "";
  }
  if (/(^|\.)bing\.com$/i.test(url.hostname)) {
    if (url.pathname === "/ck/a") {
      const encoded = url.searchParams.get("u") ?? "";
      if (!encoded.startsWith("a1")) return "";
      const decoded = decodeBase64Url(encoded.slice(2)).trim();
      return /^https?:\/\//i.test(decoded) ? decoded : "";
    }
    return "";
  }
  if (url.protocol !== "http:" && url.protocol !== "https:") return "";
  return url.toString();
}

/** 从一段 HTML 里抓 `result__snippet` / `result-snippet` 的文本（html 版是 `<a>`，lite 版是 `<td>`）。 */
function snippetFrom(segment: string): string {
  const pattern = /<(a|div|td|span|p)\b[^>]*class\s*=\s*["'][^"']*\bresult[-_]{1,2}snippet\b[^"']*["'][^>]*>([\s\S]*?)<\/\1>/i;
  const match = pattern.exec(segment);
  return match ? plainText(match[2]) : "";
}

/** 标题锚点：`class="result__a"`（html 版）或 `class='result-link'`（lite 版）。 */
const TITLE_CLASS = /\b(result__a|result-link)\b/i;
const HREF_ATTR = /\bhref\s*=\s*(?:"([^"]*)"|'([^']*)')/i;

function hrefOf(attrs: string): string {
  const match = HREF_ATTR.exec(attrs);
  return match ? (match[1] ?? match[2] ?? "") : "";
}

/**
 * 解析 DuckDuckGo HTML 版结果页。
 *
 * 返回顺序即页面顺序，已去重（同一目标 URL 只留第一条）、已过滤非 http(s) 链接。
 * 反爬页/改版页解析不出东西时返回 `[]`（由调用方决定是报「没有结果」还是重试）。
 */
export function parseDuckDuckGoHtml(html: string): SearchResult[] {
  return parseAnchorResults(html);
}

/** 解析 DuckDuckGo lite 版结果页（标题仍是 `result-link` 锚点，摘要按整段文本抓）。 */
export function parseDuckDuckGoLite(html: string): SearchResult[] {
  const results = parseAnchorResults(html);
  if (results.length) return results;
  // lite 版偶尔不带 class，只有 `href` + 序号表格：退回按表格行宽松解析
  return parseLiteTableRows(html);
}

/** 两个版本共用的锚点解析：标题锚点切段，段内找摘要。 */
function parseAnchorResults(html: string): SearchResult[] {
  const anchors: { index: number; end: number; attrs: string; body: string }[] = [];
  const pattern = /<a\b([^>]*)>([\s\S]*?)<\/a>/gi;
  for (let match = pattern.exec(html); match; match = pattern.exec(html)) {
    if (TITLE_CLASS.test(match[1])) {
      anchors.push({
        index: match.index,
        end: match.index + match[0].length,
        attrs: match[1],
        body: match[2],
      });
    }
  }
  const results: SearchResult[] = [];
  const seen = new Set<string>();
  for (let i = 0; i < anchors.length; i += 1) {
    const anchor = anchors[i];
    const url = unwrapDuckDuckGoLink(hrefOf(anchor.attrs));
    const title = truncate(titleText(anchor.body), MAX_TITLE_CHARS);
    if (!url || !title || seen.has(url)) continue;
    const nextIndex = i + 1 < anchors.length ? anchors[i + 1].index : html.length;
    const snippet = truncate(snippetFrom(html.slice(anchor.end, nextIndex)), MAX_SNIPPET_CHARS);
    seen.add(url);
    results.push({ title, url, snippet });
    if (results.length >= MAX_SEARCH_RESULTS) break;
  }
  return results;
}

/** lite 版宽松兜底：`<a href="…">标题</a>` 且 href 能还原出目标地址即算一条。 */
function parseLiteTableRows(html: string): SearchResult[] {
  const results: SearchResult[] = [];
  const seen = new Set<string>();
  const pattern = /<a\b([^>]*)>([\s\S]*?)<\/a>/gi;
  for (let match = pattern.exec(html); match; match = pattern.exec(html)) {
    const url = unwrapDuckDuckGoLink(hrefOf(match[1]));
    const title = truncate(titleText(match[2]), MAX_TITLE_CHARS);
    if (!url || !title || seen.has(url)) continue;
    seen.add(url);
    results.push({ title, url, snippet: "" });
    if (results.length >= MAX_SEARCH_RESULTS) break;
  }
  return results;
}

/**
 * 解析必应网页版结果页。
 *
 * 每条自然结果在 `<li class="b_algo">` 里：标题是 `<h2>` 内的第一个 `<a>`，
 * 摘要在 `<div class="b_caption"><p>` 里。没有 `<h2>` 的（视频/广告位）跳过。
 */
export function parseBingHtml(html: string): SearchResult[] {
  const segments: { start: number; bodyStart: number }[] = [];
  const listPattern = /<li\b[^>]*class\s*=\s*"[^"]*\bb_algo\b[^"]*"[^>]*>/gi;
  for (let match = listPattern.exec(html); match; match = listPattern.exec(html)) {
    segments.push({ start: match.index, bodyStart: match.index + match[0].length });
  }
  const results: SearchResult[] = [];
  const seen = new Set<string>();
  for (let i = 0; i < segments.length; i += 1) {
    const segment = html.slice(
      segments[i].bodyStart,
      i + 1 < segments.length ? segments[i + 1].start : html.length,
    );
    const heading = /<h2\b[^>]*>([\s\S]*?)<\/h2>/i.exec(segment);
    const anchor = heading ? /<a\b([^>]*)>([\s\S]*?)<\/a>/i.exec(heading[1]) : null;
    if (!anchor) continue;
    const url = unwrapBingLink(hrefOf(anchor[1]));
    const title = truncate(titleText(anchor[2]), MAX_TITLE_CHARS);
    if (!url || !title || seen.has(url)) continue;
    const paragraph = /<p\b[^>]*>([\s\S]*?)<\/p>/i.exec(segment);
    const snippet = truncate(paragraph ? plainText(paragraph[1]) : "", MAX_SNIPPET_CHARS);
    seen.add(url);
    results.push({ title, url, snippet });
    if (results.length >= MAX_SEARCH_RESULTS) break;
  }
  return results;
}

function clampLimit(raw: unknown): number {
  const n = typeof raw === "number" && Number.isFinite(raw) ? Math.trunc(raw) : 5;
  return Math.min(MAX_SEARCH_RESULTS, Math.max(1, n));
}

/** 合并时的上限夹紧：这里允许 0（表示「不要结果」），上限仍是 `MAX_SEARCH_RESULTS`。 */
function clampMergeLimit(raw: unknown): number {
  const n = typeof raw === "number" && Number.isFinite(raw) ? Math.trunc(raw) : MAX_SEARCH_RESULTS;
  return Math.min(MAX_SEARCH_RESULTS, Math.max(0, n));
}

/**
 * 结果 URL 的规范化形式，**只用于去重比较**（结果里仍保留搜索引擎给的原始链接）。
 *
 * 同一页面常被两个来源写成不同样子：末尾多一个 `/`、带 `#anchor`、host 大小写不同。
 * 不做归一就会把同一页当成两条，合并后模型看到重复链接还白占一条配额。
 */
export function normalizeResultUrl(url: string): string {
  const raw = typeof url === "string" ? url.trim() : "";
  if (!raw) return "";
  // 先切 #fragment：即便后面 URL 解析失败，同一页的不同锚点也不该算两条
  const withoutHash = raw.split("#")[0].trim();
  if (!withoutHash) return "";
  let parsed: URL;
  try {
    parsed = new URL(withoutHash);
  } catch {
    // 相对地址/坏数据：只做能确定的那一步（去末尾斜杠）
    return withoutHash.replace(/\/+$/, "");
  }
  // host 小写由 URL 构造器保证；路径大小写敏感不能动，所以按 协议+host+路径+查询 重建
  const pathname = parsed.pathname.replace(/\/+$/, "");
  return `${parsed.protocol}//${parsed.host.toLowerCase()}${pathname}${parsed.search}`;
}

/**
 * 合并两个来源的结果：`primary` 在前，按 {@link normalizeResultUrl} 去重，补足到 `limit`。
 *
 * 必应排前面是因为它对中文站点的收录更贴合和鸣用户，DuckDuckGo 只做补位；
 * 没标题、没网址的条目一律当坏数据丢掉（模型点开也读不到页）。
 */
export function mergeSearchResults(
  primary: SearchResult[],
  secondary: SearchResult[],
  limit: number,
): SearchResult[] {
  const capped = clampMergeLimit(limit);
  if (capped <= 0) return [];
  const merged: SearchResult[] = [];
  const seen = new Set<string>();
  const candidates = [...(Array.isArray(primary) ? primary : []), ...(Array.isArray(secondary) ? secondary : [])];
  for (const result of candidates) {
    if (!result || typeof result.url !== "string" || typeof result.title !== "string") continue;
    const key = normalizeResultUrl(result.url);
    if (!key || seen.has(key)) continue;
    if (!collapseWhitespace(result.title)) continue;
    seen.add(key);
    merged.push(result);
    if (merged.length >= capped) break;
  }
  return merged;
}

interface SearchCacheEntry {
  results: SearchResult[];
  expiresAt: number;
}

/** 模块级缓存：同一 query+limit 的连续重试（模型常这么干）不该重复打外网。 */
const searchCache = new Map<string, SearchCacheEntry>();

function cacheKeyOf(query: string, limit: number): string {
  // query 已过 collapseWhitespace，这里再小写：中英文关键词的大小写不该产生两份缓存
  return `${query.toLowerCase()}\u0000${limit}`;
}

function readCache(key: string): SearchResult[] | null {
  const entry = searchCache.get(key);
  if (!entry) return null;
  if (entry.expiresAt <= Date.now()) {
    searchCache.delete(key);
    return null;
  }
  // LRU：Map 的迭代顺序就是插入顺序，命中后挪到末尾即「最近用过」
  searchCache.delete(key);
  searchCache.set(key, entry);
  // 拷一份再给出去：调用方改动结果不该污染缓存
  return entry.results.map((result) => ({ ...result }));
}

function writeCache(key: string, results: SearchResult[]): void {
  // 失败不缓存：网络抖动/反爬是瞬时的，写进缓存只会让接下来 5 分钟一直失败
  if (!results.length) return;
  searchCache.delete(key);
  searchCache.set(key, {
    results: results.map((result) => ({ ...result })),
    expiresAt: Date.now() + SEARCH_CACHE_TTL_MS,
  });
  while (searchCache.size > SEARCH_CACHE_MAX_ENTRIES) {
    const oldest = searchCache.keys().next();
    if (oldest.done) break;
    searchCache.delete(oldest.value);
  }
}

/** 上一次真实搜索的开始时间（毫秒）；间隔按「开始时间」算，排队等待不叠加。 */
let lastSearchStartedAt = 0;
/** 真实搜索的排队尾巴：并发调用按到达顺序串起来，间隔约束对并发也成立。 */
let searchQueue: Promise<void> = Promise.resolve();

/** 清空缓存与限速状态。模块级状态会跨用例串味，单测在 `beforeEach` 里调用。 */
export function resetSearchState(): void {
  searchCache.clear();
  lastSearchStartedAt = 0;
  searchQueue = Promise.resolve();
}

function sleep(ms: number): Promise<void> {
  return new Promise<void>((resolve) => {
    setTimeout(resolve, ms);
  });
}

/**
 * 排队抢一个「可以发真实搜索」的时段，返回释放函数（调用方在 finally 里放行）。
 *
 * 为什么不直接拒绝：用户连着问两句时，第二句多等 1.5 秒还能拿到结果，
 * 直接报错只会让模型以为搜索坏了、转头去猜。也只有这样才保证「上一次搜索已经跑完」。
 */
async function acquireSearchSlot(minIntervalMs: number): Promise<() => void> {
  const previous = searchQueue;
  let release: () => void = () => undefined;
  searchQueue = new Promise<void>((resolve) => {
    release = resolve;
  });
  try {
    // 上一轮无论成功还是失败都要放行；这里的 catch 是「别人的失败不阻塞我」
    await previous.catch(() => undefined);
    const interval = Number.isFinite(minIntervalMs) && minIntervalMs > 0 ? minIntervalMs : 0;
    const waitMs = lastSearchStartedAt + interval - Date.now();
    if (waitMs > 0) await sleep(waitMs);
    lastSearchStartedAt = Date.now();
  } catch {
    // 排队/等待本身出问题也只能放行，否则后面的搜索会被永久堵在队列里
  }
  return release;
}

interface SearchAttempt {
  /** 报错时给模型看的名字。 */
  label: string;
  request: () => ReturnType<HttpRequestFn>;
  parse: (html: string) => SearchResult[];
}

/**
 * 跑一次单源尝试。网络错/非 2xx/解析空都折算成「空结果 + 一句中文原因」，
 * 由调用方决定还试不试下一个源——这里不抛错。
 */
async function runAttempt(attempt: SearchAttempt, limit: number, failures: string[]): Promise<SearchResult[]> {
  try {
    const response = await attempt.request();
    if (!response.ok) {
      failures.push(`${attempt.label}请求失败：${response.error}`);
      return [];
    }
    if (response.statusCode < 200 || response.statusCode >= 300) {
      failures.push(`${attempt.label}返回 HTTP ${response.statusCode}`);
      return [];
    }
    const results = attempt.parse(response.body).slice(0, limit);
    if (!results.length) failures.push(`${attempt.label}没有解析出结果（可能触发了反爬）`);
    return results;
  } catch (error) {
    failures.push(`${attempt.label}请求失败：${error instanceof Error ? error.message : String(error)}`);
    return [];
  }
}

/** 单次搜索的可选项（`request` / `minIntervalMs` 只给单测用）。 */
export interface SearchOptions {
  limit?: number;
  /** 注入假请求（生产走主进程 HTTP 桥）。 */
  request?: HttpRequestFn;
  /** 两次真实搜索的最小间隔（毫秒）；单测传 0 关掉，避免真的等。 */
  minIntervalMs?: number;
}

/**
 * 联网搜索（必应 → DuckDuckGo 网页版 → lite 版）。**永不抛**。
 *
 * 顺序：先必应；必应条数不够（少于 `min(limit, 3)`）时再借 DuckDuckGo 补足并合并，
 * 必应失败/反爬时按原顺序退回 DDG 网页版 → lite 版。全部失败返回 `{ ok: false, error }`，
 * 由工具层给出「改用 web_read / 让用户提供链接」的出路。
 *
 * 缓存与限速都是模块级状态：命中缓存直接返回（不发请求、不占限速名额），
 * 限速按「排队等待」实现，宁可慢一点也不给模型一个「搜索坏了」的错误。
 */
export async function searchWeb(query: string, options: SearchOptions = {}): Promise<SearchOutcome> {
  const q = collapseWhitespace(query);
  if (!q) return { ok: false, error: "搜索关键词为空" };
  const limit = clampLimit(options.limit);
  const request = options.request ?? httpRequest;

  const cacheKey = cacheKeyOf(q, limit);
  const cached = readCache(cacheKey);
  if (cached) return { ok: true, results: cached };

  const minIntervalMs =
    typeof options.minIntervalMs === "number" && Number.isFinite(options.minIntervalMs)
      ? Math.max(0, options.minIntervalMs)
      : DEFAULT_SEARCH_MIN_INTERVAL_MS;

  const htmlHeaders = {
    Accept: "text/html,application/xhtml+xml",
    "Accept-Language": "zh-CN,zh;q=0.9,en;q=0.8",
  };
  const bingAttempt: SearchAttempt = {
    label: "必应",
    // mkt + setlang 都指中文：只带 setlang 时必应仍可能按出口 IP 返回英文结果
    request: () =>
      request({
        url: `${SEARCH_BING_ENDPOINT}?q=${encodeURIComponent(q)}&mkt=zh-CN&setlang=zh-Hans`,
        method: "GET",
        headers: htmlHeaders,
      }),
    parse: parseBingHtml,
  };
  const htmlAttempt: SearchAttempt = {
    label: "DuckDuckGo 网页版",
    request: () =>
      request({
        url: SEARCH_HTML_ENDPOINT,
        method: "POST",
        headers: { ...htmlHeaders, "Content-Type": "application/x-www-form-urlencoded" },
        body: `q=${encodeURIComponent(q)}`,
      }),
    parse: parseDuckDuckGoHtml,
  };
  const liteAttempt: SearchAttempt = {
    label: "DuckDuckGo 精简版",
    request: () =>
      request({ url: `${SEARCH_LITE_ENDPOINT}?q=${encodeURIComponent(q)}`, method: "GET", headers: htmlHeaders }),
    parse: parseDuckDuckGoLite,
  };

  const release = await acquireSearchSlot(minIntervalMs);
  try {
    // 排队期间可能已有别的调用把同一 query 搜完写进缓存，再查一次能省一次请求
    const cachedAfterWait = readCache(cacheKey);
    if (cachedAfterWait) return { ok: true, results: cachedAfterWait };

    const failures: string[] = [];
    const fillTarget = Math.min(limit, SECONDARY_FILL_THRESHOLD);
    const primary = await runAttempt(bingAttempt, limit, failures);
    if (primary.length >= fillTarget) {
      writeCache(cacheKey, primary);
      return { ok: true, results: primary };
    }
    if (primary.length) {
      // 必应有结果但太少：借 DuckDuckGo 补足；必应仍排前面（中文站点收录更贴合）
      const htmlResults = await runAttempt(htmlAttempt, limit, failures);
      let merged = mergeSearchResults(primary, htmlResults, limit);
      if (merged.length < fillTarget) {
        const liteResults = await runAttempt(liteAttempt, limit, failures);
        merged = mergeSearchResults(merged, liteResults, limit);
      }
      // 合并后仍为空说明三条结果全是坏数据：别回一个「成功但没结果」，继续走兜底
      if (merged.length) {
        writeCache(cacheKey, merged);
        return { ok: true, results: merged };
      }
    }

    // 必应失败/反爬：保持原有顺序，DuckDuckGo 网页版 → lite 版
    const htmlResults = await runAttempt(htmlAttempt, limit, failures);
    if (htmlResults.length) {
      writeCache(cacheKey, htmlResults);
      return { ok: true, results: htmlResults };
    }
    const liteResults = await runAttempt(liteAttempt, limit, failures);
    if (liteResults.length) {
      writeCache(cacheKey, liteResults);
      return { ok: true, results: liteResults };
    }
    return { ok: false, error: failures.join("；") || "搜索失败" };
  } finally {
    release();
  }
}
