/**
 * 任务交付结论的展示口径（d.252）。
 *
 * 背景：在这之前任务「做完了」只是一个状态位——组长看到 done，却不知道谁做的、
 * 什么时候交的、做成什么样、怎么验证的。结论现在随任务一起存（`result` +
 * `completedAt` + `completedBy`），但面板上只该占一行：完整正文放进 title 悬浮。
 *
 * 只做「怎么把已有的事实说成一句话」，不猜、不补：没有结论就如实写「（没写结论）」。
 */

/** 行内最多显示多少个字（按码点算，emoji 不会被劈开）。 */
export const TASK_RESULT_PREVIEW = 120;

export interface TaskResultNote {
  /** 一行展示用（含「结论：」前缀与提交说明）。 */
  text: string;
  /** 完整结论（悬浮/复制用）；没写结论时是占位文案。 */
  full: string;
}

export interface TaskResultInput {
  result?: string | null;
  completedAt?: string | null;
}

function clip(text: string, max: number): string {
  const chars = [...text];
  if (chars.length <= max) return text;
  return `${chars.slice(0, max).join("")}…`;
}

/**
 * 把「结论 + 谁交的 + 什么时候」拼成一行。
 *
 * 判据是**完成时刻**而不是「有没有结论」：任务被退回未完成时结论还在库里（留作历史），
 * 但界面上不该继续显示成「已提交」——那种状态最容易被读成「这活儿做完了」。
 * 因此 completedAt 为空一律返回 null，调用方据此不渲染这一行。
 */
export function describeTaskResult(
  task: TaskResultInput,
  opts: { who?: string | null; completedText?: string | null } = {},
): TaskResultNote | null {
  const raw = typeof task.result === "string" ? task.result.trim() : "";
  const completedAt = task.completedAt ?? null;
  if (completedAt === null) return null;

  const full = raw === "" ? "（没写结论）" : raw;
  const who = typeof opts.who === "string" && opts.who !== "" ? `${opts.who} 交的` : "已提交";
  const when = typeof opts.completedText === "string" && opts.completedText !== "" ? opts.completedText : null;
  const suffix = when === null ? `（${who}）` : `（${who}，${when}）`;

  return { text: `结论：${clip(raw === "" ? "（没写结论）" : raw, TASK_RESULT_PREVIEW)}${suffix}`, full };
}
