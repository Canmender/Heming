/**
 * wiki 检索的查询分词（d.35 · P1-5）。
 *
 * 背景：`searchPages` 原先把 query 按空白切开后逐词 `includes`。
 * 中文没有空格，一句「预算风险」在文档写作「预算与风险」时就是 0 命中——
 * 用户会以为知识库是空的。
 *
 * 做法（只做读侧、无依赖）：
 * - ASCII 段原样成一个词（整词匹配，行为与旧版逐字一致）；
 * - 含 CJK 的段：长度 ≤ 2 保留整段；更长时展开相邻**二元组**，
 *   匹配时允许「覆盖率达到阈值」即算命中（整词出现仍然优先）。
 *
 * 为什么用 bigram 而不是词典分词：词典要么引入依赖、要么自己维护一张永远不全的表；
 * bigram 确定性强、对中文足够，且不改变「同一份库同一句 query 结果一致」的契约。
 */

/** 中日韩统一表意文字（含扩展 A 与兼容区）。 */
const CJK = /[㐀-䶿一-鿿豈-﫿]/;

/** 切段：空白 + 中英文标点。 */
const SPLIT = /[\s,，.。;；:：!！?？、()（）[\]【】{}｛｝"'“”‘’<>《》/\\|]+/;

/** CJK 长词的覆盖率阈值：至少 60% 的二元组出现才算命中。 */
export const CJK_COVERAGE = 0.6;

/** 一个查询词。 */
export interface QueryTerm {
  /** 原词（已小写）。 */
  text: string;
  /** 匹配单元：整词 + （CJK 长词的）相邻二元组。 */
  units: string[];
  /** 是否允许「覆盖率」匹配（仅 CJK 且长度 > 2）。 */
  coverage: boolean;
}

/**
 * 把 query 切成词，并为每个词准备匹配单元。
 *
 * 空 query / 只有标点 → 空数组（调用方据此返回空结果）。
 */
export function tokenizeQuery(query: string): QueryTerm[] {
  const q = String(query ?? "")
    .toLowerCase()
    .trim();
  if (!q) return [];
  const chunks = q.split(SPLIT).filter(Boolean);
  const terms: QueryTerm[] = [];
  for (const chunk of chunks) {
    if (!CJK.test(chunk)) {
      // ASCII（或其它非 CJK）：整词匹配，与旧版行为完全一致。
      terms.push({ text: chunk, units: [chunk], coverage: false });
      continue;
    }
    const chars = [...chunk];
    if (chars.length <= 2) {
      terms.push({ text: chunk, units: [chunk], coverage: false });
      continue;
    }
    const units = new Set<string>();
    for (let i = 0; i + 1 < chars.length; i += 1) units.add(chars[i] + chars[i + 1]);
    terms.push({ text: chunk, units: [...units], coverage: true });
  }
  return terms;
}

/**
 * 一个词在文本里的匹配强度（0 = 不命中，1 = 整词命中，0<r<1 = 覆盖率命中）。
 *
 * 返回强度而不是布尔，是为了让打分能区分「整词出现在标题」与「部分出现在正文」。
 */
export function matchTerm(term: QueryTerm, hay: string): number {
  if (!hay) return 0;
  if (hay.includes(term.text)) return 1;
  if (!term.coverage) return 0;
  if (term.units.length === 0) return 0;
  let hit = 0;
  for (const unit of term.units) if (hay.includes(unit)) hit += 1;
  const ratio = hit / term.units.length;
  return ratio >= CJK_COVERAGE ? ratio : 0;
}
