/**
 * vault 搜索：Obsidian 风格子集（`tag:` / `path:` / `file:` / `line:` / 引号短语 / `-` 排除）。
 *
 * 分词复用 `lib/wiki/query.ts` 的 `tokenizeQuery`：ASCII 整词、CJK 长词展开相邻二元组并
 * 允许覆盖率命中——中文没有空格，逐词 includes 会让「预算风险」在「预算与风险」里 0 命中。
 *
 * 确定性契约：打分与排序只依赖页面内容与查询本身（权重是常量，同分按 rel 字典序），
 * 不读时钟、不用随机；同一份索引同一句 query 每次结果一致。
 */

import { matchTerm, tokenizeQuery, type QueryTerm } from "../wiki/query.js";
import type {
  PageInfo,
  SearchHit,
  SearchKey,
  SearchQuery,
  SearchTerm,
  VaultIndex,
} from "./types.js";

/** 一次搜索最多返回多少条（规格：结果 ≤200）。 */
export const SEARCH_MAX = 200;

/** 各类命中键的打分权重：文件名 > 标签 > 行内 > 路径 > 正文。 */
const KEY_WEIGHT: Record<SearchKey, number> = {
  file: 8,
  tag: 6,
  line: 4,
  path: 3,
  content: 2,
};

/** `matched` 数组的固定输出顺序（避免 Set 迭代顺序影响可读性）。 */
const CANONICAL_KEYS: SearchKey[] = ["tag", "path", "file", "line", "content"];

function compareText(a: string, b: string): number {
  return a < b ? -1 : a > b ? 1 : 0;
}

/* ------------------------------------------------------------------ 解析 */

/**
 * 把查询串拆成「正向词 + 排除词」。
 *
 * 语法：`tag:#x` / `path:dir` / `file:name` / `line:xxx` / `content:词` / `"短语"` / `-排除`。
 * - 键名大小写不敏感，`tag:` 后的 `#` 会被去掉；
 * - 引号内的空格属于短语；
 * - `-` 必须紧贴词首才算排除（`a - b` 里的 `-` 是普通词，会被忽略）。
 */
