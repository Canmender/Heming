/**
 * 行级 diff（d.207.4.110）：给「这一轮到底改了什么」算一份能读的对照。
 *
 * ## 为什么自己写
 *
 * 只要「改动前 / 改动后」两段文本、要的是**人眼能扫的对照**，不是给机器打补丁的 unified diff。
 * 引入 diff 库要为一个纯函数加依赖，而这里要的口径很窄：前缀/后缀相同的行先剥掉，中间用
 * 最长公共子序列对齐，长段未改动折叠，统计增删行数。几百行文件的全量 DP 是毫秒级。
 *
 * ## 口径
 *
 * - 行尾统一按 `\n` 切（先把 `\r\n` 收敛成 `\n`）：Windows 文件的 CRLF 不该让每一行都算「改了」。
 * - 未改动的长段折叠成一行「…（省略 N 行未改动）」：用户要的是改动，不是整篇文件。
 * - 超过 `DIFF_MAX_ROWS` 时只回前若干行并标 `truncated`：**不假装完整**——界面据此提示去撤回或看全文件。
 */

/** 单次对照最多回多少行（含上下文与折叠标记行）。 */
export const DIFF_MAX_ROWS = 600;

/** 改动前后各保留几行未改动内容作上下文。 */
export const DIFF_CONTEXT_LINES = 3;

export type DiffRow =
  | { kind: "same"; text: string; oldNo: number; newNo: number; omitted?: number }
  | { kind: "add"; text: string; newNo: number }
  | { kind: "del"; text: string; oldNo: number };

export interface DiffResult {
  rows: DiffRow[];
  /** 新增行数。 */
  added: number;
  /** 删除行数。 */
  removed: number;
  /** 是否因行数上限而截断。 */
  truncated: boolean;
  /** 两边是否完全一致（据此决定要不要弹窗）。 */
  identical: boolean;
}

type Op = { kind: "same" | "add" | "del"; text: string; omitted?: number };

function splitLines(text: string): string[] {
  const normalized = text.replace(/\r\n/g, "\n").replace(/\r/g, "\n");
  if (normalized === "") return [];
  const lines = normalized.split("\n");
  // 末尾换行不算「多一行空内容」：文件以 \n 结束是常态
  if (lines.length > 0 && lines[lines.length - 1] === "") lines.pop();
  return lines;
}

/** 最长公共子序列 → 一条有序的 same/add/del 操作流。 */
function align(before: string[], after: string[]): Op[] {
  // 先剥公共前后缀：绝大多数「改几行」的文件到这里就只剩一小段，DP 规模骤降
  let head = 0;
  while (head < before.length && head < after.length && before[head] === after[head]) head += 1;
  let tail = 0;
  while (
    tail < before.length - head &&
    tail < after.length - head &&
    before[before.length - 1 - tail] === after[after.length - 1 - tail]
  ) {
    tail += 1;
  }

  const midBefore = before.slice(head, before.length - tail);
  const midAfter = after.slice(head, after.length - tail);
  const ops: Op[] = [];
  for (let i = 0; i < head; i += 1) ops.push({ kind: "same", text: before[i] ?? "" });

  const n = midBefore.length;
  const m = midAfter.length;
  if (n === 0) {
    for (const text of midAfter) ops.push({ kind: "add", text });
  } else if (m === 0) {
    for (const text of midBefore) ops.push({ kind: "del", text });
  } else {
    // dp[i][j] = midBefore[i..] 与 midAfter[j..] 的 LCS 长度
    const width = m + 1;
    const dp = new Uint32Array((n + 1) * width);
    for (let i = n - 1; i >= 0; i -= 1) {
      for (let j = m - 1; j >= 0; j -= 1) {
        dp[i * width + j] =
          midBefore[i] === midAfter[j]
            ? dp[(i + 1) * width + (j + 1)]! + 1
            : Math.max(dp[(i + 1) * width + j]!, dp[i * width + (j + 1)]!);
      }
    }
    let i = 0;
    let j = 0;
    while (i < n && j < m) {
      if (midBefore[i] === midAfter[j]) {
        ops.push({ kind: "same", text: midBefore[i] ?? "" });
        i += 1;
        j += 1;
      } else if (dp[(i + 1) * width + j]! >= dp[i * width + (j + 1)]!) {
        ops.push({ kind: "del", text: midBefore[i] ?? "" });
        i += 1;
      } else {
        ops.push({ kind: "add", text: midAfter[j] ?? "" });
        j += 1;
      }
    }
    while (i < n) {
      ops.push({ kind: "del", text: midBefore[i] ?? "" });
      i += 1;
    }
    while (j < m) {
      ops.push({ kind: "add", text: midAfter[j] ?? "" });
      j += 1;
    }
  }

  for (let k = 0; k < tail; k += 1) ops.push({ kind: "same", text: before[before.length - tail + k] ?? "" });
  return ops;
}

