/**
 * 工作区自定义命令（d.240）：`.heming/commands/<名字>.md` 里的提示词，变成 `/名字`。
 *
 * 为什么做：内置命令（`/plan` `/status` `/goal`…）解决的是「和鸣自己会做的事」，
 * 但每个团队都有反复叮嘱的同一段话——「按我们的风格复盘这次改动」
 * 「先读 docs/DESIGN.md 再动手」「提交前跑哪三条命令」。
 * 现在只能每次手打，或者塞进 AGENTS.md 里（那是**每轮都发**的约定，会吃上下文）。
 * codex / Claude Code 都有「把常用提示词存成命令」的能力，这一版补上。
 *
 * 设计口径（与 `projectRules.ts` 一致的地方多一点，避免两套心智）：
 * - **只认一个目录**：`.heming/commands/*.md`，不扫全仓、不猜别的扩展名。
 * - **文件名就是命令名**：`review.md` → `/review`；名字只允许 `[a-z0-9-]`，
 *   因为命令要能被 `/` 面板快速筛出来，中文名会让筛选变成猜谜。
 * - **文件是提示词本身**：可选首行 `# 标题`、可选紧随的 `> 说明`，其余全文即提示词。
 * - 展开后**走正常发送路径**（会落库、会调工具、会占用这一轮上下文）——
 *   它跟 `/init` 同类，不是本地命令。
 * - 单文件封顶、总数封顶、命名冲突取先读到的那个，坏文件跳过而不是让整批失效。
 */

import type { FileFsBridge } from "../fileEdit/bridge.js";
import type { FileRoot } from "../fileEdit/paths.js";
import type { SlashCommand } from "./slashCommands.js";

/** 约定目录（相对工作区根，正斜杠）。 */
export const CUSTOM_COMMANDS_DIR = ".heming/commands";
/** 一次最多认几个命令：太多了 `/` 面板会变成翻页器。 */
export const MAX_CUSTOM_COMMANDS = 20;
/** 单条命令的提示词上限：命令是「一段叮嘱」，不是长文档。 */
export const MAX_CUSTOM_COMMAND_CHARS = 4000;

/** 按码点截断（d.412 回归）：这段正文会进提示词，不能在 emoji 中间劈出落单代理。 */
function clipByPoints(text: string, max: number): string {
  const points = Array.from(text);
  return points.length > max ? points.slice(0, max).join("") : text;
}
/** 命令名（来自文件名，不含 `.md`）。 */
export const CUSTOM_COMMAND_NAME_RE = /^[a-z][a-z0-9-]{0,29}$/;

export interface CustomCommandSource {
  /** 相对工作区的路径，例如 `.heming/commands/review.md`。 */
  rel: string;
  /** 文件全文。 */
  text: string;
}

export interface CustomCommand {
  /** 命令名（不含斜杠），来自文件名。 */
  name: string;
  /** 完整命令，例如 `/review`。 */
  command: string;
  /** 面板里的标题。 */
  title: string;
  /** 面板里的一行说明。 */
  hint: string;
  /** 展开后真正发给模型的那段话。 */
  prompt: string;
  /** 来源文件（相对工作区），用于「这条命令是哪来的」。 */
  rel: string;
  /** 是否因为超长被截断（截断处在提示词末尾写明了）。 */
  truncated: boolean;
}

/** 从相对路径取命令名：只看文件名、只要 `.md`。 */
export function commandNameOf(rel: string): string | null {
  const file = rel.replace(/\\/g, "/").split("/").pop() ?? "";
  if (!file.toLowerCase().endsWith(".md")) return null;
  const name = file.slice(0, -3).toLowerCase();
  return CUSTOM_COMMAND_NAME_RE.test(name) ? name : null;
}

interface ParsedBody {
  title: string | null;
  hint: string | null;
  body: string;
}

/**
 * 拆出可选的 `# 标题` 与紧随的 `> 说明`，返回真正的提示词正文。
 *
 * 只认**文件开头**的这两行：正文中间出现的 `#` / `>` 属于提示词本身，不能当元信息吃掉。
 */
