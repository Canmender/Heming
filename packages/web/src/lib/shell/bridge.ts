import type { FileRoot } from "../fileEdit/paths.js";

/**
 * 本机命令执行的渲染层桥（d.164）。
 *
 * 与 `fileEdit/bridge.ts` 分开一个命名空间：文件桥的语义是「读写文件」，
 * 命令桥的语义是「起一个子进程」——两者的信任级别不同，混在一个对象里
 * 会让「有文件桥」被误读成「能跑命令」。
 */

export type ShellFailureCode =
  | "untrusted-sender"
  | "no-roots"
  | "no-write-root"
  | "outside-roots"
  | "invalid-command"
  | "invalid-timeout"
  | "spawn-failed"
  | "timeout"
  | "aborted"
  | "too-large"
  | "io";

export interface ShellRunRequest {
  /**
   * 本次执行的标识（d.165）。
   *
   * 主进程只认这个 id 来取消：`ipcRenderer.invoke` 本身没有 abort，
   * 用户点「停止」时渲染层只能另发一条 `shell:cancel` 来杀进程。
   */
  runId: string;
  roots: FileRoot[];
  /** 相对根的工作目录；缺省用第一条写根的根目录。 */
  cwd?: string;
  command: string;
  timeoutMs?: number;
}

export interface ShellRunSuccess {
  ok: true;
  /** 进程退出码；被信号杀掉时为 null。 */
  exitCode: number | null;
  stdout: string;
  stderr: string;
  /** 输出是否被主进程截断（截断时会明说，不假装命令只输出了这么多）。 */
  truncated: boolean;
  durationMs: number;
  /** 真正执行命令的工作目录（绝对 posix 路径）。 */
  cwd: string;
}

export interface ShellRunFailure {
  ok: false;
  code: ShellFailureCode;
  error: string;
}

export type ShellRunResponse = ShellRunSuccess | ShellRunFailure;

export interface ShellCancelResponse {
  /** 进程是否真的被取消（false 表示没找到这个 id：已经结束、或对方版本没有取消能力）。 */
  ok: boolean;
  code?: "unknown-run" | "untrusted-sender" | "io";
  error?: string;
}

export interface ShellBridge {
  run(request: ShellRunRequest): Promise<ShellRunResponse>;
  /**
   * 取消一条在跑（或排队中）的命令。
   *
   * 老安装包没有这个方法：调用方要先 `hasShellCancel` 再决定文案，
   * 不能说「已停止」而进程还在跑。
   */
  cancel?(runId: string): Promise<ShellCancelResponse>;
}

declare global {
  interface Window {
    __heming_shell?: ShellBridge;
  }
}

/** 读桌面端注入的命令桥；缺方法或形状不对一律返回 null（调用方据此不注入工具）。 */
export function getShellBridge(): ShellBridge | null {
  if (typeof window === "undefined") return null;
  const candidate = window.__heming_shell;
  if (!candidate || typeof candidate !== "object") return null;
  if (typeof candidate.run !== "function") return null;
  return candidate;
}

export function hasShellBridge(): boolean {
  return getShellBridge() !== null;
}

/** 桌面端是否提供「取消在跑命令」的能力（老安装包没有）。 */
export function hasShellCancel(bridge: ShellBridge | null = getShellBridge()): boolean {
  return Boolean(bridge && typeof bridge.cancel === "function");
}
