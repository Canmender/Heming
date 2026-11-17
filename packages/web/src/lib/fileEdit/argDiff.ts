/**
 * 内联对照（d.239）：从工具**参数**算出「这次调用打算改什么」，给折叠行的展开区做一份
 * 「一眼能看」的增删对照。
 *
 * 为什么需要它：`file_write` 的展开区原来是整段参数 JSON（把几千字正文当字符串读），
 * `file_edit` 则要自己在 old_string / new_string 里找差别——明明改动就在手里，
 * 却要再点开「本轮改动 → 查看改动」才知道改了什么。
 *
 * 口径：
 * - **只从参数推**：参数是模型当时给的内容，不需要再读盘、也不会因为文件后来被改而错位；
 * - **只认能确定语义的三个工具**：`file_write`（整份写入 → 全部是新增）、
 *   `file_edit`（`old_string` → `new_string` 走同一套 LCS）、`file_patch`（补丁文本自带增删前缀，
 *   直接按文法画，不读盘）；`file_undo` 是回滚，有结果文案与撤回入口，不在这里猜；
 * - **失败的调用不显示**：没写成功却画出「改了什么」会骗人。
 */
import { diffLines, type DiffRow } from "./turnDiff.js";

/** 展开区里最多画多少行对照：这里是「看一眼」的地方，全量审阅仍走「查看改动」。 */
export const ARG_DIFF_MAX_ROWS = 40;

export interface ArgDiff {
  rows: DiffRow[];
  /** 新增行数（按全文算，不受显示上限影响）。 */
  added: number;
  /** 删除行数（同上）。 */
  removed: number;
  /** 是否因为显示上限被截断。 */
  truncated: boolean;
}

function readStringArg(argsJson: string, key: string): string | null {
  try {
    const parsed: unknown = JSON.parse(argsJson);
    if (parsed === null || typeof parsed !== "object") return null;
    const value = (parsed as Record<string, unknown>)[key];
    return typeof value === "string" ? value : null;
  } catch {
    return null;
  }
}

function contentLines(text: string): string[] {
  const normalized = text.replace(/\r\n/g, "\n").replace(/\r/g, "\n");
  if (normalized === "") return [];
  const lines = normalized.split("\n");
  // 末尾换行不算「多一行空内容」：文件以 \n 结束是常态
  if (lines[lines.length - 1] === "") lines.pop();
  return lines;
}

/**
 * 参数 → 对照。返回 `null` 表示「这个工具/这份参数没有可画的对照」
 * （未知工具、参数缺字段、非法 JSON、原文与结果一致）。
 */
export function argDiff(name: string, argsJson: string | undefined | null): ArgDiff | null {
  if (!argsJson) return null;
  if (name === "file_write") {
    const content = readStringArg(argsJson, "content");
    if (content === null) return null;
    const lines = contentLines(content);
    if (lines.length === 0) return null;
    const shown = lines.slice(0, ARG_DIFF_MAX_ROWS);
    const rows: DiffRow[] = shown.map((text, index) => ({ kind: "add", text, newNo: index + 1 }));
    return { rows, added: lines.length, removed: 0, truncated: lines.length > shown.length };
  }
  if (name === "file_edit") {
    const before = readStringArg(argsJson, "old_string");
    const after = readStringArg(argsJson, "new_string");
    if (before === null || after === null) return null;
    const result = diffLines(before, after, { maxRows: ARG_DIFF_MAX_ROWS });
    if (result.identical) return null;
    return {
      rows: result.rows,
      added: result.added,
      removed: result.removed,
      truncated: result.truncated,
    };
  }
  if (name === "file_patch") {
    const patch = readStringArg(argsJson, "patch");
    if (patch === null) return null;
    const diff = patchDiff(patch);
    return diff.added === 0 && diff.removed === 0 ? null : diff;
  }
  return null;
}

/** 「新增 3 行 / 删除 1 行」一句话；只有新增/只有删除时不写另一半。 */
export function formatArgDiffStat(diff: ArgDiff): string {
  const parts: string[] = [];
  if (diff.added > 0) parts.push(`新增 ${diff.added} 行`);
  if (diff.removed > 0) parts.push(`删除 ${diff.removed} 行`);
  return parts.length > 0 ? parts.join(" / ") : "没有行变化";
}

/** 补丁里的结构行（这些行不是文件内容，画成上下文即可）。 */
const PATCH_CONTROL_PREFIXES = ["*** Begin Patch", "*** End Patch", "*** Add File:", "*** Update File:", "*** Delete File:", "*** Move to:", "@@"];

/**
 * `file_patch` 的补丁文本 → 对照行。
 *
 * 补丁本身就是「上下文 / 删 / 增」的逐行表达，不需要读盘。文件头与 `@@` 锚点画成
 * 上下文行（`*** Update File: x` 那行能让用户看出这是哪个文件），跳过 `*** Begin/End Patch`。
 */
function patchDiff(patch: string): ArgDiff {
  const lines = contentLines(patch);
  const rows: DiffRow[] = [];
  let added = 0;
  let removed = 0;
  let oldNo = 1;
  let newNo = 1;
  for (const line of lines) {
    if (line.startsWith("*** Begin Patch") || line.startsWith("*** End Patch")) continue;
    const isControl = PATCH_CONTROL_PREFIXES.some((prefix) => line.startsWith(prefix));
    if (isControl) {
      rows.push({ kind: "same", text: line, oldNo, newNo });
      oldNo += 1;
      newNo += 1;
      continue;
    }
    // 补丁文法：`+` 增、`-` 删、空格/空行是上下文（`+++`/`---` 这种文件头不在这里出现）
    if (line.startsWith("+")) {
      added += 1;
      rows.push({ kind: "add", text: line.slice(1), newNo });
      newNo += 1;
    } else if (line.startsWith("-")) {
      removed += 1;
      rows.push({ kind: "del", text: line.slice(1), oldNo });
      oldNo += 1;
    } else {
      rows.push({ kind: "same", text: line.startsWith(" ") ? line.slice(1) : line, oldNo, newNo });
      oldNo += 1;
      newNo += 1;
    }
  }
  const truncated = rows.length > ARG_DIFF_MAX_ROWS;
  return { rows: (truncated ? rows.slice(0, ARG_DIFF_MAX_ROWS) : rows), added, removed, truncated };
}

