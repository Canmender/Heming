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
  model?: string;
  baseUrl?: string;
  apiKey?: string;
}

export interface McpOptions {
  /** 显式给出的工作目录；缺省由 index 用 `process.cwd()` 兜底。 */
  cwd?: string;
  /** 放行 `run_command`（MCP 客户端能调用它真跑命令）。 */
  allowDanger: boolean;
}

export type ParsedArgs =
  | { ok: true; action: "help" }
  | { ok: true; action: "version" }
  | { ok: true; action: "run"; options: PromptOptions }
  | { ok: true; action: "mcp"; options: McpOptions }
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
  let command: "run" | "exec" | "mcp" | null = null;
  let json = false;
  let outputFormat: "text" | "json" | "stream-json" = "text";
  let allowDanger = false;
  let cwd: string | undefined;
  let maxRounds: number | undefined;
  let model: string | undefined;
  let baseUrl: string | undefined;
  let apiKey: string | undefined;
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
        case "cwd":
        case "max-rounds":
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
          else {
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
      if (arg === "run" || arg === "exec" || arg === "mcp") {
        command = arg;
        continue;
      }
      return { ok: false, error: `未知命令「${arg}」（支持 run / exec / mcp，用 --help 查看用法）` };
    }
    promptParts.push(arg);
  }

  if (command === null) {
    return { ok: false, error: "缺少命令（用 run、exec 或 mcp）" };
  }

  /**
   * `mcp serve`：把工具按 MCP 协议暴露给别的编辑器。
   *
   * 与 run/exec 的分工是刻意的：这条路**不调模型**，所以 `--model` / `--api-key` /
   * `--max-rounds` / 输出格式在这里一律拒绝——静默忽略会让用户以为某个开关生效了。
   */
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
    if (notForMcp.length > 0) {
      return {
        ok: false,
        error: `mcp serve 不接 ${notForMcp.join(" / ")}（它不调模型，只把文件工具按 MCP 协议暴露出去）`,
      };
    }
    return { ok: true, action: "mcp", options: { allowDanger, ...(cwd !== undefined ? { cwd } : {}) } };
  }

  const rawPrompt = promptParts.join(" ").trim();
  // `-` 表示「指令从 stdin 读」：CI 里最常见的是 `git diff | heming exec -`。
  const fromStdin = rawPrompt === "-";
  const prompt = fromStdin ? "" : rawPrompt;
  if (!prompt && !fromStdin) {
    return { ok: false, error: `${command} 缺少 prompt（要执行的指令；也可以写 - 从 stdin 读）` };
  }
  if (command === "run" && json) {
    return { ok: false, error: "run 不支持 --json；需要机器可读结果请用 exec --json（要事件流用 --output-format stream-json）" };
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
      ...(cwd !== undefined ? { cwd } : {}),
      ...(maxRounds !== undefined ? { maxRounds } : {}),
      ...(model !== undefined ? { model } : {}),
      ...(baseUrl !== undefined ? { baseUrl } : {}),
      ...(apiKey !== undefined ? { apiKey } : {}),
    },
  };
}
