/**
 * 中文分词（设计 §2.2/§5.1）：零依赖——ASCII 词小写化 + 中文相邻二字 bigram。
 * BM25 与关键词提取共用同一分词口径。
 */

/** 匹配一段连续中文（含扩展 A 区）或一段 ASCII 词（字母/数字/下划线）。 */
const TOKEN_RE = /[㐀-䶿一-鿿]+|[A-Za-z0-9_]+/g;
const ASCII_ONLY = /^[A-Za-z0-9_]+$/;

/**
 * 分词：中文按相邻二字切 bigram（单字成串时保留该字），ASCII 词小写化；
 * 标点与空白只作切分符。结果按首次出现顺序去重（关键词提取与 BM25 文档项共用，
 * 因此 BM25 的词频项退化为 0/1，排序由 IDF 与覆盖率主导）。
 */
export function tokenize(text: string): string[] {
  if (typeof text !== "string" || !text) return [];
  const out: string[] = [];
  const seen = new Set<string>();
  const push = (token: string) => {
    if (seen.has(token)) return;
    seen.add(token);
    out.push(token);
  };
  for (const match of text.matchAll(TOKEN_RE)) {
    const chunk = match[0];
    if (ASCII_ONLY.test(chunk)) {
      push(chunk.toLowerCase());
      continue;
    }
    if (chunk.length === 1) {
      push(chunk);
      continue;
    }
    for (let i = 0; i + 1 < chunk.length; i++) push(chunk.slice(i, i + 2));
  }
  return out;
}
