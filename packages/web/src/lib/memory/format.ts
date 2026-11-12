import type { SupersededInfo, VaultRecallInfo } from "./recall.js";
import type { EpisodicEntry, SemanticEntry, WorkingTurn } from "./types.js";
import { VAULT_INJECT_PER_NOTE_CHARS } from "../vault/types.js";

/**
 * 记忆注入格式（设计 §4）：三段标题 + 逐条要点 + 页脚声明。
 * 空召回返回空串（零注入，原系统提示词保持原样）。
 */

/** 注入总字符预算。 */
export const MEMORY_CHAR_BUDGET = 1200;
/** 三层预算占比：语义 40% / 情景 40% / 焦点 20%（未用额度顺延给下一层）。 */
export const MEMORY_BUDGET_RATIO = { semantic: 0.4, episodic: 0.4, working: 0.2 } as const;
/** 单条至少保留的字符数：剩余预算低于此值就不再开新条目。 */
const MIN_ITEM_CHARS = 10;
/** 条目行前缀与换行的固定开销（"- " 两字符 + 换行一字符）。 */
const ITEM_OVERHEAD = 3;
/** 焦点行取最近几条用户文本。 */
const FOCUS_TURNS = 2;

export const MEMORY_HEADINGS = {
  semantic: "## 长期记忆（语义）",
  episodic: "## 相关情景记忆",
  working: "## 当前会话焦点",
} as const;

export const MEMORY_FOOTER =
  "> 以上记忆仅作参考；与用户当前表述冲突时，以当前表述为准。不要向用户复述本段结构。";

const ORDER = ["semantic", "episodic", "working"] as const;

type Recalled = {
  semantic?: SemanticEntry[];
  episodic?: EpisodicEntry[];
  working?: WorkingTurn[];
};

interface Group {
  key: (typeof ORDER)[number];
  heading: string;
  items: MemoryItem[];
}

/** 记忆层（注入侧口径：只有这三层，覆盖信息在 recall 侧）。 */
export type MemoryLayer = (typeof ORDER)[number];

/** 一条候选注入项：`id` 指向来源条目，`text` 是未截断的原文。 */
type MemoryItem = { id: string; text: string };

/**
 * 真正进入注入文本的一行。
 *
 * 为什么单独建类型：召回（recall）给的是「取什么」，格式化给的才是「注入了什么」，
 * 两者在预算裁剪处会分叉——被额度砍掉的条目不能算「已注入」，
 * 否则可观测性会把「没带上」 reporting 成「带上了」。
 */
export interface InjectedItem {
  /** 来源条目 id（工作层的焦点行是聚合行，用 `focus` 占位）。 */
  id: string;
  layer: MemoryLayer;
  /** 实际注入的文本（可能已被预算截断）。 */
  content: string;
  /** 是否因预算被截断。 */
  truncated: boolean;
}

/** 格式化 + 注入清单（可观测性用；`text` 与 `formatMemorySection` 逐字一致）。 */
export interface MemoryTrace {
  text: string;
  /** 真进了提示词的行。 */
  injected: InjectedItem[];
  /** 参与分层的**全部**候选文本（含被预算裁掉的），供未注入项也能显示内容。 */
  candidates: { id: string; layer: MemoryLayer; text: string }[];
}

/** 当前会话焦点：先给一行「焦点」（最近 2 条用户文本），再按时间先后列最近轮次。 */
function workingItems(turns: WorkingTurn[]): MemoryItem[] {
  if (!turns.length) return [];
  const items: MemoryItem[] = [];
  const asked = turns.map((turn) => turn.userText).filter((text) => !!text);
  // 焦点行是跨轮聚合行，没有单一来源条目；id 用保留字，UI 据此不去匹配具体记忆卡。
  if (asked.length) items.push({ id: "focus", text: `焦点：${asked.slice(-FOCUS_TURNS).join("；")}` });
  for (const turn of turns) {
    if (turn.userText) items.push({ id: turn.id, text: `用户：${turn.userText}` });
    if (turn.assistantText) items.push({ id: turn.id, text: `助手：${turn.assistantText}` });
  }
  return items;
}

/** 分隔符后为空的行没有信息量（如 key/value 全空），直接丢掉。 */
function meaningful(line: string): boolean {
  const body = line.includes("：") ? line.slice(line.indexOf("：") + 1) : line;
  return body.trim().length > 0;
}

