/**
 * MCP 的 `prompts` 与 `resources`：把工作区里那几份「规矩与模板」交给别的编辑器（d.325）。
 *
 * ## 为什么要有这一层
 *
 * d.289 起 `heming mcp serve` 只暴露**工具**（读文件、写文件、跑命令）。但一个工作区里真正
 * 决定「和鸣会怎么干活」的东西不是工具，是这几份文本：
 *
 * - `.heming/commands/*.md`：用户写好的固定指令（d.240 桌面端 `/名字` 调的就是它们）；
 * - `AGENTS.md` / `HEMING.md` / `.heming/AGENTS.md` / `.heming/rules.md`：仓库约定（d.174/d.310）；
 * - `.heming/permissions.json` / `hooks.json` / `mcp.json`：这个工作区的权限、检查与外部服务配置。
 *
 * 之前这些对 MCP 客户端是不可见的：Cursor / Claude Code 里既调不到 `/review`，也看不到
 * 「这个仓库改完要跑 pnpm test」。把它们按 MCP 的 `prompts`（可被用户直接选用的指令模板）
 * 和 `resources`（可被引用/读入上下文的文档）暴露出去，编辑器那边才算真的接上了这个仓库。
 *
 * ## 两条安全边界
 *
 * 1. **只读固定名单**：`resources/list` 的内容由这里写死（命令目录 + 约定文件 + 三份配置），
 *    不按客户端给的路径去读盘；`resources/read` 先按 URI 在这份名单里查，查不到就报错。
 *    因此 URI 里的 `../` 之类根本没有机会变成一次路径穿越。
 * 2. **单份有上限**：超过 `MCP_CATALOG_MAX_FILE_CHARS` 的截断，并在正文末尾写明「要用全的
 *    请用 file_read 读哪一份」——比悄悄少给一半内容诚实。
 *
 * 读不到（没这份文件、没权限、不是文本）就当这个工作区没有它，不阻断也不报错。
 *
 * d.342 起再加一类 `resources/templates/list`：上面那些是**固定名单**，模板则是
 * `heming://workspace/{path}` —— 客户端把 `path` 换成本工作区的相对路径就能读任意文本文件。
 * 它比固定名单多一层盘上判定：路径必须在工作区内（正斜杠相对路径、不能有 `..`）、
 * 必须是普通文本文件、超长同样截断。模板只是「可读」，不参与订阅推送。
 */

import {
  CUSTOM_COMMANDS_DIR,
  parseCustomCommands,
  type CustomCommandSource,
} from "../../../packages/web/src/lib/agentRuntime/customCommands.js";
import { PROJECT_RULE_FILES } from "../../../packages/web/src/lib/agentRuntime/projectRules.js";
import type { FileFsBridge, FileReadResponse } from "../../../packages/web/src/lib/fileEdit/bridge.js";
import { createNodeFsBridge } from "../../../evals/runner/fsBridge.js";
import { cliProjectRuleRoots } from "./projectRules.js";
import path from "node:path";

/** 资源 URI 的前缀：`heming://workspace/<相对路径>`。 */
export const MCP_RESOURCE_PREFIX = "heming://workspace/";

/** 单份文件给客户端的上限（字符）。超过就截断并在末尾说明。 */
export const MCP_CATALOG_MAX_FILE_CHARS = 60_000;

/** 资源总量上限（命令 + 约定 + 配置）。命令目录本身最多 20 条，这里留足余量。 */
export const MCP_CATALOG_MAX_RESOURCES = 40;

/** 资源模板的 URI：{path} 由客户端替换成工作区内的相对路径。 */
export const MCP_RESOURCE_TEMPLATE_URI = "heming://workspace/{path}";

/** 除了约定文件之外，工作区里值得给客户端看的配置。 */
export const MCP_CONFIG_FILES = [
  ".heming/permissions.json",
  ".heming/hooks.json",
  ".heming/mcp.json",
] as const;

/** 一条提示词（对应 MCP 的 `Prompt`，外加正文）。 */
export interface McpPromptEntry {
  /** 提示词名（就是命令名，例如 `review`）。 */
  name: string;
  title?: string;
  description?: string;
  /** 发给模型的那段话。 */
  text: string;
  /** 来源文件（相对工作区）。 */
  source: string;
}

