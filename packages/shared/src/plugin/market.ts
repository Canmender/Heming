import { z } from "zod";
import { compareHemingVersion, parseHemingVersion } from "./version.js";

/**
 * 云端插件市场索引 v2（`market.json`，format: 1）的契约与纯函数。
 *
 * ## 为什么索引要单独成一种格式
 * d.95 的 `/api/plugins` 是「目录里有什么字节」的枚举：扁平列表、一条 = 一个 id 的最新版，
 * 只有 id/名称/版本/权限计数。市场页要显示的东西（图标、分类、标签、每版本兼容性、
 * 详细介绍、弃用与迁移）它一个都没有，客户端只能自己再去拉清单——列表一长就是 N 次请求。
 *
 * 所以 v2 把「列表页要显示的全部字段」放进一份由**发布工具生成**的静态 JSON：
 * - 服务端仍然只存字节、不解析插件（索引是发布工具算好的产物）；
 * - 客户端用 zod 校验后直接渲染；任何一条坏数据只丢这一条，不让整份索引失效；
 * - 兼容性由 `engines.heming` 表达，服务端可按 `?hostVersion=` 过滤（见 `filterMarketByHostVersion`）。
 *
 * ## 语义约定
 * - 插件版本**发布后不可变**：同 id+version 的内容变了必须提升版本号（服务端在发布路由上拦）。
 * - 弃用分两层：整插件 `status: removed` / 单版本 `status: deprecated`（学 Obsidian + MCP Registry）。
 * - `channel` 只有 release / prerelease；prerelease 默认不在市场首屏展示。
 */

export const MARKET_FORMAT_VERSION = 1;

export class MarketIndexInvalidError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "MarketIndexInvalidError";
  }
}

const LocalizedText = z.string().min(1).max(200);

const MarketVersionSchema = z.strictObject({
  version: z.string().min(1).max(64),
  publishedAt: z.string().min(1).max(40),
  schemaVersion: z.number().int().min(1).max(99),
  engines: z.strictObject({ heming: z.string().min(1).max(32) }),
  distribution: z.enum(["manifest", "bundle"]),
  /** 清单（或整个 tgz）的 sha256，客户端下载后必须核对。 */
  sha256: z.string().regex(/^[0-9a-f]{64}$/, { error: "必须是 64 位小写 hex" }),
  size: z.number().int().min(0).max(1_000_000_000),
  /** 界面插件多一项包指纹。 */
  package: z
    .strictObject({
      sha256: z.string().regex(/^[0-9a-f]{64}$/, { error: "必须是 64 位小写 hex" }),
      size: z.number().int().min(1).max(1_000_000_000),
    })
    .optional(),
  /** 详细介绍文档（相对该版本目录的 .md 路径）。 */
  detail: z.string().max(200).optional(),
  status: z.enum(["active", "deprecated", "deleted"]).optional(),
  statusMessage: z.string().max(500).optional(),
  channel: z.enum(["release", "prerelease"]).optional(),
});

const MarketPluginSchema = z.strictObject({
  id: z.string().regex(/^[a-z0-9][a-z0-9._-]{0,63}$/, { error: "插件 id 不合法" }),
  title: LocalizedText.optional(),
  description: LocalizedText.optional(),
  icon: z.string().max(48_000).optional(),
  author: z.string().max(64).optional(),
  homepage: z.string().max(2_048).optional(),
  repository: z.string().max(2_048).optional(),
  metadata: z
    .strictObject({
      category: z.string().max(32).optional(),
      tags: z.array(z.string().max(32)).max(8).optional(),
      keywords: z.array(z.string().max(32)).max(20).optional(),
      sortKeys: z.record(z.string().max(32), z.number()).optional(),
    })
    .optional(),
  /** 推荐安装版本（缺省 = 最高兼容版本）。 */
  latest: z.string().max(64).optional(),
  updatedAt: z.string().max(40).optional(),
  /** 整插件生命周期（单版本生命周期在 versions[].status）。 */
  status: z.enum(["active", "deprecated", "removed"]).optional(),
  deprecatedReason: z.string().max(500).optional(),
  /** 建议迁移到哪个插件（下架/改名时告诉用户）。 */
  alternativeId: z.string().max(64).optional(),
  /** 旧 id 列表：用于「已装旧 id → 提示新 id」的迁移。 */
  renames: z.array(z.string().max(64)).max(8).optional(),
  versions: z.array(MarketVersionSchema).min(1).max(200),
});

