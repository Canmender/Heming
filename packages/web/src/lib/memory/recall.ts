import type { EpisodicEntry, SemanticEntry, WorkingTurn } from "./types.js";
import type { MemoryStore } from "./store.js";
import { recencyScore } from "./store.js";
import { tokenize } from "./tokenize.js";

/**
 * 记忆召回（设计 §4）：三层各自独立打分，只负责「取什么」，
 * 拼装与预算裁剪交给 format.ts。
 */

/** 语义层非 pinned 条目的召回上限。 */
export const SEMANTIC_TOP = 5;
/** 情景层召回上限。 */
export const EPISODIC_TOP = 3;
/** 工作层召回轮数。 */
export const WORKING_TOP = 6;
/** 情景层的 importance 加权下限（importance=0.5 时权重为 1）。 */
const IMPORTANCE_FLOOR = 0.5;

const BM25_K1 = 1.2;
const BM25_B = 0.75;

/**
 * 简化 BM25：docs 为已分词文档（词项可重复，重复即词频）。
 * IDF = ln(1 + (N - df + 0.5) / (df + 0.5))；无重叠词返回 0。
 */
export function bm25Score(queryTokens: string[], docs: string[][]): number[] {
  const n = docs.length;
  if (!n) return [];
  const scores = new Array<number>(n).fill(0);
  const terms = [...new Set(queryTokens)];
  if (!terms.length) return scores;

  const lengths = docs.map((doc) => doc.length);
  const avgLength = lengths.reduce((sum, len) => sum + len, 0) / n || 1;

  for (const term of terms) {
    let df = 0;
    const tf = new Array<number>(n).fill(0);
    docs.forEach((doc, i) => {
      const count = doc.filter((token) => token === term).length;
      if (count > 0) {
        df += 1;
        tf[i] = count;
      }
    });
    if (!df) continue;
    const idf = Math.log(1 + (n - df + 0.5) / (df + 0.5));
    for (let i = 0; i < n; i++) {
      if (!tf[i]) continue;
      const norm = 1 - BM25_B + BM25_B * (lengths[i] / avgLength);
      scores[i] += (idf * (tf[i] * (BM25_K1 + 1))) / (tf[i] + BM25_K1 * norm);
    }
  }
  return scores;
}

/** 语义层：pinned 全带；其余按 key/value 与查询的 bigram 重合度 × recency 取 top5。 */
function rankSemantic(entries: SemanticEntry[], queryTokens: string[], nowMs: number): SemanticEntry[] {
  const pinned = entries.filter((entry) => entry.pinned);
  const rest = entries.filter((entry) => !entry.pinned);
  const querySet = new Set(queryTokens);
  if (!querySet.size) return [...pinned, ...rest.slice(0, SEMANTIC_TOP)];

  const ranked = rest
    .map((entry) => {
      const doc = new Set(tokenize(`${entry.key} ${entry.value}`));
      let hits = 0;
      for (const token of querySet) if (doc.has(token)) hits += 1;
      return { entry, score: (hits / querySet.size) * recencyScore(entry.updatedAt, nowMs) };
    })
    .filter((item) => item.score > 0)
    .sort((a, b) => b.score - a.score)
    .slice(0, SEMANTIC_TOP)
    .map((item) => item.entry);
  return [...pinned, ...ranked];
}

/** 情景层：bigram BM25 × 14 天半衰期 × importance 加权，取 top3。 */
function rankEpisodic(entries: EpisodicEntry[], queryTokens: string[], nowMs: number): EpisodicEntry[] {
  const weight = (entry: EpisodicEntry) =>
    recencyScore(entry.at, nowMs) * (IMPORTANCE_FLOOR + entry.importance);
  if (!entries.length) return [];
  if (!queryTokens.length) {
    return [...entries].sort((a, b) => weight(b) - weight(a)).slice(0, EPISODIC_TOP);
  }
  const scores = bm25Score(
    queryTokens,
    entries.map((entry) => tokenize(entry.summary)),
  );
  return entries
    .map((entry, i) => ({ entry, score: scores[i] * weight(entry) }))
    .filter((item) => item.score > 0)
    .sort((a, b) => b.score - a.score)
    .slice(0, EPISODIC_TOP)
    .map((item) => item.entry);
}

/**
 * 三层召回入口：语义（pinned + top5）／情景（top3）／工作（最近 6 轮，按时间先后）。
 * 记忆总开关关闭、或任何异常 → 三层皆空（调用侧据此零注入）。
 */
export function recallMemory(
  store: MemoryStore,
  input: { agentId: string; conversationId: string; query: string },
): { semantic: SemanticEntry[]; episodic: EpisodicEntry[]; working: WorkingTurn[] } {
  try {
    if (!store.getSettings().enabled) return { semantic: [], episodic: [], working: [] };
    const nowMs = store.nowMs();
    const queryTokens = tokenize(input.query ?? "");
    return {
      semantic: rankSemantic(store.semantic(input.agentId), queryTokens, nowMs),
      episodic: rankEpisodic(store.episodic(input.agentId), queryTokens, nowMs),
      working: store.working(input.conversationId, input.agentId).slice(-WORKING_TOP),
    };
  } catch {
    return { semantic: [], episodic: [], working: [] };
  }
}
