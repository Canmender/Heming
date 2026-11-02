/**
 * 桌面文件桥（`window.__heming_files`）的探测与类型。
 *
 * 为什么单独一个模块：`file_patch` / `file_read` 的**可见性**由「桥是否存在」决定
 * （见 `tools.ts` 的 `buildFileToolBridgeIfAvailable`），设置区要据此显示
 * 「仅桌面端可用」，确认卡预览也要据此决定能不能读盘。
 * 三处都要判断同一件事，散着写必然漂移。
 *
 * 浏览器端没有这个桥（`window.__heming_files` 为 undefined），
 * 所有调用方都必须按可选处理——**不要**为了「能用」而造一个内存假桥：
 * 那会让用户在浏览器里以为文件真被改了。
 */

import type { FileRoot } from "./paths.js";

/** 读盘结果（与主进程 `file-fs.js` 的返回形状一致）。 */
export type FileReadResponse =
  | { ok: true; content: string; bytes: number }
  | {
      ok: false;
      code?: "invalid-path" | "outside-roots" | "symlink" | "not-found" | "not-file" | "too-large" | "binary" | "io" | "no-roots";
      error: string;
    };

/** 一条写盘/删除指令。 */
export interface FileWriteOp {
  kind: "write" | "delete";
  /** 目标绝对路径（正斜杠或反斜杠都可以，主进程会 `path.resolve`）。 */
  path: string;
  /** `kind=write` 时的整份新内容。 */
  content?: string;
}

/** 批量写入结果。 */
export interface FileWriteResponse {
  ok: boolean;
  /** 逐文件结果（部分失败时用来看哪些成功）。 */
  results?: { path: string; ok: boolean; error?: string }[];
  written?: number;
  deleted?: number;
  error?: string;
}

/** preload 暴露的桥（浏览器端为 undefined）。 */
export interface FileFsBridge {
  read(payload: { roots: FileRoot[]; path: string }): Promise<FileReadResponse>;
  write(payload: { roots: FileRoot[]; ops: FileWriteOp[] }): Promise<FileWriteResponse>;
  /** 系统目录选择器；取消返回 null。 */
  pickRoot(): Promise<string | null>;
}

/** 取桥：桌面端有、浏览器端没有。 */
export function getFileBridge(): FileFsBridge | null {
  if (typeof window === "undefined") return null;
  const bridge = (window as unknown as { __heming_files?: FileFsBridge }).__heming_files;
  if (!bridge || typeof bridge.read !== "function" || typeof bridge.write !== "function") return null;
  return bridge;
}

/** 是否具备文件编辑能力（工具可见性的唯一判据之一）。 */
export function hasFileBridge(): boolean {
  return getFileBridge() !== null;
}
