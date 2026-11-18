/**
 * 把同一个智能体的几个账号读成一行：一个窗口一份结论。
 *
 * 口径照内核 GUI 的合并（`internal/gui/assets/quotaall.js` 的 mergeQuotas）：
 * - 只有读得到的账号参与（`error` 的、以及读数过期到重置之后的，算「读不到」并单独计数）；
 * - 计数窗口（有 limit 的点数）把用量与上限分别相加，剩下的按合计算；
 * - 钱包（只有 balance）把余额相加；
 * - 只按份额说的窗口，只在**同一个计划**的账号之间求平均（同计划的窗口一样大，平均才是他们一起的份额）；
 * - 份额不与计数相加，只有厂商原话的窗口不参与；
 * - 两个及以上账号都有的窗口才合并，一个账号自己的已经在下面那行写着。
 */

import { agentName, formatCount, parseTime, unitLabel, type QuotaTone, type QuotaWindow } from "./magpieQuota.js";
import type { AccountRow } from "./magpieCli.js";

/** 合并后的一份额度。 */
export interface MergedWindow {
  /** 内核给的窗口名，例如 "5 hours"、"week"。 */
  name: string;
  /** 有几个账号参与这份合计。 */
  accounts: number;
  /** 有几份读不到（失败，或读数是重置之前的旧读数）。 */
  unknown: number;
  /** 剩余百分数（计数窗口按合计算）。 */
  left: number;
  tone: QuotaTone;
  /** 一行结论：`平均剩 62%` 或 `剩 7,000 点`。 */
  text: string;
  /** 悬停时补充口径：为什么是平均、合计多少。 */
  detail: string;
  /** 这些账号里最早的一份什么时候重置。 */
  resetsAt: number | null;
}

export interface MergedAgent {
  agent: string;
  label: string;
  /** 参与合并的账号数。 */
  accounts: number;
  windows: MergedWindow[];
}

interface Bucket {
  window: QuotaWindow;
  kind: "p" | "c" | "b" | "u";
  plan: string;
  accounts: number;
  unknown: number;
  amount: number;
  limit: number;
  balance: number;
  used: number;
  resetsAt: number | null;
}

/** 两个及以上账号共有的窗口才在这里出现；一个账号的不用合并。 */
export function mergeAccounts(rows: readonly AccountRow[], now: number): MergedAgent[] {
  const byAgent = new Map<string, AccountRow[]>();
  for (const row of rows) {
    const list = byAgent.get(row.agent);
    if (list) list.push(row);
    else byAgent.set(row.agent, [row]);
  }

  const merged: MergedAgent[] = [];
  for (const [agent, list] of byAgent) {
    const read = list.filter((row) => !row.error && (row.windows.length > 0 || row.balance));
    if (read.length < 2) continue;
    const buckets = new Map<string, Bucket>();
    for (const row of read) {
      for (const window of row.windows) {
        if (window.text) continue;
        const kind = bucketKind(window);
        if (!kind) continue;
        const key = [window.name, window.pool, window.unit, kind === "p" ? `p:${row.plan ?? ""}` : kind].join("|");
        let bucket = buckets.get(key);
        if (!bucket) {
          bucket = {
            window,
            kind,
            plan: row.plan ?? "",
            accounts: 0,
            unknown: 0,
            amount: 0,
            limit: 0,
            balance: 0,
            used: 0,
            resetsAt: null,
          };
          buckets.set(key, bucket);
        }
        // 读数是重置之前的旧数：算「读不到」，不参与平均。
        const resetsAt = readTime(window.resetsAt);
        if (row.asOf && resetsAt !== null && resetsAt <= now) {
          bucket.unknown += 1;
          continue;
        }
        bucket.accounts += 1;
        if (kind === "c") {
          bucket.amount += Math.max(0, window.amount ?? 0);
          bucket.limit += Math.max(0, window.limit ?? 0);
        } else if (kind === "b") {
          bucket.balance += window.balance ?? 0;
        } else if (kind !== "u") {
          bucket.used += clamp(100 - windowLeft(window));
        }
        if (resetsAt !== null && resetsAt > now && (bucket.resetsAt === null || resetsAt < bucket.resetsAt)) {
          bucket.resetsAt = resetsAt;
        }
      }
    }

    const windows: MergedWindow[] = [];
    for (const bucket of buckets.values()) {
      if (bucket.accounts < 2) continue;
      if (bucket.kind === "u" && bucket.accounts < read.length) continue;
      windows.push(finish(bucket));
    }
    if (windows.length === 0) continue;
    merged.push({ agent, label: agentName(agent), accounts: read.length, windows });
  }

  return merged.sort((a, b) => a.label.localeCompare(b.label));
}

function bucketKind(window: QuotaWindow): Bucket["kind"] | "" {
  if (window.unlimited) return "u";
  if ((window.limit ?? 0) > 0) return "c";
  if (window.balance !== null) return "b";
  if (Number.isFinite(window.used)) return "p";
  return "";
}

function finish(bucket: Bucket): MergedWindow {
  const { window, kind } = bucket;
  const unknown = bucket.unknown;
  const suffix = unknown > 0 ? `；${unknown} 份读不到，没有算进来` : "";

  if (kind === "u") {
    return {
      name: window.name,
      accounts: bucket.accounts,
      unknown,
      left: 100,
      tone: "ok",
      text: "不限量",
      detail: `${bucket.accounts} 个账号都读成不限量${suffix}`,
      resetsAt: bucket.resetsAt,
    };
  }

  if (kind === "c") {
    const left = bucket.limit > 0 ? clamp((100 * (bucket.limit - bucket.amount)) / bucket.limit) : 0;
    const unit = unitLabel(window.unit);
    return {
      name: window.name,
      accounts: bucket.accounts,
      unknown,
      left,
      tone: toneFor(left),
      text: left > 0 ? `剩 ${formatCount(bucket.limit - bucket.amount)} ${unit}` : "已用完",
      detail: `合计 已用 ${formatCount(bucket.amount)} / 共 ${formatCount(bucket.limit)} ${unit}${suffix}`,
      resetsAt: bucket.resetsAt,
    };
  }

  if (kind === "b") {
    return {
      name: window.name,
      accounts: bucket.accounts,
      unknown,
      left: 100,
      tone: "ok",
      text: `余额 ${formatCount(bucket.balance)}`,
      detail: `${bucket.accounts} 个账号的余额相加${suffix}`,
      resetsAt: bucket.resetsAt,
    };
  }

  const left = clamp(100 - bucket.used / bucket.accounts);
  return {
    name: window.name,
    accounts: bucket.accounts,
    unknown,
    left,
    tone: toneFor(left),
    text: left > 0 ? `平均剩 ${Math.round(left)}%` : "已用完",
    detail: `同一计划下 ${bucket.accounts} 个账号的平均${suffix}`,
    resetsAt: bucket.resetsAt,
  };
}

function windowLeft(window: QuotaWindow): number {
  if (Number.isFinite(window.remaining)) return window.remaining;
  return 100 - (window.used ?? 0);
}

function readTime(text: string | null | undefined): number | null {
  if (!text) return null;
  const at = parseTime(text);
  return Number.isFinite(at) ? at : null;
}

function clamp(value: number): number {
  if (!Number.isFinite(value)) return 0;
  return Math.min(100, Math.max(0, value));
}

function toneFor(left: number): QuotaTone {
  if (left <= 10) return "danger";
  if (left <= 25) return "warn";
  return "ok";
}
