/**
 * 从 stdin 读 prompt（`heming exec -` 这种用法）。
 *
 * 为什么值得单独一个模块：CI 里最常用的形态是 `git diff | heming exec -`、
 * `cat failures.log | heming run -` —— 把上一步的输出直接喂给智能体。它有两个坑必须在这里
 * 收掉：①没有上限时一个 `cat /dev/urandom` 就能把内存吃满；②读失败/超限必须给一句人话，
 * 而不是让用户看着进程卡住。
 *
 * 这个函数只做「读 + 立上限」，不做 trim（是否为空由调用方按自己的语义判断：
 * 空 prompt 是用法错误，全空白也算空）。
 */

/** 单次 stdin 读取的上限：1MB 足够放下几万行日志/一个补丁，又不至于把内存吃满。 */
export const STDIN_LIMIT_BYTES = 1_000_000;

export type StdinReadResult = { ok: true; text: string } | { ok: false; error: string };

/** 读 Readable 的全部内容（默认 `process.stdin`）。超限立即停止并报错。 */
export async function readPromptFromStdin(
  stream: NodeJS.ReadableStream = process.stdin,
  limit = STDIN_LIMIT_BYTES,
): Promise<StdinReadResult> {
  const chunks: Buffer[] = [];
  let bytes = 0;
  try {
    for await (const chunk of stream) {
      const buf = Buffer.isBuffer(chunk) ? chunk : Buffer.from(String(chunk), "utf8");
      bytes += buf.length;
      if (bytes > limit) {
        return {
          ok: false,
          error: `从 stdin 读到的内容超过 ${limit} 字节上限（prompt 本该是一段指令，而不是整份大文件）；请改用 --cwd 让智能体自己读文件`,
        };
      }
      chunks.push(buf);
    }
  } catch (error) {
    return { ok: false, error: `读取 stdin 失败：${error instanceof Error ? error.message : String(error)}` };
  }
  const text = Buffer.concat(chunks).toString("utf8");
  // 有些平台会塞 BOM，会让第一个词变成「\uFEFF请…」——strip 掉再交给调用方。
  return { ok: true, text: text.charCodeAt(0) === 0xfeff ? text.slice(1) : text };
}
