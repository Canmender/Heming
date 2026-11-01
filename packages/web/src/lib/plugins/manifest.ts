import { z } from "zod";

/**
 * 插件清单（`plugin.json`）的唯一解析入口。
 *
 * 插件是纯声明式系统能力包：承载技能与**远程 MCP 服务**（仅 HTTP）。
 * 清单在进入存储前必须完整校验，解析失败一律给出中文错误并指出字段路径——
 * 不做「尽量猜」的容错，否则坏包会在安装后以半可用状态存在，比直接拒绝更难排查。
 *
 * 为什么 v2 仍拒绝 stdio/命令：那会在用户机器上拉起进程，等于安装即执行
 * 第三方代码；本地进程类集成仍走接口区手动配置或 Registry 安装。
 */

export const PLUGIN_SCHEMA_VERSION = 2;
export const PLUGIN_SCHEMA_VERSIONS = [1, 2] as const;
export const MAX_PLUGIN_SKILLS = 50;
export const MAX_PLUGIN_MCP_SERVERS = 10;

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

/** 手写清单里的空字符串条目直接丢弃；非字符串保留，交给内层报类型错误。 */
function dropBlankEntries<T extends z.ZodTypeAny>(schema: T) {
  return z.preprocess((value) => {
    if (!Array.isArray(value)) return value;
    return value.filter((item) => !(typeof item === "string" && !item.trim()));
  }, schema);
}

const SkillSpecSchema = z.object(
  {
    name: z
      .string({ required_error: "缺少技能名", invalid_type_error: "技能名必须是文本" })
      .trim()
      .min(1, "技能名不能为空")
      .max(SKILL_NAME_MAX, `技能名最多 ${SKILL_NAME_MAX} 字`),
    description: z
      .string({ invalid_type_error: "技能描述必须是文本" })
      .trim()
      .max(SKILL_DESCRIPTION_MAX, `技能描述最多 ${SKILL_DESCRIPTION_MAX} 字`)
      .default(""),
    instructions: z
      .string({ required_error: "缺少技能指令", invalid_type_error: "技能指令必须是文本" })
      .trim()
      .min(1, "技能指令不能为空")
      .max(SKILL_INSTRUCTIONS_MAX, `技能指令最多 ${SKILL_INSTRUCTIONS_MAX} 字`),
    triggers: dropBlankEntries(
      z
        .array(
          z
            .string({ invalid_type_error: "触发词必须是文本" })
            .trim()
            .min(1, "触发词不能为空")
            .max(SKILL_TRIGGER_MAX, `单个触发词最多 ${SKILL_TRIGGER_MAX} 字`),
          { invalid_type_error: "触发词必须是数组" },
        )
        .max(SKILL_TRIGGERS_MAX, `触发词最多 ${SKILL_TRIGGERS_MAX} 个`)
        .default([]),
    ),
    tags: dropBlankEntries(
      z
        .array(
          z
            .string({ invalid_type_error: "标签必须是文本" })
            .trim()
            .min(1, "标签不能为空")
            .max(SKILL_TAG_MAX, `单个标签最多 ${SKILL_TAG_MAX} 字`),
          { invalid_type_error: "标签必须是数组" },
        )
        .max(SKILL_TAGS_MAX, `标签最多 ${SKILL_TAGS_MAX} 个`)
        .default([]),
    ),
  },
  { invalid_type_error: "技能必须是 JSON 对象" },
);

