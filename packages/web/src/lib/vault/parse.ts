/**
 * vault 的 markdown 解析层：frontmatter、双链、行内标签、标题。
 *
 * 为什么单独一层：索引（index.ts）、搜索（search.ts）、工具层（tools.ts）都要读同一份
 * markdown，但各自只关心其中一块。把这些纯函数拆出来，解析口径只有一处，
 * 测试也只需要构造 markdown 夹具，不必碰文件系统。
 *
 * 两条硬口径（规格 §3.5）：
 * 1. **代码块与行内代码里的 `[[...]]` / `#tag` / `# 标题` 一律不算**——
 *    这是最容易写错的一处，所以先把代码区域「掩码」成等长空格（保留换行），
 *    再在掩码后的文本上做正则；这样行号与原文完全对齐。
 * 2. 行号一律 **1 基**，且指**原文件**里的行（body 的行号会加上 frontmatter 的偏移）。
 *
 * 全部纯函数：同一份输入永远同一份输出，不读时钟、不读环境。
 */

import type { Heading } from "./types.js";

/** frontmatter 解析结果。 */
export interface ParsedFrontmatter {
  /** 键值；数组值统一成 string[]，标量统一成 string（引号已去掉）。 */
  meta: Record<string, string | string[]>;
  /** 正文（不含 frontmatter 与分隔线）。 */
  body: string;
  /**
   * body 第 1 行在原文里的行号偏移：body 首行的文件行号 = lineOffset + 1。
   * 没有 frontmatter 时为 0。
   */
  lineOffset: number;
}

/** 行号计算的公共选项。 */
export interface LineOptions {
  /** 文本块首行在整份文件里的偏移（frontmatter 占用的行数）。 */
  lineOffset?: number;
}

/** 抽出来的双链（解析结果由 index.ts 补）。 */
export interface ParsedLink {
  target: string;
  alias?: string;
  heading?: string;
  embed: boolean;
  /** 1 基文件行号。 */
  line: number;
}

/** 抽出来的行内标签。 */
export interface ParsedTag {
  tag: string;
  /** 1 基文件行号。 */
  line: number;
}

/* ------------------------------------------------------------------ frontmatter */

/** 去掉首尾成对的引号。 */
function unquote(value: string): string {
  const text = value.trim();
  if (text.length >= 2) {
    const first = text[0];
    const last = text[text.length - 1];
    if ((first === '"' && last === '"') || (first === "'" && last === "'")) {
      return text.slice(1, -1);
    }
  }
  return text;
}

/**
 * 拆 frontmatter。只支持单层 `key: value`、`key: [a, b]`、`key: a, b` 与
 * 「键后换行 + `- item` 列表」四种形态——足够 tags / aliases 用，
 * 刻意不引 YAML 依赖：解析器越弱，出错面越小。
 */
export function parseFrontmatter(raw: string): ParsedFrontmatter {
  const text = String(raw ?? "").replace(/^\uFEFF/, ""); // 去 BOM，否则首行匹配不到 ---
  const match = /^---[ \t]*\r?\n([\s\S]*?)\r?\n---[ \t]*(?:\r?\n|$)/.exec(text);
  if (!match) return { meta: {}, body: text, lineOffset: 0 };

  const meta: Record<string, string | string[]> = {};
  let pendingKey: string | null = null;
  for (const line of match[1].split(/\r?\n/)) {
    // 列表项：`- a` / `- "b"`，只归到上一个键
    const item = /^\s*-\s+(.*)$/.exec(line);
    if (item && pendingKey) {
      const prev = meta[pendingKey];
      const list = Array.isArray(prev) ? prev : [];
      list.push(unquote(item[1]));
      meta[pendingKey] = list;
      continue;
    }
    const kv = /^([A-Za-z_][\w-]*)\s*:\s*(.*)$/.exec(line.trim());
    if (!kv) {
      pendingKey = null;
      continue;
    }
    const [, key, rawValue] = kv;
    const value = rawValue.trim();
    pendingKey = key;
    if (!value) {
      // 可能是「键后换行 + 列表」，先占位成空数组
      meta[key] = [];
      continue;
    }
    if (value.startsWith("[") && value.endsWith("]")) {
      meta[key] = value
        .slice(1, -1)
        .split(",")
        .map((part) => unquote(part))
        .filter(Boolean);
      continue;
    }
    meta[key] = unquote(value);
  }

  // 空数组还原成空串：`title:` 这种空标量不该被当成列表
  for (const key of Object.keys(meta)) {
    const value = meta[key];
    if (Array.isArray(value) && value.length === 0) meta[key] = "";
  }

  const lineOffset = (match[0].match(/\n/g) ?? []).length;
  return { meta, body: text.slice(match[0].length), lineOffset };
}

