/**
 * 卡帕西 LLM Wiki 标准的**结构清单 / 检查 / 补齐**（知识库页「标准检查」的数据面）。
 *
 * 口径（计划 §0.2）：
 *   raw/<来源>.md            原始来源，只读
 *   wiki/{entities,concepts,sources,synthesis,notes}/<页面>.md   LLM 维护页
 *   index.md / log.md / schema.md / 首页.md                       四个根文件
 *   每个 .md 必须有 `created` + `tags` frontmatter
 *
 * 三条纪律：
 * 1. **检查只报告，不改文件**：缺 frontmatter 的页面只列出来，绝不自动补
 *    （改写用户的正文内容比不标准更糟，而且「created」只有作者知道）；
 * 2. **补齐只补缺**：目录用 `createDir`（幂等），根文件用 `create`（已存在会失败，
 *    这里把它当「已经有了」跳过），绝不覆盖用户已经写过的内容；
 * 3. **与桌面端同一套模板**：默认库首启也会落一份同样的结构（`packages/desktop/vault-fs.js`
 *    的 `ensureStandardVault` / `buildStandardFile`）。两处清单与模板**改一处必须改两处**。
 *
 * 纯逻辑（`inspectStandard`）不碰桥、可直接单测；落盘动作（`applyStandardRepair`）
 * 只依赖 `VaultBridge` 的既有方法，浏览器内存桥同样可用（临时模式也能补齐自测）。
 */

import { describeVaultError } from "./bridge.js";
import type { VaultBridge, VaultEntry, VaultId } from "./types.js";

/** 标准目录（相对库根；建目录用 mkdir -p，父目录自动出现）。 */
export const STANDARD_DIRS = [
  "raw",
  "wiki/entities",
  "wiki/concepts",
  "wiki/sources",
  "wiki/synthesis",
  "wiki/notes",
] as const;

/** 标准的四个根文件。 */
export const STANDARD_ROOT_FILES = ["index.md", "log.md", "schema.md", "首页.md"] as const;

/** 每个 markdown 页面必须具备的 frontmatter 字段。 */
export const REQUIRED_FRONTMATTER_FIELDS = ["created", "tags"] as const;

/** 必备 frontmatter 字段名。 */
export type FrontmatterField = (typeof REQUIRED_FRONTMATTER_FIELDS)[number];

/**
 * 生成标准根文件的初始模板。
 *
 * 与 `packages/desktop/vault-fs.js` 的 `buildStandardFile` 逐字同源（口径见文件头）；
 * 模板里带 `created` / `tags`，这样「刚补齐的库」自己就能通过标准检查。
 *
 * @param rel 根文件相对路径
 * @param today `YYYY-MM-DD`（注入而不是内部读时钟：单测要能断言固定日期）
 * @returns 模板文本；未知文件返回 null（调用方跳过）
 */
