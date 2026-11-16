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

/** 搜索类失败的公共形状（glob / grep 共用）。 */
export type FileSearchFailure = {
  ok: false;
  code?: "invalid-pattern" | "outside-roots" | "no-roots" | "io" | "untrusted-sender";
  error: string;
};

/**
 * `file:glob` 的结果。
 *
 * 返回**绝对路径**（主进程只做它最有把握的事：遍历与过滤），相对化交给 web 侧
 * （`relFromRoot`）——「根内相对路径」的口径仍然只有一处实现。
 */
export type FileGlobResponse =
  | { ok: true; root: string; paths: string[]; truncated: boolean }
  | FileSearchFailure;

/** `file:grep` 的一条命中（`path` 为绝对路径，`line` 从 1 开始）。 */
export interface FileGrepMatch {
  path: string;
  line: number;
  text: string;
}

/** `file:grep` 的结果。 */
export type FileGrepResponse =
  | { ok: true; root: string; matches: FileGrepMatch[]; truncated: boolean }
  | FileSearchFailure;

/** preload 暴露的桥（浏览器端为 undefined）。 */
export interface FileFsBridge {
  read(payload: { roots: FileRoot[]; path: string }): Promise<FileReadResponse>;
  /**
   * 批量写入/删除。
   *
   * `createParents`（可选）：允许主进程补建缺失的父目录（`file_write` 新建深路径时用）。
   * 默认 false——老调用方与老语义（父目录必须已存在）完全不变。
   */
  write(payload: { roots: FileRoot[]; ops: FileWriteOp[]; createParents?: boolean }): Promise<FileWriteResponse>;
  /** 系统目录选择器；取消返回 null。 */
  pickRoot(): Promise<string | null>;
  /**
   * 按通配符找文件（桌面 0.3+ 才有；老安装包缺这两个方法）。
   *
   * 用可选方法而不是必选：老版本和鸣的 `__heming_files` 只有 read/write/pickRoot，
   * 必选会让整个桥「不可用」，连读写也一起消失——能力降级要按工具粒度发生。
   */
  glob?(payload: { roots: FileRoot[]; pattern: string; dir?: string }): Promise<FileGlobResponse>;
  /** 按正则搜文件内容（桌面 0.3+ 才有）。 */
  grep?(payload: { roots: FileRoot[]; pattern: string; dir?: string; include?: string }): Promise<FileGrepResponse>;
  /**
   * 「默认工作区」的绝对路径（桌面 0.3+ 才有）：主进程在 `文档\和鸣` 建好的目录。
   *
   * 为什么是**同步字符串**而不是方法：`currentFileRoots()` 是同步口径（工具可见性、HITL 闸门、
   * 确认卡都在同步路径上调用），拿 Promise 只能二选一——要么首次调用时还没有根（工具不注入），
   * 要么把整条闸门改成异步。所以 preload 用 `sendSync` 取一次，这里只读字段。
   *
   * 未分组会话（没有工作区、也没手动配根）靠它兜底，否则开箱即用的智能体仍然不能写文件。
   */
  defaultRootPath?: string | null;
  /** 同上，异步版本（设置区展示用；正常读取请用 `defaultRootPath`）。 */
  defaultRoot?(): Promise<{ ok: boolean; path?: string; error?: string }>;
  /**
   * 读一张图片（桌面 0.3+ 才有）：回 base64 与**按魔数判断的真实 mime**。
   *
   * 与 `read` 分开是刻意的：文本读取会拒二进制，图片通道只认四种格式、上限也不同
   * （5MB vs 2MB）。用可选方法 → 老安装包按工具隐藏 `file_image`，而不是让整条文件
   * 能力一起失效。
   */
  image?(payload: { roots: FileRoot[]; path: string }): Promise<FileImageResponse>;
  /**
   * 撤销上一次写入（桌面 0.3+ 才有）：主进程把「替换前留的备份」写回该文件。
   *
   * `file_write` / `file_edit` / `file_patch` 覆盖或删除文件之前，主进程都会留一份原始
   * 字节（`userData/backups`）。这份备份**只能用一次**：撤销成功后再撤销会回
   * `no-backup`——不保留是为了不出现「撤销↔重做」来回横跳，用户看不出当前是哪个版本。
   */
  undo?(payload: { roots: FileRoot[]; path: string }): Promise<FileUndoResponse>;
  /**
   * 列出「可回滚的最近改动」（桌面 0.3+ 才有）：设置区列表用。
   *
   * 返回的是**绝对路径 + 时间 + 字节数**，按时间倒序、每个文件只给最新一份、
   * 只含可写根内的文件（列出来的每一行都要真的能点「回滚」）。
   */
  backups?(payload: { roots: FileRoot[] }): Promise<FileBackupsResponse>;
}

