/**
 * 命令行参数解析（纯函数）。
 *
 * 为什么把解析单独抽出来：`index.ts` 只做 I/O（读 env、写 stdout/stderr、装信号），
 * 解析没有任何副作用，单独成模块才能不启进程就把「未知选项 / 缺 prompt / 选项取值」
 * 这些最容易回归的分支钉在单测里。
 *
 * 约定（与仓库其它脚本一致）：
 * - 同时认 `--x value` 与 `--x=value`；
 * - `--` 之后的所有词都算 prompt（prompt 里出现 `--foo` 时用它保命）；
 * - 未知选项一律报错（退出码 2），绝不猜测、绝不忽略——CLI 里的静默忽略
 *   会让用户在 CI 里以为某个开关生效了。
 */

import { parseCliContextBudget } from "./contextBudget.js";

export interface PromptOptions {
  /** `run` 流式给人看；`exec` 非交互（可与 `--json` 组合给机器读）。 */
  command: "run" | "exec";
  /** 用户问题（多个位置参数用一个空格拼接）。`fromStdin` 为真时这里是空串。 */
  prompt: string;
  /** stdout 的格式：`text` 给人读 / `json` 一个对象（exec 专用）/ `stream-json` 一行一条事件。 */
  outputFormat: "text" | "json" | "stream-json";
  /** 只有 `exec` 支持：stdout 只输出一个 JSON 对象（= `outputFormat === "json"`，保留旧字段兼容）。 */
  json: boolean;
  /** prompt 写的是 `-`：从 stdin 读指令（`git diff | heming exec -`）。 */
  fromStdin: boolean;
  /** 工作目录（缺省由 index 用 `process.cwd()` 兜底）。 */
  cwd?: string;
  /** 最多允许的工具轮数（第 N+1 轮还想调工具就提前收口）。 */
  maxRounds?: number;
  /** 放行 `run_command` 等 danger 工具。 */
  allowDanger: boolean;
  /**
   * 只读模式：除自报只读的工具外一律不执行（写、删、改、跑命令都拦住）。
   * 与 `--allow-danger` 同时给时只读赢——「先看看它想干什么」不该顺带动手。
   */
  readOnly: boolean;
  /**
   * 交互式审批：危险调用（命令、MCP 工具）先在终端问一句，而不是一律拒绝或一律放行。
   * 需要真正的终端（stdin 是 TTY）；`run -`（从 stdin 读指令）不能与它同时用。
   */
  ask: boolean;
  /**
   * 信任工作区的 `.heming/permissions.json`：只有信任之后，里面的 **allow** 规则才生效。
   * deny / ask 不受这个开关影响——它们是收紧方向，仓库里写了一定照做。
   */
  trustWorkspace: boolean;
  model?: string;
  baseUrl?: string;
  apiKey?: string;
  /** 接上一次会话（当前工作目录下最近一次）。 */
  continueSession: boolean;
  /** 显式接某个会话：整串 id 或唯一前缀。 */
  resume?: string;
  /** 存档目录（缺省 `~/.heming/cli-sessions`，也可用 HEMING_CLI_SESSION_DIR）。 */
  sessionDir?: string;
  /**
   * 连上工作区 `.heming/mcp.json` 里声明的 MCP 服务，把它们的工具一起交给模型。
   * 必须显式打开：连服务等于启动仓库里写的命令，克隆来的仓库不该自动获得这个权力。
   */
  mcp: boolean;
  /**
   * 信任工作区的 `.heming/hooks.json`：只有信任之后，命中的工具调用才会先跑那些本机脚本。
   * 默认不信任——配置跟着仓库走，克隆一个陌生仓库不能在你敲命令时自动执行它的脚本。
   */
  trustHooks: boolean;
  /**
   * 续聊历史的 token 预算（`--context-budget`）：超出就把早期对话折成摘要。
   * 缺省 12k；只在 `--continue` / `--resume` 这类带历史的运行里起作用。
   */
  contextBudget?: number;
  /** `false` = `--no-compact`：历史原样发送，不做折叠。 */
  compact: boolean;
  /**
   * 是否读写工作区记忆（`.heming/memory.json`）。
   *
   * 缺省开启：记过的偏好下次运行自动带上。`--no-memory` 关掉两头——既不注入召回、
   * 也不挂 `remember` 工具（「这次别记也别用」要能一句话做到）。
   */
  memory: boolean;
  /**
   * 是否挂子代理（`agent_task`）。缺省开启；`--no-subagent` 关掉。
   *
   * 关掉之后模型只能自己一个文件一个文件地查——查证类任务会明显更费上下文，
   * 但省一次模型调用。MCP 模式本来就没有它（那条路不调模型）。
   */
  subagent: boolean;
  /** 回退日志（d.336）：默认开；`--no-rewind` 关掉（关掉只是不抓原文）。 */
  rewind: boolean;
}

