import { z } from "zod";
import { LEGACY_ENGINES, normalizeEnginesHemmin } from "./version.js";

/**
 * 插件清单 v5（唯一权威解析器，web / server / 脚本共用）。
 *
 * ## 为什么 v5 要放在 shared
 * v1–v4 的解析器长在 `packages/web/src/lib/plugins/manifest.ts`（1300 行），
 * 那是「浏览器里怎么展示与安装」的地方；但 v5 起多了三件**不属于某个端**的事：
 * 1. `engines.heming`：安装预览、市场索引过滤、发布校验三处都要判；
 * 2. `meta`（图标/分类/标签/详情文档）：市场页与目录生成器都要读；
 * 3. 明显的「未知字段」策略：必须与 lint 脚本、服务端校验一致。
 * 所以 v5 的核心 schema 落在这里，web 只在它之上补两件 web 独有的事：
 * 命令 target 的页面白名单（`PALETTE_PAGES`），以及把结果投射到既有内部类型。
 *
 * ## 分层严格度（学 Claude Code / VS Code 的实践）
 * - **顶层未知键**：剥掉并记一条 warning（`warnings`）。理由：跨版本兼容靠 `engines`，
 *   顶层多一个展示字段不该让包装不上；但用户必须能看见「这个字段被忽略了」。
 * - **敏感子对象**（`engines` / `permissions` / `meta` / 每个贡献条目）：strict，未知键=报错。
 *   理由：权限/贡献写错位置是危险笔误（例如把 `events` 写到 permissions 外面），
 *   静默忽略会让人以为声明生效了。
 *
 * ## 边界（v5 仍然不做什么）
 * - 不执行代码、不允许 stdio MCP（红线不变）；
 * - bundle 的包结构/签名/解包配额仍由主进程 `plugin-package.js` 权威判定；
 * - `meta.detail` 只校验形状，不在这里读取包内文件（由市场路由按路径守卫读）。
 */

export const PLUGIN_SCHEMA_VERSION_V5 = 5;

/** v1–v5 统一常量（web 侧的旧常量继续保留，v5 以这里为准）。 */
export const PLUGIN_LIMITS = {
  skills: 50,
  mcpServers: 10,
  commands: 30,
  toolPacks: 10,
  toolsPerPack: 50,
  networkHosts: 20,
  files: 5,
  desktopWidgets: 1,
  widgetScales: 6,
  widgetSettingFields: 20,
  widgetSettingOptions: 20,
  tags: 8,
  keywords: 20,
  screenshots: 4,
  iconChars: 48_000,
  detailInlineChars: 16_384,
  homepageChars: 2_048,
} as const;

const ID_RE = /^[a-z0-9][a-z0-9._-]{0,63}$/;
const SERVER_KEY_RE = /^[a-z0-9][a-z0-9-]{0,31}$/;
const CATEGORY_RE = /^[a-z0-9][a-z0-9-]{0,31}$/;
const WIDGET_ID_RE = /^[a-z0-9][a-z0-9-]{0,31}$/;
const DETAIL_PATH_RE = /^[A-Za-z0-9][A-Za-z0-9._/-]{0,199}$/;
const LOCAL_HOSTS = new Set(["localhost", "127.0.0.1", "[::1]", "::1"]);

/** 解析失败的统一错误：`message` 已是可直接展示的中文。 */
export class PluginManifestInvalidError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "PluginManifestInvalidError";
  }
}

/* ───────────────────────── 权限 / 主机规范化 ───────────────────────── */

/**
 * URL → 归一化 host[:port]（小写、去默认端口）。非法 URL 返回空串。
 *
 * 与 `packages/web/src/lib/plugins/permissions.ts` 的 `hostOfUrl` 同口径：
 * 默认端口两侧统一（`api.example.com:443` 与 `api.example.com` 等价），
 * 非默认端口保留；IPv6 保留方括号。
 */
