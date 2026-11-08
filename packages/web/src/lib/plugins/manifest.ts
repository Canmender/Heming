import { z } from "zod";
import {
  LEGACY_ENGINES,
  PluginManifestInvalidError,
  enginesStatus,
  parsePluginManifestV5,
  toV5View,
  type EnginesStatus,
  type LegacyNormalizedPlugin,
  type PluginManifestV5,
  type PluginMetaV5,
  type PluginV5ParseResult,
} from "@heming/shared";
import { PALETTE_PAGES } from "../palette/pages.js";
import { settingsCardById } from "../settings/registry.js";
import { hostOfUrl, normalizeNetworkHost } from "./permissions.js";

/**
 * 插件清单（`plugin.json`）的唯一解析入口（d.98 · 统一插件模型 v4）。
 *
 * 插件是纯声明式系统能力包：三类贡献面（技能 / 远程 MCP 服务 / 命令）统一收进
 * `contributions`，并显式声明 `permissions`（网络主机 / 工具风险上限 / 预留文件根）。
 * 清单在进入存储前必须完整校验，解析失败一律给出中文错误并指出字段路径——
 * 不做「尽量猜」的容错，否则坏包会在安装后以半可用状态存在，比直接拒绝更难排查。
 *
 * 版本策略：
 * - **v5**（`packages/shared/src/plugin/manifest.ts` 的 `parsePluginManifestV5`）是当前契约：
 *   在 v4 之上增加 `engines.heming`（最小宿主版本）与 `meta`（上架元数据），
 *   并用分层严格度挡住「权限/贡献写错位置」的笔误（顶层未知键警告、敏感子对象 strict）。
 *   解析结果的权威形状在 shared；本文件只补 web 独有的两件事：命令 `target.page`
 *   必须存在于命令面板的 `PALETTE_PAGES`、`target.settings.card` 必须存在于
 *   `SETTINGS_CARDS`（单元目标只校验 id 字符集，允许指向将来才安装的单元），
 *   然后投射到既有内部 `PluginManifest`。
 * - **v4**（`PLUGIN_SCHEMA_VERSION`）仍可安装：界面插件声明
 *   （`distribution` + `contributions.desktopWidgets` + `permissions.events/graphics/eval`）。
 *   工具束 / 签名 / 权限语义一字未改；
 * - **v3** 仍可安装（技能 / MCP / 命令 / 工具束），但**不接受 v4 新增字段**——带了
 *   `distribution` / `contributions.desktopWidgets` / `permissions.events|graphics|eval`
 *   的 v3 清单直接拒绝并给字段路径，不静默丢字段（d.88 的 v4 教训：zod 会静默 strip）；
 * - v1 / v2 继续按原规则解析并归一化；
 * - 归一化后 `PluginManifest` 恒定具备 `distribution`、`contributions.desktopWidgets`
 *   与 `permissions { network, tools, files, events, graphics, eval }`，UI 不用再判空。
 *   `engines` / `meta` 只对 v5 存在（可选字段），旧包不会凭空多出这两个字段。
 *
 * 为什么仍拒绝 stdio/命令类 MCP：那会在用户机器上拉起进程，等于安装即执行
 * 第三方代码；本地进程类集成仍走接口区手动配置或 Registry 安装。
 *
 * ★ 界面插件（bundle）的**代码执行/签名/首方限制**不在这里判：
 *   本文件只校验清单形状；「非第一方 bundle 拒绝」「tgz 配额/路径穿越」由主进程安装器
 *   （`widgets:install`）在写盘前完成。web 侧的声明式安装管线见到 bundle 清单一律拒绝，
 *   避免把「带可执行内容」的包装进只存技能/MCP 的本机插件存储。
 */

export const PLUGIN_SCHEMA_VERSION = 4;
/**
 * 可安装的清单版本。
 *
 * v5 的解析器在 `@heming/shared`（web / server / lint 共用一份），这里保留 v1–v4 的
 * 旧解析路径（旧包的迁移提示与展示口径与 web 强绑定，搬去 shared 只会制造两份规则）。
 */
export const PLUGIN_SCHEMA_VERSIONS = [1, 2, 3, 4, 5] as const;
export const MAX_PLUGIN_SKILLS = 50;
export const MAX_PLUGIN_MCP_SERVERS = 10;
export const MAX_PLUGIN_COMMANDS = 30;
export const MAX_PLUGIN_PERMISSION_HOSTS = 20;
/** 工具束上限（d.65 增补：第四类贡献面，只声明归属，不改执行）。 */
export const MAX_PLUGIN_TOOL_PACKS = 10;
export const MAX_TOOL_PACK_TOOLS = 50;
/** 界面插件上限（d.98 P0：一个插件包本轮只允许 1 个桌面小组件）。 */
export const MAX_PLUGIN_DESKTOP_WIDGETS = 1;
/** 缩放档位上限（规格 §2.3：1–6 档）。 */
export const MAX_DESKTOP_WIDGET_SCALES = 6;
/** 通用设置表单最多字段数（防止清单把设置页撑爆）。 */
export const MAX_WIDGET_SETTING_FIELDS = 20;
/** `select` 字段最多选项数。 */
export const MAX_WIDGET_SETTING_OPTIONS = 20;

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

const HOST_MAX = 253;

/** base64url（无填充）解码后的字节数；非法或长度不可能（len%4===1）返回 -1。 */
function base64UrlByteLength(value: string): number {
  if (!/^[A-Za-z0-9_-]+$/.test(value)) return -1;
  if (value.length % 4 === 1) return -1;
  return Math.floor((value.length * 3) / 4);
}

/** 命令 target 可指向的页面 id（单一真源：命令面板的页面目录）。 */
const PAGE_IDS: ReadonlySet<string> = new Set(PALETTE_PAGES.map((page) => page.page));

