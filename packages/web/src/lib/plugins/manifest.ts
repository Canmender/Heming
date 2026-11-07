import { z } from "zod";
import { PALETTE_PAGES } from "../palette/pages.js";
import { hostOfUrl, normalizeNetworkHost } from "./permissions.js";

/**
 * 插件清单（`plugin.json`）的唯一解析入口（d.64 · 统一插件模型 v3）。
 *
 * 插件是纯声明式系统能力包：三类贡献面（技能 / 远程 MCP 服务 / 命令）统一收进
 * `contributions`，并显式声明 `permissions`（网络主机 / 工具风险上限 / 预留文件根）。
 * 清单在进入存储前必须完整校验，解析失败一律给出中文错误并指出字段路径——
 * 不做「尽量猜」的容错，否则坏包会在安装后以半可用状态存在，比直接拒绝更难排查。
 *
 * 版本策略：
 * - **v4**（`PLUGIN_SCHEMA_VERSION`）是当前契约：在 v3 的贡献面之上增加模型接入预设
 *   （`contributions.llmPresets`，只填地址/模型、不带 Key）；
 * - **v3** 仍可安装（技能 / MCP / 命令 / 工具束），但不接受预设——带预设的 v3 直接拒绝，
 *   不静默丢字段；
 * - v1 / v2 继续按原规则解析并归一化；
 * - **v1 / v2 旧包继续按原规则解析**，随后归一化成 v3 结构：
 *   `commands` 空、`permissions.network` = 其服务 host 全集、`permissions.tools = "read"`
 *   （等于「安装时已确认的既有事实」——旧包不回溯拦截）；
 * - 归一化后 `PluginManifest` 恒定具备 `contributions.skills/mcpServers/commands` 与
 *   `permissions { network, tools, files }`，UI 不用再判空。
 *
 * 为什么仍拒绝 stdio/命令类 MCP：那会在用户机器上拉起进程，等于安装即执行
 * 第三方代码；本地进程类集成仍走接口区手动配置或 Registry 安装。
 */

export const PLUGIN_SCHEMA_VERSION = 4;
export const PLUGIN_SCHEMA_VERSIONS = [1, 2, 3, 4] as const;
export const MAX_PLUGIN_SKILLS = 50;
export const MAX_PLUGIN_MCP_SERVERS = 10;
export const MAX_PLUGIN_COMMANDS = 30;
export const MAX_PLUGIN_PERMISSION_HOSTS = 20;
/** 工具束上限（d.65 增补：第四类贡献面，只声明归属，不改执行）。 */
export const MAX_PLUGIN_TOOL_PACKS = 10;
export const MAX_TOOL_PACK_TOOLS = 50;
/** 模型接入预设上限（d.86：插件可以声明「模型连接预设」，只填地址/模型，不带 Key）。 */
export const MAX_PLUGIN_LLM_PRESETS = 20;

/** 预留文件根上限（本轮只校验与展示，不执行）。 */
const MAX_PLUGIN_FILES = 5;
const FILE_PATH_MAX = 200;

const MCP_SERVER_NAME_MAX = 64;
const MCP_SERVER_DESCRIPTION_MAX = 200;
const MCP_SERVER_URL_MAX = 2048;
const LOCAL_MCP_HOSTS = new Set(["localhost", "127.0.0.1", "[::1]", "::1"]);

const SKILL_NAME_MAX = 32;
const SKILL_DESCRIPTION_MAX = 200;
const SKILL_INSTRUCTIONS_MAX = 8000;
const SKILL_TRIGGER_MAX = 64;
const SKILL_TRIGGERS_MAX = 20;
const SKILL_TAGS_MAX = 20;
const SKILL_TAG_MAX = 32;

const COMMAND_ID_RE = /^[a-z0-9][a-z0-9._-]{0,63}$/;
const COMMAND_TITLE_MAX = 64;
const COMMAND_DESCRIPTION_MAX = 200;
const COMMAND_KEYWORDS_MAX = 20;
const COMMAND_KEYWORD_MAX = 32;

/**
 * 工具束里的工具名：精确匹配 MCP 裸工具名（字母数字开头，允许 `.` `_` `:` `-`）。
 *
 * 为什么不用通配符：工具束只做「归属与分组」，写通配符会让「哪些工具属于这个插件」
 * 变成模糊声明，展示时会误导用户；精确名匹配不上就进 `unresolved`，不猜。
 */
const TOOL_NAME_RE = /^[A-Za-z0-9][A-Za-z0-9_.:-]{0,63}$/;
const TOOL_PACK_NAME_MAX = 32;
const TOOL_PACK_DESCRIPTION_MAX = 200;
const LLM_PRESET_LABEL_MAX = 32;
const LLM_PRESET_MODEL_MAX = 128;
const LLM_PRESET_NOTE_MAX = 200;
const LLM_PRESET_BASE_URL_MAX = 2048;

const HOST_MAX = 253;

/** base64url（无填充）解码后的字节数；非法或长度不可能（len%4===1）返回 -1。 */
function base64UrlByteLength(value: string): number {
  if (!/^[A-Za-z0-9_-]+$/.test(value)) return -1;
  if (value.length % 4 === 1) return -1;
  return Math.floor((value.length * 3) / 4);
}

