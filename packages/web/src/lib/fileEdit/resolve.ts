/**
 * 补丁目标路径的解析（apply 干跑、HITL 规则、确认卡预览三处共用）。
 *
 * 为什么必须共用：`file_patch` 的「目标到底是哪个绝对路径」这件事，
 * 干跑要用它读盘、HITL 要用它匹配规则、确认卡要用它算 diff 与授权前缀。
 * 三处各写一遍的话，只要有一处口径不同（例如对 `..` 一个折叠一个拒绝），
 * 就会出现「HITL 认为在根内的路径，干跑认为是越界」这种最难排查的分歧。
 *
 * 口径：
 * - 路径必须是**所选根内的相对路径**（绝对路径一律拒绝，文案让模型改成相对写法）；
 * - 相对路径里出现 `..` 直接拒绝（不折叠后放过，理由见 `paths.ts` 的 `resolveInsideRoot`）；
 * - 目标必须落在 `mode=write` 的根里才能写（只读根明确拒绝）。
 */

import {
  isAbsolutePath,
  relFromRoot,
  resolveInsideRoot,
  type FileRoot,
} from "./paths.js";
import type { PatchError } from "./types.js";

/** 可写根清单（给文案用：告诉模型「哪里可以写」，但不暗示可以绕过）。 */
export function writeRootNames(roots: FileRoot[]): string {
  const list = roots.filter((r) => r.mode === "write").map((r) => `${r.name}（${r.path}）`);
  return list.length ? list.join("、") : "（尚未配置可写根）";
}

/** 解析出的目标。 */
export interface ResolvedTarget {
  abs: string;
  rel: string;
  root: FileRoot;
}

/** 选中根：显式 `root` 参数 > 第一个可写根。 */
export function pickRoot(roots: FileRoot[], rootName?: string): FileRoot | PatchError {
  if (rootName && rootName.trim()) {
    const wanted = rootName.trim().toLowerCase();
    const hit = roots.find((r) => r.name.trim().toLowerCase() === wanted);
    if (!hit) {
      return {
        code: "root-unknown",
        message: `没有名为「${rootName}」的根。当前可写根：${writeRootNames(roots)}。`,
      };
    }
    return hit;
  }
  const first = roots.find((r) => r.mode === "write");
  if (!first) {
    return {
      code: "root-unknown",
      message: "尚未配置可写根。请让用户在设置区「文件编辑」里添加一个可写根目录后再试。",
    };
  }
  return first;
}

/**
 * 把一个补丁内的路径解析成绝对路径。
 *
 * 判错顺序：路径本身合法 → 是否越界 → 根是否只读。
 * 这样模型看到的原因总是最具体的那一条，而不是笼统的「不能写」。
 */
export function resolvePatchPath(
  roots: FileRoot[],
  root: FileRoot,
  rawPath: string,
): ResolvedTarget | PatchError {
  const raw = String(rawPath ?? "").trim();
  if (!raw) return { code: "path-invalid", message: "路径不能为空。", path: rawPath };
  if (raw.includes("\u0000")) {
    return { code: "path-invalid", message: `路径里含非法字符（NUL）：${raw}`, path: rawPath };
  }
  if (raw.length > 300) {
    return { code: "path-invalid", message: `路径过长（超过 300 字符）：${raw}`, path: rawPath };
  }
  if (isAbsolutePath(raw)) {
    return {
      code: "path-invalid",
      message:
        `补丁里的路径必须是所选根「${root.name}」内的相对路径，不能写绝对路径：${raw}。` +
        `请把路径改成相对 ${root.path} 的写法。`,
      path: raw,
    };
  }
  if (raw.replace(/\\/g, "/").split("/").some((seg) => seg === "..")) {
    return {
      code: "path-escape",
      message:
        `路径越界：${raw} 含 \`..\`，会跑出根「${root.name}」（${root.path}）。` +
        `可写根：${writeRootNames(roots)}。请改用根内的相对路径。`,
      path: raw,
    };
  }
  const abs = resolveInsideRoot(root.path, raw);
  if (!abs) {
    return {
      code: "path-escape",
      message:
        `路径越界：${raw} 解析后不在根「${root.name}」（${root.path}）内。` +
        `可写根：${writeRootNames(roots)}。请改用根内的相对路径。`,
      path: raw,
    };
  }
  if (root.mode !== "write") {
    return {
      code: "root-readonly",
      message:
        `根「${root.name}」（${root.path}）是只读根，不能写入。` +
        `可写根：${writeRootNames(roots)}。需要写入时请让用户在设置区调整根的读写模式。`,
      path: raw,
    };
  }
  return { abs, rel: relFromRoot(root.path, abs) ?? raw.replace(/\\/g, "/"), root };
}

/**
 * 类型收窄：解析结果是错误还是目标。
 *
 * 入参用 `unknown` 而不是联合类型：调用方既可能拿到 `FileRoot | PatchError`
 * （挑根）也可能拿到 `ResolvedTarget | PatchError`（解析路径），
 * 联合签名会把简单事写复杂。
 */
export function isPatchError(value: unknown): value is PatchError {
  if (!value || typeof value !== "object") return false;
  const v = value as Partial<PatchError>;
  return typeof v.code === "string" && typeof v.message === "string";
}
