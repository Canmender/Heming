import { z } from "zod";
import { PLUGIN_CATALOG_ID_RE, PLUGIN_CATALOG_VERSION_RE } from "./pluginCatalog.js";

/**
 * 云端模块目录（服务端 ↔ 客户端共用契约）。
 *
 * 模块与声明式插件的区别：模块带**宿主页面 / 后台任务 / 可执行引擎**，
 * 由用户在插件区显式安装后才生效。安装包里不携带任何模块；
 * 客户端从服务端拿到这份目录，用户自己决定装哪个。
 *
 * 边界：
 * - 目录只描述「有哪些模块、版本、是否需要下载引擎」，不含代码与密钥；
 * - 宿主页面代码是否内置由客户端决定（当前三个模块的页面随应用发布，
 *   但未安装时完全不生效）；带引擎的模块（信息中枢）引擎包不随安装包；
 * - 目录是公开产物，不需要登录态。
 */

export const ModuleCatalogEntrySchema = z.object({
  id: z.string().regex(PLUGIN_CATALOG_ID_RE),
  name: z.string().min(1).max(128),
  version: z.string().regex(PLUGIN_CATALOG_VERSION_RE),
  description: z.string().max(2000).default(""),
  author: z.string().max(128).default(""),
  /**
   * 需要下载的可执行引擎 id（如 `heming.infohub-engine`）；
   * 纯宿主页面模块为 `null`，安装时不需要联网。
   */
  engine: z.string().min(1).max(64).nullable().default(null),
  /** 服务端上线时间（可选；客户端只展示）。 */
  publishedAt: z.string().optional(),
});

export const ModuleCatalogResponseSchema = z.object({
  modules: z.array(ModuleCatalogEntrySchema),
  generatedAt: z.string(),
});

export type ModuleCatalogEntry = z.infer<typeof ModuleCatalogEntrySchema>;
export type ModuleCatalogResponse = z.infer<typeof ModuleCatalogResponseSchema>;