/** 命令 target 可指向的页面 id（单一真源：命令面板的页面目录）。 */
const PAGE_IDS: ReadonlySet<string> = new Set(PALETTE_PAGES.map((page) => page.page));

/** 手写清单里的空字符串条目直接丢弃；非字符串保留，交给内层报类型错误。 */
function dropBlankEntries<T extends z.ZodTypeAny>(schema: T) {
  return z.preprocess((value) => {
    if (!Array.isArray(value)) return value;
    return value.filter((item) => !(typeof item === "string" && !item.trim()));
  }, schema);
}

/**
 * zod 4 把 v3 的 `required_error` 与 `invalid_type_error` 合并成了单个 `error`。
 * 传函数形式时可以按 `issue.input` 是否为 `undefined` 区分「字段缺失」与「类型不对」，
 * 这里把原来的两套中文文案原样保留，保证界面上的报错与 zod 3 时期逐字一致。
 */
function typeParams(missing: string, wrongType?: string) {
  return {
    error: (issue: { input?: unknown }): string =>
      issue.input === undefined ? missing : (wrongType ?? missing),
  };
}

const SkillSpecSchema = z.object(
  {
    name: z
      .string(typeParams("缺少技能名", "技能名必须是文本"))
      .trim()
      .min(1, "技能名不能为空")
      .max(SKILL_NAME_MAX, `技能名最多 ${SKILL_NAME_MAX} 字`),
    description: z
      .string(typeParams("技能描述必须是文本"))
      .trim()
      .max(SKILL_DESCRIPTION_MAX, `技能描述最多 ${SKILL_DESCRIPTION_MAX} 字`)
      .default(""),
    instructions: z
      .string(typeParams("缺少技能指令", "技能指令必须是文本"))
      .trim()
      .min(1, "技能指令不能为空")
      .max(SKILL_INSTRUCTIONS_MAX, `技能指令最多 ${SKILL_INSTRUCTIONS_MAX} 字`),
    triggers: dropBlankEntries(
      z
        .array(
          z
            .string(typeParams("触发词必须是文本"))
            .trim()
            .min(1, "触发词不能为空")
            .max(SKILL_TRIGGER_MAX, `单个触发词最多 ${SKILL_TRIGGER_MAX} 字`),
          typeParams("触发词必须是数组"),
        )
        .max(SKILL_TRIGGERS_MAX, `触发词最多 ${SKILL_TRIGGERS_MAX} 个`)
        .default([]),
    ),
    tags: dropBlankEntries(
      z
        .array(
          z
            .string(typeParams("标签必须是文本"))
            .trim()
            .min(1, "标签不能为空")
            .max(SKILL_TAG_MAX, `单个标签最多 ${SKILL_TAG_MAX} 字`),
          typeParams("标签必须是数组"),
        )
        .max(SKILL_TAGS_MAX, `标签最多 ${SKILL_TAGS_MAX} 个`)
        .default([]),
    ),
  },
  typeParams("技能必须是 JSON 对象"),
);

const McpServerSpecSchema = z
  .object(
    {
      key: z
        .string(typeParams("缺少服务 key", "服务 key 必须是文本"))
        .trim()
        .regex(
          /^[a-z0-9][a-z0-9-]{0,31}$/,
          "服务 key 只能用小写字母、数字和连字符，且以字母或数字开头（≤32）",
        ),
      name: z
        .string(typeParams("缺少服务名", "服务名必须是文本"))
        .trim()
        .min(1, "服务名不能为空")
        .max(MCP_SERVER_NAME_MAX, `服务名最多 ${MCP_SERVER_NAME_MAX} 字`),
      url: z
        .string(typeParams("缺少服务地址", "服务地址必须是文本"))
        .trim()
        .min(1, "服务地址不能为空")
        .max(MCP_SERVER_URL_MAX, `服务地址最多 ${MCP_SERVER_URL_MAX} 字符`),
      description: z
        .string(typeParams("服务描述必须是文本"))
        .trim()
        .max(MCP_SERVER_DESCRIPTION_MAX, `服务描述最多 ${MCP_SERVER_DESCRIPTION_MAX} 字`)
        .default(""),
    },
    typeParams("MCP 服务必须是 JSON 对象"),
  )
  .superRefine((server, ctx) => {
    let url: URL;
    try {
      url = new URL(server.url);
    } catch {
      ctx.addIssue({ code: z.ZodIssueCode.custom, path: ["url"], message: "服务地址不是合法的 URL" });
      return;
    }
    if (url.username || url.password) {
      ctx.addIssue({
        code: z.ZodIssueCode.custom,
        path: ["url"],
        message: "服务地址不能包含用户名或密码（鉴权请在接口区补请求头）",
      });
      return;
    }
    if (url.protocol === "https:") return;
    if (url.protocol === "http:" && LOCAL_MCP_HOSTS.has(url.hostname)) return;
    ctx.addIssue({
      code: z.ZodIssueCode.custom,
      path: ["url"],
      message: "远程 MCP 必须使用 https；http 仅允许 localhost / 127.0.0.1 / [::1]",
    });
  });

