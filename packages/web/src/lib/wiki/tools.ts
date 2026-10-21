/**
 * 知识库（wiki/）的只读工具：让智能体在回答前先检索个人知识库，
 * 并让答案末尾能挂上可核对的来源。
 *
 * 为什么是工具而不是「每轮把所有 wiki 塞进系统提示词」：
 * 知识库会长期增长，全量注入既超预算又会稀释当前问题；按需检索才是标准做法
 *（卡帕西 LLM Wiki 里的 Query 流程：先 index 定位，再读具体页面）。
 *
 * 来源由编排层拼脚注（见 agentStream.sourceFooter），不依赖模型自觉：
 * 模型可以漏写引用，但「这次到底读过哪些页面」是工具返回值说了算。
 */

import type { ToolBridge, ToolSource } from "../agentStream.js";
import type { RiskLevel } from "../hitl/types.js";
import {
  KIND_LABEL,
  parseFrontmatter,
  parsePagePath,
  resolveWikiBridge,
  type WikiBridge,
  type WikiPage,
} from "./index.js";

/** 一次检索最多返回几页（再少不够用，再多等于把库倒给模型）。 */
export const WIKI_SEARCH_MAX = 10;

/** 默认返回页数。 */
export const WIKI_SEARCH_DEFAULT = 5;

/** 单次扫描的页面文件上限：个人库通常几百页，超出时先扫前 N 个，避免一次读几百个文件。 */
export const WIKI_SCAN_MAX = 500;

export interface WikiToolSpec {
  name: string;
  description: string;
  parameters: Record<string, unknown>;
  riskHint: RiskLevel;
}

const prop = (description: string) => ({ type: "string" as const, description });

/** 工具清单：只有读，没有写——修改知识库仍由用户或 wiki 面板完成。 */
export const WIKI_TOOLS: WikiToolSpec[] = [
  {
    name: "wiki_search",
    riskHint: "read",
    description:
      "在本机个人知识库（wiki/ 下的 markdown 页面）里检索。回答涉及项目背景、概念定义、历史结论的问题前，先用它定位相关页面。返回结果含页面路径与摘要。",
    parameters: {
      type: "object",
      properties: {
        query: prop("关键词或问题片段，如「部署流程」「记忆分层」。"),
        limit: {
          type: "number",
          description: `最多返回几页（默认 ${WIKI_SEARCH_DEFAULT}，上限 ${WIKI_SEARCH_MAX}）。`,
        },
      },
      required: ["query"],
    },
  },
  {
    name: "wiki_read",
    riskHint: "read",
    description:
      "读取知识库某个页面的全文。路径先用 wiki_search 找到（形如 wiki/concepts/llm.md），不要凭猜测拼路径。",
    parameters: {
      type: "object",
      properties: {
        path: prop("页面相对路径，如 wiki/concepts/llm.md。"),
      },
      required: ["path"],
    },
  },
];

/* ------------------------------------------------------------------ 检索 */

export interface WikiSearchHit {
  page: WikiPage;
  score: number;
  snippet: string;
}

/**
 * 纯函数检索：所有关键词都命中才入选（AND），标题命中权重最高。
 * 排序固定为「得分 → 标题 → 路径」，同一份库同一句 query 每次结果一致。
 */
export function searchPages(
  pages: WikiPage[],
  query: string,
  limit: number = WIKI_SEARCH_DEFAULT,
): WikiSearchHit[] {
  const q = query.trim().toLowerCase();
  if (!q) return [];
  const terms = q.split(/\s+/).filter(Boolean);
  const hits: WikiSearchHit[] = [];
  for (const page of pages) {
    const title = page.title.toLowerCase();
    const tags = page.tags.join(" ").toLowerCase();
    const body = page.body.toLowerCase();
    const hay = `${title}\n${tags}\n${body}`;
    if (!terms.every((t) => hay.includes(t))) continue;
    let score = 0;
    for (const t of terms) {
      if (title.includes(t)) score += 6;
      if (tags.includes(t)) score += 3;
      if (body.includes(t)) score += 1;
    }
    if (title.includes(q)) score += 5;
    hits.push({ page, score, snippet: snippetAround(page.body, terms[0]) });
  }
  hits.sort(
    (a, b) =>
      b.score - a.score ||
      a.page.title.localeCompare(b.page.title) ||
      a.page.path.localeCompare(b.page.path),
  );
  return hits.slice(0, clampLimit(limit));
}

function clampLimit(n: unknown): number {
  const value = typeof n === "number" && Number.isFinite(n) ? Math.floor(n) : WIKI_SEARCH_DEFAULT;
  return Math.min(WIKI_SEARCH_MAX, Math.max(1, value));
}

/** 命中词附近的一小段正文（压成单行，便于列表里读）。 */
function snippetAround(body: string, term: string): string {
  const flat = body.replace(/\s+/g, " ").trim();
  if (!flat) return "";
  const at = flat.toLowerCase().indexOf(term);
  if (at < 0) return flat.slice(0, 120);
  const start = Math.max(0, at - 50);
  const text = flat.slice(start, start + 140);
  return `${start > 0 ? "…" : ""}${text}${start + 140 < flat.length ? "…" : ""}`;
}

