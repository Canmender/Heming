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

/**
 * 估算单段文本的 token 数（空串 0，非空至少 1）。
 *
 * d.412.4.183：原来是 `for...of` + `ch.codePointAt(0)` + 闭包 `flush()`，
 * 每个字符都新建迭代器记录、每次 flush 都走闭包调用——而这是压缩链、用量校准、
 * 工具折叠里调用最密的纯函数（每条消息、每个工具参数都要过）。改成按 charCodeAt
 * 的下标循环（手动合并 UTF-16 代理对还原码点），把 flush 展开成内联表达式，
 * 语义逐字节不变（全 BMP + 补充平面 + 孤立代理 + 随机混合串交叉验证一致），
 * ASCII 长串约 2×、混合中文约 2×。
 */
export function estimateTokens(text: string): number {
  if (!text) return 0;
  let tokens = 0;
  let ascii = 0;
  let other = 0;
  const len = text.length;
  for (let i = 0; i < len; i += 1) {
    let cp = text.charCodeAt(i);
    // 合并高低代理对为真实码点，对齐 for...of 的按码点迭代（补充平面 CJK 才能命中 isWide）。
    if (cp >= 0xd800 && cp <= 0xdbff && i + 1 < len) {
      const lo = text.charCodeAt(i + 1);
      if (lo >= 0xdc00 && lo <= 0xdfff) {
        cp = 0x10000 + ((cp - 0xd800) << 10) + (lo - 0xdc00);
        i += 1;
      }
    }
    if (isWideCodePoint(cp)) {
      tokens += Math.ceil(ascii / 4) + Math.ceil(other / 2) + 1;
      ascii = 0;
      other = 0;
    } else if (cp < 0x80) {
      ascii += 1;
    } else {
      other += 1;
    }
  }
  return tokens + Math.ceil(ascii / 4) + Math.ceil(other / 2);
}

/**
 * 一张图片按多少 token 计（估算口径，宁可高估）。
 *
 * ★ 以前 `estimateRowsTokens` 只看 `content` 文本：带图的历史行按 4 token 算，
 * 实际供应商要花上千 token 读图。于是「预算说还能塞 5000 token」的请求实际已经超限，
 * 撞 400 之后按 `aggressive` 收紧预算也收不回来——超的是图片，不是文字。
 * 取值偏保守（1280×720 一档图约 1.1k token，取 1500 留余量）。
 */
export const IMAGE_TOKEN_COST = 1500;

/**
 * 一次工具调用的结构开销（id / type / 分隔符等）。
 *
 * 调用本身要占字段，名字短的也有这条固定成本；把它单列出来，
 * 断言里就能写「这一条 = 结构 + 名字 + 参数」，不用猜。
 */
export const TOOL_CALL_OVERHEAD = 8;

/**
 * 单条消息的估算 token：正文 + 内容片（图片按固定成本、文本按字数）+ 工具调用参数 + 结构开销。
 *
 * ★ 以前完全不计 `tool_calls`：assistant 行上的 `arguments` 可以是几万字符（写文件、批量改代码），
 * 预算里却只算正文。于是「还能塞 3000 token」的判断在带工具历史时是错的，
 * 撞 400 之后按 `aggressive` 收紧也收不回来——超的是工具参数，不是正文。
 */
export function estimateRowTokens(row: ChatMessage): number {
  let sum = ROW_TOKEN_OVERHEAD;
  const parts = row?.contentParts;
  if (!Array.isArray(parts) || !parts.length) {
    sum += estimateTokens(String(row?.content ?? ""));
  } else {
    for (const part of parts) {
      if (!part) continue;
      sum += part.type === "image" ? IMAGE_TOKEN_COST : estimateTokens(String(part.text ?? ""));
    }
  }
  for (const call of row?.tool_calls ?? []) {
    if (!call?.function) continue;
    sum += TOOL_CALL_OVERHEAD;
    sum += estimateTokens(String(call.function.name ?? ""));
    sum += estimateTokens(String(call.function.arguments ?? ""));
  }
  if (row?.tool_call_id) sum += estimateTokens(String(row.tool_call_id));
  if (row?.name) sum += estimateTokens(String(row.name));
  return sum;
}

/** 整段历史的 token 估算：逐条内容 + 每条约 4 token 结构开销。 */
export function estimateRowsTokens(rows: ChatMessage[]): number {
  if (!Array.isArray(rows) || !rows.length) return 0;
  let sum = 0;
  for (const row of rows) {
    sum += estimateRowTokens(row);
  }
  return sum;
}
