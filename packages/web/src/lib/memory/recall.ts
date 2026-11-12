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
/** 知识库条目在语义段里最多占几条（再多会把真正的长期记忆挤出预算）。 */
export const VAULT_RECALL_TOP = 2;
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
      .sort((a, b) => b.score - a.score);
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
    .sort((a, b) => b.score - a.score);
  const chosen = pickDiverse(scored, EPISODIC_TOP);
  const picked = scored.filter((item) => chosen.has(item.entry.id)).map((item) => item.entry);
  for (const item of scored) if (chosen.has(item.entry.id)) settle(item.entry, item.base);
  return { picked, scores, boosts };
}

/**
 * 知识库条目参与召回的选项（d.114）。
 *
 * 缺省从记忆仓库读指针条目与设置；`enabled/available/entries` 三个口子给集成侧覆盖：
 * - `enabled` 的**唯一真源**仍是 `MemorySettings.vaultMemory`（这里只是允许显式传同一值）；
 * - `available` 由集成侧告知「知识库源是否接入」，未接入时整体跳过但**可观测**；
 * - `entries` 允许传一份快照（例如知识库页刚同步完、内存仓库还没刷新时）。
 */
export interface VaultRecallOptions {
  enabled?: boolean;
  available?: boolean;
  entries?: SemanticEntry[];
}

/** 知识库层这次参与没参与、为什么没参与（可观测性，不静默变空）。 */
export interface VaultRecallInfo {
  /** 设置开关是否为开。 */
  enabled: boolean;
  /** 知识库源是否接入。 */
  available: boolean;
  /** 整体跳过的原因：设置关闭 / 源未接入 / 没有纳入任何笔记 / 读取异常；null = 正常参与。 */
  skippedReason: "disabled" | "unavailable" | "empty" | "error" | null;
  /** 记忆仓库里的知识库条目总数（候选池）。 */
  candidates: number;
  /** 这次真正进入召回候选的条数（≤ `VAULT_RECALL_TOP`）。 */
  picked: number;
}

/**
 * 知识库层排序：语义层同一套分数口径（重合度 × 90 天衰减 × 置信度 × 个性化），
 * 外加**稳定 tie-break**（分数相同时按 rel 字典序）——同一份输入两次召回顺序一致。
 *
 * 它不参与「同主题键时效覆盖」：知识库条目的 key 是 rel，本来就不会和长期记忆撞键。
 */
function rankVault(
  entries: SemanticEntry[],
  queryTokens: string[],
  nowMs: number,
  usage: UsageView,
): { picked: SemanticEntry[]; scores: Record<string, number>; boosts: Record<string, number> } {
  const scores: Record<string, number> = {};
  const boosts: Record<string, number> = {};
  if (!entries.length) return { picked: [], scores, boosts };
  const boostOf = (id: string) => usage.boostOf(id);
  const decayed = (entry: SemanticEntry) =>
    recencyScore(entry.updatedAt, nowMs, SEMANTIC_HALF_LIFE_DAYS) * (CONFIDENCE_FLOOR + entry.confidence);
  const tieBreak = (a: { score: number; entry: SemanticEntry }, b: { score: number; entry: SemanticEntry }) =>
    b.score - a.score || (a.entry.key < b.entry.key ? -1 : a.entry.key > b.entry.key ? 1 : 0);

  if (!queryTokens.length) {
    const scored = entries.map((entry) => ({ entry, score: decayed(entry) * boostOf(entry.id) })).sort(tieBreak);
    const picked = scored.slice(0, VAULT_RECALL_TOP).map((item) => item.entry);
    for (const item of scored.slice(0, VAULT_RECALL_TOP)) {
      scores[item.entry.id] = roundScore(item.score);
      if (boostOf(item.entry.id) > 1) boosts[item.entry.id] = boostOf(item.entry.id);
    }
    return { picked, scores, boosts };
  }

  const querySet = new Set(queryTokens);
  const scored = entries
    .map((entry) => {
      const tokens = new Set(tokenize(`${entry.key} ${entry.value}`));
      let hits = 0;
      for (const token of querySet) if (tokens.has(token)) hits += 1;
      return { entry, tokens, base: (hits / querySet.size) * decayed(entry) };
    })
    .filter((item) => item.base > 0)
    .map((item) => ({ ...item, score: item.base * boostOf(item.entry.id) }))
    .sort(tieBreak);
  const chosen = pickDiverse(scored, VAULT_RECALL_TOP);
  const picked = scored.filter((item) => chosen.has(item.entry.id)).map((item) => item.entry);
  for (const item of scored) {
    if (!chosen.has(item.entry.id)) continue;
    scores[item.entry.id] = roundScore(item.base * boostOf(item.entry.id));
    if (boostOf(item.entry.id) > 1) boosts[item.entry.id] = boostOf(item.entry.id);
  }
  return { picked, scores, boosts };
}

/** 读知识库条目；异常按「没有知识库」处理，绝不让它挡住记忆召回。 */
function readVaultEntries(store: MemoryStore, options?: VaultRecallOptions): SemanticEntry[] {
  if (options?.entries) return options.entries.filter((entry) => entry.source === "vault");
  try {
    return store.vaultEntries();
  } catch {
    return [];
  }
}

