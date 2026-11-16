import type { ModelCapability } from "../modelCaps.js";
import type { ContextSettings } from "./settings.js";

/**
 * 按模型上下文窗口分配历史预算（d.160）。
 *
 * 为什么需要这一层：`settings.budgetTokens` 的默认值是 6000，是给「未知模型 + 8K 窗口」
 * 定下的保守值。但真实连接的模型常见 64K/128K/200K 窗口——6K 预算等于**每几轮就把
 * 前面全压成摘要**，长任务做到一半，前面读过的文件、定下的约束就只剩一段摘要，
 * 模型开始重复劳动、或者忘了已经改过什么。用户看到的就是「聊久了像失忆」。
 *
 * 两条口径（刻意的取舍）：
 * - **只用窗口的一部分**（`BUDGET_WINDOW_RATIO`）：剩下要放系统提示词、工具声明、
 *   这一轮的工具结果和输出；把窗口全拿去装历史，供应商会直接 400。
 * - **有上限**（`MAX_AUTO_BUDGET`）：窗口再大也不无限放大。单轮 10 万 token 的历史
 *   意味着每轮都要重新读一遍（缓存命中率下降、首字延迟上升、按量计费的用户账单变厚），
 *   超过 3.2 万之后继续涨的收益很小——那时候更该做的是压缩，而不是硬塞。
 */

/** 历史预算占模型窗口的比例（与设置卡里的「按窗口 60% 计」是同一个数，必须同源）。 */
export const BUDGET_WINDOW_RATIO = 0.6;

/** 自动档的下限：不低于历史默认值，避免小窗口模型反而被调小。 */
export const MIN_AUTO_BUDGET = 6000;

/** 自动档的上限：再大就不划算（见文件头）。 */
export const MAX_AUTO_BUDGET = 32_000;

/** 一轮（user + assistant + 工具往返）大约占多少 token，用来把预算换算成保留轮数。 */
export const TURN_BUDGET_TOKENS = 750;

/** 保留轮数的上下限。 */
export const MIN_AUTO_TURNS = 8;
export const MAX_AUTO_TURNS = 24;

/** 只取本模块需要的两个字段：窗口与单次输出上限。 */
export type ModelWindow = Pick<ModelCapability, "contextWindow" | "maxOutput">;

function usableWindow(caps: ModelWindow | null | undefined): number {
  const window = caps?.contextWindow;
  if (typeof window !== "number" || !Number.isFinite(window) || window < 1) return 0;
  return Math.floor(window);
}

/**
 * 窗口允许的最大历史预算（`floor(窗口 × 60%)`）；能力未知时返回 0（调用方按默认值走）。
 */
export function windowBudgetTokens(caps: ModelWindow | null | undefined): number {
  const window = usableWindow(caps);
  if (!window) return 0;
  return Math.floor(window * BUDGET_WINDOW_RATIO);
}

/**
 * 自动档预算。
 *
 * - 能力未知 → `MIN_AUTO_BUDGET`（保持 d.159 及以前的行为，不因为查不到就偷偷改小）；
 * - 窗口很小的模型（60% 仍不到下限）→ 就用窗口允许的值，**不越过窗口硬塞**；
 * - 其余按窗口比例，封顶 `MAX_AUTO_BUDGET`。
 */
export function autoBudgetTokens(caps: ModelWindow | null | undefined): number {
  const limit = windowBudgetTokens(caps);
  if (!limit) return MIN_AUTO_BUDGET;
  if (limit <= MIN_AUTO_BUDGET) return limit;
  return Math.min(limit, MAX_AUTO_BUDGET);
}

/** 预算换算保留轮数：预算越大留越多原文，但夹在 8–24 轮之间。 */
export function autoKeepRecentTurns(budgetTokens: number): number {
  const budget =
    typeof budgetTokens === "number" && Number.isFinite(budgetTokens) && budgetTokens > 0
      ? budgetTokens
      : MIN_AUTO_BUDGET;
  const turns = Math.floor(budget / TURN_BUDGET_TOKENS);
  return Math.min(MAX_AUTO_TURNS, Math.max(MIN_AUTO_TURNS, turns));
}

/**
 * 把设置与真实模型窗口合起来，得到本次真正要用的预算。
 *
 * - `autoBudget === true`（默认）：预算与轮数都按窗口自动算，用户手填的数值被忽略但不擦除
 *   （关掉自动档后原值还在，这是「开关」而不是「覆盖」）。
 * - `autoBudget === false`：尊重用户手填值；但**仍会收敛到窗口允许的上限**——超窗的预算
 *   不会换来更多上下文，只会换来一次 400。
 */
export function applyModelBudget(
  settings: ContextSettings,
  caps: ModelWindow | null | undefined,
): ContextSettings {
  const limit = windowBudgetTokens(caps);
  if (!settings.autoBudget) {
    if (!limit) return settings;
    if (settings.budgetTokens <= limit) return settings;
    return { ...settings, budgetTokens: limit };
  }
  const budgetTokens = autoBudgetTokens(caps);
  return {
    ...settings,
    budgetTokens,
    keepRecentTurns: autoKeepRecentTurns(budgetTokens),
  };
}
