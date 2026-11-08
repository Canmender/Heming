import {
  comparePluginVersions,
  filterMarketByHostVersion,
  isVersionCompatible,
  parseMarketIndex,
  pickInstallVersion,
  type MarketIndex,
  type MarketParseResult,
  type MarketPlugin,
  type MarketVersion,
  type PluginCatalogEntry,
} from "@heming/shared";
import { API_BASE } from "../api.js";

/**
 * 云端插件市场 v2 客户端（d.108 · 阶段 B）。
 *
 * 市场索引是一份由发布工具生成的静态 JSON（`market.json`）：列表页需要的
 * 图标/分类/标签/每版本兼容性/生命周期都在里面，客户端拿一次即可渲染，
 * 不必为每个插件再拉清单。
 *
 * 边界（与 catalogClient 一致）：
 * - 服务端只存字节、不解析插件；客户端用 shared 的 `parseMarketIndex` 校验；
 * - **任何不可用都归类成 `MarketUnavailableError`**：调用方（插件页）据此回落到
 *   既有 v1「仓库」面板，而不是让市场 Tab 白屏；
 * - 单条坏数据只丢该条（`warnings`），不让整份索引失效；
 * - 下载/安装仍走既有链路：市场条目先映射成 `PluginCatalogEntry`，再交给
 *   `downloadPluginManifest` + 安装预览，**sha256 与权限校验一条不少**。
 */

export class MarketUnavailableError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "MarketUnavailableError";
  }
}

export interface MarketClientDeps {
  fetchImpl?: typeof fetch;
  /** 测试注入；缺省 `API_BASE`（空串 = 同源相对路径）。 */
  baseUrl?: string;
}

export interface FetchMarketIndexOptions extends MarketClientDeps {
  /** 宿主版本（`?hostVersion=`）：服务端过滤 + 客户端再过滤一次（双保险）。 */
  hostVersion?: string;
  /** 增量同步（`?updatedSince=`）：只返回该时间后变更的条目。 */
  updatedSince?: string;
}

export interface MarketIndexResult {
  index: MarketIndex;
  warnings: string[];
  source: "v2";
}

function baseUrlOf(deps: MarketClientDeps): string {
  return (deps.baseUrl ?? API_BASE).replace(/\/+$/, "");
}

function reasonOf(err: unknown): string {
  return err instanceof Error ? err.message : String(err);
}

/** 拉市场索引；404/网络/格式错误一律抛 `MarketUnavailableError`（调用方回落 v1）。 */
export async function fetchMarketIndex(
  options: FetchMarketIndexOptions = {},
): Promise<MarketIndexResult> {
  const fetchImpl = options.fetchImpl ?? fetch;
  const params = new URLSearchParams();
  if (options.hostVersion) params.set("hostVersion", options.hostVersion);
  if (options.updatedSince) params.set("updatedSince", options.updatedSince);
  const search = params.toString();
  const query = search ? `?${search}` : "";
  const url = `${baseUrlOf(options)}/api/plugin-market${query}`;

  let response: Response;
  try {
    response = await fetchImpl(url, { headers: { accept: "application/json" } });
  } catch (err) {
    throw new MarketUnavailableError(`市场目录不可用：${reasonOf(err)}`);
  }
  if (response.status === 404) {
    throw new MarketUnavailableError("市场目录暂未发布（HTTP 404）");
  }
  if (!response.ok) {
    throw new MarketUnavailableError(`市场目录不可用：HTTP ${response.status}`);
  }

  let raw: unknown;
  try {
    raw = await response.json();
  } catch (err) {
    throw new MarketUnavailableError(`市场目录不可用：返回的不是合法 JSON（${reasonOf(err)}）`);
  }

  let parsed: MarketParseResult;
  try {
    parsed = parseMarketIndex(raw);
  } catch (err) {
    throw new MarketUnavailableError(`市场目录不可用：${reasonOf(err)}`);
  }
  // 服务端带 `?hostVersion=` 时会过滤，但客户端仍兜底一次：目录可能由旧工具生成
  // 或缓存了未过滤版本；双保险与 shared 的同一实现同源。
  const index = options.hostVersion
    ? filterMarketByHostVersion(parsed.index, options.hostVersion)
    : parsed.index;
  return { index, warnings: parsed.warnings, source: "v2" };
}