/** 大小写不敏感地取 frontmatter 的某个键。 */
function metaValue(meta: Record<string, string | string[]>, key: string): string | string[] | undefined {
  const actual = Object.keys(meta).find((candidate) => candidate.toLowerCase() === key);
  return actual === undefined ? undefined : meta[actual];
}

/**
 * 标量拆成多个值：
 * - tags 支持逗号与空白混写（`tags: a, b` / `tags: "#a #b"`）；
 * - aliases 只按逗号拆（别名本身可以带空格，如 `alias: 项目 甲`）。
 */
function splitScalar(value: string, mode: "comma" | "comma-space"): string[] {
  const text = value.trim();
  if (!text) return [];
  const parts = text.split(/[,，]/);
  if (mode === "comma") return parts.map((part) => part.trim()).filter(Boolean);
  return parts
    .flatMap((part) => part.trim().split(/\s+/))
    .map((part) => part.trim())
    .filter(Boolean);
}

/** 从 frontmatter 取列表（去重、保序、大小写不敏感去重）。 */
function readList(
  meta: Record<string, string | string[]>,
  keys: string[],
  mode: "comma" | "comma-space",
): string[] {
  for (const key of keys) {
    const value = metaValue(meta, key);
    if (value === undefined) continue;
    const raw = Array.isArray(value) ? value : splitScalar(value, mode);
    const out: string[] = [];
    const seen = new Set<string>();
    for (const item of raw) {
      const text = unquote(String(item)).trim();
      if (!text) continue;
      const lower = text.toLowerCase();
      if (seen.has(lower)) continue;
      seen.add(lower);
      out.push(text);
    }
    return out;
  }
  return [];
}

