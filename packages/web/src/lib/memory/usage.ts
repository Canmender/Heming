import type { StorageLike } from "./types.js";
import type { RecallRun } from "./recallLog.js";
import { createDefaultStorage, isPlainObject, readJson, writeJson } from "./storage.js";

/**
 * 记忆个性化权重（d.28）：把 d.27 落地的归因结果（哪些条目被注入、哪些被**疑似引用**）
 * 反哺回召回打分，并给出「长期未被引用」的淘汰线索。
 *
 * 三条硬约束，决定了这里的写法：
 *
 * 1. **判据必须是确定性的字符串统计**。绝不出现「问模型这次用了哪条记忆」这类二次调用——
 *    那种答案不可复现，用户在记忆区看到的权重就成了玄学。这里的每一个数字都能从
 *    `EntryUsage` 的两个整数计数器手算出来。
 * 2. **只提权，不降权**。被引用得多最多把分数抬 25%（`USAGE_BOOST_MAX`）；
 *    「从没被引用」绝不自动扣分、绝不自动删——那是用户的数据，
 *    冷记忆只列出来给人看、给人删（见记忆页的冷门清单）。
 * 3. **旁路数据，不进三层**。权重账本存独立键，与召回日志一样属于本机诊断数据，
 *    不参与记忆导出/导入：换设备带走的是记下来的事实，不是「这台机器上哪几条常被用到」。
 *
 * 为什么要单独一个账本而不直接从召回日志算：日志是 40 档的环形缓冲，
 * 一天聊得多就滚掉了。权重若只从日志推导，用户会看到「明明上周还挺准的匹配这周变差了」，
 * 而原因（日志滚了）与他无关。账本按条目 id 累加，滚动窗口不影响它。
 */

/** 账本键（独立于三层与召回日志，不参与记忆导出）。 */
export const USAGE_KEY = "heming.memory.usage.v1";
/** 提权上限：用得再多也只抬 25%，避免「热门记忆」把预算吃满、新事实永远排不上。 */
export const USAGE_BOOST_MAX = 0.25;
/**
 * 平滑项：`used/(used+SMOOTH)` 让「1 次引用」不至于立刻顶到上限。
 * used=1 → ×1.0625，used=3 → ×1.125，used→∞ → ×1.25（收敛但取不到）。
 */
export const USAGE_SMOOTH = 3;
/** 至少注入过这么多次、且一次都没被疑似引用，才有资格进冷门清单（样本太少不下结论）。 */
export const COLD_MIN_INJECTED = 6;
/** 账本最多记这么多条目：id 是有限集合（三层各有条数上限），400 已覆盖且远小于单键护栏。 */
export const USAGE_LEDGER_MAX = 400;
/** 账本字节护栏：比召回日志（256KB）再小一档，诊断数据不吃 localStorage 配额。 */
export const USAGE_SIZE_LIMIT = 64 * 1024;

/** 一条记忆的用量计数（`lastAt` 只用于账本满时的淘汰顺序，不参与打分）。 */
export interface EntryUsage {
  /** 被注入进提示词的次数（只计语义/情景层，工作层是刚说过的话，计数没有信息量）。 */
  injected: number;
  /** 其中被判为「疑似引用」的次数（判据见 attribution.ts，恒 ≤ `injected`）。 */
  used: number;
  /** 最后一次被计入的时刻（ISO）。 */
  lastAt: string;
}

/** 召回侧只需要「这条值多少倍」这一个能力，便于测试里塞一个假视图。 */
export interface UsageView {
  boostOf(id: string): number;
}

/** 乘子上限封顶 + 保留 4 位小数：UI 里不要出现 1.1250000000000001。 */
export function usageBoost(usage: EntryUsage | undefined): number {
  if (!usage || usage.used <= 0) return 1;
  const raw = 1 + USAGE_BOOST_MAX * (usage.used / (usage.used + USAGE_SMOOTH));
  return Math.round(raw * 1e4) / 1e4;
}

/** 冷记忆线索：注入够多次却从未被疑似引用。**只是线索，不是删除指令。** */
export function isColdUsage(usage: EntryUsage | undefined): boolean {
  return !!usage && usage.used === 0 && usage.injected >= COLD_MIN_INJECTED;
}

/* ------------------------------------------------------------------ 水合 */

function pickUsage(raw: unknown): EntryUsage | null {
  if (!isPlainObject(raw)) return null;
  const num = (v: unknown) => (typeof v === "number" && Number.isFinite(v) && v >= 0 ? Math.floor(v) : 0);
  const injected = num(raw.injected);
  const used = Math.min(num(raw.used), injected);
  if (!injected && !used) return null;
  const lastAt = typeof raw.lastAt === "string" ? raw.lastAt : "";
  return { injected, used, lastAt };
}

