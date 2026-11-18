/**
 * 额度走向：内核 `quota history --json` 的历史读数。
 *
 * 内核每隔一段时间为每个账号的每个窗口记一个点（时间 + 还剩多少百分比、
 * 以及这一轮什么时候重置），这里把这些点画成一条线，并回答线本身答不出的问题：
 * 照当前这个速度，是会在重置前用完，还是撑得过这次重置。
 *
 * 拟合只取「最近一次回升之后」的点，且至少要三个点、跨度一小时：
 * 把一周前的老读数混进当前这一轮，斜率会被历史平均抹平，等于没算。
 */

import { agentName, windowName } from "./magpieQuota.js";

export interface QuotaPoint {
  at: string;
  left: number;
  start?: string;
  resetsAt?: string;
}

export interface QuotaLine {
  name: string;
  points: QuotaPoint[];
}

export interface QuotaHistoryRow {
  provider: string;
  user?: string;
  lines: QuotaLine[];
}

const finite = (value: unknown): value is number => typeof value === "number" && Number.isFinite(value);

function text(value: unknown): string {
  return typeof value === "string" ? value.trim() : "";
}

function parsePoint(value: unknown): QuotaPoint | null {
  if (!value || typeof value !== "object") return null;
  const item = value as Record<string, unknown>;
  const at = text(item.at);
  if (!at) return null;
  if (!finite(item.left)) return null;
  const point: QuotaPoint = { at, left: item.left };
  const start = text(item.start);
  const resetsAt = text(item.resetsAt);
  if (start) point.start = start;
  if (resetsAt) point.resetsAt = resetsAt;
  return point;
}

export function parseQuotaHistory(stdout: string): QuotaHistoryRow[] {
  let data: unknown;
  try {
    data = JSON.parse(stdout);
  } catch {
    return [];
  }
  if (!Array.isArray(data)) return [];
  const rows: QuotaHistoryRow[] = [];
  for (const entry of data) {
    if (!entry || typeof entry !== "object") continue;
    const item = entry as Record<string, unknown>;
    const provider = text(item.provider);
    if (!provider) continue;
    const lines: QuotaLine[] = [];
    if (Array.isArray(item.lines)) {
      for (const rawLine of item.lines) {
        if (!rawLine || typeof rawLine !== "object") continue;
        const line = rawLine as Record<string, unknown>;
        const name = text(line.name);
        const points = Array.isArray(line.points)
          ? line.points.map(parsePoint).filter((point): point is QuotaPoint => point !== null)
          : [];
        if (!name || points.length === 0) continue;
        lines.push({ name, points });
      }
    }
    if (lines.length === 0) continue;
    const row: QuotaHistoryRow = { provider, lines };
    const user = text(item.user);
    if (user) row.user = user;
    rows.push(row);
  }
  return rows;
}

/** 真正能画出线的行：至少一条窗口有两个点。 */
export function drawableRows(rows: readonly QuotaHistoryRow[]): QuotaHistoryRow[] {
  return rows.filter((row) => row.lines.some((line) => line.points.length >= 2));
}

/** 读数的起止时间，用来写「最近 7 天」「昨天到今天」这类说明。 */
export function historySpan(rows: readonly QuotaHistoryRow[]): { from: number; to: number } | null {
  let from = Number.POSITIVE_INFINITY;
  let to = Number.NEGATIVE_INFINITY;
  for (const row of rows) {
    for (const line of row.lines) {
      for (const point of line.points) {
        const at = Date.parse(point.at);
        if (!Number.isFinite(at)) continue;
        if (at < from) from = at;
        if (at > to) to = at;
      }
    }
  }
  if (!Number.isFinite(from) || !Number.isFinite(to) || to <= from) return null;
  return { from, to };
}

