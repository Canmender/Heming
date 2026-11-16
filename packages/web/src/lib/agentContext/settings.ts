import type { StorageLike } from "./types.js";
import { DEFAULT_BUDGET_TOKENS, DEFAULT_KEEP_RECENT_TURNS } from "./budget.js";
import { createDefaultStorage, isPlainObject, readJson, writeJson } from "../memory/storage.js";

/**
 * 上下文预算设置（设计 §5）：键 `heming.context.v1`，全本机、损坏回退默认值。
 * `enabled === false` 即「按原样发送」，行为回到加预算之前。
 */

/** 本模块所用的两个本机键（带版本号，便于日后迁移）。 */
export const CONTEXT_KEYS = {
  settings: "heming.context.v1",
  summaries: "heming.contextSummaries.v1",
} as const;

export interface ContextSettings {
  /** 总开关：关闭 = 原样发送（回到今天行为）。 */
  enabled: boolean;
  /** 提示词 + 历史的 token 总预算。 */
  budgetTokens: number;
  /** 原文保留的最近轮数上限。 */
  keepRecentTurns: number;
  /** 关 = 只用零成本确定性摘要（不发额外请求）。 */
  llmSummary: boolean;
  /**
   * 按当前模型的上下文窗口自动分配预算（d.160，默认开）。
   *
   * 开 = `budgetTokens`/`keepRecentTurns` 由窗口算出（见 `modelBudget.ts`），手填值保留但不生效；
   * 关 = 完全按手填值（仍会收敛到窗口允许的上限，超窗只会换来 400）。
   * 历史存量设置里没有这个键，`normalizeContextSettings` 按 `true` 补——这正是想要的行为：
   * 老用户升级后，长对话不再被 6K 预算切碎。
   */
  autoBudget: boolean;
}

export const DEFAULT_CONTEXT_SETTINGS: ContextSettings = {
  enabled: true,
  budgetTokens: DEFAULT_BUDGET_TOKENS,
  keepRecentTurns: DEFAULT_KEEP_RECENT_TURNS,
  llmSummary: true,
  autoBudget: true,
};

/** 默认存储惰性单例：避免每次读取都写探针；localStorage 不可用时自动降级纯内存。 */
let defaultStorage: StorageLike | undefined;
function storageOrDefault(storage?: StorageLike): StorageLike {
  if (storage) return storage;
  if (!defaultStorage) defaultStorage = createDefaultStorage();
  return defaultStorage;
}

function positiveInt(value: unknown, fallback: number): number {
  return typeof value === "number" && Number.isFinite(value) && value >= 1 ? Math.floor(value) : fallback;
}

/** 逐字段校验：类型/取值不符的字段回落默认（不整段丢弃，好字段照样用）。 */
export function normalizeContextSettings(raw: unknown): ContextSettings {
  if (!isPlainObject(raw)) return { ...DEFAULT_CONTEXT_SETTINGS };
  return {
    enabled: typeof raw.enabled === "boolean" ? raw.enabled : DEFAULT_CONTEXT_SETTINGS.enabled,
    budgetTokens: positiveInt(raw.budgetTokens, DEFAULT_CONTEXT_SETTINGS.budgetTokens),
    keepRecentTurns: positiveInt(raw.keepRecentTurns, DEFAULT_CONTEXT_SETTINGS.keepRecentTurns),
    llmSummary: typeof raw.llmSummary === "boolean" ? raw.llmSummary : DEFAULT_CONTEXT_SETTINGS.llmSummary,
    autoBudget: typeof raw.autoBudget === "boolean" ? raw.autoBudget : DEFAULT_CONTEXT_SETTINGS.autoBudget,
  };
}

/** 读取设置：缺键/损坏/存储抛错一律回默认值，永不抛出。 */
export function loadContextSettings(storage?: StorageLike): ContextSettings {
  try {
    return readJson(
      storageOrDefault(storage),
      CONTEXT_KEYS.settings,
      { ...DEFAULT_CONTEXT_SETTINGS },
      normalizeContextSettings,
    );
  } catch {
    return { ...DEFAULT_CONTEXT_SETTINGS };
  }
}

/**
 * 打补丁保存：非法字段被忽略（保留原值而非写坏），返回合并后的完整设置。
 * 写入失败（配额/隐私模式）静默——设置只留在内存里，不影响本次会话。
 */
export function saveContextSettings(
  patch: Partial<ContextSettings>,
  storage?: StorageLike,
): ContextSettings {
  const store = storageOrDefault(storage);
  const current = loadContextSettings(store);
  const next: ContextSettings = { ...current };
  if (typeof patch?.enabled === "boolean") next.enabled = patch.enabled;
  if (typeof patch?.llmSummary === "boolean") next.llmSummary = patch.llmSummary;
  if (typeof patch?.autoBudget === "boolean") next.autoBudget = patch.autoBudget;
  if (typeof patch?.budgetTokens === "number" && Number.isFinite(patch.budgetTokens) && patch.budgetTokens >= 1) {
    next.budgetTokens = Math.floor(patch.budgetTokens);
  }
  if (
    typeof patch?.keepRecentTurns === "number" &&
    Number.isFinite(patch.keepRecentTurns) &&
    patch.keepRecentTurns >= 1
  ) {
    next.keepRecentTurns = Math.floor(patch.keepRecentTurns);
  }
  try {
    writeJson(store, CONTEXT_KEYS.settings, next);
  } catch {
    /* 落盘失败静默：本次会话仍按内存态生效 */
  }
  return next;
}
