/**
 * CLI 侧的确定性工具钩子（`.heming/hooks.json`）。
 *
 * 为什么 CLI 要认这份文件：从 d.236 起，桌面端在每次工具调用前都会跑工作区声明的
 * 本机检查（`packages/web/src/lib/hitl/hooks.ts` + `hookRunner.ts`），「不许改
 * `generated/**`」「提交前必须跑 lint」这类硬规矩由此变成确定性闸门。可 `heming run`
 * 之前完全不看它——同一份 hooks.json，窗口里的和鸣会先跑检查再动手，终端里的和鸣
 * 直接动。团队把规矩写进仓库，结果只有一半入口遵守，这比没有规矩更糟。
 *
 * 与桌面端**逐字对齐**的口径（解析、匹配、判定全部复用同一份纯逻辑，不另立一套）：
 * - 配置只认工作区里的 `.heming/hooks.json`，不扫用户目录；
 * - 配置解析失败 **fail-closed**：调用方据此拒绝所有工具调用，而不是「忽略这段配置继续跑」；
 * - 命中的 hook 按配置顺序依次执行，任一拒绝立即停下；
 * - 命令末尾追加 payload JSON 文件路径作为第一个参数；
 * - 判定优先级 **超时 > stdout JSON > 退出码**（0 放行 / 2 拒绝 / 其它一律拒绝）。
 *
 * 与桌面端**唯一的不同**：这里默认**不执行**仓库里的脚本。
 * `.heming/hooks.json` 跟着仓库走，克隆一个陌生仓库不能让它在你敲下 `heming run`
 * 时自动在本机执行命令。要真正生效必须显式加 `--trust-hooks`，与
 * `.heming/permissions.json` 的 allow 规则需要 `--trust-workspace` 是同一个道理。
 */

import { spawn } from "node:child_process";
import { promises as fs } from "node:fs";
import path from "node:path";
import {
  MAX_TOOL_HOOKS,
  TOOL_HOOKS_CONFIG_REL,
  TOOL_HOOKS_TMP_REL,
  buildHookPayload,
  hookDeniedText,
  interpretHookResult,
  matchHooks,
  parseHooksConfig,
  type ToolHookDecision,
  type ToolHookRule,
} from "../../../packages/web/src/lib/hitl/hooks.js";

/** 配置文件大小上限：一份钩子清单不该有几百 KB。 */
export const CLI_HOOKS_MAX_BYTES = 256 * 1024;

/** 单条 hook 的 stdout / stderr 各留多少字（判定只用第一行，留这些足够诊断）。 */
export const CLI_HOOK_OUTPUT_MAX_CHARS = 8_000;

/** 加载成功后的钩子集：规则 + 来源 + 是否放行执行。 */
export interface CliHookSet {
  /** 已解析的规则（可能为空）。 */
  hooks: ToolHookRule[];
  /** 给人看的来源（相对工作区的路径）。 */
  source: string;
  /** 是否允许真跑这些脚本（`--trust-hooks`）。 */
  enabled: boolean;
}

/**
 * 加载结果。
 *
 * - `ok:true`：文件存在且解析成功（规则可以为空）；
 * - `ok:false`：文件存在但读不了 / 太大 / 解析失败 → 信任时调用方必须拒绝启动；
 * - `null`：没有这份配置（常态，大多数仓库没有）。
 */
export type CliHooksLoad =
  | { ok: true; set: CliHookSet }
  | { ok: false; error: string; source: string }
  | null;

/** 一次判定的结果：拒绝时带上命中的规则与原因，给模型看的文案由调用方拼。 */
export interface CliHookVerdict {
  decision: "allow" | "deny";
  reason?: string;
  /** 命中规则在配置里的序号（从 1 开始）。 */
  ruleIndex?: number;
  /** 命中的那条命令原文。 */
  command?: string;
}

/** 配置文件的绝对路径（正斜杠）。 */
export function cliHooksConfigPath(cwd: string): string {
  const root = path.resolve(cwd).replace(/\\/g, "/").replace(/\/+$/, "");
  return `${root}/${TOOL_HOOKS_CONFIG_REL}`;
}

