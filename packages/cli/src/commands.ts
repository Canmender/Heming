/**
 * 工作区自定义命令在终端里的用法（d.333）。
 *
 * ## 为什么要有这一层
 *
 * 桌面端从 d.240 起就认 `.heming/commands/*.md`：文件名就是命令名，输入 `/review` 就把那份
 * 提示词发出去。CLI 一直没有这条路——更别扭的是，d.325 起 `heming mcp serve` 反而把同一批
 * 命令当成 MCP 的 `prompts` 交给了 Cursor / Claude Code：别的编辑器能调 `/review`，
 * 我们自己的终端不能。
 *
 * ## 与桌面端的一处有意差异
 *
 * 桌面端的 `expandCustomCommand` 只认**精确匹配**（`/review`，不带参数）。终端里习惯是一行写完，
 * 所以这里允许命令后面接补充说明：`heming run /review src/login.ts` 会把 `src/login.ts` 接在
 * 命令正文之后，中间空一行。命令本身该怎么写还是写在文件里，这里只负责把这一行里的尾巴补上去。
 *
 * ## 三条判断
 *
 * 1. 只有 `/` 开头且**形如命令名**（小写字母开头、字母数字短横线）才当命令处理；`/usr/bin/x`
 *    这种含斜杠的第一段不像命令名，照旧当普通提问发出去。
 * 2. 形状像命令但工作区里没有定义 → 直接报错并列出可用的，**不**原样发给模型：
 *    `/reviwe` 多半是打错了，静默发出去只会让模型对着一个陌生词瞎猜。
 * 3. 找不到命令目录、单份文件坏了，一律当「这个工作区没有这条命令」，不阻断正常跑。
 */

import { readdir, readFile } from "node:fs/promises";
import path from "node:path";
import {
  CUSTOM_COMMANDS_DIR,
  CUSTOM_COMMAND_NAME_RE,
  commandNameOf,
  parseCustomCommands,
  type CustomCommand,
  type CustomCommandSource,
} from "../../../packages/web/src/lib/agentRuntime/customCommands.js";

/** 单份命令文件的读取上限（字符）：比桌面端的 4000 字正文上限留足头部空间。 */
export const CLI_COMMAND_FILE_MAX_CHARS = 20_000;

/** 一次 `run` 里最多用一条命令，所以命令行上这条尾巴不必太长。 */
export const CLI_COMMAND_ARGS_MAX = 2000;

/**
 * 按码点截断到 max 个字符，避免在 UTF-16 代理对中间劈开 emoji（劈开会留下孤立的
 * 高位/低位代理，拼进提示词后显示成乱码方块）。
 */
function clipCodePoints(text: string, max: number): string {
  const chars = Array.from(text);
  return chars.length <= max ? text : chars.slice(0, max).join("");
}

/** `heming commands` 与运行提示里用的命令列表项。 */
export interface CliCommandSummary {
  name: string;
  command: string;
  title: string;
  hint: string;
  rel: string;
}

/** 读命令目录的结果：null = 这个工作区没有命令目录（不是错误）。 */
export type CliCommandsLoad =
  | { ok: true; commands: CustomCommand[] }
  | { ok: false; error: string; source: string }
  | null;

/** 命令行开头的一次命令调用。 */
export interface CliCommandInvocation {
  name: string;
  /** 命令名之后的补充说明（可能为空串）。 */
  args: string;
}

/** 命令目录的绝对路径（正斜杠）。 */
export function cliCommandsDir(cwd: string): string {
  return `${path.resolve(cwd).replace(/\\/g, "/")}/${CUSTOM_COMMANDS_DIR}`;
}

/**
 * 从工作区读命令文件。
 *
 * 不借 `collectCustomCommands`：那个函数走的是 web 的文件桥，`glob` 给绝对路径、`read` 只认
 * 绝对路径，两边的路径口径在 CLI 里容易接错（d.325 就在这上面栽过一次）。这里直接读目录，
 * 读到的正文交给 web 的 `parseCustomCommands`——**解析规则两边同一份**，不各写一套。
 */
export async function loadCliCommands(cwd: string): Promise<CliCommandsLoad> {
  const dir = cliCommandsDir(cwd);
  let names: string[];
  try {
    const entries = await readdir(dir, { withFileTypes: true });
    names = entries
      .filter((entry) => entry.isFile() && entry.name.toLowerCase().endsWith(".md"))
      .map((entry) => entry.name)
      .filter((name) => commandNameOf(name) !== null)
      .sort((a, b) => a.localeCompare(b));
  } catch (error) {
    const code = (error as { code?: unknown }).code;
    if (code === "ENOENT") return null;
    if (code === "ENOTDIR") return { ok: false, error: "这个路径不是目录", source: dir };
    return { ok: false, error: (error as Error).message, source: dir };
  }

  const sources: CustomCommandSource[] = [];
  for (const name of names) {
    try {
      const rawText = await readFile(path.join(dir, name), "utf8");
      // 记事本 / PowerShell 5 默认写 BOM：不剥掉的话 `# 标题` 认不出来，整行会混进正文。
      const text = rawText.replace(/^\uFEFF/, "");
      sources.push({ rel: `${CUSTOM_COMMANDS_DIR}/${name}`, text: clipCodePoints(text, CLI_COMMAND_FILE_MAX_CHARS) });
    } catch {
      // 单份读不到就当没有这一条：命令是锦上添花，不能因为它让整次运行失败。
    }
  }
  return { ok: true, commands: parseCustomCommands(sources) };
}

