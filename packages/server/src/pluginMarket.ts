import express, { Router, type NextFunction, type Request, type Response } from "express";
import { existsSync, mkdirSync, readFileSync, renameSync, statSync, writeFileSync } from "node:fs";
import { extname, join, resolve, sep } from "node:path";
import {
  MarketIndexInvalidError,
  PLUGIN_CATALOG_ID_RE,
  PLUGIN_CATALOG_VERSION_RE,
  filterMarketByHostVersion,
  parseMarketIndex,
  type MarketIndex,
} from "@heming/shared";

/**
 * 云端插件市场索引 v2（d.105）：`<HEMING_PLUGIN_DIR>/market.json` 的「原样分发」。
 *
 * 分工（规格 §6.1）：
 * - 索引由**发布工具**（`scripts/publish-plugin.mjs --index`）在本地生成；服务端不扫描、
 *   不解析插件包、不生成索引，只把 market.json 当字节存/发。唯一的解析点是：
 *   ① 读取时校验顶层结构（坏索引要 500 而不是静默给空市场）；② 带 `?hostVersion=` /
 *   `?updatedSince=` 时按索引里已有的字符串过滤（只读索引，不碰插件包）。
 * - `detail.md` 与图标/截图等资源放在 `<id>/<version>/` 下，按白名单 + 大小上限原样分发。
 * - 写索引（PUT）复用既有的 `x-publish-key`（未配置密钥 = 关闭写接口）。
 *
 * 为什么单独一个文件：`app.ts` 的路由已经很长，而这里需要「先 raw 后 json」的中间件顺序
 * （PUT 的 body 必须原样落盘，不能让 `express.json` 重排字节），所以用独立 Router 挂载。
 */

/** 索引文件上限（= PUT 上限）：正常索引几十 KB；4MB 足够几千个插件。 */
export const MAX_MARKET_INDEX_BYTES = 4 * 1024 * 1024;
/** 详情文档上限：规格 §6.1 定的 64KB。 */
export const MAX_DETAIL_BYTES = 64 * 1024;
/** 单个资源文件上限：规格 §6.1 定的 2MB。 */
export const MAX_ASSET_BYTES = 2 * 1024 * 1024;

const ASSET_CONTENT_TYPES: Record<string, string> = {
  ".png": "image/png",
  ".jpg": "image/jpeg",
  ".jpeg": "image/jpeg",
  ".webp": "image/webp",
  ".svg": "image/svg+xml",
  ".ico": "image/x-icon",
};

/** 资源文件名：单段、以字母/数字开头，只允许 `字母数字._-`（天然挡掉 `..` 与路径分隔符）。 */
const ASSET_NAME_RE = /^[A-Za-z0-9][A-Za-z0-9._-]{0,127}$/;
/** 详情文件名：索引里的 `detail` 只允许版本目录下的单段 `.md`。 */
const DETAIL_FILE_RE = /^[A-Za-z0-9][A-Za-z0-9._-]{0,127}\.md$/i;

/** 索引读取结果：原样字节 + 解析后的结构（过滤时用）。 */
export interface MarketIndexSnapshot {
  bytes: Buffer;
  index: MarketIndex;
  /** `parseMarketIndex` 丢弃的坏条目说明；不阻断整份索引。 */
  warnings: string[];
}

/** 索引存在但无法解析（发布工具写坏 / 磁盘损坏）：路由层映射 500，不静默返回空市场。 */
export class MarketIndexCorruptError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "MarketIndexCorruptError";
  }
}

export type MarketWriteError = "too_large" | "invalid_json" | "invalid_object" | "invalid_index";

export type MarketWriteResult =
  | { ok: true; size: number; warnings: string[] }
  | { ok: false; error: MarketWriteError; message: string };

