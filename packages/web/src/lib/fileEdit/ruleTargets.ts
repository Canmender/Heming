/**
 * 一次工具调用「会碰哪些路径」的解析（HITL 规则匹配与「记住本次选择」共用）。
 *
 * 为什么单独一个模块：文件工具的规则授权是**按路径前缀**的（规格 §7），
 * 而闸门拿到的只有 `argsJson`。要判断「这次写入是否被某条目录规则覆盖」，
 * 就必须先把参数里的相对路径解析成绝对路径——这件事干跑层（`apply.ts`）也在做，
 * 所以解析口径统一走 `resolve.ts`，这里只做「从参数到目标清单」的编排。
 *
 * 解析不出来（补丁格式错、路径越界、根不存在）时返回 null：
 * HITL 遇到 null 就退回「按参数摘要匹配」的老口径，**不会**误判成「已授权」。
 */

import { hasDeleteIntent, parsePatch } from "./parse.js";
import {
  compareKey,
  isInsideRoot,
  resolveInsideRoot,
  toPosixPath,
  type FileRoot,
} from "./paths.js";
import { isPatchError, pickRoot, resolvePatchPath } from "./resolve.js";

/** 工具名常量（与 `tools.ts` 的定义保持一致，避免字符串散落）。 */
export const FILE_PATCH_TOOL = "file_patch";
export const FILE_READ_TOOL = "file_read";
export const FILE_WRITE_TOOL = "file_write";
export const FILE_EDIT_TOOL = "file_edit";
export const FILE_GLOB_TOOL = "file_glob";
export const FILE_GREP_TOOL = "file_grep";
export const FILE_IMAGE_TOOL = "file_image";
/** 撤销上一次写入（d.170）：写类工具，目标解析与 file_write 相同。 */
export const FILE_UNDO_TOOL = "file_undo";

/** 本模块能解析的全部文件工具名。 */
export type FileEditToolName =
  | typeof FILE_PATCH_TOOL
  | typeof FILE_READ_TOOL
  | typeof FILE_WRITE_TOOL
  | typeof FILE_EDIT_TOOL
  | typeof FILE_GLOB_TOOL
  | typeof FILE_GREP_TOOL
  | typeof FILE_IMAGE_TOOL
  | typeof FILE_UNDO_TOOL;

const FILE_EDIT_TOOLS: readonly string[] = [
  FILE_PATCH_TOOL,
  FILE_READ_TOOL,
  FILE_WRITE_TOOL,
  FILE_EDIT_TOOL,
  FILE_GLOB_TOOL,
  FILE_GREP_TOOL,
  FILE_IMAGE_TOOL,
  FILE_UNDO_TOOL,
];

/** 是否是本模块能解析的文件工具。 */
export function isFileEditTool(name: string): name is FileEditToolName {
  return FILE_EDIT_TOOLS.includes(name);
}

/**
 * 是否是**会写盘**的文件工具。
 *
 * 为什么单列一个判定：确认卡里「整工具本会话放行」这条捷径必须对写工具关掉
 * （授权只能按目录前缀），而读工具（file_read/file_glob/file_grep）保持原有口径。
 * 判定集中在这里，新增写工具时只改一处，不会漏掉某个调用点。
 */
export function isFileWriteTool(
  name: string,
): name is typeof FILE_PATCH_TOOL | typeof FILE_WRITE_TOOL | typeof FILE_EDIT_TOOL | typeof FILE_UNDO_TOOL {
  return (
    name === FILE_PATCH_TOOL || name === FILE_WRITE_TOOL || name === FILE_EDIT_TOOL || name === FILE_UNDO_TOOL
  );
}

/** 安全解析参数 JSON（解析失败给空对象）。 */
export function parseToolArgs(argsJson: string): Record<string, unknown> {
  const text = (argsJson ?? "").trim();
  if (!text) return {};
  try {
    const parsed: unknown = JSON.parse(text);
    return parsed && typeof parsed === "object" && !Array.isArray(parsed)
      ? (parsed as Record<string, unknown>)
      : {};
  } catch {
    return {};
  }
}

/** 一次调用涉及的目标路径。 */
export interface CallPathTargets {
  tool: FileEditToolName;
  /** 目标绝对路径（正斜杠、去重、保序）。 */
  absolute: string[];
  /** 相对所选根的路径（展示用，与 `absolute` 同序）。 */
  rel: string[];
  /** 涉及的根名（去重）。 */
  rootNames: string[];
  /** 删除语义的变更数（Delete File + 改名）。 */
  deletions: number;
  /**
   * 与 `absolute` 同序的目标类型。`dir` 表示这次操作的对象是**目录**本身
   * （file_glob/file_grep 的 path、或省略 path 时的整个根），归纳前缀时
   * 要保留目录这一层，不能退到父目录。
   */
  kinds?: ("file" | "dir")[];
  /** 补丁原文（`file_patch` 才有，用于确认卡 diff）。 */
  patchText?: string;
}