/** 列表用的精简形状（不含可能几千字的正文）。 */
export function summarizeCliCommands(commands: readonly CustomCommand[]): CliCommandSummary[] {
  return commands.map((item) => ({
    name: item.name,
    command: item.command,
    title: item.title,
    hint: item.hint,
    rel: item.rel,
  }));
}

/**
 * 看这一行像不像在调命令。
 *
 * 只认形如 `/<小写字母开头的名字>` 的第一段；`/usr/bin/foo`、`/1-2-3` 都不算，
 * 照旧当普通提问。
 */
export function parseCliCommandInvocation(prompt: string): CliCommandInvocation | null {
  const trimmed = prompt.trimStart();
  if (!trimmed.startsWith("/")) return null;
  const match = /^\/([A-Za-z0-9-]+)(?:\s+([\s\S]*))?$/.exec(trimmed);
  if (match === null) return null;
  const name = (match[1] ?? "").toLowerCase();
  if (!CUSTOM_COMMAND_NAME_RE.test(name)) return null;
  return { name, args: clipCodePoints((match[2] ?? "").trim(), CLI_COMMAND_ARGS_MAX) };
}

/** 一条命令被调用之后，真正发给模型的那段话。 */
export function expandCliCommand(command: CustomCommand, args: string): string {
  const extra = args.trim();
  return extra === "" ? command.prompt : `${command.prompt}\n\n${extra}`;
}

/** 解析结果：要么换成一段提示词，要么给一句能照着改的错。 */
export type CliCommandResolution =
  | { ok: true; prompt: string; command: CustomCommand }
  | { ok: false; error: string };

/** 把一次命令调用落成提示词；名字没定义就报错（带上可用的命令）。 */
export function resolveCliCommand(
  invocation: CliCommandInvocation,
  commands: readonly CustomCommand[],
): CliCommandResolution {
  const found = commands.find((item) => item.name === invocation.name);
  if (found !== undefined) {
    return { ok: true, prompt: expandCliCommand(found, invocation.args), command: found };
  }
  const available = commands.map((item) => item.command).join("、");
  if (commands.length === 0) {
    return {
      ok: false,
      error: `工作区里没有这个命令：/${invocation.name}（这个工作区还没有自定义命令：放一个 .heming/commands/名字.md，就能用 /名字 调它）`,
    };
  }
  return {
    ok: false,
    error: `工作区里没有这个命令：/${invocation.name}（现有的：${available}；定义写在工作区 .heming/commands/<名字>.md）`,
  };
}

/** `heming commands` 的表头与每一行（给人看的版本）。 */
export function describeCliCommands(load: CliCommandsLoad, cwd: string): string {
  const dir = cliCommandsDir(cwd);
  if (load === null) {
    return `这个工作区还没有自定义命令（放一个 ${CUSTOM_COMMANDS_DIR}/名字.md 就有；也可以用 heming mcp serve 把它们交给编辑器）。\n目录：${dir}`;
  }
  if (!load.ok) {
    return `命令目录读不出来：${load.error}（${load.source}）`;
  }
  if (load.commands.length === 0) {
    return `命令目录是空的（${dir}）：往里放一个 名字.md，正文就是提示词，第一行可写 # 标题、第二行可写 > 说明。`;
  }
  const width = Math.min(24, Math.max(...load.commands.map((item) => item.command.length)));
  const lines = [`工作区自定义命令（${dir}，共 ${load.commands.length} 条）：`];
  for (const item of load.commands) {
    lines.push(`  ${item.command.padEnd(width)}  ${item.title}${item.hint === item.title ? "" : `——${item.hint}`}`);
    lines.push(`  ${" ".repeat(width)}  ${item.rel}`);
  }
  lines.push("");
  lines.push("用法：heming run /名字 [补充说明]（补充说明会接在命令正文之后）。");
  return lines.join("\n");
}

/** 运行起来之后，stderr 上那一句「用的是哪条命令」。 */
export function describeCliCommandUse(command: CustomCommand, args: string): string {
  const tail = args.trim() === "" ? "" : "，并已接上你这一行里的补充说明";
  return `用的是工作区命令 ${command.command}（${command.title}，来自 ${command.rel}）${tail}。`;
}