/** frontmatter 标签：`tags` 优先，兼容单数 `tag`；支持数组 / 逗号串 / 空格串。 */
export function frontmatterTags(meta: Record<string, string | string[]>): string[] {
  return readList(meta, ["tags", "tag"], "comma-space")
    .map((tag) => tag.replace(/^#+/, "").trim())
    .filter(Boolean);
}

/** frontmatter 别名：`aliases` 优先，兼容单数 `alias`；只按逗号拆。 */
export function frontmatterAliases(meta: Record<string, string | string[]>): string[] {
  return readList(meta, ["aliases", "alias"], "comma");
}

/* ------------------------------------------------------------------ 代码掩码 */

/** 一行变等长空格（保留换行由调用方处理）。 */
function blank(line: string): string {
  return " ".repeat(line.length);
}

/** 掩掉一行里的行内代码（反引号串，闭合串长度必须与开启串一致）。 */
function maskInlineCode(line: string): string {
  if (!line.includes("`")) return line;
  const chars = line.split("");
  let i = 0;
  while (i < line.length) {
    if (line[i] !== "`") {
      i += 1;
      continue;
    }
    let run = 0;
    while (i + run < line.length && line[i + run] === "`") run += 1;
    // 向后找长度**恰好**为 run 的反引号串作为闭合
    let j = i + run;
    let closeAt = -1;
    while (j < line.length) {
      if (line[j] === "`") {
        let closeRun = 0;
        while (j + closeRun < line.length && line[j + closeRun] === "`") closeRun += 1;
        if (closeRun === run) {
          closeAt = j;
          break;
        }
        j += closeRun;
        continue;
      }
      j += 1;
    }
    if (closeAt < 0) {
      // 没有闭合：按 CommonMark，这个反引号串是普通文本
      i += run;
      continue;
    }
    for (let k = i; k < closeAt + run; k += 1) chars[k] = " ";
    i = closeAt + run;
  }
  return chars.join("");
}

/** 行首缩进宽度：空格算 1 列，Tab 对齐到下一个 4 列（CommonMark 的 tab stop）。 */
function indentWidth(line: string): number {
  let width = 0;
  for (const ch of line) {
    if (ch === " ") width += 1;
    else if (ch === "\t") width += 4 - (width % 4);
    else break;
  }
  return width;
}

/** 行首缩进对应的字符数（按列宽切容器缩进用；Tab 在列宽内算一个字符）。 */
function indentChars(line: string, width: number): number {
  let column = 0;
  let index = 0;
  while (index < line.length && column < width) {
    const ch = line[index];
    if (ch === " ") {
      column += 1;
      index += 1;
      continue;
    }
    if (ch === "\t") {
      const next = column + (4 - (column % 4));
      if (next > width) break;
      column = next;
      index += 1;
      continue;
    }
    break;
  }
  return index;
}

/** 列表项上下文：marker 所在列与内容起始列（嵌套列表靠它算「相对缩进」）。 */
interface ListItemContext {
  markerIndent: number;
  contentIndent: number;
}

/** 围栏代码块状态。 */
interface FenceState {
  /** 开启围栏的字符（` 或 ~）。 */
  char: string;
  /** 开启围栏的长度（闭合串不能短于它）。 */
  length: number;
  /** 闭合围栏允许的最大「绝对缩进列」（容器缩进 + 3）。 */
  closeIndent: number;
  /** 开启时的列表内容缩进；>0 表示围栏在列表项里，缩进不足即容器结束。 */
  containerIndent: number;
  /** 开启时的引用深度；引用层级下降表示容器结束。 */
  quoteDepth: number;
}

/**
 * 把代码区域掩码成等长空格（保留换行），供双链/标签/标题在「非代码文本」上匹配。
 *
 * 判据以「与预览层 mdast（CommonMark）一致」为准——索引和阅读视图看到的不一样，
 * 比少支持更糟。覆盖的代码形态：
 * - 围栏代码块：``` 或 ~~~（≥3 个），允许 0–3 空格缩进（相对当前容器）；
 * - **缩进代码块**：相对容器缩进 ≥4 且处于块起点/空行之后（不能打断段落）；
 * - **引用块里的围栏**：`> ``` ` 每行去掉 `>` 前缀后按同样规则判定；
 * - **列表项里的围栏 / 缩进代码块**：按列表内容列计算相对缩进，嵌套列表同理；
 * - 行内代码：成对反引号串（同长度闭合；未闭合按普通文本，见 CommonMark）。
 *
 * 容器结束（引用层级下降、列表项缩进不足）时围栏随之结束，不会越界把后续正文吞掉。
 * 跨行的行内代码不掩（当前按行配对；极少数写法会与围栏判定冲突，第二轮再处理）。
 */
export function maskCode(text: string): string {
  const lines = String(text ?? "").split("\n");
  const out: string[] = [];
  let fence: FenceState | null = null;
  let inIndented = false;
  let prevBlank = true;
  let listStack: ListItemContext[] = [];
  let lastQuoteDepth = 0;

  for (const line of lines) {
    // 1) 去掉 blockquote 前缀（可嵌套：每层前最多 3 空格 + 一个 `>` + 可选空格）。
    //    围栏内容行同样带 `>` 前缀，所以每行都要先剥掉再比较闭合行。
    let prefixChars = 0;
    let quoteDepth = 0;
    for (;;) {
      const marker = /^ {0,3}>[ \t]?/.exec(line.slice(prefixChars));
      if (!marker) break;
      prefixChars += marker[0].length;
      quoteDepth += 1;
    }
    if (quoteDepth !== lastQuoteDepth) {
      // 引用层级变化 = 换了容器，列表栈不跨容器沿用
      listStack = [];
      lastQuoteDepth = quoteDepth;
    }
    const content = line.slice(prefixChars);
    const isBlank = content.trim() === "";

    // 2) 围栏内部：整行掩盖，只判断是否闭合；容器结束时围栏提前结束
    if (fence) {
      if (quoteDepth < fence.quoteDepth) {
        fence = null; // 引用块结束，围栏所属容器已不存在，当前行按普通行处理
      } else if (quoteDepth > fence.quoteDepth) {
        // 引用更深：这行在围栏内容里（`>` 是代码字符），只掩盖、不判闭合
        out.push(blank(line));
        prevBlank = isBlank;
        continue;
      } else if (fence.containerIndent > 0 && !isBlank && indentWidth(content) < fence.containerIndent) {
        fence = null; // 列表项结束，围栏不再吞后续正文
      } else {
        out.push(blank(line));
        if (!isBlank) {
          const close = /^([ \t]*)(`{3,}|~{3,})[ \t]*$/.exec(content);
          if (close) {
            const closes =
              close[2][0] === fence.char &&
              close[2].length >= fence.length &&
              indentWidth(content) <= fence.closeIndent;
            if (closes) fence = null;
          }
        }
        prevBlank = isBlank;
        continue;
      }
    }

    // 3) 缩进代码块内部：相对容器缩进 ≥4 或空行继续
    if (inIndented) {
      if (isBlank || indentWidth(content) >= 4) {
        out.push(blank(line));
        prevBlank = isBlank;
        continue;
      }
      inIndented = false;
    }

    if (isBlank) {
      out.push(line);
      prevBlank = true;
      continue;
    }

    // 4) 列表项：维护内容缩进栈，续行按相对缩进判断代码块
    let containerIndent = 0;
    // `rest` 是「去掉容器前缀后的内容」：列表项行去掉 marker + 其后间距；
    // 普通续行去掉列表内容缩进。围栏/缩进代码块都按 rest 的相对缩进判断。
    let rest = content;
    const listMarker = /^( {0,3})([-+*]|\d{1,9}[.)])([ \t]+|$)/.exec(content);
    if (listMarker) {
      const markerIndent = indentWidth(listMarker[1]);
      // 新的同级/更浅列表项关闭已有项
      while (listStack.length > 0 && listStack[listStack.length - 1].markerIndent >= markerIndent) {
        listStack.pop();
      }
      const gap = listMarker[3] ? listMarker[3].length : 0;
      // CommonMark：标记后 1–4 个空格算内容缩进；没有或过多按 1 个算
      const spacing = gap >= 1 && gap <= 4 ? gap : 1;
      const contentIndent = markerIndent + listMarker[2].length + spacing;
      listStack.push({ markerIndent, contentIndent });
      containerIndent = contentIndent;
      // 列表项行自身：marker 之后的内容（marker 不是空白字符，不能按缩进宽度切）
      rest = content.slice(listMarker[0].length);
    } else if (listStack.length > 0) {
      const top = listStack[listStack.length - 1];
      const indent = indentWidth(content);
      containerIndent = indent >= top.contentIndent ? top.contentIndent : 0;
      // 行首比当前项的 marker 还靠左：当前列表项结束（惰性续行不在这里处理，后面也不判代码块）
      if (containerIndent === 0 && indent < top.markerIndent) listStack.pop();
      if (containerIndent > 0) rest = content.slice(indentChars(content, containerIndent));
    }

    const opener = /^( {0,3})(`{3,}|~{3,})(.*)$/.exec(rest);
    if (opener && !(opener[2][0] === "`" && opener[3].includes("`"))) {
      fence = {
        char: opener[2][0],
        length: opener[2].length,
        // 闭合围栏可相对容器再缩进最多 3 列（CommonMark），与开启行自身缩进无关
        closeIndent: containerIndent + 3,
        containerIndent,
        quoteDepth,
      };
      out.push(blank(line));
      prevBlank = false;
      continue;
    }

    // 5) 缩进代码块：只能从块起点/空行后开始，避免把段落里的缩进行误判成代码
    if (indentWidth(rest) >= 4 && prevBlank) {
      inIndented = true;
      out.push(blank(line));
      prevBlank = true;
      continue;
    }

    out.push(maskInlineCode(line));
    prevBlank = false;
  }
  return out.join("\n");
}

/* ------------------------------------------------------------------ 通用小工具 */

/** 位置所在的 1 基行号。 */
function lineAt(text: string, index: number): number {
  let line = 1;
  for (let i = 0; i < index && i < text.length; i += 1) {
    if (text[i] === "\n") line += 1;
  }
  return line;
}

/** 该位置是否被反斜杠转义（奇数个 \ 才算转义）。 */
function isEscaped(text: string, index: number): boolean {
  let count = 0;
  let i = index - 1;
  while (i >= 0 && text[i] === "\\") {
    count += 1;
    i -= 1;
  }
  return count % 2 === 1;
}

/* ------------------------------------------------------------------ 双链 */

/**
 * 抽 `[[a]]` / `[[a|别名]]` / `[[a#标题]]` / `![[a]]`。
 *
 * - 代码块与行内代码里的一律不算（规格 §3.5）；
 * - `[[目标|显示]]` 只按**第一个** `|` 拆（别名里可以有 `|`）；
 * - `[[a#标题]]` 拆成 target + heading（标题是否存在由 index.ts 判定）；
 * - `!` 前缀记为嵌入；被 `\` 转义的 `\[[...]]` 不算。
 */
export function extractLinks(text: string, opts: LineOptions = {}): ParsedLink[] {
  const source = String(text ?? "");
  const masked = maskCode(source);
  const offset = opts.lineOffset ?? 0;
  const out: ParsedLink[] = [];
  const re = /(!?)\[\[([^[\]\n]+?)\]\]/g;
  let match: RegExpExecArray | null;
  while ((match = re.exec(masked)) !== null) {
    const at = match.index;
    if (isEscaped(masked, at)) continue;
    const embed = match[1] === "!";
    const inner = match[2];
    const pipe = inner.indexOf("|");
    const left = (pipe < 0 ? inner : inner.slice(0, pipe)).trim();
    const aliasRaw = pipe < 0 ? "" : inner.slice(pipe + 1).trim();
    if (!left) continue;
    const hash = left.indexOf("#");
    const target = (hash < 0 ? left : left.slice(0, hash)).trim();
    const heading = hash < 0 ? "" : left.slice(hash + 1).trim();
    if (!target) continue;
    const link: ParsedLink = {
      target,
      embed,
      line: lineAt(masked, at) + offset,
    };
    if (aliasRaw) link.alias = aliasRaw;
    if (heading) link.heading = heading;
    out.push(link);
  }
  return out;
}

/* ------------------------------------------------------------------ 行内标签 */

/** 标签内容允许的字符：字母（含 CJK）、数字、下划线、连字符、斜杠。 */
const TAG_CHARS = /[\p{L}\p{N}_/-]+/gu;

/** 纯数字（含用 - 或 / 分隔的数字）不算标签：`#123`、`#2024-11`。 */
function isNumericTag(tag: string): boolean {
  return /^[\d/-]+$/.test(tag);
}

/**
 * 抽行内标签 `#tag` / `#a/b`。
 *
 * 排除（规格 §3 与任务口径）：
 * - `#` 后是空格或行尾（不是标签，标题符号也不匹配）；
 * - 纯数字（`#123`）；
 * - URL 片段（`https://x/#section`，`#` 紧跟在字母/数字/`/`/`.`/`-` 之后）；
 * - 代码块与行内代码里的；
 * - HTML 实体（`&#39;`）与 `\#` 转义。
 *
 * 大小写保留原文，去重交给索引层（比较时用 lower）。
 */
export function extractInlineTags(text: string, opts: LineOptions = {}): ParsedTag[] {
  const source = String(text ?? "");
  const masked = maskCode(source);
  const offset = opts.lineOffset ?? 0;
  const out: ParsedTag[] = [];
  const re = /(^|[^\p{L}\p{N}_&/#\\.-])#([\p{L}\p{N}_/-]+)/gu;
  let match: RegExpExecArray | null;
  while ((match = re.exec(masked)) !== null) {
    const hashIndex = match.index + match[1].length;
    if (isEscaped(masked, hashIndex)) continue;
    const raw = match[2];
    const tag = raw.replace(/[/-]+$/, "").trim();
    if (!tag) continue;
    if (isNumericTag(tag)) continue;
    out.push({ tag, line: lineAt(masked, hashIndex) + offset });
  }
  return out;
}

/* ------------------------------------------------------------------ 标题 */

/**
 * 抽 ATX 标题（`#`…`######` + 空格 + 文本）。
 *
 * 跳过围栏代码块内的行；标题文本取**原文**（行内代码里的反引号会原样保留），
 * 去掉首尾空白与结尾的 `#` 串（CommonMark 的闭合式写法）。
 */
export function extractHeadings(text: string, opts: LineOptions = {}): Heading[] {
  const source = String(text ?? "");
  const masked = maskCode(source);
  const original = source.split("\n");
  const maskedLines = masked.split("\n");
  const offset = opts.lineOffset ?? 0;
  const out: Heading[] = [];
  for (let i = 0; i < original.length; i += 1) {
    // 代码块整行被掩成空格，trim 后为空，自然跳过
    if (!maskedLines[i].trim()) continue;
    const match = /^\s{0,3}(#{1,6})(?:\s+(.*?))?\s*$/.exec(original[i]);
    if (!match) continue;
    const textRaw = (match[2] ?? "").replace(/(?:^|\s)#+\s*$/, "").trim();
    if (!textRaw) continue;
    out.push({ level: match[1].length, text: textRaw, line: i + 1 + offset });
  }
  return out;
}
