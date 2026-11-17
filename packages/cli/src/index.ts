#!/usr/bin/env node
/**
 * `@heming/cli` 的入口：只做 I/O（argv/env/stdout/stderr/SIGINT/退出码）。
 *
 * 解析在 `args.ts`（纯函数），模型配置在 `config.ts`，运行在 `run.ts`。
 * 这条边界是刻意的：参数与配置错误（退出码 2）必须在加载真实模型/工具之前判定，
 * 否则用户只会看到半截堆栈——CLI 最常见的第一次体验就是「key 没配」。
 */

import { readFileSync, statSync } from "node:fs";
import path from "node:path";
import { parseArgs } from "./args.js";
import { resolveModelConfig } from "./config.js";
import { createEventSink } from "./events.js";
import { outcomeExitCode, startAgentRun } from "./run.js";
import { readPromptFromStdin } from "./stdin.js";
import { MAX_TOOL_ROUNDS } from "../../../packages/web/src/lib/agentStream.js";
import type { LlmProfile } from "../../../packages/web/src/store/llm.js";

const USAGE = `用法：
  heming run [选项] <prompt...>              跑一轮，最终回答流式写到 stdout
  heming run - [选项]                        指令从 stdin 读（git diff | heming run -）
  heming exec [--json | --output-format stream-json] [选项] <prompt...>
                                             非交互执行；--json 时 stdout 只有一个 JSON 对象，
                                             stream-json 时 stdout 每行一条事件
  heming --version | --help

常用选项：
  --cwd <dir>          工作目录（也是唯一可写根），默认当前目录
  --max-rounds <n>     最多允许 n 个工具轮；第 n+1 轮还要调工具就提前收口
  --allow-danger       允许 run_command 等危险工具（默认拒绝）
  --output-format <f>  stdout 格式：text（默认）/ json（exec 专用）/ stream-json（事件流）
  --model <id>         模型 id（默认 gpt-4o-mini）
  --base-url <url>     OpenAI 兼容端点（默认 https://api.openai.com/v1）
  --api-key <key>      API Key（优先于环境变量）

环境变量（优先级：命令行 > HEMING_* > OPENAI_*）：
  HEMING_API_KEY / OPENAI_API_KEY          必填
  HEMING_BASE_URL / OPENAI_BASE_URL        可选
  HEMING_MODEL / OPENAI_MODEL              可选

退出码：0 成功；1 运行失败；2 用法或配置错误；130 Ctrl+C 中断。`;

const HELP = `@heming/cli —— 和鸣的无头智能体循环

${USAGE}

能力边界：
  - 内置文件工具（file_read / file_write / file_edit / file_patch / file_glob /
    file_grep / file_image / file_undo）、todo_write、tool_output_read；
  - run_command 仅在 --allow-danger 时提供，且每条命令都会真的执行；
  - 不接 MCP、不接联网搜索、没有人工确认（无人值守时「问」一律按拒绝处理）。

机器可读输出：
  heming exec --json ...                  stdout 恰好一个 JSON 对象（跑完才输出）
  heming exec --output-format stream-json ...  stdout 每行一条事件：start / round /
                                        delta / tool_start / tool_end / retry / final
  heming exec -                          指令从 stdin 读（git diff | heming exec -）

示例：
  pnpm cli "读一下 README 并总结三句话"
  pnpm cli exec --json "把 src 下的 TODO 列出来"
  HEMING_API_KEY=sk-... pnpm cli --allow-danger "跑一下测试并修掉失败"

说明：
  - run 的 stdout 只放模型最终回答；进度/工具轨迹在 stderr。
  - exec --json 的 JSON 契约与字段说明见 packages/cli/README.md。`;

/** 从包自己的 package.json 读版本：避免手写常量与 monorepo 版本号漂移。 */
function readVersion(): string {
  try {
    const raw = readFileSync(new URL("../package.json", import.meta.url), "utf8");
    const parsed = JSON.parse(raw) as { version?: unknown };
    return typeof parsed.version === "string" ? parsed.version : "0.0.0";
  } catch {
    return "0.0.0";
  }
}

function writeErr(text: string): void {
  process.stderr.write(text);
}