/** 命令目标：页面 / 本插件技能 / 插件详情（打开自己的详情面板）。 */
const CommandTargetSchema = z.discriminatedUnion(
  "kind",
  [
    z.object(
      {
        kind: z.literal("page", typeParams("目标类型缺失", "目标类型必须是 page/skill/plugin")),
        page: z.string(typeParams("缺少页面 id", "页面 id 必须是文本")).trim().min(1, "页面 id 不能为空"),
      },
      typeParams("命令目标必须是 JSON 对象"),
    ),
    z.object(
      {
        kind: z.literal("skill"),
        name: z.string(typeParams("缺少技能名", "技能名必须是文本")).trim().min(1, "技能名不能为空"),
      },
      typeParams("命令目标必须是 JSON 对象"),
    ),
    z.object(
      {
        kind: z.literal("plugin"),
      },
      typeParams("命令目标必须是 JSON 对象"),
    ),
  ],
  typeParams("命令目标必须是 JSON 对象（kind: page / skill / plugin）"),
);

const CommandSpecSchema = z.object(
  {
    id: z
      .string(typeParams("缺少命令 id", "命令 id 必须是文本"))
      .trim()
      .regex(COMMAND_ID_RE, "命令 id 只能用小写字母、数字、点、下划线和连字符，且以字母或数字开头（≤64）"),
    title: z
      .string(typeParams("缺少命令标题", "命令标题必须是文本"))
      .trim()
      .min(1, "命令标题不能为空")
      .max(COMMAND_TITLE_MAX, `命令标题最多 ${COMMAND_TITLE_MAX} 字`),
    description: z
      .string(typeParams("命令描述必须是文本"))
      .trim()
      .max(COMMAND_DESCRIPTION_MAX, `命令描述最多 ${COMMAND_DESCRIPTION_MAX} 字`)
      .default(""),
    keywords: dropBlankEntries(
      z
        .array(
          z
            .string(typeParams("关键词必须是文本"))
            .trim()
            .min(1, "关键词不能为空")
            .max(COMMAND_KEYWORD_MAX, `单个关键词最多 ${COMMAND_KEYWORD_MAX} 字`),
          typeParams("关键词必须是数组"),
        )
        .max(COMMAND_KEYWORDS_MAX, `关键词最多 ${COMMAND_KEYWORDS_MAX} 个`)
        .default([]),
    ),
    target: CommandTargetSchema,
  },
  typeParams("命令必须是 JSON 对象"),
);

/**
 * 主机白名单条目：`host` 或 `host:port`，不含协议/路径/账号。
 * 用 URL 反解析校验：它同时覆盖 IPv4、域名与 `[::1]:8787` 这类 IPv6 字面量。
 *
 * 这里只校验「像不像主机」；默认端口（80/443）在比对前由
 * `normalizeNetworkHost` 统一规范化——所以 `api.acme.com:443` 是合法写法，
 * 不该因为 URL 把它规范化掉就判成格式错误（d.77 修复）。
 */
