import type { SkillBinding, SkillDefinition, SkillMatch, SkillUsage } from "./types.js";
import { DEFAULT_ROUTE_BUDGET, DEFAULT_ROUTE_TOP_K } from "./types.js";

/**
 * 技能路由（设计 §5.1）：零依赖分词（ASCII 词 + 中文 bigram）→ 字段加权 × IDF
 * → usage 微增益 → 过滤 → top3 + pinned 先入 → 总注入预算裁剪。
 */

const ASCII_WORD = /[a-z0-9]+(?:[._#+-][a-z0-9]+)*/g;
// 中文区间：CJK 扩展 A + 基本区 + 兼容表意文字
const CJK_RUN = new RegExp("[㐀-䶿一-鿿豈-﫿]+", "g");

/** 字段权重：name ×3、triggers ×2.5、tags ×1.5、description ×1。 */
const FIELD_WEIGHTS = { name: 3, triggers: 2.5, tags: 1.5, description: 1 } as const;
type FieldName = keyof typeof FIELD_WEIGHTS;
const FIELD_NAMES: readonly FieldName[] = ["name", "triggers", "tags", "description"];

/** usage 微增益：每次使用 +5%，最多 +20%（不喧宾夺主）。 */
const USAGE_STEP = 0.05;
const USAGE_CAP = 4;

/** 预算内截断时至少保留的正文长度，太短则整条放弃。 */
const MIN_TRUNCATED_INSTRUCTIONS = 40;

const SECTION_HEADER = "## 已启用技能";

/**
 * 查询/字段分词：ASCII 小写词 + 中文相邻二字 bigram（孤立中文单字保留自身）。
 * 与 lib/memory 口径一致，但此处自带实现，避免跨模块依赖。
 */
export function tokenize(text: string): string[] {
  const out: string[] = [];
  if (!text) return out;
  const lower = text.toLowerCase();
  for (const m of lower.matchAll(ASCII_WORD)) out.push(m[0]);
  for (const m of lower.matchAll(CJK_RUN)) {
    const run = m[0];
    if (run.length === 1) out.push(run);
    else for (let i = 0; i + 1 < run.length; i += 1) out.push(run.slice(i, i + 2));
  }
  return out;
}

interface SkillDoc {
  skill: SkillDefinition;
  fields: Record<FieldName, Set<string>>;
  /** 可展示的命中词候选（name/triggers/tags 原文），用于生成「命中」理由。 */
  terms: string[];
}

function buildDoc(skill: SkillDefinition): SkillDoc {
  return {
    skill,
    fields: {
      name: new Set(tokenize(skill.name)),
      triggers: new Set(skill.triggers.flatMap((t) => tokenize(t))),
      tags: new Set(skill.tags.flatMap((t) => tokenize(t))),
      description: new Set(tokenize(skill.description)),
    },
    terms: [skill.name, ...skill.triggers, ...skill.tags].map((t) => t.trim()).filter(Boolean),
  };
}

/** 命中词展示优先用技能侧原文（「代码」而非 bigram「段代」），取最短包含项。 */
function displayTerm(doc: SkillDoc, token: string): string {
  let best: string | undefined;
  for (const term of doc.terms) {
    if (term.toLowerCase().includes(token) && (best === undefined || term.length < best.length)) {
      best = term;
    }
  }
  return best ?? token;
}

/** 注入正文：设计 §5.1 的 `## 已启用技能` 段落；无命中 → 空串（不注入标题）。 */
export function formatSkillSection(matches: SkillMatch[]): string {
  const valid = matches.filter((m) => m && m.skill);
  if (valid.length === 0) return "";
  const parts = valid.map(
    (m) => `### ${m.skill.name}（${m.reason}）\n${m.skill.instructions.trim()}`,
  );
  return [SECTION_HEADER, ...parts].join("\n\n");
}

export interface RouteContext {
  skills: SkillDefinition[];
  usage?: Record<string, SkillUsage>;
  binding?: SkillBinding;
  /**
   * 该智能体**已分配**的技能 id（技能页的分配是真边界，不只是展示）。
   * 缺省表示不限制——纯池路由（单测/预览）仍可对全量打分。
   * 置顶不能绕过它：`pinned` 只是排序偏好，不是授权。
   */
  allowed?: ReadonlySet<string> | readonly string[];
}

export interface RouteInput {
  query: string;
  topK?: number;
  charBudget?: number;
}

export function routeSkills(ctx: RouteContext, input: RouteInput): SkillMatch[] {
  const topK = input.topK ?? DEFAULT_ROUTE_TOP_K;
  const charBudget = input.charBudget ?? DEFAULT_ROUTE_BUDGET;
  const disabled = new Set(ctx.binding?.disabled ?? []);
  const pinnedIds = ctx.binding?.pinned ?? [];
  const allowed = ctx.allowed ? new Set(ctx.allowed) : null;

  const docs = ctx.skills
    .filter((s) => s.enabled && !disabled.has(s.id) && (!allowed || allowed.has(s.id)))
    .map((s) => buildDoc(s));
  if (docs.length === 0) return [];

  const queryTokens = [...new Set(tokenize(input.query))];
  const idf = (token: string): number => {
    const n = docs.length;
    const df = docs.filter((d) => FIELD_NAMES.some((f) => d.fields[f].has(token))).length;
    // BM25 风格 IDF：池内文档频率越高越不具区分度，但恒为正
    return Math.log(1 + (n - df + 0.5) / (df + 0.5));
  };

  interface Scored {
    skill: SkillDefinition;
    score: number;
    hits: { term: string; weight: number }[];
  }

  const scored: Scored[] = docs.map((doc) => {
    let base = 0;
    const hits: { term: string; weight: number }[] = [];
    for (const token of queryTokens) {
      let weight = 0;
      for (const field of FIELD_NAMES) {
        if (doc.fields[field].has(token)) weight += FIELD_WEIGHTS[field];
      }
      if (weight <= 0) continue;
      const contribution = weight * idf(token);
      base += contribution;
      hits.push({ term: displayTerm(doc, token), weight: contribution });
    }
    const used = ctx.usage?.[doc.skill.id]?.count ?? 0;
    const score = base * (1 + USAGE_STEP * Math.min(used, USAGE_CAP));
    return { skill: doc.skill, score, hits };
  });

  const pinned: SkillMatch[] = [];
  const ranked: Scored[] = [];
  for (const s of scored) {
    if (pinnedIds.includes(s.skill.id)) {
      pinned.push({ skill: s.skill, score: round(s.score), reason: "用户置顶" });
    } else if (s.score > 0) {
      s.hits.sort((a, b) => b.weight - a.weight);
      ranked.push(s);
    }
  }
  // 分数降序；同分按名称稳定排序，保证结果可预期
  ranked.sort((a, b) => b.score - a.score || a.skill.name.localeCompare(b.skill.name));

  const accepted: SkillMatch[] = [];
  // pinned 先入且不受 top-K 限制，但仍受总预算约束（超预算时截断正文）
  for (const match of pinned) {
    if (fits([...accepted, match], charBudget)) accepted.push(match);
    else {
      const truncated = truncateToFit(accepted, match, charBudget);
      if (truncated) accepted.push(truncated);
    }
  }

  let rankedUsed = 0;
  for (const s of ranked) {
    if (rankedUsed >= topK) break;
    const match: SkillMatch = {
      skill: s.skill,
      score: round(s.score),
      reason: `命中：${dedupe(s.hits.slice(0, 3).map((h) => h.term)).join(" / ")}`,
    };
    if (fits([...accepted, match], charBudget)) {
      accepted.push(match);
      rankedUsed += 1;
    }
  }
  return accepted;
}

function round(score: number): number {
  return Math.round(score * 1000) / 1000;
}

function dedupe(items: string[]): string[] {
  return [...new Set(items)];
}

function fits(matches: SkillMatch[], charBudget: number): boolean {
  return formatSkillSection(matches).length <= charBudget;
}

/** 预算不足时把置顶技能的正文截断到刚好放下；剩余空间太小则放弃该条。 */
function truncateToFit(
  accepted: SkillMatch[],
  match: SkillMatch,
  charBudget: number,
): SkillMatch | null {
  const withEmpty = formatSkillSection([
    ...accepted,
    { ...match, skill: { ...match.skill, instructions: "" } },
  ]).length;
  // withEmpty 已含标题/分割/标题行开销，再留 1 个字符给省略号
  const available = charBudget - withEmpty - 1;
  if (available < MIN_TRUNCATED_INSTRUCTIONS) return null;
  const instructions = `${match.skill.instructions.trim().slice(0, available)}…`;
  return { ...match, skill: { ...match.skill, instructions } };
}