/** `heming sessions` 的选项：只列存档，不调模型。 */
export interface SessionsOptions {
  /** stdout 输出 JSON 数组（给脚本用），否则是一张给人看的表。 */
  json: boolean;
  /** 只看这个目录下跑过的会话。 */
  cwd?: string;
  sessionDir?: string;
}

/** `heming memory` 的选项：直接读写 `.heming/memory.json`，不调模型。 */
export interface MemoryOptions {
  /** 工作目录（缺省由 index 用 `process.cwd()` 兜底）。 */
  cwd?: string;
  /** stdout 输出 JSON（给脚本用），否则是一张给人看的表。 */
  json: boolean;
  /** 记下这句话。 */
  add?: string;
  /** 删掉这条（完整 id 或列表里的序号）。 */
  forget?: string;
}

/** `heming commands` 的选项：只列工作区里的自定义命令，不调模型。 */
export interface CommandsOptions {
  /** 工作目录（缺省由 index 用 `process.cwd()` 兜底）。 */
  cwd?: string;
  /** stdout 输出 JSON 数组（给脚本用），否则是一张给人看的表。 */
  json: boolean;
}

/** `heming rewind` 的选项：只读写 `.heming/rewind/`，不调模型。 */
export interface RewindOptions {
  /** 工作目录（缺省由 index 用 `process.cwd()` 兜底）。 */
  cwd?: string;
  /** 退最近几轮；省略 = 只列出来看（不动文件）。 */
  runs?: number;
}

export interface McpOptions {
  /** 显式给出的工作目录；缺省由 index 用 `process.cwd()` 兜底。 */
  cwd?: string;
  /** 放行 `run_command`（MCP 客户端能调用它真跑命令）。 */
  allowDanger: boolean;
  /** 只读模式：只把只读工具暴露给客户端，写工具直接从 tools/list 里拿掉。 */
  readOnly: boolean;
  /** 同 run：信任工作区权限规则里的 allow（deny / ask 总是生效），需要用 --trust-workspace 显式打开。 */
  trustWorkspace: boolean;
  /** 同 run：信任工作区的 `.heming/hooks.json` 并真的执行那些脚本（`--trust-hooks`）。 */
  trustHooks: boolean;
}

export type ParsedArgs =
  | { ok: true; action: "help" }
  | { ok: true; action: "version" }
  | { ok: true; action: "run"; options: PromptOptions }
  | { ok: true; action: "mcp"; options: McpOptions }
  | { ok: true; action: "sessions"; options: SessionsOptions }
  | { ok: true; action: "memory"; options: MemoryOptions }
  | { ok: true; action: "commands"; options: CommandsOptions }
  | { ok: true; action: "rewind"; options: RewindOptions }
  | { ok: false; error: string };

/** 需要取值的选项：值不能是另一个选项（`--cwd --json` 是写错了，不该把 `--json` 当目录）。 */
function takeValue(argv: string[], index: number, inline: string | undefined): { value?: string; next: number } {
  if (inline !== undefined) return { value: inline, next: index };
  const next = index + 1;
  const candidate = argv[next];
  if (candidate === undefined || (candidate.startsWith("-") && candidate !== "-")) {
    return { next: index };
  }
  return { value: candidate, next };
}