/** 从磁盘/内存桥读出全部 wiki 页面（index.md、log.md 与 raw/ 不算页面）。 */
async function loadPages(bridge: WikiBridge): Promise<WikiPage[]> {
  const files = (await bridge.list())
    .filter((f) => /^wiki\/.+\.md$/.test(f))
    .sort()
    .slice(0, WIKI_SCAN_MAX);
  const pages: WikiPage[] = [];
  for (const path of files) {
    const raw = await bridge.read(path);
    if (raw == null) continue;
    const { meta, body } = parseFrontmatter(raw);
    const info = parsePagePath(path);
    pages.push({
      path,
      title: String(meta.title ?? info?.slug ?? "未命名"),
      kind: info?.kind ?? "notes",
      tags: Array.isArray(meta.tags) ? meta.tags : [],
      body,
      updatedAt: String(meta.updated ?? ""),
    });
  }
  return pages;
}

/**
 * 校验模型给的路径：只允许 `wiki/` 或 `raw/` 下的 `.md`。
 *
 * 这是提示注入之外的另一道边界：工具参数来自模型，`../../` 这类写法
 * 在桌面端会直接落到用户磁盘的任意位置，必须在进 read 之前挡掉。
 */
export function validWikiPath(raw: unknown): string | null {
  if (typeof raw !== "string") return null;
  const path = raw.trim().replace(/^\.\//, "");
  if (!path || path.length > 300) return null;
  if (path.includes("..") || path.includes("\\") || path.includes("\0") || path.startsWith("/")) {
    return null;
  }
  if (!/^(wiki|raw)\/[^/]+(\/[^/]+)*\.md$/.test(path)) return null;
  return path;
}

/* ------------------------------------------------------------------ 工具桥 */

export function buildWikiToolBridge(bridge: WikiBridge = resolveWikiBridge()): ToolBridge {
  return {
    tools: WIKI_TOOLS.map((spec) => ({
      type: "function" as const,
      function: {
        name: spec.name,
        description: spec.description,
        parameters: spec.parameters,
      },
    })),
    meta: (name) => {
      const spec = WIKI_TOOLS.find((s) => s.name === name);
      return spec ? { risk: spec.riskHint } : undefined;
    },
    execute: async (call) => {
      const args = parseArgs(call.arguments);
      try {
        switch (call.name) {
          case "wiki_search": {
            const query = typeof args.query === "string" ? args.query.trim().slice(0, 200) : "";
            if (!query) return { text: "query 不能为空。", ok: false };
            const hits = searchPages(await loadPages(bridge), query, args.limit as number);
            if (!hits.length) {
              return { text: `知识库里没有匹配「${query}」的页面。`, ok: true };
            }
            const text = [
              `在知识库找到 ${hits.length} 个页面（按相关度排序）：`,
              ...hits.map((h) => {
                const tags = h.page.tags.length ? `\n标签：${h.page.tags.join("、")}` : "";
                return (
                  `## ${h.page.title}\n` +
                  `路径：${h.page.path}\n` +
                  `类别：${KIND_LABEL[h.page.kind]}${tags}` +
                  (h.snippet ? `\n摘要：${h.snippet}` : "")
                );
              }),
              "回答时请以这些页面为依据；需要细节就用 wiki_read 读全文。",
            ].join("\n\n");
            return { text, ok: true, sources: sourcesOf(hits) };
          }
          case "wiki_read": {
            const path = validWikiPath(args.path);
            if (!path) {
              return {
                text: "path 必须是 wiki/ 或 raw/ 下的 .md 相对路径，例如 wiki/concepts/llm.md。",
                ok: false,
              };
            }
            const raw = await bridge.read(path);
            if (raw == null) return { text: `知识库里没有页面 ${path}。`, ok: false };
            const { meta, body } = parseFrontmatter(raw);
            const title = String(meta.title ?? parsePagePath(path)?.slug ?? basename(path));
            const header = [`# ${title}`, `路径：${path}`];
            if (meta.updated) header.push(`更新：${String(meta.updated)}`);
            return {
              text: `${header.join("\n")}\n\n${body.trim()}`,
              ok: true,
              sources: [{ id: path, title } satisfies ToolSource],
            };
          }
          default:
            return { text: `未知工具 ${call.name}`, ok: false };
        }
      } catch (e) {
        // 永不抛：读库失败让模型知道原因（可改用别的依据），不中断整轮
        return {
          text: `读取知识库失败：${e instanceof Error ? e.message : String(e)}`,
          ok: false,
        };
      }
    },
  };
}

/** 命中页 → 脚注来源（同一路径只出现一次）。 */
function sourcesOf(hits: WikiSearchHit[]): ToolSource[] {
  const seen = new Set<string>();
  const out: ToolSource[] = [];
  for (const { page } of hits) {
    if (seen.has(page.path)) continue;
    seen.add(page.path);
    out.push({ id: page.path, title: page.title, detail: KIND_LABEL[page.kind] });
  }
  return out;
}

function basename(path: string): string {
  return path.slice(path.lastIndexOf("/") + 1).replace(/\.md$/, "");
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
