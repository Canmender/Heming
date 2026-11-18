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
import { startMcpServe } from "./mcpServe.js";
import { collectCliProjectRules, describeCliProjectRules } from "./projectRules.js";
import { outcomeExitCode, startAgentRun } from "./run.js";
import { describeCliWorkspaceRules, loadCliWorkspaceRules } from "./workspaceRules.js";
import { describeCliContext } from "./contextBudget.js";
import { createCliHookRunner, describeCliHooks, loadCliHooks } from "./toolHooks.js";
import { APPROVAL_ANSWER_HINTS, createTerminalApprover } from "./approvals.js";
import { describeCliCommandUse, describeCliCommands, loadCliCommands, parseCliCommandInvocation, resolveCliCommand, summarizeCliCommands } from "./commands.js";
import {
  addCliMemory,
  describeCliMemory,
  loadCliMemory,
  memoryPath,
  memorySection,
  recallCliMemory,
  removeCliMemory,
} from "./memory.js";
import { MCP_CLIENT_CONFIG_FILE, connectMcpServer, loadMcpServers, mcpToolName, type McpConnection } from "./mcpClient.js";
import {
  appendTurn,
  describeSession,
  latestSession,
  listSessions,
  newSessionId,
  resolveSession,
  sessionDir,
  summarize,
  toHistory,
  writeSession,
  type SessionRecord,
} from "./sessions.js";
import { readPromptFromStdin } from "./stdin.js";
import { MAX_TOOL_ROUNDS } from "../../../packages/web/src/lib/agentStream.js";
import type { LlmProfile } from "../../../packages/web/src/store/llm.js";

const USAGE = `用法：
  heming run [选项] <prompt...>              跑一轮，最终回答流式写到 stdout
  heming run - [选项]                        指令从 stdin 读（git diff | heming run -）
  heming exec [--json | --output-format stream-json] [选项] <prompt...>
                                             非交互执行；--json 时 stdout 只有一个 JSON 对象，
                                             stream-json 时 stdout 每行一条事件
  heming mcp serve [--cwd <dir>] [--allow-danger]
                                             按 MCP（Model Context Protocol）把文件工具
                                             暴露给别的编辑器：协议消息走 stdin/stdout
  heming sessions [--json] [--cwd <dir>]     列出本机的会话存档（id / 时间 / 条数 / 最后一句）
  heming memory [list | add <一句话> | forget <id 或序号>]
                                             看 / 加 / 删这个工作区的长期记忆
  heming commands [--json] [--cwd <dir>]     列出 .heming/commands/*.md 里的自定义命令
  heming --version | --help

常用选项：
  --cwd <dir>          工作目录（也是唯一可写根），默认当前目录
  --max-rounds <n>     最多允许 n 个工具轮；第 n+1 轮还要调工具就提前收口
  --allow-danger       允许 run_command 等危险工具（默认拒绝）
  --read-only          只读模式：除读取类工具外一律不执行（写、删、命令都拦住）
  --ask                危险调用（命令 / MCP 工具）先在终端问一句（需要真终端）
  --trust-workspace    让 .heming/permissions.json 里的 allow 规则生效（deny / ask 总是生效）
  --trust-hooks        允许执行 .heming/hooks.json 里的本机检查（默认只读配置、不执行）
  --mcp                连上 .heming/mcp.json 里声明的 MCP 服务（工具还要 --allow-danger 才真能用）
  --context-budget <n> 续聊历史的 token 预算（默认 12000），超出就把早期对话折成摘要
  --no-compact         不折叠历史：整段发给模型（会更快烧钱，也更早撞上下文上限）
  --no-memory          不读写 .heming/memory.json（既不注入召回，也不提供 remember 工具）
  --no-subagent        不给 agent_task：查证类任务只能自己翻，省一次模型调用
  --output-format <f>  stdout 格式：text（默认）/ json（exec 专用）/ stream-json（事件流）
  --continue           接着这个目录下最近一次会话聊（等价于 --resume 最近一条）
  --resume <id>        接着指定会话聊（支持唯一前缀，id 从 heming sessions 看）
  --session-dir <dir>  会话存档目录（默认 ~/.heming/cli-sessions）
  --model <id>         模型 id（默认 gpt-4o-mini）
  --base-url <url>     OpenAI 兼容端点（默认 https://api.openai.com/v1）
  --api-key <key>      API Key（优先于环境变量）

环境变量（优先级：命令行 > HEMING_* > OPENAI_*）：
  HEMING_API_KEY / OPENAI_API_KEY          必填
  HEMING_BASE_URL / OPENAI_BASE_URL        可选
  HEMING_MODEL / OPENAI_MODEL              可选
  HEMING_CLI_SESSION_DIR                   可选（会话存档目录，同 --session-dir）

退出码：0 成功（mcp serve 在 stdin 关闭后也返回 0）；1 运行失败；2 用法或配置错误；130 Ctrl+C 中断。`;

