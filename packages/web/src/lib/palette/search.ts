import type { TeamMember } from "@heming/shared";
import { skillPool } from "../skills/index.js";
import {
  formatInfohubTime,
  type InfohubSearchHit,
} from "../infohub/client.js";
import { PALETTE_ACTIONS, findPaletteAction, type PaletteActionId } from "./actions.js";
import { PALETTE_PAGES, findPalettePage, type PalettePage } from "./pages.js";
import { PALETTE_SETTINGS, findPaletteSetting, type PaletteSettingSection } from "./settings.js";
import type { RecentEntry } from "./recent.js";
import type { Page } from "../../store/ui.js";

/**
 * 命令面板的检索与分组（纯函数，便于单测）。
 *
 * 两条独立职责：
 * 1. `searchAllDetailed` / `searchAll`：**保持旧行为不变**（成员 + 技能），
 *    命令面板的成员/技能结果与旧版逐字一致，回归用例直接复用；
 * 2. `buildEmptyGroups` / `searchPalette`：新版分组检索，页面 / 设置 / 动作 /
 *    成员 / 技能 / 归档**分组不混排**。
 */

/** 成员 / 技能 / 归档的旧版结果形状（命令面板仍在用）。 */
export type SearchResult =
  | { kind: "member"; id: string; name: string; username: string; avatar?: string; detail: string }
  | { kind: "skill"; id: string; name: string; detail: string }
  | { kind: "archive"; id: string; name: string; detail: string; hit: InfohubSearchHit };

export interface SearchOutcome {
  /** 截断后实际展示的结果（成员最多 8、技能最多 5）。 */
  results: SearchResult[];
  /** 命中总数（含被上限截掉的），用于「还有 N 条」提示。 */
  total: number;
}

const MEMBER_LIMIT = 8;
const SKILL_LIMIT = 5;
const ARCHIVE_LIMIT = 5;

/** 相对活跃度：在线 › 最近活跃 › 从未登录。 */
export function presenceText(m: TeamMember): string {
  if (m.online) return "在线";
  if (!m.lastSeenAt) return "从未登录";
  const diff = Math.max(0, Date.now() - Date.parse(m.lastSeenAt));
  if (!Number.isFinite(diff)) return "最近活跃";
  if (diff < 3_600_000) return `${Math.max(1, Math.floor(diff / 60_000))} 分钟前活跃`;
  if (diff < 86_400_000) return `${Math.floor(diff / 3_600_000)} 小时前活跃`;
  return `${Math.floor(diff / 86_400_000)} 天前活跃`;
}

/** 把成员翻成一条结果。 */
function memberResult(m: TeamMember): Extract<SearchResult, { kind: "member" }> {
  return {
    kind: "member",
    id: m.user.id,
    name: m.user.displayName,
    username: m.user.username,
    avatar: m.user.avatar,
    detail: `@${m.user.username} · ${presenceText(m)}`,
  };
}

/** 归档命中 → 一行结果（标题取正文/摘要前 48 字）。 */
export function archiveResult(hit: InfohubSearchHit): SearchResult {
  const text = (hit.content || hit.snippet || "").replace(/<<|>>/g, "").replace(/\s+/g, " ").trim();
  const name = Array.from(text).slice(0, 48).join("") || "（空消息）";
  const source = hit.source === "qq" ? "QQ" : hit.source === "wechat" ? "微信" : hit.source;
  return {
    kind: "archive",
    id: `archive-${hit.id}`,
    name,
    detail: `${source} · ${hit.convName} · ${formatInfohubTime(hit.ts, true)}`,
    hit,
  };
}

/**
 * 旧版搜索（成员 + 技能）：排序规则原样保留 —— 前缀命中优先于包含命中；
 * 同前缀内在线成员优先（找成员时「现在在线的那个人」通常就是要找的人）。
 */
export function searchAllDetailed(keyword: string, members: TeamMember[]): SearchOutcome {
  const q = keyword.trim().toLowerCase();
  if (!q) return { results: [], total: 0 };

  const memberMatches = members
    .filter(
      (m) =>
        m.user.displayName.toLowerCase().includes(q) || m.user.username.toLowerCase().includes(q),
    )
    .map(memberResult)
    .sort((a, b) => {
      const aName = a.name.toLowerCase();
      const bName = b.name.toLowerCase();
      const aPrefix = aName.startsWith(q) ? 0 : 1;
      const bPrefix = bName.startsWith(q) ? 0 : 1;
      if (aPrefix !== bPrefix) return aPrefix - bPrefix;
      const aMember = members.find((m) => m.user.id === a.id);
      const bMember = members.find((m) => m.user.id === b.id);
      if (aMember && bMember && aMember.online !== bMember.online) {
        return aMember.online ? -1 : 1;
      }
      return a.name.localeCompare(b.name, "zh");
    });

  const skillMatches: SearchResult[] = skillPool
    .list()
    .filter(
      (s) =>
        s.name.toLowerCase().includes(q) || (s.description ?? "").toLowerCase().includes(q),
    )
    .map((s) => ({
      kind: "skill" as const,
      id: s.id,
      name: s.name,
      detail: s.description ? s.description.slice(0, 40) : "技能",
    }));

  const results = [...memberMatches.slice(0, MEMBER_LIMIT), ...skillMatches.slice(0, SKILL_LIMIT)];
  return { results, total: memberMatches.length + skillMatches.length };
}