/** 一份资源（对应 MCP 的 `Resource`，外加正文）。 */
export interface McpResourceEntry {
  uri: string;
  /** 展示名（就是文件名）。 */
  name: string;
  title?: string;
  description?: string;
  mimeType: string;
  /** 文件全文（超长已截断并注明）。 */
  text: string;
  /** 相对工作区的路径，便于客户端再交给 `file_read`。 */
  rel: string;
}

export interface McpCatalog {
  prompts: McpPromptEntry[];
  resources: McpResourceEntry[];
}

/** 空目录（没有命令、没有约定、没有配置）。 */
export const EMPTY_CATALOG: McpCatalog = Object.freeze({
  prompts: Object.freeze([]) as unknown as McpPromptEntry[],
  resources: Object.freeze([]) as unknown as McpResourceEntry[],
}) as McpCatalog;

/** 相对路径 → 资源 URI（统一正斜杠，去掉开头的 `./` 或 `.\`）。 */
export function resourceUriOf(rel: string): string {
  const clean = rel.replace(/\\/g, "/").replace(/^\.[\\/]/, "");
  return `${MCP_RESOURCE_PREFIX}${clean}`;
}

/** 资源 URI → 相对路径；不是我们的命名空间就返回 null。 */
export function relOfResourceUri(uri: string): string | null {
  if (typeof uri !== "string") return null;
  const trimmed = uri.trim();
  if (!trimmed.startsWith(MCP_RESOURCE_PREFIX)) return null;
  const rel = trimmed.slice(MCP_RESOURCE_PREFIX.length);
  if (!rel || rel.startsWith("/") || rel.includes("..")) return null;
  return rel;
}

/** 按扩展名给 MIME：MCP 客户端多半只认 markdown / json / text 三类。 */
export function mimeOf(rel: string): string {
  const lower = rel.toLowerCase();
  if (lower.endsWith(".md") || lower.endsWith(".markdown")) return "text/markdown";
  if (lower.endsWith(".json")) return "application/json";
  return "text/plain";
}

/**
 * 交给客户端之前的两件归一：去掉文件开头的 BOM、CRLF 折成 LF。
 *
 * 这两样对「把这文件当上下文读」只有坏处：BOM 会变成正文第一个字符（还会让
 * `# 标题` / `> 说明` 这类首行约定认不出来——记事本和 PowerShell 5 默认就写 BOM），
 * CRLF 会让每行多一个 `\r`。除此之外**不做任何改写**，命令文件的正文、缩进、代码块都照原样。
 */
export function normalizeCatalogText(text: string): string {
  return text.replace(/^\uFEFF/, "").replace(/\r\n/g, "\n");
}

/** 截到上限，并在末尾说明「要看全的请用 file_read 读哪一份」。 */
function clip(text: string, rel: string): string {
  if (text.length <= MCP_CATALOG_MAX_FILE_CHARS) return text;
  return (
    text.slice(0, MCP_CATALOG_MAX_FILE_CHARS) +
    `\n\n（这份文件超过 ${MCP_CATALOG_MAX_FILE_CHARS} 字，这里只给了前面这些；要看全的请用 file_read 读 ${rel}。）`
  );
}

/**
 * 采集一个工作区的提示词与资源。
 *
 * 顺序是固定的（命令按路径排序、约定文件按 `PROJECT_RULE_FILES` 的顺序、配置放最后），
 * 这样客户端两次 `prompts/list` / `resources/list` 看到的顺序一致——每次请求都重新读，
 * 用户改了 `.heming/commands/review.md` 下次就能看到新版本。
 */