/** 在全部根里按名字挑一个（读不要求 write 模式）。 */
function pickAnyRoot(roots: FileRoot[], rootName?: string): FileRoot | null {
  if (rootName && rootName.trim()) {
    const wanted = rootName.trim().toLowerCase();
    return roots.find((r) => r.name.trim().toLowerCase() === wanted) ?? null;
  }
  return roots[0] ?? null;
}

/**
 * 给写工具挑根：显式 `root` 按名字找，缺省取第一条**可写**根。
 *
 * 为什么不能直接复用 `pickAnyRoot`：契约规定写工具「root 缺省＝第一条可写根」。
 * 若设置区第一条是只读根，按 roots[0] 解析会把一次合法写入误判成越界
 * （HITL 于是弹窗/拒绝），而工具层其实会落到后面的写根上——两层口径必须一致。
 */
function pickWriteRoot(roots: FileRoot[], rootName?: string): FileRoot | null {
  const named = rootName && rootName.trim() ? pickAnyRoot(roots, rootName) : null;
  if (named) return named;
  if (rootName && rootName.trim()) return null;
  return roots.find((r) => r.mode === "write") ?? roots[0] ?? null;
}

/** 根目录的绝对路径形态（正斜杠、无尾斜杠）——用于「整根」目标。 */
function rootAbsPath(root: FileRoot): string {
  return toPosixPath(root.path).replace(/\/+$/, "");
}

/**
 * 解析一次调用涉及的路径目标；解析不出来返回 null。
 *
 * - `file_patch`：按所选写根解析每个 op（含 `Move to` 目标）。
 * - `file_write` / `file_edit`：单个明确写目标（整份覆盖 / 精确替换），
 *   解析口径与读相同（根内相对路径），但缺省根取第一条**可写**根。
 * - `file_read` / `file_image`：按所选根解析 `path`（读只要求根存在，不要求可写）。
 * - `file_glob` / `file_grep`：`path` 可选；缺省时目标就是所选根本身
 *   （读根即可，因为扫描也包含子目录）。
 */
export function targetsOfCall(
  call: { name: string; argsJson: string },
  roots: FileRoot[],
): CallPathTargets | null {
  if (!isFileEditTool(call.name)) return null;
  const args = parseToolArgs(call.argsJson);
  const rootName = typeof args.root === "string" ? args.root : undefined;

  // 单路径写工具：file_write / file_edit。
  if (isFileWriteTool(call.name) && call.name !== FILE_PATCH_TOOL) {
    const rawPath = typeof args.path === "string" ? args.path.trim() : "";
    if (!rawPath) return null;
    const root = pickWriteRoot(roots, rootName);
    if (!root) return null;
    const abs = resolveInsideRoot(root.path, rawPath);
    if (!abs) return null;
    return {
      tool: call.name,
      absolute: [abs],
      rel: [rawPath.replace(/\\/g, "/")],
      rootNames: [root.name],
      deletions: 0,
    };
  }

  if (call.name === FILE_PATCH_TOOL) {
    return targetsOfPatch(call, roots, args, rootName);
  }

  const rawPath = typeof args.path === "string" ? args.path.trim() : "";
  const root = pickAnyRoot(roots, rootName);
  if (!root) return null;

  if (!rawPath) {
    // file_glob / file_grep 允许省略 path（＝整根）；file_read / file_image 必须有路径。
    if (call.name === FILE_READ_TOOL || call.name === FILE_IMAGE_TOOL) return null;
    return {
      tool: call.name,
      absolute: [rootAbsPath(root)],
      rel: [""],
      kinds: ["dir"],
      rootNames: [root.name],
      deletions: 0,
    };
  }

  const abs = resolveInsideRoot(root.path, rawPath);
  if (!abs) return null;
  return {
    tool: call.name,
    absolute: [abs],
    rel: [rawPath.replace(/\\/g, "/")],
    // glob/grep 的 path 是「在哪个目录下搜」，目录本身就是要授权的对象；
    // file_read 的 path 是文件。两者的前缀归纳口径不同（目录 vs 父目录）。
    kinds: [call.name === FILE_READ_TOOL || call.name === FILE_IMAGE_TOOL ? "file" : "dir"],
    rootNames: [root.name],
    deletions: 0,
  };
}