const MarketIndexSchema = z.strictObject({
  format: z.literal(MARKET_FORMAT_VERSION),
  title: LocalizedText,
  description: LocalizedText.optional(),
  generatedAt: z.string().min(1).max(40),
  categories: z.record(z.string().max(32), z.strictObject({ title: LocalizedText })).optional(),
  tags: z.record(z.string().max(32), z.strictObject({ title: LocalizedText })).optional(),
  sortKeys: z
    .record(
      z.string().max(32),
      z.strictObject({ title: LocalizedText, order: z.enum(["asc", "desc"]).optional() }),
    )
    .optional(),
  plugins: z.array(z.unknown()).max(5_000),
});

export type MarketVersion = z.infer<typeof MarketVersionSchema>;
export type MarketPlugin = z.infer<typeof MarketPluginSchema>;
export type MarketIndex = {
  format: 1;
  title: string;
  description?: string;
  generatedAt: string;
  categories?: Record<string, { title: string }>;
  tags?: Record<string, { title: string }>;
  sortKeys?: Record<string, { title: string; order?: "asc" | "desc" }>;
  plugins: MarketPlugin[];
};

export interface MarketParseResult {
  index: MarketIndex;
  /** 被丢弃的条目与原因（**不**让一条坏数据毁掉整份索引）。 */
  warnings: string[];
}

/**
 * 解析索引：顶层非法直接抛（客户端应回落 v1 目录）；
 * 单条插件/版本非法 → 丢该条并记 warning（市场「少一条」比「整页不可用」好）。
 */
export function parseMarketIndex(raw: unknown): MarketParseResult {
  const top = MarketIndexSchema.safeParse(raw);
  if (!top.success) {
    throw new MarketIndexInvalidError(`市场索引格式不对：${top.error.issues[0]?.message ?? "未知原因"}`);
  }
  const warnings: string[] = [];
  const plugins: MarketPlugin[] = [];
  const seen = new Set<string>();

  for (const [index, entry] of top.data.plugins.entries()) {
    const parsed = MarketPluginSchema.safeParse(entry);
    if (!parsed.success) {
      warnings.push(`第 ${index + 1} 个插件条目非法，已忽略：${parsed.error.issues[0]?.message ?? "未知原因"}`);
      continue;
    }
    const plugin = parsed.data;
    if (seen.has(plugin.id)) {
      warnings.push(`插件 ${plugin.id} 重复出现，已忽略后一条`);
      continue;
    }
    seen.add(plugin.id);
    // 版本去重：同 version 只留第一条（发布不可变，重复本身就是数据问题）。
    const versions: MarketVersion[] = [];
    const versionSeen = new Set<string>();
    for (const version of plugin.versions) {
      if (versionSeen.has(version.version)) {
        warnings.push(`插件 ${plugin.id} 的版本 ${version.version} 重复，已忽略后一条`);
        continue;
      }
      if (!parseHemingVersion(version.engines.heming)) {
        warnings.push(`插件 ${plugin.id} 的版本 ${version.version} 的 engines.heming 非法，已忽略`);
        continue;
      }
      if (version.distribution === "bundle" && !version.package) {
        warnings.push(`界面插件 ${plugin.id}@${version.version} 缺少 package 指纹，已忽略`);
        continue;
      }
      versionSeen.add(version.version);
      versions.push(version);
    }
    if (versions.length === 0) {
      warnings.push(`插件 ${plugin.id} 没有可用版本，已忽略`);
      continue;
    }
    plugins.push({ ...plugin, versions });
  }

  return {
    index: { ...(top.data as Omit<MarketIndex, "plugins">), plugins },
    warnings,
  };
}