function buildGroups(recalled: Recalled): Group[] {
  const candidates: Group[] = [
    {
      key: "semantic",
      heading: MEMORY_HEADINGS.semantic,
      items: (recalled.semantic ?? []).map((entry) => ({
        id: entry.id,
        // 知识库条目（d.114）：必须让模型看出「这是笔记摘录，不是用户档案」，
        // 否则它会把某篇文档里的一句话当成关于用户的既定事实。
        // 单条摘要按注入预算上限（400 字）截断，整轮仍受 1200 字总预算约束。
        text:
          entry.source === "vault"
            ? `来自知识库《${entry.vault?.rel ?? entry.key}》：${truncate(entry.value, VAULT_INJECT_PER_NOTE_CHARS)}`
            : `${entry.key}：${entry.value}`,
      })),
    },
    {
      key: "episodic",
      heading: MEMORY_HEADINGS.episodic,
      items: (recalled.episodic ?? []).map((entry) => ({
        id: entry.id,
        text: `${String(entry.at ?? "").slice(0, 10)}：${entry.summary}`,
      })),
    },
    { key: "working", heading: MEMORY_HEADINGS.working, items: workingItems(recalled.working ?? []) },
  ];
  return candidates
    .map((group) => ({ ...group, items: group.items.filter((item) => meaningful(item.text)) }))
    .filter((group) => group.items.length > 0);
}

/** 逐条填充：额度不足时截断当前条目并停止，而不是整段丢弃。层名由调用方补。 */
function fillItems(
  items: MemoryItem[],
  budget: number,
): { lines: string[]; used: number; injected: Omit<InjectedItem, "layer">[] } {
  const lines: string[] = [];
  const injected: Omit<InjectedItem, "layer">[] = [];
  let used = 0;
  for (const item of items) {
    const remain = budget - used;
    if (remain < MIN_ITEM_CHARS + ITEM_OVERHEAD) break;
    const text = truncate(item.text, remain - ITEM_OVERHEAD);
    lines.push(`- ${text}`);
    injected.push({ id: item.id, content: text, truncated: text.length < item.text.length });
    used += text.length + ITEM_OVERHEAD;
    if (text.length < item.text.length) break; // 已截断 → 额度用尽
  }
  return { lines, used, injected };
}

function truncate(text: string, max: number): string {
  if (text.length <= max) return text;
  return `${text.slice(0, Math.max(0, max - 1))}…`;
}

/** 固定骨架（标题 + 分隔空行 + 页脚）与内容共用同一渲染函数，预算才能算准。 */
function render(groups: { heading: string; lines: string[] }[]): string {
  const out: string[] = [];
  for (const group of groups) {
    out.push(group.heading);
    for (const line of group.lines) out.push(line);
    out.push(""); // 段间空行（设计 §4 的三段排版）
  }
  out.push(MEMORY_FOOTER);
  return out.join("\n");
}

/**
 * 知识库层在本次注入里的参与情况（d.114）。
 *
 * 为什么单独一行统计而不混进 `counts`：`counts` 的语义是「三层召回各几条」，
 * 知识库是语义层里的一类**指针条目**，混进去会让既有三层口径失真；
 * 单独一块既保持老字段不变，又能让记忆页看出「关闭/未接入/被预算截掉」。
 */
export interface VaultInjectStats extends VaultRecallInfo {
  /** 真有知识库条目进了提示词的行数（可小于 `picked`：预算可能截掉）。 */
  injected: number;
}

/** 一次生成的注入旁路：召回与注入的差集 + 打分与覆盖信息（可观测性的数据结构）。 */
export interface MemoryObservability {
  /** 实际注入的每一行（含来源 id、是否被截断）。 */
  injected: InjectedItem[];
  /** 召回到了但没注入的候选及原因。 */
  dropped: MemoryDrop[];
  /** 条目 id → 召回打分（语义 + 情景合并）。 */
  scores: Record<string, number>;
  /**
   * 条目 id → 个性化乘子（d.28），**只收录 >1 的那些**。
   * 与 `scores` 的关系：`scores` 已经是乘完之后的最终分，这里给的是「其中提了多少」，
   * UI 用它解释「为什么这条排在前面」，不重新参与排序。
   */
  boosts: Record<string, number>;
  /** 被同主题键新值覆盖掉的旧语义条目。 */
  superseded: SupersededInfo[];
  /** 三层召回条数（注入前）——与 `injected.length` 可以不相等。 */
  counts: { semantic: number; episodic: number; working: number };
  /**
   * 知识库层参与情况（**可选**：没有知识库条目且调用方没传选项时缺省，
   * 既有调用点与用例的形状不变）。
   */
  vault?: VaultInjectStats;
  /**
   * 本次生效的智能体记忆偏好（**可选**：调用方没传偏好时缺省，形状不变）。
   * 关掉的层会在 `skippedByPrefs` 里留下人话原因——否则用户只会觉得「记忆没了」。
   */
  prefs?: { shortTerm: boolean; longTerm: boolean; personalDb: boolean };
  /** 召回失败的原因（为空 = 没出错；有值 = 这轮没注入记忆，且能说清为什么）。 */
  error?: string;
  /** 因偏好关闭而被整层跳过的说明（空数组表示没有因偏好跳过任何层）。 */
  skippedByPrefs?: string[];
}

/** 召回了却没注入的原因：被同键新值覆盖（正常）／被预算裁掉（额度不够）。 */
export interface MemoryDrop {
  id: string;
  layer: MemoryLayer;
  reason: "budget" | "superseded";
  /** 原条目文本（UI 只拿 id 没法解释「哪条被裁了」）。 */
  content?: string;
}

