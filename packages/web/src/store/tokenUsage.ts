import { create } from "zustand";

const STORAGE_KEY = "heming.tokenUsage";
const MAX_RECORDS = 5000;

export interface UsageRecord {
  model: string;
  tokens: number;
  at: string;
}

export function monthKeyOf(iso: string): string {
  return iso.slice(0, 7);
}

export function dayKeyOf(iso: string): string {
  return iso.slice(0, 10);
}

export function summarizeMonth(
  records: UsageRecord[],
  monthKey: string,
): { total: number; byModel: Record<string, number> } {
  let total = 0;
  const byModel: Record<string, number> = {};
  for (const r of records) {
    if (monthKeyOf(r.at) !== monthKey) continue;
    total += r.tokens;
    byModel[r.model] = (byModel[r.model] ?? 0) + r.tokens;
  }
  return { total, byModel };
}

export function daysOfMonth(monthKey: string): string[] {
  const [year, month] = monthKey.split("-").map(Number);
  const count = new Date(year, month, 0).getDate();
  return Array.from({ length: count }, (_, i) => `${monthKey}-${String(i + 1).padStart(2, "0")}`);
}

export function dailyTotals(
  records: UsageRecord[],
  monthKey: string,
): { day: string; total: number; byModel: Record<string, number> }[] {
  const byDay = new Map<string, { total: number; byModel: Record<string, number> }>();
  for (const r of records) {
    if (monthKeyOf(r.at) !== monthKey) continue;
    const day = dayKeyOf(r.at);
    const entry = byDay.get(day) ?? { total: 0, byModel: {} };
    entry.total += r.tokens;
    entry.byModel[r.model] = (entry.byModel[r.model] ?? 0) + r.tokens;
    byDay.set(day, entry);
  }
  return daysOfMonth(monthKey).map((day) => {
    const hit = byDay.get(day);
    return { day, total: hit?.total ?? 0, byModel: hit?.byModel ?? {} };
  });
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
  record: (model: string, tokens: number, at?: string) => void;
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
  reset() {
    save([]);
    set({ records: [] });
  },
}));
