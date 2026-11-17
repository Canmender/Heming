/**
 * 评测用的「本机命令」桥：直接跑桌面端真实的 `shell-run.js`。
 *
 * 为什么不写一个假的：
 * 命令工具的价值一半在工具层（参数校验、错误码、截断），另一半在**主进程**——
 * 工作目录必须落在可写根内、超时要真杀进程树、输出要限长。假实现只能验证前者，
 * 后者（也就是用户真正在意的「它会不会乱跑、会不会停不下来」）会全部漏掉。
 * 这里 `createRequire` 载入桌面模块，等价于在 Electron 主进程里调同一份代码；
 * 用例里的命令必须是无副作用的（`node -e "console.log(...)"` 一类），
 * 因为评测在真机上跑，不能真的去装包、起服务。
 */

import { createRequire } from "node:module";
import type { FileRoot } from "../../packages/web/src/lib/fileEdit/paths.js";
import type {
  ShellBridge,
  ShellCancelResponse,
  ShellFailure,
  ShellJobFailureCode,
  ShellJobKillResponse,
  ShellJobOutputResponse,
  ShellJobStartResponse,
  ShellJobSummary,
  ShellRunRequest,
  ShellRunResponse,
} from "../../packages/web/src/lib/shell/bridge.js";

interface DesktopShell {
  runCommand: (
    params: { runId?: string; roots: FileRoot[]; cwd?: string; command: string; timeoutMs?: number },
    spawnImpl?: unknown,
  ) => Promise<
    | { ok: true; exitCode: number; stdout: string; stderr: string; truncated: boolean; durationMs: number; cwd: string }
    | { ok: false; code: string; error: string }
  >;
  cancelRun: (runId: string) => { ok: boolean; error?: string };
  /** d.180：后台作业（长命令不阻塞回合）。评测同样跑桌面真实实现。 */
  startBackground: (params: {
    runId?: string;
    roots: FileRoot[];
    cwd?: string;
    command: string;
  }) => Promise<{ ok: true; jobId: string; pid?: number; cwd: string } | { ok: false; code: string; error: string }>;
  readJobOutput: (
    jobId: string,
    waitMs?: number,
  ) => Promise<
    | {
        ok: true;
        jobId: string;
        running: boolean;
        exitCode: number | null;
        stdout: string;
        stderr: string;
        truncated: boolean;
        droppedBytes: number;
      }
    | { ok: false; code: string; error: string }
  >;
  killJob: (jobId: string) => { ok: true; jobId: string; killed: boolean; alreadyFinished: boolean } | { ok: false; code: string; error: string };
  listJobs: () => Array<{
    id: string;
    command: string;
    cwd: string;
    running: boolean;
    exitCode: number | null;
    startedAt: number;
    finishedAt: number | null;
    bytes: number;
    dropped: number;
  }>;
}

const requireDesktop = createRequire(import.meta.url);
const desktopShell = requireDesktop("../../packages/desktop/shell-run.js") as DesktopShell;

export interface EvalShellBridgeOptions {
  roots: () => FileRoot[];
  /** 缺省由桌面模块自己生成（`local-<ts>-<seq>`）；测试要断言取消时传固定值。 */
  runId?: () => string;
}

let seq = 0;

/** 把桌面模块的返回折成渲染层桥的形状。 */
function toResponse(
  result: Awaited<ReturnType<DesktopShell["runCommand"]>>,
): ShellRunResponse {
  if (result.ok) {
    return {
      ok: true,
      exitCode: result.exitCode,
      stdout: result.stdout,
      stderr: result.stderr,
      truncated: result.truncated,
      durationMs: result.durationMs,
      cwd: result.cwd,
    };
  }
  return { ok: false, code: result.code as never, error: result.error };
}

/** 桌面端的作业错误码只有几种，评测里归一成 web 侧同一套稳定码。 */
function jobCode(code: string): ShellJobFailureCode {
  switch (code) {
    case "unknown-job":
    case "untrusted-sender":
    case "io":
    case "no-roots":
    case "outside-roots":
    case "spawn-failed":
    case "invalid-command":
      return code;
    case "path-escape":
    case "invalid-path":
      return "outside-roots";
    default:
      return "io";
  }
}

export function createEvalShellBridge(options: EvalShellBridgeOptions): ShellBridge {
  return {
    async run(request: ShellRunRequest) {
      const runId = request.runId || options.runId?.() || `eval-${Date.now()}-${seq++}`;
      const result = await desktopShell.runCommand({
        runId,
        roots: request.roots,
        command: request.command,
        ...(request.cwd ? { cwd: request.cwd } : {}),
        ...(request.timeoutMs ? { timeoutMs: request.timeoutMs } : {}),
      });
      return toResponse(result);
    },
    async cancel(runId: string): Promise<ShellCancelResponse> {
      const result = desktopShell.cancelRun(runId);
      return result.ok ? { ok: true } : { ok: false, code: "unknown-run", error: result.error };
    },
    // d.180：后台作业四件（起 / 读增量 / 列 / 停）。评测也走桌面真实实现，
    // 否则「起得来、轮询得到、杀得掉」这三件事只有单测证明。
    async start(request): Promise<ShellJobStartResponse | ShellFailure> {
      const result = await desktopShell.startBackground({
        runId: options.runId?.() || `eval-job-${Date.now()}-${seq++}`,
        roots: request.roots,
        command: request.command,
        ...(request.cwd ? { cwd: request.cwd } : {}),
      });
      if (!result.ok) {
        return { ok: false, code: jobCode(result.code), error: result.error };
      }
      return {
        ok: true,
        jobId: result.jobId,
        ...(typeof result.pid === "number" ? { pid: result.pid } : {}),
        cwd: result.cwd,
      };
    },
    async jobOutput(request): Promise<ShellJobOutputResponse | ShellFailure> {
      const result = await desktopShell.readJobOutput(request.jobId, request.waitMs);
      if (!result.ok) {
        return { ok: false, code: jobCode(result.code), error: result.error };
      }
      return {
        ok: true,
        jobId: result.jobId,
        running: result.running,
        exitCode: result.exitCode,
        stdout: result.stdout,
        stderr: result.stderr,
        truncated: result.truncated,
        droppedBytes: result.droppedBytes,
      };
    },
    async jobs(): Promise<{ ok: true; jobs: ShellJobSummary[] } | ShellFailure> {
      // 与 web 侧 `ShellBridge.jobs` 的契约一致：成功包一层 `{ ok: true, jobs }`，
      // 而不是裸数组（`command_list` 按 `ok` 判断通道是否可用）。
      return {
        ok: true,
        jobs: desktopShell.listJobs().map((job) => ({
          id: job.id,
          command: job.command,
          cwd: job.cwd,
          running: job.running,
          exitCode: job.exitCode,
          startedAt: job.startedAt,
          finishedAt: job.finishedAt,
          bytes: job.bytes,
          dropped: job.dropped,
        })),
      };
    },
    async jobKill(request): Promise<ShellJobKillResponse | ShellFailure> {
      const result = desktopShell.killJob(request.jobId);
      if (!result.ok) {
        return { ok: false, code: jobCode(result.code), error: result.error };
      }
      return { ok: true, jobId: result.jobId, killed: result.killed, alreadyFinished: result.alreadyFinished };
    },
  };
}
