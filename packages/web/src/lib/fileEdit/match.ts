/**
 * 三级锚点匹配与 hunk 应用（规格 §4）。
 *
 * 为什么不数行号：模型数行号必错（长文件里差一行就整段改错位置），
 * 而「这段原文长这样」是它能可靠复述的东西。
 *
 * 三级顺序（命中即止）：
 * 1. **精确**：逐字相等（含行首尾空白）；
 * 2. **空白归一**：忽略行首尾空白与连续空白的差异；
 * 3. **标点归一**：在第 2 级基础上，把 Unicode 连字符类与 ASCII `-`、弯引号与直引号互认。
 *
 * 第 3 级是必要的：模型输出的 `-` 与文件里的 `–`（U+2013）不一致，
 * 是「补丁匹配失败」最常见的来源；不做归一化，用户会看到一堆莫名其妙的失败。
 *
 * ★ 归一化只用于**定位**，不用于**写回**：命中后，上下文行一律取文件里的原行，
 *   新增行才取补丁里的文本。否则「空白有差异」的上下文行会被补丁里的写法覆盖，
 *   用户会看到一堆自己没让改的空白变动。
 */

import { hunkOldLines } from "./parse.js";
import type { Hunk, PatchError, PatchLine } from "./types.js";

/** 文件的文本形态：行 + 行尾 + 末尾换行 + BOM，四者都要原样保留。 */
export interface FileText {
  lines: string[];
  /** 原文件行尾；新建文件用 `\n`。 */
  eol: "\n" | "\r\n";
  /** 原文件是否以换行结尾（新增文件恒为 true）。 */
  finalNewline: boolean;
  /** 是否带 UTF-8 BOM（保留，不擅自去掉）。 */
  bom: boolean;
}

/** 把整份文本拆成可逐行操作的结构。 */
export function splitText(text: string): FileText {
  const source = String(text ?? "");
  const bom = source.startsWith("\uFEFF");
  const body = bom ? source.slice(1) : source;
  const eol: "\n" | "\r\n" = body.includes("\r\n") ? "\r\n" : "\n";
  const finalNewline = body.endsWith("\n");
  let lines = body === "" ? [] : body.split(/\r\n|\n/);
  if (finalNewline && lines.length && lines[lines.length - 1] === "") lines.pop();
  return { lines, eol, finalNewline, bom };
}

/** 按原文件的形态拼回整份文本（行尾与 BOM 都不改动）。 */
export function joinText(file: FileText, lines: string[]): string {
  const head = file.bom ? "\uFEFF" : "";
  const tail = file.finalNewline ? file.eol : "";
  return `${head}${lines.join(file.eol)}${tail}`;
}

/** 第 2 级：空白归一（行首尾空白与连续空白差异都忽略）。 */
export function normalizeSpaceLine(line: string): string {
  return line.replace(/\s+/g, " ").trim();
}

/** Unicode 连字符类 → ASCII `-`。 */
const HYPHENS = /[\u2010\u2011\u2012\u2013\u2014\u2015\u2212]/g;
/** 弯单引号 → `'`。 */
const SINGLE_QUOTES = /[\u2018\u2019\u201A\u201B]/g;
/** 弯双引号 → `"`。 */
const DOUBLE_QUOTES = /[\u201C\u201D\u201E\u201F]/g;

/** 第 3 级：空白归一 + 标点归一。 */
export function normalizePunctLine(line: string): string {
  return normalizeSpaceLine(line)
    .replace(HYPHENS, "-")
    .replace(SINGLE_QUOTES, "'")
    .replace(DOUBLE_QUOTES, '"');
}

/** 匹配级别（1 精确 / 2 空白归一 / 3 标点归一）。 */
export type MatchLevel = 1 | 2 | 3;

export interface HunkPosition {
  /** 命中的起始行下标。 */
  start: number;
  level: MatchLevel;
  /** 同一级别下命中多处（已取第一个）。 */
  ambiguous: boolean;
}

/** 生成某一级别的比较函数。 */
function comparatorFor(level: MatchLevel): (a: string, b: string) => boolean {
  if (level === 1) return (a, b) => a === b;
  if (level === 2) return (a, b) => normalizeSpaceLine(a) === normalizeSpaceLine(b);
  return (a, b) => normalizePunctLine(a) === normalizePunctLine(b);
}

/**
 * 在 `lines` 里找 hunk 原文块的落点。
 *
 * @param from 从第几行开始找（多 hunk 时传上一块的结束位置，保证按文件顺序应用）
 * @param atEof 该块必须在文件末尾（`*** End of File`）
 * @returns 命中位置；找不到返回 null
 */
