/**
 * 工具失败的「为什么 / 下一步」（d.220）。
 *
 * ## 为什么
 *
 * 工具失败时 `toolError.ts` 已经把三样东西拼进结果文本：第一行 `标题（error_code）：说明`、
 * 可选 `可重试：…`、可选 `提示：…`——模型看得到，也能照着改一次就过。
 *
 * 但界面上这些全埋在展开区的原文里：折叠行只看得到参数摘要和「失败」两个字。一个长任务
 * 里七次工具调用里有两次红了，用户得逐条展开才知道是「路径越界」还是「没有可写根」，
 * 更不知道下一步该做什么。于是「它怎么老是失败」就成了对产品的判断，而不是对配置的判断。
 *
 * ## 口径
 *
 * - **只搬运，不发明**：错误码与建议的契约在 `toolError.ts`，这里不另立一套建议表。
 *   解析不出来（不是契约格式）就只给第一行，绝不猜。
 * - 折叠行的标题压到一行（默认 72 字），完整原文仍在 `title` 与展开区里。
 * - 下一步优先用 `提示：`（给人看的出路）；没有提示才用 `可重试：`（照做一次就能过）。
 *   两样都没有就不写「下一步」这一行——不拿「请重试」凑数。
 */

/** 折叠行里失败标题的最大长度（按码点截断）。 */
export const FAILURE_HEADLINE_MAX = 72;

/** 一条工具失败的界面摘要。 */
export interface ToolFailureNote {
  /** 结果第一行：`标题（error_code）：说明`，已截断。 */
  headline: string;
  /** 契约里的 `提示：…`（一句出路）；没有则 null。 */
  hint: string | null;
  /** 契约里的 `可重试：…`（照做一次就能过）；没有则 null。 */
  retry: string | null;
}

const HINT_PREFIX = "提示：";
const RETRY_PREFIX = "可重试：";

/** 按码点截断，超长补省略号（代理对不会被劈开）。 */
function clip(text: string, max: number): string {
  const chars = [...text];
  if (chars.length <= max) return text;
  return `${chars.slice(0, Math.max(0, max - 1)).join("")}…`;
}

/**
 * 从工具结果文本里解析失败摘要。
 *
 * 空串/全空行返回 null（调用方据此不渲染任何失败标记——「没有结果」不等于「失败」）。
 */
export function parseToolFailure(result: string | undefined | null): ToolFailureNote | null {
  const raw = (result ?? "").trim();
  if (!raw) return null;
  const lines = raw
    .split(/\r?\n/)
    .map((line) => line.trim())
    .filter((line) => line.length > 0);
  const first = lines[0];
  if (first === undefined) return null;

  let hint: string | null = null;
  let retry: string | null = null;
  for (const line of lines.slice(1)) {
    if (hint === null && line.startsWith(HINT_PREFIX)) {
      const rest = line.slice(HINT_PREFIX.length).trim();
      if (rest) hint = rest;
      continue;
    }
    if (retry === null && line.startsWith(RETRY_PREFIX)) {
      const rest = line.slice(RETRY_PREFIX.length).trim();
      if (rest) retry = rest;
    }
  }
  return { headline: clip(first, FAILURE_HEADLINE_MAX), hint, retry };
}

/**
 * 「下一步」那句话：优先 `提示：`，其次 `可重试：`，都没有返回 null（不写没有信息量的空话）。
 */
export function failureNextStep(note: ToolFailureNote): string | null {
  if (note.hint) return note.hint;
  if (note.retry) return `可重试：${note.retry}`;
  return null;
}

/** 契约里 `标题（error_code）：说明` 的那个 code（英文 kebab-case，稳定不本地化）。 */
const CODE_RE = /（([a-z][a-z0-9-]{0,40})）/;

/**
 * 从工具结果文本里取稳定错误码（d.221）。
 *
 * 只认 `toolError.ts` 契约里的写法：中文括号里那段英文 kebab-case（`path-escape`、
 * `no-roots`、`match-failed`…）。取不到就返回 null——**绝不按中文猜**，猜错会把
 * 两种完全不同的失败统计成同一类。被用户拒绝的那次没有错误码，由调用方标 `denied`。
 */
export function failureCode(result: string | undefined | null): string | null {
  const raw = (result ?? "").trim();
  if (!raw) return null;
  const firstLine = raw.split(/\r?\n/, 1)[0] ?? "";
  const match = CODE_RE.exec(firstLine);
  return match?.[1] ?? null;
}

