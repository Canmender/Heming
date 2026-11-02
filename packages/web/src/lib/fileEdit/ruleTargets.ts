/**
 * 一次工具调用「会碰哪些路径」的解析（HITL 规则匹配与「记住本次选择」共用）。
 *
 * 为什么单独一个模块：`file_patch` 的规则授权是**按路径前缀**的（规格 §7），
 * 而闸门拿到的只有 `argsJson`。要判断「这次补丁是否被某条目录规则覆盖」，
 * 就必须先把补丁里的相对路径解析成绝对路径——这件事干跑层（`apply.ts`）也在做，
 * 所以解析口径统一走 `resolve.ts`，这里只做「从参数到目标清单」的编排。
 *
 * 解析不出来（补丁格式错、路径越界、根不存在）时返回 null：
 * HITL 遇到 null 就退回「按参数摘要匹配」的老口径，**不会**误判成「已授权」。
 */

import { hasDeleteIntent, parsePatch } from "./parse.js";
import { isInsideRoot, resolveInsideRoot, type FileRoot } from "./paths.js";
import { isPatchError, pickRoot, resolvePatchPath } from "./resolve.js";

/** 工具名常量（与 `tools.ts` 的定义保持一致，避免字符串散落）。 */
export const FILE_PATCH_TOOL = "file_patch";
export const FILE_READ_TOOL = "file_read";

/** 是否是本模块能解析的文件工具。 */
export function isFileEditTool(name: string): name is typeof FILE_PATCH_TOOL | typeof FILE_READ_TOOL {
  return name === FILE_PATCH_TOOL || name === FILE_READ_TOOL;
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
  tool: typeof FILE_PATCH_TOOL | typeof FILE_READ_TOOL;
  /** 目标绝对路径（正斜杠、去重、保序）。 */
  absolute: string[];
  /** 相对所选根的路径（展示用，与 `absolute` 同序）。 */
  rel: string[];
  /** 涉及的根名（去重）。 */
  rootNames: string[];
  /** 删除语义的变更数（Delete File + 改名）。 */
  deletions: number;
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
 * 解析一次调用涉及的路径目标；解析不出来返回 null。
 *
 * `file_patch`：按所选写根解析每个 op（含 `Move to` 目标）。
 * `file_read`：按所选根解析 `path`（读只要求根存在，不要求可写）。
 */
export function targetsOfCall(
  call: { name: string; argsJson: string },
  roots: FileRoot[],
): CallPathTargets | null {
  if (!isFileEditTool(call.name)) return null;
  const args = parseToolArgs(call.argsJson);
  const rootName = typeof args.root === "string" ? args.root : undefined;

  if (call.name === FILE_READ_TOOL) {
    const rawPath = typeof args.path === "string" ? args.path : "";
    if (!rawPath.trim()) return null;
    const root = pickAnyRoot(roots, rootName);
    if (!root) return null;
    const abs = resolveInsideRoot(root.path, rawPath);
    if (!abs) return null;
    return {
      tool: FILE_READ_TOOL,
      absolute: [abs],
      rel: [rawPath.trim().replace(/\\/g, "/")],
      rootNames: [root.name],
      deletions: 0,
    };
  }

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
 * @param mode `write` 只允许写根（file_patch）；`any` 任意根（file_read）
 */
export function dirPrefixesOfTargets(
  absolute: string[],
  roots: FileRoot[],
  mode: "write" | "any" = "write",
): string[] {
  const candidates = roots.filter((r) => (mode === "any" ? true : r.mode === "write"));
  const out: string[] = [];
  const seen = new Set<string>();
  for (const target of absolute) {
    // 最长前缀优先：更具体的根决定这条前缀是否被允许
    const root = candidates
      .filter((r) => isInsideRoot(r.path, target))
      .sort((a, b) => b.path.length - a.path.length)[0];
    if (!root) continue;
    const cut = target.lastIndexOf("/");
    if (cut <= 0) continue;
    const dir = `${target.slice(0, cut)}/`;
    const rootPrefix = `${root.path.replace(/\/+$/, "")}/`;
    // 目录必须落在根内（或就是根本身）：不能把根外的目录写成规则
    if (dir.toLowerCase() !== rootPrefix.toLowerCase() && !isInsideRoot(root.path, dir.replace(/\/$/, ""))) {
      continue;
    }
    const key = dir.toLowerCase();
    if (seen.has(key)) continue;
    seen.add(key);
    out.push(dir);
  }
  return out;
}

/** 由一次调用推导前缀规则；不可推导返回 null（不提供「记住」）。 */
export function prefixRulesOfCall(
  call: { name: string; argsJson: string },
  roots: FileRoot[],
): string[] | null {
  const targets = targetsOfCall(call, roots);
  if (!targets) return null;
  const mode = targets.tool === FILE_PATCH_TOOL ? "write" : "any";
  const prefixes = dirPrefixesOfTargets(targets.absolute, roots, mode);
  return prefixes.length ? prefixes : null;
}
