/**
 * 确认卡的补丁预览：把一次 `file_patch` 变成「将修改 N 个文件（A/M/D）+ 行级 diff」。
 *
 * 与 `hitl/preview.ts` 的关系：那边是**参数级**预览（old_string/new_string），
 * 不读磁盘；补丁的参数是一整份协议文本，光看参数看不出「最终文件长什么样」，
 * 所以这里要读盘做一次干跑。diff 本身**复用** `preview.ts` 的 `diffLines`，
 * 不另造一套——两套的截断与统计口径迟早会不一致。
 *
 * 三条硬约束（Lead 定稿）：
 * 1. **脱敏**：疑似密钥的行在预览里隐藏（预览是给人看的，不能把密钥摆到屏幕上；
 *    也绝不把预览内容写进日志）；
 * 2. **截断**：总行数超过 `PATCH_PREVIEW_MAX_LINES` 时截断并注明；
 * 3. **只读**：预览只调 `read`，绝不触发任何写入。
 */

import { kindsSummary, planPatch } from "./apply.js";
import { getFileBridge, type FileFsBridge } from "./bridge.js";
import { splitText } from "./match.js";
import { parsePatch } from "./parse.js";
import { fileRootsStore } from "./roots.js";
import type { FileRoot } from "./paths.js";
import { parseToolArgs } from "./ruleTargets.js";
import { containsSensitive } from "../selfEdit/guards.js";
import { diffLines, type PreviewLine } from "../hitl/preview.js";
import type { ChangeKind, PatchError } from "./types.js";

/** 预览最多展示多少行（跨文件累计）。 */
export const PATCH_PREVIEW_MAX_LINES = 200;

/** 单文件预览。 */
export interface PatchFilePreview {
  /** 相对路径。 */
  rel: string;
  kind: ChangeKind;
  /** 改名来源（`kind=M` 且路径变了时才有）。 */
  movedFrom?: string;
  /** 该文件完整的增/删行数（不受截断影响）。 */
  added: number;
  removed: number;
  /** 展示用的 diff 行。 */
  lines: PreviewLine[];
  /** 该文件的行被截断过。 */
  truncated: boolean;
}

/** 一次补丁的预览。 */
export interface PatchPreview {
  /** 「将修改 N 个文件（A/M/D）」。 */
  summary: string;
  files: PatchFilePreview[];
  /** 总展示行数（截断后）。 */
  shownLines: number;
  /** 是否因超限截断。 */
  truncated: boolean;
  /** 预览生成失败时的原因（例如补丁格式错）；此时 `files` 为空。 */
  error?: string;
}

/** 疑似密钥的行替换成这个标记（不给用户看，也不进日志）。 */
const MASKED_LINE = "…（该行含疑似敏感内容，已隐藏）";

/** 脱敏：命中密钥特征的行整体隐藏。 */
function sanitize(line: string): string {
  return containsSensitive(line) ? MASKED_LINE : line;
}

/** 把一组文本行变成预览行（带脱敏）。 */
function toPreviewLines(lines: string[], kind: "add" | "del"): PreviewLine[] {
  return lines.map((text) => ({ kind, text: sanitize(text) }));
}

export interface PatchPreviewDeps {
  bridge?: FileFsBridge | null;
  roots?: FileRoot[];
}

/**
 * 构造预览；拿不到桥、参数里没有补丁时返回 null（调用方什么都不显示）。
 *
 * 补丁本身有问题时返回 `{ error }`：用户至少能看到「这次不会改任何文件」，
 * 而不是一个永远转圈的预览。
 */
export async function buildPatchPreview(
  argsJson: string,
  deps?: PatchPreviewDeps,
): Promise<PatchPreview | null> {
  const args = parseToolArgs(argsJson);
  const patchText = typeof args.patch === "string" ? args.patch : "";
  if (!patchText.includes("*** Begin Patch")) return null;

  const bridge = deps?.bridge ?? getFileBridge();
  if (!bridge) return null;
  const roots = deps?.roots ?? fileRootsStore.roots();
  const rootName = typeof args.root === "string" ? args.root : undefined;

  const parsed = parsePatch(patchText);
  if (!parsed.ok) {
    return { summary: "补丁格式有误，不会修改任何文件", files: [], shownLines: 0, truncated: false, error: formatError(parsed.error) };
  }

  const planned = await planPatch(parsed.plan, {
    roots,
    ...(rootName ? { rootName } : {}),
    patchText,
    io: {
      read: async (abs) => {
        const result = await bridge.read({ roots, path: abs });
        if (result.ok) return { ok: true, content: result.content, bytes: result.bytes };
        const code =
          result.code === "not-found" ? "not-found" : result.code === "binary" ? "binary" : result.code === "too-large" ? "too-large" : "io";
        return { ok: false, code, error: result.error || "读取失败" };
      },
    },
  });
  if (!planned.ok) {
    return {
      summary: "补丁无法应用，不会修改任何文件",
      files: [],
      shownLines: 0,
      truncated: false,
      error: formatError(planned.error),
    };
  }

  const files: PatchFilePreview[] = [];
  let budget = PATCH_PREVIEW_MAX_LINES;
  let truncated = false;
  let shownLines = 0;

  for (const change of planned.changes) {
    let lines: PreviewLine[];
    let added = 0;
    let removed = 0;

    if (change.kind === "A") {
      const body = splitText(change.newText ?? "").lines;
      lines = toPreviewLines(body, "add");
      added = body.length;
    } else if (change.kind === "D") {
      const body = splitText(change.oldText ?? "").lines;
      lines = toPreviewLines(body, "del");
      removed = body.length;
    } else {
      const before = splitText(change.oldText ?? "").lines;
      const after = splitText(change.newText ?? "").lines;
      const diff = diffLines(before, after);
      lines = diff.lines.map((line) => ({ kind: line.kind, text: sanitize(line.text) }));
      added = diff.added;
      removed = diff.removed;
    }

    const take = Math.max(0, Math.min(lines.length, budget));
    const fileTruncated = take < lines.length;
    if (fileTruncated) truncated = true;
    budget -= take;
    shownLines += take;
    files.push({
      rel: change.rel,
      kind: change.kind,
      ...(change.movedFrom ? { movedFrom: change.movedFrom } : {}),
      added,
      removed,
      lines: lines.slice(0, take),
      truncated: fileTruncated,
    });
  }

  return { summary: kindsSummary(planned.changes), files, shownLines, truncated };
}

/** 预览里的失败文案（简短版：确认卡上不需要完整的分步建议）。 */
function formatError(error: PatchError): string {
  return error.path ? `${error.message}（${error.path}）` : error.message;
}
