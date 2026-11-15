/**
 * 「完成即证据」（P3/T15）：把一回合**实际发生的动作**提炼成可复核的证据。
 *
 * 为什么需要它：模型说「已完成」是一句自述，用户无法验证；而工具调用与落盘结果
 * 是同一台机器上发生过的事实。证据不改变模型的行为，它只做一件事——
 * 让「完成」有据可查，让「只自称完成」在复盘和评测里能被判负。
 *
 * 三条口径：
 * 1. 只收**成功**的调用（`ok === true`）：失败的调用什么都没证明；
 * 2. 只收**有副作用或读了真实数据**的调用：纯 tool_search 这类内部动作不算证据；
 * 3. 去重保序：同一文件改两次只记一条，顺序按首次出现。
 */
import type { ChatMessage } from "../llmClient.js";
import type { RolloutEvidence } from "./types.js";


/** 关键参数里可能放文件路径的键名（不同工具桥的命名不统一，按名单取）。 */
const PATH_KEYS = ["path", "file", "filepath", "file_path", "target", "to", "dest", "destination"];

/** 补丁正文里的文件头（fileEdit 的补丁语法；`*** Move to:` 也是目标文件）。 */
const PATCH_HEADER_RE = /^\*\*\*\s+(?:Add|Update|Delete)\s+File:\s*(.+?)\s*$/gm;
const PATCH_MOVE_RE = /^\*\*\*\s+Move\s+to:\s*(.+?)\s*$/gm;

/** 会改变本机状态的工具名特征（写文件/删文件/改名）。 */
const WRITE_TOOL_RE = /patch|write|edit|create|delete|remove|move|rename|mkdir/i;
/** 会执行命令的工具名特征（跑命令是另一类证据：它证明「真的跑过」）。 */
const COMMAND_TOOL_RE = /shell|exec|command|terminal|bash|pwsh|run_|spawn/i;

/** 内部动作：它们不碰外部世界，不能当证据。 */
const INTERNAL_TOOLS = new Set(["tool_search"]);

/** 单条证据文本上限（证据是摘要，不是第二份日志）。 */
const MAX_COMMAND_CHARS = 160;
const MAX_DIGEST_PER_RESULT = 80;
const MAX_DIGEST_CHARS = 240;

/** 按码点截断，避免切坏代理对。 */
function clip(text: string, max: number): string {
  const chars = [...text];
  return chars.length <= max ? text : `${chars.slice(0, Math.max(0, max - 1)).join("")}…`;
}

/** 压成一行（参数 JSON 里的换行会把一条证据撑成多行）。 */
function oneLine(text: string): string {
  return text.replace(/\s+/g, " ").trim();
}

/** 从工具参数里挖出文件路径：JSON 键 + 补丁正文两种来源。 */
function pathsOf(argsJson: string): string[] {
  const found: string[] = [];
  let parsed: unknown;
  try {
    parsed = JSON.parse(argsJson || "{}");
  } catch {
    parsed = null;
  }
  if (parsed && typeof parsed === "object") {
    for (const [key, value] of Object.entries(parsed as Record<string, unknown>)) {
      if (typeof value !== "string") continue;
      if (!PATH_KEYS.includes(key.toLowerCase())) continue;
      const path = value.trim();
      if (path) found.push(path);
    }
  }
  // 补丁正文：`patch` 字段（或整个参数串）里的文件头就是落盘目标。
  const text = typeof (parsed as { patch?: unknown } | null)?.patch === "string"
    ? String((parsed as { patch: string }).patch)
    : argsJson;
  for (const re of [PATCH_HEADER_RE, PATCH_MOVE_RE]) {
    re.lastIndex = 0;
    for (const match of text.matchAll(re)) {
      const path = match[1]?.trim();
      if (path) found.push(path);
    }
  }
  return found;
}

