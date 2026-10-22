import type { EpisodicEntry, SemanticEntry, WorkingTurn } from "./types.js";
import type { MemoryStore } from "./store.js";
import { recencyScore } from "./store.js";
import { tokenize } from "./tokenize.js";
import type { UsageView } from "./usage.js";
import { NEUTRAL_USAGE } from "./usage.js";

/**
 * 记忆召回（设计 §4）：三层各自独立打分，只负责「取什么」，
 * 拼装与预算裁剪交给 format.ts。
 *
 * 两条重排规则（d.25）：
 * - **时效覆盖**：语义层同主题键只保留最新更新的那条（旧值视为已被推翻）；
 * - **多样性重排**：语义/情景都按 MMR 贪心选名额，近似重复的条目不会一起占满预算。
 *
 * 第三条（d.28）：**个性化加权**。`usage` 给出「这条被疑似引用过几次」的乘子，
 * 在既有分数上乘一次。不给 `usage` 时所有乘子为 1，分数与 d.27 逐字相同。
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
 * 一条语义旧值被同键新值推翻的记录（可观测性用）。
 * 记 `winnerId` 而不是只记「这条没召回」——用户要看的是「谁顶替了它」。
 */
export type SupersededInfo = { key: string; loserId: string; winnerId: string };

/** 分数只用于展示与相对排序，保留 4 位小数避免 UI 出现 0.3247109382471093 这种长串。 */
function roundScore(n: number): number {
  return Number.isFinite(n) ? Math.round(n * 1e4) / 1e4 : 0;
}

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
 *
 * 顺带产出**被覆盖清单**（可观测性）：旧条没进注入不是「召回坏了」，而是被同键新值
 * 推翻——这个原因原来算完就丢，用户在记忆区只能看到「这条没命中」，看不到为什么。
 */
function supersedeSemantic(entries: SemanticEntry[]): {
  live: SemanticEntry[];
  superseded: SupersededInfo[];
} {
  const winners = new Map<string, SemanticEntry>();
  const losers: SupersededInfo[] = [];
  const pinnedKeys = new Set<string>();
  for (const entry of entries) {
    const current = winners.get(entry.key);
    if (!current) {
      winners.set(entry.key, entry);
    } else if (atMs(entry.updatedAt) > atMs(current.updatedAt)) {
      winners.set(entry.key, entry);
      losers.push({ key: entry.key, loserId: current.id, winnerId: entry.id });
    } else {
      losers.push({ key: current.key, loserId: entry.id, winnerId: current.id });
    }
    if (entry.pinned) pinnedKeys.add(entry.key);
  }
  return {
    live: [...winners.values()].map((entry) =>
      pinnedKeys.has(entry.key) && !entry.pinned ? { ...entry, pinned: true } : entry,
    ),
    superseded: losers,
  };
}

/**
 * 语义层：先按主题键做时效覆盖，再分 pinned（全带）／其余（重合度 × recency × 置信度 × 个性化）
 * 经多样性重排取 top5。查询为空时退回 pinned + 最近更新 5 条。
 *
 * 分数一并带出（d.27 可观测性）：pinned 项没有「查询重合度」（它必带），
 * 给它衰减分 × 置信度这一半，口径与非 pinned 可比。
 */
function rankSemantic(
  entries: SemanticEntry[],
  queryTokens: string[],
  nowMs: number,
  usage: UsageView,
): { picked: SemanticEntry[]; scores: Record<string, number>; boosts: Record<string, number>; superseded: SupersededInfo[] } {
  const { live, superseded } = supersedeSemantic(entries);
  const pinned = live.filter((entry) => entry.pinned);
  const rest = live.filter((entry) => !entry.pinned);
  const querySet = new Set(queryTokens);
  const boostOf = (id: string) => usage.boostOf(id);
  const decayed = (entry: SemanticEntry) =>
    recencyScore(entry.updatedAt, nowMs, SEMANTIC_HALF_LIFE_DAYS) *
    (CONFIDENCE_FLOOR + entry.confidence);
  const scores: Record<string, number> = {};
  const boosts: Record<string, number> = {};
  const settle = (entry: SemanticEntry, base: number) => {
    const factor = boostOf(entry.id);
    scores[entry.id] = roundScore(base * factor);
    if (factor > 1) boosts[entry.id] = factor;
  };
  for (const entry of pinned) settle(entry, decayed(entry));

  let picked: SemanticEntry[];
  if (!querySet.size) {
    picked = [...pinned, ...rest.slice(0, SEMANTIC_TOP)];
    for (const entry of picked) if (!(entry.id in scores)) settle(entry, decayed(entry));
  } else {
    const scored = rest
      .map((entry) => {
        const tokens = new Set(tokenize(`${entry.key} ${entry.value}`));
        let hits = 0;
        for (const token of querySet) if (tokens.has(token)) hits += 1;
        return { entry, tokens, base: (hits / querySet.size) * decayed(entry) };
      })
      .filter((item) => item.base > 0)
      // 个性化只在这一步改顺序：命中数与衰减相同的老记忆，被引用过的那条排前面。
      .map((item) => ({ ...item, score: item.base * boostOf(item.entry.id) }))
      .sort((a, b) => b.score - a.score)
      .filter((item) => item.score > 0);
    // 入选集合按原排序回填，保证分数并列时结果稳定（不随桶顺序漂移）
    const chosen = pickDiverse(scored, SEMANTIC_TOP);
    const fromRest = scored.filter((item) => chosen.has(item.entry.id)).map((item) => item.entry);
    picked = [...pinned, ...fromRest];
    for (const item of scored) if (chosen.has(item.entry.id)) settle(item.entry, item.base);
  }
  return { picked, scores, boosts, superseded };
}