/** 读一份工作区钩子配置；语义见文件头。 */
export async function loadCliHooks(cwd: string, enabled: boolean): Promise<CliHooksLoad> {
  const file = cliHooksConfigPath(cwd);
  const source = TOOL_HOOKS_CONFIG_REL;

  let stat;
  try {
    stat = await fs.stat(file);
  } catch (error) {
    // 不存在 = 没有钩子，这是常态。
    if ((error as NodeJS.ErrnoException).code === "ENOENT") return null;
    return { ok: false, error: `读不到钩子配置：${messageOf(error)}`, source };
  }
  if (!stat.isFile()) return { ok: false, error: "钩子配置路径不是文件", source };
  if (stat.size > CLI_HOOKS_MAX_BYTES) {
    return {
      ok: false,
      error: `钩子配置太大（${stat.size} 字节 > ${CLI_HOOKS_MAX_BYTES} 字节上限）`,
      source,
    };
  }

  let rawText: string;
  try {
    rawText = await fs.readFile(file, "utf8");
  } catch (error) {
    return { ok: false, error: `读不到钩子配置：${messageOf(error)}`, source };
  }

  // 与权限规则同一个坑：记事本 / PowerShell 5 会写 BOM，JSON.parse 直接炸。
  const parsed = parseHooksConfig(rawText.replace(/^\uFEFF/, ""));
  if (!parsed.ok) return { ok: false, error: parsed.error, source };

  return { ok: true, set: { hooks: parsed.hooks, source, enabled } };
}

/** 一行说明：启动时打到 stderr，让用户知道这次跑会（或不会）执行哪些检查。 */
export function describeCliHooks(set: CliHookSet): string {
  const count = set.hooks.length;
  if (count === 0) return `工作区钩子：${set.source} 里没有规则（来自 ${set.source}）`;
  const state = set.enabled
    ? "已启用，命中的工具调用会先跑本机检查"
    : "未启用（加 --trust-hooks 才会执行这些脚本）";
  const capped = count >= MAX_TOOL_HOOKS ? `（已达上限 ${MAX_TOOL_HOOKS} 条）` : "";
  return `工作区钩子：${count} 条${capped}；${state}（来自 ${set.source}）`;
}

/** 一次 hook 进程的执行结果（`timedOut` 单独标出来，判定优先级最高）。 */
interface HookProcessResult {
  exitCode: number | null;
  stdout: string;
  stderr: string;
  timedOut: boolean;
}

/**
 * 跑一条 hook 命令。
 *
 * 用 shell 执行（配置里写 `node scripts/check.js` 是最常见的形态），工作目录是工作区根；
 * 契约与桌面端一致：命令末尾追加 payload 文件路径作为第一个参数。
 *
 * 超时后 `kill()` 只保证杀掉 shell 本身，孙进程可能残留——这与桌面端命令桥的行为一致，
 * 也远好于「超时了还当放行」。
 */
function runHookProcess(command: string, cwd: string, timeoutMs: number): Promise<HookProcessResult> {
  return new Promise((resolve) => {
    let child;
    try {
      child = spawn(command, {
        cwd,
        shell: true,
        windowsHide: true,
        stdio: ["ignore", "pipe", "pipe"],
      });
    } catch (error) {
      resolve({ exitCode: -1, stdout: "", stderr: messageOf(error), timedOut: false });
      return;
    }

    let stdout = "";
    let stderr = "";
    let settled = false;
    let timedOut = false;

    const finish = (exitCode: number | null): void => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      resolve({ exitCode, stdout, stderr, timedOut });
    };

    const timer = setTimeout(() => {
      timedOut = true;
      try {
        child.kill();
      } catch {
        // 进程已经没了：`close` 事件马上会到，走正常收尾。
      }
    }, timeoutMs);

    child.stdout?.on("data", (chunk: Buffer | string) => {
      if (stdout.length >= CLI_HOOK_OUTPUT_MAX_CHARS) return;
      stdout += String(chunk);
      if (stdout.length > CLI_HOOK_OUTPUT_MAX_CHARS) stdout = stdout.slice(0, CLI_HOOK_OUTPUT_MAX_CHARS);
    });
    child.stderr?.on("data", (chunk: Buffer | string) => {
      if (stderr.length >= CLI_HOOK_OUTPUT_MAX_CHARS) return;
      stderr += String(chunk);
      if (stderr.length > CLI_HOOK_OUTPUT_MAX_CHARS) stderr = stderr.slice(0, CLI_HOOK_OUTPUT_MAX_CHARS);
    });
    child.on("error", (error) => {
      stderr += `\n${messageOf(error)}`;
      finish(-1);
    });
    child.on("close", (code) => finish(code));
  });
}