const HELP = `@heming/cli —— 和鸣的无头智能体循环

${USAGE}

能力边界：
  - 内置文件工具（file_read / file_write / file_edit / file_patch / file_glob /
    file_grep / file_image / file_undo）、todo_write、tool_output_read；
  - run_command 仅在 --allow-danger 时提供，且每条命令都会真的执行；
  - 不调外部模型的一条路：heming mcp serve 只把工具按 MCP 协议暴露出去，不替你思考；
  - 反方向：--mcp 让我们自己当 MCP 客户端，把工作区 .heming/mcp.json 里的服务工具接进来；
  - 不接联网搜索、没有人工确认（无人值守时「问」一律按拒绝处理）。

MCP 服务（给别的编辑器用）：
  heming mcp serve --cwd <dir>            stdio JSON-RPC，支持 initialize / ping /
                                          tools/list / tools/call；stdout 只放协议消息，
                                          诊断信息走 stderr；不加 --allow-danger 就没有
                                          run_command（调了回「未执行」）。

会话（接着上次聊）：
  heming run --continue "接着刚才那步继续"   接这个工作目录下最近一次会话
  heming run --resume 20261118-144230-ab12 "继续"  接指定会话（支持唯一前缀）
  heming sessions                         看有哪些会话（id / 时间 / 条数 / 最后一句）
  说明：存档只含文字问答（不含工具调用），默认放在 ~/.heming/cli-sessions/；
        用 --session-dir 或 HEMING_CLI_SESSION_DIR 换目录。
        --continue 优先接同一工作目录的最近一次，没有才退到全局最近一次。

机器可读输出：
  heming exec --json ...                  stdout 恰好一个 JSON 对象（跑完才输出）
  heming exec --output-format stream-json ...  stdout 每行一条事件：start / round /
                                        delta / tool_start / tool_end / retry / final
  heming exec -                          指令从 stdin 读（git diff | heming exec -）

示例：
  pnpm cli "读一下 README 并总结三句话"
  pnpm cli exec --json "把 src 下的 TODO 列出来"
  HEMING_API_KEY=sk-... pnpm cli --allow-danger "跑一下测试并修掉失败"
  heming mcp serve --cwd .               让 Cursor / Claude Code 之类的客户端通过 MCP
                                         调用本机的文件工具（不需要模型凭据）
  pnpm cli --continue "把刚才那两个失败用例修掉"
  pnpm cli --resume 20261118-144230-ab12 "继续"
  pnpm cli --trust-workspace "按仓库里的权限规则跑，别改 docs/"
  pnpm cli --trust-hooks "按仓库里的钩子检查跑，改完 generated 前会被拦住"
  pnpm cli --read-only "先只看不改：这套代码哪里会出问题"
  pnpm cli --ask "跑一下测试；每一步命令我都想先看一眼"
  pnpm cli --continue --context-budget 4000 "接着聊，历史只留最近一小段"
  pnpm cli --continue --no-compact "把整段历史原样发给模型"

工作区权限规则（.heming/permissions.json，与桌面端同一份）：
  {"deny":[{"tool":"run_command","command":"git push*"}]}   仓库里写了就一定生效
  {"ask":[{"tool":"file_write","path":"docs/**"}]}           CLI 没有人可以确认，落成拒绝
  {"allow":[{"tool":"file_write","path":"src/**"}]}         只在 --trust-workspace 时生效
  文件坏了（JSON 解析失败）就不启动：宁可当场说清楚，也不要跑几轮再被全拒。

工作区钩子（.heming/hooks.json，与桌面端同一份）：
  {"hooks":[{"tool":"file_write","path":"generated/**","command":"node scripts/no-generated.js"}]}
  命中的工具调用会先跑这条本机命令；命令末尾会追加 payload JSON 的路径作为第一个参数。
  退出码 0 放行、2 拒绝（取 stdout/stderr 第一行作原因）、其它一律拒绝；超时也算拒绝。
  默认**不执行**：配置跟着仓库走，克隆一个陌生仓库不该让它的脚本自动在你机器上跑，
  要真的生效必须显式加 --trust-hooks。

只读模式（--read-only）：
  除了读文件、搜代码、看目录，其它工具（写、删、打补丁、跑命令）一律不执行。
  被拒的调用会回一句「CLI 以只读模式运行」，模型会转而把改动写成说明交回来。
  它的作用范围比权限规则更靠前：即使仓库写了 allow、即使同时给了 --allow-danger，
  也只读。适合「先让它看看、别动手」和 CI 里的预演。

续聊的上下文预算（--context-budget / --no-compact）：
  --continue / --resume 会把上次会话的文字问答带进来，最多可有 200 轮。
  默认按 12000 tokens 给历史留预算：放不下时把**早期**对话折成三段摘要
  （意图 / 结论 / 待办），最近的原文照旧保留；摘要由程序生成，不额外调模型。
  折了会打一行「上下文：折叠了 N 条早期对话」；--no-compact 则整段原样发送。
  真的撞上供应商的上下文上限时，会自动收紧一次预算重试（最多两级）。

工作区自定义命令（.heming/commands/*.md，与桌面端的 /名字 同一批文件）：
  文件名就是命令名（小写字母开头，可带数字和短横线），正文就是提示词；
  第一行可以写 # 标题，紧跟的第二行可以写 > 说明。
  heming run /review                    这一行会被换成 review.md 的正文
  heming run /review src/login.ts       命令行上的补充说明会接在正文之后
  heming commands                       看这个工作区有哪些命令（--json 给脚本用）
  形状像命令但没定义会直接报错并列出可用的，不会把 /reviwe 这种原样发给模型。

工作区记忆（.heming/memory.json）：
  模型可以用 remember 工具把「以后都该记得的事」记下来（偏好、约定、踩过的坑），
  下次运行会按你的提问自动挑几条相关的接在提示词里。
  heming memory                          看记了些什么（带序号，能直接删）
  heming memory add "以后都用中文回答"      手动加一条
  heming memory forget 2                  删掉序号 2（也认完整 id）
  --no-memory 关掉两头；记忆文件坏了不会让运行失败，只会说一句并且这次不写。

  子代理（agent_task）：
    模型可以派一个**只读**子代理去仓库里查证（它能 file_read / file_glob / file_grep /
    file_image / tool_output_read，不能写、不能跑命令），只把结论交回来。查证类工作最吃上下文，
    让它在外面翻完再回来，主对话就不必塞进几百行搜到的原文。
    --no-subagent 关掉它；子代理的模型调用同样计入 exec --json 的 rounds 与用量。

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

/** 比较两个工作目录是否同一个：统一正斜杠、去末尾斜杠，Windows 下忽略大小写。 */
function memPathOf(cwd: string): string {
  return memoryPath(cwd);
}

function normalizeCwd(value: string): string {
  const resolved = path.resolve(value.trim() || ".").replace(/\\/g, "/").replace(/\/+$/, "");
  return process.platform === "win32" ? resolved.toLowerCase() : resolved;
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

  /**
   * `sessions`：只读存档目录。
   *
   * 空目录不是错误：第一次用的人正是最需要看「还没有会话」这句话的时候，
   * 所以给一句怎么产生第一条的提示，退出码仍是 0。
   */
  if (parsed.action === "sessions") {
    const dir = sessionDir(parsed.options.sessionDir);
    const records = await listSessions(dir);
    const cwdFilter = parsed.options.cwd;
    const filtered = cwdFilter
      ? records.filter((record) => normalizeCwd(record.cwd) === normalizeCwd(cwdFilter))
      : records;
    if (parsed.options.json) {
      process.stdout.write(`${JSON.stringify(filtered.map(summarize), null, 2)}\n`);
      return 0;
    }
    if (filtered.length === 0) {
      const scope = cwdFilter ? `这个目录（${cwdFilter}）下` : "本机";
      writeErr(`[heming] ${scope}还没有会话存档（目录：${dir}）。跑一次 heming run 就会有一份。\n`);
      return 0;
    }
    process.stdout.write(`[heming] 会话存档（目录：${dir}，共 ${filtered.length} 条）：\n`);
    for (const record of filtered) {
      process.stdout.write(`${describeSession(record)}\n`);
    }
    return 0;
  }

  /**
   * `memory`：直接读写工作区的 `.heming/memory.json`，不调模型。
   *
   * 为什么给人一条命令：模型记错一条时用户得能一眼看见、能删。只把记忆交给模型
   * 自己管，等于把「它记错了什么」也一起藏起来。
   */
  if (parsed.action === "memory") {
    const memCwd = path.resolve(parsed.options.cwd ?? process.cwd());
    if (parsed.options.add !== undefined) {
      const added = await addCliMemory(memCwd, parsed.options.add);
      if (!added.ok) {
        writeErr(`heming: ${added.error}\n`);
        return 1;
      }
      writeErr(
        added.added
          ? `[heming] 记下了（${memPathOf(memCwd)}，现在 ${added.total} 条）：${added.entry.text}\n`
          : `[heming] 这句已经记过了，没有重复写（共 ${added.total} 条）：${added.entry.text}\n`,
      );
      return 0;
    }
    if (parsed.options.forget !== undefined) {
      const removed = await removeCliMemory(memCwd, parsed.options.forget);
      if (!removed.ok) {
        writeErr(`heming: ${removed.error}\n`);
        return 1;
      }
      writeErr(`[heming] 删掉了：${removed.entry.text}（还剩 ${removed.total} 条）\n`);
      return 0;
    }
    const loaded = await loadCliMemory(memCwd);
    if (!loaded) {
      writeErr(
        `[heming] 这个工作区还没有记过任何东西（${memPathOf(memCwd)} 还不存在）。` +
          " 让它在跑的过程中调 remember，或直接 heming memory add \"…\"。\n",
      );
      return 0;
    }
    if (!loaded.ok) {
      writeErr(`heming: 记忆读不出来：${loaded.error}（${loaded.source}）\n`);
      return 1;
    }
    if (loaded.entries.length === 0) {
      writeErr(`[heming] 记忆文件是空的（${loaded.source}）。\n`);
      return 0;
    }
    process.stdout.write(`[heming] 工作区记忆（${loaded.source}，共 ${loaded.entries.length} 条，新的在最后）：\n`);
    loaded.entries.forEach((entry, index) => {
      process.stdout.write(`${String(index + 1).padStart(3)}  ${entry.at}  ${entry.id}\n     ${entry.text}\n`);
    });
    process.stdout.write("删除：heming memory forget <序号或 id>\n");
    return 0;
  }
  // `commands` 也只读盘、不调模型：列出工作区里的自定义命令。
  if (parsed.action === "commands") {
    const cwd = path.resolve(parsed.options.cwd ?? process.cwd());
    const loaded = await loadCliCommands(cwd);
    if (loaded && !loaded.ok) {
      writeErr(`heming: 命令目录读不出来：${loaded.error}（${loaded.source}）\n`);
      return 1;
    }
    if (parsed.options.json) {
      process.stdout.write(`${JSON.stringify(summarizeCliCommands(loaded?.commands ?? []))}\n`);
      return 0;
    }
    process.stdout.write(`${describeCliCommands(loaded, cwd)}\n`);
    return 0;
  }
  // `mcp serve` 不调模型：它只把文件工具按 MCP 协议暴露给别的编辑器，所以走单独的装配。
  if (parsed.action === "mcp") {
    return startMcpServe(parsed.options, {
      stdin: process.stdin,
      stdout: process.stdout,
      stderr: process.stderr,
      version: readVersion(),
    });
  }

  const options = parsed.options;
  const streamMode = options.outputFormat === "stream-json";
  /**
   * 只读模式与 `--allow-danger` 同时给时只读赢，但要明说一句：
   * 用户以为自己放行了命令，实际一条都没跑，静默忽略比报错更让人困惑。
   */
  if (options.readOnly && options.allowDanger) {
    writeErr("[heming] --read-only 优先：危险工具仍然不会执行（--allow-danger 这次被忽略）。\n");
  }

  const sink = streamMode ? createEventSink((chunk) => process.stdout.write(chunk)) : null;
  /**
   * `--mcp` 连上的子进程。
   *
   * 必须声明在 failEarly 之前：MCP 子进程挂在 stdio 管道上，只要它们还活着，
   * 父进程就不会退出。中途因为「没配模型」「--continue 没找到会话」之类失败时，
   * failEarly 要负责把已经连上的连接全部关掉，否则终端会一直挂着等 Ctrl+C。
   */
  const mcpConnections: McpConnection[] = [];
  const closeMcpConnections = (): void => {
    for (const connection of mcpConnections) {
      try {
        connection.close();
      } catch {
        // 对方已经退了：这里只求不留孤儿进程。
      }
    }
  };

  /** 运行前的用法/配置错误：stream-json 模式下也给一条机器可读的事件。 */
  const failEarly = (message: string): number => {
    writeErr(`heming: ${message}\n`);
    sink?.emit({ type: "error", message });
    closeMcpConnections();
    return 2;
  };
  /*
   * `--ask` 要真的有人在终端前面：审批从 stdin 读回答，而 stdin 是管道时
   * 下一行可能是脚本的输入（`run -` 的提示词、CI 的数据），把那些当成「y」
   * 就等于自动批准一切。所以非终端直接拒绝启动，而不是退化成默认拒绝。
   */
  if (options.ask && !process.stdin.isTTY) {
    return failEarly(
      "--ask 需要真正的终端：当前 stdin 不是 TTY（管道、CI、重定向）。去掉 --ask（危险调用会一律拒绝），或改用 --allow-danger 显式放行。",
    );
  }
  const approver = options.ask ? createTerminalApprover({ input: process.stdin, output: process.stderr }) : null;
  if (approver) {
    writeErr(`[heming] 审批已开启：${APPROVAL_ANSWER_HINTS}\n`);
  }

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

  /*
   * 工作区自定义命令（d.333）：`heming run /review src/login.ts` 把这一行换成命令正文，
   * 命令行上的尾巴接在后面。形状像命令但工作区里没有定义时直接不启动——`/reviwe`
   * 多半是打错了，把它原样发给模型只会让它对着一个陌生词瞎猜。
   *
   * 抄下展开之前的那一行：记忆召回要按「用户真正说了什么」去捞，而不是按命令正文
   * （正文可能四千字，会把打分全带偏）。
   */
  const rawPrompt = prompt;
  const commandInvocation = parseCliCommandInvocation(prompt);
  if (commandInvocation !== null) {
    const loadedCommands = await loadCliCommands(cwd);
    if (loadedCommands && !loadedCommands.ok) {
      return failEarly(`命令目录读不出来：${loadedCommands.error}（${loadedCommands.source}）`);
    }
    const resolved = resolveCliCommand(commandInvocation, loadedCommands?.commands ?? []);
    if (!resolved.ok) return failEarly(resolved.error);
    prompt = resolved.prompt;
    writeErr(`[heming] ${describeCliCommandUse(resolved.command, commandInvocation.args)}\n`);
  }

  /**
   * 会话存档：`--resume <id>` / `--continue` 决定接哪一份，都没给就是新会话。
   *
   * 读存档不往外抛（sessions.ts 全部 try-catch）：接不上最多等于回到单轮模式，
   * 但 `--resume` 写错了要当场说清楚，否则用户会以为上下文进去了。
   */
  /**
   * 工作区权限规则：`.heming/permissions.json`，与桌面端认的是同一份文件。
   *
   * 三种口径：
   * - deny / ask 一定生效（ask 在这里落成拒绝——CLI 没有人可以确认）；
   * - allow 只在 `--trust-workspace` 时生效（克隆来的仓库不能自己放宽权限）；
   * - 读到了但内容坏了 → 当场不启动：这里没人能确认，让模型白跑几轮再在第一次工具调用被全拒，
   *   比现在说清楚更糟。
   */
  const rulesLoad = await loadCliWorkspaceRules(cwd, options.trustWorkspace);
  if (rulesLoad && !rulesLoad.ok) {
    return failEarly(`工作区权限规则有问题：${rulesLoad.error}（${rulesLoad.source}）`);
  }
  const workspaceRules = rulesLoad && rulesLoad.ok ? rulesLoad.rules : null;
  if (workspaceRules) writeErr(`[heming] ${describeCliWorkspaceRules(workspaceRules)}\n`);

  /**
   * 工作区钩子：`.heming/hooks.json`，与桌面端同一份配置、同一套解析与判定。
   *
   * 与权限规则的差别在于**默认不执行**：配置文件跟着仓库走，克隆一个陌生仓库不能在你
   * 敲下 heming run 时自动在本机跑它的脚本。要真的生效必须显式 `--trust-hooks`。
   * 但「有配置却不信任」也要说出来——用户该知道这次少了哪道检查。
   *
   * 读到了但内容坏了：只有在信任之后才拒绝启动。不信任时那些脚本根本不会跑，
   * 一份坏 JSON 不该让「只想让它读读代码」的人连门都进不去。
   */
  const hooksLoad = await loadCliHooks(cwd, options.trustHooks);
  if (hooksLoad && !hooksLoad.ok && options.trustHooks) {
    return failEarly(`工作区钩子配置有问题：${hooksLoad.error}（${hooksLoad.source}）`);
  }
  const hookSet = hooksLoad && hooksLoad.ok ? hooksLoad.set : null;
  const hookRunner = hookSet
    ? createCliHookRunner(hookSet, { cwd, streamId: `cli-${Date.now().toString(36)}` })
    : null;
  if (hookSet) {
    const line = describeCliHooks(hookSet);
    if (line) writeErr(`[heming] ${line}\n`);
  }

  /*
   * MCP 工具（`--mcp`）：把工作区 `.heming/mcp.json` 里声明的服务连上。
   *
   * 为什么必须显式打开：连接等于「启动仓库里写的命令」。克隆一个陌生仓库就自动执行它，
   * 和自动运行 postinstall 是同一类风险。连上之后它们的工具也不会直接可用——
   * MCP 工具一律按 danger 处理，还要 `--allow-danger` 才真的调过去。
   */
  if (options.mcp) {
    const config = await loadMcpServers(cwd);
    if (config === null) {
      return failEarly(
        `--mcp 需要工作区里有 ${MCP_CLIENT_CONFIG_FILE}（声明 {\"mcpServers\":{\"名字\":{\"command\":\"…\"}}}）。这次没有找到，所以一个服务也没连。`,
      );
    }
    if (!config.ok) return failEarly(`MCP 配置有问题：${config.error}（${config.source}）`);
    for (const server of config.servers) {
      const connected = await connectMcpServer(server, { cwd, version: readVersion() });
      if (!connected.ok) {
        writeErr(`[heming] MCP 服务 ${server.name} 没连上：${connected.error}\n`);
        continue;
      }
      mcpConnections.push(connected.connection);
      const names = connected.connection.tools.slice(0, 6).map((tool) => tool.name);
      const more = connected.connection.tools.length > names.length ? ` 等 ${connected.connection.tools.length} 个` : "";
      writeErr(
        `[heming] MCP 已连上 ${server.name}：${names.map((tool) => mcpToolName(server.name, tool)).join("、")}${more}${options.allowDanger ? "" : "（未加 --allow-danger：这批工具现在调用会得到「未执行」）"}\n`,
      );
    }
    if (mcpConnections.length === 0) {
      writeErr(`[heming] MCP：${config.servers.length} 个服务一个都没连上，这次只用自己的工具。\n`);
    }
  }
  const sessionRoot = sessionDir(options.sessionDir);
  let prior: SessionRecord | null = null;
  if (options.resume !== undefined) {
    const resolvedSession = await resolveSession(sessionRoot, options.resume);
    if (!resolvedSession.ok) return failEarly(resolvedSession.error);
    prior = resolvedSession.record;
  } else if (options.continueSession) {
    prior = await latestSession(sessionRoot, cwd);
    if (!prior) {
      return failEarly(
        `--continue 没找到可接的会话（目录：${sessionRoot}）。先跑一次 heming run，或不带 --continue 开一个新的。`,
      );
    }
  }
  const sessionId = prior?.id ?? newSessionId();

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
  if (prior) {
    writeErr(`[heming] 接着会话 ${prior.id}（已有 ${prior.turns.length} 条问答）\n`);
  }

  // 工作区约定（AGENTS.md 一族，d.310）：与桌面端同一份口径，读不到就当没有，不阻断运行。
  let projectRulesSection = "";
  try {
    const collected = await collectCliProjectRules({ cwd });
    projectRulesSection = collected.section;
    const line = describeCliProjectRules(collected);
    if (line) writeErr(`[heming] ${line}\n`);
  } catch (error) {
    // 约定文件读挂了不该让整次运行失败：说一句，继续跑。
    writeErr(`[heming] 项目约定没读成：${error instanceof Error ? error.message : String(error)}\n`);
  }
  /*
   * 工作区记忆（d.329）：按这一轮的提问捞几条相关的接进提示词。
   *
   * 记忆文件读坏了不该让运行失败——说一句，然后这次两头都不做：既不注入召回，
   * 也不挂 `remember` 工具。否则模型会往一个坏文件里写，把还能救的数据覆盖掉。
   */
  let recallSection = "";
  let memoryEnabled = options.memory;
  if (memoryEnabled) {
    const loadedMemory = await loadCliMemory(cwd);
    if (loadedMemory && !loadedMemory.ok) {
      memoryEnabled = false;
      writeErr(`[heming] 记忆读不出来，这次不带上也不写入：${loadedMemory.error}（${loadedMemory.source}）\n`);
    } else if (loadedMemory) {
      const recalled = recallCliMemory(loadedMemory.entries, rawPrompt);
      recallSection = memorySection(recalled);
      // 摘要句自带句号：拼「这次带上几条」之前先把它摘掉，免得出现「。；」。
      const memoryLine = describeCliMemory(loadedMemory).replace(/。$/, "");
      writeErr(`[heming] ${memoryLine}${recalled.length > 0 ? `；这次带上 ${recalled.length} 条相关的` : ""}。\n`);
    }
  }
  const handle = startAgentRun({
    prompt,
    cwd,
    profile,
    allowDanger: options.allowDanger,
    ...(workspaceRules ? { workspaceRules } : {}),
    ...(hookRunner ? { hooks: hookRunner } : {}),
    ...(mcpConnections.length > 0 ? { mcp: mcpConnections } : {}),
    ...(options.readOnly ? { readOnly: true } : {}),
    ...(approver ? { ask: approver.ask } : {}),
    ...(memoryEnabled ? {} : { memory: false }),
    ...(options.subagent ? {} : { subagent: false }),
    ...(recallSection ? { memorySection: recallSection } : {}),
    ...(projectRulesSection ? { projectRules: projectRulesSection } : {}),
    ...(options.contextBudget !== undefined ? { contextBudget: options.contextBudget } : {}),
    ...(options.compact ? {} : { compact: false }),
    // 折叠只在真折了时说一句：没折、也没关掉的时候，用户不需要看到「历史都在预算内」。
    onContext: (stats) => {
      if (!stats.enabled) {
        writeErr("[heming] 上下文：不折叠（--no-compact），历史原样发送。\n");
        return;
      }
      if (stats.folded > 0) writeErr(`[heming] ${describeCliContext(stats)}\n`);
    },
    history: toHistory(prior),
    sessionId,
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

  // 存档：只放文字问答，失败也只说一句——stdout 契约和退出码都已经定了，不该被存档影响。
  try {
    const record = appendTurn(prior, {
      id: sessionId,
      cwd,
      model: resolved.config.model,
      prompt,
      answer: result.text ?? "",
    });
    await writeSession(sessionRoot, record);
    writeErr(`[heming] 会话 ${sessionId}（接着聊：heming run --continue，或 --resume ${sessionId}）\n`);
  } catch (error) {
    writeErr(`[heming] 会话没有存下来：${error instanceof Error ? error.message : String(error)}\n`);
  }

  // 审批器的 readline 也握着 stdin，不收掉同样会让进程等着。
  approver?.close();
  // MCP 子进程要收掉：它们挂在 stdio 上，留着会让 Node 等 stdin 关闭而不退出。
  closeMcpConnections();

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
