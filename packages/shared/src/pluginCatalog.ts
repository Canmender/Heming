import { z } from "zod";

/**
 * 云端插件目录（服务端 ↔ 客户端共用契约）。
 *
 * 为什么放在 shared：插件包是**用户自行下载安装的独立产物**，不再随安装包分发。
 * 服务端只负责「有哪些包、哪个版本、内容指纹」，客户端负责下载原样 `plugin.json`
 * 并走既有的安装/预览管线（校验、权限、信任全在客户端，服务端不解析执行）。
 *
 * 边界：
 * - 目录与包内容都是**公开产物**，不含用户数据；下载不需要登录态；
 * - 服务端不保存插件运行期数据，也不代表官方审核——安装前仍由客户端展示权限与指纹；
 * - 客户端必须校验下载内容的 sha256 与目录一致，避免中间层篡改。
 */

/** 插件 id 与版本号的字符集（同时用于服务端防路径穿越）。 */
export const PLUGIN_CATALOG_ID_RE = /^[a-z0-9][a-z0-9._-]{0,63}$/;
export const PLUGIN_CATALOG_VERSION_RE = /^[0-9A-Za-z][0-9A-Za-z.+_-]{0,63}$/;

/** `plugin.json` 内容指纹（sha256 hex）。 */
export const PLUGIN_CATALOG_SHA256_RE = /^[0-9a-f]{64}$/;

export const PluginCatalogPermissionsSchema = z.object({
  network: z.array(z.string()).default([]),
  tools: z.enum(["none", "read", "write"]),
  files: z.array(z.string()).default([]),
});

/** 贡献面计数：只给「这个包带来什么」的概览，具体权限以 manifest 为准。 */
export const PluginCatalogContributionsSchema = z.object({
  skills: z.number().int().min(0).default(0),
  mcpServers: z.number().int().min(0).default(0),
  commands: z.number().int().min(0).default(0),
  toolPacks: z.number().int().min(0).default(0),
  /** d.97：界面插件（desktopWidget）数量；纯声明式包恒为 0。 */
  desktopWidgets: z.number().int().min(0).default(0),
});

/**
 * 分发形态（d.97）：
 * - `manifest`：只分发 `plugin.json` 本身（既有全部插件；缺省值，向后兼容）；
 * - `bundle`：界面插件，除清单外还分发 `package.tgz`（含 `files/**` 代码与资源）。
 */
export const PluginCatalogDistributionSchema = z.enum(["manifest", "bundle"]);

/** 界面插件包（`package.tgz`）的指纹与字节数；`manifest` 形态没有这一项。 */
export const PluginCatalogPackageSchema = z.object({
  sha256: z.string().regex(PLUGIN_CATALOG_SHA256_RE),
  size: z.number().int().min(0),
});

export const PluginCatalogEntrySchema = z.object({
  id: z.string().regex(PLUGIN_CATALOG_ID_RE),
  name: z.string().min(1).max(128),
  version: z.string().regex(PLUGIN_CATALOG_VERSION_RE),
  /** 清单 schemaVersion（客户端据此判断「这个包需要更新版和鸣」）。 */
  schemaVersion: z.number().int().min(1).max(99),
  description: z.string().max(2000).default(""),
  author: z.string().max(128).default(""),
  /** 该版本上线时间（服务端取文件时间）。 */
  publishedAt: z.string(),
  sha256: z.string().regex(PLUGIN_CATALOG_SHA256_RE),
  /** plugin.json 字节数。 */
  size: z.number().int().min(0),
  permissions: PluginCatalogPermissionsSchema,
  contributions: PluginCatalogContributionsSchema,
  /** d.97：缺省 `manifest`（老服务端/老目录不认识这个字段时按纯声明式处理）。 */
  distribution: PluginCatalogDistributionSchema.default("manifest"),
  /** d.97：`distribution: "bundle"` 时存在；客户端下载后先比 sha256 再解包。 */
  package: PluginCatalogPackageSchema.optional(),
});

export const PluginCatalogResponseSchema = z.object({
  plugins: z.array(PluginCatalogEntrySchema),
  generatedAt: z.string(),
});

export type PluginCatalogEntry = z.infer<typeof PluginCatalogEntrySchema>;
export type PluginCatalogResponse = z.infer<typeof PluginCatalogResponseSchema>;
export type PluginCatalogPermissions = z.infer<typeof PluginCatalogPermissionsSchema>;
export type PluginCatalogContributions = z.infer<typeof PluginCatalogContributionsSchema>;
export type PluginCatalogDistribution = z.infer<typeof PluginCatalogDistributionSchema>;
export type PluginCatalogPackage = z.infer<typeof PluginCatalogPackageSchema>;

// —— 云端插件仓库（d.95）：详情 / 发布 / 删除 的共用契约 ——
//
// 「目录」是客户端只读视图（只给最新版）；「仓库」多两个写/查能力：
// - detail：某个 id 的全部版本（客户端展示更新记录、回滚参考）；
// - publish：把一份 plugin.json 原样写进仓库（只校验 id/版本/大小，不解析权限）；
// - remove：下线某个版本（仓库运维用，不做成客户端能力）。
// 发布/下线需要单独的发布密钥（环境变量 HEMING_PLUGIN_PUBLISH_KEY），不是用户登录态。

/** 单个插件在仓库里的全部版本（新→旧）。 */
export const PluginCatalogDetailSchema = z.object({
  id: z.string().regex(PLUGIN_CATALOG_ID_RE),
  versions: z.array(PluginCatalogEntrySchema).min(1),
});
export type PluginCatalogDetail = z.infer<typeof PluginCatalogDetailSchema>;

export const PluginCatalogDetailResponseSchema = z.union([
  PluginCatalogDetailSchema,
  z.object({ error: z.string() }),
]);

/** 发布结果：`created=false` 表示同 id/版本已存在且被覆盖（幂等重发）。 */
export const PluginCatalogPublishResultSchema = z.object({
  id: z.string().regex(PLUGIN_CATALOG_ID_RE),
  version: z.string().regex(PLUGIN_CATALOG_VERSION_RE),
  sha256: z.string().regex(PLUGIN_CATALOG_SHA256_RE),
  size: z.number().int().min(0),
  created: z.boolean(),
});
export type PluginCatalogPublishResult = z.infer<typeof PluginCatalogPublishResultSchema>;
