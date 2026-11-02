/**
 * 干跑（dry-run）：把一份解析好的计划变成「每个文件会变成什么」。
 *
 * 这一层是**唯一读盘的地方**（通过注入的 `PatchIo`），也是所有「能不能写」的判定点：
 * 路径是否在根内、文件是否存在、是否二进制、是否超限、锚点是否匹配。
 * 全部通过才返回变更集；任何一项失败整单不产出——规格 §4 的原子性就落在这里。
 *
 * 为什么不直接写：确认卡要拿「改前/改后」做行级 diff，写盘层要拿整份新内容做
 * tmp+rename。先把变更算出来，这两件事都是纯展示/纯 IO，不需要再读一次盘。
 *
 * 本文件不 import 桌面桥：读盘能力由调用方注入（`PatchIo`），所以单测里 IO 是内存假实现，
 * 不需要 jsdom 的 window 桥。
 */

import { MAX_FILE_BYTES, MAX_FILES_PER_PATCH, MAX_PATCH_BYTES } from "./limits.js";
import { applyHunks, buildAddedText } from "./match.js";
import { utf8Bytes, type FileRoot } from "./paths.js";
import { isPatchError, pickRoot, resolvePatchPath } from "./resolve.js";
import type { FileChange, FileOp, PatchError, PatchPlan } from "./types.js";

/** 读一个文件的结果（错误必须分类：文案要按原因分流，规格 §9）。 */
export type ReadResult =
  | { ok: true; content: string; bytes: number }
  | { ok: false; code: "not-found" | "binary" | "too-large" | "io"; error: string };

/** 干跑需要的唯一能力：按绝对路径读文件。 */
export interface PatchIo {
  read(abs: string): Promise<ReadResult>;
}

/** 干跑上下文。 */
export interface PlanContext {
  /** 用户配置的全部根（含只读根：它们参与「能不能写」的判定）。 */
  roots: FileRoot[];
  /** 工具参数 `root`：选中哪个根；缺省用第一个可写根。 */
  rootName?: string;
  /** 补丁原文（只用于总量上限判定）。 */
  patchText: string;
  io: PatchIo;
}

export type PlanResult =
  | { ok: true; changes: FileChange[]; notes: string[]; targets: string[] }
  | { ok: false; error: PatchError };

function fail(code: PatchError["code"], message: string, extra?: Partial<PatchError>): PlanResult {
  return { ok: false, error: { code, message, ...extra } };
}

/** 给失败加文件定位信息。 */
function withPath(error: PatchError, path: string): PatchError {
  return error.path ? error : { ...error, path };
}

/**
 * 干跑一份计划。
 *
 * 顺序：上限（补丁体积/文件数）→ 逐个 op 解析路径并读盘 → 算新内容 → 收集变更。
 * 任何一步失败立即返回，**已经算出的内容全部丢弃**（不写盘，不返回半套）。
 */