/**
 * 由召回结果算出注入旁路（召回 → 格式化 → 差集归因一步到位）。
 *
 * 为什么放在格式化这一层：只有这里同时知道「候选」和「实际进了文本的行」，
 * 把差集留给调用方算，等于把「召回 ≠ 注入」这个口径散落到每个 UI 里各写一遍。
 */
export function summarizeInjection(
  recalled: Recalled & {
    scores?: Record<string, number>;
    boosts?: Record<string, number>;
    superseded?: SupersededInfo[];
    vault?: VaultRecallInfo;
  },
): MemoryTrace & { observability: MemoryObservability } {
  const trace = formatMemorySectionWithTrace(recalled);
  const semantic = recalled.semantic ?? [];
  const episodic = recalled.episodic ?? [];
  const working = recalled.working ?? [];
  const superseded = recalled.superseded ?? [];
  const injectedIds = new Set(trace.injected.map((item) => item.id));
  const loserIds = new Set(superseded.map((info) => info.loserId));
  // 候选文本直接复用格式化层分组出来的结果（dropped 也要显示「哪条被裁了」，只给 id 用户看不懂）
  const textById = new Map<string, string>();
  for (const item of trace.candidates) if (!textById.has(item.id)) textById.set(item.id, item.text);
  const dropped: MemoryDrop[] = [];
  const visit = (ids: string[], layer: MemoryLayer) => {
    for (const id of ids) {
      if (injectedIds.has(id)) continue;
      dropped.push({
        id,
        layer,
        reason: loserIds.has(id) ? "superseded" : "budget",
        ...(textById.has(id) ? { content: textById.get(id) } : {}),
      });
    }
  };
  visit(semantic.map((entry) => entry.id), "semantic");
  visit(episodic.map((entry) => entry.id), "episodic");
  visit(working.map((turn) => turn.id), "working");
  // 知识库条目也走「召回 ≠ 注入」口径：picked 里可能有几条被预算截掉，
  // 记忆页要能区分「没纳入」与「纳入了但这次没进提示词」。
  const vaultIds = new Set(semantic.filter((entry) => entry.source === "vault").map((entry) => entry.id));
  const vaultInjected = trace.injected.filter((item) => vaultIds.has(item.id)).length;
  return {
    ...trace,
    observability: {
      injected: trace.injected,
      dropped,
      scores: recalled.scores ?? {},
      boosts: recalled.boosts ?? {},
      superseded,
      counts: { semantic: semantic.length, episodic: episodic.length, working: working.length },
      ...(recalled.vault ? { vault: { ...recalled.vault, injected: vaultInjected } } : {}),
    },
  };
}

/**
 * 格式化为可追加在原系统提示词之后的记忆段，同时给出**注入清单**（可观测性）：
 * 总长 ≤ 1200 字符，按语义 40% / 情景 40% / 焦点 20% 分配并顺延未用额度，
 * 每条超长的行按剩余额度截断（以「…」收尾）。三层全空 → `text` 为空串、清单为空。
 *
 * 清单只包含**真的进了文本的行**：被预算裁掉的候选不在这里，
 * 「召回了几条」与「注入几条」必须由调用方分别读两个数组。
 */
export function formatMemorySectionWithTrace(recalled: Recalled): MemoryTrace {
  const groups = buildGroups(recalled);
  const candidates = groups.flatMap((group) =>
    group.items.map((item) => ({ id: item.id, layer: group.key, text: item.text })),
  );
  if (!groups.length) return { text: "", injected: [], candidates };

  const skeleton = render(groups.map((group) => ({ heading: group.heading, lines: [] })));
  const pool = Math.max(0, MEMORY_CHAR_BUDGET - skeleton.length);
  const shares: Record<Group["key"], number> = {
    semantic: pool * MEMORY_BUDGET_RATIO.semantic,
    episodic: pool * MEMORY_BUDGET_RATIO.episodic,
    working: pool * MEMORY_BUDGET_RATIO.working,
  };

  const rendered: { heading: string; lines: string[] }[] = [];
  const injected: InjectedItem[] = [];
  let leftover = 0;
  for (const key of ORDER) {
    const share = shares[key] + leftover;
    leftover = 0;
    const group = groups.find((candidate) => candidate.key === key);
    if (!group) {
      leftover = share; // 该层无内容 → 额度顺延给下一层
      continue;
    }
    const { lines, used, injected: layerItems } = fillItems(group.items, share);
    if (!lines.length) {
      leftover = share; // 一条都放不下（预算极小）→ 连标题都不出
      continue;
    }
    leftover = Math.max(0, share - used);
    rendered.push({ heading: group.heading, lines });
    for (const item of layerItems) injected.push({ ...item, layer: key });
  }
  return { text: rendered.length ? render(rendered) : "", injected, candidates };
}

/** 只要文本的调用方（拼装提示词）用的薄封装，行为与 d.26 逐字一致。 */
export function formatMemorySection(recalled: Recalled): string {
  return formatMemorySectionWithTrace(recalled).text;
}
