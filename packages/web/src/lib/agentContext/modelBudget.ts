import type { ModelCapability } from "../modelCaps.js";
import type { ContextSettings } from "./settings.js";

/**
 * 上下文预算（d.351）：按 DSH 的压缩规则从模型窗口算，不再让用户手填。
 *
 * DSH 的口径（`packages/compaction/compaction-basic/src/config.ts`）：
 * - `thresholdRatio = 0.8`：上下文用到窗口的 80% 之前不压缩；
 * - `headroomTokens = 65536`：给摘要请求本身留的余量，实际阈值取「窗口 80%」与
 *   「窗口 − 输出预留 − 余量」中较小的那个；
 * - `retainRatio = 0.16`：压缩时保留最近 16% 的原文，其余折成摘要。
 *
 * 和鸣把这三个数照抄过来，但用途只有一半：我们没有「摘要请求」这一层，
 * 所以 `thresholdTokens` 就是历史原文能占的预算（`budgetTokens`），
 * `retainTokens / TURN_BUDGET_TOKENS` 换算成「保留最近几轮原文」。
 * 窗口未知时仍回落到保守的 6000 / 8 轮，和 d.160 的行为一致。
 *
 * 为什么不再给用户自定义：预算低于窗口阈值只会让长对话更早被压成摘要，
 * 高于窗口又会换来 400；两个方向都不是「调优」，是挖坑。
 */

/** 上下文用到窗口的这个比例开始压缩（与 DSH 同值）。 */
export const COMPACT_THRESHOLD_RATIO = 0.8;

/** 压缩时保留的原文比例（与 DSH 同值）。 */
export const COMPACT_RETAIN_RATIO = 0.16;

/** 摘要/输出余量（与 DSH 默认同值）：阈值还要给这次请求的输出留位置。 */
export const COMPACT_HEADROOM_TOKENS = 65_536;

/** 窗口未知时的预算与轮数：保持 d.159 的保守口径。 */
export const MIN_AUTO_BUDGET = 6000;
export const MIN_AUTO_TURNS = 8;

/** 一轮（user + assistant + 工具往返）大约占多少 token，用来把保留量换算成轮数。 */
export const TURN_BUDGET_TOKENS = 750;

/** 保留轮数的硬上限：再多也只是把摘要推后，不改变「原文很贵」这件事。 */
export const MAX_AUTO_TURNS = 40;

/** 只取本模块需要的字段：窗口与单次输出上限。 */
export type ModelWindow = Pick<ModelCapability, "contextWindow" | "maxOutput">;

/** 一次压缩规则的完整数值（窗口未知时调用方拿 `null`，不要编）。 */
export interface CompactSpec {
  contextWindow: number;
  /** 消息可用的窗口：窗口减去这次请求的输出预留。 */
  messageBudgetTokens: number;
  /** 再减去摘要余量后的压力预算。 */
  pressureBudgetTokens: number;
  /** 真正开始压缩的阈值 = min(窗口 × 80%, 压力预算)。 */
  thresholdTokens: number;
  /** 压缩时保留的原文 token。 */
  retainTokens: number;
}

function usableWindow(caps: ModelWindow | null | undefined): number {
  const window = caps?.contextWindow;
  if (typeof window !== "number" || !Number.isFinite(window) || window < 1) return 0;
  return Math.floor(window);
}

/** 这次请求的输出预留：模型声明的 maxOutput，缺省 8192（与 DSH 的常见档一致）。 */
function reservedOutput(caps: ModelWindow | null | undefined): number {
  const maxOutput = caps?.maxOutput;
  if (typeof maxOutput !== "number" || !Number.isFinite(maxOutput) || maxOutput < 0) return 8192;
  return Math.floor(maxOutput);
}

/**
 * 按 DSH 规则算一次压缩规格；窗口未知返回 `null`（调用方回落默认预算）。
 *
 * `thresholdRatio` 与 `retainRatio` 可覆写，只为测试与将来的模型特例留口；
 * 业务路径不要传。
 */
