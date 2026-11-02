import type {
  TeamUsageByDay,
  TeamUsageByModel,
  TeamUsageRange,
  TeamUsageResponse,
  TeamUsageRankRow,
  TeamUsageSelf,
} from "@heming/shared";
import type { TeamUsageRow } from "./store.js";

/**
 * 团队用量的**聚合**（纯逻辑，双实现共用）。
 *
 * 为什么聚合放在这里而不是 store：内存与 SQLite 两个实现只能保证「同样的行读出来」，
 * 排行/明细的口径必须只有一份，否则换个存储口径就变了。store 只负责按区间读行。
 *
 * 三条口径：
 * - `tokens: null` 是「未上报」而不是 0（d.32）：不参与求和，单独计数；
 * - 区间是**自然日闭区间**，日期键由客户端按本地时区给（服务端不猜时区）；
 * - 全站排行只给聚合数与显示名——模型名、连接名都不出现在别人的排行里。
 */

export const USAGE_RANGE_DAYS: Record<TeamUsageRange, number> = { "7d": 7, "30d": 30 };

/** UTC 自然日键（服务端兜底：客户端正常会传本地 `to`，跨时区不会劈叉）。 */
export function dayKeyUtc(now: Date = new Date()): string {
  return `${now.getUTCFullYear()}-${String(now.getUTCMonth() + 1).padStart(2, "0")}-${String(
    now.getUTCDate(),
  ).padStart(2, "0")}`;
}

/** `YYYY-MM-DD` → 该日 UTC 零点毫秒；非法返回 null（不抛）。 */
export function parseDayKey(key: string): number | null {
  if (!/^\d{4}-\d{2}-\d{2}$/.test(key)) return null;
  const [y, m, d] = key.split("-").map(Number);
  const ms = Date.UTC(y, m - 1, d);
  if (!Number.isFinite(ms)) return null;
  // 反查校验：2026-02-31 这类会滚到下个月，必须判非法而不是静默改写。
  const back = dayKeyUtc(new Date(ms));
  return back === key ? ms : null;
}

export function addDays(key: string, delta: number): string {
  const ms = parseDayKey(key);
  if (ms === null) return key;
  return dayKeyUtc(new Date(ms + delta * 86_400_000));
}

/** 区间边界：`to` 缺省用 UTC 今天；`from = to - (days - 1)`（含今天共 N 天）。 */
export function usageRangeBounds(
  range: TeamUsageRange,
  to: string = dayKeyUtc(),
): { from: string; to: string } {
  const days = USAGE_RANGE_DAYS[range];
  return { from: addDays(to, -(days - 1)), to };
}

/** 闭区间内的全部日期键（画逐日用量用；升序）。 */
export function daysBetween(from: string, to: string): string[] {
  const start = parseDayKey(from);
  const end = parseDayKey(to);
  if (start === null || end === null || end < start) return [];
  const out: string[] = [];
  // 上限护栏：无论入参多离谱，最多列 400 天（防止内存/渲染被拖死）。
  for (let i = 0, ms = start; ms <= end && i < 400; i += 1, ms += 86_400_000) {
    out.push(dayKeyUtc(new Date(ms)));
  }
  return out;
}

function inRange(row: TeamUsageRow, from: string, to: string): boolean {
  return row.date >= from && row.date <= to;
}

/** 本人明细：按模型聚合 + 逐日聚合（未上报单独计数，不进合计）。 */
export function buildSelfUsage(
  rows: TeamUsageRow[],
  from: string,
  to: string,
): TeamUsageSelf {
  const mine = rows.filter((row) => row.date >= from && row.date <= to);
  const byModelMap = new Map<string, TeamUsageByModel>();
  const byDayMap = new Map<string, TeamUsageByDay>();
  const dayKeys = daysBetween(from, to);
  for (const day of dayKeys) byDayMap.set(day, { date: day, tokens: 0, unreported: 0 });

  let total = 0;
  let unreported = 0;
  for (const row of mine) {
    const tokens = typeof row.tokens === "number" ? row.tokens : null;
    if (tokens === null) unreported += row.unreported;
    else total += tokens;

    const model = byModelMap.get(row.model) ?? {
      model: row.model,
      tokens: 0,
      unreported: 0,
      connections: [],
    };
    if (tokens !== null) model.tokens += tokens;
    model.unreported += row.unreported;
    for (const name of row.connections) {
      if (model.connections.length >= 5) break;
      if (!model.connections.includes(name)) model.connections.push(name);
    }
    byModelMap.set(row.model, model);

    const day = byDayMap.get(row.date) ?? { date: row.date, tokens: 0, unreported: 0 };
    if (tokens !== null) day.tokens += tokens;
    day.unreported += row.unreported;
    byDayMap.set(row.date, day);
  }

  return {
    total,
    unreported,
    byModel: [...byModelMap.values()].sort(
      (a, b) => b.tokens - a.tokens || a.model.localeCompare(b.model),
    ),
    byDay: [...byDayMap.values()].sort((a, b) => (a.date < b.date ? -1 : a.date > b.date ? 1 : 0)),
  };
}

/**
 * 全站排行：每个成员一行聚合数。
 *
 * 只给 `tokens / unreported / days` 与显示名——模型、连接名、逐日明细都不外露，
 * 即便对方在团队页看到排行，也反推不出「用什么模型、连的哪个 Key」。
 */
export function buildUsageRanking(
  rows: TeamUsageRow[],
  from: string,
  to: string,
  names: Map<string, string>,
): TeamUsageRankRow[] {
  const byActor = new Map<string, { tokens: number; unreported: number; dates: Set<string> }>();
  for (const row of rows) {
    if (!inRange(row, from, to)) continue;
    const entry = byActor.get(row.actorId) ?? { tokens: 0, unreported: 0, dates: new Set<string>() };
    if (typeof row.tokens === "number") entry.tokens += row.tokens;
    entry.unreported += row.unreported;
    entry.dates.add(row.date);
    byActor.set(row.actorId, entry);
  }
  return [...byActor.entries()]
    .map(([userId, entry]) => ({
      userId,
      displayName: names.get(userId) ?? "成员",
      tokens: entry.tokens,
      unreported: entry.unreported,
      days: entry.dates.size,
    }))
    .sort((a, b) => b.tokens - a.tokens || b.days - a.days || a.displayName.localeCompare(b.displayName))
    .slice(0, 100);
}

/** 汇总成 `GET /api/team/usage` 的响应体（本人明细 + 全站排行）。 */
export function summarizeTeamUsage(
  rows: TeamUsageRow[],
  opts: {
    viewerId: string;
    range: TeamUsageRange;
    from: string;
    to: string;
    names: Map<string, string>;
  },
): TeamUsageResponse {
  const { viewerId, range, from, to, names } = opts;
  const selfRows = rows.filter((row) => row.actorId === viewerId);
  return {
    range,
    from,
    to,
    self: buildSelfUsage(selfRows, from, to),
    ranking: buildUsageRanking(rows, from, to, names),
  };
}
