import { failureResult } from "../toolError.js";
import type { ToolFailureResult } from "../toolError.js";
import type { ToolBridge } from "../agentStream.js";
import type { FileRoot } from "../fileEdit/paths.js";
import { resolveInsideRoot, relFromRoot } from "../fileEdit/paths.js";
import { pickRoot, isPatchError } from "../fileEdit/resolve.js";
import { hasJobRuntime, startShellJob } from "./bridge.js";
import type {
  ShellBridge,
  ShellFailure,
  ShellJobKillResponse,
  ShellJobOutputResponse,
  ShellJobStartResponse,
  ShellJobSummary,
  ShellRunResponse,
} from "./bridge.js";
import {
  SHELL_DEFAULT_TIMEOUT_MS,
  SHELL_JOB_MAX_CAPTURE_BYTES,
  SHELL_JOB_MAX_WAIT_MS,
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

/**
 * 后合作业三件套（d.180）。
 *
 * 前台 `run_command` 有 120 秒硬上限：构建、装依赖、跑整套测试这类命令根本跑不完。
 * 拆开成「起（run_command background）/读（command_output）/列（command_list）/停（command_kill）」，
 * 模型才有办法把一条长命令变成「起一次、反复读增量」的循环。
 */
export const SHELL_OUTPUT_TOOL = "command_output";
export const SHELL_LIST_TOOL = "command_list";
export const SHELL_KILL_TOOL = "command_kill";

const JOB_TOOL_NAMES = new Set<string>([SHELL_OUTPUT_TOOL, SHELL_LIST_TOOL, SHELL_KILL_TOOL]);

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
        background: {
          type: "boolean",
          description:
            "为 true 时起成后台作业并立刻返回 jobId（适合构建、装依赖、整套测试等可能超过两分钟的命令）；"
            + "之后用 command_output 读增量输出、用 command_kill 停止。",
        },
      },
      required: ["command"],
      additionalProperties: false,
    },
  },
  {
    name: SHELL_OUTPUT_TOOL,
    description:
      "读取一个后台作业自上次读取以来新增的 stdout/stderr（读一次消费一次）。"
      + "作业还在跑时可以 wait_ms 等它产出；作业结束后读一次拿收尾输出。"
      + "不要用轮询代替思考：等一会儿再读，别连续空读。",
    parameters: {
      type: "object",
      properties: {
        job_id: {
          type: "string",
          description: "后台作业 id（run_command 的 background:true 返回的 jobId）。",
        },
        wait_ms: {
          type: "integer",
          description: `最多等多久（毫秒，0..${SHELL_JOB_MAX_WAIT_MS}），默认 0 立即返回。`,
        },
      },
      required: ["job_id"],
      additionalProperties: false,
    },
  },
  {
    name: SHELL_LIST_TOOL,
    description: "列出当前桌面端登记的后台命令作业（含运行中与最近结束的），看作业 id、状态、耗时与命令。",
    parameters: {
      type: "object",
      properties: {},
      required: [],
      additionalProperties: false,
    },
  },
  {
    name: SHELL_KILL_TOOL,
    description: "请求停止一个后台命令作业（会杀进程树）。已经结束的作业会如实告诉你无需停止。",
    parameters: {
      type: "object",
      properties: {
        job_id: {
          type: "string",
          description: "要停止的后台作业 id（先用 command_list 确认）。",
        },
      },
      required: ["job_id"],
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
  | { ok: true; command: string; cwd?: string; timeoutMs: number; background: boolean }
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

  return {
    ok: true,
    command,
    ...(cwdRaw ? { cwd: cwdRaw } : {}),
    timeoutMs,
    background: args.background === true,
  };
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

/** 老安装包没有后台作业通道：不假装能起，明确说清并给升级/前台两条路。 */
function bridgeMissingFailure(): ToolFailureResult {
  return failureResult("后台命令不可用（bridge-missing）", "当前桌面端没有后台作业通道，`background: true` 无法生效。", {
    error_code: "bridge-missing",
    hint: "当前桌面端版本不支持后台命令，请改用前台命令或升级",
  });
}

/** 后台通道失败码 → 与前台同一套 ToolFailure 形状（`error_code` / `hint` / `retry_with`）。 */
function jobFailureOf(res: Extract<ShellFailure, { ok: false }>): ToolFailureResult {
  switch (res.code) {
    case "unknown-job":
      return failureResult("作业不存在（unknown-job）", res.error || "没有这个后台作业：可能已结束并被清理。", {
        error_code: "unknown-job",
        hint: "先用 command_list 看当前有哪些作业",
      });
    case "no-roots":
    case "no-write-root":
      return failureResult("没有可执行目录（no-write-root）", "当前没有可写根，作业无法确定工作目录。", {
        error_code: "no-write-root",
      });
    case "outside-roots":
      return failureResult("工作目录越界（path-escape）", res.error || "工作目录不在可写根内。", {
        error_code: "path-escape",
      });
    case "invalid-command":
      return failureResult("命令无效（invalid-command）", res.error, { error_code: "invalid-command" });
    case "untrusted-sender":
      return failureResult("调用来源不可信（untrusted-sender）", res.error, { error_code: "untrusted-sender" });
    case "io":
      return failureResult("作业读写失败（io）", res.error || "桌面端读写作业输出时出错。", {
        error_code: "io",
        hint: "再读一次；仍失败就让用户看桌面端日志",
      });
    default:
      return failureResult("作业启动失败（spawn-failed）", res.error || "无法启动子进程。", {
        error_code: "spawn-failed",
        hint: "确认命令在系统里存在、且用户允许在此目录执行",
      });
  }
}

function parseJobId(raw: unknown): { ok: true; jobId: string } | { ok: false; failure: ToolFailureResult } {
  const args = (raw ?? {}) as Record<string, unknown>;
  const jobId = typeof args.job_id === "string" ? args.job_id.trim() : "";
  if (!jobId) {
    return {
      ok: false,
      failure: failureResult("缺少作业 id（invalid-args）", "`job_id` 不能为空；先用 command_list 看有哪些作业。", {
        error_code: "invalid-args",
        retry_with: 'job_id: "job-…"',
      }),
    };
  }
  return { ok: true, jobId };
}

/** wait_ms 缺省 0（立即返回）；给了就钳到 0..30 秒，避免一次工具调用挂住整轮对话。 */
function parseWaitMs(raw: unknown): number {
  const args = (raw ?? {}) as Record<string, unknown>;
  const value = typeof args.wait_ms === "number" ? args.wait_ms : Number.NaN;
  if (!Number.isFinite(value)) return 0;
  return Math.min(Math.max(Math.floor(value), 0), SHELL_JOB_MAX_WAIT_MS);
}

function formatJobStart(res: ShellJobStartResponse, cwdLabel: string): {
  text: string;
  ok: boolean;
  /** d.182：结构化上报「这一回合起了哪个作业」，界面据此在收口后继续盯它（不再从文案里抠 jobId）。 */
  jobs: string[];
} {
  return {
    text:
      `已在后台启动：jobId=${res.jobId}（工作目录 ${cwdLabel}）。\n`
      + `用 command_output 读增量输出（可 wait_ms 等待，最多 ${SHELL_JOB_MAX_WAIT_MS}ms），`
      + "用 command_kill 停掉；不要重复启动同一条命令。",
    ok: true,
    jobs: [res.jobId],
  };
}

function formatJobOutput(res: ShellJobOutputResponse): { text: string; ok: boolean } {
  const status = res.running
    ? "运行中"
    : res.exitCode === null
      ? "已停止（退出码 未知）"
      : `已结束（退出码 ${res.exitCode}）`;
  const stdout = res.stdout.trim() ? res.stdout.replace(/\s+$/, "") : "（无新增输出）";
  const stderr = res.stderr.trim() ? res.stderr.replace(/\s+$/, "") : "（无新增输出）";
  const lines: string[] = [`作业 ${res.jobId}：${status}`, "--- stdout ---", stdout, "--- stderr ---", stderr];
  if (res.truncated) {
    lines.push(`（输出超过 ${Math.round(SHELL_JOB_MAX_CAPTURE_BYTES / 1024)}KB 上限，早期内容已被丢弃）`);
  }
  if (res.droppedBytes > 0) lines.push(`（已丢弃 ${res.droppedBytes} 字节早期输出）`);
  lines.push("再次读取只返回新增输出");
  return { text: lines.join("\n"), ok: true };
}

/** 列表里的状态列：已完成要带退出码，被停掉的作业 `exitCode` 是 null。 */
function jobListStatus(job: ShellJobSummary): string {
  if (job.running) return "运行中";
  if (job.exitCode === null) return "已停止";
  return `已结束(${job.exitCode})`;
}

function formatDuration(ms: number): string {
  const seconds = Math.max(0, ms) / 1000;
  if (seconds < 60) return `${seconds.toFixed(1)}s`;
  const totalSeconds = Math.floor(seconds);
  const minutes = Math.floor(totalSeconds / 60);
  const restSeconds = totalSeconds % 60;
  if (minutes < 60) return `${minutes}m${String(restSeconds).padStart(2, "0")}s`;
  return `${Math.floor(minutes / 60)}h${String(minutes % 60).padStart(2, "0")}m`;
}

function jobElapsedMs(job: ShellJobSummary, now: number): number {
  const end = job.running || job.finishedAt === null ? now : job.finishedAt;
  return Math.max(0, end - job.startedAt);
}

/** 命令压成单行再截断：列表是给人/模型扫一眼的，不能因为命令里有换行就串行。 */
function oneLine(text: string, max: number): string {
  const flat = text.replace(/\s+/g, " ").trim();
  if (flat.length <= max) return flat;
  return `${flat.slice(0, max - 1)}…`;
}

function formatJobList(jobs: ShellJobSummary[], now: number): { text: string; ok: boolean } {
  if (jobs.length === 0) return { text: "当前没有后台作业。", ok: true };
  const lines = [`后台作业 ${jobs.length} 个：`];
  for (const job of jobs) {
    lines.push(`- ${job.id} ${jobListStatus(job)} ${formatDuration(jobElapsedMs(job, now))} — ${oneLine(job.command, 80)}`);
  }
  return { text: lines.join("\n"), ok: true };
}

function formatJobKill(res: ShellJobKillResponse): { text: string; ok: boolean } {
  if (res.killed) return { text: `已请求停止作业 ${res.jobId}，进程树会在停止后清理。`, ok: true };
  return { text: `作业 ${res.jobId} 已经结束，无需停止。`, ok: true };
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
  const bridge = deps.bridge;
  const jobsAvailable = hasJobRuntime(bridge);
  // 老安装包（没有后台通道）只暴露 run_command：给一个点了必然失败的 entry 比没有更糟。
  const tools = (jobsAvailable ? TOOLS : TOOLS.filter((spec) => spec.name === SHELL_TOOL)).map((spec) => ({
    type: "function" as const,
    function: {
      name: spec.name,
      description: spec.description,
      parameters: spec.parameters,
    },
  }));

  const parseCallArguments = (
    call: { name: string; arguments: string },
  ): { ok: true; raw: unknown } | { ok: false; failure: ToolFailureResult } => {
    try {
      return { ok: true, raw: call.arguments ? JSON.parse(call.arguments) : {} };
    } catch (err) {
      return {
        ok: false,
        failure: failureResult("参数不是合法 JSON（invalid-args）", `解析参数失败：${String(err)}`, {
          error_code: "invalid-args",
        }),
      };
    }
  };

  /** 前台执行 `run_command` 的全部逻辑（d.164 原有行为，逐字保留）。 */
  const runCommand = async (raw: unknown, opts?: { signal?: AbortSignal }) => {
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

      // ---- 后台作业（d.180）：起一次就返回，不进入前台的串行队列 ----
      if (parsed.background) {
        if (!jobsAvailable) return bridgeMissingFailure();
        let started: ShellJobStartResponse | ShellFailure;
        try {
          started = await startShellJob(bridge, { roots, command: parsed.command, runId, cwd: cwdAbs });
        } catch (err) {
          return failureResult("后台启动失败（spawn-failed）", `调用桌面端失败：${String(err)}`, {
            error_code: "spawn-failed",
          });
        }
        if (!started.ok) return jobFailureOf(started);
        return formatJobStart(started, cwdLabel);
      }

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
  };

  /** `command_output`：读一个作业的增量输出（读一次消费一次）。 */
  const readJobOutput = async (raw: unknown) => {
    if (!jobsAvailable) return bridgeMissingFailure();
    const parsedId = parseJobId(raw);
    if (!parsedId.ok) return parsedId.failure;
    let res: ShellJobOutputResponse | ShellFailure;
    try {
      res = await bridge.jobOutput!({ jobId: parsedId.jobId, waitMs: parseWaitMs(raw) });
    } catch (err) {
      return failureResult("读取后台输出失败（io）", `调用桌面端失败：${String(err)}`, { error_code: "io" });
    }
    if (!res.ok) return jobFailureOf(res);
    return formatJobOutput(res);
  };

  /** `command_list`：列出本主进程登记的后台作业。 */
  const listJobs = async () => {
    if (!jobsAvailable) return bridgeMissingFailure();
    let res: { ok: true; jobs: ShellJobSummary[] } | ShellFailure;
    try {
      res = await bridge.jobs!();
    } catch (err) {
      return failureResult("列出后台作业失败（io）", `调用桌面端失败：${String(err)}`, { error_code: "io" });
    }
    if (!res.ok) return jobFailureOf(res);
    return formatJobList(res.jobs, Date.now());
  };

  /** `command_kill`：请求停止一个作业（只认 jobId，不接受 pid）。 */
  const killJob = async (raw: unknown) => {
    if (!jobsAvailable) return bridgeMissingFailure();
    const parsedId = parseJobId(raw);
    if (!parsedId.ok) return parsedId.failure;
    let res: ShellJobKillResponse | ShellFailure;
    try {
      res = await bridge.jobKill!({ jobId: parsedId.jobId });
    } catch (err) {
      return failureResult("停止后台作业失败（io）", `调用桌面端失败：${String(err)}`, { error_code: "io" });
    }
    if (!res.ok) return jobFailureOf(res);
    return formatJobKill(res);
  };

  return {
    tools,
    meta(name: string) {
      // d.207：命令与后台作业是长任务的主干能力（写完要跑、跑完要读输出），声明成核心工具。
      switch (name) {
        case SHELL_TOOL:
          return { risk: "danger" as const, displayName: "运行命令", core: true };
        case SHELL_OUTPUT_TOOL:
          return { risk: "read" as const, displayName: "读取后台输出", core: true };
        case SHELL_LIST_TOOL:
          return { risk: "read" as const, displayName: "列出后台命令", core: true };
        case SHELL_KILL_TOOL:
          return { risk: "write" as const, displayName: "停止后台命令", core: true };
        default:
          return undefined;
      }
    },
    async execute(call: { name: string; arguments: string }, opts?: { signal?: AbortSignal }) {
      if (call.name !== SHELL_TOOL && !JOB_TOOL_NAMES.has(call.name)) {
        return failureResult("未知工具（unknown-tool）", `没有名为「${call.name}」的内置命令工具。`, {
          error_code: "unknown-tool",
        });
      }
      const parsedCall = parseCallArguments(call);
      if (!parsedCall.ok) return parsedCall.failure;
      switch (call.name) {
        case SHELL_TOOL:
          return runCommand(parsedCall.raw, opts);
        case SHELL_OUTPUT_TOOL:
          return readJobOutput(parsedCall.raw);
        case SHELL_LIST_TOOL:
          return listJobs();
        default:
          return killJob(parsedCall.raw);
      }
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