/** 把连续的未改动行折叠：首尾各留 `context` 行，中间记成「省略 N 行」。 */
function collapseSameRuns(ops: Op[], context: number): Op[] {
  const out: Op[] = [];
  let i = 0;
  while (i < ops.length) {
    const op = ops[i]!;
    if (op.kind !== "same") {
      out.push(op);
      i += 1;
      continue;
    }
    let end = i;
    while (end < ops.length && ops[end]!.kind === "same") end += 1;
    const runLength = end - i;
    // 文件头/尾的未改动段没有「上文/下文」需要交代，整段折叠即可
    const atHead = i === 0;
    const atTail = end === ops.length;
    const keepHead = atHead ? 0 : context;
    const keepTail = atTail ? 0 : context;
    if (runLength <= keepHead + keepTail + 1) {
      for (let k = i; k < end; k += 1) out.push(ops[k]!);
    } else {
      for (let k = i; k < i + keepHead; k += 1) out.push(ops[k]!);
      out.push({ kind: "same", text: `…（省略 ${runLength - keepHead - keepTail} 行未改动）`, omitted: runLength - keepHead - keepTail });
      for (let k = end - keepTail; k < end; k += 1) out.push(ops[k]!);
    }
    i = end;
  }
  return out;
}

/**
 * 算一份行级对照。
 *
 * `options.maxRows` / `options.context` 主要给测试用；产品里用默认值。
 */
export function diffLines(
  before: string,
  after: string,
  options: { maxRows?: number; context?: number } = {},
): DiffResult {
  const maxRows = options.maxRows ?? DIFF_MAX_ROWS;
  const context = options.context ?? DIFF_CONTEXT_LINES;
  const beforeLines = splitLines(before);
  const afterLines = splitLines(after);
  // 完全一致时不要走折叠：否则整篇未改动会被折成一行「省略 N 行」，看着像有改动
  if (beforeLines.length === afterLines.length && beforeLines.every((line, i) => line === afterLines[i])) {
    return { rows: [], added: 0, removed: 0, truncated: false, identical: true };
  }
  const ops = collapseSameRuns(align(beforeLines, afterLines), context);

  let added = 0;
  let removed = 0;
  for (const op of ops) {
    if (op.kind === "add") added += 1;
    else if (op.kind === "del") removed += 1;
  }

  const rows: DiffRow[] = [];
  let oldNo = 1;
  let newNo = 1;
  for (const op of ops) {
    if (op.kind === "same") {
      const row: DiffRow = { kind: "same", text: op.text, oldNo, newNo };
      if (typeof (op as { omitted?: number }).omitted === "number") row.omitted = (op as { omitted?: number }).omitted;
      rows.push(row);
      oldNo += 1;
      newNo += 1;
    } else if (op.kind === "add") {
      rows.push({ kind: "add", text: op.text, newNo });
      newNo += 1;
    } else {
      rows.push({ kind: "del", text: op.text, oldNo });
      oldNo += 1;
    }
    if (rows.length >= maxRows) break;
  }

  return {
    rows,
    added,
    removed,
    truncated: rows.length >= maxRows && rows.length < ops.length,
    identical: added === 0 && removed === 0,
  };
}

/** 「新增 3 行 / 删除 1 行」这种一句话摘要（无改动时如实说没变化）。 */
export function formatDiffStat(result: DiffResult): string {
  if (result.identical) return "内容没有变化";
  const parts: string[] = [];
  if (result.added > 0) parts.push(`新增 ${result.added} 行`);
  if (result.removed > 0) parts.push(`删除 ${result.removed} 行`);
  return parts.join(" · ");
}
