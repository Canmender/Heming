/**
 * 个人知识库的客户端层（卡帕西 LLM Wiki 标准）。
 *
 * 桌面端经 preload 的 `__heming_wiki` 桥读写**真实 markdown 文件**——
 * 这样 Obsidian 能直接打开这个目录图谱浏览，任意 LLM agent 也能直接维护它，
 * 这正是标准里「Obsidian 是 IDE、LLM 是程序员、wiki 是代码库」的含义。
 *
 * 浏览器没有文件桥，降级到内存实现：功能（建页、双链、图谱）完全可用，
 * 只是关掉页面就没了。此时界面会明确提示「当前为临时模式」。
 */

/** preload 暴露的桥（浏览器端为 undefined）。 */
export interface WikiBridge {
  info(): Promise<{ root: string; exists: boolean }>;
  list(): Promise<string[]>;
  read(rel: string): Promise<string | null>;
  write(rel: string, content: string): Promise<{ path: string; bytes: number }>;
  remove(rel: string): Promise<boolean>;
  log(kind: string, title: string, extra?: string): Promise<boolean>;
}

/** 取桥：桌面端有、浏览器端没有。 */
export function getWikiBridge(): WikiBridge | null {
  if (typeof window === "undefined") return null;
  const bridge = (window as unknown as { __heming_wiki?: WikiBridge }).__heming_wiki;
  return bridge ?? null;
}

/** 页面类别：与 wiki-fs.js 的 PAGE_KINDS 对应，也是 index.md 的分组口径。 */
export const WIKI_KINDS = [
  "entities",
  "concepts",
  "sources",
  "synthesis",
  "notes",
] as const;
export type WikiKind = (typeof WIKI_KINDS)[number];

/** 类别中文名（界面用）。 */
export const KIND_LABEL: Record<WikiKind, string> = {
  entities: "实体",
  concepts: "概念",
  sources: "来源",
  synthesis: "综合",
  notes: "笔记",
};

/** wiki/<类别>/<页面>.md 的相对路径。 */
export function pagePath(kind: WikiKind, slug: string): string {
  return `wiki/${kind}/${slug}.md`;
}

/** raw/<来源>.md 的相对路径。 */
export function rawPath(slug: string): string {
  return `raw/${slug}.md`;
}

/**
 * 从文件名生成 slug：去掉非法字符、转小写、非中文部分用连字符连接。
 * 中文保留（Obsidian 与常见文件系统都支持），只清掉路径分隔符与 Windows 保留符。
 */
