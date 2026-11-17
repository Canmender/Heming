/**
 * 工具参数的一行人话摘要（d.216）。
 *
 * 背景：工具轨迹里每个调用展开后直接渲染原始 JSON——写文件时那是一整篇内容、
 * 跑命令时那是一整条命令，用户看到的是一坨转义字符，而不是「它改了哪个文件、
 * 跑了什么」。这一层只回答一个问题：**这次调用干了什么**，给一行能扫过去的摘要。
 *
 * 口径：
 * - 纯函数、不读全局、不抛异常（模型给的参数可能是不合法 JSON 或半截 JSON）；
 * - 解析不了就返回空串——宁可只显示工具名，也不显示一句瞎猜的话；
 * - 只取「用户关心」的字段，长文本一律压成一行并截断；
 * - 不翻译路径（用户看的是自己的路径），只压掉多余层级与反斜杠。
 */

const MAX_TEXT = 60;
const MAX_PATH = 64;

/** 压成一行：换行/制表/连续空白统一成一个空格，并去掉首尾空白。 */
function oneLine(value: unknown): string {
  if (typeof value !== "string") return "";
  return value.replace(/\s+/g, " ").trim();
}

/** 截断（按码点，避免把代理对切一半）。 */
function clip(text: string, max: number): string {
  const chars = Array.from(text);
  if (chars.length <= max) return text;
  return `${chars.slice(0, max - 1).join("")}…`;
}

/** 路径：压掉多余分隔符与首尾斜杠，过长时保留末尾（末尾才是文件名）。 */
function shortPath(value: unknown): string {
  const raw = oneLine(value).replace(/\\/g, "/").replace(/\/{2,}/g, "/").replace(/\/$/, "");
  if (!raw) return "";
  return clip(raw, MAX_PATH);
}

/** 行数：只数换行，末尾没有换行也算一行（与编辑器行号口径一致）。 */
function lineCount(value: unknown): number {
  if (typeof value !== "string" || value.length === 0) return 0;
  let lines = 1;
  for (let i = 0; i < value.length; i += 1) if (value[i] === "\n") lines += 1;
  return lines;
}

function numberField(value: unknown): number | null {
  if (typeof value === "number" && Number.isFinite(value)) return Math.trunc(value);
  if (typeof value === "string" && /^\d+$/.test(value.trim())) return Number.parseInt(value.trim(), 10);
  return null;
}

/** 把参数对象里前若干个标量拼成 `key: value · key: value`，未知工具兜底用。 */
function scalarPairs(args: Record<string, unknown>): string {
  const parts: string[] = [];
  for (const [key, value] of Object.entries(args)) {
    if (parts.length >= 2) break;
    if (value === null || value === undefined) continue;
    if (typeof value === "string") {
      const text = oneLine(value);
      if (text) parts.push(`${key}: ${clip(text, 28)}`);
    } else if (typeof value === "number" || typeof value === "boolean") {
      parts.push(`${key}: ${String(value)}`);
    } else if (Array.isArray(value)) {
      parts.push(`${key}: ${value.length} 项`);
    }
  }
  return parts.join(" · ");
}

/** 从 unified diff 里数出改了几个文件（`+++ b/...` 行）。 */
function patchTargets(patch: unknown): { count: number; first: string } {
  const text = typeof patch === "string" ? patch : "";
  const names: string[] = [];
  for (const line of text.split("\n")) {
    const match = /^\+\+\+ (?:b\/)?(.+)$/.exec(line.trim());
    if (match && match[1] && match[1] !== "/dev/null") names.push(match[1]);
  }
  return { count: names.length, first: names[0] ? shortPath(names[0]) : "" };
}

/**
 * 一行摘要。`argsJson` 是模型给的原始参数字符串（可能是空、可能不合法）。
 * 没有可说的就返回空串。
 */