function isHostLike(value: string): boolean {
  if (!value || /[\s/\\?#@]/.test(value)) return false;
  try {
    const url = new URL(`http://${value}`);
    return url.hostname.length > 0;
  } catch {
    return false;
  }
}

const HostSchema = z
  .string(typeParams("网络主机必须是文本"))
  .trim()
  .min(1, "网络主机不能为空")
  .max(HOST_MAX, `单个主机最多 ${HOST_MAX} 字符`)
  .refine(isHostLike, "网络主机只能写 host 或 host:port（不含协议、路径与账号密码）");

/** 预留文件根：相对路径，不允许绝对路径与 `..`（本轮只校验与展示）。 */
function isRelativePath(value: string): boolean {
  if (!value || value.length > FILE_PATH_MAX) return false;
  if (value.startsWith("/") || value.startsWith("\\")) return false;
  if (/^[a-zA-Z]:/.test(value)) return false;
  return !value.replace(/\\/g, "/").split("/").some((part) => part === "..");
}

const FilePathSchema = z
  .string(typeParams("文件根必须是文本"))
  .trim()
  .min(1, "文件根不能为空")
  .max(FILE_PATH_MAX, `单个文件根最多 ${FILE_PATH_MAX} 字符`)
  .refine(isRelativePath, "文件根必须是相对路径（不能以 / 或盘符开头，也不能包含 ..）");

const PermissionsSchema = z.object(
  {
    network: dropBlankEntries(
      z
        .array(HostSchema, typeParams("权限网络列表必须是数组"))
        .max(MAX_PLUGIN_PERMISSION_HOSTS, `网络主机最多 ${MAX_PLUGIN_PERMISSION_HOSTS} 个`)
        .default([]),
    ),
    tools: z
      .enum(["none", "read", "write"], {
        error: 'permissions.tools 只能是 "none" / "read" / "write"',
      })
      .default("read"),
    files: dropBlankEntries(
      z
        .array(FilePathSchema, typeParams("权限文件列表必须是数组"))
        .max(MAX_PLUGIN_FILES, `预留文件根最多 ${MAX_PLUGIN_FILES} 个`)
        .default([]),
    ),
  },
  typeParams("permissions 必须是 JSON 对象"),
);

/** 工具束：一组工具名的**声明式分组**（不定义工具、不改变开关与 HITL）。 */
const ToolPackSpecSchema = z.object(
  {
    id: z
      .string(typeParams("缺少工具束 id", "工具束 id 必须是文本"))
      .trim()
      .regex(COMMAND_ID_RE, "工具束 id 只能用小写字母、数字、点、下划线和连字符，且以字母或数字开头（≤64）"),
    name: z
      .string(typeParams("缺少工具束名", "工具束名必须是文本"))
      .trim()
      .min(1, "工具束名不能为空")
      .max(TOOL_PACK_NAME_MAX, `工具束名最多 ${TOOL_PACK_NAME_MAX} 字`),
    description: z
      .string(typeParams("工具束描述必须是文本"))
      .trim()
      .max(TOOL_PACK_DESCRIPTION_MAX, `工具束描述最多 ${TOOL_PACK_DESCRIPTION_MAX} 字`)
      .default(""),
    tools: z
      .array(
        z
          .string(typeParams("工具名必须是文本"))
          .trim()
          .regex(TOOL_NAME_RE, "工具名只能由字母、数字和 . _ : - 组成，且以字母或数字开头（≤64）"),
        typeParams("工具列表必须是数组"),
      )
      .max(MAX_TOOL_PACK_TOOLS, `单个工具束最多 ${MAX_TOOL_PACK_TOOLS} 个工具`),
  },
  typeParams("工具束必须是 JSON 对象"),
);

/**
 * 模型接入预设（d.86）：插件带来的「连接怎么填」模板。
 *
 * 只允许声明协议 / Base URL / 模型 / 说明——**没有 apiKey 字段**。
 * 远程必须 https，明文 http 仅放行本机回环（与本仓 MCP 服务地址同一套约束）：
 * 预设会把用户引到一个地址上，地址规则两边必须一致，否则插件能绕开「不能明文出网」。
 */
const LlmPresetSpecSchema = z
  .strictObject(
    {
      id: z
        .string(typeParams("缺少预设 id", "预设 id 必须是文本"))
        .trim()
        .regex(COMMAND_ID_RE, "预设 id 只能用小写字母、数字、点、下划线和连字符，且以字母或数字开头（≤64）"),
      label: z
        .string(typeParams("缺少预设名", "预设名必须是文本"))
        .trim()
        .min(1, "预设名不能为空")
        .max(LLM_PRESET_LABEL_MAX, `预设名最多 ${LLM_PRESET_LABEL_MAX} 字`),
      provider: z.enum(["openai", "anthropic"], {
        error: '预设协议只能是 "openai"（OpenAI 兼容）或 "anthropic"（Messages API）',
      }),
      baseUrl: z
        .string(typeParams("缺少 Base URL", "Base URL 必须是文本"))
        .trim()
        .min(1, "Base URL 不能为空")
        .max(LLM_PRESET_BASE_URL_MAX, `Base URL 最多 ${LLM_PRESET_BASE_URL_MAX} 字符`),
      model: z
        .string(typeParams("缺少模型名", "模型名必须是文本"))
        .trim()
        .min(1, "模型名不能为空")
        .max(LLM_PRESET_MODEL_MAX, `模型名最多 ${LLM_PRESET_MODEL_MAX} 字`),
      note: z
        .string(typeParams("预设说明必须是文本"))
        .trim()
        .max(LLM_PRESET_NOTE_MAX, `预设说明最多 ${LLM_PRESET_NOTE_MAX} 字`)
        .default(""),
    },
  )
  .superRefine((preset, ctx) => {
    let url: URL;
    try {
      url = new URL(preset.baseUrl);
    } catch {
      ctx.addIssue({ code: z.ZodIssueCode.custom, path: ["baseUrl"], message: "Base URL 不是合法的 URL" });
      return;
    }
    if (url.username || url.password) {
      ctx.addIssue({
        code: z.ZodIssueCode.custom,
        path: ["baseUrl"],
        message: "Base URL 不能包含用户名或密码（Key 由用户自己在表单里填）",
      });
      return;
    }
    if (url.protocol === "https:") return;
    if (url.protocol === "http:" && LOCAL_MCP_HOSTS.has(url.hostname)) return;
    ctx.addIssue({
      code: z.ZodIssueCode.custom,
      path: ["baseUrl"],
      message: "模型地址必须使用 https；http 仅允许 localhost / 127.0.0.1 / [::1]",
    });
  });

const ContributionsSchema = z.object(
  {
    skills: z
      .array(SkillSpecSchema, typeParams("技能列表必须是数组"))
      .max(MAX_PLUGIN_SKILLS, `单个插件最多 ${MAX_PLUGIN_SKILLS} 个技能`)
      .default([]),
    mcpServers: z
      .array(McpServerSpecSchema, typeParams("MCP 服务列表必须是数组"))
      .max(MAX_PLUGIN_MCP_SERVERS, `单个插件最多 ${MAX_PLUGIN_MCP_SERVERS} 台 MCP 服务`)
      .default([]),
    commands: z
      .array(CommandSpecSchema, typeParams("命令列表必须是数组"))
      .max(MAX_PLUGIN_COMMANDS, `单个插件最多 ${MAX_PLUGIN_COMMANDS} 个命令`)
      .default([]),
    toolPacks: z
      .array(ToolPackSpecSchema, typeParams("工具束列表必须是数组"))
      .max(MAX_PLUGIN_TOOL_PACKS, `单个插件最多 ${MAX_PLUGIN_TOOL_PACKS} 个工具束`)
      .default([]),
    // d.86：模型接入预设（只填地址/模型，不含 Key；publisher 仍是插件作者）
    llmPresets: z
      .array(LlmPresetSpecSchema, typeParams("模型预设列表必须是数组"))
      .max(MAX_PLUGIN_LLM_PRESETS, `单个插件最多 ${MAX_PLUGIN_LLM_PRESETS} 个模型预设`)
      .default([]),
  },
  typeParams("contributions 必须是 JSON 对象"),
);

/**
 * 发布者公钥（d.67，TOFU 模型）：Ed25519 raw 公钥 32 字节，base64url（无填充）。
 *
 * 只做**格式**校验；是否可信由安装时的首次信任/换钥复核决定（见 signature.ts）。
 */
const PublisherSchema = z.object(
  {
    id: z
      .string(typeParams("缺少发布者 id", "发布者 id 必须是文本"))
      .trim()
      .regex(
        COMMAND_ID_RE,
        "发布者 id 只能用小写字母、数字、点、下划线和连字符，且以字母或数字开头（≤64）",
      ),
    publicKey: z
      .string(typeParams("缺少发布者公钥", "发布者公钥必须是文本"))
      .trim()
      .refine(
        (value) => base64UrlByteLength(value) === 32,
        "发布者公钥必须是 base64url 编码的 Ed25519 raw 公钥（32 字节）",
      ),
  },
  typeParams("publisher 必须是 JSON 对象"),
);

/** 清单签名（d.67）：目前只支持 ed25519，值为 base64url 64 字节。 */
const SignatureSchema = z.object(
  {
    alg: z.literal("ed25519", { error: 'signature.alg 只支持 "ed25519"' }),
    value: z
      .string(typeParams("缺少签名值", "签名值必须是文本"))
      .trim()
      .refine(
        (value) => base64UrlByteLength(value) === 64,
        "签名值必须是 base64url 编码的 Ed25519 签名（64 字节）",
      ),
  },
  typeParams("signature 必须是 JSON 对象"),
);

const PluginManifestSchema = z
  .object(
    {
      schemaVersion: z.union([z.literal(1), z.literal(2), z.literal(3), z.literal(4)], {
        // zod 4 去掉了 errorMap，直接给一个字符串即覆盖这一层的所有报错文案。
        error: `仅支持 schemaVersion: ${PLUGIN_SCHEMA_VERSIONS.join(" / ")}`,
      }),
      id: z
        .string(typeParams("缺少插件 id", "插件 id 必须是文本"))
        .trim()
        .regex(
          /^[a-z0-9][a-z0-9._-]{0,63}$/,
          "插件 id 只能用小写字母、数字、点、下划线和连字符，且以字母或数字开头（≤64）",
        ),
      name: z
        .string(typeParams("缺少插件名", "插件名必须是文本"))
        .trim()
        .min(1, "插件名不能为空")
        .max(64, "插件名最多 64 字"),
      version: z
        .string(typeParams("缺少版本号", "版本号必须是文本"))
        .trim()
        .min(1, "版本号不能为空")
        .max(32, "版本号最多 32 字"),
      description: z
        .string(typeParams("插件描述必须是文本"))
        .trim()
        .max(200, "插件描述最多 200 字")
        .default(""),
      author: z
        .string(typeParams("作者名必须是文本"))
        .trim()
        .max(64, "作者名最多 64 字")
        .default(""),
      // v1/v2 的顶层字段（仅旧包使用；v3 进来会被 parsePluginManifest 的迁移提示拦下）
      skills: z
        .array(SkillSpecSchema, typeParams("技能列表必须是数组"))
        .max(MAX_PLUGIN_SKILLS, `单个插件最多 ${MAX_PLUGIN_SKILLS} 个技能`)
        .optional(),
      mcpServers: z
        .array(McpServerSpecSchema, typeParams("MCP 服务列表必须是数组"))
        .max(MAX_PLUGIN_MCP_SERVERS, `单个插件最多 ${MAX_PLUGIN_MCP_SERVERS} 台 MCP 服务`)
        .optional(),
      // v3 的贡献面
      contributions: ContributionsSchema.optional(),
      // v3 的权限声明（无 MCP 服务时可省略）
      permissions: PermissionsSchema.optional(),
      // v3 的可选签名与发布者（d.67；旧 v3 清单没有这两个字段照样合法）
      publisher: PublisherSchema.optional(),
      signature: SignatureSchema.optional(),
    },
    typeParams("插件清单必须是 JSON 对象"),
  )
  .superRefine((manifest, ctx) => {
    const legacy = manifest.schemaVersion < 3;
    const skills = legacy ? (manifest.skills ?? []) : (manifest.contributions?.skills ?? []);
    const servers = legacy ? (manifest.mcpServers ?? []) : (manifest.contributions?.mcpServers ?? []);
    const commands = legacy ? [] : (manifest.contributions?.commands ?? []);
    const toolPacks = legacy ? [] : (manifest.contributions?.toolPacks ?? []);
    const llmPresets = legacy ? [] : (manifest.contributions?.llmPresets ?? []);

    if (legacy && manifest.contributions) {
      ctx.addIssue({
        code: z.ZodIssueCode.custom,
        path: ["contributions"],
        message: `schemaVersion ${manifest.schemaVersion} 请使用顶层 skills / mcpServers；升级到 schemaVersion 3 才支持 contributions`,
      });
    }
    if (legacy && manifest.permissions) {
      ctx.addIssue({
        code: z.ZodIssueCode.custom,
        path: ["permissions"],
        message: `schemaVersion ${manifest.schemaVersion} 不支持权限声明，请升级到 schemaVersion 3`,
      });
    }
    if (legacy && manifest.publisher) {
      ctx.addIssue({
        code: z.ZodIssueCode.custom,
        path: ["publisher"],
        message: `schemaVersion ${manifest.schemaVersion} 不支持 publisher，请升级到 schemaVersion 3`,
      });
    }
    if (legacy && manifest.signature) {
      ctx.addIssue({
        code: z.ZodIssueCode.custom,
        path: ["signature"],
        message: `schemaVersion ${manifest.schemaVersion} 不支持 signature，请升级到 schemaVersion 3`,
      });
    }
    // 有签名必须有发布者：验签公钥只能来自 publisher，缺了就无法判断签名有效性。
    if (manifest.signature && !manifest.publisher) {
      ctx.addIssue({
        code: z.ZodIssueCode.custom,
        path: ["signature"],
        message: "有 signature 时必须同时提供 publisher（否则无法确定验签公钥）",
      });
    }

    if (manifest.schemaVersion === 1) {
      if (skills.length === 0) {
        ctx.addIssue({
          code: z.ZodIssueCode.custom,
          path: ["skills"],
          message: "插件至少要包含 1 个技能",
        });
      }
      if (servers.length > 0) {
        ctx.addIssue({
          code: z.ZodIssueCode.custom,
          path: ["mcpServers"],
          message: "schemaVersion 1 不支持 MCP 服务，请升级到 schemaVersion 2 或 3",
        });
      }
    }

    if (manifest.schemaVersion === 3 && llmPresets.length > 0) {
      ctx.addIssue({
        code: z.ZodIssueCode.custom,
        path: ["contributions", "llmPresets"],
        message: "模型接入预设需要 schemaVersion 4（旧版本应用不认识它，宁可拒绝也不要静默丢掉）",
      });
    }

    if (!legacy) {
      if (!manifest.contributions) {
        ctx.addIssue({
          code: z.ZodIssueCode.custom,
          path: ["contributions"],
          message: `schemaVersion ${manifest.schemaVersion} 必须声明 contributions（技能 / MCP 服务 / 命令 / 工具束 / 模型预设至少一类）`,
        });
      } else if (
        skills.length + servers.length + commands.length + toolPacks.length + llmPresets.length ===
        0
      ) {
        ctx.addIssue({
          code: z.ZodIssueCode.custom,
          path: ["contributions"],
          message: "插件至少要包含 1 项能力（技能 / MCP 服务 / 命令 / 工具束 / 模型预设）",
        });
      }
    } else if (skills.length + servers.length === 0) {
      ctx.addIssue({
        code: z.ZodIssueCode.custom,
        path: ["skills"],
        message: "插件至少要包含 1 项能力（技能或 MCP 服务）",
      });
    }

    const seenSkills = new Set<string>();
    skills.forEach((skill, index) => {
      if (seenSkills.has(skill.name)) {
        ctx.addIssue({
          code: z.ZodIssueCode.custom,
          path: legacy ? ["skills", index, "name"] : ["contributions", "skills", index, "name"],
          message: `技能名重复：${skill.name}`,
        });
      }
      seenSkills.add(skill.name);
    });

    const seenServers = new Set<string>();
    servers.forEach((server, index) => {
      if (seenServers.has(server.key)) {
        ctx.addIssue({
          code: z.ZodIssueCode.custom,
          path: legacy ? ["mcpServers", index, "key"] : ["contributions", "mcpServers", index, "key"],
          message: `服务 key 重复：${server.key}`,
        });
      }
      seenServers.add(server.key);
    });

    // v4：模型预设的 Base URL 主机也必须被权限声明覆盖（预设会把用户引到这个地址）。
    if (!legacy) {
      const declaredHosts = new Set(
        (manifest.permissions?.network ?? []).map(normalizeNetworkHost),
      );
      const seenPresets = new Set<string>();
      llmPresets.forEach((preset, index) => {
        if (seenPresets.has(preset.id)) {
          ctx.addIssue({
            code: z.ZodIssueCode.custom,
            path: ["contributions", "llmPresets", index, "id"],
            message: `预设 id 重复：${preset.id}`,
          });
        }
        seenPresets.add(preset.id);
        const host = hostOfUrl(preset.baseUrl);
        if (host && !declaredHosts.has(host)) {
          ctx.addIssue({
            code: z.ZodIssueCode.custom,
            path: ["permissions", "network"],
            message: `未声明模型地址主机：${host}（见 contributions.llmPresets[${index}].baseUrl）`,
          });
        }
      });
    }

    // v3：权限声明必须覆盖全部 MCP 服务主机（声明即约束）。
    if (!legacy) {
      const declared = new Set(
        (manifest.permissions?.network ?? []).map(normalizeNetworkHost),
      );
      servers.forEach((server, index) => {
        const host = hostOfUrl(server.url);
        if (!host || declared.has(host)) return;
        ctx.addIssue({
          code: z.ZodIssueCode.custom,
          path: ["permissions", "network"],
          message: `未声明 MCP 服务主机：${host}（见 contributions.mcpServers[${index}].url）`,
        });
      });
    }

    // v3：命令 id 唯一、目标必须可解析。
    const seenCommands = new Set<string>();
    commands.forEach((command, index) => {
      if (seenCommands.has(command.id)) {
        ctx.addIssue({
          code: z.ZodIssueCode.custom,
          path: ["contributions", "commands", index, "id"],
          message: `命令 id 重复：${command.id}`,
        });
      }
      seenCommands.add(command.id);
      if (command.target.kind === "page" && !PAGE_IDS.has(command.target.page)) {
        ctx.addIssue({
          code: z.ZodIssueCode.custom,
          path: ["contributions", "commands", index, "target", "page"],
          message: `未知页面：${command.target.page}`,
        });
      }
      if (command.target.kind === "skill" && !seenSkills.has(command.target.name)) {
        ctx.addIssue({
          code: z.ZodIssueCode.custom,
          path: ["contributions", "commands", index, "target", "name"],
          message: `command 目标技能不存在于本插件：${command.target.name}`,
        });
      }
    });

    // v3：工具束 id 唯一；同一个工具不能被两个工具束同时声明（否则归属展示会自相矛盾）。
    // 报错必须点名**两处**字段路径，用户才知道改哪一行。
    const seenPacks = new Set<string>();
    const toolOwners = new Map<string, string>();
    toolPacks.forEach((pack, packIndex) => {
      if (seenPacks.has(pack.id)) {
        ctx.addIssue({
          code: z.ZodIssueCode.custom,
          path: ["contributions", "toolPacks", packIndex, "id"],
          message: `工具束 id 重复：${pack.id}`,
        });
      }
      seenPacks.add(pack.id);
      pack.tools.forEach((tool, toolIndex) => {
        const path = `contributions.toolPacks[${packIndex}].tools[${toolIndex}]`;
        const first = toolOwners.get(tool);
        if (first) {
          ctx.addIssue({
            code: z.ZodIssueCode.custom,
            path: ["contributions", "toolPacks", packIndex, "tools", toolIndex],
            message: `工具名重复：${tool}（已由 ${first} 声明）`,
          });
          return;
        }
        toolOwners.set(tool, path);
      });
    });
  });

export type PluginSkillSpec = z.infer<typeof SkillSpecSchema>;
export type PluginMcpServerSpec = z.infer<typeof McpServerSpecSchema>;
export type PluginCommandSpec = z.infer<typeof CommandSpecSchema>;
export type PluginToolPackSpec = z.infer<typeof ToolPackSpecSchema>;
export type PluginLlmPresetSpec = z.infer<typeof LlmPresetSpecSchema>;
export type PluginSchemaVersion = (typeof PLUGIN_SCHEMA_VERSIONS)[number];
export type PluginToolRisk = "none" | "read" | "write";

/** 归一化后的权限声明（v1/v2 也会补全，UI 不用判空）。 */
export interface PluginPermissions {
  /** 网络主机白名单（host 或 host:port）。 */
  network: string[];
  /** 本插件 MCP 工具的风险上限（只能收紧，不放宽 HITL）。 */
  tools: PluginToolRisk;
  /** 预留文件根（本轮只校验与展示，不执行）。 */
  files: string[];
}

/**
 * 五类贡献面：技能 / 远程 MCP 服务 / 命令 / 工具束 / 模型接入预设。
 *
 * `toolPacks` 是 d.65 的**向后兼容增补**（schemaVersion 仍为 3）：老清单没有该字段
 * 照样合法；它只声明「哪些工具属于同一组」，不定义工具、不改变开关与 HITL。
 */
export interface PluginContributions {
  skills: PluginSkillSpec[];
  mcpServers: PluginMcpServerSpec[];
  commands: PluginCommandSpec[];
  toolPacks: PluginToolPackSpec[];
  /**
   * 模型接入预设（d.86）：插件带来「一条连接怎么填」的模板（协议 / Base URL / 模型 / 说明），
   * **不含 Key**——用户点一下只是把表单填好，Key 仍由用户自己填、仍存本机安全存储。
   * v1–v3 旧清单归一化为空数组。
   */
  llmPresets: PluginLlmPresetSpec[];
}

/** 发布者声明（d.67，TOFU）：公钥只是内容，不证明身份；信任由首次安装确认。 */
export interface PluginPublisher {
  id: string;
  /** base64url（无填充）编码的 Ed25519 raw 公钥（32 字节）。 */
  publicKey: string;
}

/** 清单签名（d.67）。只覆盖语义内容（含 publisher），不含 signature 自己。 */
export interface PluginSignature {
  alg: "ed25519";
  /** base64url（无填充）编码的 64 字节签名。 */
  value: string;
}

/**
 * 归一化后的插件清单（唯一对外形态）。
 *
 * ★ `schemaVersion` 保留原始版本号（1/2/3）：安装弹窗要据此提示「旧版清单（v2）」；
 * 但 `contributions` / `permissions` 一定存在且为 v3 形状。
 */
export interface PluginManifest {
  schemaVersion: PluginSchemaVersion;
  id: string;
  name: string;
  version: string;
  description: string;
  author: string;
  contributions: PluginContributions;
  permissions: PluginPermissions;
  /** 可选：发布者与签名（d.67；旧 v3 清单没有这两个字段）。 */
  publisher?: PluginPublisher;
  signature?: PluginSignature;
}

/** 清单错误：`message` 已是可直接展示的中文。 */
export class PluginManifestError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "PluginManifestError";
  }
}