/**
 * 从「本回合成功执行过的工具调用 + 结果」构建证据。
 *
 * 入参是 `(call, result)` 对，调用方保证 result 是**这一回合**的：
 * 跨回合混进来会让「这次完成」的凭据变成上一次的。
 * 没有任何可证据的动作时返回 `undefined`——空证据与「没证据」是一回事，
 * 存一个 `{files:[],commands:[]}` 反而会让「无证据」看起来像「查过了没副作用」。
 */
export function buildTurnEvidence(
  pairs: readonly { call: { name: string; arguments: string }; text: string; ok: boolean }[],
): RolloutEvidence | undefined {
  const files: string[] = [];
  const commands: string[] = [];
  const digests: string[] = [];
  const seenFiles = new Set<string>();
  const seenCommands = new Set<string>();

  for (const { call, text, ok } of pairs) {
    const name = call.name;
    if (!ok || INTERNAL_TOOLS.has(name)) continue;
    const paths = WRITE_TOOL_RE.test(name) ? pathsOf(call.arguments) : [];
    for (const path of paths) {
      if (seenFiles.has(path)) continue;
      seenFiles.add(path);
      files.push(path);
    }
    const summary = oneLine(call.arguments).slice(0, MAX_COMMAND_CHARS);
    if (COMMAND_TOOL_RE.test(name)) {
      const command = clip(`${name}${summary ? `: ${summary}` : ""}`, MAX_COMMAND_CHARS);
      if (!seenCommands.has(command)) {
        seenCommands.add(command);
        commands.push(command);
      }
    } else if (paths.length > 0) {
      // 写文件类动作也进 commands：用户复核时关心「对哪个文件做了什么」。
      const command = clip(`${name}: ${paths.join("、")}`, MAX_COMMAND_CHARS);
      if (!seenCommands.has(command)) {
        seenCommands.add(command);
        commands.push(command);
      }
    }
    for (const line of text.split(/\r?\n/)) {
      const trimmed = line.trim();
      if (!trimmed) continue;
      digests.push(clip(trimmed, MAX_DIGEST_PER_RESULT));
      if (digests.join(" | ").length >= MAX_DIGEST_CHARS) break;
    }
  }

  if (files.length === 0 && commands.length === 0) return undefined;
  const outputDigest = digests.length > 0 ? clip(digests.join(" | "), MAX_DIGEST_CHARS) : undefined;
  return { files, commands, ...(outputDigest ? { outputDigest } : {}) };
}

/**
 * 从一回合的转录重建证据（给任务区/回放这类「只有 messages、没有工具调用对象」的地方用）。
 *
 * 关键在于把两侧接上：助手消息的 `tool_calls` 带参数，工具消息带 `tool_call_id`，
 * 按 id 配对才拿得到「哪个工具、改了什么路径」。只按工具名+结果文本猜路径会造出
 * 似是而非的证据，宁可没有。
 */
export function evidenceFromTranscript(messages: readonly ChatMessage[]): RolloutEvidence | undefined {
  const argsById = new Map<string, { name: string; arguments: string }>();
  for (const message of messages) {
    for (const call of message.tool_calls ?? []) {
      if (!call?.id) continue;
      argsById.set(call.id, {
        name: call.function?.name ?? "",
        arguments: call.function?.arguments ?? "",
      });
    }
  }
  const pairs = messages
    .filter((m) => m.role === "tool" && typeof m.name === "string")
    .map((m) => {
      const known = typeof m.tool_call_id === "string" ? argsById.get(m.tool_call_id) : undefined;
      // 工具消息的 result 由工具自己产生，ok 记为 true：失败的结果文本里不含成功标记，
      // 而 buildTurnEvidence 的写/命令识别依赖参数，不会因此凭空多出证据。
      return {
        call: { name: known?.name || (m.name as string), arguments: known?.arguments ?? "" },
        text: typeof m.content === "string" ? m.content : "",
        ok: true,
      };
    });
  return buildTurnEvidence(pairs);
}
