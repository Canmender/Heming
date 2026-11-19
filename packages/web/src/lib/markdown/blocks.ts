/**
 * 流式 markdown 的分块（d.353，对齐 DSH 的「冻结前缀 + 只重解析尾部」）。
 *
 * 为什么要切：`react-markdown` 每次都把整段正文重新解析成 AST。流式时每帧文本
 * 都变，于是一篇两千字的回答每帧都要重解析两千字——越到后面越卡。DSH 的做法
 * 是把已经写完的部分「冻结」，每帧只解析最后两块。
 *
 * 切分规则刻意保守：只在**空行**处切，且不切开以下三种会跨空行延续的结构——
 * 列表（两个列表项之间是空行也算同一张列表）、表格（连续以 `|` 开头的行）、
 * 以及缩进 2 格以上的续行。切错最多是「本可以少解析一点」，绝不能把一张列表
 * 拆成两张、把表格拆成两个表。
 *
 * 尾部两块（`keepUnstable = 2`）永远不冻结：最后一块正在增长，倒数第二块可能
 * 还会被后面的行改写（例如表格末行、列表末项）。围栏代码块没有闭合时，从围栏
 * 开始的那一块起全部算尾部——半截代码块每帧都要重解析，不能冻结成成品。
 */

export interface MarkdownBlocks {
  /** 已写完、可以冻结的前缀（含结尾空行）。 */
  stable: string;
  /** 仍在增长、每帧都要重解析的尾部。 */
  tail: string;
}

const FENCE = /^\s{0,3}(`{3,}|~{3,})/;
const LIST = /^\s{0,3}(?:[-*+]|\d{1,9}[.)])\s+/;
const TABLE_ROW = /^\s{0,3}\|/;
const INDENTED = /^\s{2,}\S/;

/** 这一行是不是「延续上一块」的行——是的话不要在它前面切。 */
function continuesBlock(line: string): boolean {
  return LIST.test(line) || TABLE_ROW.test(line) || INDENTED.test(line);
}

/**
 * 把正文切成「冻结前缀 + 尾部」。
 *
 * @param text 当前完整正文
 * @param keepUnstable 尾部保留几块（默认 2，与 DSH 的 `UNSTABLE_TAIL_BLOCKS` 一致）
 */
export function splitMarkdownBlocks(text: string, keepUnstable = 2): MarkdownBlocks {
  if (!text) return { stable: "", tail: "" };
  const lines = text.split("\n");
  /** 每个块起始行的行号（第一个块从 0 开始）。 */
  const starts: number[] = [0];
  let fence: string | null = null;
  /** 当前块的开围栏行号（围栏未闭合时，从这里起都不能冻结）。 */
  let openFenceStart = -1;

  for (let i = 0; i < lines.length; i += 1) {
    const line = lines[i] ?? "";
    const fenceMatch = FENCE.exec(line);
    if (fenceMatch) {
      const marker = fenceMatch[1] ?? "";
      if (fence === null) {
        fence = marker;
        openFenceStart = starts[starts.length - 1] ?? 0;
      } else if (
        // 只有同种字符、且长度不短于开围栏的闭围栏才算闭合
        marker[0] === fence[0] &&
        marker.length >= fence.length
      ) {
        fence = null;
        openFenceStart = -1;
      }
      continue;
    }
    if (fence !== null) continue;
    if (i === 0 || line.trim() !== "") continue;
    // 空行：看下一个非空行是否延续结构；延续就不切。
    let next = i + 1;
    while (next < lines.length && (lines[next] ?? "").trim() === "") next += 1;
    if (next >= lines.length) continue; // 文末空行：没有下一块可切
    const nextLine = lines[next] ?? "";
    if (continuesBlock(nextLine)) continue;
    starts.push(i + 1);
  }

  // 尾部起点：最后 keepUnstable 块的开始行；围栏未闭合时更早。
  let unstableStart = Math.max(0, starts.length - Math.max(1, keepUnstable));
  if (fence !== null && openFenceStart >= 0) {
    const fenceBlock = starts.filter((start) => start <= openFenceStart).length - 1;
    unstableStart = Math.min(unstableStart, Math.max(0, fenceBlock));
  }
  const cutLine = starts[unstableStart] ?? 0;
  if (unstableStart === 0) return { stable: "", tail: text };
  const cut = lines.slice(0, cutLine).join("\n").length + (cutLine > 0 ? 1 : 0);
  return { stable: text.slice(0, cut), tail: text.slice(cut) };
}
