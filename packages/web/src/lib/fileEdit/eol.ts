/**
 * 换行风格：让改动跟着文件走，而不是把整个文件改成模型顺手敲的那种换行。
 *
 * 为什么需要（d.233）：
 * - 模型输出的文本几乎总是 `\n`，而 Windows 上的源码/文档多是 `\r\n`；
 * - `file_edit` 把 `\n` 片段塞进 `\r\n` 文件，会得到**混合行尾**：编辑器报警、diff 变脏、
 *   后续每改一次就更乱；
 * - `file_write` 整份覆盖时如果不看原文件风格，会把 5000 行文件的行尾全改掉——内容只改了 3 处，
 *   diff 却是整篇删除加整篇新增，评审的人根本看不出真正改了什么。
 *
 * 口径：**只跟随、不发明**。原文件风格明确（纯 LF 或纯 CRLF）时才对齐；混合行尾或新建文件
 * 一律保持模型给的原文（没有可跟随的事实，就不擅自格式化）。
 */

/** 探测文本的换行风格；混合或没有换行时返回 null（没有任何风格可跟随）。 */
export function detectNewlineStyle(text: string): "\n" | "\r\n" | null {
  if (typeof text !== "string" || text === "") return null;
  const crlf = (text.match(/\r\n/g) || []).length;
  if (crlf === 0) return text.includes("\n") ? "\n" : null;
  // 剩下的裸 \n 数量 = 总 \n 数 - CRLF 数；为 0 才是纯 CRLF
  const lf = (text.match(/\n/g) || []).length;
  if (lf === crlf) return "\r\n";
  return null;
}

/**
 * 把待插入文本的换行对齐到 `style`。
 *
 * @returns `{ text, converted }`——`converted` 只在真的改动过换行时为 true，
 *   调用方据此告诉用户「文件是 CRLF，已经按它写」，而不是悄悄动格式。
 */
export function adaptNewlines(
  text: string,
  style: "\n" | "\r\n" | null,
): { text: string; converted: boolean } {
  if (typeof text !== "string" || text === "" || style === null) return { text, converted: false };
  // 先收敛成 LF（先把 \r\n 收掉，再处理孤立的 \r），再统一出口，避免 \r\r\n 这种叠加
  const lf = text.replace(/\r\n/g, "\n").replace(/\r/g, "\n");
  const next = style === "\r\n" ? lf.replace(/\n/g, "\r\n") : lf;
  return { text: next, converted: next !== text };
}