export function slugify(title: string): string {
  const cleaned = title
    .trim()
    // 文件系统非法字符：ASCII 一批 + 中文全角冒号/问号等在部分平台也受限
    .replace(/[<>:"/\\|?*\x00-\x1f]/g, "-")
    .replace(/[：？＊]/g, "-")
    .replace(/\s+/g, "-") // 空格转连字符
    .replace(/-+/g, "-")
    .replace(/^-|-$/g, "");
  // 按码点截断：标题里的 emoji 若被切成半个代理对，作为文件名写盘会变成 U+FFFD。
  const clipped = Array.from(cleaned).slice(0, 60).join("");
  return clipped || "未命名";
}

/**
 * 一个 wiki 页面。body 存去掉 frontmatter 后的正文——
 * frontmatter 单独字段化，便于程序读写 tags 而不必解析 YAML。
 */
export interface WikiPage {
  /** 相对路径，如 wiki/concepts/llm.md */
  path: string;
  title: string;
  kind: WikiKind;
  tags: string[];
  /** 正文（不含 frontmatter）。 */
  body: string;
  updatedAt: string;
}

/* ------------------------------------------------------------------ 解析 */

/**
 * 拆 frontmatter。标准里页面带 YAML 头（tags/updated），Dataview 之类插件也依赖它。
 * 只支持 `key: value` 与 `key: [a, b]` 两种形态——足够 tags 用，
 * 不引入 YAML 依赖（解析器越弱越好，错也只错在 tags 上）。
 */
export function parseFrontmatter(
  raw: string,
): { meta: Record<string, string | string[]>; body: string } {
  const text = raw.replace(/^﻿/, ""); // 去 BOM，否则首行匹配不到 ---
  const match = /^---\r?\n([\s\S]*?)\r?\n---\r?\n?/.exec(text);
  if (!match) return { meta: {}, body: text };
  const meta: Record<string, string | string[]> = {};
  for (const line of match[1].split(/\r?\n/)) {
    const kv = /^([A-Za-z_][\w-]*)\s*:\s*(.*)$/.exec(line.trim());
    if (!kv) continue;
    const [, key, rawValue] = kv;
    const value = rawValue.trim();
    if (value.startsWith("[") && value.endsWith("]")) {
      meta[key] = value
        .slice(1, -1)
        .split(",")
        .map((s) => s.trim().replace(/^["']|["']$/g, ""))
        .filter(Boolean);
    } else {
      meta[key] = value.replace(/^["']|["']$/g, "");
    }
  }
  return { meta, body: text.slice(match[0].length) };
}

/** 组装带 frontmatter 的页面文本（tags 为空时省略该行，避免留下空数组噪声）。 */
export function renderPage(page: {
  title: string;
  tags?: string[];
  body: string;
  updated?: string;
}): string {
  const updated = page.updated ?? new Date().toISOString().slice(0, 10);
  const lines = ["---", `title: ${page.title}`];
  if (page.tags?.length) lines.push(`tags: [${page.tags.join(", ")}]`);
  lines.push(`updated: ${updated}`, "---", "");
  return `${lines.join("\n")}\n${page.body.trim()}\n`;
}

/** 从相对路径反推 kind 与 slug。 */
export function parsePagePath(rel: string): { kind: WikiKind; slug: string } | null {
  const m = /^wiki\/([a-z]+)\/(.+)\.md$/.exec(rel);
  if (!m) return null;
  const kind = m[1] as WikiKind;
  if (!WIKI_KINDS.includes(kind)) return null;
  return { kind, slug: m[2] };
}

/* ------------------------------------------------------------------ 双链 */

/**
 * 抽取正文里的 `[[页面名]]` 双链（Obsidian 语法）。
 * 保留 display 别名写法 `[[目标|显示]]` 里的「显示」部分。
 */
export function extractLinks(body: string): { target: string; alias?: string }[] {
  const out: { target: string; alias?: string }[] = [];
  // 别名写法 [[目标|显示]] 里目标本身可能含空格，用惰性匹配到第一个 |
  const re = /\[\[([^\][|\n]+?)(?:\|([^\][\n]+?))?\]\]/g;
  let m: RegExpExecArray | null;
  while ((m = re.exec(body)) !== null) {
    const target = m[1].trim();
    const alias = m[2]?.trim();
    if (target) out.push(alias ? { target, alias } : { target });
  }
  return out;
}

/** 把 `[[页面名]]` 渲染成可点的锚点（alias 优先作显示文本）。 */
export function renderLinks(body: string): { text: string; target: string }[] {
  return extractLinks(body).map((l) => ({ text: l.alias ?? l.target, target: l.target }));
}

/* ------------------------------------------------------------------ 图谱 */

export interface GraphNode {
  id: string;
  title: string;
  kind: WikiKind;
  /** 入链 + 出链总数，决定节点大小（枢纽页更大）。 */
  degree: number;
  /** 无入链且无出链 → 孤儿页，图谱里用另一种颜色标出（标准的 Lint 检查项之一）。 */
  orphan: boolean;
}

export interface GraphEdge {
  source: string;
  target: string;
}

export interface WikiGraph {
  nodes: GraphNode[];
  edges: GraphEdge[];
}

/**
 * 由页面集合构建图谱。
 *
 * 双链按**标题**解析目标（与 Obsidian 一致：写 `[[和小鸣]]` 指向同名页面），
 * 解析不到的目标会被忽略——不凭空造节点，否则图谱里会出现一堆幽灵点。
 */
export function buildGraph(pages: WikiPage[]): WikiGraph {
  const byTitle = new Map<string, string>();
  for (const page of pages) {
    const info = parsePagePath(page.path);
    // 同名页面：先出现的那个胜出，后出现的重复标题不覆盖——
    // 与「同名页面时链接解析到先出现的那一个」的约定一致，稳定且与顺序无关地偏好首个。
    if (info && !byTitle.has(page.title)) byTitle.set(page.title, page.path);
  }
  const byPath = new Map(pages.map((p) => [p.path, p]));
  const degree = new Map<string, number>();
  const edges: GraphEdge[] = [];
  const seenEdge = new Set<string>();

  for (const page of pages) {
    for (const link of extractLinks(page.body)) {
      const target = byTitle.get(link.target);
      if (!target || target === page.path) continue;
      // 去重：同一对页面可能有多处链接，图里只画一条
      const key = `${page.path}NUL${target}`;
      if (seenEdge.has(key)) continue;
      seenEdge.add(key);
      edges.push({ source: page.path, target });
      degree.set(page.path, (degree.get(page.path) ?? 0) + 1);
      degree.set(target, (degree.get(target) ?? 0) + 1);
    }
  }

  const nodes: GraphNode[] = pages.map((page) => {
    const d = degree.get(page.path) ?? 0;
    return {
      id: page.path,
      title: page.title,
      kind: parsePagePath(page.path)?.kind ?? "notes",
      degree: d,
      orphan: d === 0,
    };
  });
  return { nodes, edges };
}

/* ------------------------------------------------------------------ 索引 */

/**
 * 生成 index.md（标准里的内容目录）。
 * 回答问题时 LLM 先读 index 找相关页，再钻进具体页面——这就是为什么
 * 索引必须按类别组织且带一句话摘要。
 */
export function renderIndex(pages: WikiPage[]): string {
  const lines = ["---", "title: 索引", `updated: ${new Date().toISOString().slice(0, 10)}`, "---", ""];
  lines.push("# 索引", "", `共 ${pages.length} 个页面。`, "");
  for (const kind of WIKI_KINDS) {
    const inKind = pages.filter((p) => (parsePagePath(p.path)?.kind ?? "notes") === kind);
    if (!inKind.length) continue;
    lines.push(`## ${KIND_LABEL[kind]}（${inKind.length}）`, "");
    for (const page of inKind.sort((a, b) => a.title.localeCompare(b.title))) {
      // 一句话摘要：正文首个非标题、非列表行，截断 60 字
      const summary =
        page.body
          .split(/\r?\n/)
          .map((l) => l.trim())
          .find((l) => l && !l.startsWith("#") && !l.startsWith("---") && !l.startsWith("|")) ?? "";
      const chars = Array.from(summary);
      const short = chars.length > 60 ? `${chars.slice(0, 60).join("")}…` : summary;
      lines.push(`- [[${page.title}]]${short ? ` —— ${short}` : ""}`);
    }
    lines.push("");
  }
  return `${lines.join("\n")}\n`;
}

/**
 * 默认的 schema.md（标准的第三层：告诉 LLM 这个 wiki 该怎么维护）。
 * 首次建库时写入；用户改过就不覆盖（schema 是与 LLM 共同演进的产物，不该被程序改回）。
 */
export const DEFAULT_SCHEMA = `---
title: 知识库规约
updated: ${new Date().toISOString().slice(0, 10)}
---

# 知识库规约

本文件是知识库的维护规约，**LLM 与人共同演进**：改之前先读它，写完记得同步更新。

## 三层结构

- \`raw/<名称>.md\`：**原始来源，只读**。文章、论文、访谈记录等一手材料。
  LLM 读它、引用它，但**绝不修改它**——它是全部结论的事实基准。
- \`wiki/<类别>/<页面>.md\`：**LLM 生成的页面**，可改。类别：
  - \`entities\` 实体：人、组织、产品、地点等具体对象
  - \`concepts\` 概念：抽象观点、方法、模式
  - \`sources\` 来源：单份原始材料的摘要页
  - \`synthesis\` 综合：跨页面的综合结论、演进中的论点
  - \`notes\` 笔记：其他零散内容
- \`index.md\` / \`log.md\`：索引与流水，见下。

## 页面格式

每个页面带 YAML frontmatter（\`title\` / \`tags\` / \`updated\`），正文用 markdown，
页面之间用 Obsidian 双向链接 \`[[页面名]]\` 交叉引用（可写别名 \`[[目标|显示文字]]\`）。

## 操作流程

**Ingest（摄入）**
1. 读 \`raw/\` 下的新材料，与我确认关键收获。
2. 在 \`wiki/\` 写或更新相关页面——一份材料常会触及十几页，不止新建一页。
3. 更新 \`index.md\`（按类别加条目 + 一句话摘要）。
4. 追加 \`log.md\`：\`## [YYYY-MM-DD] ingest | 材料标题\`。

**Query（提问）**
1. 先读 \`index.md\` 定位相关页，再钻进具体页面读全文。
2. 回答带引用（标明来自哪个页面）。
3. **有价值的回答要归档回 wiki**：新建页面或追加到已有页面，让探索成果沉淀而非消失在聊天记录里。

**Lint（体检）**
定期检查：页面间矛盾、被新资料推翻的旧结论、无入链的孤儿页、
被反复提及却没有独立页面的概念、缺失的交叉引用。
体检结论与待查方向追加到 \`log.md\`。

## 底线

- 不改 \`raw/\`。
- 每条长期结论都要能追溯到某个 \`raw/\` 来源或某次提问。
- 矛盾不要掩盖：新旧结论冲突时，两个都写上并注明时间，说明哪个更新。
`;

/* ------------------------------------------------------------------ 浏览器降级 */

/** 内存实现：浏览器端没有文件桥时用，接口与 WikiBridge 一致。 */
export function createMemoryWikiBridge(): WikiBridge {
  const files = new Map<string, string>();
  return {
    async info() {
      return { root: "（浏览器临时模式，不落盘）", exists: files.size > 0 };
    },
    async list() {
      return [...files.keys()].sort();
    },
    async read(rel) {
      return files.get(rel) ?? null;
    },
    async write(rel, content) {
      files.set(rel, content);
      return { path: rel, bytes: new TextEncoder().encode(content).length };
    },
    async remove(rel) {
      return files.delete(rel);
    },
    async log(kind, title, extra) {
      const today = new Date().toISOString().slice(0, 10);
      const prev = files.get("log.md") ?? "";
      files.set(
        "log.md",
        `${prev}\n## [${today}] ${kind} | ${title}\n${extra ? `\n${extra}\n` : ""}`,
      );
      return true;
    },
  };
}

/** 取可用桥：有 preload 桥就用它，否则退到内存实现。 */
export function resolveWikiBridge(): WikiBridge {
  return getWikiBridge() ?? createMemoryWikiBridge();
}

/** 是否为浏览器临时模式（界面据此提示「关掉就没了」）。 */
export function isWikiEphemeral(): boolean {
  return getWikiBridge() === null;
}