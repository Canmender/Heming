import type { EpisodicEntry, SemanticEntry, WorkingTurn } from "./types.js";
import type { MemoryStore } from "./store.js";
import { recencyScore } from "./store.js";
import { tokenize } from "./tokenize.js";

/**
 * 记忆召回（设计 §4）：三层各自独立打分，只负责「取什么」，
 * 拼装与预算裁剪交给 format.ts。
 *
 * 两条重排规则（d.25）：
 * - **时效覆盖**：语义层同主题键只保留最新更新的那条（旧值视为已被推翻）；
 * - **多样性重排**：语义/情景都按 MMR 贪心选名额，近似重复的条目不会一起占满预算。
 */

/** 语义层非 pinned 条目的召回上限。 */
export const SEMANTIC_TOP = 5;
/** 情景层召回上限。 */
export const EPISODIC_TOP = 3;
/** 工作层召回轮数。 */
export const WORKING_TOP = 6;
/** 情景层的 importance 加权下限（importance=0.5 时权重为 1）。 */
const IMPORTANCE_FLOOR = 0.5;
/** 语义层的 confidence 加权下限（confidence=0.5 时权重为 1）。 */
const CONFIDENCE_FLOOR = 0.5;
/**
 * 语义层时间衰减半衰期（天）。
 * 情景层共用 `EPISODIC_HALF_LIFE_DAYS=14` 是因为「某次对话发生了什么」本就该快速淡出；
 * 长期事实用 14 天衰减会让三个月前记下的「用户在杭州」在召回时几乎归零。
 */
export const SEMANTIC_HALF_LIFE_DAYS = 90;
/** 多样性重排的最大降权幅度（重合度=1 时分数打 (1 - DIVERSITY_DAMP) 折）。 */
const DIVERSITY_DAMP = 0.6;

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

/** 时间戳转毫秒；不可解析（脏数据）按 0 处理，即「最旧」，会被同键的新条目覆盖。 */
function atMs(iso: string): number {
  const t = Date.parse(iso);
  return Number.isFinite(t) ? t : 0;
}

/** 两个词集的重合度（Jaccard）：0 完全不相关，1 完全同文；都空视为全同。 */
function overlapOf(a: Set<string>, b: Set<string>): number {
  if (!a.size && !b.size) return 1;
  let inter = 0;
  for (const token of a) if (b.has(token)) inter += 1;
  return inter / (a.size + b.size - inter);
}

/**
 * 多样性重排（MMR 贪心）：每轮取「分数 × 重复惩罚」最高的候选。
 * 只做降权不硬删——高度重复的条目仍可补位（否则 top 名额会被空置），
 * 但绝不会让同一件事的三个近似版本一起占满注入预算。
 */
function pickDiverse(
  candidates: { entry: { id: string }; score: number; tokens: Set<string> }[],
  limit: number,
): Set<string> {
  const chosen = new Set<string>();
  const taken: Set<string>[] = [];
  const pool = [...candidates];
  while (chosen.size < limit && pool.length) {
    let bestIndex = 0;
    let bestScore = -Infinity;
    for (let i = 0; i < pool.length; i++) {
      const item = pool[i];
      let maxOverlap = 0;
      for (const tokens of taken) maxOverlap = Math.max(maxOverlap, overlapOf(item.tokens, tokens));
      const score = item.score * (1 - DIVERSITY_DAMP * maxOverlap);
      if (score > bestScore) {
        bestScore = score;
        bestIndex = i;
      }
    }
    const winner = pool.splice(bestIndex, 1)[0];
    chosen.add(winner.entry.id);
    taken.push(winner.tokens);
  }
  return chosen;
}

/**
 * 时效覆盖：同一主题键只保留 `updatedAt` 最新的那条。
 *
 * 为什么必要：语义记忆默认落全局桶，但某个智能体也能往自己的桶里写同名 key，
 * 复盘/手动/显式三条写入路径都可能在两个桶里各留一份「称呼」。原样注入会让
 * 模型同时看到「称呼=老王」和「称呼=王总」，自相矛盾的记忆比没有记忆更糟。
 *
 * pinned 的含义是「这个主题必带」而不是「这一版内容必带」：若同键存在更新的条目，
 * 让最新那条继承置顶位（因此置顶项也可能被换掉，但主题不会丢）。
 */
function supersedeSemantic(entries: SemanticEntry[]): SemanticEntry[] {
  const winners = new Map<string, SemanticEntry>();
  const pinnedKeys = new Set<string>();
  for (const entry of entries) {
    const current = winners.get(entry.key);
    if (!current || atMs(entry.updatedAt) > atMs(current.updatedAt)) winners.set(entry.key, entry);
    if (entry.pinned) pinnedKeys.add(entry.key);
  }
  return [...winners.values()].map((entry) =>
    pinnedKeys.has(entry.key) && !entry.pinned ? { ...entry, pinned: true } : entry,
  );
}

/**
 * 语义层：先按主题键做时效覆盖，再分 pinned（全带）／其余（重合度 × recency × 置信度）
 * 经多样性重排取 top5。查询为空时退回 pinned + 最近更新 5 条。
 */
function rankSemantic(entries: SemanticEntry[], queryTokens: string[], nowMs: number): SemanticEntry[] {
  const live = supersedeSemantic(entries);
  const pinned = live.filter((entry) => entry.pinned);
  const rest = live.filter((entry) => !entry.pinned);
  const querySet = new Set(queryTokens);
  if (!querySet.size) return [...pinned, ...rest.slice(0, SEMANTIC_TOP)];

  const decayed = (entry: SemanticEntry) =>
    recencyScore(entry.updatedAt, nowMs, SEMANTIC_HALF_LIFE_DAYS) * (CONFIDENCE_FLOOR + entry.confidence);
  const scored = rest
    .map((entry) => {
      const tokens = new Set(tokenize(`${entry.key} ${entry.value}`));
      let hits = 0;
      for (const token of querySet) if (tokens.has(token)) hits += 1;
      return { entry, tokens, score: (hits / querySet.size) * decayed(entry) };
    })
    .filter((item) => item.score > 0)
    .sort((a, b) => b.score - a.score);
  // 入选集合按原排序回填，保证分数并列时结果稳定（不随桶顺序漂移）
  const chosen = pickDiverse(scored, SEMANTIC_TOP);
  return [...pinned, ...scored.filter((item) => chosen.has(item.entry.id)).map((item) => item.entry)];
}

/**
 * 情景层：bigram BM25 × 14 天半衰期 × importance 加权，再经多样性重排取 top3
 * （同一段对话沉淀出的近似摘要只占一个名额，其余名额让给更有区分度的情景）。
 */
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
  const scored = entries
    .map((entry, i) => ({
      entry,
      tokens: new Set(tokenize(entry.summary)),
      score: scores[i] * weight(entry),
    }))
    .filter((item) => item.score > 0)
    .sort((a, b) => b.score - a.score);
  const chosen = pickDiverse(scored, EPISODIC_TOP);
  return scored.filter((item) => chosen.has(item.entry.id)).map((item) => item.entry);
}

/**
 * 三层召回入口：语义（同键时效覆盖 → pinned + top5）／情景（top3，多样性重排）／
 * 工作（最近 6 轮，按时间先后）。
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
