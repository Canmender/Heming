/**
 * 上下文用量指示（d.187）。
 *
 * ## 为什么要有
 *
 * 长任务的失败常常静默：历史越攒越大，某一轮起模型开始「忘事」——但用户看不到任何信号，
 * 只会觉得它变笨了。d.160 起预算会按模型窗口自动分配、d.183 起可以 `/compact`，
 * 但**两者都不显示「现在用了多少」**，用户既不知道该不该压，也判断不出「它为什么突然忘了」。
 *
 * ## 三条口径
 *
 * 1. **安静档**：小于预算 30%（且总量不到 1500 tokens）时整条不渲染——短对话里加一行数字是噪音。
 * 2. **警告档**：≥80% 时提示「可以发 `/compact` 压一次」；≥100% 时说明「下一轮会压缩早期内容」。
 * 3. **只报估算**：数字来自 `estimateRowsTokens`（与压缩链同一个估算器），不假称是精确计费值。
 */

/** 低于这个比例不显示（避免短对话里出现噪音）。 */
export const CONTEXT_METER_QUIET_RATIO = 0.3;
/** 低于这个 token 数也不显示（预算很大但对话还很短时同理会变成噪音）。 */
export const CONTEXT_METER_QUIET_TOKENS = 1500;
/** 到这个比例开始提醒「可以压一次」。 */
export const CONTEXT_METER_WARN_RATIO = 0.8;

export type ContextMeterLevel = "quiet" | "ok" | "warn" | "full";

export interface ContextMeterState {
  used: number;
  budget: number;
  /** used / budget（budget 为 0 时为 0）。 */
  ratio: number;
  level: ContextMeterLevel;
  /** 给界面看的一行字；`level === "quiet"` 时调用方不该渲染。 */
  text: string;
}

/** `850` / `12.4K` / `1.2M`（只用于显示，不参与计算）。 */
export function formatTokens(tokens: number): string {
  const value = Math.max(0, Math.round(Number.isFinite(tokens) ? tokens : 0));
  if (value < 1000) return String(value);
  const k = value / 1000;
  if (k < 100) return `${k.toFixed(1)}K`;
  const m = value / 1_000_000;
  return `${m.toFixed(1)}M`;
}

export function contextMeter(used: number, budget: number): ContextMeterState {
  const safeUsed = Math.max(0, Math.round(Number.isFinite(used) ? used : 0));
  const safeBudget = Math.max(0, Math.round(Number.isFinite(budget) ? budget : 0));
  const ratio = safeBudget > 0 ? safeUsed / safeBudget : 0;

  let level: ContextMeterLevel;
  if (safeBudget <= 0 || safeUsed < CONTEXT_METER_QUIET_TOKENS || ratio < CONTEXT_METER_QUIET_RATIO) {
    level = "quiet";
  } else if (ratio >= 1) {
    level = "full";
  } else if (ratio >= CONTEXT_METER_WARN_RATIO) {
    level = "warn";
  } else {
    level = "ok";
  }

  const percent = Math.round(ratio * 100);
  const base = `上下文 ≈ ${formatTokens(safeUsed)} / ${formatTokens(safeBudget)}（${percent}%）`;
  const text =
    level === "full"
      ? `${base}，下一轮会压缩早期内容`
      : level === "warn"
        ? `${base}，可以发 /compact 压一次`
        : base;
  return { used: safeUsed, budget: safeBudget, ratio, level, text };
}