const McpServerSpecSchema = z
  .object(
    {
      key: z
        .string({ required_error: "缺少服务 key", invalid_type_error: "服务 key 必须是文本" })
        .trim()
        .regex(
          /^[a-z0-9][a-z0-9-]{0,31}$/,
          "服务 key 只能用小写字母、数字和连字符，且以字母或数字开头（≤32）",
        ),
      name: z
        .string({ required_error: "缺少服务名", invalid_type_error: "服务名必须是文本" })
        .trim()
        .min(1, "服务名不能为空")
        .max(MCP_SERVER_NAME_MAX, `服务名最多 ${MCP_SERVER_NAME_MAX} 字`),
      url: z
        .string({ required_error: "缺少服务地址", invalid_type_error: "服务地址必须是文本" })
        .trim()
        .min(1, "服务地址不能为空")
        .max(MCP_SERVER_URL_MAX, `服务地址最多 ${MCP_SERVER_URL_MAX} 字符`),
      description: z
        .string({ invalid_type_error: "服务描述必须是文本" })
        .trim()
        .max(MCP_SERVER_DESCRIPTION_MAX, `服务描述最多 ${MCP_SERVER_DESCRIPTION_MAX} 字`)
        .default(""),
    },
    { invalid_type_error: "MCP 服务必须是 JSON 对象" },
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

const PluginManifestSchema = z
  .object(
    {
      schemaVersion: z.union([z.literal(1), z.literal(2)], {
        errorMap: () => ({ message: `仅支持 schemaVersion: ${PLUGIN_SCHEMA_VERSIONS.join(" 或 ")}` }),
      }),
      id: z
        .string({ required_error: "缺少插件 id", invalid_type_error: "插件 id 必须是文本" })
        .trim()
        .regex(
          /^[a-z0-9][a-z0-9._-]{0,63}$/,
          "插件 id 只能用小写字母、数字、点、下划线和连字符，且以字母或数字开头（≤64）",
        ),
      name: z
        .string({ required_error: "缺少插件名", invalid_type_error: "插件名必须是文本" })
        .trim()
        .min(1, "插件名不能为空")
        .max(64, "插件名最多 64 字"),
      version: z
        .string({ required_error: "缺少版本号", invalid_type_error: "版本号必须是文本" })
        .trim()
        .min(1, "版本号不能为空")
        .max(32, "版本号最多 32 字"),
      description: z
        .string({ invalid_type_error: "插件描述必须是文本" })
        .trim()
        .max(200, "插件描述最多 200 字")
        .default(""),
      author: z
        .string({ invalid_type_error: "作者名必须是文本" })
        .trim()
        .max(64, "作者名最多 64 字")
        .default(""),
      skills: z
        .array(SkillSpecSchema, { invalid_type_error: "技能列表必须是数组" })
        .max(MAX_PLUGIN_SKILLS, `单个插件最多 ${MAX_PLUGIN_SKILLS} 个技能`)
        .default([]),
      mcpServers: z
        .array(McpServerSpecSchema, { invalid_type_error: "MCP 服务列表必须是数组" })
        .max(MAX_PLUGIN_MCP_SERVERS, `单个插件最多 ${MAX_PLUGIN_MCP_SERVERS} 台 MCP 服务`)
        .default([]),
    },
    { invalid_type_error: "插件清单必须是 JSON 对象" },
  )
  .superRefine((manifest, ctx) => {
    if (manifest.schemaVersion === 1) {
      if (manifest.skills.length === 0) {
        ctx.addIssue({
          code: z.ZodIssueCode.custom,
          path: ["skills"],
          message: "插件至少要包含 1 个技能",
        });
      }
      if (manifest.mcpServers.length > 0) {
        ctx.addIssue({
          code: z.ZodIssueCode.custom,
          path: ["mcpServers"],
          message: "schemaVersion 1 不支持 MCP 服务，请升级到 schemaVersion 2",
        });
      }
    }
    if (manifest.skills.length + manifest.mcpServers.length === 0) {
      ctx.addIssue({
        code: z.ZodIssueCode.custom,
        path: ["skills"],
        message: "插件至少要包含 1 项能力（技能或 MCP 服务）",
      });
    }

    const seenSkills = new Set<string>();
    manifest.skills.forEach((skill, index) => {
      if (seenSkills.has(skill.name)) {
        ctx.addIssue({
          code: z.ZodIssueCode.custom,
          path: ["skills", index, "name"],
          message: `技能名重复：${skill.name}`,
        });
      }
      seenSkills.add(skill.name);
    });

    const seenServers = new Set<string>();
    manifest.mcpServers.forEach((server, index) => {
      if (seenServers.has(server.key)) {
        ctx.addIssue({
          code: z.ZodIssueCode.custom,
          path: ["mcpServers", index, "key"],
          message: `服务 key 重复：${server.key}`,
        });
      }
      seenServers.add(server.key);
    });
  });

export type PluginSkillSpec = z.infer<typeof SkillSpecSchema>;
export type PluginMcpServerSpec = z.infer<typeof McpServerSpecSchema>;
export type PluginManifest = z.infer<typeof PluginManifestSchema>;

/** 清单错误：`message` 已是可直接展示的中文。 */
export class PluginManifestError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "PluginManifestError";
  }
}

function pathLabel(path: (string | number)[]): string {
  let out = "";
  for (const part of path) {
    if (typeof part === "number") out += `[${part}]`;
    else out += out ? `.${part}` : part;
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
  const parsed = PluginManifestSchema.safeParse(raw);
  if (!parsed.success) throw new PluginManifestError(formatIssues(parsed.error));
  const manifest = parsed.data;
  return {
    ...manifest,
    skills: manifest.skills.map((skill) => ({
      ...skill,
      triggers: uniq(skill.triggers),
      tags: uniq(skill.tags),
    })),
  };
}
