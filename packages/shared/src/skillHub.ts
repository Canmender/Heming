import { z } from "zod";

/**
 * 技能社区（skill hub）契约：把「国内技能社区」的条目归一化成和鸣认识的形状。
 *
 * ## 为什么需要一层归一化
 * 首个接入源是**虾评**（`https://xiaping.coze.com`，国内 Agent 技能交易平台，第三方内容）。
 * 它的原始字段是 `current_version / owner_name / avg_stars / security_status / trigger[]` 这类
 * 平台特有命名；如果 web 直接吃上游 JSON，将来换源（或上游改名）会牵动整个 UI。
 * 所以：**server 负责调上游 + 归一化，web 只认本文件的形状**；
 * 上游的 `Authorization`（下载/注册需要）只经 server 透传，server 不落库、不记日志。
 *
 * ## 边界（红线）
 * - 技能内容只有**文本指令**（SKILL.md），和鸣不执行随技能下发的代码/脚本；
 * - 下载需要用户自己的社区 API Key（虾评正式版会消耗平台代币），和鸣不代扣、不共享 Key；
 * - 社区是公开第三方内容：安装前展示来源、作者、安全标记与版本，**默认不自动分配给任何智能体**。
 */

/** 首个接入源。`baseUrl` 可由服务端环境变量覆盖/关闭。 */
export const SKILL_HUB_SOURCES = [
  {
    id: "xiaping",
    name: "虾评",
    homepage: "https://xiaping.coze.com",
    /** 上游给 Agent 的接入指南（注册/下载说明）。 */
    docsUrl: "https://xiaping.coze.com/skill.md",
  },
] as const;

export type SkillHubSourceId = (typeof SKILL_HUB_SOURCES)[number]["id"];

/** 上游一页（归一化后）。 */
export const SkillHubSkillSchema = z.object({
  id: z.string().min(1).max(128),
  name: z.string().min(1).max(128),
  description: z.string().max(2000).default(""),
  /** 触发词（上游 `trigger`）：用于搜索与导入后的技能 triggers。 */
  triggers: z.array(z.string().max(64)).max(30).default([]),
  categories: z.array(z.string().max(32)).max(8).default([]),
  tags: z.array(z.string().max(32)).max(20).default([]),
  ownerName: z.string().max(64).default(""),
  /** 社区里的当前版本号（字符串，不做 semver 解释）。 */
  version: z.string().max(32).default(""),
  downloads: z.number().int().min(0).default(0),
  stars: z.number().int().min(0).default(0),
  /** `official`（正式版）/ `trial`（试用版）/ 其它上游状态原样透传。 */
  status: z.string().max(32).default(""),
  /** 是否依赖用户自备 API Key（安装前提示）。 */
  requiresApiKey: z.boolean().default(false),
  featured: z.boolean().default(false),
  updatedAt: z.string().max(40).default(""),
});
export type SkillHubSkill = z.infer<typeof SkillHubSkillSchema>;

export const SkillHubPageSchema = z.object({
  skills: z.array(SkillHubSkillSchema),
  total: z.number().int().min(0),
  hasMore: z.boolean(),
  /** 服务端最后成功拉上游的时间（ISO）；用于「数据可能过期」提示。 */
  fetchedAt: z.string().max(40),
});
export type SkillHubPage = z.infer<typeof SkillHubPageSchema>;

export const SkillHubDetailSchema = SkillHubSkillSchema.extend({
  createdAt: z.string().max(40).default(""),
  versionCount: z.number().int().min(0).default(1),
  /** 上游安全检测结论（`safe` 等）；缺失时不假装安全。 */
  securityStatus: z.string().max(32).optional(),
  /** 上游安全报告（Markdown，可能很长；只展示不执行）。 */
  securityReport: z.string().max(20000).optional(),
  /** 上游详情页链接（给人看原文用）。 */
  homepage: z.string().max(500).optional(),
});
export type SkillHubDetail = z.infer<typeof SkillHubDetailSchema>;

/** 下载结果：server 已解包，只把文本内容与文件清单交给客户端。 */
export const SkillHubDownloadSchema = z.object({
  skillId: z.string().min(1).max(128),
  name: z.string().min(1).max(128),
  version: z.string().max(32).default(""),
  /** 解包后找到的 SKILL.md 原文（UTF-8，≤128KB）。 */
  skillMd: z.string().min(1).max(131_072),
  /** 包内其它文件（**只给路径与大小**，客户端不执行也不落盘）。 */
  files: z
    .array(z.object({ path: z.string().max(300), size: z.number().int().min(0) }))
    .max(200)
    .default([]),
  /** zip 字节的 sha256（与上游 `download_url` 返回的内容对应，便于核对）。 */
  zipSha256: z.string().regex(/^[0-9a-f]{64}$/),
  size: z.number().int().min(1).max(5 * 1024 * 1024),
});
export type SkillHubDownload = z.infer<typeof SkillHubDownloadSchema>;

/** 一键注册结果（用户明确点「创建账号」才调用；server 不持久化 Key）。 */
export const SkillHubRegisterResultSchema = z.object({
  apiKey: z.string().min(8).max(200),
  /** 上游可能返回用户名（重复时会加前缀）。 */
  name: z.string().max(128).optional(),
});
export type SkillHubRegisterResult = z.infer<typeof SkillHubRegisterResultSchema>;

/** 社区状态（GET /api/skill-hub）——决定 UI 是否展示入口。 */
export const SkillHubStatusSchema = z.object({
  enabled: z.boolean(),
  source: z.object({
    id: z.string(),
    name: z.string(),
    homepage: z.string(),
    docsUrl: z.string(),
  }),
  /** 上游连通性（server 侧最近一次探测结果，不阻塞 UI）。 */
  reachable: z.boolean().default(true),
  categories: z.array(z.string().max(32)).max(40).default([]),
});
export type SkillHubStatus = z.infer<typeof SkillHubStatusSchema>;

/** 安装到技能池后记在本机的社区元信息（写进技能定义的 `community` 字段）。 */
export const SkillCommunityMetaSchema = z.object({
  source: z.string().max(32),
  skillId: z.string().max(128),
  name: z.string().max(128).default(""),
  author: z.string().max(64).default(""),
  version: z.string().max(32).default(""),
  homepage: z.string().max(500).optional(),
  installedAt: z.string().max(40),
});
export type SkillCommunityMeta = z.infer<typeof SkillCommunityMetaSchema>;