export async function collectCliMcpCatalog(input: {
  cwd: string;
  bridge?: FileFsBridge | null;
}): Promise<McpCatalog> {
  const roots = cliProjectRuleRoots(input.cwd);
  const bridge = input.bridge ?? createNodeFsBridge();
  const prompts: McpPromptEntry[] = [];
  const resources: McpResourceEntry[] = [];

  /**
   * 桥返回的路径可能是绝对路径（Node 桥就是这样）。对客户端来说必须是工作区相对路径：
   * 绝对路径会把用户机器上的目录结构漏进 URI，客户端也没法再交给 file_read。
   */
  const toRel = (raw: string): string => {
    const posix = raw.replace(/\\/g, "/");
    if (!path.isAbsolute(posix)) return posix.replace(/^\.\//, "");
    return path.relative(input.cwd, posix).replace(/\\/g, "/").replace(/^\.\//, "");
  };

  const readText = async (target: string): Promise<string | null> => {
    // 桥的 read 只认绝对路径（它要按根做越界判定），所以相对路径先落到 cwd 上。
    const abs = path.isAbsolute(target)
      ? target.replace(/\\/g, "/")
      : path.join(input.cwd, target).replace(/\\/g, "/");
    try {
      const res = await bridge.read({ roots, path: abs });
      return res.ok ? normalizeCatalogText(res.content) : null;
    } catch {
      return null;
    }
  };

  const addResource = (rel: string, text: string, title?: string): void => {
    if (resources.length >= MCP_CATALOG_MAX_RESOURCES) return;
    if (resources.some((entry) => entry.rel === rel)) return;
    const name = rel.split("/").pop() ?? rel;
    resources.push({
      uri: resourceUriOf(rel),
      name,
      ...(title ? { title } : {}),
      description: `工作区里的 ${rel}`,
      mimeType: mimeOf(rel),
      text: clip(text, rel),
      rel,
    });
  };

  // 1. 自定义命令：既是可被选用的提示词，也是可读的资源（同一份文件，两种视图）。
  try {
    if (bridge.glob) {
      const found = await bridge.glob({ roots, pattern: `${CUSTOM_COMMANDS_DIR}/*.md` });
      if (found.ok) {
        const files = [...found.paths].sort();
        const sources: CustomCommandSource[] = [];
        for (const abs of files) {
          const rel = toRel(abs);
          if (!rel) continue;
          const text = await readText(abs);
          if (text === null) continue;
          sources.push({ rel, text });
          addResource(rel, text);
        }
        for (const command of parseCustomCommands(sources)) {
          prompts.push({
            name: command.name,
            title: command.title,
            ...(command.hint ? { description: command.hint } : {}),
            text: command.prompt,
            source: command.rel,
          });
        }
      }
    }
  } catch {
    // 命令目录读不了：当这个工作区没有自定义命令。
  }

  // 2. 仓库约定（AGENTS.md 一族）。
  for (const rel of PROJECT_RULE_FILES) {
    const text = await readText(rel);
    if (text !== null) addResource(rel, text);
  }

  // 3. 工作区配置（权限、钩子、外部 MCP 服务）。
  for (const rel of MCP_CONFIG_FILES) {
    const text = await readText(rel);
    if (text !== null) addResource(rel, text);
  }

  return { prompts, resources };
}

/** stderr / instructions 用的一行摘要。空目录返回空串（调用方就不打印）。 */
export function describeCliMcpCatalog(catalog: McpCatalog): string {
  if (catalog.prompts.length === 0 && catalog.resources.length === 0) return "";
  const parts: string[] = [];
  if (catalog.prompts.length > 0) {
    parts.push(`${catalog.prompts.length} 条提示词（${catalog.prompts.map((p) => p.name).join("、")}）`);
  }
  if (catalog.resources.length > 0) {
    parts.push(`${catalog.resources.length} 份资源`);
  }
  return `工作区内容：${parts.join("、")}，客户端可以用 prompts / resources 直接取用`;
}

/** 一条资源模板（MCP 的 `ResourceTemplate`）：URI 里带占位符，客户端填完再来读。 */
export interface McpResourceTemplate {
  uriTemplate: string;
  name: string;
  title?: string;
  description?: string;
  /** 客户端据此决定当文本还是当二进制处理；具体文件的实际类型以 `resources/read` 回执为准。 */
  mimeType?: string;
}

/**
 * 这个服务提供的资源模板（目前只有一条：工作区里任意文本文件）。
 *
 * 为什么值得单开一类而不是继续往固定名单里加：固定名单能覆盖的是「命令、约定、配置」，
 * 但客户端真正会想读的常常是普通源码文件（「把这个文件的全文读进来」）。没有模板时，
 * 它只能退回去调 `file_read` 工具——那要多跑一轮模型调用；有了模板就能直接当上下文引用。
 */
export function describeResourceTemplates(): McpResourceTemplate[] {
  return [
    {
      uriTemplate: MCP_RESOURCE_TEMPLATE_URI,
      name: "工作区文件",
      title: "工作区里的任意文本文件",
      description:
        "把 {path} 换成本工作区内的相对路径（用正斜杠），例如 heming://workspace/src/a.ts。" +
        `只读；不是文本或超过 ${MCP_CATALOG_MAX_FILE_CHARS} 字会说明原因/截断，不会替客户端改文件。`,
    },
  ];
}

/** 读模板资源的回执：成功带正文，失败是一句人话（协议层原样转成 -32602）。 */
export type WorkspaceResourceRead =
  | { ok: true; uri: string; mimeType: string; text: string }
  | { ok: false; reason: string };

/**
 * 按模板 URI 读工作区里的一份文本文件（d.342）。
 *
 * 三条边界都在这一个函数里，协议层不再自己拼路径：
 *
 * 1. **只读工作区**：URI 必须是 `heming://workspace/<相对路径>`，`relOfResourceUri` 已经挡掉
 *    `..` 与开头的 `/`；这里再算一次相对路径，跑出工作区就拒——不依赖桥的越界判定也安全。
 * 2. **只给文本**：桥自己会区分二进制/编码问题，回执里的 `code` 直接翻成人话。
 * 3. **单份有上限**：与固定名单同一个上限，超了截断并指明「要看全的用 file_read 读哪个文件」。
 */
export async function readWorkspaceResource(input: {
  cwd: string;
  uri: string;
  bridge?: FileFsBridge | null;
}): Promise<WorkspaceResourceRead> {
  const rel = relOfResourceUri(input.uri);
  if (rel === null) {
    return {
      ok: false,
      reason: `资源 URI 必须是 heming://workspace/<相对路径>，且不能包含 .. 或以 / 开头（收到：${input.uri}）`,
    };
  }
  const clean = rel.replace(/\/+$/, "");
  if (!clean) return { ok: false, reason: "资源 URI 里没有文件路径" };
  if (clean.includes("\u0000")) return { ok: false, reason: "资源 URI 里有非法字符" };

  const abs = path.join(input.cwd, clean).replace(/\\/g, "/");
  const escaped = path.relative(input.cwd, abs).replace(/\\/g, "/");
  if (escaped.startsWith("..") || path.isAbsolute(escaped)) {
    return { ok: false, reason: `只能读工作区里的文件：${clean} 不在 ${input.cwd} 下` };
  }

  const bridge = input.bridge ?? createNodeFsBridge();
  const roots = cliProjectRuleRoots(input.cwd);
  let res: FileReadResponse;
  try {
    res = await bridge.read({ roots, path: abs });
  } catch (error) {
    return { ok: false, reason: `读 ${clean} 时出错：${(error as Error).message}` };
  }
  if (!res.ok) {
    const reasons: Record<string, string> = {
      "not-found": `工作区里没有这份文件：${clean}`,
      "not-file": `${clean} 不是文件（可能是个目录）`,
      "too-large": `${clean} 太大，一次读不完；改用 file_read 分段读`,
      binary: `${clean} 像是二进制文件，不能当文本资源读`,
      symlink: `${clean} 是符号链接，资源模板不跟着链接走`,
      "invalid-path": `${clean} 这个路径不合法`,
      "outside-roots": `只能读工作区里的文件：${clean}`,
      "no-roots": "这个服务没有可读的工作区",
      io: `读 ${clean} 时系统报错`,
    };
    return { ok: false, reason: reasons[res.code ?? ""] ?? `读不出 ${clean}：${res.error}` };
  }

  const text = normalizeCatalogText(res.content);
  return { ok: true, uri: resourceUriOf(clean), mimeType: mimeOf(clean), text: clip(text, clean) };
}
