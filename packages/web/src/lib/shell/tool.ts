import { failureResult } from "../toolError.js";
import type { ToolFailureResult } from "../toolError.js";
import type { ToolBridge } from "../agentStream.js";
import type { FileRoot } from "../fileEdit/paths.js";
import { resolveInsideRoot, relFromRoot } from "../fileEdit/paths.js";
import { pickRoot, isPatchError } from "../fileEdit/resolve.js";
import type { ShellBridge, ShellRunResponse } from "./bridge.js";
import {
  SHELL_DEFAULT_TIMEOUT_MS,
  SHELL_MAX_COMMAND_CHARS,
  SHELL_MAX_OUTPUT_CHARS,
  SHELL_MAX_TIMEOUT_MS,
} from "./limits.js";

/**
 * 内置「本机命令」工具（d.164）。
 *
 * 为什么必须有它：前十一版补齐了「自己会想、会读写文件、会派帮手」，但**不会跑命令**——
 * 装依赖、跑测试、看 git 状态、查端口，这些是智能体应用最基本的动作，缺了它就只能
 * 让用户复制命令去终端里敲，等于把「智能体」降级成「帮你写命令的聊天框」。
 *
 * 安全口径（与文件工具同一套思路，但更严）：
 * - 风险等级是 `danger`：`hitl/policy.ts` 对 danger 不提供记忆放行，每条命令都要人点一次；
 * - 工作目录必须在**可写根**内，主进程再夹一次（双层防线）；
 * - 有超时、有输出上限、被中止时杀进程树——不会留下孤儿进程在后台跑。
 */

export const SHELL_TOOL = "run_command";

const TOOLS = [
  {
    name: SHELL_TOOL,
    description:
      "在本机执行一条 shell 命令（Windows 用 cmd.exe，其它平台用 /bin/sh），执行前会请用户确认。"
      + "适合：装依赖、跑测试、git 状态/差异、查进程与端口、构建。"
      + "不适合：交互式命令（vim、top）、需要输入密码的命令、长时间挂起的服务"
      + "（要起服务请用户自己开终端）。命令的 stdout/stderr 会返回给你；"
      + "非零退出码也算执行完成，读错误输出再决定下一步。",
    parameters: {
      type: "object",
      properties: {
        command: {
          type: "string",
          description: `要执行的命令（最多 ${SHELL_MAX_COMMAND_CHARS} 字符）。一条命令只做一件事。`,
        },
        cwd: {
          type: "string",
          description: "工作目录（相对可写根）。省略则在树根执行；跨目录操作请先 cd 到目标目录。",
        },
        timeout_ms: {
          type: "integer",
          description: `超时毫秒，默认 ${SHELL_DEFAULT_TIMEOUT_MS}，上限 ${SHELL_MAX_TIMEOUT_MS}。`,
        },
      },
      required: ["command"],
      additionalProperties: false,
    },
  },
];

export interface ShellToolDeps {
  bridge: ShellBridge;
  roots: () => FileRoot[];
  /** 测试注入：生成一次执行的 id（真实环境用时间戳 + 随机串）。 */
  newRunId?: () => string;
}

let runSeq = 0;

/**
 * 生成一次执行的 id。
 *
 * 用「序号 + 时间戳 + 随机串」：同一毫秒内连发也不会撞，
 * 而纯随机串在日志里不容易和别的请求对上号。
 */
function defaultRunId(): string {
  runSeq += 1;
  return `cmd-${Date.now().toString(36)}-${runSeq}-${Math.random().toString(36).slice(2, 8)}`;
}

/** 参数解析结果。 */
type ParsedArgs =
  | { ok: true; command: string; cwd?: string; timeoutMs: number }
  | { ok: false; failure: ToolFailureResult };