function pathLabel(path: readonly PropertyKey[]): string {
  let out = "";
  for (const part of path) {
    if (typeof part === "number") out += `[${part}]`;
    // zod 4 把 issue.path 的类型从 (string | number)[] 放宽成了 PropertyKey[]（可能含 symbol）。
    // 实际只会出现字符串与数字；这里用 String() 兜底，避免 symbol 拼接时直接抛 TypeError。
    else out += out ? `.${String(part)}` : String(part);
  }
  return out;
}

function formatIssues(error: z.ZodError): string {
  const parts = error.issues.slice(0, 3).map((issue) => {
    const at = pathLabel(issue.path);
    return at ? `${at}：${issue.message}` : issue.message;
  });
  const rest = error.issues.length - parts.length;
  return parts.join("；") + (rest > 0 ? `；另有 ${rest} 处错误` : "");
}

function uniq(items: string[]): string[] {
  return [...new Set(items.filter(Boolean))];
}

/** 旧版清单的权限兜底：网络 = 其服务 host 全集、工具上限 read（等于既有事实）。 */
function legacyPermissions(servers: PluginMcpServerSpec[]): PluginPermissions {
  return {
    network: uniq(servers.map((server) => hostOfUrl(server.url)).filter(Boolean)),
    tools: "read",
    files: [],
  };
}

