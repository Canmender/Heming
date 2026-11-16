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

/** 真实桌面实现包装成 `ShellBridge`（供 `buildShellToolBridge` 注入）。 */
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
  };
}
