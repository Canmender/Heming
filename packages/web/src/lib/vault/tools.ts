/**
 * 知识库（vault）的智能体工具：`vault_search` / `vault_read` / `vault_write`。
 *
 * 形状与 `lib/wiki/tools.ts` 一致（ToolBridge）：工具声明 + 执行 + 风险元数据，
 * 由能力注册表合并进本轮工具桥，HITL 由既有编排层按 `risk` 处理。
 *
 * 安全口径（规格 §4）：
 * - 读只允许库内文本相对路径（拒绝 `..`、绝对路径、盘符、NUL、隐藏目录、非文本扩展名）；
 * - 写走**智能体专用通道** `vault:apply`，只允许库的 `writeDirs`（默认 `inbox`），
 *   越界直接返回中文拒绝原因，不静默改写路径；
 * - 写工具风险标 `write`（既有工具桥据此问人）。
 *
 * 浏览器临时模式（无桌面桥）不注入这三个工具：往内存里写东西会让用户
 * 以为文件真的落盘了（与 `filesProvider` 同一产品判断）。
 */

import type { ToolBridge, ToolSource } from "../agentStream.js";
import type { RiskLevel } from "../hitl/types.js";
import { describeVaultError, isInsideWriteDirs, isVaultEphemeral } from "./bridge.js";
import { extractHeadings, frontmatterTags, parseFrontmatter } from "./parse.js";
import { runSearch } from "./search.js";
import { useVaultStore } from "./store.js";
import {
  MAX_PATH_CHARS,
  MAX_TEXT_BYTES,
  TEXT_EXTS,
  type VaultMeta,
} from "./types.js";

/** 一次检索最多返回几处命中。 */
export const VAULT_SEARCH_MAX = 10;

/** 默认返回命中数。 */
export const VAULT_SEARCH_DEFAULT = 5;

export interface VaultToolSpec {
  name: string;
  description: string;
  parameters: Record<string, unknown>;
  riskHint: RiskLevel;
}

const prop = (description: string) => ({ type: "string" as const, description });

/** 工具清单：两个只读 + 一个受限写。 */
export const VAULT_TOOLS: VaultToolSpec[] = [
  {
    name: "vault_search",
    riskHint: "read",
    description:
      "在本机知识库（vault，Obsidian 兼容的 markdown 目录）里检索。回答涉及用户笔记、项目背景、历史结论的问题前，先用它定位相关内容。支持 tag:#标签、path:目录、file:文件名、line:同段词、\"引号短语\"、-排除词，中文按二元组匹配。返回文件路径、命中行号与摘要。",
    parameters: {
      type: "object",
      properties: {
        query: prop("检索式，如「部署流程」「tag:#项目 预算」「\"预算与风险\"」。"),
        limit: {
          type: "number",
          description: `最多返回几处命中（默认 ${VAULT_SEARCH_DEFAULT}，上限 ${VAULT_SEARCH_MAX}）。`,
        },
      },
      required: ["query"],
    },
  },
  {
    name: "vault_read",
    riskHint: "read",
    description:
      "读取知识库某个文件的全文。路径先用 vault_search 找到（形如 inbox/会议纪要.md），不要凭猜测拼路径。",
    parameters: {
      type: "object",
      properties: {
        path: prop("库内相对路径，如 inbox/会议纪要.md。"),
      },
      required: ["path"],
    },
  },
  {
    name: "vault_write",
    riskHint: "write",
    description:
      "把内容写入知识库的允许目录（默认 inbox/，由用户在知识库设置里决定）。只读优先：能只查不写就不要写；只在用户明确要求把结论沉淀到知识库时使用。越界路径会被拒绝，且每次写入都会请用户确认（write 风险）。",
    parameters: {
      type: "object",
      properties: {
        path: prop("库内相对路径，必须落在允许目录内，如 inbox/memory-预算-20261108.md。"),
        content: prop("要写入的 markdown 正文。"),
        mode: {
          type: "string",
          enum: ["overwrite", "append"],
          description: "写入方式：overwrite 覆盖（默认），append 追加到文件末尾。",
        },
      },
      required: ["path", "content"],
    },
  },
];

/* ------------------------------------------------------------------ 参数校验 */

function extOf(rel: string): string {
  const base = rel.slice(rel.lastIndexOf("/") + 1);
  const dot = base.lastIndexOf(".");
  return dot <= 0 ? "" : base.slice(dot).toLowerCase();
}

