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

/**
 * 后台作业的一条摘要（d.180）：`command_list` 的每一行都由它拼出来。
 *
 * `bytes` 是当前捕获量、`dropped` 是因 512KB 上限丢掉的字节数——两个数字都要给模型看，
 * 否则它会以为「输出只有这么点」。
 */
export interface ShellJobSummary {
  id: string;
  command: string;
  cwd: string;
  running: boolean;
  exitCode: number | null;
  startedAt: number;
  finishedAt: number | null;
  bytes: number;
  dropped: number;
}

/** 后台作业通道的稳定失败码（与桌面的 `shell:job-*` 通道一一对应）。 */
export type ShellJobFailureCode =
  | "unknown-job"
  | "untrusted-sender"
  | "io"
  | "no-roots"
  | "outside-roots"
  | "spawn-failed"
  | "invalid-command";

export interface ShellJobStartResponse {
  ok: true;
  jobId: string;
  pid?: number;
  cwd: string;
}

export interface ShellJobOutputResponse {
  ok: true;
  jobId: string;
  running: boolean;
  exitCode: number | null;
  /** 自上次读取以来新增的 stdout（读一次消费一次）。 */
  stdout: string;
  /** 自上次读取以来新增的 stderr（读一次消费一次）。 */
  stderr: string;
  /** 是否因 512KB 上限丢过内容。 */
  truncated: boolean;
  /** 累计丢弃的字节数。 */
  droppedBytes: number;
}

export interface ShellJobKillResponse {
  ok: true;
  jobId: string;
  killed: boolean;
  alreadyFinished: boolean;
}

/** 后台作业通道的失败形状（与前台 `ShellRunFailure` 同一套 `ok:false` 约定）。 */
export interface ShellJobFailure {
  ok: false;
  code: ShellJobFailureCode;
  error: string;
}

/**
 * 命令桥失败并集：前台 `shell:run` 与后台作业通道共用。
 *
 * 契约里 `start` / `jobs` / `jobOutput` / `jobKill` 的返回都写成 `… | ShellFailure`，
 * 所以这里保留这个名字，而不是再发明一套失败类型。
 */
export type ShellFailure = ShellRunFailure | ShellJobFailure;

export interface ShellBridge {
  run(request: ShellRunRequest): Promise<ShellRunResponse>;
  /**
   * 取消一条在跑（或排队中）的命令。
   *
   * 老安装包没有这个方法：调用方要先 `hasShellCancel` 再决定文案，
   * 不能说「已停止」而进程还在跑。
   */
  cancel?(runId: string): Promise<ShellCancelResponse>;
  /**
   * 后台起一条命令（d.180）：立刻返回 jobId，不进入前台串行队列。
   *
   * 老安装包（d.180 之前）没有这个方法：调用方要用 `hasJobRuntime` 判断整体可用性
   * （现行桌面端没有 `start`，起作业复用 `run({background:true})`），缺了就只能回
   * 「当前桌面端版本不支持后台命令」，不能假装已经起了作业。
   */
  start?(payload: {
    roots: FileRoot[];
    command: string;
    cwd?: string;
    runId?: string;
  }): Promise<ShellJobStartResponse | ShellFailure>;
  /** 列出本主进程登记的后台作业（含最近结束的）。 */
  jobs?(): Promise<{ ok: true; jobs: ShellJobSummary[] } | ShellFailure>;
  /** 读一个作业自上次读取以来的增量输出；`waitMs` 最多等 30 秒。 */
  jobOutput?(payload: { jobId: string; waitMs?: number }): Promise<ShellJobOutputResponse | ShellFailure>;
  /** 请求停止一个作业（只认本主进程登记过的 jobId，不接受 pid）。 */
  jobKill?(payload: { jobId: string }): Promise<ShellJobKillResponse | ShellFailure>;
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

/**
 * 桌面端是否提供后台作业通道（d.180；老安装包四个方法一个都没有）。
 *
 * 四个方法必须**全部**存在才算：只判断一个的话，半升级的桥会让模型拿到
 * 「能起不能读」的工具集，比完全没有更糟（作业起来后没人能收）。
 */
export function hasJobBridge(bridge: ShellBridge | null = getShellBridge()): boolean {
  return Boolean(
    bridge &&
      typeof bridge.start === "function" &&
      typeof bridge.jobs === "function" &&
      typeof bridge.jobOutput === "function" &&
      typeof bridge.jobKill === "function",
  );
}

/** 三个作业通道（列表/读增量/停止）是否齐全；缺一个就是半升级或老桌面端。 */
export function hasJobChannels(bridge: ShellBridge | null = getShellBridge()): boolean {
  return Boolean(
    bridge &&
      typeof bridge.jobs === "function" &&
      typeof bridge.jobOutput === "function" &&
      typeof bridge.jobKill === "function",
  );
}

/**
 * 后台作业**实际可用**的判定——工具可见性与 `background:true` 分支都按它来。
 *
 * 契约 §4 把「新桥」写成 `start`/`jobs`/`jobOutput`/`jobKill` 四个方法都在，但桌面端
 * （契约 §1/§2）把「起后台」实现为 `shell:run` 的 `background:true` 分支，preload 上
 * 并没有单独的 `start` 转发。按字面要求 `start` 的话，**已经支持后台的新桌面端会被
 * 误判成老桥**，四个工具全部不注入、`background:true` 永远回 bridge-missing——功能
 * 静默消失。所以这里的口径是：三个作业通道必须齐，启动方式 `start` 或 `run` 任一即可。
 */
export function hasJobRuntime(bridge: ShellBridge | null = getShellBridge()): boolean {
  if (!hasJobChannels(bridge)) return false;
  return typeof bridge!.start === "function" || typeof bridge!.run === "function";
}

/** `start` 的入参形状（与 `run({background:true})` 共用）。 */
export interface ShellJobStartRequest {
  roots: FileRoot[];
  command: string;
  cwd?: string;
  runId?: string;
}

/**
 * 起一个后台作业：桌面端有显式 `start` 就用它；没有则复用 `run` 的 background 分支。
 *
 * 后者是**现行桌面端**的真实形状（`shell:run` payload 加 `background:true`，返回的
 * 就是 `ShellJobStartResponse`），也是契约 §1 写死的那条路径；`start` 留给将来
 * 桌面端补一个更直白的转发时用，不需要再改 web 工具层。
 */
export async function startShellJob(
  bridge: ShellBridge,
  payload: ShellJobStartRequest,
): Promise<ShellJobStartResponse | ShellFailure> {
  if (typeof bridge.start === "function") return bridge.start(payload);
  if (typeof bridge.run !== "function") {
    return { ok: false, code: "spawn-failed", error: "桌面端没有后台启动通道" };
  }
  // 桥类型里 `run` 的返回只写了前台结果；background:true 时主进程回的是启动响应，
  // 这里按运行时真实形状收窄（契约 §1「立刻返回 {ok:true, jobId, pid, cwd}」）。
  const runBackground = bridge.run as unknown as (
    request: ShellRunRequest & { background: true },
  ) => Promise<ShellJobStartResponse | ShellFailure>;
  return runBackground({
    runId: payload.runId ?? `bg-${Date.now().toString(36)}`,
    roots: payload.roots,
    command: payload.command,
    ...(payload.cwd !== undefined ? { cwd: payload.cwd } : {}),
    background: true,
  });
}
