/**
 * 本轮「引用工作区文件」的读取与注入（d.175）。
 *
 * ## 为什么
 *
 * 到 d.174，模型已经能自己 `file_read`，但用户想「就针对这几个文件回答」时，只能靠描述
 * 文件名让模型去猜路径——猜错一次就是一轮工具调用，猜对也要多花一轮。Claude Code / opencode
 * 都有 `@文件` 的做法：用户点选或打出来，内容随这一轮一起给模型。
 *
 * ## 口径
 *
 * - **引用是「这一轮的输入」，不是「授权」**：能读的文件仍然必须是根内可读的；引用一个
 *   根外路径会被丢掉并如实写进「读不到」清单，绝不越权去读。
 * - **有上限**：单文件 6000 字、合计 12000 字、最多 3 个。超了截断并明说「只给了前 N 字，
 *   其余用 file_read 读」——静默截断会让模型以为已经看全。
 * - **读不到要说出来**：文件被删、是二进制、太大，都要在段落里留一行「这几个没读到，
 *   别假装看过；需要就用 file_read 再取一次」。沉默会让模型凭文件名编内容。
 * - **失败不阻断**：桥不在（浏览器端）、一个都读不到 → 段落为空，这一轮照常发。
 */

import type { FileFsBridge } from "./bridge.js";
import { compareKey, isInsideRoot, relFromRoot, toPosixPath } from "./paths.js";
import type { FileRoot } from "./paths.js";

/** 一轮最多引用几个文件。 */
export const MAX_FILE_REFS = 3;

/** 单个引用文件的字数上限。 */
export const MAX_FILE_REF_CHARS = 6000;

/** 一轮引用内容的总字数上限。 */
export const MAX_FILE_REFS_TOTAL_CHARS = 12000;

/** 段落标题。 */
export const FILE_REFS_HEADING = "## 本轮引用的文件";

export interface FileRefEntry {
  /** 展示用的相对路径（正斜杠）。 */
  rel: string;
  /** 绝对路径（正斜杠），`file_read` 认这个形状。 */
  path: string;
  text: string;
  truncated: boolean;
}

export interface CollectedFileRefs {
  files: FileRefEntry[];
  /** 读不到的文件（展示用相对路径或原样路径）。 */
  missing: string[];
  /** 拼好的注入段；一个都没读到时为空串。 */
  section: string;
}

const EMPTY: CollectedFileRefs = { files: [], missing: [], section: "" };

/** 找到包含该绝对路径的根，返回展示用相对路径。 */
function locate(roots: readonly FileRoot[], absPath: string): { root: FileRoot; rel: string } | null {
  const abs = toPosixPath(absPath).replace(/\/+$/, "");
  if (!abs) return null;
  for (const root of roots) {
    const rootAbs = toPosixPath(root.path).replace(/\/+$/, "");
    if (!rootAbs) continue;
    const rel = relFromRoot(rootAbs, abs);
    if (rel !== null) return { root, rel };
  }
  return null;
}

/**
 * 读用户这一轮点选的文件，拼成注入段。
 *
 * 顺序即用户选中顺序；超出总数上限的条目直接丢弃（UI 已限制，这里是兜底）。
 */
export async function collectFileRefs(input: {
  bridge: FileFsBridge | null;
  roots: readonly FileRoot[];
  paths: readonly string[];
}): Promise<CollectedFileRefs> {
  const { bridge } = input;
  const wanted = input.paths.map((p) => toPosixPath(p)).filter(Boolean).slice(0, MAX_FILE_REFS);
  if (!bridge || wanted.length === 0 || input.roots.length === 0) return EMPTY;

  const files: FileRefEntry[] = [];
  const missing: string[] = [];
  let used = 0;

  for (const abs of wanted) {
    const located = locate(input.roots, abs);
    if (!located) {
      // 根外路径：不当成错误抛出去，但要如实记一笔（可能是用户换过根）。
      missing.push(abs);
      continue;
    }
    let raw: string | null = null;
    try {
      const res = await bridge.read({ roots: [...input.roots], path: abs });
      if (res.ok && typeof res.content === "string") raw = res.content;
    } catch {
      raw = null;
    }
    if (raw === null) {
      missing.push(located.rel);
      continue;
    }
    const text = raw.replace(/^\uFEFF/, "").replace(/\r\n/g, "\n").trim();
    if (!text) {
      missing.push(located.rel); // 空文件没有可读内容，按「读不到」处理更诚实
      continue;
    }
    const truncated = text.length > MAX_FILE_REF_CHARS;
    const clipped = truncated ? text.slice(0, MAX_FILE_REF_CHARS).trimEnd() : text;
    if (used + clipped.length > MAX_FILE_REFS_TOTAL_CHARS) {
      missing.push(located.rel); // 总量不够了：不进正文，但要在末尾说出来
      continue;
    }
    used += clipped.length;
    files.push({ rel: located.rel, path: abs, text: clipped, truncated });
  }

  if (files.length === 0 && missing.length === 0) return EMPTY;

  const lines: string[] = [FILE_REFS_HEADING, "", "用户这一轮指定了这些文件，内容如下（不用再 file_read 取一遍；要改还是走正常写入流程）。"];
  for (const file of files) {
    lines.push("", `### ${file.rel}`, "", file.text);
    if (file.truncated) {
      lines.push("", `（内容太长，只给了前 ${MAX_FILE_REF_CHARS} 字；需要后面的部分请用 \`file_read\` 读 \`${file.rel}\`。）`);
    }
  }
  if (missing.length > 0) {
    lines.push(
      "",
      `（这些引用没读到：${missing.map((m) => `\`${m}\``).join("、")}——不要凭文件名猜内容，需要就用 \`file_read\` 取，取不到就告诉用户。）`,
    );
  }

  return { files, missing, section: lines.join("\n") };
}
