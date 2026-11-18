/**
 * 终端续聊的上下文预算：历史放不下时折叠早期对话，而不是把整段塞给模型。
 *
 * 为什么需要它：`--continue` / `--resume` 会把上一次会话的文字问答整段带进新请求，
 * 而会话存档本身允许 200 轮。跑久了就有两个后果——请求越来越贵，最后直接撞上
 * 供应商的上下文上限（400），一次也跑不了。桌面端从 d.183 起就有预算 + 折叠，
 * CLI 一直没有：同一个会话在窗口里能接着聊，在终端里多聊几轮就废了。
 *
 * 口径**直接复用桌面端的 `prepareHistory`**，不另写一套切分与摘要：
 * - 切分：`planContext`（预算 + 最近轮数 + 不拆 user→assistant 对）；
 * - 折叠：早期对话压成三段摘要（【早期对话摘要】意图/结论/待办）；
 * - 溢出重试：`agentStream` 命中上下文超限特征时会带 `aggressive` 再调一次，这里照转。
 *
 * 与桌面端**有意不同的一点**：CLI 只用零成本确定性摘要（`llmSummary: false`）。
 * 桌面端可以为了质量多发一次摘要请求，终端不该在「我让你跑个活」的时候
 * 偷偷多花一次调用——而且那次调用的结果不会显示在任何地方，用户看不见。
 */
import type { ChatMessage } from "../../../packages/web/src/lib/llmClient.js";
import type { TriggerDeps } from "../../../packages/web/src/lib/agentStream.js";
import type { ContextSettings } from "../../../packages/web/src/lib/agentContext/settings.js";
import {
  countFoldedMessages,
  prepareHistory,
} from "../../../packages/web/src/lib/agentContext/history.js";

/** 默认预算：CLI 的系统提示词比桌面端短得多（没有记忆/技能/工作区注入），12k 够长又不至于烧钱。 */
export const CLI_CONTEXT_BUDGET_DEFAULT = 12_000;
/** 原文保留的最近轮数（一轮 = 一条 user + 它后面的全部）。 */
export const CLI_CONTEXT_KEEP_TURNS_DEFAULT = 8;
/** 预算下限/上限：太小会把最后一轮也切碎，太大则等于没设。 */
export const CLI_CONTEXT_BUDGET_MIN = 500;
export const CLI_CONTEXT_BUDGET_MAX = 200_000;

/** 折叠统计：入口拿它给用户一句话，别让人以为「它忘了我刚才说的」。 */
export interface CliContextStats {
  /** 最后一次请求里折叠掉的原始消息条数（0 = 没折）。 */
  folded: number;
  /** 折叠发生过几次（溢出重试会让它大于 1）。 */
  folds: number;
  /** 最近一次实际用的预算（aggressive 重试会是收紧后的值）。 */
  budgetTokens: number;
  /** 溢出重试收紧到第几级：0 = 没收紧，1 = 半预算，2 = 四分之一预算。 */
  aggressive: 0 | 1 | 2;
  /** 是否启用折叠（`--no-compact` 时为 false）。 */
  enabled: boolean;
}

export interface CliContextOptions {
  /** 预算（token）；缺省 `CLI_CONTEXT_BUDGET_DEFAULT`。 */
  budgetTokens?: number;
  /** 原文保留的最近轮数；缺省 `CLI_CONTEXT_KEEP_TURNS_DEFAULT`。 */
  keepRecentTurns?: number;
  /** `false` = `--no-compact`：历史原样发送。 */
  enabled?: boolean;
  /** 系统提示词的 token 估算（给了就和历史共用一本账，避免「各算各的」双花）。 */
  systemTokens?: number;
}

export interface CliHistoryPrep {
  /** 直接交给 `TriggerDeps.prepareHistory`。 */
  prepare: NonNullable<TriggerDeps["prepareHistory"]>;
  /** 运行结束后读它给用户一句实话。 */
  stats: CliContextStats;
}

/** 把用户给的预算收进合法区间；非法值（NaN/负数）回落默认。 */
export function normalizeCliContextBudget(value: number | undefined): number {
  if (typeof value !== "number" || !Number.isFinite(value)) return CLI_CONTEXT_BUDGET_DEFAULT;
  const rounded = Math.floor(value);
  if (rounded < CLI_CONTEXT_BUDGET_MIN) return CLI_CONTEXT_BUDGET_MIN;
  if (rounded > CLI_CONTEXT_BUDGET_MAX) return CLI_CONTEXT_BUDGET_MAX;
  return rounded;
}