export function searchAll(keyword: string, members: TeamMember[]): SearchResult[] {
  return searchAllDetailed(keyword, members).results;
}

/* ------------------------------ 新版分组检索 ------------------------------ */

export type PaletteItemKind = "page" | "setting" | "action" | "member" | "skill" | "archive";

/**
 * 一条面板结果。
 *
 * 刻意用「一个宽结构 + kind 判别」而不是六个独立接口：面板渲染与键盘游标都在
 * 一个扁平数组上工作，统一形状能少一半分支；执行时按 kind 取对应字段。
 */
export interface PaletteItem {
  kind: PaletteItemKind;
  /** 全局唯一 id（`<kind>:<key>`），用于 React key、aria-activedescendant 与最近使用。 */
  id: string;
  name: string;
  detail: string;
  /** page 项：目标页面。 */
  page?: Page;
  /** setting 项：设置分区 id。 */
  tab?: string;
  /** action 项：动作 id。 */
  actionId?: PaletteActionId;
  /** page 项的 Alt 快捷键数字（无则 undefined）。 */
  digit?: string;
  /** member 项：成员 userId（执行时聚焦用）。 */
  userId?: string;
  /** member 项：头像与用户名。 */
  avatar?: string;
  username?: string;
  /** archive 项：原始命中（执行时只投递检索词，不复制结果页）。 */
  hit?: InfohubSearchHit;
}

export type PaletteGroupId = "recent" | "page" | "setting" | "action" | "member" | "skill" | "archive";

export interface PaletteGroup {
  id: PaletteGroupId;
  label: string;
  items: PaletteItem[];
  /** 未截断的命中总数；> items.length 时面板显示「还有 N 条」。 */
  total?: number;
}

export const GROUP_LABELS: Record<PaletteGroupId, string> = {
  recent: "最近使用",
  page: "页面跳转",
  setting: "设置",
  action: "常用动作",
  member: "团队成员",
  skill: "技能",
  archive: "本机归档",
};

/** 检索时各组上限：命令面板是「快速找」，不要一屏被同类结果占满。 */
export const GROUP_LIMITS: Record<PaletteGroupId, number> = {
  recent: 5,
  page: 8,
  setting: 5,
  action: 4,
  member: MEMBER_LIMIT,
  skill: SKILL_LIMIT,
  archive: ARCHIVE_LIMIT,
};

/** 检索结果的组顺序（空查询只用前三个：最近 / 页面 / 动作）。 */
const SEARCH_ORDER: PaletteGroupId[] = ["page", "setting", "action", "member", "skill", "archive"];
const EMPTY_ORDER: PaletteGroupId[] = ["recent", "page", "action"];

export function pageItem(p: PalettePage): PaletteItem {
  return {
    kind: "page",
    id: `page:${p.page}`,
    name: p.label,
    detail: p.description,
    page: p.page,
    digit: p.digit,
  };
}

export function settingItem(s: PaletteSettingSection): PaletteItem {
  return {
    kind: "setting",
    id: `setting:${s.tab}`,
    name: s.label,
    detail: s.description,
    tab: s.tab,
  };
}

export function actionItem(a: (typeof PALETTE_ACTIONS)[number]): PaletteItem {
  return {
    kind: "action",
    id: `action:${a.id}`,
    name: a.label,
    detail: a.description,
    actionId: a.id,
  };
}

export function memberItem(m: TeamMember): PaletteItem {
  const r = memberResult(m);
  return {
    kind: "member",
    id: `member:${r.id}`,
    name: r.name,
    detail: r.detail,
    userId: r.id,
    avatar: r.avatar,
    username: r.username,
  };
}

export function skillItem(s: ReturnType<typeof skillPool.list>[number]): PaletteItem {
  return {
    kind: "skill",
    id: `skill:${s.id}`,
    name: s.name,
    detail: s.description ? s.description.slice(0, 40) : "技能",
  };
}

export function archiveItem(hit: InfohubSearchHit): PaletteItem {
  const r = archiveResult(hit);
  return { kind: "archive", id: r.id, name: r.name, detail: r.detail, hit };
}

/**
 * 空查询的分组：最近使用（≤5，本机记录）→ 页面跳转（13）→ 常用动作（4）。
 *
 * 最近使用里若某条已不存在（页面被删/动作下线），**静默跳过**而不是渲染一条点了没反应的项。
 */