/**
 * 情景层：bigram BM25 × 14 天半衰期 × importance 加权 × 个性化，再经多样性重排取 top3
 * （同一段对话沉淀出的近似摘要只占一个名额，其余名额让给更有区分度的情景）。
 */
function rankEpisodic(
  entries: EpisodicEntry[],
  queryTokens: string[],
  nowMs: number,
  usage: UsageView,
): { picked: EpisodicEntry[]; scores: Record<string, number>; boosts: Record<string, number> } {
  const boostOf = (id: string) => usage.boostOf(id);
  const weight = (entry: EpisodicEntry) =>
    recencyScore(entry.at, nowMs) * (IMPORTANCE_FLOOR + entry.importance);
  const scores: Record<string, number> = {};
  const boosts: Record<string, number> = {};
  const settle = (entry: EpisodicEntry, base: number) => {
    const factor = boostOf(entry.id);
    scores[entry.id] = roundScore(base * factor);
    if (factor > 1) boosts[entry.id] = factor;
  };
  if (!entries.length) return { picked: [], scores, boosts };
  if (!queryTokens.length) {
    const picked = [...entries]
      .map((entry) => ({ entry, score: weight(entry) * boostOf(entry.id) }))
      .sort((a, b) => b.score - a.score)
      .slice(0, EPISODIC_TOP)
      .map((item) => item.entry);
    for (const entry of picked) settle(entry, weight(entry));
    return { picked, scores, boosts };
  }
  const bm25 = bm25Score(
    queryTokens,
    entries.map((entry) => tokenize(entry.summary)),
  );
  const scored = entries
    .map((entry, i) => ({
      entry,
      tokens: new Set(tokenize(entry.summary)),
      base: bm25[i] * weight(entry),
    }))
    .filter((item) => item.base > 0)
    .map((item) => ({ ...item, score: item.base * boostOf(item.entry.id) }))
    .sort((a, b) => b.score - a.score)
    .filter((item) => item.score > 0);
  const chosen = pickDiverse(scored, EPISODIC_TOP);
  const picked = scored.filter((item) => chosen.has(item.entry.id)).map((item) => item.entry);
  for (const item of scored) if (chosen.has(item.entry.id)) settle(item.entry, item.base);
  return { picked, scores, boosts };
}

/**
 * 三层召回入口：语义（同键时效覆盖 → pinned + top5）／情景（top3，多样性重排）／
 * 工作（最近 6 轮，按时间先后）。
 * 记忆总开关关闭、或任何异常 → 三层皆空（调用侧据此零注入）。
 *
 * `scores` / `superseded` 是给「召回可观测性」用的旁路信息（d.27）：
 * 排序口径原本算完即丢，用户只能看到「注入了哪几条」看不到「凭什么这几条」，
 * 也看不到某条旧事实是被同键新值覆盖掉的（不是没召回）。两者都不参与排序本身。
 *
 * `usage`（d.28）是个性化加权视图：只改「同命中度之间谁排前面」和分数，
 * 不改取什么、不改预算，也不省略任何一层。缺省为 `NEUTRAL_USAGE`（全 ×1），
 * 此时 `scores` 与 d.27 逐字一致、`boosts` 为空表。
 */
export function recallMemory(
  store: MemoryStore,
  input: { agentId: string; conversationId: string; query: string },
  usage: UsageView = NEUTRAL_USAGE,
): {
  semantic: SemanticEntry[];
  episodic: EpisodicEntry[];
  working: WorkingTurn[];
  scores: Record<string, number>;
  boosts: Record<string, number>;
  superseded: SupersededInfo[];
} {
  const empty = {
    semantic: [] as SemanticEntry[],
    episodic: [] as EpisodicEntry[],
    working: [] as WorkingTurn[],
    scores: {} as Record<string, number>,
    boosts: {} as Record<string, number>,
    superseded: [] as SupersededInfo[],
  };
  try {
    if (!store.getSettings().enabled) return empty;
    const nowMs = store.nowMs();
    const queryTokens = tokenize(input.query ?? "");
    const semantic = rankSemantic(store.semantic(input.agentId), queryTokens, nowMs, usage);
    const episodic = rankEpisodic(store.episodic(input.agentId), queryTokens, nowMs, usage);
    return {
      semantic: semantic.picked,
      episodic: episodic.picked,
      working: store.working(input.conversationId, input.agentId).slice(-WORKING_TOP),
      scores: { ...semantic.scores, ...episodic.scores },
      boosts: { ...semantic.boosts, ...episodic.boosts },
      superseded: semantic.superseded,
    };
  } catch {
    return empty;
  }
}