export interface PluginMarketService {
  readonly dir: string;
  /** 读索引；不存在返回 null；损坏抛 `MarketIndexCorruptError`。按 mtime+size 做内存缓存。 */
  readIndex(): MarketIndexSnapshot | null;
  /** 读 `<id>/<version>/detail.md`；不存在 null，超 64KB 返回 "too_large"。 */
  readDetail(id: string, version: string): Buffer | "too_large" | null;
  /** 读版本目录下的白名单资源；不存在/扩展名不允许/路径越界 null，超 2MB 返回 "too_large"。 */
  readAsset(id: string, version: string, file: string): { bytes: Buffer; contentType: string } | "too_large" | null;
  /** 校验并原子写索引（原样字节）；失败返回原因，不抛。 */
  writeIndex(bytes: Buffer): MarketWriteResult;
}

/**
 * `?updatedSince=` 过滤：只保留 `updatedAt` 晚于该时刻的插件条目。
 * 缺 `updatedAt` 的条目**保留**（无法证明它没变，宁可多发一条也不漏更新）。
 */
export function filterMarketByUpdatedSince(index: MarketIndex, sinceMs: number): MarketIndex {
  return {
    ...index,
    plugins: index.plugins.filter((plugin) => {
      if (!plugin.updatedAt) return true;
      const time = Date.parse(plugin.updatedAt);
      return Number.isNaN(time) ? true : time > sinceMs;
    }),
  };
}

/** 校验 id/版本段：直接复用 shared 的目录正则（与既有 `/api/plugins*` 同一字符集）。 */
function validSegment(id: string, version: string): boolean {
  return PLUGIN_CATALOG_ID_RE.test(id) && PLUGIN_CATALOG_VERSION_RE.test(version);
}

/** 解析索引字节：JSON 错误/顶层结构错误都翻译成 `MarketIndexCorruptError`。 */
function parseIndexBytes(bytes: Buffer): { index: MarketIndex; warnings: string[] } {
  let raw: unknown;
  try {
    raw = JSON.parse(bytes.toString("utf8"));
  } catch (error) {
    throw new MarketIndexCorruptError(
      `市场索引不是合法 JSON：${error instanceof Error ? error.message : String(error)}`,
    );
  }
  try {
    return parseMarketIndex(raw);
  } catch (error) {
    if (error instanceof MarketIndexInvalidError) {
      throw new MarketIndexCorruptError(error.message);
    }
    throw error;
  }
}

