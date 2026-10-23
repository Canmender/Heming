import { create } from "zustand";

const STORAGE_KEY = "heming.tokenUsage";
const MAX_RECORDS = 5000;

export interface UsageRecord {
  model: string;
  /**
   * 本轮 token 用量。`null` = 该轮供应商**未上报**（不是 0）。
   * 为什么照样写一条记录：不写的话界面只能显示 0，分不清「真的用了 0」与「没数据」；
   * 写下来，界面才有素材说出「未上报」。老记录都是数字，读回照旧。
   */
  tokens: number | null;
  at: string;
}

/** 是否已上报：只有数字才参与求和（老数据也都是数字）。 */
function reportedTokens(r: UsageRecord): number | null {
  return typeof r.tokens === "number" ? r.tokens : null;
}

export function monthKeyOf(iso: string): string {
  const d = new Date(iso);
  return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, "0")}`;
}

export function dayKeyOf(iso: string): string {
  const d = new Date(iso);
  return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, "0")}-${String(
    d.getDate(),
  ).padStart(2, "0")}`;
}

export function summarizeMonth(
  records: UsageRecord[],
  monthKey: string,
): { total: number; byModel: Record<string, number>; missing: number } {
  let total = 0;
  let missing = 0;
  const byModel: Record<string, number> = {};
  for (const r of records) {
    if (monthKeyOf(r.at) !== monthKey) continue;
    const tokens = reportedTokens(r);
    if (tokens === null) {
      missing++; // 未上报单独计数，不参与求和
      continue;
    }
    total += tokens;
    byModel[r.model] = (byModel[r.model] ?? 0) + tokens;
  }
  return { total, byModel, missing };
}

export function daysOfMonth(monthKey: string): string[] {
  const [year, month] = monthKey.split("-").map(Number);
  const count = new Date(year, month, 0).getDate();
  return Array.from({ length: count }, (_, i) => `${monthKey}-${String(i + 1).padStart(2, "0")}`);
}

export function dailyTotals(
  records: UsageRecord[],
  monthKey: string,
): { day: string; total: number; byModel: Record<string, number>; missing: number }[] {
  const byDay = new Map<string, { total: number; byModel: Record<string, number>; missing: number }>();
  for (const r of records) {
    if (monthKeyOf(r.at) !== monthKey) continue;
    const day = dayKeyOf(r.at);
    const entry = byDay.get(day) ?? { total: 0, byModel: {}, missing: 0 };
    const tokens = reportedTokens(r);
    if (tokens === null) {
      entry.missing++;
    } else {
      entry.total += tokens;
      entry.byModel[r.model] = (entry.byModel[r.model] ?? 0) + tokens;
    }
    byDay.set(day, entry);
  }
  return daysOfMonth(monthKey).map((day) => {
    const hit = byDay.get(day);
    return { day, total: hit?.total ?? 0, byModel: hit?.byModel ?? {}, missing: hit?.missing ?? 0 };
  });
}

/** 近 30 个自然日（含今天）逐日合计：零值天不跳过；本地时区。 */
export function last30DaysTotals(
  records: UsageRecord[],
  now: Date = new Date(),
): { day: string; total: number; missing: number }[] {
  const byDay = new Map<string, { total: number; missing: number }>();
  for (const r of records) {
    const day = dayKeyOf(r.at);
    const entry = byDay.get(day) ?? { total: 0, missing: 0 };
    const tokens = reportedTokens(r);
    if (tokens === null) entry.missing++;
    else entry.total += tokens;
    byDay.set(day, entry);
  }
  const days: { day: string; total: number; missing: number }[] = [];
  for (let i = 29; i >= 0; i--) {
    const d = new Date(now.getFullYear(), now.getMonth(), now.getDate() - i);
    const day = dayKeyOf(d.toISOString());
    const hit = byDay.get(day);
    days.push({ day, total: hit?.total ?? 0, missing: hit?.missing ?? 0 });
  }
  return days;
}

/** 相对 max 的 5 档热度：0=无，1 ≤25%，2 ≤50%，3 ≤75%，4 其余。 */
export function heatLevel(total: number, max: number): 0 | 1 | 2 | 3 | 4 {
  if (total <= 0 || max <= 0) return 0;
  const ratio = total / max;
  if (ratio <= 0.25) return 1;
  if (ratio <= 0.5) return 2;
  if (ratio <= 0.75) return 3;
  return 4;
}

function load(): UsageRecord[] {
  try {
    const raw = localStorage.getItem(STORAGE_KEY);
    if (raw) {
      const parsed = JSON.parse(raw) as { records?: UsageRecord[] };
      return Array.isArray(parsed.records) ? parsed.records : [];
    }
  } catch {
    /* 损坏数据回退空日志 */
  }
  return [];
}

function save(records: UsageRecord[]): void {
  localStorage.setItem(STORAGE_KEY, JSON.stringify({ records }));
}

interface TokenState {
  quota: number;
  records: UsageRecord[];
  /** 记一轮**已上报**的用量（签名不变：既有调用/测试不受影响）。 */
  record: (model: string, tokens: number, at?: string) => void;
  /** 记一轮**未上报**（`tokens:null`）：界面据此说「未上报」而不是「用了 0」。 */
  recordUnreported: (model: string, at?: string) => void;
  reset: () => void;
}

export const useTokenUsageStore = create<TokenState>((set, get) => ({
  quota: 3_000_000,
  records: load(),
  record(model, tokens, at) {
    const next = [...get().records, { model, tokens, at: at ?? new Date().toISOString() }].slice(
      -MAX_RECORDS,
    );
    save(next);
    set({ records: next });
  },
  recordUnreported(model, at) {
    const next = [
      ...get().records,
      { model, tokens: null, at: at ?? new Date().toISOString() },
    ].slice(-MAX_RECORDS);
    save(next);
    set({ records: next });
  },
  reset() {
    save([]);
    set({ records: [] });
  },
}));