/** 市场条目 → 既有安装弹窗认识的 `PluginCatalogEntry`（字段缺失给安全默认）。 */
export function indexToCatalogEntry(
  plugin: MarketPlugin,
  version: MarketVersion,
): PluginCatalogEntry {
  return {
    id: plugin.id,
    name: plugin.title ?? plugin.id,
    version: version.version,
    schemaVersion: version.schemaVersion,
    description: plugin.description ?? "",
    author: plugin.author ?? "",
    publishedAt: version.publishedAt,
    sha256: version.sha256,
    size: version.size,
    // 索引不携带权限/贡献明细（安装预览会从真实清单算），这里给保守默认值：
    // tools 取 "none" 不虚报权限；计数 0 只影响未打开详情的展示。
    permissions: { network: [], tools: "none", files: [] },
    contributions: {
      skills: 0,
      mcpServers: 0,
      commands: 0,
      toolPacks: 0,
      desktopWidgets: version.distribution === "bundle" ? 1 : 0,
    },
    distribution: version.distribution,
    ...(version.package ? { package: version.package } : {}),
  };
}

/** 选一个可安装的**声明式**版本：过滤 deleted / bundle / 不兼容，稳定版优先，版本降序。 */
export function pickDeclarativeVersion(
  plugin: MarketPlugin,
  hostVersion?: string,
): MarketVersion | null {
  const candidates = plugin.versions.filter((version) => {
    if (version.status === "deleted") return false;
    if (version.distribution !== "manifest") return false;
    if (hostVersion && !isVersionCompatible(version, hostVersion)) return false;
    return true;
  });
  if (candidates.length === 0) return null;
  const stable = candidates.filter((version) => (version.channel ?? "release") === "release");
  const pool = stable.length > 0 ? stable : candidates;
  return [...pool].sort((a, b) => comparePluginVersions(b.version, a.version))[0] ?? null;
}

/**
 * 市场里所有可安装的声明式插件（一条 = 一个插件的最新兼容版本）。
 * 供「回落列表」或命令面板/搜索复用；`removed` 的整插件不返回。
 */
export function declarativeEntries(index: MarketIndex, hostVersion?: string): PluginCatalogEntry[] {
  const out: PluginCatalogEntry[] = [];
  for (const plugin of index.plugins) {
    if (plugin.status === "removed") continue;
    const version = pickDeclarativeVersion(plugin, hostVersion);
    if (version) out.push(indexToCatalogEntry(plugin, version));
  }
  return out;
}

/** 按 id 找市场条目（包含 removed：调用方自行决定是否隐藏）。 */
export function findMarketPlugin(index: MarketIndex, id: string): MarketPlugin | undefined {
  return index.plugins.find((plugin) => plugin.id === id);
}

/** 详情文档 URL（服务端只接受 id/版本字符集，客户端再做一次 encode）。 */
function detailUrl(id: string, version: string, deps: MarketClientDeps): string {
  return `${baseUrlOf(deps)}/api/plugin-market/${encodeURIComponent(id)}/${encodeURIComponent(
    version,
  )}/detail`;
}

/**
 * 拉某个版本的详细介绍（markdown）。
 *
 * 404 = 该版本没有详情文档（正常，返回 null）；网络/5xx/413 抛错，
 * 由详情弹窗展示「加载失败 + 重试」，不阻断版本列表与安装。
 */
export async function fetchMarketDetail(
  id: string,
  version: string,
  deps: MarketClientDeps = {},
): Promise<string | null> {
  const fetchImpl = deps.fetchImpl ?? fetch;
  let response: Response;
  try {
    response = await fetchImpl(detailUrl(id, version, deps), {
      headers: { accept: "text/markdown" },
    });
  } catch (err) {
    throw new MarketUnavailableError(`详情加载失败：${reasonOf(err)}`);
  }
  if (response.status === 404) return null;
  if (!response.ok) {
    throw new MarketUnavailableError(`详情加载失败：HTTP ${response.status}`);
  }
  return response.text();
}

/** 某个插件是否有可更新版本（兼容、非 deleted、非 prerelease 优先）。 */
export function marketUpdateVersion(
  plugin: MarketPlugin,
  installedVersion: string,
  hostVersion: string,
): MarketVersion | null {
  const candidate = pickInstallVersion(plugin, { hostVersion });
  if (!candidate) return null;
  return comparePluginVersions(candidate.version, installedVersion) > 0 ? candidate : null;
}