export async function planPatch(plan: PatchPlan, ctx: PlanContext): Promise<PlanResult> {
  const patchBytes = utf8Bytes(ctx.patchText ?? "");
  if (patchBytes > MAX_PATCH_BYTES) {
    return fail(
      "patch-too-large",
      `补丁总量 ${Math.round(patchBytes / 1024)} KB 超过上限 ${Math.round(MAX_PATCH_BYTES / 1024)} KB。请拆成多次调用。`,
    );
  }

  const selected = pickRoot(ctx.roots, ctx.rootName);
  if (isPatchError(selected)) return { ok: false, error: selected };

  const changes: FileChange[] = [];
  const notes: string[] = [];
  const targets: string[] = [];
  /** 已解析出的绝对路径：两个不同写法落到同一个文件时，后一个必须报错而不是覆盖前一个。 */
  const seen = new Set<string>();

  const addTarget = (abs: string): boolean => {
    const key = abs.toLowerCase();
    if (seen.has(key)) return false;
    seen.add(key);
    targets.push(abs);
    return true;
  };

  const checkBytes = (abs: string, rel: string, text: string): PatchError | null => {
    const bytes = utf8Bytes(text);
    if (bytes > MAX_FILE_BYTES) {
      return {
        code: "file-too-large",
        path: rel,
        message: `文件 ${rel} 改后约 ${Math.round(bytes / 1024)} KB，超过单文件上限 ${Math.round(MAX_FILE_BYTES / 1024)} KB。请拆成多次补丁。`,
      };
    }
    return null;
  };

  for (const op of plan.ops) {
    if (changes.length >= MAX_FILES_PER_PATCH) {
      return fail(
        "too-many-files",
        `单次调用最多修改 ${MAX_FILES_PER_PATCH} 个文件，请拆成多次调用。`,
      );
    }

    if (op.kind === "add") {
      const target = resolvePatchPath(ctx.roots, selected, op.path);
      if (isPatchError(target)) return { ok: false, error: target };
      if (!addTarget(target.abs)) {
        return fail("invalid-patch", `同一份补丁里重复操作了 ${target.rel}，请合并成一次。`, { path: op.path });
      }
      const existing = await ctx.io.read(target.abs);
      if (existing.ok) {
        return fail(
          "file-exists",
          `目标已存在：${target.rel}。要改已存在的文件请改用 \`*** Update File: ${target.rel}\`。`,
          { path: op.path },
        );
      }
      if (existing.code !== "not-found") {
        return fail(
          "file-exists",
          `目标 ${target.rel} 已存在但无法读取（${existing.error}）。要改它请用 \`*** Update File\`，要新建请换一个路径。`,
          { path: op.path },
        );
      }
      const newText = buildAddedText(op.lines);
      const tooLarge = checkBytes(target.abs, target.rel, newText);
      if (tooLarge) return { ok: false, error: tooLarge };
      changes.push({
        abs: target.abs,
        rel: target.rel,
        root: target.root.name,
        kind: "A",
        oldText: null,
        newText,
      });
      continue;
    }

    if (op.kind === "delete") {
      const target = resolvePatchPath(ctx.roots, selected, op.path);
      if (isPatchError(target)) return { ok: false, error: target };
      if (!addTarget(target.abs)) {
        return fail("invalid-patch", `同一份补丁里重复操作了 ${target.rel}，请合并成一次。`, { path: op.path });
      }
      const existing = await ctx.io.read(target.abs);
      if (!existing.ok) return { ok: false, error: readFailure(op, target.rel, existing) };
      changes.push({
        abs: target.abs,
        rel: target.rel,
        root: target.root.name,
        kind: "D",
        oldText: existing.content,
        newText: null,
      });
      continue;
    }

    // update（可带改名）
    const source = resolvePatchPath(ctx.roots, selected, op.path);
    if (isPatchError(source)) return { ok: false, error: source };
    const existing = await ctx.io.read(source.abs);
    if (!existing.ok) return { ok: false, error: readFailure(op, source.rel, existing) };
    if (existing.bytes > MAX_FILE_BYTES) {
      return fail(
        "file-too-large",
        `文件 ${source.rel} 有 ${Math.round(existing.bytes / 1024)} KB，超过单文件上限 ${Math.round(MAX_FILE_BYTES / 1024)} KB。请先拆分文件或改用别的办法。`,
        { path: op.path },
      );
    }

    const applied = applyHunks(existing.content, op.hunks, source.rel);
    if (!applied.ok) {
      if (!addTarget(source.abs)) {
        return fail("invalid-patch", `同一份补丁里重复操作了 ${source.rel}，请合并成一次。`, { path: op.path });
      }
      return { ok: false, error: withPath(applied.error, op.path) };
    }
    notes.push(...applied.notes);

    if (op.moveTo) {
      const dest = resolvePatchPath(ctx.roots, selected, op.moveTo);
      if (isPatchError(dest)) return { ok: false, error: dest };
      if (!addTarget(source.abs) || !addTarget(dest.abs)) {
        return fail("invalid-patch", `同一份补丁里重复操作了 ${dest.rel}，请合并成一次。`, { path: op.moveTo });
      }
      const destExisting = await ctx.io.read(dest.abs);
      if (destExisting.ok) {
        return fail(
          "file-exists",
          `改名目标已存在：${dest.rel}。请先确认要覆盖还是换个名字（本工具不会覆盖已有文件）。`,
          { path: op.moveTo },
        );
      }
      const tooLarge = checkBytes(dest.abs, dest.rel, applied.text);
      if (tooLarge) return { ok: false, error: tooLarge };
      // 改名 = 删旧 + 增新：两个变更条目，写盘层照此执行，A/M/D 统计也是 1A + 1D。
      changes.push({
        abs: source.abs,
        rel: source.rel,
        root: source.root.name,
        kind: "D",
        oldText: existing.content,
        newText: null,
      });
      changes.push({
        abs: dest.abs,
        rel: dest.rel,
        root: dest.root.name,
        kind: "A",
        oldText: null,
        newText: applied.text,
        movedFrom: source.rel,
      });
      continue;
    }

    if (!addTarget(source.abs)) {
      return fail("invalid-patch", `同一份补丁里重复操作了 ${source.rel}，请合并成一次。`, { path: op.path });
    }
    const tooLarge = checkBytes(source.abs, source.rel, applied.text);
    if (tooLarge) return { ok: false, error: tooLarge };
    changes.push({
      abs: source.abs,
      rel: source.rel,
      root: source.root.name,
      kind: "M",
      oldText: existing.content,
      newText: applied.text,
    });
  }

  if (changes.length === 0) return { ok: false, error: { code: "empty-patch", message: "No files were modified" } };
  return { ok: true, changes, notes, targets };
}