export function createPluginMarketService(opts: { dir: string }): PluginMarketService {
  const dir = opts.dir;
  const indexPath = join(dir, "market.json");
  /** 缓存键 = mtimeMs + size：替换索引（rename）或原地改写都会变。 */
  let cache: { key: string; snapshot: MarketIndexSnapshot } | null = null;

  function readVersionFile(id: string, version: string, file: string): { bytes: Buffer; size: number } | null {
    if (!validSegment(id, version)) return null;
    if (!existsSync(dir)) return null;
    const base = resolve(dir, id, version);
    const target = resolve(base, file);
    // 双保险：字符集已经挡住 `..`/分隔符，这里再确认解析结果仍在版本目录内。
    if (target !== join(base, file) || !target.startsWith(base + sep)) return null;
    try {
      const stat = statSync(target);
      if (!stat.isFile()) return null;
      return { bytes: readFileSync(target), size: stat.size };
    } catch {
      return null;
    }
  }

  function readIndex(): MarketIndexSnapshot | null {
    let stat;
    try {
      stat = statSync(indexPath);
    } catch {
      cache = null;
      return null;
    }
    if (!stat.isFile()) {
      cache = null;
      return null;
    }
    const key = `${stat.mtimeMs}:${stat.size}`;
    if (cache && cache.key === key) return cache.snapshot;
    const bytes = readFileSync(indexPath);
    const parsed = parseIndexBytes(bytes);
    const snapshot: MarketIndexSnapshot = { bytes, index: parsed.index, warnings: parsed.warnings };
    cache = { key, snapshot };
    return snapshot;
  }

  /**
   * 索引里 `versions[].detail` 指定的文件名（约定优先 `detail.md`）。
   * 只接受「版本目录下的单段 .md」：多段路径需要额外目录穿越面，而详情本来就只有一份。
   */
  function detailFileFromIndex(id: string, version: string): string | null {
    let snapshot: MarketIndexSnapshot | null;
    try {
      snapshot = readIndex();
    } catch {
      return null; // 索引坏了不影响按约定读 detail.md
    }
    if (!snapshot) return null;
    const plugin = snapshot.index.plugins.find((item) => item.id === id);
    const target = plugin?.versions.find((item) => item.version === version);
    const detail = target?.detail;
    if (typeof detail !== "string" || detail === "detail.md" || !DETAIL_FILE_RE.test(detail)) return null;
    return detail;
  }

  return {
    dir,
    readIndex,
    readDetail(id, version) {
      let found = readVersionFile(id, version, "detail.md");
      if (!found) {
        const alternate = detailFileFromIndex(id, version);
        if (alternate) found = readVersionFile(id, version, alternate);
      }
      if (!found) return null;
      if (found.size > MAX_DETAIL_BYTES) return "too_large";
      return found.bytes;
    },
    readAsset(id, version, file) {
      if (!ASSET_NAME_RE.test(file)) return null;
      const extension = extname(file).toLowerCase();
      const contentType = ASSET_CONTENT_TYPES[extension];
      if (!contentType) return null;
      const found = readVersionFile(id, version, file);
      if (!found) return null;
      if (found.size === 0 || found.size > MAX_ASSET_BYTES) return "too_large";
      return { bytes: found.bytes, contentType };
    },
    writeIndex(bytes) {
      if (bytes.length === 0) return { ok: false, error: "invalid_json", message: "请求体为空" };
      if (bytes.length > MAX_MARKET_INDEX_BYTES) {
        return { ok: false, error: "too_large", message: `市场索引过大（上限 ${MAX_MARKET_INDEX_BYTES / 1024 / 1024}MB）` };
      }
      let raw: unknown;
      try {
        raw = JSON.parse(bytes.toString("utf8"));
      } catch (error) {
        return {
          ok: false,
          error: "invalid_json",
          message: `请求体不是合法 JSON：${error instanceof Error ? error.message : String(error)}`,
        };
      }
      if (!raw || typeof raw !== "object" || Array.isArray(raw)) {
        return { ok: false, error: "invalid_object", message: "请求体必须是 JSON 对象" };
      }
      let warnings: string[];
      try {
        warnings = parseMarketIndex(raw).warnings;
      } catch (error) {
        if (error instanceof MarketIndexInvalidError) {
          return { ok: false, error: "invalid_index", message: error.message };
        }
        throw error;
      }
      try {
        mkdirSync(dir, { recursive: true });
        const tmp = join(dir, `.market.json.tmp-${process.pid}-${Date.now()}`);
        writeFileSync(tmp, bytes);
        renameSync(tmp, indexPath);
      } catch (error) {
        return {
          ok: false,
          error: "invalid_index",
          message: `索引写入失败：${error instanceof Error ? error.message : String(error)}`,
        };
      }
      cache = null;
      return { ok: true, size: bytes.length, warnings };
    },
  };
}

/** 只读字符串 query 参数（Express 5 的 query 值是 string | string[] | ParsedQs）。 */
function stringQuery(value: unknown): string {
  return typeof value === "string" ? value : "";
}

/**
 * 市场索引路由。**必须在 `app.use(express.json())` 之前挂载**：
 * PUT 的 body 要原样落盘（重排 JSON 会改变字节、也违背「服务端只存字节」），
 * 所以这里用路由级 `express.raw`，不能让全局 json 解析先消费掉。
 */