export function summarizeToolArgs(name: string, argsJson: string): string {
  const raw = typeof argsJson === "string" ? argsJson.trim() : "";
  if (!raw) return "";
  let args: Record<string, unknown>;
  try {
    const parsed: unknown = JSON.parse(raw);
    if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) return "";
    args = parsed as Record<string, unknown>;
  } catch {
    return "";
  }

  switch (name) {
    case "file_write": {
      const path = shortPath(args.path);
      const lines = lineCount(args.content);
      if (path && lines > 0) return `${path} · +${lines} 行`;
      return path;
    }
    case "file_edit": {
      const path = shortPath(args.path);
      const oldLines = lineCount(args.old_string);
      const newLines = lineCount(args.new_string);
      if (!path) return "";
      return oldLines > 0 && newLines > 0 ? `${path} · ${oldLines} 行 → ${newLines} 行` : path;
    }
    case "file_patch": {
      const targets = patchTargets(args.patch);
      if (targets.count > 1) return `补丁 · ${targets.count} 个文件`;
      if (targets.count === 1 && targets.first) return `补丁 · ${targets.first}`;
      return "补丁";
    }
    case "file_read":
    case "file_image":
    case "file_undo":
      return shortPath(args.path);
    case "file_glob": {
      const pattern = clip(oneLine(args.pattern), MAX_TEXT);
      if (!pattern) return "";
      return pattern;
    }
    case "file_grep": {
      const pattern = clip(oneLine(args.pattern), 40);
      const where = shortPath(args.path) || oneLine(args.glob);
      if (!pattern) return "";
      return where ? `/${pattern}/ in ${where}` : `/${pattern}/`;
    }
    case "run_command": {
      const command = oneLine(args.command);
      if (!command) return "";
      const cwd = shortPath(args.cwd);
      return cwd ? `${clip(command, MAX_TEXT)} · ${cwd}` : clip(command, MAX_TEXT);
    }
    case "command_output":
    case "command_kill": {
      const id = oneLine(args.job_id);
      return id ? `作业 ${id}` : "";
    }
    case "command_list":
      return "列出后台作业";
    case "agent_task": {
      const tasks = Array.isArray(args.tasks)
        ? args.tasks.filter((item): item is string => typeof item === "string")
        : [];
      if (tasks.length > 1) return `并行 ${tasks.length} 件：${clip(oneLine(tasks[0]), MAX_TEXT - 16)}`;
      const single = oneLine(tasks[0] ?? args.task);
      return clip(single, MAX_TEXT);
    }
    case "workflow_run": {
      const steps = Array.isArray(args.steps) ? args.steps : [];
      const goal = clip(oneLine(args.goal), 40);
      if (steps.length > 0) return goal ? `${steps.length} 步 · ${goal}` : `${steps.length} 步`;
      return goal;
    }
    case "todo_write": {
      const todos = Array.isArray(args.todos) ? args.todos : [];
      return todos.length > 0 ? `${todos.length} 项` : "";
    }
    case "tool_output_read": {
      const id = oneLine(args.id);
      const offset = numberField(args.offset);
      if (!id) return "";
      return offset !== null && offset > 0 ? `#${id} · 从第 ${offset} 字` : `#${id}`;
    }
    default:
      return scalarPairs(args);
  }
}


/**
 * 这次调用涉及的那个文件路径（d.235）：给「定位」按钮用。
 *
 * 只认真正有单一目标文件的工具：读、写、改、撤销、读图。
 * 不认 `file_glob`（模式不是路径）、不认 `file_patch`（一份补丁可能改多个文件，
 * 挑一个出来定位等于替用户猜）。纯函数、不抛：参数缺失/不是 JSON/路径为空一律 null。
 */
export function toolArgPath(name: string, argsJson: string): string | null {
  const withPath = new Set(["file_read", "file_write", "file_edit", "file_undo", "file_image"]);
  if (!withPath.has(name)) return null;
  try {
    const parsed: unknown = JSON.parse(argsJson);
    if (!parsed || typeof parsed !== "object") return null;
    const value = (parsed as { path?: unknown }).path;
    if (typeof value !== "string") return null;
    const trimmed = value.trim();
    return trimmed.length > 0 ? trimmed : null;
  } catch {
    return null;
  }
}
