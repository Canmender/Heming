import type { ToolTrace } from "../store/chat.js";

/**
 * 流式气泡里工具调用行的折叠（d.243）。
 *
 * 为什么需要：一次长任务常常连跑十几条命令，每条调用在对话里占一行。行本身是折叠的
 * （点开才看参数/结果），但「十几行工具轨迹」叠在一起仍然会把正文挤到屏幕外——
 * 用户的原话是「大量命令行输出占用屏幕位置」。
 *
 * 折叠口径（三条，都是为了让「有用的那几行」永远留在屏幕上）：
 * 1. 只保留**最近**的几次调用：长任务里用户关心的是「现在在干什么」；
 * 2. **失败/被拒的调用一律不折**：它们才是需要立刻看见、需要点开看原因的行，
 *    折进去等于把「为什么卡住」藏起来；
 * 3. 折掉多少写在按钮上（含其中几次出错），不是静默省略。
 */

/** 少于等于这个数量就不折（5 行以内还没到「挤」的程度）。 */
export const TOOL_TRACE_FOLD_AT = 6;
/** 折叠后保留最近几次（含失败的会额外保留，不计入这个数）。 */
export const TOOL_TRACE_KEEP_RECENT = 3;

export interface FoldedToolTraces {
  /** 需要收起来的旧行（全是成功的；失败/被拒的不会被折进来）。 */
  hidden: ToolTrace[];
  /** 直接显示的行（最近 N 次 + 所有失败/被拒），按原顺序。 */
  visible: ToolTrace[];
  /** hidden 里出错的次数（口径上恒为 0，保留字段是为了让调用方不必假设）。 */
  hiddenFailed: number;
}

function isFailure(trace: ToolTrace): boolean {
  return trace.status === "error" || trace.status === "denied";
}

/**
 * 按「保留最近 N 次 + 不折失败」切分工具轨迹。
 *
 * `at` 与 `keepRecent` 可注入只为测试与将来调参；产品调用直接用默认值。
 */
export function foldToolTraces(
  tools: readonly ToolTrace[],
  at = TOOL_TRACE_FOLD_AT,
  keepRecent = TOOL_TRACE_KEEP_RECENT,
): FoldedToolTraces {
  if (tools.length <= at) return { hidden: [], visible: [...tools], hiddenFailed: 0 };
  const cutoff = Math.max(0, tools.length - Math.max(1, keepRecent));
  const hidden: ToolTrace[] = [];
  const visible: ToolTrace[] = [];
  tools.forEach((trace, index) => {
    // 旧的失败行也留在 visible 里：顺序仍按原时间，只是它们不被折掉。
    if (index < cutoff && !isFailure(trace)) hidden.push(trace);
    else visible.push(trace);
  });
  return { hidden, visible, hiddenFailed: hidden.filter(isFailure).length };
}