/**
 * 解析插件清单。接受 JSON 文本或已解析对象；失败抛 `PluginManifestError`。
 * 未知字段由 zod 丢弃，不会进入存储。
 */
export function parsePluginManifest(input: string | unknown): PluginManifest {
  let raw: unknown = input;
  if (typeof input === "string") {
    if (!input.trim()) throw new PluginManifestError("插件清单为空，请粘贴 plugin.json 内容");
    try {
      raw = JSON.parse(input);
    } catch {
      throw new PluginManifestError("不是有效的 JSON，请检查逗号、引号与括号是否配对");
    }
  }
  // v3 迁移提示必须在 zod 之前判：未知字段会被丢弃，schema 里看不到它们。
  if (raw && typeof raw === "object" && !Array.isArray(raw)) {
    const record = raw as Record<string, unknown>;
    if (record.schemaVersion === 3) {
      if ("skills" in record) {
        throw new PluginManifestError(
          "schemaVersion 3 不再接受顶层 skills，请迁移到 contributions.skills",
        );
      }
      if ("mcpServers" in record) {
        throw new PluginManifestError(
          "schemaVersion 3 不再接受顶层 mcpServers，请迁移到 contributions.mcpServers",
        );
      }
    }
  }
  const parsed = PluginManifestSchema.safeParse(raw);
  if (!parsed.success) throw new PluginManifestError(formatIssues(parsed.error));
  const manifest = parsed.data;
  const legacy = manifest.schemaVersion < 3;
  const legacySkills = manifest.skills ?? [];
  const legacyServers = manifest.mcpServers ?? [];
  const contributions: PluginContributions = {
    skills: (legacy ? legacySkills : (manifest.contributions?.skills ?? [])).map((skill) => ({
      ...skill,
      triggers: uniq(skill.triggers),
      tags: uniq(skill.tags),
    })),
    mcpServers: (legacy ? legacyServers : (manifest.contributions?.mcpServers ?? [])).map((server) => ({
      ...server,
    })),
    commands: legacy
      ? []
      : (manifest.contributions?.commands ?? []).map((command) => ({
          ...command,
          keywords: uniq(command.keywords),
          target: { ...command.target },
        })),
    toolPacks: legacy
      ? []
      : (manifest.contributions?.toolPacks ?? []).map((pack) => ({
          ...pack,
          tools: [...pack.tools],
        })),
    llmPresets: legacy
      ? []
      : (manifest.contributions?.llmPresets ?? []).map((preset) => ({ ...preset })),
  };
  const permissions: PluginPermissions = legacy
    ? legacyPermissions(contributions.mcpServers)
    : {
        network: uniq((manifest.permissions?.network ?? []).map((host) => host.toLowerCase())),
        tools: manifest.permissions?.tools ?? "read",
        files: uniq(manifest.permissions?.files ?? []),
      };
  return {
    schemaVersion: manifest.schemaVersion,
    id: manifest.id,
    name: manifest.name,
    version: manifest.version,
    description: manifest.description,
    author: manifest.author,
    contributions,
    permissions,
    // 旧版清单不允许带签名（superRefine 已拒绝），这里只透传 v3 的可选字段。
    ...(manifest.publisher ? { publisher: { ...manifest.publisher } } : {}),
    ...(manifest.signature ? { signature: { ...manifest.signature } } : {}),
  };
}