export function buildEmptyGroups(recent: RecentEntry[]): PaletteGroup[] {
  const groups: PaletteGroup[] = [];
  const recentItems: PaletteItem[] = [];
  for (const entry of recent) {
    if (entry.kind === "page") {
      const p = findPalettePage(entry.id);
      if (p) recentItems.push(pageItem(p));
    } else if (entry.kind === "setting") {
      const s = findPaletteSetting(entry.id);
      if (s) recentItems.push(settingItem(s));
    } else {
      const a = findPaletteAction(entry.id);
      if (a) recentItems.push(actionItem(a));
    }
    if (recentItems.length >= GROUP_LIMITS.recent) break;
  }
  if (recentItems.length) {
    groups.push({ id: "recent", label: GROUP_LABELS.recent, items: recentItems });
  }
  groups.push({ id: "page", label: GROUP_LABELS.page, items: PALETTE_PAGES.map(pageItem) });
  groups.push({ id: "action", label: GROUP_LABELS.action, items: PALETTE_ACTIONS.map(actionItem) });
  return groups;
}

/** 匹配：名字/描述/额外关键词任一包含即命中（大小写不敏感）。 */
function matches(q: string, name: string, detail: string, keywords: string[] = []): boolean {
  return (
    name.toLowerCase().includes(q) ||
    detail.toLowerCase().includes(q) ||
    keywords.some((k) => k.toLowerCase().includes(q))
  );
}

/** 组内排序：前缀命中优先，其次按名称本地化排序。 */
function rank<T extends { name: string }>(items: T[], q: string): T[] {
  return [...items].sort((a, b) => {
    const ap = a.name.toLowerCase().startsWith(q) ? 0 : 1;
    const bp = b.name.toLowerCase().startsWith(q) ? 0 : 1;
    if (ap !== bp) return ap - bp;
    return a.name.localeCompare(b.name, "zh");
  });
}

/**
 * 输入检索：页面名 + 页面描述、设置分区名（含关键词）、动作名、成员、技能、归档。
 *
 * 分组顺序固定（页面 → 设置 → 动作 → 成员 → 技能 → 归档），**组间不混排**；
 * 空组直接不出现，避免一屏全是标题。
 */
export function searchPalette(
  keyword: string,
  ctx: { members: TeamMember[]; archiveHits: InfohubSearchHit[] },
): PaletteGroup[] {
  const q = keyword.trim().toLowerCase();
  if (!q) return buildEmptyGroups([]);

  const found = new Map<PaletteGroupId, PaletteItem[]>();

  found.set(
    "page",
    // 先映射成面板项再排序：目录对象上的字段叫 label，排序要的是统一的 name。
    rank(
      PALETTE_PAGES.filter((p) => matches(q, p.label, p.description)).map(pageItem),
      q,
    ),
  );
  found.set(
    "setting",
    rank(
      PALETTE_SETTINGS.filter((s) => matches(q, s.label, s.description, s.keywords)).map(settingItem),
      q,
    ),
  );
  found.set(
    "action",
    rank(
      PALETTE_ACTIONS.filter((a) => matches(q, a.label, a.description, a.keywords)).map(actionItem),
      q,
    ),
  );
  found.set("member", searchAllDetailed(q, ctx.members).results.filter((r) => r.kind === "member").map((r) => {
    const member = ctx.members.find((m) => m.user.id === r.id);
    return member ? memberItem(member) : { kind: "member" as const, id: `member:${r.id}`, name: r.name, detail: r.detail };
  }));
  found.set("skill", searchAllDetailed(q, []).results.filter((r) => r.kind === "skill").map((r) => ({
    kind: "skill" as const,
    id: `skill:${r.id}`,
    name: r.name,
    detail: r.detail,
  })));
  found.set("archive", ctx.archiveHits.map(archiveItem));

  const groups: PaletteGroup[] = [];
  const totals: Partial<Record<PaletteGroupId, number>> = {
    page: PALETTE_PAGES.filter((p) => matches(q, p.label, p.description)).length,
    setting: PALETTE_SETTINGS.filter((s) => matches(q, s.label, s.description, s.keywords)).length,
    action: PALETTE_ACTIONS.filter((a) => matches(q, a.label, a.description, a.keywords)).length,
    // 成员/技能的命中总数要自己数：`searchAllDetailed` 只给「成员+技能」合计，
    // 且它会把结果截断，不能反推每类各有多少。
    member: ctx.members.filter(
      (m) =>
        m.user.displayName.toLowerCase().includes(q) || m.user.username.toLowerCase().includes(q),
    ).length,
    skill: skillPool
      .list()
      .filter((s) => s.name.toLowerCase().includes(q) || (s.description ?? "").toLowerCase().includes(q))
      .length,
    archive: ctx.archiveHits.length,
  };
  for (const id of SEARCH_ORDER) {
    const all = found.get(id) ?? [];
    const items = all.slice(0, GROUP_LIMITS[id]);
    if (items.length) groups.push({ id, label: GROUP_LABELS[id], items, total: totals[id] ?? all.length });
  }
  return groups;
}

/** 扁平化成可键盘游标的一维数组（组标题不参与）。 */
export function flattenGroups(groups: PaletteGroup[]): PaletteItem[] {
  return groups.flatMap((g) => g.items);
}

export type { Page };