export function parseArgs(argv: string[]): ParsedArgs {
  let command: "run" | "exec" | "mcp" | "sessions" | "memory" | "commands" | "rewind" | null = null;
  let json = false;
  let outputFormat: "text" | "json" | "stream-json" = "text";
  let allowDanger = false;
  let trustWorkspace = false;
  let trustHooks = false;
  let readOnly = false;
  let ask = false;
  let contextBudget: number | undefined;
  let compact = true;
  let cwd: string | undefined;
  let maxRounds: number | undefined;
  let model: string | undefined;
  let baseUrl: string | undefined;
  let apiKey: string | undefined;
  let continueSession = false;
  let resume: string | undefined;
  let sessionDir: string | undefined;
  let mcp = false;
  let memory = true;
  let subagent = true;
  let keepRewind = true;
  const promptParts: string[] = [];
  let flagsEnded = false;

  for (let i = 0; i < argv.length; i += 1) {
    const arg = argv[i]!;

    if (!flagsEnded && arg === "--") {
      flagsEnded = true;
      continue;
    }

    if (!flagsEnded && (arg === "--help" || arg === "-h")) return { ok: true, action: "help" };
    if (!flagsEnded && (arg === "--version" || arg === "-v")) return { ok: true, action: "version" };

    if (!flagsEnded && arg.startsWith("--")) {
      const eq = arg.indexOf("=");
      const name = eq >= 0 ? arg.slice(2, eq) : arg.slice(2);
      const inline = eq >= 0 ? arg.slice(eq + 1) : undefined;

      switch (name) {
        case "json": {
          if (inline !== undefined) return { ok: false, error: "--json 不接受取值（直接写 --json 即可）" };
          if (outputFormat === "stream-json") {
            return { ok: false, error: "--json 与 --output-format stream-json 冲突：选一个（要边跑边说事件就只用 stream-json）" };
          }
          json = true;
          outputFormat = "json";
          break;
        }
        case "output-format": {
          const taken = takeValue(argv, i, inline);
          i = taken.next;
          const value = taken.value;
          if (value === undefined || value.trim() === "") {
            return { ok: false, error: "--output-format 需要一个值（text / json / stream-json）" };
          }
          if (value !== "text" && value !== "json" && value !== "stream-json") {
            return {
              ok: false,
              error: `--output-format 只支持 text / json / stream-json，收到「${value}」`,
            };
          }
          if (
            (value === "json" && outputFormat === "stream-json") ||
            (value === "stream-json" && outputFormat === "json")
          ) {
            return { ok: false, error: "--json 与 --output-format stream-json 冲突：选一个（要边跑边说事件就只用 stream-json）" };
          }
          outputFormat = value;
          json = value === "json";
          break;
        }
        case "allow-danger": {
          if (inline !== undefined) return { ok: false, error: "--allow-danger 不接受取值（直接写 --allow-danger 即可）" };
          allowDanger = true;
          break;
        }
        case "read-only": {
          if (inline !== undefined) return { ok: false, error: "--read-only 不接受取值（直接写 --read-only 即可）" };
          readOnly = true;
          break;
        }
        case "ask": {
          if (inline !== undefined) return { ok: false, error: "--ask 不接受取值（直接写 --ask 即可）" };
          ask = true;
          break;
        }
        case "no-subagent": {
          if (inline !== undefined) return { ok: false, error: "--no-subagent 不接受取值（直接写 --no-subagent 即可）" };
          subagent = false;
          break;
        }
        case "no-rewind": {
          if (inline !== undefined) return { ok: false, error: "--no-rewind 不接受取值（直接写 --no-rewind 即可）" };
          keepRewind = false;
          break;
        }
        case "no-memory": {
          if (inline !== undefined) return { ok: false, error: "--no-memory 不接受取值（直接写 --no-memory 即可）" };
          memory = false;
          break;
        }
        case "no-compact": {
          if (inline !== undefined) return { ok: false, error: "--no-compact 不接受取值（直接写 --no-compact 即可）" };
          compact = false;
          break;
        }
        case "mcp": {
      if (inline !== undefined) {
        return { ok: false, error: "--mcp 不接受取值（直接写 --mcp 即可）" };
      }
      mcp = true;
      continue;
    }
    case "trust-hooks": {
      if (inline !== undefined) {
        return { ok: false, error: "--trust-hooks 不接受取值（直接写 --trust-hooks 即可）" };
      }
      trustHooks = true;
      continue;
    }
    case "trust-workspace": {
          if (inline !== undefined) {
            return { ok: false, error: "--trust-workspace 不接受取值（直接写 --trust-workspace 即可）" };
          }
          trustWorkspace = true;
          break;
        }
        case "continue": {
          if (inline !== undefined) return { ok: false, error: "--continue 不接受取值（直接写 --continue 即可）" };
          continueSession = true;
          break;
        }
        case "resume":
        case "session-dir": {
          const taken = takeValue(argv, i, inline);
          i = taken.next;
          if (taken.value === undefined || taken.value.trim() === "") {
            return { ok: false, error: `--${name} 需要一个值（例如 --${name} <值>）` };
          }
          if (name === "resume") resume = taken.value;
          else sessionDir = taken.value;
          break;
        }
        case "cwd":
        case "max-rounds":
        case "context-budget":
        case "model":
        case "base-url":
        case "api-key": {
          const taken = takeValue(argv, i, inline);
          i = taken.next;
          if (taken.value === undefined || taken.value.trim() === "") {
            return { ok: false, error: `--${name} 需要一个值（例如 --${name} <值>）` };
          }
          const value = taken.value;
          if (name === "cwd") cwd = value;
          else if (name === "model") model = value;
          else if (name === "base-url") baseUrl = value;
          else if (name === "api-key") apiKey = value;
          else if (name === "context-budget") {
            // 预算必须是正整数，且要在能用的区间里：太小会把最后一轮也切碎，太大等于没设。
            const budget = parseCliContextBudget(value);
            if (!budget.ok) return { ok: false, error: budget.error };
            contextBudget = budget.value;
          } else {
            // 轮次上限必须是正整数：0/负数/小数都说明用户理解错了语义，当场报错比默默夹逼诚实。
            if (!/^\d+$/.test(value) || Number(value) < 1) {
              return { ok: false, error: `--max-rounds 需要正整数，收到「${value}」` };
            }
            maxRounds = Number(value);
          }
          break;
        }
        default:
          return { ok: false, error: `未知选项 --${name}（用 --help 查看用法）` };
      }
      continue;
    }

    // 单个 `-` 或其它以 `-` 开头的词：不认识的短选项也报错，不把 `-x` 当成 prompt。
    if (!flagsEnded && arg.startsWith("-") && arg !== "-") {
      return { ok: false, error: `未知选项 ${arg}（用 --help 查看用法）` };
    }

    if (command === null) {
      if (
        arg === "run" ||
        arg === "exec" ||
        arg === "mcp" ||
        arg === "sessions" ||
        arg === "memory" ||
        arg === "commands" ||
        arg === "rewind"
      ) {
        command = arg;
        continue;
      }
      return { ok: false, error: `未知命令「${arg}」（支持 run / exec / mcp / sessions / memory / commands / rewind，用 --help 查看用法）` };
    }
    promptParts.push(arg);
  }

  if (command === null) {
    return { ok: false, error: "缺少命令（用 run、exec、mcp、sessions、memory、commands 或 rewind）" };
  }

  /**
   * `sessions`：只列存档，不调模型。
   *
   * 与 run/exec 的选项在这里一律拒绝——静默忽略会让人以为 `--model` 之类
   * 能筛出「某个模型跑过的会话」，而它其实什么都没做。
   */
  if (command === "sessions") {
    if (promptParts.length > 0) {
      return { ok: false, error: "sessions 不接受位置参数（它只列会话；要看某一份用 run --resume）" };
    }
    const notForSessions: string[] = [];
    if (outputFormat === "stream-json") notForSessions.push("--output-format stream-json");
    if (allowDanger) notForSessions.push("--allow-danger");
    if (maxRounds !== undefined) notForSessions.push("--max-rounds");
    if (model !== undefined) notForSessions.push("--model");
    if (baseUrl !== undefined) notForSessions.push("--base-url");
    if (apiKey !== undefined) notForSessions.push("--api-key");
    if (continueSession) notForSessions.push("--continue");
    if (trustWorkspace) notForSessions.push("--trust-workspace");
    if (trustHooks) notForSessions.push("--trust-hooks");
  if (readOnly) notForSessions.push("--read-only");
  if (!memory) notForSessions.push("--no-memory");
  if (!subagent) notForSessions.push("--no-subagent");
  if (!keepRewind) notForSessions.push("--no-rewind");
  if (ask) notForSessions.push("--ask");
    if (contextBudget !== undefined) notForSessions.push("--context-budget");
    if (!compact) notForSessions.push("--no-compact");
    if (mcp) notForSessions.push("--mcp");
    if (resume !== undefined) notForSessions.push("--resume");
    if (notForSessions.length > 0) {
      return {
        ok: false,
        error: `sessions 不接 ${notForSessions.join(" / ")}（它只列存档，不跑模型也不接会话）`,
      };
    }
    return {
      ok: true,
      action: "sessions",
      options: {
        json,
        ...(cwd !== undefined ? { cwd } : {}),
        ...(sessionDir !== undefined ? { sessionDir } : {}),
      },
    };
  }

  /**
   * `memory`：直接读写工作区记忆（`.heming/memory.json`），不调模型。
   *
   * 为什么给人一条命令：模型记错一条时，用户得能一眼看见、能删。只把记忆留给模型
   * 自己管，等于把「它记错了什么」也藏起来了。
   */
  if (command === "memory") {
    const sub = promptParts[0];
    const rest = promptParts.slice(1).join(" ").trim();
    const notForMemory: string[] = [];
    if (outputFormat !== "text" && !json) notForMemory.push("--output-format");
    if (allowDanger) notForMemory.push("--allow-danger");
    if (readOnly) notForMemory.push("--read-only");
    if (ask) notForMemory.push("--ask");
    if (maxRounds !== undefined) notForMemory.push("--max-rounds");
    if (model !== undefined) notForMemory.push("--model");
    if (baseUrl !== undefined) notForMemory.push("--base-url");
    if (apiKey !== undefined) notForMemory.push("--api-key");
    if (continueSession) notForMemory.push("--continue");
    if (resume !== undefined) notForMemory.push("--resume");
    if (sessionDir !== undefined) notForMemory.push("--session-dir");
    if (mcp) notForMemory.push("--mcp");
    if (trustWorkspace) notForMemory.push("--trust-workspace");
    if (trustHooks) notForMemory.push("--trust-hooks");
    if (contextBudget !== undefined) notForMemory.push("--context-budget");
    if (!compact) notForMemory.push("--no-compact");
    if (!memory) notForMemory.push("--no-memory");
  if (!subagent) notForMemory.push("--no-subagent");
  if (!keepRewind) notForMemory.push("--no-rewind");
    if (notForMemory.length > 0) {
      return {
        ok: false,
        error: `memory 不接 ${notForMemory.join(" / ")}（它只读写 .heming/memory.json，不调模型）`,
      };
    }
    const base = { json, ...(cwd !== undefined ? { cwd } : {}) };
    if (sub === undefined) return { ok: true, action: "memory", options: base };
    if (sub === "add") {
      if (!rest) return { ok: false, error: "memory add 需要一句话（heming memory add \"以后都用中文回答\"）" };
      return { ok: true, action: "memory", options: { ...base, add: rest } };
    }
    if (sub === "forget") {
      if (!rest) return { ok: false, error: "memory forget 需要一条的 id 或序号（先跑 heming memory 看看）" };
      return { ok: true, action: "memory", options: { ...base, forget: rest } };
    }
    return { ok: false, error: `memory 只支持 list（默认）/ add / forget，收到「${sub}」` };
  }
  /**
   * `mcp serve`：把工具按 MCP 协议暴露给别的编辑器。
   *
   * 与 run/exec 的分工是刻意的：这条路**不调模型**，所以 `--model` / `--api-key` /
   * `--max-rounds` / 输出格式在这里一律拒绝——静默忽略会让用户以为某个开关生效了。
   */
  /**
   * `rewind`：只看/回退 `.heming/rewind/` 里记下的轮次，不调模型。
   *
   * 位置参数只有一个可选的轮数：省略 = 列出来看，给了数字 = 真的动手（会改文件）。
   * 不接受 `--json`：回退的结果是给人看的一句话，机器要读的话直接看 `.heming/rewind/*.json`。
   */
  if (command === "rewind") {
    if (json) return { ok: false, error: "rewind 不接受 --json（它要改文件；要看有哪些轮次直接读 .heming/rewind/*.json）" };
    if (promptParts.length > 1) {
      return { ok: false, error: "rewind 最多接一个数字（要退最近几轮），例如 heming rewind 2" };
    }
    const notForRewind: string[] = [];
    if (outputFormat !== "text") notForRewind.push("--output-format");
    if (allowDanger) notForRewind.push("--allow-danger");
    if (readOnly) notForRewind.push("--read-only");
    if (ask) notForRewind.push("--ask");
    if (maxRounds !== undefined) notForRewind.push("--max-rounds");
    if (model !== undefined) notForRewind.push("--model");
    if (baseUrl !== undefined) notForRewind.push("--base-url");
    if (apiKey !== undefined) notForRewind.push("--api-key");
    if (continueSession) notForRewind.push("--continue");
    if (resume !== undefined) notForRewind.push("--resume");
    if (sessionDir !== undefined) notForRewind.push("--session-dir");
    if (mcp) notForRewind.push("--mcp");
    if (trustWorkspace) notForRewind.push("--trust-workspace");
    if (trustHooks) notForRewind.push("--trust-hooks");
    if (contextBudget !== undefined) notForRewind.push("--context-budget");
    if (!compact) notForRewind.push("--no-compact");
    if (!memory) notForRewind.push("--no-memory");
    if (!subagent) notForRewind.push("--no-subagent");
    if (!keepRewind) notForRewind.push("--no-rewind");
    if (notForRewind.length > 0) {
      return {
        ok: false,
        error: `rewind 不接 ${notForRewind.join(" / ")}（它只读写 .heming/rewind/，不调模型也不改会话）`,
      };
    }
    const rawRuns = promptParts[0];
    let runs: number | undefined;
    if (rawRuns !== undefined) {
      if (!/^[0-9]+$/.test(rawRuns) || Number(rawRuns) < 1) {
        return { ok: false, error: `rewind 需要正整数（要退最近几轮），收到「${rawRuns}」` };
      }
      runs = Number(rawRuns);
    }
    return {
      ok: true,
      action: "rewind",
      options: { ...(runs !== undefined ? { runs } : {}), ...(cwd !== undefined ? { cwd } : {}) },
    };
  }

  /**
   * `commands`：只列 `.heming/commands/*.md`，不调模型。
   *
   * 与 sessions / memory 同一条口径：模型、会话、权限、危险工具这些选项一律拒绝，
   * 静默忽略会让人以为 `commands --cwd` 之外的开关也生效了。
   */
  if (command === "commands") {
    if (promptParts.length > 0) {
      return {
        ok: false,
        error: "commands 不接受位置参数（它只列命令；要用某条命令请写 heming run /名字）",
      };
    }
    const notForCommands: string[] = [];
    if (outputFormat !== "text" && !json) notForCommands.push("--output-format");
    if (allowDanger) notForCommands.push("--allow-danger");
    if (readOnly) notForCommands.push("--read-only");
    if (ask) notForCommands.push("--ask");
    if (maxRounds !== undefined) notForCommands.push("--max-rounds");
    if (model !== undefined) notForCommands.push("--model");
    if (baseUrl !== undefined) notForCommands.push("--base-url");
    if (apiKey !== undefined) notForCommands.push("--api-key");
    if (continueSession) notForCommands.push("--continue");
    if (resume !== undefined) notForCommands.push("--resume");
    if (sessionDir !== undefined) notForCommands.push("--session-dir");
    if (mcp) notForCommands.push("--mcp");
    if (trustWorkspace) notForCommands.push("--trust-workspace");
    if (trustHooks) notForCommands.push("--trust-hooks");
    if (contextBudget !== undefined) notForCommands.push("--context-budget");
    if (!compact) notForCommands.push("--no-compact");
    if (!memory) notForCommands.push("--no-memory");
    if (!subagent) notForCommands.push("--no-subagent");
    if (!keepRewind) notForCommands.push("--no-rewind");
    if (notForCommands.length > 0) {
      return {
        ok: false,
        error: `commands 不接 ${notForCommands.join(" / ")}（它只列工作区里的自定义命令，不跑模型）`,
      };
    }
    return {
      ok: true,
      action: "commands",
      options: { json, ...(cwd !== undefined ? { cwd } : {}) },
    };
  }

  if (command === "mcp") {
    const sub = promptParts[0];
    if (sub !== "serve") {
      return { ok: false, error: `mcp 只支持 serve 子命令（heming mcp serve）${sub ? `，收到「${sub}」` : ""}` };
    }
    if (promptParts.length > 1) {
      return { ok: false, error: "mcp serve 不接受多余的位置参数（它从 stdin 读协议消息，不读 prompt）" };
    }
    const notForMcp: string[] = [];
    if (json) notForMcp.push("--json");
    if (outputFormat !== "text") notForMcp.push("--output-format");
    if (maxRounds !== undefined) notForMcp.push("--max-rounds");
    if (model !== undefined) notForMcp.push("--model");
    if (baseUrl !== undefined) notForMcp.push("--base-url");
    if (apiKey !== undefined) notForMcp.push("--api-key");
    if (continueSession) notForMcp.push("--continue");
    if (resume !== undefined) notForMcp.push("--resume");
    if (sessionDir !== undefined) notForMcp.push("--session-dir");
    if (mcp) notForMcp.push("--mcp");
  if (ask) notForMcp.push("--ask");
    if (contextBudget !== undefined) notForMcp.push("--context-budget");
    if (!compact) notForMcp.push("--no-compact");
    if (!memory) notForMcp.push("--no-memory");
  if (!subagent) notForMcp.push("--no-subagent");
    if (notForMcp.length > 0) {
      return {
        ok: false,
        error: `mcp serve 不接 ${notForMcp.join(" / ")}（它不调模型，只把文件工具按 MCP 协议暴露出去）`,
      };
    }
    return {
      ok: true,
      action: "mcp",
      options: { allowDanger, readOnly, trustWorkspace, trustHooks, ...(cwd !== undefined ? { cwd } : {}) },
    };
  }

  const rawPrompt = promptParts.join(" ").trim();
  // `-` 表示「指令从 stdin 读」：CI 里最常见的是 `git diff | heming exec -`。
  const fromStdin = rawPrompt === "-";
  const prompt = fromStdin ? "" : rawPrompt;
  if (ask && fromStdin) {
    return {
      ok: false,
      error:
        "--ask 不能和 `run -` 一起用：审批要从 stdin 读你的回答，而 `run -` 的提示词也从 stdin 来。把提示词直接写在命令行上，或去掉 --ask。",
    };
  }
  if (!prompt && !fromStdin) {
    return { ok: false, error: `${command} 缺少 prompt（要执行的指令；也可以写 - 从 stdin 读）` };
  }
  if (command === "run" && json) {
    return { ok: false, error: "run 不支持 --json；需要机器可读结果请用 exec --json（要事件流用 --output-format stream-json）" };
  }
  if (continueSession && resume !== undefined) {
    return { ok: false, error: "--continue 与 --resume 只能选一个：前者接「这个目录下最近一次」，后者接指定会话" };
  }

  return {
    ok: true,
    action: "run",
    options: {
      command,
      prompt,
      outputFormat,
      json,
      fromStdin,
      allowDanger,
      readOnly,
      ask,
      trustWorkspace,
      trustHooks,
      compact,
      memory,
      subagent,
      rewind: keepRewind,
      mcp,
      continueSession,
      ...(cwd !== undefined ? { cwd } : {}),
      ...(maxRounds !== undefined ? { maxRounds } : {}),
      ...(contextBudget !== undefined ? { contextBudget } : {}),
      ...(model !== undefined ? { model } : {}),
      ...(baseUrl !== undefined ? { baseUrl } : {}),
      ...(apiKey !== undefined ? { apiKey } : {}),
      ...(resume !== undefined ? { resume } : {}),
      ...(sessionDir !== undefined ? { sessionDir } : {}),
    },
  };
}