/** 读盘失败 → 按原因给可行动文案（规格 §9）。 */
function readFailure(op: FileOp, rel: string, result: Exclude<ReadResult, { ok: true }>): PatchError {
  if (result.code === "not-found") {
    return {
      code: "file-not-found",
      path: op.path,
      message:
        op.kind === "delete"
          ? `要删除的文件不存在：${rel}。请先用 file_read 确认路径，或省略这一步。`
          : `要修改的文件不存在：${rel}。请先用 file_read 确认路径；如果本意是新建文件，请改用 \`*** Add File: ${rel}\`。`,
    };
  }
  if (result.code === "binary") {
    return {
      code: "binary-file",
      path: op.path,
      message: `${rel} 不是 UTF-8 文本文件（检测到二进制内容），本工具只处理文本。`,
    };
  }
  if (result.code === "too-large") {
    return {
      code: "file-too-large",
      path: op.path,
      message: `${rel} 超过单文件上限 ${Math.round(MAX_FILE_BYTES / 1024)} KB，无法读取。`,
    };
  }
  return { code: "write-failed", path: op.path, message: `读取 ${rel} 失败：${result.error}` };
}

/** A/M/D 统计（确认卡与工具结果文案共用）。 */
export function sumKinds(changes: FileChange[]): { added: number; modified: number; deleted: number } {
  let added = 0;
  let modified = 0;
  let deleted = 0;
  for (const change of changes) {
    if (change.kind === "A") added += 1;
    else if (change.kind === "D") deleted += 1;
    else modified += 1;
  }
  return { added, modified, deleted };
}

/** 「将修改 N 个文件（A/M/D）」的一句话。 */
export function kindsSummary(changes: FileChange[]): string {
  const { added, modified, deleted } = sumKinds(changes);
  const parts: string[] = [];
  if (added) parts.push(`${added} 个新增`);
  if (modified) parts.push(`${modified} 个修改`);
  if (deleted) parts.push(`${deleted} 个删除`);
  return `将修改 ${changes.length} 个文件（${parts.join("、") || "无变更"}）`;
}