export function createPluginMarketRouter(opts: { dir: string; publishKey: string }): Router {
  const market = createPluginMarketService({ dir: opts.dir });
  const publishKey = opts.publishKey;
  const router = Router();

  function publishAuthorized(req: Request): boolean {
    if (!publishKey) return false;
    const given = String(req.header("x-publish-key") ?? "");
    return given.length === publishKey.length && given === publishKey;
  }

  router.get("/", (req, res) => {
    let snapshot: MarketIndexSnapshot | null;
    try {
      snapshot = market.readIndex();
    } catch (error) {
      console.error(`[plugin-market] 市场索引损坏：${error instanceof Error ? error.message : String(error)}`);
      res.status(500).json({ error: "市场索引损坏，请重新发布索引" });
      return;
    }
    if (!snapshot) {
      res.status(404).json({ error: "市场索引不存在" });
      return;
    }
    const hostVersion = stringQuery(req.query.hostVersion);
    const updatedSince = stringQuery(req.query.updatedSince);
    if (!hostVersion && !updatedSince) {
      res.setHeader("Content-Type", "application/json; charset=utf-8");
      if (snapshot.warnings.length > 0) {
        res.setHeader("X-Market-Warnings", String(snapshot.warnings.length));
      }
      res.send(snapshot.bytes);
      return;
    }
    let index = snapshot.index;
    if (updatedSince) {
      const sinceMs = Date.parse(updatedSince);
      if (Number.isNaN(sinceMs)) {
        res.status(400).json({ error: "updatedSince 必须是可解析的 ISO 时间" });
        return;
      }
      index = filterMarketByUpdatedSince(index, sinceMs);
    }
    if (hostVersion) index = filterMarketByHostVersion(index, hostVersion);
    if (snapshot.warnings.length > 0) {
      res.setHeader("X-Market-Warnings", String(snapshot.warnings.length));
    }
    res.setHeader("Content-Type", "application/json; charset=utf-8");
    res.json(index);
  });

  router.get("/assets/:id/:version/:file", (req, res) => {
    const found = market.readAsset(req.params.id, req.params.version, req.params.file);
    if (found === "too_large") {
      res.status(413).json({ error: `资源过大（上限 ${MAX_ASSET_BYTES / 1024 / 1024}MB）` });
      return;
    }
    if (!found) {
      res.status(404).json({ error: "资源不存在" });
      return;
    }
    res.setHeader("Content-Type", found.contentType);
    res.setHeader("X-Content-Type-Options", "nosniff");
    res.setHeader("Cache-Control", "public, max-age=600");
    res.send(found.bytes);
  });

  router.get("/:id/:version/detail", (req, res) => {
    const found = market.readDetail(req.params.id, req.params.version);
    if (found === "too_large") {
      res.status(413).json({ error: `详情文档过大（上限 ${MAX_DETAIL_BYTES / 1024}KB）` });
      return;
    }
    if (!found) {
      res.status(404).json({ error: "详情文档不存在" });
      return;
    }
    res.setHeader("Content-Type", "text/markdown; charset=utf-8");
    res.setHeader("X-Content-Type-Options", "nosniff");
    res.send(found);
  });

  router.put(
    "/",
    // 5MB 的解析上限 + 业务层 4MB 判断：让「超 4MB」走统一的 JSON 错误体，而不是 body-parser 的 HTML。
    express.raw({
      type: ["application/json", "application/octet-stream", "text/plain"],
      limit: "5mb",
    }),
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
      const result = market.writeIndex(bytes);
      if (!result.ok) {
        const status = result.error === "too_large" ? 413 : 400;
        res.status(status).json({ error: result.message });
        return;
      }
      res.status(200).json({ ok: true, size: result.size, warnings: result.warnings });
    },
  );

  // body-parser 的 413（>5MB）也翻译成 JSON 错误体，客户端不必解析 HTML。
  router.use((error: unknown, _req: Request, res: Response, next: NextFunction) => {
    const status = (error as { status?: number; type?: string })?.status;
    if (status === 413) {
      res.status(413).json({ error: `市场索引过大（上限 ${MAX_MARKET_INDEX_BYTES / 1024 / 1024}MB）` });
      return;
    }
    next(error);
  });

  return router;
}
