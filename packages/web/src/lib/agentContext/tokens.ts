import type { ChatMessage } from "./types.js";

/**
 * Token 估算（设计 §3.1）：零依赖、CJK 感知，为「预算」服务——宁可高估不可低估。
 * 口径：CJK 及其标点 1 token/字；ASCII 连续段每 4 字符 1 token（向上取整）；
 * 其余（西里尔、emoji 等）2 字符 1 token。每条消息另加 4 token 结构开销。
 */

/** 单条消息的结构开销（role 字段、分隔符等），与内容一起计入预算。 */
export const ROW_TOKEN_OVERHEAD = 4;

/**
 * 是否按「一字一 token」计（CJK 及日韩文字、CJK 标点、全角符号）。
 * 覆盖：谚文字母/音节、CJK 部首与符号、假名与注音、CJK 扩展 A/基本区/兼容区、
 * 全角形式，以及扩展 B 及以上的补充平面（代理对，按码点判断）。
 */
function isWideCodePoint(cp: number): boolean {
  return (
    (cp >= 0x1100 && cp <= 0x115f) || // 谚文字母
    (cp >= 0x2e80 && cp <= 0x303f) || // CJK 部首/符号/标点（含「【】」等）
    (cp >= 0x3041 && cp <= 0x33ff) || // 假名、注音、CJK 兼容
    (cp >= 0x3400 && cp <= 0x4dbf) || // CJK 扩展 A
    (cp >= 0x4e00 && cp <= 0x9fff) || // CJK 基本区
    (cp >= 0xa000 && cp <= 0xa4cf) || // 彝文
    (cp >= 0xac00 && cp <= 0xd7a3) || // 谚文音节
    (cp >= 0xf900 && cp <= 0xfaff) || // CJK 兼容表意文字
    (cp >= 0xfe30 && cp <= 0xfe4f) || // CJK 兼容形式
    (cp >= 0xff00 && cp <= 0xff60) || // 全角形式
    (cp >= 0xffe0 && cp <= 0xffe6) || // 全角符号
    (cp >= 0x20000 && cp <= 0x3ffff) // CJK 扩展 B–F
  );
}

/** 估算单段文本的 token 数（空串 0，非空至少 1）。 */
export function estimateTokens(text: string): number {
  if (!text) return 0;
  let tokens = 0;
  let ascii = 0;
  let other = 0;
  const flush = () => {
    tokens += Math.ceil(ascii / 4) + Math.ceil(other / 2);
    ascii = 0;
    other = 0;
  };
  for (const ch of text) {
    const cp = ch.codePointAt(0) as number;
    if (isWideCodePoint(cp)) {
      flush();
      tokens += 1;
    } else if (cp < 0x80) {
      ascii += 1;
    } else {
      other += 1;
    }
  }
  flush();
  return tokens;
}

/** 整段历史的 token 估算：逐条内容 + 每条约 4 token 结构开销。 */
export function estimateRowsTokens(rows: ChatMessage[]): number {
  if (!Array.isArray(rows) || !rows.length) return 0;
  let sum = 0;
  for (const row of rows) {
    sum += estimateTokens(String(row?.content ?? "")) + ROW_TOKEN_OVERHEAD;
  }
  return sum;
}