/**
 * 命令 target 指向的能力单元 id：与插件/单元 id 同规则。
 *
 * 只校验字符集，**不要求单元已安装**——命令可以指向上架后才安装的单元，
 * 否则「先装命令插件、后装它指向的单元」这种正常顺序会被解析器挡住。
 */
const UNIT_ID_RE = /^[a-z0-9][a-z0-9._-]{0,63}$/;
const UNIT_ID_MESSAGE = "单元 id 只能用小写字母、数字、点、下划线、连字符，且以字母或数字开头（≤64）";

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

/**
 * 命令目标：页面 / 本插件技能 / 插件详情 / 设置卡 / 能力单元（d.108 规格附录 A）。
 *
 * `settings.card` 的存在性不在这里判：schema 只认形状，卡片目录属于 settings 模块，
 * 由下面的后置校验统一检查（和 `target.page` 对 `PALETTE_PAGES` 同一思路）。
 */
const CommandTargetSchema = z.discriminatedUnion(
  "kind",
  [
    z.object(
      {
        kind: z.literal(
          "page",
          typeParams("目标类型缺失", "目标类型必须是 page/skill/plugin/settings/unit"),
        ),
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
    z.object(
      {
        kind: z.literal("settings"),
        card: z
          .string(typeParams("缺少设置卡 id", "设置卡 id 必须是文本"))
          .trim()
          .min(1, "设置卡 id 不能为空")
          .max(64, "设置卡 id 最多 64 字符"),
      },
      typeParams("命令目标必须是 JSON 对象"),
    ),
    z.object(
      {
        kind: z.literal("unit"),
        unitId: z
          .string(typeParams("缺少单元 id", "单元 id 必须是文本"))
          .trim()
          .regex(UNIT_ID_RE, UNIT_ID_MESSAGE),
      },
      typeParams("命令目标必须是 JSON 对象"),
    ),
  ],
  typeParams("命令目标必须是 JSON 对象（kind: page / skill / plugin / settings / unit）"),
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
    /**
     * d.98 新增（v4）：界面插件可接收的事件类别。
     *
     * 用 `optional` 与 desktopWidgets 同理——v3 带这三个字段要能被识别并拒绝。
     * 归一化后未声明即为空数组（不接收任何事件）。
     */
    events: z
      .array(z.enum(["notify"], { error: 'permissions.events 目前只支持 "notify"' }), typeParams("事件列表必须是数组"))
      .max(8, "事件最多 8 个")
      .optional(),
    /** d.98 新增（v4）：渲染能力声明（决定 widget 的 CSP，如 wasm → 'wasm-unsafe-eval'）。 */
    graphics: z
      .array(z.enum(["webgl", "wasm"], { error: 'permissions.graphics 只支持 "webgl" / "wasm"' }), typeParams("渲染能力列表必须是数组"))
      .max(8, "渲染能力最多 8 个")
      .optional(),
    /** d.98 新增（v4）：是否允许 `unsafe-eval`（pixi6 需要 true；只对声明了的第一方 widget 放开）。 */
    eval: z.boolean(typeParams("permissions.eval 必须是布尔值")).optional(),
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

/* ══════════════════ d.98 · 界面插件声明（规格 §2.3） ══════════════════ */

const WIDGET_ID_RE = /^[a-z0-9][a-z0-9-]{0,31}$/;
const WIDGET_NAME_MAX = 32;
const WIDGET_ENTRY_MAX = 200;
const WIDGET_DIMENSION_MIN = 96;
const WIDGET_DIMENSION_MAX = 1024;
const WIDGET_SCALE_MIN = 0.5;
const WIDGET_SCALE_MAX = 2;
const WIDGET_ANCHOR_MAX = 32;
const WIDGET_POSITION_MARGIN_MAX = 512;
const WIDGET_SETTING_KEY_RE = /^[A-Za-z0-9][A-Za-z0-9_.-]{0,63}$/;
const WIDGET_SETTING_LABEL_MAX = 32;
const WIDGET_SETTING_OPTION_VALUE_MAX = 64;

/** 包内入口：相对路径 + `.html`，禁止绝对路径 / `..` / scheme / 反斜杠。 */
function isWidgetEntry(value: string): boolean {
  if (!isRelativePath(value)) return false;
  if (value.includes("\\") || value.includes("://") || /^[a-zA-Z][a-zA-Z0-9+.-]*:/.test(value)) {
    return false;
  }
  return /\.html$/i.test(value);
}

/** 包内图片资源（托盘/图标）：相对路径 + `.png`。 */
function isWidgetPng(value: string): boolean {
  if (!isRelativePath(value)) return false;
  if (value.includes("\\") || value.includes("://")) return false;
  return /\.png$/i.test(value);
}

/** 缩放档位：0.5–2、最多 2 位小数（浮点比较留 1e-9 余量）。 */
const WidgetScaleSchema = z
  .number(
    typeParams("缩放档位必须是数字", "缩放档位必须是数字"),
  )
  .min(WIDGET_SCALE_MIN, `缩放档位不能小于 ${WIDGET_SCALE_MIN}`)
  .max(WIDGET_SCALE_MAX, `缩放档位不能大于 ${WIDGET_SCALE_MAX}`)
  .refine(
    (value) => Math.abs(value * 100 - Math.round(value * 100)) < 1e-9,
    "缩放档位最多 2 位小数",
  );

const WidgetSettingsOptionSchema = z.object(
  {
    value: z
      .string(typeParams("缺少选项值", "选项值必须是文本"))
      .trim()
      .min(1, "选项值不能为空")
      .max(WIDGET_SETTING_OPTION_VALUE_MAX, `选项值最多 ${WIDGET_SETTING_OPTION_VALUE_MAX} 字`),
    label: z
      .string(typeParams("缺少选项名", "选项名必须是文本"))
      .trim()
      .min(1, "选项名不能为空")
      .max(WIDGET_SETTING_LABEL_MAX, `选项名最多 ${WIDGET_SETTING_LABEL_MAX} 字`),
  },
  typeParams("设置选项必须是 JSON 对象"),
);

/**
 * 通用表单字段（规格 §2.3 本轮支持的 5 种类型）。
 *
 * `select` 必须给 `options`，且 `default` 必须在选项里；其它类型给 `options` 视为写错
 * （不静默忽略——宿主表单不会用它，留着只会让清单作者以为生效了）。
 * 各类型的 `default` 形状也在这里钉死：坏默认值会让表单首帧显示错值。
 */
const WidgetSettingFieldSchema = z
  .object(
    {
      key: z
        .string(typeParams("缺少设置字段键", "设置字段键必须是文本"))
        .trim()
        .regex(WIDGET_SETTING_KEY_RE, "设置字段键只能由字母、数字和 . _ - 组成，且以字母或数字开头（≤64）"),
      label: z
        .string(typeParams("缺少设置字段名", "设置字段名必须是文本"))
        .trim()
        .min(1, "设置字段名不能为空")
        .max(WIDGET_SETTING_LABEL_MAX, `设置字段名最多 ${WIDGET_SETTING_LABEL_MAX} 字`),
      type: z.enum(["boolean", "select", "text", "number", "agent"], {
        error: "设置字段类型只能是 boolean / select / text / number / agent",
      }),
      default: z.unknown().optional(),
      options: z
        .array(WidgetSettingsOptionSchema, typeParams("设置选项列表必须是数组"))
        .max(MAX_WIDGET_SETTING_OPTIONS, `单个 select 字段最多 ${MAX_WIDGET_SETTING_OPTIONS} 个选项`)
        .optional(),
    },
    typeParams("设置字段必须是 JSON 对象"),
  )
  .superRefine((field, ctx) => {
    if (field.type === "select") {
      if (!field.options || field.options.length === 0) {
        ctx.addIssue({
          code: z.ZodIssueCode.custom,
          path: ["options"],
          message: "select 字段必须提供 options（至少 1 项）",
        });
        return;
      }
      if (field.default !== undefined && !field.options.some((option) => option.value === field.default)) {
        ctx.addIssue({
          code: z.ZodIssueCode.custom,
          path: ["default"],
          message: "select 字段的 default 必须是 options 里的某个 value",
        });
      }
    } else if (field.type === "boolean") {
      if (field.default !== undefined && typeof field.default !== "boolean") {
        ctx.addIssue({
          code: z.ZodIssueCode.custom,
          path: ["default"],
          message: "boolean 字段的 default 必须是布尔值",
        });
      }
      if (field.options !== undefined) {
        ctx.addIssue({
          code: z.ZodIssueCode.custom,
          path: ["options"],
          message: "只有 select 字段可以声明 options",
        });
      }
    } else if (field.type === "number") {
      if (
        field.default !== undefined &&
        (typeof field.default !== "number" || !Number.isFinite(field.default))
      ) {
        ctx.addIssue({
          code: z.ZodIssueCode.custom,
          path: ["default"],
          message: "number 字段的 default 必须是数字",
        });
      }
      if (field.options !== undefined) {
        ctx.addIssue({
          code: z.ZodIssueCode.custom,
          path: ["options"],
          message: "只有 select 字段可以声明 options",
        });
      }
    } else if (field.type === "text" || field.type === "agent") {
      // agent 的默认值是智能体 id（字符串）或空；text 同理。
      if (field.default !== undefined && field.default !== null && typeof field.default !== "string") {
        ctx.addIssue({
          code: z.ZodIssueCode.custom,
          path: ["default"],
          message: `${field.type} 字段的 default 必须是文本或 null`,
        });
      }
      if (field.options !== undefined) {
        ctx.addIssue({
          code: z.ZodIssueCode.custom,
          path: ["options"],
          message: "只有 select 字段可以声明 options",
        });
      }
    }
  });

const WidgetSettingsSchema = z
  .object(
    {
      title: z
        .string(typeParams("设置标题必须是文本"))
        .trim()
        .max(WIDGET_NAME_MAX, `设置标题最多 ${WIDGET_NAME_MAX} 字`)
        .optional(),
      fields: z
        .array(WidgetSettingFieldSchema, typeParams("设置字段列表必须是数组"))
        .max(MAX_WIDGET_SETTING_FIELDS, `单个小组件最多 ${MAX_WIDGET_SETTING_FIELDS} 个设置字段`),
    },
    typeParams("settings 必须是 JSON 对象"),
  )
  .superRefine((settings, ctx) => {
    const seen = new Set<string>();
    settings.fields.forEach((field, index) => {
      if (seen.has(field.key)) {
        ctx.addIssue({
          code: z.ZodIssueCode.custom,
          path: ["fields", index, "key"],
          message: `设置字段键重复：${field.key}`,
        });
      }
      seen.add(field.key);
    });
  });

const WidgetPositionSchema = z.object(
  {
    anchor: z
      .string(typeParams("缺少落位锚点", "落位锚点必须是文本"))
      .trim()
      .min(1, "落位锚点不能为空")
      .max(WIDGET_ANCHOR_MAX, `落位锚点最多 ${WIDGET_ANCHOR_MAX} 字`)
      .default("bottom-right"),
    margin: z
      .number(typeParams("落位间距必须是数字", "落位间距必须是数字"))
      .min(0, "落位间距不能为负")
      .max(WIDGET_POSITION_MARGIN_MAX, `落位间距不能大于 ${WIDGET_POSITION_MARGIN_MAX}`)
      .default(24),
    remember: z.boolean(typeParams("是否记住位置必须是布尔值")).default(true),
  },
  typeParams("position 必须是 JSON 对象"),
);

/** 托盘菜单项：宿主已实现的四种动作（规格 §2.3）。 */
const WidgetTrayItemSchema = z.enum(["toggle", "clickThrough", "resetPosition", "settings"], {
  error: '托盘菜单项只能是 "toggle" / "clickThrough" / "resetPosition" / "settings"',
});

const WidgetTraySchema = z.object(
  {
    icon: z
      .string(typeParams("缺少托盘图标", "托盘图标必须是文本"))
      .trim()
      .min(1, "托盘图标不能为空")
      .refine(isWidgetPng, "托盘图标必须是包内相对路径的 .png"),
    items: z
      .array(WidgetTrayItemSchema, typeParams("托盘菜单项必须是数组"))
      .max(8, "托盘菜单项最多 8 个")
      .default(["toggle", "settings"]),
  },
  typeParams("tray 必须是 JSON 对象"),
);

/**
 * 清单 `contributions.desktopWidgets[]` 的一项（界面插件的窗口规格）。
 *
 * 这里只做**形状**校验：窗口怎么建、透明/置顶/穿透怎么生效全在主进程；
 * 渲染层拿到的 `WidgetRecord.widget` 就是这份规格（见 `src/types/widgets.ts`）。
 */
export const DesktopWidgetSpecSchema = z
  .object(
    {
      id: z
        .string(typeParams("缺少小组件 id", "小组件 id 必须是文本"))
        .trim()
        .regex(WIDGET_ID_RE, "小组件 id 只能用小写字母、数字和连字符，且以字母或数字开头（≤32）"),
      name: z
        .string(typeParams("缺少小组件名", "小组件名必须是文本"))
        .trim()
        .min(1, "小组件名不能为空")
        .max(WIDGET_NAME_MAX, `小组件名最多 ${WIDGET_NAME_MAX} 字`),
      entry: z
        .string(typeParams("缺少入口", "入口必须是文本"))
        .trim()
        .min(1, "入口不能为空")
        .max(WIDGET_ENTRY_MAX, `入口路径最多 ${WIDGET_ENTRY_MAX} 字符`)
        .refine(
          isWidgetEntry,
          "入口必须是包内相对路径的 .html（不能以 / 或盘符开头，不能含 ..、反斜杠与 scheme）",
        ),
      width: z
        .number(typeParams("缺少窗口宽度", "窗口宽度必须是数字"))
        .int("窗口宽度必须是整数")
        .min(WIDGET_DIMENSION_MIN, `窗口宽度不能小于 ${WIDGET_DIMENSION_MIN}`)
        .max(WIDGET_DIMENSION_MAX, `窗口宽度不能大于 ${WIDGET_DIMENSION_MAX}`),
      height: z
        .number(typeParams("缺少窗口高度", "窗口高度必须是数字"))
        .int("窗口高度必须是整数")
        .min(WIDGET_DIMENSION_MIN, `窗口高度不能小于 ${WIDGET_DIMENSION_MIN}`)
        .max(WIDGET_DIMENSION_MAX, `窗口高度不能大于 ${WIDGET_DIMENSION_MAX}`),
      scales: z
        .array(WidgetScaleSchema, typeParams("缩放档位必须是数组"))
        .min(1, "缩放档位至少 1 档")
        .max(
          MAX_DESKTOP_WIDGET_SCALES,
          `缩放档位最多 ${MAX_DESKTOP_WIDGET_SCALES} 档`,
        )
        .refine(
          (scales) => scales.every((value, index) => index === 0 || value > scales[index - 1]),
          "缩放档位必须严格递增",
        ),
      defaultScale: WidgetScaleSchema.default(1),
      transparent: z.boolean(typeParams("transparent 必须是布尔值")).default(false),
      alwaysOnTop: z.boolean(typeParams("alwaysOnTop 必须是布尔值")).default(false),
      skipTaskbar: z.boolean(typeParams("skipTaskbar 必须是布尔值")).default(false),
      resizable: z.boolean(typeParams("resizable 必须是布尔值")).default(false),
      clickThrough: z
        .enum(["none", "auto"], { error: 'clickThrough 只能是 "none" / "auto"' })
        .default("none"),
      position: WidgetPositionSchema.default({ anchor: "bottom-right", margin: 24, remember: true }),
      icon: z
        .string(typeParams("图标必须是文本"))
        .trim()
        .min(1, "图标不能为空")
        .refine(isWidgetPng, "图标必须是包内相对路径的 .png")
        .optional(),
      tray: WidgetTraySchema.optional(),
      settings: WidgetSettingsSchema.optional(),
    },
    typeParams("desktopWidget 必须是 JSON 对象"),
  )
  .superRefine((widget, ctx) => {
    if (!widget.scales.includes(widget.defaultScale)) {
      ctx.addIssue({
        code: z.ZodIssueCode.custom,
        path: ["defaultScale"],
        message: "defaultScale 必须是 scales 里的一档",
      });
    }
  });

export type PluginWidgetSettingOption = z.infer<typeof WidgetSettingsOptionSchema>;
export type PluginWidgetSettingField = z.infer<typeof WidgetSettingFieldSchema>;
export type PluginWidgetSettings = z.infer<typeof WidgetSettingsSchema>;
export type PluginWidgetPosition = z.infer<typeof WidgetPositionSchema>;
export type PluginWidgetTrayItem = z.infer<typeof WidgetTrayItemSchema>;
export type PluginWidgetTray = z.infer<typeof WidgetTraySchema>;

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
    /**
     * 界面插件声明（d.98 / v4）。
     *
     * 用 `optional` 而不是 `.default([])`：v3 清单里**写没写这个字段**本身要能被识别
     * （带新字段的 v3 必须明确拒绝，而不是被默认值抹平后静默通过）。
     * 归一化时统一成数组（见 `PluginContributions`）。
     */
    desktopWidgets: z
      .array(DesktopWidgetSpecSchema, typeParams("桌面小组件列表必须是数组"))
      .max(MAX_PLUGIN_DESKTOP_WIDGETS, `本轮最多 ${MAX_PLUGIN_DESKTOP_WIDGETS} 个桌面小组件`)
      .optional(),
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
      /**
       * d.98 新增（v4）：分发形态。
       *
       * `bundle` = 界面插件（带 files/** 可执行内容，走主进程安装）；
       * `manifest` = 纯声明式包（既有全部插件；缺省值，v3 等价）。
       * 同样用 `optional`：v3 写了这个字段要报错，而不是被默认值吞掉。
       */
      distribution: z
        .enum(["bundle", "manifest"], { error: 'distribution 只能是 "bundle" / "manifest"' })
        .optional(),
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
    const isV4 = manifest.schemaVersion === 4;
    const skills = legacy ? (manifest.skills ?? []) : (manifest.contributions?.skills ?? []);
    const servers = legacy ? (manifest.mcpServers ?? []) : (manifest.contributions?.mcpServers ?? []);
    const commands = legacy ? [] : (manifest.contributions?.commands ?? []);
    const toolPacks = legacy ? [] : (manifest.contributions?.toolPacks ?? []);
    const desktopWidgets = legacy ? [] : (manifest.contributions?.desktopWidgets ?? []);
    const distribution = manifest.distribution ?? "manifest";

    /**
     * v4 新增字段只属于 v4（d.88 的教训：zod 会静默 strip 未知字段，装完半可用）。
     * v3 里写这些字段一律拒绝并给字段路径；v1/v2 的 contributions/permissions 已整块拒绝，
     * 这里只补字段级提示，避免报错里出现一堆重复项。
     */
    if (manifest.schemaVersion === 3) {
      if (manifest.distribution !== undefined) {
        ctx.addIssue({
          code: z.ZodIssueCode.custom,
          path: ["distribution"],
          message: "schemaVersion 3 不支持 distribution（界面插件分发形态），请升级到 schemaVersion 4",
        });
      }
      if (manifest.contributions?.desktopWidgets !== undefined) {
        ctx.addIssue({
          code: z.ZodIssueCode.custom,
          path: ["contributions", "desktopWidgets"],
          message:
            "schemaVersion 3 不支持 contributions.desktopWidgets（界面插件），请升级到 schemaVersion 4",
        });
      }
      (["events", "graphics", "eval"] as const).forEach((key) => {
        if (manifest.permissions?.[key] !== undefined) {
          ctx.addIssue({
            code: z.ZodIssueCode.custom,
            path: ["permissions", key],
            message: `schemaVersion 3 不支持 permissions.${key}（界面插件权限），请升级到 schemaVersion 4`,
          });
        }
      });
    }

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

    if (!legacy) {
      if (!manifest.contributions) {
        ctx.addIssue({
          code: z.ZodIssueCode.custom,
          path: ["contributions"],
          message: `schemaVersion ${manifest.schemaVersion} 必须声明 contributions（技能 / MCP 服务 / 命令 / 工具束${isV4 ? " / 桌面小组件" : ""}至少一类）`,
        });
      } else if (
        skills.length + servers.length + commands.length + toolPacks.length + desktopWidgets.length ===
        0
      ) {
        ctx.addIssue({
          code: z.ZodIssueCode.custom,
          path: ["contributions"],
          message: isV4
            ? "插件至少要包含 1 项能力（技能 / MCP 服务 / 命令 / 工具束 / 桌面小组件）"
            : "插件至少要包含 1 项能力（技能 / MCP 服务 / 命令 / 工具束）",
        });
      }
    } else if (skills.length + servers.length === 0) {
      ctx.addIssue({
        code: z.ZodIssueCode.custom,
        path: ["skills"],
        message: "插件至少要包含 1 项能力（技能或 MCP 服务）",
      });
    }

    /**
     * v4：bundle 包只允许「界面插件」这一种可执行形态（规格 §2.2 新增拒绝规则）。
     *
     * 拒绝理由不是洁癖：技能/MCP/工具束都会在本机物化成可被模型调用的能力，
     * 而 bundle 的代码运行在独立 origin 的 widget 窗口里——两种权限模型混在一个包里，
     * 用户点一次「安装」等于同时确认两套信任，没法说清边界。
     */
    if (isV4) {
      if (distribution === "bundle") {
        const forbidden: Array<[string, number, string]> = [
          ["skills", skills.length, "技能"],
          ["mcpServers", servers.length, "MCP 服务"],
          ["toolPacks", toolPacks.length, "工具束"],
        ];
        for (const [key, count, label] of forbidden) {
          if (count === 0) continue;
          ctx.addIssue({
            code: z.ZodIssueCode.custom,
            path: ["contributions", key],
            message: `界面插件（distribution: "bundle"）只允许贡献 commands 与 desktopWidgets，不能声明${label}`,
          });
        }
      } else if (desktopWidgets.length > 0) {
        ctx.addIssue({
          code: z.ZodIssueCode.custom,
          path: ["contributions", "desktopWidgets"],
          message: '声明 contributions.desktopWidgets 时必须 distribution: "bundle"（界面插件需要随包文件）',
        });
      }
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
      // d.108：settings / unit 是 v5 新增目标。旧版清单按既有口径明确拒绝
      // （与「v3 拒绝 v4 新增字段」一致：不静默接受新字段，也不静默降级）。
      if (
        manifest.schemaVersion < 5 &&
        (command.target.kind === "settings" || command.target.kind === "unit")
      ) {
        ctx.addIssue({
          code: z.ZodIssueCode.custom,
          path: ["contributions", "commands", index, "target", "kind"],
          message: `schemaVersion ${manifest.schemaVersion} 不支持 ${command.target.kind} 目标，请升级到 schemaVersion 5`,
        });
        return;
      }
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
export type PluginSchemaVersion = (typeof PLUGIN_SCHEMA_VERSIONS)[number];
export type PluginToolRisk = "none" | "read" | "write";

/**
 * v5 的宿主兼容声明（`engines.heming`，必填）：最小应用版本，只做 `>=` 语义。
 *
 * 比较实现是 `@heming/shared` 的 `satisfiesEngines`（5 段 `d.特性.破坏性.修订.构建`，
 * 不能用 semver）；web 侧只负责把「声明」翻译成「能不能装」。
 */
export interface PluginEngines {
  heming: string;
}

/** v5 上架元数据的轻字段（规格 §4.2；`meta.icon` 建议用 https URL，data URI 占本机配额）。 */
export interface PluginMeta {
  icon?: string;
  homepage?: string;
  repository?: string;
  license?: string;
  category?: string;
  tags?: string[];
  keywords?: string[];
  screenshots?: string[];
  detail?: string;
}

/** 归一化后的权限声明（v1/v2 也会补全，UI 不用判空）。 */
export interface PluginPermissions {
  /** 网络主机白名单（host 或 host:port）。 */
  network: string[];
  /** 本插件 MCP 工具的风险上限（只能收紧，不放宽 HITL）。 */
  tools: PluginToolRisk;
  /** 预留文件根（本轮只校验与展示，不执行）。 */
  files: string[];
  /** d.98（v4）：界面插件可接收的事件类别；未声明为空数组（不接收任何事件）。 */
  events: PluginWidgetEvent[];
  /** d.98（v4）：渲染能力声明（webgl / wasm）；决定 widget 的 CSP。 */
  graphics: PluginGraphicsCapability[];
  /** d.98（v4）：是否允许 `unsafe-eval`（只对第一方 widget 放开）。 */
  eval: boolean;
}

/** 界面插件可接收的事件类别（当前只有通知中心转发）。 */
export type PluginWidgetEvent = "notify";
/** widget 渲染能力声明。 */
export type PluginGraphicsCapability = "webgl" | "wasm";

/**
 * 五类贡献面：技能 / 远程 MCP 服务 / 命令 / 工具束 / 桌面小组件。
 *
 * `toolPacks` 是 d.65 的**向后兼容增补**（schemaVersion 仍为 3）：老清单没有该字段
 * 照样合法；它只声明「哪些工具属于同一组」，不定义工具、不改变开关与 HITL。
 *
 * `desktopWidgets` 是 d.98（schemaVersion 4）的第五类贡献面：**界面插件**。
 * web 侧只做清单校验与展示，安装/窗口/代码执行全部在主进程（见 `src/types/widgets.ts`）。
 */
export interface PluginContributions {
  skills: PluginSkillSpec[];
  mcpServers: PluginMcpServerSpec[];
  commands: PluginCommandSpec[];
  toolPacks: PluginToolPackSpec[];
  /** d.98（v4）：界面插件声明；v3 及更旧清单恒为空数组。 */
  desktopWidgets: PluginDesktopWidgetSpec[];
  /**
   * 已废弃（d.90）：模型不再由插件声明，统一由 magpie 网关提供。
   * 字段恒为空数组，仅用于兼容既有消费方（统计/展示）；清单里不再接受该字段。
   */
  llmPresets: [];
}

/** 归一化后的 `desktopWidget` 规格（类型来源是 zod schema，避免两处手写漂移）。 */
export type PluginDesktopWidgetSpec = z.infer<typeof DesktopWidgetSpecSchema>;

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
 * ★ `schemaVersion` 保留原始版本号（1/2/3/4/5）：安装弹窗要据此提示「旧版清单（v2）」；
 * 但 `distribution` / `contributions` / `permissions` 一定存在且为当前形状。
 * `engines` / `meta` 只在 v5 清单上出现（可选字段；旧包没有「兼容性声明」这回事）。
 */
export interface PluginManifest {
  schemaVersion: PluginSchemaVersion;
  id: string;
  name: string;
  version: string;
  description: string;
  author: string;
  /** d.98：分发形态。`bundle` = 界面插件（带可执行内容，由主进程安装）；缺省 `manifest`。 */
  distribution: PluginDistribution;
  contributions: PluginContributions;
  permissions: PluginPermissions;
  /** v5：最小宿主版本（v1–v4 没有该字段；`pluginEnginesStatus` 对旧包按「不限制」处理）。 */
  engines?: PluginEngines;
  /** v5：上架元数据（市场页用；安装记录只留轻字段，见规格 §4.4）。 */
  meta?: PluginMeta;
  /** 可选：发布者与签名（d.67；旧 v3 清单没有这两个字段）。 */
  publisher?: PluginPublisher;
  signature?: PluginSignature;
}

/** 分发形态（规格 §2.2）：纯声明式清单 / 带文件的界面插件包。 */
export type PluginDistribution = "manifest" | "bundle";

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

function uniq<T extends string>(items: T[]): T[] {
  return [...new Set(items.filter(Boolean))];
}

/** 旧版清单的权限兜底：网络 = 其服务 host 全集、工具上限 read（等于既有事实）。 */
function legacyPermissions(servers: PluginMcpServerSpec[]): PluginPermissions {
  return {
    network: uniq(servers.map((server) => hostOfUrl(server.url)).filter(Boolean)),
    tools: "read",
    files: [],
    // 旧包没有界面插件权限概念：不接收事件、不声明渲染能力、不允许 eval。
    events: [],
    graphics: [],
    eval: false,
  };
}

/**
 * 深拷贝小组件规格（含 scales / position / tray.items / settings.fields.options）。
 *
 * 解析结果是「唯一对外形态」，调用方（安装弹窗/详情/列表）只读；
 * 但仍做一次深拷贝：这些对象会进本机存储与 IPC，浅拷贝留下的共享引用
 * 会让「改了展示对象就改了记录」这类问题很难查。
 */
function copyWidgetSpec(spec: PluginDesktopWidgetSpec): PluginDesktopWidgetSpec {
  return {
    ...spec,
    scales: [...spec.scales],
    position: { ...spec.position },
    ...(spec.tray ? { tray: { ...spec.tray, items: [...spec.tray.items] } } : {}),
    ...(spec.settings
      ? {
          settings: {
            ...spec.settings,
            fields: spec.settings.fields.map((field) => ({
              ...field,
              ...(field.options ? { options: field.options.map((option) => ({ ...option })) } : {}),
            })),
          },
        }
      : {}),
  };
}

/* ══════════════════ v5：委托 shared 解析器 + web 独有校验 ══════════════════ */

/** `meta` 深拷贝：数组会进安装记录与市场缓存，浅拷贝会留下共享引用。 */
function copyMeta(meta: PluginMetaV5): PluginMeta {
  const out: PluginMeta = {};
  if (meta.icon !== undefined) out.icon = meta.icon;
  if (meta.homepage !== undefined) out.homepage = meta.homepage;
  if (meta.repository !== undefined) out.repository = meta.repository;
  if (meta.license !== undefined) out.license = meta.license;
  if (meta.category !== undefined) out.category = meta.category;
  if (meta.tags) out.tags = [...meta.tags];
  if (meta.keywords) out.keywords = [...meta.keywords];
  if (meta.screenshots) out.screenshots = [...meta.screenshots];
  if (meta.detail !== undefined) out.detail = meta.detail;
  return out;
}

/**
 * v5 → web 内部 `PluginManifest`。
 *
 * `distribution / contributions / permissions` 一律用 shared 的归一化结果（缺省值已补全），
 * 这里只做两件 web 侧的事：① 命令 `target.page` 必须在 `PALETTE_PAGES` 里；
 * ② 把结果投射成既有内部类型（数组深拷贝，避免调用方改到解析缓存）。
 *
 * ★ `desktopWidgets` 是唯一的形状差异：shared 的 v5 schema 里 `scales/defaultScale/position`
 * 是可选（界面插件的权威校验在主进程 `plugin-package.js`），web 内部类型是补全后的形状。
 * web 的声明式安装管线本来就会拒绝 bundle（`assertDeclarativeManifest`），所以这里只做投射。
 */
function fromV5(parsed: PluginV5ParseResult): PluginManifest {
  const v5 = parsed.manifest;
  v5.contributions.commands.forEach((command, index) => {
    if (command.target.kind === "page" && !PAGE_IDS.has(command.target.page)) {
      throw new PluginManifestError(
        `contributions.commands[${index}].target.page：未知页面：${command.target.page}`,
      );
    }
    // d.108：shared 只认形状；设置卡目录在 web，必须在这里补存在性校验。
    if (command.target.kind === "settings" && !settingsCardById(command.target.card)) {
      throw new PluginManifestError(
        `contributions.commands[${index}].target.card：未知设置卡：${command.target.card}`,
      );
    }
  });
  return {
    schemaVersion: 5,
    id: v5.id,
    name: v5.name,
    version: v5.version,
    description: v5.description,
    author: v5.author,
    distribution: v5.distribution,
    contributions: {
      skills: v5.contributions.skills.map((skill) => ({
        ...skill,
        triggers: [...skill.triggers],
        tags: [...skill.tags],
      })),
      mcpServers: v5.contributions.mcpServers.map((server) => ({ ...server })),
      commands: v5.contributions.commands.map((command) => ({
        ...command,
        keywords: [...command.keywords],
        target: { ...command.target },
      })),
      toolPacks: v5.contributions.toolPacks.map((pack) => ({ ...pack, tools: [...pack.tools] })),
      desktopWidgets: v5.contributions.desktopWidgets as unknown as PluginDesktopWidgetSpec[],
      llmPresets: [],
    },
    permissions: {
      // v5 的 `PluginPermissionsV5` 是 zod 推断类型（字段可选）；`parsePluginManifestV5`
      // 归一化时已补全缺省值，这里的 `??` 只是让类型与运行时口径一致。
      network: [...(v5.permissions.network ?? [])],
      tools: v5.permissions.tools ?? "read",
      files: [...(v5.permissions.files ?? [])],
      events: [...((v5.permissions.events ?? []) as PluginWidgetEvent[])],
      graphics: [...((v5.permissions.graphics ?? []) as PluginGraphicsCapability[])],
      eval: v5.permissions.eval ?? false,
    },
    engines: { heming: v5.engines.heming },
    meta: copyMeta(v5.meta),
    ...(v5.publisher ? { publisher: { ...v5.publisher } } : {}),
    ...(v5.signature ? { signature: { ...v5.signature } } : {}),
  };
}

/** 解析 JSON 文本；空/坏 JSON 的文案与历史逐字一致（安装弹窗依赖它们）。 */
function parseJsonInput(input: string): unknown {
  if (!input.trim()) throw new PluginManifestError("插件清单为空，请粘贴 plugin.json 内容");
  try {
    return JSON.parse(input);
  } catch {
    throw new PluginManifestError("不是有效的 JSON，请检查逗号、引号与括号是否配对");
  }
}

/**
 * 解析插件清单并带上非阻断 warning（v5 的未知顶层字段等）。
 *
 * 为什么单独给一个入口：`parsePluginManifest` 的返回类型是既有的 `PluginManifest`，
 * 加个 `warnings` 字段会污染所有消费方；安装预览/lint 需要把「忽略了未知字段 x」
 * 展示出来，所以由这个函数负责。
 */
export function parsePluginManifestDetailed(input: string | unknown): {
  manifest: PluginManifest;
  warnings: string[];
} {
  let raw: unknown = input;
  if (typeof input === "string") raw = parseJsonInput(input);

  if (raw && typeof raw === "object" && !Array.isArray(raw)) {
    const record = raw as Record<string, unknown>;
    // v5 走 shared 的唯一权威解析器（strict 规则、engines 归一化、bundle 限制都在那里）。
    if (record.schemaVersion === 5) {
      let parsed: PluginV5ParseResult;
      try {
        parsed = parsePluginManifestV5(raw);
      } catch (err) {
        // shared 的错误类型与文案已经是中文 + 字段路径，换成 web 的既有错误类即可。
        if (err instanceof PluginManifestInvalidError) throw new PluginManifestError(err.message);
        throw err;
      }
      return { manifest: fromV5(parsed), warnings: parsed.warnings };
    }
    // v3 迁移提示必须在 zod 之前判：未知字段会被丢弃，schema 里看不到它们。
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
    // d.98：界面插件声明（v3 及更旧恒为空数组）；深拷贝避免调用方改到解析缓存。
    desktopWidgets: legacy ? [] : (manifest.contributions?.desktopWidgets ?? []).map(copyWidgetSpec),
    // 插件不再能声明模型预设（d.90：模型统一由 magpie 网关提供）；字段保留为空数组以兼容既有消费方。
    llmPresets: [],
  };
  const permissions: PluginPermissions = legacy
    ? legacyPermissions(contributions.mcpServers)
    : {
        network: uniq((manifest.permissions?.network ?? []).map((host) => host.toLowerCase())),
        tools: manifest.permissions?.tools ?? "read",
        files: uniq(manifest.permissions?.files ?? []),
        events: uniq(manifest.permissions?.events ?? []),
        graphics: uniq(manifest.permissions?.graphics ?? []),
        eval: manifest.permissions?.eval === true,
      };
  return {
    manifest: {
      schemaVersion: manifest.schemaVersion,
      id: manifest.id,
      name: manifest.name,
      version: manifest.version,
      description: manifest.description,
      author: manifest.author,
      distribution: manifest.distribution ?? "manifest",
      contributions,
      permissions,
      // 旧版清单不允许带签名（superRefine 已拒绝），这里只透传 v3 的可选字段。
      ...(manifest.publisher ? { publisher: { ...manifest.publisher } } : {}),
      ...(manifest.signature ? { signature: { ...manifest.signature } } : {}),
    },
    warnings: [],
  };
}

/**
 * 解析插件清单。接受 JSON 文本或已解析对象；失败抛 `PluginManifestError`。
 *
 * v1–v4 的未知字段由 zod 丢弃（历史包袱，旧包有 `llmPresets` 这类遗留字段，strict 会误杀）；
 * v5 的未知字段策略在 shared 里分层处理（顶层警告、敏感子对象报错）。
 */
export function parsePluginManifest(input: string | unknown): PluginManifest {
  return parsePluginManifestDetailed(input).manifest;
}

/* ══════════════════ 兼容性判定（engines.heming） ══════════════════ */

/**
 * 当前应用版本（构建期注入的 5 段版本号，见 `vite-env.d.ts`）。
 *
 * 测试/非 vite 环境读不到时返回空串：`enginesStatus` 对空宿主版本会判 `needsNewerApp`，
 * 失败关闭比「假装兼容」安全；调用方也可以显式传版本覆盖。
 */
export function currentAppVersion(): string {
  try {
    return typeof __APP_VERSION__ === "string" ? __APP_VERSION__.trim() : "";
  } catch {
    return "";
  }
}

/**
 * 插件是否兼容当前应用（安装预览/市场/详情页共用口径）。
 *
 * - v1–v4：没有 `engines` 字段 ⇒ `compatible`（旧包按「不限制宿主版本」处理，规格 §4.5）；
 * - v5：`engines.heming` 是必填，缺失按 `invalidEngines`（失败关闭，不静默放行）。
 *
 * @param appVersion 当前应用版本；默认 `__APP_VERSION__`，测试可注入。
 */
export function pluginEnginesStatus(
  manifest: Pick<PluginManifest, "schemaVersion"> & { engines?: PluginEngines },
  appVersion: string = currentAppVersion(),
): EnginesStatus {
  const required = manifest.engines?.heming;
  if (manifest.schemaVersion === 5 && !required) return { status: "invalidEngines", required: "" };
  return enginesStatus(required, appVersion);
}

/**
 * 把 web 归一化清单投射成 shared 的 v5 读模型（单元投影/诊断/市场共用）。
 *
 * v1–v4 用 `toV5View`（`engines = d.0`、`meta = {}`）；v5 保留自身 `engines/meta`——
 * 否则「兼容性判定」会把一个新包当成「不限制」。
 */
export function toPluginV5View(manifest: PluginManifest): PluginManifestV5 {
  const view = toV5View(manifest as unknown as LegacyNormalizedPlugin);
  if (manifest.schemaVersion !== 5) return view;
  return {
    ...view,
    engines: { heming: manifest.engines?.heming ?? LEGACY_ENGINES },
    meta: { ...(manifest.meta ?? {}) },
  };
}