/** 一条可回滚的改动。 */
export interface FileBackupItem {
  /** 被改动文件的绝对路径。 */
  path: string;
  /** 这份备份对应内容的写入时刻（ISO 字符串）。 */
  at: string;
  /** 备份的原始字节数。 */
  bytes: number;
}

/** `file:backups` 的响应。 */
export type FileBackupsResponse =
  | { ok: true; items: FileBackupItem[] }
  | { ok: false; code?: "no-roots" | "untrusted-sender" | "io"; error: string };

/**
 * 桥是否支持列出最近改动（`file_undo` 的界面入口）。
 *
 * 老安装包没有 `backups`：整块「最近改动」不渲染，而不是列出一堆点不动的行。
 */
export function hasBackupsBridge(bridge: FileFsBridge | null): boolean {
  return !!bridge && typeof bridge.backups === "function";
}

/** `file:undo` 的失败码（与主进程 `undoWrite` 对齐）。 */
export type FileUndoFailureCode =
  | "invalid-path"
  | "outside-roots"
  | "symlink"
  | "no-backup"
  | "no-backup-dir"
  | "no-write-root"
  | "no-roots"
  | "io";

/** `file:undo` 的结果：成功要回「恢复到哪一刻」与字节数。 */
export type FileUndoResponse =
  | { ok: true; path: string; restoredFrom: string; bytes: number }
  | { ok: false; code?: FileUndoFailureCode; error: string };

/**
 * 桥是否支持撤销（`file_undo`）。
 *
 * 老安装包的 `__heming_files` 没有 `undo`：按工具隐藏，而不是让模型调用后拿到
 * `undefined is not a function`（与 `hasSearchBridge` / `hasImageBridge` 同一口径）。
 */
export function hasUndoBridge(bridge: FileFsBridge | null): boolean {
  return !!bridge && typeof bridge.undo === "function";
}

/**
 * 读图失败码（与主进程 `readImage` 对齐）。
 *
 * `unsupported-image` 是图片通道独有的：文本读取用 `binary` 表示「这不是文本」，
 * 图片读取要能说清「这不是我能看的图片」——处置方式不同（前者让模型改用 file_read，
 * 后者让模型别硬读、去看目录里别的文件）。
 */
export type FileImageFailureCode =
  | "invalid-path"
  | "outside-roots"
  | "symlink"
  | "not-found"
  | "not-file"
  | "too-large"
  | "unsupported-image"
  | "no-roots"
  | "io";

/** `file:image` 的响应：成功带 base64 与真实 mime。 */
export type FileImageResponse =
  | { ok: true; mime: string; bytes: number; base64: string }
  | { ok: false; code?: FileImageFailureCode; error: string };

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

/**
 * 桥是否支持搜索类工具（glob / grep）。
 *
 * 老安装包没有这两个方法：按工具隐藏，而不是让模型调用后拿到 `undefined is not a function`。
 */
export function hasSearchBridge(bridge: FileFsBridge | null): boolean {
  return !!bridge && typeof bridge.glob === "function" && typeof bridge.grep === "function";
}

/**
 * 桥是否支持读图（`file_image`）。
 *
 * 老安装包没有 `image` 方法：按工具隐藏，而不是让模型调用后拿到
 * `undefined is not a function`——同一套降级口径（见 `hasSearchBridge`）。
 */
export function hasImageBridge(bridge: FileFsBridge | null): boolean {
  return !!bridge && typeof bridge.image === "function";
}

/**
 * 默认工作区路径（老安装包没有这个字段 → `null`）。
 *
 * 只做形状校验：非字符串、空串、含 NUL 一律当没有。真正的合法性（绝对路径、非盘符根、
 * 长度上限）由 `roots.ts` 的 `isAcceptableRootPath` 再判一次——这里不复制那份判断。
 */
export function getDefaultRootPath(): string | null {
  if (typeof window === "undefined") return null;
  const bridge = (window as unknown as { __heming_files?: FileFsBridge }).__heming_files;
  const raw = bridge?.defaultRootPath;
  if (typeof raw !== "string") return null;
  const trimmed = raw.trim();
  if (!trimmed || trimmed.includes("\u0000")) return null;
  return trimmed;
}
