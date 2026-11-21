/**
 * 工具结果在界面上的预览（d.234）。
 *
 * 为什么需要：`file_read` 读一个几千行的文件、`run_command` 跑构建、`tool_output_read`
 * 分段读大输出，结果动辄几万到几十万字。以前展开区把这些字一股脑塞进 `<pre>`：
 * 一行 DOM、几万个文本节点，页面卡得滚不动，而且真正有用的部分（开头的错误码、
 * 结尾的失败原因）被中间那一大片淹掉。
 *
 * 口径三条：
 * 1. **先给头再给尾**：契约行与错误码都在开头，日志的结论在结尾，中间最长。
 * 2. **不假装完整**：截了就明写「还有 N 字未显示」，给一个「展开全部」的按钮。
 * 3. **纯函数**：只决定「给哪一段」，看不看全部由组件自己的状态决定。
 */

/** 折叠时保留的开头行数（契约行、错误码、前几行输出都在这一块）。 */
export const TOOL_RESULT_HEAD_LINES = 40;

/** 折叠时保留的结尾行数（构建/测试的结论通常在最后几行）。 */
export const TOOL_RESULT_TAIL_LINES = 12;

/** 总长度没超过这个数就原样给（不值得为几百字做折叠）。 */
export const TOOL_RESULT_PREVIEW_MIN_CHARS = 2_000;

export interface ToolResultPreview {
  /** 准备渲染的文字（未截断时与入参逐字相同）。 */
  preview: string;
  /** 被藏起来的字符数；0 表示没截。 */
  hiddenChars: number;
  /** 是否发生了截断。 */
  truncated: boolean;
}

const EMPTY: ToolResultPreview = { preview: "", hiddenChars: 0, truncated: false };

function splitLines(text: string): string[] {
  return text.split("\n");
}

/**
 * 把一段工具结果压成「开头 N 行 + 省略说明 + 结尾 M 行」。
 *
 * 短文本（≤ `TOOL_RESULT_PREVIEW_MIN_CHARS` 字）原样返回——折叠一次反而让人多按一下。
 */
export function previewToolResult(
  result: string | null | undefined,
  options: {
    headLines?: number;
    tailLines?: number;
    minChars?: number;
  } = {}
): ToolResultPreview {
  if (typeof result !== "string" || result.length === 0) return EMPTY;
  const headLines = Math.max(1, options.headLines ?? TOOL_RESULT_HEAD_LINES);
  const tailLines = Math.max(0, options.tailLines ?? TOOL_RESULT_TAIL_LINES);
  const minChars = Math.max(0, options.minChars ?? TOOL_RESULT_PREVIEW_MIN_CHARS);
  if (result.length <= minChars) return { preview: result, hiddenChars: 0, truncated: false };

  const lines = splitLines(result);
  // 行数不多但单行极长（压缩成一行的 JSON、base64、没有换行的日志）：
  // 行数判据在这里失效，退化成按字符截。
  if (lines.length <= headLines + tailLines) {
    const keep = Math.max(1, Math.floor(minChars / 2));
    let head = result.slice(0, keep);
    let tail = result.slice(-keep);
    // slice 按 UTF-16 码元切，切点可能正好落在 emoji/扩展汉字的代理对中间，
    // 劈出落单代理（渲染/回灌模型都会变乱码方块）。与 shell/tool.ts 的 clip 同口径：
    // head 末尾是被劈开的高位代理就退一格，tail 开头是被劈开的低位代理就丢一格。
    // 只在确属被劈开的配对时退，文本本身落单的异常字符不动；hiddenChars 仍按码元计。
    const headLast = head.charCodeAt(head.length - 1);
    if (headLast >= 0xd800 && headLast <= 0xdbff) {
      const next = result.charCodeAt(keep);
      if (next >= 0xdc00 && next <= 0xdfff) head = head.slice(0, -1);
    }
    const tailFirst = tail.charCodeAt(0);
    if (tailFirst >= 0xdc00 && tailFirst <= 0xdfff) {
      const prev = result.charCodeAt(result.length - keep - 1);
      if (prev >= 0xd800 && prev <= 0xdbff) tail = tail.slice(1);
    }
    const hiddenChars = Math.max(0, result.length - head.length - tail.length);
    if (hiddenChars === 0) return { preview: result, hiddenChars: 0, truncated: false };
    return {
      preview: `${head}\n…（中间还有 ${hiddenChars} 字未显示）…\n${tail}`,
      hiddenChars,
      truncated: true,
    };
  }

  const head = lines.slice(0, headLines);
  const tail = tailLines > 0 ? lines.slice(-tailLines) : [];
  const hiddenLines = lines.length - head.length - tail.length;
  if (hiddenLines <= 0) return { preview: result, hiddenChars: 0, truncated: false };
  // 被藏起来的行 join("\n") 后的真实字符数：每行长度相加，行与行之间各有 1 个换行。
  // 最后一条隐藏行与 tail 之间的换行不属于「被藏起来的内容」（它仍会出现在 preview 里），
  // 所以行数减 1 个换行——旧实现每行都 +1，多算了一个，展示给用户和 hiddenChars 都偏大。
  const hiddenRows = lines.slice(head.length, lines.length - tail.length);
  const hiddenChars = hiddenRows.reduce((sum, line) => sum + line.length, 0) + Math.max(0, hiddenRows.length - 1);
  const middle = `…（中间还有 ${hiddenLines} 行 / ${hiddenChars} 字未显示）…`;
  const preview = [...head, middle, ...tail].join("\n");
  return { preview, hiddenChars, truncated: true };
}