export function buildStandardFile(rel: string, today: string): string | null {
  const frontmatter = (title: string, tag: string): string =>
    `---\ntitle: ${title}\ncreated: ${today}\ntags: [${tag}]\nupdated: ${today}\n---\n`;
  switch (rel) {
    case "index.md":
      return `${frontmatter("索引", "index")}
# 索引

> 这是知识库的目录，由智能体维护：每新建或更新一个页面，就在对应类别下补一行
> \`- [[页面名]] —— 一句话摘要\`。人先读它定位相关页，再钻进具体页面。

## 实体（entities）

## 概念（concepts）

## 来源（sources）

## 综合（synthesis）

## 笔记（notes）
`;
    case "log.md":
      return `${frontmatter("时间流水", "log")}
# 时间流水

> 只追加、不改历史。每条以 \`## [YYYY-MM-DD] <类型> | <标题>\` 开头
> （类型如 init / ingest / query / lint），便于 grep 出「什么时候、因为什么动了知识库」。

## [${today}] init | 初始化知识库

- 建好 raw/、wiki/<类别>/、index.md、log.md、schema.md、首页.md。
- 之后缺什么，知识库页的「标准检查」会列出来。
`;
    case "schema.md":
      return `${frontmatter("知识库规约", "schema")}
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

每个页面带 YAML frontmatter，且必须有 \`created\`（创建日期）与 \`tags\`（分类标签）；
正文用 markdown，页面之间用 Obsidian 双向链接 \`[[页面名]]\` 交叉引用（可写别名 \`[[目标|显示文字]]\`）。

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
    case "首页.md":
      return `${frontmatter("首页", "index")}
# 欢迎使用知识库

这里按卡帕西 LLM Wiki 标准组织：**人负责判断，LLM 负责整理**。

## 从这里开始

- [[索引]]：全库目录，回答提问前先查这里。
- \`raw/\`：放原始材料（文章、论文、访谈记录）。**只读**——智能体读它但不改它。
- \`wiki/\`：智能体维护的页面，按实体 / 概念 / 来源 / 综合 / 笔记分类。
- \`schema.md\`：维护规约；\`log.md\`：时间流水。

## 怎么用

1. 把材料丢进 \`raw/\`；
2. 在对话里让智能体「摄入」这份材料；
3. 它会更新 \`wiki/\` 页面、\`index.md\` 与 \`log.md\`；
4. 有疑问直接问；答案有长期价值时让它归档回 wiki。
`;
    default:
      return null;
  }
}

/** `rel` 是否落在只读来源目录 `raw/`（含目录本身）。 */
export function isRawRel(rel: string): boolean {
  const norm = rel.replace(/\\/g, "/").replace(/^\/+/, "");
  return norm === "raw" || norm.startsWith("raw/");
}

/** frontmatter 值是否「有内容」：非空字符串，或至少一个非空元素的数组。 */
function hasValue(value: string | string[] | undefined): boolean {
  if (Array.isArray(value)) return value.some((item) => String(item).trim().length > 0);
  return typeof value === "string" && value.trim().length > 0;
}

/**
 * 一个页面的 frontmatter 缺哪些必备字段。
 * 没有 frontmatter 时 `meta` 是空对象，两个字段都会报缺——这正是想要的结论。
 */
export function missingFrontmatterFields(
  meta: Record<string, string | string[]> | undefined,
): FrontmatterField[] {
  const fields: FrontmatterField[] = [];
  for (const field of REQUIRED_FRONTMATTER_FIELDS) {
    if (!hasValue(meta?.[field])) fields.push(field);
  }
  return fields;
}

/** 一个页面的 frontmatter 问题。 */
export interface StandardPageIssue {
  rel: string;
  /** 缺的字段（created / tags）。 */
  missing: FrontmatterField[];
}

/** 检查输入：目录树 + 已解析的页面（通常是 `store.index.pages`）。 */
export interface StandardCheckInput {
  tree: VaultEntry[];
  /**
   * rel → 页面 frontmatter。传 `store.index.pages` 即可（`PageInfo` 结构兼容）。
   * 为 null/缺省时不检查 frontmatter（索引还没建好），报告里 `frontmatterChecked=false`。
   */
  pages?: Map<string, { frontmatter: Record<string, string | string[]> }> | null;
}

/** 标准检查结果。 */
export interface StandardReport {
  /** 缺失的标准目录（相对路径）。 */
  missingDirs: string[];
  /** 缺失的根文件。 */
  missingFiles: string[];
  /** 缺必备 frontmatter 的页面（最多列 `MAX_PAGE_ISSUES` 条，其余用计数表示）。 */
  pageIssues: StandardPageIssue[];
  /** 页面问题总数（`pageIssues` 只是前 N 条）。 */
  pageIssueCount: number;
  /** 扫过的页面数。 */
  scannedPages: number;
  /** 是否检查了 frontmatter（索引未就绪时为 false，界面要说明而不是假装通过）。 */
  frontmatterChecked: boolean;
  /** 结构 + frontmatter 是否全部合格。 */
  complete: boolean;
}

/** 报告里最多列多少条页面问题（界面滚动区不必渲染几千行）。 */
export const MAX_PAGE_ISSUES = 50;