/** `file_patch` 的目标解析（多作业、含 Move to，逐 op 解析）。 */
function targetsOfPatch(
  call: { name: string; argsJson: string },
  roots: FileRoot[],
  args: Record<string, unknown>,
  rootName?: string,
): CallPathTargets | null {
  const patchText = typeof args.patch === "string" ? args.patch : "";
  const parsed = parsePatch(patchText);
  if (!parsed.ok) return null;
  const selected = pickRoot(roots, rootName);
  if (isPatchError(selected)) return null;

  const absolute: string[] = [];
  const rel: string[] = [];
  const rootNames: string[] = [];
  const seen = new Set<string>();
  const push = (resolved: { abs: string; rel: string; root: FileRoot }): boolean => {
    const key = resolved.abs.toLowerCase();
    if (seen.has(key)) return true;
    seen.add(key);
    absolute.push(resolved.abs);
    rel.push(resolved.rel);
    if (!rootNames.includes(resolved.root.name)) rootNames.push(resolved.root.name);
    return true;
  };

  for (const op of parsed.plan.ops) {
    const source = resolvePatchPath(roots, selected, op.path);
    if (isPatchError(source)) return null;
    push(source);
    if (op.kind === "update" && op.moveTo) {
      const dest = resolvePatchPath(roots, selected, op.moveTo);
      if (isPatchError(dest)) return null;
      push(dest);
    }
  }
  if (absolute.length === 0) return null;
  return {
    tool: FILE_PATCH_TOOL,
    absolute,
    rel,
    rootNames,
    deletions: hasDeleteIntent(parsed.plan.ops) ? parsed.plan.ops.filter((op) => op.kind === "delete" || (op.kind === "update" && op.moveTo)).length : 0,
    patchText,
  };
}

/**
 * 由目标路径归纳「目录前缀规则」（`D:/Obsidian/学院事务/`）。
 *
 * 约束（Lead 定稿）：
 * - 前缀必须来自**用户显式添加的根之内**（可以是根本身，但不能凭空生成到根外）；
 * - 同一目录只留一条（大小写不敏感去重）；
 * - 推导不出来（目标不在允许的根内）返回空数组 —— 调用方据此**不提供**「记住」。
 *
 * @param mode `write` 只允许写根（file_patch/file_write/file_edit）；`any` 任意根（只读三件）
 * @param kinds 与 `absolute` 同序的目标类型；`dir` 目标保留目录这一层
 *   （glob/grep 的 `path` 是「在哪个目录下搜」，记住的应该是该目录而不是它的父目录）
 */
export function dirPrefixesOfTargets(
  absolute: string[],
  roots: FileRoot[],
  mode: "write" | "any" = "write",
  kinds?: readonly ("file" | "dir")[],
): string[] {
  const candidates = roots.filter((r) => (mode === "any" ? true : r.mode === "write"));
  const out: string[] = [];
  const seen = new Set<string>();
  absolute.forEach((target, index) => {
    const isDir = kinds?.[index] === "dir";
    // 最长前缀优先：更具体的根决定这条前缀是否被允许。
    // 目录目标允许「就是根本身」（isInsideRoot 不含根本身，这里显式补上）。
    const root = candidates
      .filter((r) => isInsideRoot(r.path, target) || (isDir && compareKey(r.path) === compareKey(target)))
      .sort((a, b) => b.path.length - a.path.length)[0];
    if (!root) return;
    const cut = target.lastIndexOf("/");
    if (!isDir && cut <= 0) return;
    const dir = isDir ? `${target}/` : `${target.slice(0, cut)}/`;
    const rootPrefix = `${root.path.replace(/\/+$/, "")}/`;
    // 目录必须落在根内（或就是根本身）：不能把根外的目录写成规则
    if (dir.toLowerCase() !== rootPrefix.toLowerCase() && !isInsideRoot(root.path, dir.replace(/\/$/, ""))) {
      return;
    }
    const key = dir.toLowerCase();
    if (seen.has(key)) return;
    seen.add(key);
    out.push(dir);
  });
  return out;
}

/** 由一次调用推导前缀规则；不可推导返回 null（不提供「记住」）。 */
export function prefixRulesOfCall(
  call: { name: string; argsJson: string },
  roots: FileRoot[],
): string[] | null {
  const targets = targetsOfCall(call, roots);
  if (!targets) return null;
  // 写工具的前缀必须落在写根内，否则「记住」会生成一条工具层根本不会执行的授权；
  // 读工具允许任意根（只读根本来就不需要写权限）。
  const mode = isFileWriteTool(targets.tool) ? "write" : "any";
  const prefixes = dirPrefixesOfTargets(targets.absolute, roots, mode, targets.kinds);
  return prefixes.length ? prefixes : null;
}