function parseArgs(raw: unknown): ParsedArgs {
  const args = (raw ?? {}) as Record<string, unknown>;
  const command = typeof args.command === "string" ? args.command.trim() : "";
  if (!command) {
    return {
      ok: false,
      failure: failureResult("命令为空（invalid-args）", "`command` 不能为空。", {
        error_code: "invalid-args",
        retry_with: 'command: "git status --short"',
      }),
    };
  }
  if (command.includes("\u0000")) {
    return {
      ok: false,
      failure: failureResult("命令含非法字符（invalid-command）", "命令里不能有 NUL 字符。", {
        error_code: "invalid-command",
      }),
    };
  }
  if (command.length > SHELL_MAX_COMMAND_CHARS) {
    return {
      ok: false,
      failure: failureResult(
        "命令过长（invalid-command）",
        `命令 ${command.length} 字符，超过上限 ${SHELL_MAX_COMMAND_CHARS}。很长的脚本请先用 file_write 写成 .ps1/.sh 文件再执行。`,
        { error_code: "invalid-command", retry_with: "把长命令写成脚本文件，再执行那个文件" },
      ),
    };
  }

  const cwdRaw = typeof args.cwd === "string" ? args.cwd.trim() : "";
  const timeoutRaw = typeof args.timeout_ms === "number" ? args.timeout_ms : Number.NaN;
  const timeoutMs = Number.isFinite(timeoutRaw)
    ? Math.min(Math.max(Math.floor(timeoutRaw), 1000), SHELL_MAX_TIMEOUT_MS)
    : SHELL_DEFAULT_TIMEOUT_MS;

  return { ok: true, command, ...(cwdRaw ? { cwd: cwdRaw } : {}), timeoutMs };
}

/** 把输出截到上限，并说清「截了」。 */
function clip(text: string, budget: number): { text: string; truncated: boolean } {
  if (text.length <= budget) return { text, truncated: false };
  const head = text.slice(0, Math.floor(budget * 0.7));
  const tail = text.slice(-Math.floor(budget * 0.3));
  return {
    text: `${head}\n…（中间省略 ${text.length - head.length - tail.length} 字符）…\n${tail}`,
    truncated: true,
  };
}

function formatSuccess(
  res: Extract<ShellRunResponse, { ok: true }>,
  cwdLabel: string,
): { text: string; ok: boolean; error?: { error_code: string; hint?: string } } {
  const stdout = clip(res.stdout, SHELL_MAX_OUTPUT_CHARS);
  const stderrBudget = Math.max(1000, SHELL_MAX_OUTPUT_CHARS - stdout.text.length);
  const stderr = clip(res.stderr, stderrBudget);
  const lines: string[] = [
    `命令已执行：退出码 ${res.exitCode === null ? "（被信号终止）" : res.exitCode}（${res.durationMs}ms）`,
    `工作目录：${cwdLabel}`,
  ];
  if (stdout.text.trim()) lines.push("", "输出：", stdout.text.replace(/\s+$/, ""));
  else lines.push("", "输出：（空）");
  if (stderr.text.trim()) lines.push("", "错误输出：", stderr.text.replace(/\s+$/, ""));
  if (stdout.truncated || stderr.truncated) {
    lines.push("", "（输出过长已截断；要看完整内容请把范围缩小，例如只跑单个测试文件、或加 grep 过滤。）");
  }
  if (res.exitCode !== 0) {
    lines.push(
      "",
      "命令以非零退出码结束。先读上面的错误输出定位原因；不要原样重跑同一条命令，也不要换个写法反复试。",
    );
    return { text: lines.join("\n"), ok: false, error: { error_code: "command-failed", hint: "读 stderr 再改，别盲试" } };
  }
  return { text: lines.join("\n"), ok: true };
}

/**
 * 老安装包没有 `shell:cancel`：命令已经跑完，但用户以为按停止就停了。
 *
 * 不在这里说谎——明确写出「它其实跑完了」，否则用户会按「已停止」的印象做判断。
 */
function appendCancelCaveat(result: { text: string; ok: boolean; error?: { error_code: string; hint?: string } }) {
  return {
    ...result,
    text:
      result.text
      + "\n\n（注意：你按了停止，但当前桌面端版本不支持中途结束命令——它已经跑完了。"
      + "所以上面的输出是完整的，别把它当成「被打断的半截结果」。）",
  };
}