/**
 * 三层召回入口：语义（同键时效覆盖 → pinned + top5）／情景（top3，多样性重排）／
 * 工作（最近 6 轮，按时间先后）；知识库指针条目在语义段末尾参与（≤ `VAULT_RECALL_TOP` 条）。
 *
 * 记忆总开关关闭、或任何异常 → 三层皆空（调用侧据此零注入）。
 *
 * `scores` / `superseded` 是给「召回可观测性」用的旁路信息（d.27）：
 * 排序口径原本算完即丢，用户只能看到「注入了哪几条」看不到「凭什么这几条」，
 * 也看不到某条旧事实是被同键新值覆盖掉的（不是没召回）。两者都不参与排序本身。
 *
 * `usage`（d.28）是个性化加权视图：只改「同命中度之间谁排前面」和分数，
 * 不改取什么、不改预算，也不省略任何一层。缺省为 `NEUTRAL_USAGE`（全 ×1），
 * 此时 `scores` 与 d.27 逐字一致、`boosts` 为空表。
 *
 * `vaultOptions`（d.114）与前三参解耦：不传且仓库里没有知识库条目时，返回值形状
 * 与 d.112 逐字相同（下方 `vault` 字段只在「有知识库条目或调用方显式传入」时出现）。
 */
export function recallMemory(
  store: MemoryStore,
  input: {
    agentId: string;
    conversationId: string;
    query: string;
    /**
     * 智能体级记忆偏好（`agentPrefs.ts`）。**缺省视为全开**，老调用方形状不变。
     *
     * ★ 以前召回只看记忆总开关 `settings.enabled`：用户在「记忆」页把某个智能体的
     * 长期记忆关掉之后，语义/情景记忆**照样注入**——开关是摆设，用户还以为它生效了。
     * 现在按层收口：长期关 → 不召回语义/情景；短期关 → 不召回会话内工作记忆。
     */
    prefs?: { shortTerm?: boolean; longTerm?: boolean };
  },
  usage: UsageView = NEUTRAL_USAGE,
  vaultOptions?: VaultRecallOptions,
): {
  semantic: SemanticEntry[];
  episodic: EpisodicEntry[];
  working: WorkingTurn[];
  scores: Record<string, number>;
  boosts: Record<string, number>;
  superseded: SupersededInfo[];
  /** 知识库层参与情况；没有知识库条目且未显式传入选项时缺省（老调用方形状不变）。 */
  vault?: VaultRecallInfo;
} {
  // 两条早退各回一份新表：共用一个对象会让调用方改一次影响下一次。
  const empty = () => ({ semantic: [], episodic: [], working: [], scores: {}, boosts: {}, superseded: [] });
  try {
    const settings = store.getSettings();
    if (!settings.enabled) return empty();
    const nowMs = store.nowMs();
    const queryTokens = tokenize(input.query ?? "");
    // 知识库指针条目单独排序：它们不参与「同主题键时效覆盖」，也不占普通语义记忆名额。
    const allSemantic = store.semantic(input.agentId);
    // 偏好收口：长期记忆关掉 → 语义/情景一层都不取（不是「取了不注入」，是压根不查）。
    const longTermOn = input.prefs?.longTerm ?? true;
    const shortTermOn = input.prefs?.shortTerm ?? true;
    const semantic = longTermOn
      ? rankSemantic(
          allSemantic.filter((entry) => entry.source !== "vault"),
          queryTokens,
          nowMs,
          usage,
        )
      : { picked: [] as SemanticEntry[], scores: {} as Record<string, number>, boosts: {} as Record<string, number>, superseded: [] as SupersededInfo[] };
    const episodic = longTermOn
      ? rankEpisodic(store.episodic(input.agentId), queryTokens, nowMs, usage)
      : { picked: [] as EpisodicEntry[], scores: {} as Record<string, number>, boosts: {} as Record<string, number> };

    const vaultAll = readVaultEntries(store, vaultOptions);
    const vaultEnabled = vaultOptions?.enabled ?? settings.vaultMemory !== false;
    const vaultAvailable = vaultOptions?.available ?? true;
    let skippedReason: VaultRecallInfo["skippedReason"] = null;
    if (!vaultEnabled) skippedReason = "disabled";
    else if (!vaultAvailable) skippedReason = "unavailable";
    else if (!vaultAll.length) skippedReason = "empty";
    const rankedVault = skippedReason
      ? { picked: [] as SemanticEntry[], scores: {} as Record<string, number>, boosts: {} as Record<string, number> }
      : rankVault(vaultAll, queryTokens, nowMs, usage);

    const includeVaultInfo = vaultOptions !== undefined || vaultAll.length > 0;
    return {
      semantic: [...semantic.picked, ...rankedVault.picked],
      episodic: episodic.picked,
      working: shortTermOn ? store.working(input.conversationId, input.agentId).slice(-WORKING_TOP) : [],
      scores: { ...semantic.scores, ...episodic.scores, ...rankedVault.scores },
      boosts: { ...semantic.boosts, ...episodic.boosts, ...rankedVault.boosts },
      superseded: semantic.superseded,
      ...(includeVaultInfo
        ? {
            vault: {
              enabled: vaultEnabled,
              available: vaultAvailable,
              skippedReason,
              candidates: vaultAll.length,
              picked: rankedVault.picked.length,
            } satisfies VaultRecallInfo,
          }
        : {}),
    };
  } catch {
    return empty();
  }
}