/**
 * 解析 `--context-budget` 的取值。
 *
 * 报错而不夹逼：用户写了 100 是想要 100，我们默默换成 500 会让他以为预算生效了，
 * 直到某次请求被折叠得莫名其妙。区间之外的诉求用 `--no-compact` 表达。
 */
export function parseCliContextBudget(
  raw: string,
): { ok: true; value: number } | { ok: false; error: string } {
  if (!/^\d+$/.test(raw) || Number(raw) < 1) {
    return { ok: false, error: `--context-budget 需要正整数（token 数），收到「${raw}」` };
  }
  const value = Number(raw);
  if (value < CLI_CONTEXT_BUDGET_MIN || value > CLI_CONTEXT_BUDGET_MAX) {
    return {
      ok: false,
      error: `--context-budget 要在 ${CLI_CONTEXT_BUDGET_MIN}–${CLI_CONTEXT_BUDGET_MAX} 之间，收到「${raw}」（不要折叠请用 --no-compact）`,
    };
  }
  return { ok: true, value };
}

/** 一次折叠后的说明行：只讲事实（折了多少条、预算多少、有没有被收紧）。 */
export function describeCliContext(stats: CliContextStats): string {
  if (!stats.enabled) return "上下文：不折叠（--no-compact），历史原样发送。";
  if (stats.folded <= 0) {
    return `上下文：历史都在预算内（预算 ${stats.budgetTokens} tokens），没有折叠。`;
  }
  const retry = stats.aggressive > 0 ? `，命中上下文上限后收紧到第 ${stats.aggressive} 级` : "";
  return `上下文：折叠了 ${stats.folded} 条早期对话（预算 ${stats.budgetTokens} tokens${retry}）。`;
}

/**
 * 造一个「带预算的历史准备」函数。
 *
 * 失败一律回落原样发送（`prepareHistory` 内部已经这么做，这里再兜一层）：
 * 预算算错不该让整次运行跑不起来——那比多花点 token 严重得多。
 */
export function createCliHistoryPrep(options: CliContextOptions = {}): CliHistoryPrep {
  const enabled = options.enabled !== false;
  const budgetTokens = normalizeCliContextBudget(options.budgetTokens);
  const keepRecentTurns =
    typeof options.keepRecentTurns === "number" && Number.isFinite(options.keepRecentTurns)
      ? Math.max(1, Math.floor(options.keepRecentTurns))
      : CLI_CONTEXT_KEEP_TURNS_DEFAULT;
  const stats: CliContextStats = {
    folded: 0,
    folds: 0,
    budgetTokens,
    aggressive: 0,
    enabled,
  };

  /** 桌面端设置项的形状；`llmSummary: false` 见文件头「有意不同」那段。 */
  const settings: ContextSettings = {
    enabled,
    budgetTokens,
    keepRecentTurns,
    llmSummary: false,
    autoBudget: false,
  };

  const prepare: NonNullable<TriggerDeps["prepareHistory"]> = async (rows, _agentId, opts) => {
    if (!enabled) {
      stats.folded = 0;
      return rows;
    }
    try {
      const aggressive = opts?.aggressive;
      const prepared = await prepareHistory(rows, {
        settings,
        ...(typeof options.systemTokens === "number" ? { systemTokens: options.systemTokens } : {}),
        ...(aggressive ? { aggressive } : {}),
      });
      const folded = countFoldedMessages(rows, prepared);
      if (folded > 0) {
        stats.folded = folded;
        stats.folds += 1;
      }
      // 收紧级别按「这次请求实际用的预算」记：aggressive 只影响这一次调用。
      stats.aggressive = aggressive ?? 0;
      stats.budgetTokens =
        aggressive === 2
          ? Math.max(1, Math.round(budgetTokens * 0.25))
          : aggressive === 1
            ? Math.max(1, Math.round(budgetTokens * 0.5))
            : budgetTokens;
      return prepared;
    } catch {
      // 预算/摘要任何一步出错都回到「原样发送」：宁可贵一点，也不要跑不起来。
      return rows;
    }
  };

  return { prepare, stats };
}