function failureOf(res: Extract<ShellRunResponse, { ok: false }>): ToolFailureResult {
  switch (res.code) {    case "no-roots":
    case "no-write-root":
      return failureResult("没有可执行目录（no-write-root）", "当前没有可写根，命令无法确定工作目录。请让用户在设置区添加一个可写根。", {
        error_code: "no-write-root",
      });
    case "outside-roots":
      return failureResult("工作目录越界（path-escape）", res.error || "工作目录不在可写根内。", {
        error_code: "path-escape",
      });
    case "invalid-command":
      return failureResult("命令无效（invalid-command）", res.error, { error_code: "invalid-command" });
    case "invalid-timeout":
      return failureResult("超时参数无效（invalid-timeout）", res.error, {
        error_code: "invalid-timeout",
        retry_with: `timeout_ms: ${SHELL_DEFAULT_TIMEOUT_MS}`,
      });
    case "timeout":
      return failureResult("命令超时（timeout）", res.error || "命令超过超时时间，已被终止。", {
        error_code: "timeout",
        retry_with: `timeout_ms: ${SHELL_MAX_TIMEOUT_MS}`,
        hint: "超时通常是命令在等输入或在跑长任务：把它拆小，或让用户自己跑",
      });
    case "aborted":
      return failureResult("命令已取消（aborted）", res.error || "用户中止了本轮对话。", { error_code: "aborted" });
    case "too-large":
      return failureResult("输出过大（too-large）", res.error || "命令输出超过上限，已终止。", {
        error_code: "too-large",
        hint: "加过滤（findstr / grep / --quiet）缩小输出",
      });
    case "untrusted-sender":
      return failureResult("调用来源不可信（untrusted-sender）", res.error, { error_code: "untrusted-sender" });
    default:
      return failureResult("命令执行失败（spawn-failed）", res.error || "无法启动子进程。", {
        error_code: "spawn-failed",
        hint: "确认命令在系统里存在、且用户允许在此目录执行",
      });
  }
}

/**
 * 组装工具桥；调用方负责在「没有命令桥 / 没有可写根」时不要调用本函数。
 *
 * 注意 `tools` 必须是 **OpenAI 格式**（`{type:"function",function:{…}}`），不能直接把
 * 上面的 `TOOLS` 声明塞进去：`mergeToolBridges` / `CapabilityRegistry` 都按
 * `spec.function.name` 认领工具，塞裸声明的话命令桥在「多 provider 合并」时永远认领不到
 * `run_command`，模型看到的工具清单里有它、执行时却回「未知工具」——静默失效，只有
 * 真正跑一遍才暴露（d.165 的评测用例 cmd-001 就是为抓这个而加）。
 */