export function parseSearchQuery(raw: string): SearchQuery {
  const text = String(raw ?? "");
  const terms: SearchTerm[] = [];
  const negations: SearchTerm[] = [];
  const isSpace = (ch: string): boolean => /\s/.test(ch);
  let i = 0;
  while (i < text.length) {
    while (i < text.length && isSpace(text[i])) i += 1;
    if (i >= text.length) break;

    let negate = false;
    if (text[i] === "-" && i + 1 < text.length && !isSpace(text[i + 1])) {
      negate = true;
      i += 1;
    }

    let key: SearchKey = "content";
    const keyMatch = /^(tag|path|file|line|content):/i.exec(text.slice(i));
    if (keyMatch) {
      key = keyMatch[1].toLowerCase() as SearchKey;
      i += keyMatch[0].length;
    }

    let phrase = false;
    let value = "";
    if (text[i] === '"') {
      phrase = true;
      i += 1;
      const end = text.indexOf('"', i);
      if (end < 0) {
        value = text.slice(i);
        i = text.length;
      } else {
        value = text.slice(i, end);
        i = end + 1;
      }
    } else {
      const start = i;
      while (i < text.length && !isSpace(text[i])) i += 1;
      value = text.slice(start, i);
    }

    value = value.trim();
    if (key === "tag") value = value.replace(/^#+/, "").trim();
    if (!value) continue;
    if (key === "content" && /^-+$/.test(value)) continue; // 孤立的 - 不是词
    (negate ? negations : terms).push({ key, value, phrase });
  }
  return { raw: text, terms, negations };
}

/* ------------------------------------------------------------------ 匹配 */

interface TermMatch {
  /** 0–1 的匹配强度（整词 1、CJK 覆盖率命中 0.6–1）。 */
  strength: number;
  /** 1 基命中行（标签/路径/文件名这类过滤键没有行）。 */
  line?: number;
  snippet?: string;
}

/** 压成单行的片段：命中点前后各留一点上下文。 */
function snippetAround(text: string, needle?: string): string {
  const flat = text.replace(/\s+/g, " ").trim();
  if (!flat) return "";
  const lower = flat.toLowerCase();
  const at = needle ? lower.indexOf(needle.toLowerCase()) : -1;
  const start = at > 60 ? at - 40 : 0;
  let out = flat.slice(start, start + 140);
  if (start > 0) out = `…${out}`;
  if (start + 140 < flat.length) out = `${out}…`;
  return out;
}

function average(values: number[]): number {
  if (!values.length) return 0;
  let sum = 0;
  for (const value of values) sum += value;
  return sum / values.length;
}

/** 在正文里匹配一个词；`singleLine` 为 true 时要求所有分词落在**同一行**（`line:` 语义）。 */
function matchInBody(
  page: PageInfo,
  term: SearchTerm,
  singleLine: boolean,
  lineOffset: number,
): TermMatch | null {
  const lines = page.body.split("\n");
  const lineNumber = (index: number): number => index + 1 + lineOffset;

  if (term.phrase) {
    const needle = term.value.toLowerCase();
    if (singleLine) {
      for (let i = 0; i < lines.length; i += 1) {
        if (lines[i].toLowerCase().includes(needle)) {
          return { strength: 1, line: lineNumber(i), snippet: snippetAround(lines[i], needle) };
        }
      }
      return null;
    }
    if (!page.body.toLowerCase().includes(needle)) return null;
    for (let i = 0; i < lines.length; i += 1) {
      if (lines[i].toLowerCase().includes(needle)) {
        return { strength: 1, line: lineNumber(i), snippet: snippetAround(lines[i], needle) };
      }
    }
    // 短语跨行命中：行号退到首行
    return { strength: 1, line: lineNumber(0), snippet: snippetAround(lines[0] ?? "", needle) };
  }

  const tokens = tokenizeQuery(term.value);
  if (!tokens.length) return null;

  if (singleLine) {
    for (let i = 0; i < lines.length; i += 1) {
      const lineLower = lines[i].toLowerCase();
      const strengths = tokens.map((token) => matchTerm(token, lineLower));
      if (strengths.every((value) => value > 0)) {
        return {
          strength: average(strengths),
          line: lineNumber(i),
          snippet: snippetAround(lines[i], tokens[0].text),
        };
      }
    }
    return null;
  }

  const bodyLower = page.body.toLowerCase();
  const strengths = tokens.map((token) => matchTerm(token, bodyLower));
  if (strengths.some((value) => value === 0)) return null;

  // 命中行：分词强度之和最大的第一行（确定性 tie-break：行号小者优先）
  let bestLine = 0;
  let bestSum = -1;
  let bestText = "";
  for (let i = 0; i < lines.length; i += 1) {
    const lineLower = lines[i].toLowerCase();
    let sum = 0;
    for (const token of tokens) sum += matchTerm(token, lineLower);
    if (sum > bestSum) {
      bestSum = sum;
      bestLine = i + 1;
      bestText = lines[i];
    }
  }
  if (bestSum <= 0) {
    // 分词分别命中不同行（覆盖率命中常见）：退到第一处能看到的匹配单元
    const needle = firstUnitIn(lines, tokens);
    return {
      strength: average(strengths),
      line: needle.line ? needle.line + lineOffset : lineNumber(0),
      snippet: snippetAround(needle.text, tokens[0].text),
    };
  }
  return {
    strength: average(strengths),
    line: bestLine + lineOffset,
    snippet: snippetAround(bestText, tokens[0].text),
  };
}

/** 找第一行含任一匹配单元的行（摘要定位用）。 */
function firstUnitIn(
  lines: string[],
  tokens: QueryTerm[],
): { line: number; text: string } {
  for (let i = 0; i < lines.length; i += 1) {
    const lineLower = lines[i].toLowerCase();
    for (const token of tokens) {
      if (lineLower.includes(token.text)) return { line: i + 1, text: lines[i] };
      for (const unit of token.units) {
        if (lineLower.includes(unit)) return { line: i + 1, text: lines[i] };
      }
    }
  }
  return { line: 0, text: lines.find((line) => line.trim()) ?? "" };
}

/**
 * 标签匹配：Obsidian 语义的**层级前缀**匹配。
 *
 * `tag:#构建` 命中 `构建` 与 `构建/知识库`；`tag:#构建/知识库` 命中它自己与更深层
 * `构建/知识库/x`。匹配按小写、以 `/` 为边界，**不做字符串中间匹配**
 * （`构建x`、`构建-x` 都不命中）。为什么改：原先按「精确相等」实现，
 * 与 Obsidian 的 tag: 语义不一致，用户按顶层标签过滤会漏掉所有子标签页面。
 */
function tagMatches(pageTag: string, needle: string): boolean {
  const tag = pageTag.trim().toLowerCase();
  const want = needle.trim().toLowerCase().replace(/\/+$/, "");
  if (!tag || !want) return false;
  return tag === want || tag.startsWith(`${want}/`);
}

/** 页面级匹配：按词的类型走不同索引。 */
function matchTermOnPage(page: PageInfo, term: SearchTerm, lineOffset: number): TermMatch | null {
  switch (term.key) {
    case "tag": {
      const hit = page.tags.some((tag) => tagMatches(tag, term.value));
      return hit ? { strength: 1 } : null;
    }
    case "path": {
      return page.rel.toLowerCase().includes(term.value.toLowerCase()) ? { strength: 1 } : null;
    }
    case "file": {
      return page.title.toLowerCase().includes(term.value.toLowerCase())
        ? { strength: 1 }
        : null;
    }
    case "line":
      return matchInBody(page, term, true, lineOffset);
    case "content":
    default:
      return matchInBody(page, term, false, lineOffset);
  }
}

function clampLimit(limit: unknown): number {
  const value =
    typeof limit === "number" && Number.isFinite(limit) ? Math.floor(limit) : SEARCH_MAX;
  return Math.min(SEARCH_MAX, Math.max(1, value));
}

/* ------------------------------------------------------------------ 执行 */

/** `runSearch` 选项。 */
export interface RunSearchOptions {
  /** 最多返回几条（默认 200，硬上限 200）。 */
  limit?: number;
  /**
   * 页面 rel → frontmatter 占用的行数。
   *
   * `PageInfo.body` 不含 frontmatter，而 `SearchHit.line` 要能直接拿去编辑器跳转，
   * 所以由持有文档原文的调用方（store）把偏移传进来；缺省按 body 行号（0 偏移）。
   */
  lineOffsetOf?: (rel: string) => number;
}

/**
 * 执行搜索。
 *
 * 正向词之间是 AND；任一排除词命中就整页丢弃；只给排除词时返回空数组
 * （没有正向条件等于「全库」，对界面没有意义）。结果按得分降序、rel 升序稳定排序。
 */
export function runSearch(
  index: VaultIndex | null,
  query: SearchQuery | string,
  options: RunSearchOptions = {},
): SearchHit[] {
  if (!index) return [];
  const parsed = typeof query === "string" ? parseSearchQuery(query) : query;
  if (!parsed.terms.length) return [];

  const pages = [...index.pages.values()].sort((a, b) => compareText(a.rel, b.rel));
  const hits: SearchHit[] = [];
  for (const page of pages) {
    const lineOffset = options.lineOffsetOf?.(page.rel) ?? 0;
    const matched = new Set<SearchKey>();
    let score = 0;
    let line = 0;
    let snippet = "";
    let allMatched = true;
    for (const term of parsed.terms) {
      const result = matchTermOnPage(page, term, lineOffset);
      if (!result) {
        allMatched = false;
        break;
      }
      matched.add(term.key);
      score += KEY_WEIGHT[term.key] * result.strength + (term.phrase ? 2 : 0);
      if (!line && result.line) {
        line = result.line;
        snippet = result.snippet ?? "";
      }
    }
    if (!allMatched) continue;
    if (parsed.negations.some((term) => matchTermOnPage(page, term, lineOffset) !== null)) {
      continue;
    }
    if (!line) {
      // 纯过滤命中（tag:/path:/file:）：片段给正文首行，方便列表里扫一眼
      line = 1 + lineOffset;
      snippet = snippetAround(page.body.split("\n").find((text) => text.trim()) ?? "");
    }
    hits.push({
      rel: page.rel,
      line,
      snippet,
      score,
      matched: CANONICAL_KEYS.filter((key) => matched.has(key)),
    });
  }

  hits.sort((a, b) => b.score - a.score || compareText(a.rel, b.rel) || a.line - b.line);
  return hits.slice(0, clampLimit(options.limit));
}