/* ------------------------------------------------------------------ 账本 */

export class UsageLedger implements UsageView {
  private cache: Map<string, EntryUsage> | null = null;

  constructor(
    private storage: StorageLike = createDefaultStorage(),
    private nowMs: () => number = () => Date.now(),
  ) {}

  /** 全量计数（新读到的那次会缓存在内存里，写一次失效）。损坏条目在此被丢掉。 */
  private entries(): Map<string, EntryUsage> {
    if (this.cache) return this.cache;
    const map = new Map<string, EntryUsage>();
    const raw = readJson<Record<string, unknown>>(this.storage, USAGE_KEY, {}, (value) =>
      isPlainObject(value) ? value : {},
    );
    for (const [id, value] of Object.entries(raw)) {
      const usage = pickUsage(value);
      if (usage) map.set(id, usage);
    }
    this.cache = map;
    return map;
  }

  /** 某条记忆的用量（未记过则 undefined：调用方按「无提权」处理）。 */
  get(id: string): EntryUsage | undefined {
    return this.entries().get(id);
  }

  /** 召回侧入口：没这条的计数就是 ×1（不偏不倚）。 */
  boostOf(id: string): number {
    return usageBoost(this.get(id));
  }

  /** 快照（记忆页一次读全表，避免逐条读时反复反序列化）。 */
  snapshot(): Record<string, EntryUsage> {
    return Object.fromEntries(this.entries());
  }

  /**
   * 累加一档召回档案：**一档只计一次**，同 id 在这档里出现几回都只加一。
   *
   * 工作层与 `focus` 聚合行直接跳过——那几行就是刚才的对话，必然被复述，
   * 计数只会把「被引用」这个信号淹在噪声里（与 attribution.ts 同一口径）。
   *
   * 落盘失败静默：账本只是让下次排序更准，记不上不该影响这一轮的任何东西。
   */
  apply(run: RecallRun | null): void {
    if (!run) return;
    const at = new Date(this.nowMs()).toISOString();
    const map = this.entries();
    let changed = false;
    const bump = (id: string, field: "injected" | "used") => {
      if (!id || id === "focus") return;
      const current = map.get(id) ?? { injected: 0, used: 0, lastAt: at };
      const next: EntryUsage = {
        ...current,
        injected: current.injected + (field === "injected" ? 1 : 0),
        used: current.used + (field === "used" ? 1 : 0),
        lastAt: at,
      };
      // used 不可能超过 injected（引用只能发生在注入之后）；脏数据在此被夹住。
      if (next.used > next.injected) next.used = next.injected;
      map.set(id, next);
      changed = true;
    };
    const injectedIds = new Set<string>();
    for (const item of run.injected) {
      if (item.layer === "working") continue;
      if (injectedIds.has(item.id)) continue;
      injectedIds.add(item.id);
      bump(item.id, "injected");
    }
    for (const id of run.used) {
      if (!injectedIds.has(id)) continue; // 引用必须落在本档注入过的条目上
      bump(id, "used");
    }
    if (!changed) return;
    this.trim(map);
    writeJson(this.storage, USAGE_KEY, Object.fromEntries(map), USAGE_SIZE_LIMIT);
  }

  /** 满容量时按「最后一次计入」最旧先丢：近期还在用的计数值得留。 */
  private trim(map: Map<string, EntryUsage>): void {
    if (map.size <= USAGE_LEDGER_MAX) return;
    const sorted = [...map.entries()].sort((a, b) => (a[1].lastAt < b[1].lastAt ? -1 : 1));
    for (const [id] of sorted.slice(0, map.size - USAGE_LEDGER_MAX)) map.delete(id);
  }

  /** 条目被删除时同步清掉计数，避免 id 泄漏（记忆区逐条删除/清空智能体记忆都会走到）。 */
  forget(ids: Iterable<string>): void {
    const map = this.entries();
    let changed = false;
    for (const id of ids) {
      if (map.delete(id)) changed = true;
    }
    if (!changed) return;
    writeJson(this.storage, USAGE_KEY, Object.fromEntries(map), USAGE_SIZE_LIMIT);
  }

  /** 清除诊断数据（与召回日志同一入口）。 */
  clear(): void {
    this.cache = null;
    try {
      this.storage.removeItem(USAGE_KEY);
    } catch {
      /* 静默 */
    }
  }
}

/** 模块级单例：与 recallRecorder 配对，写入端（settle）与读取端（召回/记忆页）共用一份计数。 */
export const usageLedger = new UsageLedger();

/** 零提权视图（测试与「未接用量」的调用方用）。 */
export const NEUTRAL_USAGE: UsageView = { boostOf: () => 1 };
