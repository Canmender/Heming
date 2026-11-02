/**
 * 工具调用的「变更预览」：在确认弹窗里让用户先看到要写入什么。
 *
 * 只解析**明确的文件写入形态**（path + content / old_string + new_string / delete），
 * 其余工具一律返回 null——参数里可能含密钥、请求头等敏感值，不能拿来猜着展示。
 *
 * 预览不读磁盘：删除类操作只显示目标路径，避免为了展示去访问用户文件。
 */

/** 单行预览：`add` / `del` / `ctx`（上下文）。 */
export interface PreviewLine {
  kind: "add" | "del" | "ctx";
  text: string;
}

export interface ChangePreview {
  kind: "edit" | "write" | "delete";
  /** 目标路径（存在时展示）。 */
  path?: string;
  /** 完整变更的新增 / 删除行数（不受截断影响）。 */
  added: number;
  removed: number;
  lines: PreviewLine[];
  /** 行数超过上限被截断。 */
  truncated: boolean;
}

/** 预览最多展示的行数：足够判断改了什么，又不至于把弹窗撑爆。 */
export const PREVIEW_MAX_LINES = 40;

/** 参与 diff 的单侧最大行数，防止对超大文件做前缀/后缀比较拖慢渲染。 */
const MAX_DIFF_LINES = 400;

function str(value: unknown): string | undefined {
  return typeof value === "string" && value.length > 0 ? value : undefined;
}

/** 统一换行并去掉末尾空行（避免每份内容都多显示一行空白）。 */
function toLines(text: string): string[] {
  const normalized = text.replace(/\r\n?/g, "\n");
  const lines = normalized.split("\n");
  if (lines.length > 1 && lines[lines.length - 1] === "") lines.pop();
  return lines;
}

/**
 * 简单行级 diff：先剥掉公共前缀/后缀，中间部分整体标为删除 + 新增。
 *
 * 不引入 diff 库：确认弹窗只需要「改了什么」的直觉，不需要最小编辑脚本；
 * 前缀/后缀剥离对「改几行」的常见场景已经足够准确，且结果完全确定。
 *
 * ★ 导出给 `lib/fileEdit/patchPreview.ts` 复用（file_patch 的多文件 diff 也走这一份），
 * 不要再造第二套 diff——两套的截断/统计口径迟早会不一致。
 */
export function diffLines(
  before: string[],
  after: string[],
): { lines: PreviewLine[]; added: number; removed: number } {
  const max = Math.min(before.length, after.length, MAX_DIFF_LINES);
  let prefix = 0;
  while (prefix < max && before[prefix] === after[prefix]) prefix += 1;
  let suffix = 0;
  while (
    suffix < max - prefix &&
    before[before.length - 1 - suffix] === after[after.length - 1 - suffix]
  ) {
    suffix += 1;
  }

  const removedLines = before.slice(prefix, before.length - suffix);
  const addedLines = after.slice(prefix, after.length - suffix);
  const lines: PreviewLine[] = [];
  // 保留两行上下文，帮助用户定位改动。
  for (const text of before.slice(Math.max(0, prefix - 2), prefix)) {
    lines.push({ kind: "ctx", text });
  }
  for (const text of removedLines) lines.push({ kind: "del", text });
  for (const text of addedLines) lines.push({ kind: "add", text });
  for (const text of after.slice(after.length - suffix, after.length - suffix + 2)) {
    lines.push({ kind: "ctx", text });
  }

  return {
    lines,
    added: after.length - suffix - prefix,
    removed: before.length - suffix - prefix,
  };
}

function truncate(lines: PreviewLine[]): { lines: PreviewLine[]; truncated: boolean } {
  if (lines.length <= PREVIEW_MAX_LINES) return { lines, truncated: false };
  return { lines: lines.slice(0, PREVIEW_MAX_LINES), truncated: true };
}

/**
 * 从工具参数构造变更预览。识别不了（或参数不是 JSON 对象）时返回 null。
 *
 * 识别口径：
 * - `old_string` + `new_string` → 编辑；
 * - `path`（或 file_path 等）+ `content`（或 text）→ 写入；
 * - 工具名含 delete 且带路径 → 删除（只显示路径）。
 */
export function buildChangePreview(toolName: string, argsJson: string): ChangePreview | null {
  let args: Record<string, unknown>;
  try {
    const parsed: unknown = JSON.parse(argsJson);
    if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) return null;
    args = parsed as Record<string, unknown>;
  } catch {
    return null;
  }

  const path =
    str(args.path) ??
    str(args.file_path) ??
    str(args.filePath) ??
    str(args.file) ??
    str(args.target);

  const before = str(args.old_string) ?? str(args.oldString) ?? str(args.old_content);
  const after = str(args.new_string) ?? str(args.newString) ?? str(args.new_content);

  if (before !== undefined && after !== undefined) {
    const diff = diffLines(toLines(before), toLines(after));
    const clamped = truncate(diff.lines);
    return {
      kind: "edit",
      ...(path ? { path } : {}),
      added: diff.added,
      removed: diff.removed,
      lines: clamped.lines,
      truncated: clamped.truncated,
    };
  }

  const content = str(args.content) ?? str(args.newText);
  if (path && content !== undefined) {
    const lines = toLines(content).map((text): PreviewLine => ({ kind: "add", text }));
    const clamped = truncate(lines);
    return {
      kind: "write",
      path,
      added: lines.length,
      removed: 0,
      lines: clamped.lines,
      truncated: clamped.truncated,
    };
  }

  // 没有内容可看的删除：不读磁盘，只提示目标。
  // 必须靠工具名判定——只凭「有 path 没 content」会把读文件误标成删除。
  const deleting = /(?:^|[_\s-])(?:delete|remove|unlink)(?:$|[_\s-])/i.test(toolName);
  if (path && deleting) {
    return {
      kind: "delete",
      path,
      added: 0,
      removed: 0,
      lines: [{ kind: "del", text: path }],
      truncated: false,
    };
  }

  return null;
}

/** 预览标题里的统计文案。 */
export function changeCountLabel(preview: ChangePreview): string {
  if (preview.kind === "delete") return "将删除";
  return `+${preview.added} −${preview.removed}`;
}