export function compactSpec(
  caps: ModelWindow | null | undefined,
  overrides: { thresholdRatio?: number; retainRatio?: number; headroomTokens?: number } = {},
): CompactSpec | null {
  const contextWindow = usableWindow(caps);
  if (!contextWindow) return null;
  const thresholdRatio = overrides.thresholdRatio ?? COMPACT_THRESHOLD_RATIO;
  const retainRatio = overrides.retainRatio ?? COMPACT_RETAIN_RATIO;
  const headroom = overrides.headroomTokens ?? COMPACT_HEADROOM_TOKENS;
  const messageBudgetTokens = contextWindow - reservedOutput(caps);
  if (messageBudgetTokens <= 0) return null;
  const pressureBudgetTokens = messageBudgetTokens - headroom;
  if (pressureBudgetTokens <= 0) {
    // 窗口比余量还小（小模型）：根本没有「摘要余量」可留。参考项目把这种配置当硬错误拒绝，
    // 这里没有硬错误的余地（设置卡要给小模型也显示一档），就诚实地降级：余量记 0，
    // 阈值夹到消息预算内（不能比窗口能装下的正文还大），保留量始终小于阈值。
    // 旧代码把「摘要余量」伪造成整个消息预算（4096），设置卡于是显示「摘要余量 4.1K」，
    // 可实际一分余量都没有——用户按这个数字判断要不要压缩会被误导。
    const thresholdTokens = Math.min(
      Math.floor(contextWindow * thresholdRatio),
      messageBudgetTokens,
    );
    return {
      contextWindow,
      messageBudgetTokens,
      pressureBudgetTokens: 0,
      thresholdTokens,
      retainTokens: Math.min(Math.floor(messageBudgetTokens * retainRatio), thresholdTokens - 1),
    };
  }
  const thresholdTokens = Math.floor(
    Math.min(contextWindow * thresholdRatio, pressureBudgetTokens),
  );
  return {
    contextWindow,
    messageBudgetTokens,
    pressureBudgetTokens,
    thresholdTokens,
    retainTokens: Math.floor(messageBudgetTokens * retainRatio),
  };
}

/** 窗口允许的最大历史预算；能力未知时返回 0（调用方按默认值走）。 */
export function windowBudgetTokens(caps: ModelWindow | null | undefined): number {
  return compactSpec(caps)?.thresholdTokens ?? 0;
}

/**
 * 自动档预算：窗口已知走 DSH 阈值，未知回落 `MIN_AUTO_BUDGET`。
 *
 * 窗口小到阈值低于默认值时**以阈值为准**——越过窗口硬塞只会换来一次 400。
 */
export function autoBudgetTokens(caps: ModelWindow | null | undefined): number {
  const spec = compactSpec(caps);
  if (!spec) return MIN_AUTO_BUDGET;
  return Math.max(2000, Math.min(spec.thresholdTokens, spec.messageBudgetTokens));
}

/** 保留最近几轮原文：按 DSH 的 16% 保留量换算，夹在 8–40 轮之间。 */
export function autoKeepRecentTurns(budgetTokens: number, caps?: ModelWindow | null): number {
  const spec = compactSpec(caps);
  const retain = spec ? spec.retainTokens : budgetTokens * COMPACT_RETAIN_RATIO;
  const turns = Math.floor(retain / TURN_BUDGET_TOKENS);
  return Math.min(MAX_AUTO_TURNS, Math.max(MIN_AUTO_TURNS, turns));
}

/**
 * 把设置与真实模型窗口合起来，得到本次真正要用的预算。
 *
 * d.351 起没有「手动档」：`budgetTokens`/`keepRecentTurns` 一律由 DSH 规则算出，
 * 设置里残留的旧值不再生效（保留在存储里只为回滚，不参与计算）。
 */
export function applyModelBudget(
  settings: ContextSettings,
  caps: ModelWindow | null | undefined,
): ContextSettings {
  const spec = compactSpec(caps);
  if (!spec) {
    return {
      ...settings,
      budgetTokens: MIN_AUTO_BUDGET,
      keepRecentTurns: Math.max(MIN_AUTO_TURNS, settings.keepRecentTurns),
    };
  }
  const budgetTokens = Math.max(2000, Math.min(spec.thresholdTokens, spec.messageBudgetTokens));
  return {
    ...settings,
    budgetTokens,
    keepRecentTurns: autoKeepRecentTurns(budgetTokens, caps),
  };
}
