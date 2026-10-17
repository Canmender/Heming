import type { EpisodicEntry, SemanticEntry, WorkingTurn } from "./types.js";

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
  items: string[];
}

/** 当前会话焦点：先给一行「焦点」（最近 2 条用户文本），再按时间先后列最近轮次。 */
function workingItems(turns: WorkingTurn[]): string[] {
  if (!turns.length) return [];
  const items: string[] = [];
  const asked = turns.map((turn) => turn.userText).filter((text) => !!text);
  if (asked.length) items.push(`焦点：${asked.slice(-FOCUS_TURNS).join("；")}`);
  for (const turn of turns) {
    if (turn.userText) items.push(`用户：${turn.userText}`);
    if (turn.assistantText) items.push(`助手：${turn.assistantText}`);
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
      items: (recalled.semantic ?? []).map((entry) => `${entry.key}：${entry.value}`),
    },
    {
      key: "episodic",
      heading: MEMORY_HEADINGS.episodic,
      items: (recalled.episodic ?? []).map(
        (entry) => `${String(entry.at ?? "").slice(0, 10)}：${entry.summary}`,
      ),
    },
    { key: "working", heading: MEMORY_HEADINGS.working, items: workingItems(recalled.working ?? []) },
  ];
  return candidates
    .map((group) => ({ ...group, items: group.items.filter(meaningful) }))
    .filter((group) => group.items.length > 0);
}

/** 逐条填充：额度不足时截断当前条目并停止，而不是整段丢弃。 */
function fillItems(items: string[], budget: number): { lines: string[]; used: number } {
  const lines: string[] = [];
  let used = 0;
  for (const item of items) {
    const remain = budget - used;
    if (remain < MIN_ITEM_CHARS + ITEM_OVERHEAD) break;
    const text = truncate(item, remain - ITEM_OVERHEAD);
    lines.push(`- ${text}`);
    used += text.length + ITEM_OVERHEAD;
    if (text.length < item.length) break; // 已截断 → 额度用尽
  }
  return { lines, used };
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
 * 格式化为可追加在原系统提示词之后的记忆段：
 * 总长 ≤ 1200 字符，按语义 40% / 情景 40% / 焦点 20% 分配并顺延未用额度，
 * 每条超长的行按剩余额度截断（以「…」收尾）。三层全空 → 返回空串。
 */
export function formatMemorySection(recalled: Recalled): string {
  const groups = buildGroups(recalled);
  if (!groups.length) return "";

  const skeleton = render(groups.map((group) => ({ heading: group.heading, lines: [] })));
  const pool = Math.max(0, MEMORY_CHAR_BUDGET - skeleton.length);
  const shares: Record<Group["key"], number> = {
    semantic: pool * MEMORY_BUDGET_RATIO.semantic,
    episodic: pool * MEMORY_BUDGET_RATIO.episodic,
    working: pool * MEMORY_BUDGET_RATIO.working,
  };

  const rendered: { heading: string; lines: string[] }[] = [];
  let leftover = 0;
  for (const key of ORDER) {
    const share = shares[key] + leftover;
    leftover = 0;
    const group = groups.find((candidate) => candidate.key === key);
    if (!group) {
      leftover = share; // 该层无内容 → 额度顺延给下一层
      continue;
    }
    const { lines, used } = fillItems(group.items, share);
    if (!lines.length) {
      leftover = share; // 一条都放不下（预算极小）→ 连标题都不出
      continue;
    }
    leftover = Math.max(0, share - used);
    rendered.push({ heading: group.heading, lines });
  }
  return rendered.length ? render(rendered) : "";
}