/** 插件版本比较：数字点分优先，非数字段退化为字典序（与既有服务端目录排序一致）。 */
export function comparePluginVersions(a: string, b: string): number {
  const split = (value: string): Array<string | number> =>
    value.split(/[.+-]/).map((part) => (/^\d+$/.test(part) ? Number(part) : part.toLowerCase()));
  const left = split(a);
  const right = split(b);
  const length = Math.max(left.length, right.length);
  for (let index = 0; index < length; index += 1) {
    const x = left[index];
    const y = right[index];
    if (x === undefined) return -1;
    if (y === undefined) return 1;
    if (x === y) continue;
    if (typeof x === "number" && typeof y === "number") return x < y ? -1 : 1;
    return String(x) < String(y) ? -1 : 1;
  }
  return 0;
}

/** 单个版本对宿主是否兼容（`engines.heming` 最小版本语义）。 */
export function isVersionCompatible(version: MarketVersion, hostVersion: string): boolean {
  if (!parseHemingVersion(hostVersion)) return true; // 宿主版本读不到：不误杀，由客户端兜底
  /**
   * 插件写的 `engines.heming` 非法 → **不兼容**（失败关闭）。
   *
   * 历史实现直接把非法值丢给 `compareHemingVersion`，而它把非法版本当「最小」，
   * 于是「非法 engines」被判成「任何宿主都满足」——市场显示可装、点安装却被
   * 客户端 `invalidEngines` 拦下（口径不一致，审计 P1-6）。正常索引在
   * `parseMarketIndex` 就会丢掉这种条目，这里是给「未经解析直接喂进来的索引」兜底。
   */
  if (!parseHemingVersion(version.engines.heming)) return false;
  return compareHemingVersion(hostVersion, version.engines.heming) >= 0;
}

/**
 * 按宿主版本过滤索引（服务端 `?hostVersion=` 与客户端兜底共用）。
 *
 * 行为：每个插件只保留兼容版本；一个版本都不剩的插件整条移除。返回新对象，不改输入。
 */
export function filterMarketByHostVersion(index: MarketIndex, hostVersion: string): MarketIndex {
  if (!parseHemingVersion(hostVersion)) return index;
  const plugins = index.plugins
    .map((plugin) => ({
      ...plugin,
      versions: plugin.versions.filter((version) => isVersionCompatible(version, hostVersion)),
    }))
    .filter((plugin) => plugin.versions.length > 0);
  return { ...index, plugins };
}

export interface PickVersionOptions {
  /** 是否允许预发布（默认 false：市场首屏不推 prerelease）。 */
  allowPrerelease?: boolean;
  /** 兼容版本过滤用的宿主版本；缺省不过滤。 */
  hostVersion?: string;
}

/**
 * 选一个可安装版本：
 * 1. 过滤掉 `status: deleted` 与不兼容版本；
 * 2. 不允许预发布时优先 release，只有全是 prerelease 才回落；
 * 3. 按版本号降序取第一个（`latest` 只是展示/推荐字段，不强制——推荐版本可能不兼容）。
 */
export function pickInstallVersion(
  plugin: MarketPlugin,
  options: PickVersionOptions = {},
): MarketVersion | null {
  const candidates = plugin.versions.filter((version) => {
    if (version.status === "deleted") return false;
    if (options.hostVersion && !isVersionCompatible(version, options.hostVersion)) return false;
    return true;
  });
  if (candidates.length === 0) return null;
  const stable = candidates.filter((version) => (version.channel ?? "release") === "release");
  const pool = options.allowPrerelease || stable.length === 0 ? candidates : stable;
  return [...pool].sort((a, b) => comparePluginVersions(b.version, a.version))[0] ?? null;
}

/** 该插件是否有可更新的更高兼容版本。 */
export function hasCompatibleUpdate(
  plugin: MarketPlugin,
  installedVersion: string,
  hostVersion: string,
): boolean {
  const candidate = pickInstallVersion(plugin, { hostVersion });
  if (!candidate) return false;
  return comparePluginVersions(candidate.version, installedVersion) > 0;
}