async function main(argv: string[]): Promise<number> {
  const parsed = parseArgs(argv);
  if (!parsed.ok) {
    writeErr(`heming: ${parsed.error}\n\n${USAGE}\n`);
    return 2;
  }
  if (parsed.action === "help") {
    process.stdout.write(`${HELP}\n`);
    return 0;
  }
  if (parsed.action === "version") {
    process.stdout.write(`@heming/cli ${readVersion()}\n`);
    return 0;
  }

  const options = parsed.options;
  const streamMode = options.outputFormat === "stream-json";
  const sink = streamMode ? createEventSink((chunk) => process.stdout.write(chunk)) : null;
  /** 运行前的用法/配置错误：stream-json 模式下也给一条机器可读的事件。 */
  const failEarly = (message: string): number => {
    writeErr(`heming: ${message}\n`);
    sink?.emit({ type: "error", message });
    return 2;
  };

  // `-` 表示指令来自 stdin：CI 里最常用的是 `git diff | heming exec -`。
  let prompt = options.prompt;
  if (options.fromStdin) {
    const read = await readPromptFromStdin();
    if (!read.ok) return failEarly(read.error);
    prompt = read.text.trim();
    if (!prompt) return failEarly("从 stdin 没有读到内容（prompt 为空）");
  }

  const cwd = path.resolve(options.cwd ?? process.cwd());
  try {
    if (!statSync(cwd).isDirectory()) {
      return failEarly(`--cwd 不是目录：${cwd}`);
    }
  } catch {
    return failEarly(`--cwd 目录不存在：${cwd}`);
  }

  const resolved = resolveModelConfig(options);
  if (!resolved.ok) {
    return failEarly(resolved.error);
  }
  const profile: LlmProfile = {
    id: "cli",
    label: `CLI · ${resolved.config.model}`,
    provider: "openai",
    baseUrl: resolved.config.baseUrl,
    apiKey: resolved.config.apiKey,
    model: resolved.config.model,
    temperature: 0,
  };

  const jsonMode = options.outputFormat === "json";
  sink?.emit({
    type: "start",
    command: options.command,
    cwd,
    maxRounds: options.maxRounds ?? MAX_TOOL_ROUNDS,
    allowDanger: options.allowDanger,
  });
  /** 已写出的最后一个字符：结束后补换行用（回答本身不一定以换行结尾）。 */
  let lastChar = "";
  const handle = startAgentRun({
    prompt,
    cwd,
    profile,
    allowDanger: options.allowDanger,
    ...(options.maxRounds !== undefined ? { maxRounds: options.maxRounds } : {}),
    ...(jsonMode
      ? {}
      : {
          onStdout: (chunk: string) => {
            if (sink) {
              // 事件流模式：回答增量也走事件，不往 stdout 写裸文本（否则按行解析会坏）。
              sink.emit({ type: "delta", text: chunk });
              return;
            }
            // stdout 只放最终回答；进度行全部走 stderr（见 onProgress）。
            lastChar = chunk.slice(-1);
            process.stdout.write(chunk);
          },
        }),
    ...(sink ? { onEvent: (event) => sink.emit(event) } : {}),
    onProgress: (line) => writeErr(`${line}\n`),
  });

  let interrupted = false;
  const onSigint = () => {
    if (interrupted) {
      // 第二次 Ctrl+C：用户明确不想等收尾了。直接按中断退出。
      process.exit(130);
    }
    interrupted = true;
    writeErr("\n[heming] 收到 Ctrl+C，正在停止（再按一次强制退出）…\n");
    handle.abortAll();
  };
  process.on("SIGINT", onSigint);

  let outcome;
  try {
    outcome = await handle.done;
  } finally {
    process.off("SIGINT", onSigint);
  }

  const result = interrupted
    ? { ...outcome.json, ok: false, error: "已中断（Ctrl+C）" }
    : outcome.json;
  if (sink) {
    // 事件流：收尾也发事件，消费方不必靠退出码猜「是不是跑完了」。
    sink.emit({ type: "final", result });
  } else if (jsonMode) {
    // 契约：stdout 恰好一个 JSON 对象。即使被中断也照常输出，机器侧能拿到已发生的事实。
    process.stdout.write(`${JSON.stringify(result)}\n`);
  } else if (lastChar && lastChar !== "\n") {
    process.stdout.write("\n");
  }

  const summary = interrupted
    ? "已中断"
    : outcome.json.ok
      ? "完成"
      : `失败：${outcome.json.error ?? "未知原因"}`;
  writeErr(
    `[heming] ${summary}：${outcome.json.rounds} 轮模型调用，` +
      `${outcome.json.toolCalls.length} 次工具调用，写入 ${outcome.json.writes.length} 个文件，` +
      `用时 ${(outcome.json.durationMs / 1000).toFixed(1)}s\n`,
  );

  return outcomeExitCode(outcome, interrupted);
}

// 顶层只做「拿到退出码并设置」：不调用 process.exit，让还没来得及 flush 的 stdout 写完。
// （CI 里 stdout 常是管道，process.exit 可能截断最后一段 JSON。）
main(process.argv.slice(2)).then(
  (code) => {
    process.exitCode = code;
  },
  (error) => {
    // 意料之外的异常：给一句人话 + 错误信息，不给半截堆栈。
    writeErr(`heming: 未预期的错误：${error instanceof Error ? error.message : String(error)}\n`);
    process.exitCode = 1;
  },
);