export function splitCommandFile(text: string): ParsedBody {
  const normalized = text.replace(/\r\n/g, "\n").replace(/\r/g, "\n");
  const lines = normalized.split("\n");
  let index = 0;
  // 允许文件开头有空行
  while (index < lines.length && lines[index].trim() === "") index += 1;
  let title: string | null = null;
  let hint: string | null = null;
  const heading = lines[index] ?? "";
  if (heading.startsWith("# ")) {
    title = heading.slice(2).trim() || null;
    index += 1;
    while (index < lines.length && lines[index].trim() === "") index += 1;
    const quote = lines[index] ?? "";
    if (quote.startsWith("> ")) {
      hint = quote.slice(2).trim() || null;
      index += 1;
    }
  }
  const body = lines.slice(index).join("\n").trim();
  return { title, hint, body };
}

/** 把一条文件解析成命令；名字不合法 / 正文为空 → null（坏文件不该让整批失效）。 */
export function parseCustomCommand(source: CustomCommandSource): CustomCommand | null {
  const name = commandNameOf(source.rel);
  if (name === null) return null;
  const { title, hint, body } = splitCommandFile(source.text);
  if (body === "") return null;
  const truncated = body.length > MAX_CUSTOM_COMMAND_CHARS;
  const prompt = truncated
    ? `${clipByPoints(body, MAX_CUSTOM_COMMAND_CHARS)}\n\n（这条命令超过 ${MAX_CUSTOM_COMMAND_CHARS} 字，只发了前面这些；需要完整内容请用 file_read 读 \`${source.rel}\`。）`
    : body;
  return {
    name,
    command: `/${name}`,
    title: title ?? name,
    hint: hint ?? `自定义命令（来自 ${source.rel}）`,
    prompt,
    rel: source.rel,
    truncated,
  };
}

/**
 * 解析整批命令：按路径排序保证结果稳定，同名取先读到的，超过上限的丢掉（不是静默——调用方可看 `length`）。
 */
export function parseCustomCommands(sources: readonly CustomCommandSource[]): CustomCommand[] {
  const sorted = [...sources].sort((a, b) => a.rel.localeCompare(b.rel));
  const out: CustomCommand[] = [];
  const seen = new Set<string>();
  for (const source of sorted) {
    const command = parseCustomCommand(source);
    if (command === null) continue;
    if (seen.has(command.name)) continue;
    seen.add(command.name);
    out.push(command);
    if (out.length >= MAX_CUSTOM_COMMANDS) break;
  }
  return out;
}

/**
 * 输入是不是某条自定义命令（**精确匹配**，不含参数）。
 *
 * 与 `/init` 一样：命中就把整句换成那段提示词，然后走正常发送路径。
 * 不做「`/review 顺便看看登录`」这种参数拼接——命令里该带什么，就写进文件。
 */
export function expandCustomCommand(text: string, commands: readonly CustomCommand[]): string | null {
  const trimmed = text.trim();
  if (!trimmed.startsWith("/")) return null;
  const match = commands.find((item) => item.command === trimmed);
  return match?.prompt ?? null;
}

/** 面板条目：自定义命令的 hint 里标明来源，便于和内置命令区分。 */
export function commandsToSlash(commands: readonly CustomCommand[]): SlashCommand[] {
  return commands.map((item) => ({
    command: item.command,
    title: item.title,
    hint: `${item.hint}（${item.rel}）`,
  }));
}

const MAX_LISTED_FILES = MAX_CUSTOM_COMMANDS;

/**
 * 从工作区读命令文件。
 *
 * 读不到（没有桥 / 没有根 / 老桌面端没有 glob）一律返回空数组：
 * 自定义命令是「锦上添花」，不能因为它让正常对话失败。
 */
export async function collectCustomCommands(input: {
  bridge: FileFsBridge | null;
  roots: readonly FileRoot[];
}): Promise<CustomCommand[]> {
  const { bridge } = input;
  if (!bridge || !bridge.glob || input.roots.length === 0) return [];
  try {
    const found = await bridge.glob({
      roots: [...input.roots],
      pattern: `${CUSTOM_COMMANDS_DIR}/*.md`,
    });
    if (!found.ok) return [];
    const files = found.paths.slice(0, MAX_LISTED_FILES);
    const sources: CustomCommandSource[] = [];
    for (const rel of files) {
      const res = await bridge.read({ roots: [...input.roots], path: rel });
      if (!res.ok) continue;
      sources.push({ rel, text: res.content });
    }
    return parseCustomCommands(sources);
  } catch {
    return [];
  }
}