export function buildShellToolBridge(deps: ShellToolDeps): ToolBridge {
  return {
    tools: TOOLS.map((spec) => ({
      type: "function" as const,
      function: {
        name: spec.name,
        description: spec.description,
        parameters: spec.parameters,
      },
    })),
    meta(name: string) {
      if (name === SHELL_TOOL) return { risk: "danger", displayName: "运行命令" };
      return undefined;
    },
    async execute(call: { name: string; arguments: string }, opts?: { signal?: AbortSignal }) {
      if (call.name !== SHELL_TOOL) {
        return failureResult("未知工具（unknown-tool）", `没有名为「${call.name}」的内置命令工具。`, {
          error_code: "unknown-tool",
        });
      }
      let raw: unknown;
      try {
        raw = call.arguments ? JSON.parse(call.arguments) : {};
      } catch (err) {
        return failureResult("参数不是合法 JSON（invalid-args）", `解析参数失败：${String(err)}`, {
          error_code: "invalid-args",
        });
      }
      const parsed = parseArgs(raw);
      if (!parsed.ok) return parsed.failure;

      const roots = deps.roots();
      const root = pickRoot(roots);
      if (isPatchError(root)) {
        return failureResult("没有可写根（no-write-root）", root.message, { error_code: "no-write-root" });
      }
      if (root.mode !== "write") {
        return failureResult("根是只读的（root-readonly）", `根「${root.name}」是只读的，不能在里面执行命令。`, {
          error_code: "root-readonly",
        });
      }

      let cwdAbs = root.path;
      let cwdLabel = `${root.name}（${"."}）`;
      if (parsed.cwd) {
        const resolved = resolveInsideRoot(root.path, parsed.cwd);
        if (!resolved) {
          return failureResult("工作目录越界（path-escape）", `「${parsed.cwd}」不是根「${root.name}」内的相对路径。`, {
            error_code: "path-escape",
            hint: "cwd 要写相对路径（如 src 或 .），不能写绝对路径、不能用 ..",
          });
        }
        cwdAbs = resolved;
        cwdLabel = `${root.name}（${relFromRoot(root.path, resolved) || "."}）`;
      }

      if (opts?.signal?.aborted) {
        return failureResult("命令已取消（aborted）", "本轮对话已中止，没有执行命令。", { error_code: "aborted" });
      }

      const runId = (deps.newRunId ?? defaultRunId)();
      const bridge = deps.bridge;
      const signal = opts?.signal;
      const canCancel = typeof bridge.cancel === "function";
      let cancelRequested = false;
      const onAbort = () => {
        cancelRequested = true;
        if (!canCancel) return;
        // 取消是「尽力而为」：这次调用本身不等结果，命令结果仍由 run() 的返回决定。
        void Promise.resolve(bridge.cancel!(runId)).catch(() => undefined);
      };
      if (signal) signal.addEventListener("abort", onAbort, { once: true });

      let res: ShellRunResponse;
      try {
        res = await bridge.run({
          runId,
          roots,
          command: parsed.command,
          timeoutMs: parsed.timeoutMs,
          // 必须总是带绝对工作目录：主进程的 `resolveWorkingDir` 不接受「没给 cwd」，
          // 它没有「自己猜一个根」的权限（猜错就是跑到用户没授权的目录里执行命令）。
          // 不传的话每条命令都会回「命令必须带一个绝对工作目录」——d.165 的 cmd-001 抓到的。
          cwd: cwdAbs,
        });
      } catch (err) {
        return failureResult("命令执行失败（spawn-failed）", `调用桌面端失败：${String(err)}`, {
          error_code: "spawn-failed",
        });
      } finally {
        signal?.removeEventListener("abort", onAbort);
      }
      if (!res.ok) {
        if (res.code === "aborted") {
          return failureResult(
            "命令已取消（aborted）",
            cancelRequested
              ? "用户中止了本轮对话，命令已结束（进程树一并杀掉了）。需要的话可以重新发一次。"
              : "命令被中止（渲染层断开或桌面端主动结束）。",
            { error_code: "aborted" },
          );
        }
        return failureOf(res);
      }
      if (cancelRequested && !canCancel) {
        // 老安装包没有取消通道：命令已经跑完，但用户以为自己停了，必须说清楚。
        return appendCancelCaveat(formatSuccess(res, cwdLabel));
      }
      return formatSuccess(res, cwdLabel);
    },
  };
}

/**
 * 只有「桌面桥在」且「至少一条可写根」时才提供命令工具。
 *
 * 没有可写根时不给：命令的工作目录无处安放，硬给一个 `C:\` 等于把整台机器暴露给模型。
 */
export function buildShellToolBridgeIfAvailable(deps?: {
  bridge?: ShellBridge;
  roots?: () => FileRoot[];
}): ToolBridge | null {
  const bridge = deps?.bridge ?? getDefaultBridge();
  if (!bridge) return null;
  const rootsOf = deps?.roots ?? (() => []);
  const roots = safeRoots(rootsOf);
  if (!roots.some((r) => r.mode === "write")) return null;
  return buildShellToolBridge({ bridge, roots: () => safeRoots(rootsOf) });
}

function safeRoots(rootsOf: () => FileRoot[]): FileRoot[] {
  try {
    const roots = rootsOf();
    return Array.isArray(roots) ? roots : [];
  } catch {
    return [];
  }
}

function getDefaultBridge(): ShellBridge | null {
  // 延迟 import 会在测试里变成动态模块，这里直接读全局，保持与文件桥一致的取法。
  if (typeof window === "undefined") return null;
  const candidate = window.__heming_shell;
  if (!candidate || typeof candidate.run !== "function") return null;
  return candidate;
}