/** 递归收集树里的目录与文件相对路径。 */
function collectTree(entries: VaultEntry[], dirs: Set<string>, files: Set<string>): void {
  for (const entry of entries) {
    if (entry.kind === "dir") {
      dirs.add(entry.rel);
      if (entry.children) collectTree(entry.children, dirs, files);
    } else {
      files.add(entry.rel);
    }
  }
}

/**
 * 检查一个库是否符合标准（纯函数，不碰磁盘）。
 *
 * 只检查**结构 + frontmatter 字段存在性**，不评判内容质量：内容是 Lint 阶段
 * 由人或智能体读的，不是弹窗能自动判的。
 */
export function inspectStandard(input: StandardCheckInput): StandardReport {
  const dirs = new Set<string>();
  const files = new Set<string>();
  collectTree(input.tree ?? [], dirs, files);

  const missingDirs = STANDARD_DIRS.filter((dir) => !dirs.has(dir));
  const missingFiles = STANDARD_ROOT_FILES.filter((rel) => !files.has(rel));

  const pages = input.pages ?? null;
  const pageIssues: StandardPageIssue[] = [];
  let pageIssueCount = 0;
  let scannedPages = 0;
  if (pages) {
    for (const [rel, page] of pages) {
      scannedPages += 1;
      const missing = missingFrontmatterFields(page.frontmatter);
      if (!missing.length) continue;
      pageIssueCount += 1;
      if (pageIssues.length < MAX_PAGE_ISSUES) pageIssues.push({ rel, missing });
    }
    // 稳定顺序：按路径排，用户扫一眼就知道缺的是哪批页面
    pageIssues.sort((a, b) => a.rel.localeCompare(b.rel));
  }

  const complete =
    missingDirs.length === 0 && missingFiles.length === 0 && pageIssueCount === 0;
  return {
    missingDirs,
    missingFiles,
    pageIssues,
    pageIssueCount,
    scannedPages,
    frontmatterChecked: Boolean(pages),
    complete,
  };
}

/** 补齐动作的结果（界面逐项如实展示，不把部分失败说成成功）。 */
export interface StandardRepairResult {
  createdDirs: string[];
  createdFiles: string[];
  /** 失败项（rel + 中文原因）；空数组才代表「全部补齐」。 */
  failures: { rel: string; message: string }[];
}

/** 补齐选项。 */
export interface StandardRepairOptions {
  /** 模板里的日期（默认今天；测试注入固定值）。 */
  today?: string;
}

/**
 * 一键补齐结构：只建**缺失**的目录与根文件。
 *
 * 已存在的一律跳过（`create` 抛「文件已存在」时按跳过处理——那多半是
 * 检查与补齐之间用户/智能体刚建好）；真正的失败（没权限等）记进 `failures`
 * 交给界面展示，绝不吞掉后宣称「已补齐」。
 */
export async function applyStandardRepair(
  bridge: VaultBridge,
  vaultId: VaultId,
  report: StandardReport,
  options: StandardRepairOptions = {},
): Promise<StandardRepairResult> {
  const today = options.today ?? new Date().toISOString().slice(0, 10);
  const result: StandardRepairResult = { createdDirs: [], createdFiles: [], failures: [] };

  for (const dir of report.missingDirs) {
    try {
      await bridge.createDir(vaultId, dir);
      result.createdDirs.push(dir);
    } catch (err) {
      result.failures.push({ rel: dir, message: describeVaultError(err) });
    }
  }

  for (const rel of report.missingFiles) {
    const text = buildStandardFile(rel, today);
    if (text === null) continue;
    try {
      await bridge.create(vaultId, rel, text);
      result.createdFiles.push(rel);
    } catch (err) {
      // 已存在 = 检查之后刚被建好：不算失败，也绝不覆盖
      const message = describeVaultError(err);
      if (/已存在/.test(message)) continue;
      result.failures.push({ rel, message });
    }
  }

  return result;
}