/**
 * 折线路径（0..100 的剩余百分比 → 画布坐标，y 轴翻转）。
 *
 * `width`/`height` 是用于 `viewBox` 的整数坐标，组件再按 CSS 缩放，
 * 这样不必在运行时量 DOM，单测也能直接断言字符串。
 *
 * 给了 `until`（通常就是这次重置的时刻）且它晚于最后一个点时，x 轴延到那一刻：
 * 线在重置前就停住，右边空出来的那一段就是「从现在到重置」——曲线要不要撞到底，
 * 一眼就能对上重置的位置。
 */
export function sparkPath(
  points: readonly QuotaPoint[],
  width: number,
  height: number,
  until?: number | null,
): string {
  const times: number[] = [];
  const values: number[] = [];
  for (const point of points) {
    const at = Date.parse(point.at);
    if (!Number.isFinite(at) || !Number.isFinite(point.left)) continue;
    times.push(at);
    values.push(point.left);
  }
  if (times.length < 2) return "";
  const minAt = Math.min(...times);
  const lastAt = Math.max(...times);
  const maxAt = Number.isFinite(until) && (until as number) > lastAt ? (until as number) : lastAt;
  const span = maxAt - minAt;
  const x = (at: number): number => (span > 0 ? ((at - minAt) / span) * width : width / 2);
  const y = (left: number): number => {
    const clamped = Math.min(100, Math.max(0, left));
    return height - (clamped / 100) * height;
  };
  return times.map((at, index) => `${index === 0 ? "M" : "L"}${x(at).toFixed(1)} ${y(values[index]).toFixed(1)}`).join(" ");
}

/** 这条线记录的重置时刻（毫秒）；没有或读不懂就是 null。 */
export function resetAt(line: QuotaLine): number | null {
  const value = lineResetsAt(line);
  if (!value) return null;
  const at = Date.parse(value);
  return Number.isFinite(at) ? at : null;
}

/** 最后一个读数的时间（毫秒）；没有就是 null。 */
export function lineLastAt(line: QuotaLine): number | null {
  const last = line.points[line.points.length - 1];
  if (!last) return null;
  const at = Date.parse(last.at);
  return Number.isFinite(at) ? at : null;
}

export type QuotaPace =
  | { kind: "runs-out"; at: number }
  | { kind: "lasts"; resetsAt: number };

/**
 * 照现在的速度会怎样：用完（给时间），或撑得过这次重置。
 *
 * 返回 null 的情况都是「说不准」：点太少、跨度太短、没在掉、已经空了、
 * 或者算出来的时间已经过去。说不准就不写，不猜。
 */
export function quotaPace(
  line: QuotaLine,
  now: number,
  resetsAt?: string | null,
): QuotaPace | null {
  const points = line.points
    .map((point) => ({ at: Date.parse(point.at), left: point.left }))
    .filter((point) => Number.isFinite(point.at) && Number.isFinite(point.left))
    .sort((a, b) => a.at - b.at);
  if (points.length < 3) return null;

  // 只看最近这一次回升之后的点：上一轮的数据混进来会把斜率抹平。
  let start = points.length - 1;
  while (start > 0 && points[start - 1].left >= points[start].left) start--;
  const cycle = points.slice(start);
  const last = cycle[cycle.length - 1];
  if (!last || !(last.left > 0)) return null;
  if (last.at - cycle[0].at < 60 * 60 * 1000) return null;

  const t0 = cycle[0].at;
  const n = cycle.length;
  let sx = 0;
  let sy = 0;
  let sxx = 0;
  let sxy = 0;
  for (const point of cycle) {
    const x = (point.at - t0) / (24 * 60 * 60 * 1000);
    sx += x;
    sy += point.left;
    sxx += x * x;
    sxy += x * point.left;
  }
  const denominator = n * sxx - sx * sx;
  if (!(denominator > 0)) return null;
  const slope = (n * sxy - sx * sy) / denominator;
  const reset = resetsAt ? Date.parse(resetsAt) : Number.NaN;
  const hasReset = Number.isFinite(reset) && reset > now;
  if (!(slope < 0)) return hasReset ? { kind: "lasts", resetsAt: reset } : null;

  const intercept = (sy - slope * sx) / n;
  const days = -intercept / slope;
  const out = t0 + days * 24 * 60 * 60 * 1000;
  if (!(out > now)) return null;
  if (hasReset && out >= reset) return { kind: "lasts", resetsAt: reset };
  // 一个月以上才用完的斜率，等于「没在掉」：把这个数字写在界面上只会误导。
  if (!hasReset && out - now > 30 * 24 * 60 * 60 * 1000) return null;
  return { kind: "runs-out", at: out };
}

