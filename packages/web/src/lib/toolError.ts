/**
 * 工具失败契约（P2-T9）。
 *
 * 为什么要有这个模块：工具失败时，模型只看到一段中文散文，于是常见三种坏重试——
 * 换个写法再撞一次、干脆放弃、把错误原文抄给用户。把「错在哪」「怎么改一次就能过」
 * 「一句出路」拆成稳定字段，模型才有一次改对的机会；UI 与归因（T16）也能按
 * `error_code` 分类统计，而不必解析中文。
 *
 * 约束（改契约前先读）：
 * - `error_code` 是**稳定契约**：已发布的 code 不要改名（用例、报表、归因都按它归类），
 *   新错误就加新 code。
 * - `retry_with` 只在「照做就能成功」时给。越界、被拒绝这类不可重试的失败宁可不写，
 *   也不要写「请重试」——模型会真的原样重试。
 * - 文本层保持向后兼容：原有中文开头一行不动，契约行追加在后面。旧断言与用户看到
 *   的文案都不受影响，只是多了两行可执行的建议。
 */

/** 一次工具失败的机器可读描述。 */
export interface ToolFailure {
  /** 稳定错误码（英文 kebab-case，不本地化）。 */
  error_code: string;
  /** 参数级重试建议：模型照做一次就能通过；不可重试时省略。 */
  retry_with?: string;
  /** 一句解释或出路（给人看，也给模型看）。 */
  hint?: string;
}

/** 失败的工具结果：`text` 给模型/用户，`error` 给上层统计。 */
export interface ToolFailureResult {
  text: string;
  ok: false;
  error: ToolFailure;
}

/** 契约行：`可重试：…` / `提示：…`，没有字段就整行不出现。 */
export function contractLines(failure: ToolFailure): string[] {
  const lines: string[] = [];
  if (failure.retry_with) lines.push(`可重试：${failure.retry_with}`);
  if (failure.hint) lines.push(`提示：${failure.hint}`);
  return lines;
}

/**
 * 由「标题 + 说明 + 契约」拼一条失败结果。
 *
 * 标题沿用各模块既有中文（如「锚点匹配失败」「未知工具」），错误码放在括号里，
 * 与 fileEdit 既有格式 `标题（code）：说明` 一致。
 */
export function failureResult(title: string, message: string, failure: ToolFailure): ToolFailureResult {
  const head = `${title}（${failure.error_code}）：${message}`;
  return {
    text: [head, ...contractLines(failure)].join("\n"),
    ok: false,
    error: failure,
  };
}

/**
 * 在既有文案后追加契约行（文案已成型、不想重排时用）。
 *
 * `extraLines` 用于模块自己的补充说明（例如 fileEdit 的「整份补丁未写入任何文件。」），
 * 会排在契约行之前、文案之后，保持原来的语序。
 */
export function appendFailure(message: string, failure: ToolFailure, extraLines: string[] = []): ToolFailureResult {
  const lines = [...extraLines, ...contractLines(failure)];
  return {
    text: lines.length ? `${message}\n${lines.join("\n")}` : message,
    ok: false,
    error: failure,
  };
}