/**
 * 校验模型给的知识库路径。
 *
 * 工具参数来自模型：`../../`、绝对路径、盘符、NUL、隐藏目录在桌面端会落到用户磁盘的
 * 任意位置，必须在进桥之前挡掉；这里只允许**可写文本扩展名**的库内相对路径。
 */
export function validVaultPath(raw: unknown): string | null {
  if (typeof raw !== "string") return null;
  const text = raw
    .trim()
    .replace(/\\/g, "/")
    .replace(/^\.\//, "");
  if (!text || text.length > MAX_PATH_CHARS) return null;
  if (text.includes("\u0000")) return null;
  if (text.startsWith("/") || /^[A-Za-z]:/.test(text)) return null;
  const parts = text.split("/");
  for (const part of parts) {
    if (!part || part === "." || part === "..") return null;
    if (part.startsWith(".")) return null;
  }
  if (!(TEXT_EXTS as readonly string[]).includes(extOf(text))) return null;
  return parts.join("/");
}

function clampLimit(value: unknown): number {
  const number = typeof value === "number" && Number.isFinite(value) ? Math.floor(value) : 0;
  if (!number) return VAULT_SEARCH_DEFAULT;
  return Math.min(VAULT_SEARCH_MAX, Math.max(1, number));
}

function parseArgs(raw: string): Record<string, unknown> {
  const text = raw?.trim();
  if (!text) return {};
  try {
    const parsed: unknown = JSON.parse(text);
    return parsed && typeof parsed === "object" && !Array.isArray(parsed)
      ? (parsed as Record<string, unknown>)
      : {};
  } catch {
    return {};
  }
}

function activeVault(): VaultMeta | null {
  const state = useVaultStore.getState();
  return state.vaults.find((vault) => vault.id === state.activeVaultId) ?? null;
}

function byteLength(text: string): number {
  return new TextEncoder().encode(text).length;
}

function basename(rel: string): string {
  return rel.slice(rel.lastIndexOf("/") + 1).replace(/\.[^.]+$/, "");
}

/* ------------------------------------------------------------------ 执行 */

async function executeSearch(args: Record<string, unknown>): Promise<{
  text: string;
  ok: boolean;
  sources?: ToolSource[];
}> {
  const query = typeof args.query === "string" ? args.query.trim().slice(0, 200) : "";
  if (!query) return { text: "query 不能为空。", ok: false };
  if (!useVaultStore.getState().activeVaultId) {
    return { text: "还没有打开知识库，无法检索。", ok: false };
  }
  if (useVaultStore.getState().indexStatus !== "ready") {
    await useVaultStore.getState().buildIndexNow();
  }
  const state = useVaultStore.getState();
  if (!state.index) return { text: "知识库索引不可用。", ok: false };

  const hits = runSearch(state.index, query, {
    limit: clampLimit(args.limit),
    lineOffsetOf: (rel) => state.lineOffsetOf(rel),
  });
  if (!hits.length) return { text: `知识库里没有匹配「${query}」的内容。`, ok: true };

  const lines = [`在知识库找到 ${hits.length} 处命中（按相关度排序）：`];
  const sources: ToolSource[] = [];
  const seen = new Set<string>();
  for (const hit of hits) {
    const page = state.index.pages.get(hit.rel);
    const title = page?.title ?? basename(hit.rel);
    lines.push(
      [`## ${title}`, `路径：${hit.rel}`, `行号：${hit.line}`, hit.snippet ? `摘要：${hit.snippet}` : ""]
        .filter(Boolean)
        .join("\n"),
    );
    if (!seen.has(hit.rel)) {
      seen.add(hit.rel);
      sources.push({ id: hit.rel, title, detail: `第 ${hit.line} 行`, kind: "wiki" });
    }
  }
  lines.push("回答时请以这些内容为依据；需要细节就用 vault_read 读全文。");
  return { text: lines.join("\n\n"), ok: true, sources };
}

async function executeRead(args: Record<string, unknown>): Promise<{
  text: string;
  ok: boolean;
  sources?: ToolSource[];
}> {
  const rel = validVaultPath(args.path);
  if (!rel) {
    return {
      text: "path 必须是库内文本相对路径（如 inbox/会议纪要.md），不能越出库根、不能用绝对路径或非文本扩展名。",
      ok: false,
    };
  }
  if (!useVaultStore.getState().activeVaultId) {
    return { text: "还没有打开知识库，无法读取。", ok: false };
  }
  let text: string | null = null;
  try {
    text = await useVaultStore.getState().readText(rel);
  } catch (err) {
    return { text: `读取知识库失败：${describeVaultError(err)}`, ok: false };
  }
  if (text === null) return { text: `知识库里没有文件 ${rel}。`, ok: false };

  const { meta, body, lineOffset } = parseFrontmatter(text);
  const title =
    typeof meta.title === "string" && meta.title.trim() ? meta.title.trim() : basename(rel);
  const header = [`# ${title}`, `路径：${rel}`];
  if (typeof meta.updated === "string" && meta.updated) header.push(`更新：${meta.updated}`);
  const tags = frontmatterTags(meta);
  if (tags.length) header.push(`标签：${tags.join("、")}`);
  const headings = extractHeadings(body, { lineOffset }).slice(0, 12);
  if (headings.length) {
    header.push(
      `大纲：${headings.map((heading) => `${"#".repeat(heading.level)} ${heading.text}`).join(" / ")}`,
    );
  }
  return {
    text: `${header.join("\n")}\n\n${body.trim()}`,
    ok: true,
    sources: [{ id: rel, title, detail: "知识库", kind: "wiki" }],
  };
}

async function executeWrite(args: Record<string, unknown>): Promise<{
  text: string;
  ok: boolean;
  sources?: ToolSource[];
}> {
  const rel = validVaultPath(args.path);
  if (!rel) {
    return {
      text: "path 必须是库内文本相对路径（如 inbox/结论.md），不能越出库根、不能用绝对路径或非文本扩展名。",
      ok: false,
    };
  }
  const content = typeof args.content === "string" ? args.content : "";
  if (!content.trim()) return { text: "content 不能为空。", ok: false };
  if (byteLength(content) > MAX_TEXT_BYTES) {
    return { text: "content 超过 2MB 上限，请拆分后再写。", ok: false };
  }
  const vault = activeVault();
  if (!vault) return { text: "还没有打开知识库，无法写入。", ok: false };
  if (isVaultEphemeral()) {
    return {
      text: "当前是浏览器临时模式（没有本地文件桥），写入不会落盘；请到桌面端再写入知识库。",
      ok: false,
    };
  }
  if (!isInsideWriteDirs(rel, vault.writeDirs)) {
    const allowed = vault.writeDirs.length ? vault.writeDirs.join("、") : "（未允许任何目录）";
    return {
      text: `拒绝写入：智能体只能写知识库的 ${allowed} 内的文件，${rel} 不在允许范围内。`,
      ok: false,
    };
  }
  const mode = args.mode === "append" ? "append" : "overwrite";
  const ok = await useVaultStore.getState().applyWrite(rel, content, mode);
  if (!ok) {
    return {
      text: `写入知识库失败：${useVaultStore.getState().error ?? "未知原因"}`,
      ok: false,
    };
  }
  return {
    text: `已写入 ${rel}（${mode === "append" ? "追加" : "覆盖"}，${byteLength(content)} 字节）。`,
    ok: true,
    sources: [{ id: rel, title: basename(rel), detail: "知识库", kind: "wiki" }],
  };
}

/* ------------------------------------------------------------------ 工具桥 */

/** 构建知识库工具桥（形状与 wiki 工具一致）。 */
export function buildVaultToolBridge(): ToolBridge {
  return {
    tools: VAULT_TOOLS.map((spec) => ({
      type: "function" as const,
      function: {
        name: spec.name,
        description: spec.description,
        parameters: spec.parameters,
      },
    })),
    meta: (name) => {
      const spec = VAULT_TOOLS.find((item) => item.name === name);
      return spec ? { risk: spec.riskHint } : undefined;
    },
    execute: async (call) => {
      const args = parseArgs(call.arguments);
      try {
        switch (call.name) {
          case "vault_search":
            return await executeSearch(args);
          case "vault_read":
            return await executeRead(args);
          case "vault_write":
            return await executeWrite(args);
          default:
            return { text: `未知工具 ${call.name}`, ok: false };
        }
      } catch (err) {
        // 永不抛：工具失败让模型知道原因（可改用别的依据），不中断整轮
        return {
          text: `知识库操作失败：${describeVaultError(err)}`,
          ok: false,
        };
      }
    },
  };
}

/** 只在桌面端（有文件桥）注入：浏览器临时模式写内存没有意义。 */
export function buildVaultToolBridgeIfAvailable(): ToolBridge | null {
  if (isVaultEphemeral()) return null;
  return buildVaultToolBridge();
}