/** 一条线的结论，写成一句话；没法判断时是空串。 */
export function paceText(pace: QuotaPace | null, now: number): string {
  if (!pace) return "";
  if (pace.kind === "lasts") return "照这个速度，撑得过这次重置";
  const left = pace.at - now;
  if (left < 60 * 1000) return "照这个速度，马上就要用完";
  const minutes = Math.floor(left / (60 * 1000));
  if (minutes < 60) return `照这个速度，${minutes} 分钟后用完`;
  const hours = Math.floor(minutes / 60);
  if (hours < 24) {
    const rest = minutes % 60;
    return `照这个速度，${rest > 0 ? `${hours} 小时 ${rest} 分` : `${hours} 小时`}后用完`;
  }
  const days = Math.floor(hours / 24);
  const restHours = hours % 24;
  return `照这个速度，${restHours > 0 ? `${days} 天 ${restHours} 小时` : `${days} 天`}后用完`;
}

/** 这条线最后一次读数还剩多少（没有读数就是 null）。 */
export function lineLatestLeft(line: QuotaLine): number | null {
  const last = line.points[line.points.length - 1];
  return last && Number.isFinite(last.left) ? last.left : null;
}

/** 这条线自己记录的重置时刻（取最后一条带 resetsAt 的读数）。 */
export function lineResetsAt(line: QuotaLine): string | null {
  for (let index = line.points.length - 1; index >= 0; index--) {
    const value = line.points[index]?.resetsAt;
    if (value) return value;
  }
  return null;
}

export interface TrendHeadline {
  /** 一句话结论；空串表示「没有能下结论的东西」，调用方自己兜底。 */
  text: string;
  /** 最急那一份的紧迫程度：两小时内用完算危险，一天内算偏紧。 */
  tone: "danger" | "warn" | "muted";
}

/**
 * 收起「额度走向」时留在标题下的一句话。
 *
 * 这一块平时不需要看：曲线只有想知道「照这个速度会不会用完」时才值得展开。
 * 所以收起时把**最急的那一份**写成一句话，其余的分量只报个数，不铺开。
 */
export function trendHeadline(rows: readonly QuotaHistoryRow[], now: number): TrendHeadline {
  const running: { at: number; who: string; window: string }[] = [];
  let lasts = 0;
  for (const row of rows) {
    const who = row.user ? `${agentName(row.provider)} ${row.user}` : agentName(row.provider);
    for (const line of row.lines) {
      if (line.points.length < 2) continue;
      const pace = quotaPace(line, now, lineResetsAt(line));
      if (!pace) continue;
      if (pace.kind === "lasts") {
        lasts += 1;
        continue;
      }
      running.push({ at: pace.at, who, window: windowName(line.name) });
    }
  }
  if (running.length === 0) {
    return {
      text: lasts > 0 ? `照这个速度，这 ${lasts} 份额度都撑得过这次重置` : "",
      tone: "muted",
    };
  }
  running.sort((a, b) => a.at - b.at);
  const first = running[0] as { at: number; who: string; window: string };
  const left = first.at - now;
  const others = running.length - 1;
  const sentence = paceText({ kind: "runs-out", at: first.at }, now);
  return {
    text: `${first.who}（${first.window}）${sentence}${others > 0 ? `；另有 ${others} 份也在往下掉` : ""}`,
    tone: left <= 2 * 60 * 60 * 1000 ? "danger" : left <= 24 * 60 * 60 * 1000 ? "warn" : "muted",
  };
}