export function findHunk(
  lines: string[],
  hunk: Hunk,
  from = 0,
  atEof = false,
): HunkPosition | null {
  const oldLines = hunkOldLines(hunk);
  const length = oldLines.length;
  const scanFrom = Math.max(0, Math.min(from, lines.length));

  // 整个块没有任何「原文行」：只能在文件末尾追加，或退化成按 `@@` 后面的说明文字定位。
  if (length === 0) {
    if (atEof) return { start: lines.length, level: 1, ambiguous: false };
    if (hunk.header) {
      const headerPos = findHeaderAnchor(lines, hunk.header, scanFrom);
      if (headerPos !== null) return headerPos;
    }
    return null;
  }

  const startLimit = atEof ? lines.length - length : lines.length - length;
  if (startLimit < scanFrom) return null;

  for (let level = 1 as MatchLevel; level <= 3; level = (level + 1) as MatchLevel) {
    const same = comparatorFor(level);
    let first = -1;
    let second = -1;
    for (let i = scanFrom; i <= startLimit; i += 1) {
      let hit = true;
      for (let k = 0; k < length; k += 1) {
        if (!same(lines[i + k], oldLines[k])) {
          hit = false;
          break;
        }
      }
      if (!hit) continue;
      if (atEof && i + length !== lines.length) continue;
      if (first < 0) {
        first = i;
        continue;
      }
      second = i;
      break;
    }
    if (first >= 0) return { start: first, level, ambiguous: second >= 0 };
  }
  return null;
}

/**
 * `@@` 后面那段说明文字的定位（仅当块里没有任何上下文/删除行时使用）。
 *
 * 为什么留这条路：模型常写「`@@ ## 背景` 然后只加几行」表示「在这个标题后面插入」。
 * 没有它，这类补丁只能整单失败；有它，插入语义就变成「锚点行之后」。
 */
function findHeaderAnchor(lines: string[], header: string, from: number): HunkPosition | null {
  const needle = normalizePunctLine(header);
  if (!needle) return null;
  let found = -1;
  for (let i = Math.max(0, from); i < lines.length; i += 1) {
    if (normalizePunctLine(lines[i]) === needle) {
      found = i;
      break;
    }
  }
  // 插入点放在锚点行之后
  return found >= 0 ? { start: found + 1, level: 3, ambiguous: false } : null;
}

/** 一个 hunk 应用失败时的报错文案（规格 §9：说清哪个文件、第几个块、期望的锚点）。 */
function hunkFailure(fileName: string, hunkIndex: number, hunk: Hunk): PatchError {
  const expected = hunkOldLines(hunk)
    .filter((line) => line.trim() !== "")
    .slice(0, 2);
  const where = hunk.header ? `（\`@@ ${hunk.header}\`）` : "";
  return {
    code: "match-failed",
    path: fileName,
    hunkIndex,
    expected,
    message:
      `第 ${hunkIndex} 个 \`@@\` 块${where}在 ${fileName} 里找不到匹配的原文。` +
      (expected.length ? `期望的锚点开头：${expected.map((l) => `「${l}」`).join("、")}。` : "") +
      "请先用 file_read 读这段原文，再按读到的内容重写锚点行；整份补丁未写入任何文件。",
  };
}

/**
 * 依次应用若干 hunk（原子：任一失败整份内容不返回）。
 *
 * @param text 原文件内容
 * @param hunks 变更块
 * @param fileName 报错里用的文件名（相对路径）
 */
export function applyHunks(
  text: string,
  hunks: Hunk[],
  fileName = "该文件",
): { ok: true; text: string; notes: string[] } | { ok: false; error: PatchError } {
  const file = splitText(text);
  const lines = [...file.lines];
  const notes: string[] = [];
  /** 下一块从哪找：按文件顺序，避免后面的块又匹配到前面已改过的地方。 */
  let cursor = 0;

  for (let h = 0; h < hunks.length; h += 1) {
    const hunk = hunks[h];
    const pos = findHunk(lines, hunk, cursor, hunk.atEof);
    if (!pos) return { ok: false, error: hunkFailure(fileName, h + 1, hunk) };
    if (pos.ambiguous) {
      notes.push(
        `${fileName} 的第 ${h + 1} 个 \`@@\` 块在文件里有多处相同原文，已按第一处应用（从第 ${pos.start + 1} 行起）。`,
      );
    }
    if (pos.level > 1) {
      notes.push(
        `${fileName} 的第 ${h + 1} 个 \`@@\` 块按「${pos.level === 2 ? "空白归一" : "标点归一"}」匹配成功。`,
      );
    }

    const oldCount = hunkOldLines(hunk).length;
    /** 新的这一整段：上下文行取文件原文，新增行取补丁文本。 */
    const replacement: string[] = [];
    let consumed = 0;
    for (const line of hunk.lines as PatchLine[]) {
      if (line.kind === "context") {
        replacement.push(lines[pos.start + consumed] ?? line.text);
        consumed += 1;
      } else if (line.kind === "add") {
        replacement.push(line.text);
      } else {
        consumed += 1;
      }
    }
    if (consumed !== oldCount) {
      // 解析器已保证结构正确，这里只是防御：计数对不上就不能动文件。
      return {
        ok: false,
        error: {
          code: "invalid-patch",
          path: fileName,
          hunkIndex: h + 1,
          message: `第 ${h + 1} 个 \`@@\` 块内部计数不一致，已放弃整份补丁。`,
        },
      };
    }

    lines.splice(pos.start, oldCount, ...replacement);
    cursor = pos.start + replacement.length;
  }

  return { ok: true, text: joinText(file, lines), notes };
}

/** 新增文件的内容拼装（行尾统一 `\n`，以换行结尾）。 */
export function buildAddedText(lines: string[]): string {
  return lines.length ? `${lines.join("\n")}\n` : "";
}