export function hostOfUrl(url: string): string {
  let parsed: URL;
  try {
    parsed = new URL(url);
  } catch {
    return "";
  }
  const host = parsed.hostname.toLowerCase();
  const defaultPort = parsed.protocol === "https:" ? "443" : parsed.protocol === "http:" ? "80" : "";
  const port = parsed.port && parsed.port !== defaultPort ? `:${parsed.port}` : "";
  return `${host}${port}`;
}

/** 声明的网络主机：host 或 host:port，禁协议/路径/账号/通配。 */
export function normalizeDeclaredHost(raw: unknown): string | null {
  if (typeof raw !== "string") return null;
  const text = raw.trim().toLowerCase();
  if (!text || text.length > 260) return null;
  if (/[\s/@\\?#*]/.test(text)) return null;
  if (text.includes("://")) return null;
  const ipv6 = /^\[([0-9a-f:.]+)\](?::([0-9]{1,5}))?$/.exec(text);
  if (ipv6) {
    const port = ipv6[2];
    if (port && (Number(port) < 1 || Number(port) > 65_535)) return null;
    return port ? `[${ipv6[1]}]:${port}` : `[${ipv6[1]}]`;
  }
  const match = /^([a-z0-9](?:[a-z0-9.-]{0,251}[a-z0-9])?)(?::([0-9]{1,5}))?$/.exec(text);
  if (!match) return null;
  const port = match[2];
  if (port && (Number(port) < 1 || Number(port) > 65_535)) return null;
  // 去掉 http/https 默认端口，与 hostOfUrl 的归一化保持可比较。
  if (port === "443" || port === "80") return match[1];
  return port ? `${match[1]}:${port}` : match[1];
}

/** MCP 服务 URL：只 https；http 仅本机回环；禁内嵌账号密码。 */
function validateMcpUrl(raw: string): string | null {
  let parsed: URL;
  try {
    parsed = new URL(raw);
  } catch {
    return "不是合法的 URL";
  }
  if (parsed.username || parsed.password) return "不允许内嵌账号密码";
  const host = parsed.hostname.toLowerCase();
  if (parsed.protocol === "https:") return null;
  if (parsed.protocol === "http:" && LOCAL_HOSTS.has(host)) return null;
  return "只支持 https（本机 http 仅限 localhost / 127.0.0.1 / [::1]）";
}

/* ───────────────────────── 错误文案（中文） ───────────────────────── */

interface IssueLike {
  path: (string | number | symbol)[];
  code: string;
  message: string;
}

function pathLabel(path: readonly (string | number | symbol)[]): string {
  let out = "";
  for (const part of path) {
    if (typeof part === "number") out += `[${part}]`;
    else out += out ? `.${String(part)}` : String(part);
  }
  return out;
}

/** zod 默认文案是英文；这里统一翻成中文（保留自定义 message）。 */
function chineseIssueMessage(issue: IssueLike): string {
  const message = issue.message;
  const knownEnglish = new Set([
    "Required",
    "Invalid input",
    "Expected string, received number",
    "Expected number, received string",
    "Expected boolean, received string",
    "Expected array, received string",
    "Expected object, received array",
    "Invalid input: expected string, received undefined",
    "Too small",
    "Too big",
    "Invalid URL",
  ]);
  if (!knownEnglish.has(message) && /[\u4e00-\u9fff]/.test(message)) return message;
  switch (issue.code) {
    case "invalid_type":
      if (message.toLowerCase().includes("undefined")) return "必填";
      if (message.toLowerCase().includes("array")) return "必须是数组";
      if (message.toLowerCase().includes("string")) return "必须是文本";
      if (message.toLowerCase().includes("number")) return "必须是数字";
      if (message.toLowerCase().includes("boolean")) return "必须是布尔值";
      return message;
    case "too_small":
      return message.includes("array") || message.includes("Array") ? "条目太少" : "太短";
    case "too_big":
      return message.includes("array") || message.includes("Array") ? "条目超出上限" : "太长";
    case "invalid_union":
      return "字段形状不合法";
    case "unrecognized_keys":
      return "包含未知字段";
    default:
      return message;
  }
}

export interface PluginParseIssue {
  path: string;
  message: string;
}

/** 把 zod error 压成「路径：原因；另有 N 处」的中文串（与 web 侧既有风格一致）。 */
export function formatPluginIssues(issues: readonly IssueLike[]): string {
  const shown = issues.slice(0, 3).map((issue) => {
    const at = pathLabel(issue.path);
    const message = chineseIssueMessage(issue);
    return at ? `${at}：${message}` : message;
  });
  const rest = issues.length - shown.length;
  return shown.join("；") + (rest > 0 ? `；另有 ${rest} 处错误` : "");
}

function fail(issues: readonly IssueLike[]): never {
  throw new PluginManifestInvalidError(formatPluginIssues(issues));
}

/* ───────────────────────── 基础 schema ───────────────────────── */

const trimmed = (max: number, min = 1) =>
  z
    .string({ error: `必须是文本（${min}–${max} 字）` })
    .trim()
    .min(min, { error: `至少 ${min} 个字` })
    .max(max, { error: `最多 ${max} 个字` });

const httpsUrl = (max = PLUGIN_LIMITS.homepageChars) =>
  z
    .string({ error: "必须是文本 URL" })
    .max(max, { error: `URL 最多 ${max} 字符` })
    .refine((value) => {
      try {
        const url = new URL(value);
        return url.protocol === "https:" && !url.username && !url.password;
      } catch {
        return false;
      }
    }, { error: "必须是 https:// 开头的合法 URL（不含账号密码）" });

const SkillSchema = z.strictObject({
  name: trimmed(32),
  description: trimmed(200, 0).optional().default(""),
  instructions: trimmed(8000),
  triggers: z.array(trimmed(64)).max(20, { error: "触发词最多 20 个" }).optional().default([]),
  tags: z.array(trimmed(32)).max(20, { error: "标签最多 20 个" }).optional().default([]),
});

const McpServerSchema = z
  .strictObject({
    key: z.string().regex(SERVER_KEY_RE, { error: "服务 key 只能是小写字母/数字/连字符，≤32" }),
    name: trimmed(64),
    url: z.string().max(2048, { error: "URL 最多 2048 字符" }),
    description: trimmed(200, 0).optional().default(""),
  })
  .superRefine((server, ctx) => {
    const problem = validateMcpUrl(server.url);
    if (problem) ctx.addIssue({ code: "custom", path: ["url"], message: problem });
  });

const CommandTargetSchema = z.discriminatedUnion("kind", [
  z.strictObject({ kind: z.literal("page"), page: z.string().min(1).max(64) }),
  z.strictObject({ kind: z.literal("skill"), name: z.string().min(1).max(32) }),
  z.strictObject({ kind: z.literal("plugin") }),
]);

const CommandSchema = z.strictObject({
  id: z.string().regex(ID_RE, { error: "命令 id 只能是小写字母/数字/._-，≤64" }),
  title: trimmed(64),
  description: trimmed(200, 0).optional().default(""),
  keywords: z.array(trimmed(32)).max(20, { error: "关键词最多 20 个" }).optional().default([]),
  target: CommandTargetSchema,
});

const ToolPackSchema = z.strictObject({
  id: z.string().regex(ID_RE, { error: "工具束 id 只能是小写字母/数字/._-，≤64" }),
  name: trimmed(32),
  description: trimmed(200, 0).optional().default(""),
  tools: z.array(trimmed(128)).max(PLUGIN_LIMITS.toolsPerPack, { error: "每束最多 50 个工具" }),
});

const WidgetSettingFieldSchema = z.strictObject({
  key: z.string().regex(/^[A-Za-z][A-Za-z0-9_]{0,31}$/, { error: "设置字段 key 不合法" }),
  type: z.enum(["boolean", "select", "text", "number", "agent"], { error: "不支持的设置字段类型" }),
  label: trimmed(64),
  default: z.union([z.string(), z.number(), z.boolean()]).optional(),
  options: z
    .array(z.strictObject({ value: trimmed(64), label: trimmed(64) }))
    .max(PLUGIN_LIMITS.widgetSettingOptions, { error: "选项最多 20 个" })
    .optional(),
});

const DesktopWidgetSchema = z.strictObject({
  id: z.string().regex(WIDGET_ID_RE, { error: "小组件 id 只能是小写字母/数字/连字符，≤32" }),
  name: trimmed(32),
  entry: z
    .string()
    .max(200, { error: "入口路径最多 200 字符" })
    .refine(
      (value) => value.endsWith(".html") && !value.startsWith("/") && !value.includes("..") && !value.includes("\\"),
      { error: "入口必须是包内相对 .html 路径（禁绝对路径 / .. / 反斜杠）" },
    ),
  width: z.number().int().min(96, { error: "宽度至少 96" }).max(1024, { error: "宽度最多 1024" }),
  height: z.number().int().min(96, { error: "高度至少 96" }).max(1024, { error: "高度最多 1024" }),
  scales: z
    .array(z.number().min(0.5, { error: "缩放不能小于 0.5" }).max(2, { error: "缩放不能大于 2" }))
    .min(1, { error: "至少 1 档缩放" })
    .max(PLUGIN_LIMITS.widgetScales, { error: "缩放最多 6 档" })
    .optional(),
  defaultScale: z.number().min(0.5).max(2).optional(),
  transparent: z.boolean().optional(),
  alwaysOnTop: z.boolean().optional(),
  skipTaskbar: z.boolean().optional(),
  resizable: z.boolean().optional(),
  clickThrough: z.enum(["none", "auto"]).optional(),
  position: z
    .strictObject({
      anchor: z.enum(["bottom-right", "bottom-left", "top-right", "top-left", "center"]).optional(),
      margin: z.number().int().min(0).max(200).optional(),
      remember: z.boolean().optional(),
    })
    .optional(),
  icon: z.string().max(200).optional(),
  tray: z
    .strictObject({
      icon: z.string().max(200),
      items: z.array(z.enum(["toggle", "clickThrough", "resetPosition", "settings"])).max(8).optional(),
    })
    .optional(),
  settings: z
    .strictObject({
      title: trimmed(64),
      fields: z
        .array(WidgetSettingFieldSchema)
        .max(PLUGIN_LIMITS.widgetSettingFields, { error: "设置字段最多 20 个" }),
    })
    .optional(),
});

const IconSchema = z
  .string()
  .max(PLUGIN_LIMITS.iconChars, { error: "图标字符串过长（建议用 https URL）" })
  .refine((value) => {
    if (/^data:image\/(png|jpeg|webp|svg\+xml);base64,/i.test(value)) return true;
    try {
      const url = new URL(value);
      return url.protocol === "https:";
    } catch {
      return false;
    }
  }, { error: "图标必须是 https URL 或 data:image/*;base64（建议 https，避免占本机配额）" });

const MetaSchema = z.strictObject({
  icon: IconSchema.optional(),
  homepage: httpsUrl().optional(),
  repository: httpsUrl().optional(),
  license: trimmed(32).optional(),
  category: z.string().regex(CATEGORY_RE, { error: "分类 id 只能是小写字母/数字/连字符" }).optional(),
  tags: z.array(trimmed(32)).max(PLUGIN_LIMITS.tags, { error: "标签最多 8 个" }).optional(),
  keywords: z
    .array(trimmed(32))
    .max(PLUGIN_LIMITS.keywords, { error: "关键词最多 20 个" })
    .optional(),
  screenshots: z
    .array(httpsUrl())
    .max(PLUGIN_LIMITS.screenshots, { error: "截图最多 4 张" })
    .optional(),
  detail: z
    .string()
    .max(PLUGIN_LIMITS.detailInlineChars, { error: "内联详情最多 16384 字（或改用包内 .md 路径）" })
    .optional(),
});

const PermissionsSchema = z
  .strictObject({
    network: z.array(z.string()).max(PLUGIN_LIMITS.networkHosts, { error: "网络主机最多 20 个" }).optional(),
    tools: z.enum(["none", "read", "write"], { error: "权限上限只能是 none / read / write" }).optional(),
    files: z.array(z.string()).max(PLUGIN_LIMITS.files, { error: "文件根最多 5 个" }).optional(),
    events: z.array(z.enum(["notify"]), { error: "事件只支持 notify" }).max(8).optional(),
    graphics: z.array(z.enum(["webgl", "wasm"]), { error: "渲染能力只支持 webgl / wasm" }).max(8).optional(),
    eval: z.boolean().optional(),
  })
  .superRefine((permissions, ctx) => {
    for (const [index, host] of (permissions.network ?? []).entries()) {
      if (!normalizeDeclaredHost(host)) {
        ctx.addIssue({
          code: "custom",
          path: ["network", index],
          message: "主机只能写 host 或 host:port（禁协议/路径/账号/通配）",
        });
      }
    }
    for (const [index, file] of (permissions.files ?? []).entries()) {
      if (file.startsWith("/") || /^[A-Za-z]:/.test(file) || file.includes("..") || file.includes("\\")) {
        ctx.addIssue({ code: "custom", path: ["files", index], message: "必须是包内相对路径（禁绝对路径 / 盘符 / ..）" });
      }
    }
  });

const EnginesSchema = z.strictObject({
  heming: z.string({ error: "engines.heming 必须是文本版本号（如 d.103）" }),
});

const PublisherSchema = z.strictObject({
  id: trimmed(64),
  publicKey: z
    .string()
    .min(40, { error: "公钥应是 base64url 编码的 32 字节 Ed25519 raw key" })
    .max(64, { error: "公钥应是 base64url 编码的 32 字节 Ed25519 raw key" }),
});

const SignatureSchema = z.strictObject({
  alg: z.literal("ed25519", { error: "签名算法只能是 ed25519" }),
  value: z.string().min(80, { error: "签名应是 base64url 编码的 64 字节" }).max(100),
});

const ContributionsSchema = z
  .strictObject({
    skills: z.array(SkillSchema).max(PLUGIN_LIMITS.skills, { error: "技能最多 50 个" }).optional(),
    mcpServers: z
      .array(McpServerSchema)
      .max(PLUGIN_LIMITS.mcpServers, { error: "MCP 服务最多 10 个" })
      .optional(),
    commands: z.array(CommandSchema).max(PLUGIN_LIMITS.commands, { error: "命令最多 30 个" }).optional(),
    toolPacks: z.array(ToolPackSchema).max(PLUGIN_LIMITS.toolPacks, { error: "工具束最多 10 个" }).optional(),
    desktopWidgets: z
      .array(DesktopWidgetSchema)
      .max(PLUGIN_LIMITS.desktopWidgets, { error: "本轮每包最多 1 个桌面小组件" })
      .optional(),
  })
  .superRefine((contributions, ctx) => {
    // 同一清单内的重名一律点名两处（与 web 侧既有规则一致）。
    const dup = (items: Array<{ key: string }> | undefined, label: string, at: string) => {
      const seen = new Map<string, number>();
      for (const [index, item] of (items ?? []).entries()) {
        const previous = seen.get(item.key);
        if (previous !== undefined) {
          ctx.addIssue({ code: "custom", path: [at, index], message: `${label}重复：与第 ${previous + 1} 项同名` });
        } else {
          seen.set(item.key, index);
        }
      }
    };
    dup(contributions.skills?.map((skill) => ({ key: skill.name })), "技能名", "skills");
    dup(contributions.mcpServers?.map((server) => ({ key: server.key })), "服务 key", "mcpServers");
    dup(contributions.commands?.map((command) => ({ key: command.id })), "命令 id", "commands");
    dup(contributions.toolPacks?.map((pack) => ({ key: pack.id })), "工具束 id", "toolPacks");

    const toolOwners = new Map<string, string>();
    for (const pack of contributions.toolPacks ?? []) {
      for (const tool of pack.tools) {
        const owner = toolOwners.get(tool);
        if (owner !== undefined && owner !== pack.id) {
          ctx.addIssue({
            code: "custom",
            path: ["toolPacks"],
            message: `工具 ${tool} 同时出现在工具束 ${owner} 与 ${pack.id}`,
          });
        } else {
          toolOwners.set(tool, pack.id);
        }
      }
    }
  });

/* ───────────────────────── 顶层 schema ───────────────────────── */

const ManifestV5Object = z.object({
  schemaVersion: z.literal(PLUGIN_SCHEMA_VERSION_V5),
  id: z.string().regex(ID_RE, { error: "插件 id 只能是小写字母/数字/._-，≤64" }),
  name: trimmed(64),
  version: trimmed(32),
  description: trimmed(200, 0).optional().default(""),
  author: trimmed(64, 0).optional().default(""),
  engines: EnginesSchema,
  meta: MetaSchema.optional(),
  permissions: PermissionsSchema.optional(),
  distribution: z.enum(["manifest", "bundle"], { error: "distribution 只能是 manifest / bundle" }).optional(),
  contributions: ContributionsSchema,
  publisher: PublisherSchema.optional(),
  signature: SignatureSchema.optional(),
});

const KNOWN_TOP_LEVEL = new Set([
  "$schema",
  "schemaVersion",
  "id",
  "name",
  "version",
  "description",
  "author",
  "engines",
  "meta",
  "permissions",
  "distribution",
  "contributions",
  "publisher",
  "signature",
]);

export type PluginSkillV5 = z.infer<typeof SkillSchema>;
export type PluginMcpServerV5 = z.infer<typeof McpServerSchema>;
export type PluginCommandV5 = z.infer<typeof CommandSchema>;
export type PluginToolPackV5 = z.infer<typeof ToolPackSchema>;
export type PluginDesktopWidgetV5 = z.infer<typeof DesktopWidgetSchema>;
export type PluginMetaV5 = z.infer<typeof MetaSchema>;
export type PluginPermissionsV5 = z.infer<typeof PermissionsSchema>;
export type PluginDistributionV5 = "manifest" | "bundle";

/** 归一化后的 v5 清单（缺省值已补全，消费方不用判空）。 */
export interface PluginManifestV5 {
  schemaVersion: 5;
  id: string;
  name: string;
  version: string;
  description: string;
  author: string;
  engines: { heming: string };
  meta: PluginMetaV5;
  distribution: PluginDistributionV5;
  permissions: PluginPermissionsV5;
  contributions: {
    skills: PluginSkillV5[];
    mcpServers: PluginMcpServerV5[];
    commands: PluginCommandV5[];
    toolPacks: PluginToolPackV5[];
    desktopWidgets: PluginDesktopWidgetV5[];
  };
  publisher?: { id: string; publicKey: string };
  signature?: { alg: "ed25519"; value: string };
}

export interface PluginV5ParseResult {
  manifest: PluginManifestV5;
  /** 非阻断问题：被忽略的顶层未知字段、未声明分类/标签等。 */
  warnings: string[];
}

/**
 * 解析 v5 清单。失败抛 `PluginManifestInvalidError`（中文 + 字段路径）。
 *
 * 步骤：① 结构校验（zod）；② 形状级规则（bundle 只允许 commands+desktopWidgets、
 * MCP host 必须被 permissions.network 覆盖、工具名不可跨束重复）；③ 归一化 + warnings。
 */
export function parsePluginManifestV5(raw: unknown): PluginV5ParseResult {
  if (!raw || typeof raw !== "object" || Array.isArray(raw)) {
    throw new PluginManifestInvalidError("清单必须是 JSON 对象");
  }
  const record = raw as Record<string, unknown>;
  if (record.schemaVersion !== PLUGIN_SCHEMA_VERSION_V5) {
    throw new PluginManifestInvalidError(
      `schemaVersion 必须是 ${PLUGIN_SCHEMA_VERSION_V5}（当前 ${String(record.schemaVersion)}）`,
    );
  }
  const parsed = ManifestV5Object.safeParse(record);
  if (!parsed.success) return fail(parsed.error.issues as unknown as IssueLike[]);

  const warnings: string[] = [];
  for (const key of Object.keys(record)) {
    if (!KNOWN_TOP_LEVEL.has(key)) warnings.push(`已忽略未知字段 ${key}`);
  }

  const engines = normalizeEnginesHemmin(parsed.data.engines);
  if (!engines) {
    throw new PluginManifestInvalidError(
      "engines.heming：需要合法的和鸣版本号（如 d.103 或 d.103.2.42.0）",
    );
  }

  const distribution = parsed.data.distribution ?? "manifest";
  const contributions = parsed.data.contributions;
  const skills = contributions.skills ?? [];
  const mcpServers = contributions.mcpServers ?? [];
  const commands = contributions.commands ?? [];
  const toolPacks = contributions.toolPacks ?? [];
  const desktopWidgets = contributions.desktopWidgets ?? [];

  if (distribution === "bundle") {
    if (skills.length > 0 || mcpServers.length > 0 || toolPacks.length > 0) {
      throw new PluginManifestInvalidError(
        "界面插件（distribution: bundle）只允许 commands + desktopWidgets，不允许声明 skills / mcpServers / toolPacks" +
          "（见 contributions）",
      );
    }
    if (desktopWidgets.length === 0) {
      throw new PluginManifestInvalidError(
        "distribution: bundle 必须声明至少 1 个 contributions.desktopWidgets（否则就是纯声明式包）",
      );
    }
  } else if (desktopWidgets.length > 0) {
    throw new PluginManifestInvalidError(
      "声明了 contributions.desktopWidgets 时必须写 distribution: \"bundle\"",
    );
  }

  if (skills.length + mcpServers.length + commands.length + toolPacks.length + desktopWidgets.length === 0) {
    throw new PluginManifestInvalidError("至少要让 contributions 里有一类非空（技能 / 服务 / 命令 / 工具束 / 小组件）");
  }

  const permissions = parsed.data.permissions ?? {};
  const declaredHosts = new Set(
    (permissions.network ?? []).map((host) => normalizeDeclaredHost(host)).filter((host): host is string => !!host),
  );
  for (const [index, server] of mcpServers.entries()) {
    const host = hostOfUrl(server.url);
    if (host && !declaredHosts.has(host)) {
      throw new PluginManifestInvalidError(
        `permissions.network 未覆盖 MCP 服务主机 ${host}（见 contributions.mcpServers[${index}].url）`,
      );
    }
  }

  const commandsWithSkillTarget = commands.filter((command) => command.target.kind === "skill");
  for (const [index, command] of commandsWithSkillTarget.entries()) {
    const name = (command.target as { kind: "skill"; name: string }).name;
    if (!skills.some((skill) => skill.name === name)) {
      throw new PluginManifestInvalidError(
        `contributions.commands[${index}].target：技能 ${name} 不在本插件 contributions.skills 里`,
      );
    }
  }

  if (parsed.data.signature && !parsed.data.publisher) {
    throw new PluginManifestInvalidError("有 signature 时必须同时提供 publisher（否则无法确定验签公钥）");
  }

  return {
    manifest: {
      schemaVersion: 5,
      id: parsed.data.id,
      name: parsed.data.name,
      version: parsed.data.version,
      description: parsed.data.description,
      author: parsed.data.author,
      engines: { heming: engines },
      meta: parsed.data.meta ?? {},
      distribution,
      permissions: {
        network: (permissions.network ?? []).map((host) => normalizeDeclaredHost(host) ?? host.toLowerCase()),
        tools: permissions.tools ?? "read",
        files: permissions.files ?? [],
        events: permissions.events ?? [],
        graphics: permissions.graphics ?? [],
        eval: permissions.eval ?? false,
      },
      contributions: { skills, mcpServers, commands, toolPacks, desktopWidgets },
      ...(parsed.data.publisher ? { publisher: parsed.data.publisher } : {}),
      ...(parsed.data.signature ? { signature: parsed.data.signature } : {}),
    },
    warnings,
  };
}

/**
 * 把 v1–v4 的**已归一化**清单投射成 v5 视图（不重新校验，只补 v5 缺省字段）。
 *
 * 为什么不在 shared 里解析 v1–v4：旧格式的校验规则（v1 带 MCP 拒绝、v3 拒绝 v4 字段）
 * 与 web 的展示/迁移提示强绑定，搬过来只会制造两份规则；v5 视图统一后，
 * 消费方（单元投影、诊断、市场展示）只需要认识 v5 形状。
 */
export interface LegacyNormalizedPlugin {
  schemaVersion: number;
  id: string;
  name: string;
  version: string;
  description: string;
  author: string;
  distribution?: "manifest" | "bundle";
  permissions: {
    network: string[];
    tools: "none" | "read" | "write";
    files: string[];
    events?: string[];
    graphics?: string[];
    eval?: boolean;
  };
  contributions: {
    skills: unknown[];
    mcpServers: unknown[];
    commands: unknown[];
    toolPacks: unknown[];
    desktopWidgets?: unknown[];
  };
  publisher?: { id: string; publicKey: string };
  signature?: { alg: "ed25519"; value: string };
}

export function toV5View(legacy: LegacyNormalizedPlugin): PluginManifestV5 {
  return {
    schemaVersion: 5,
    id: legacy.id,
    name: legacy.name,
    version: legacy.version,
    description: legacy.description,
    author: legacy.author,
    engines: { heming: LEGACY_ENGINES },
    meta: {},
    distribution: legacy.distribution ?? "manifest",
    permissions: {
      network: legacy.permissions.network,
      tools: legacy.permissions.tools,
      files: legacy.permissions.files,
      events: (legacy.permissions.events ?? []) as PluginPermissionsV5["events"],
      graphics: (legacy.permissions.graphics ?? []) as PluginPermissionsV5["graphics"],
      eval: legacy.permissions.eval ?? false,
    },
    contributions: {
      skills: (legacy.contributions.skills ?? []) as PluginSkillV5[],
      mcpServers: (legacy.contributions.mcpServers ?? []) as PluginMcpServerV5[],
      commands: (legacy.contributions.commands ?? []) as PluginCommandV5[],
      toolPacks: (legacy.contributions.toolPacks ?? []) as PluginToolPackV5[],
      desktopWidgets: (legacy.contributions.desktopWidgets ?? []) as PluginDesktopWidgetV5[],
    },
    ...(legacy.publisher ? { publisher: legacy.publisher } : {}),
    ...(legacy.signature ? { signature: legacy.signature } : {}),
  };
}

/**
 * v5 的 JSON Schema（**只给编辑器补全**）。
 *
 * 实测：`z.toJSONSchema` 不会输出 `.superRefine()` 里的跨字段规则（bundle 贡献限制、
 * MCP host 覆盖、工具名跨束重复、内联/路径二选一）。所以这份 schema 不能当权威校验，
 * 权威校验永远是 `parsePluginManifestV5`；CI 会用本函数比对生成物防漂移。
 */
export function pluginManifestV5JsonSchema(): Record<string, unknown> {
  return z.toJSONSchema(ManifestV5Object, { io: "output" }) as Record<string, unknown>;
}