/** payload 临时文件的路径（相对工作区根）；`runId` 只由本模块生成，不含用户输入。 */
function payloadRelPath(runId: string): string {
  return `${TOOL_HOOKS_TMP_REL}/${runId}.json`;
}

/** 生成一个碰撞概率足够低的运行 id（只用于临时文件名）。 */
function newRunId(now: number, random: () => number): string {
  const stamp = now.toString(36);
  const salt = Math.floor(random() * 36 ** 6)
    .toString(36)
    .padStart(6, "0");
  return `${stamp}-${salt}`;
}

/** 把判定与命中的规则一起带回，调用方据此拼文案。 */
function withRule(rule: ToolHookRule, ruleIndex: number, verdict: ToolHookDecision): CliHookVerdict {
  return {
    decision: verdict.decision,
    ...(verdict.reason ? { reason: verdict.reason } : {}),
    ruleIndex,
    command: rule.command,
  };
}

/** 可选注入：单测里换掉进程执行与时间来源，免得每个用例都真起子进程。 */
export interface CliHookRuntime {
  runProcess?: typeof runHookProcess;
  now?: () => number;
  random?: () => number;
}

/**
 * 造一个「调用前跑钩子」的函数。
 *
 * 返回 `null` 表示这次运行不需要做任何检查（没有配置或没启用），调用方据此完全跳过
 * ——不要为了「统一」去跑一个空循环，那样只会让每次工具调用多一次无谓的异步跳转。
 */
export function createCliHookRunner(
  set: CliHookSet,
  options: { cwd: string; streamId: string; agentId?: string; runtime?: CliHookRuntime },
): ((call: { name: string; arguments: string }) => Promise<CliHookVerdict>) | null {
  if (!set.enabled || set.hooks.length === 0) return null;

  const workspace = path.resolve(options.cwd).replace(/\\/g, "/").replace(/\/+$/, "");
  const runProcess = options.runtime?.runProcess ?? runHookProcess;
  const now = options.runtime?.now ?? Date.now;
  const random = options.runtime?.random ?? Math.random;

  return async (call) => {
    const matched = matchHooks(set.hooks, call, workspace);
    if (matched.length === 0) return { decision: "allow" };

    for (const rule of matched) {
      const ruleIndex = set.hooks.indexOf(rule) + 1;
      const runId = newRunId(now(), random);
      const rel = payloadRelPath(runId);
      const payloadAbs = `${workspace}/${rel}`;

      // payload 里带的是模型实际发来的参数原文（不二次序列化），hook 脚本能逐字核对。
      const payload = buildHookPayload({
        name: call.name,
        arguments: call.arguments,
        workspace,
        agentId: options.agentId ?? "cli",
        streamId: options.streamId,
        time: new Date(now()),
      });

      let wrote = false;
      try {
        await fs.mkdir(path.dirname(payloadAbs), { recursive: true });
        await fs.writeFile(payloadAbs, JSON.stringify(payload, null, 2), "utf8");
        wrote = true;
      } catch (error) {
        return {
          decision: "deny",
          reason: `hook「${rule.command}」无法执行：payload 临时文件写入失败（${messageOf(error)}）`,
          ruleIndex,
          command: rule.command,
        };
      }

      try {
        const result = await runProcess(`${rule.command} "${payloadAbs}"`, workspace, rule.timeoutMs);
        const verdict = withRule(
          rule,
          ruleIndex,
          interpretHookResult(result.exitCode, result.stdout, result.stderr, result.timedOut),
        );
        if (verdict.decision === "deny") return verdict;
      } finally {
        if (wrote) {
          // 删不掉不影响判定，但别把工作区的临时目录越攒越脏。
          await fs.rm(payloadAbs, { force: true }).catch(() => undefined);
        }
      }
    }

    return { decision: "allow" };
  };
}

/** 被钩子拒绝时回给模型的文案（与桌面端同一口径，见 `hookDeniedText`）。 */
export function cliHookDeniedText(verdict: CliHookVerdict, toolName: string): string {
  return hookDeniedText({
    toolName,
    ...(verdict.command ? { command: verdict.command } : {}),
    ...(verdict.ruleIndex !== undefined ? { ruleIndex: verdict.ruleIndex } : {}),
    ...(verdict.reason ? { reason: verdict.reason } : {}),
  });
}

function messageOf(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}