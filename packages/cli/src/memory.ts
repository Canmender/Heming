/**
 * 终端里的长期记忆（d.329）：把「这件事以后也要算数」写进工作区，下次还认。
 *
 * 为什么放在 `.heming/memory.json` 而不是某个隐藏目录：
 * - 它是**仓库的一部分**，跟着 git 一起走、能被 code review、能被人手改——和
 *   `.heming/{permissions,hooks,mcp}.json` 是同一套「仓库就是配置」的口径；
 * - 出了错能一眼看见：模型记错了一条，用户直接编辑这个文件，或者 `heming memory forget`；
 * - 不写系统目录：工作区之外的记忆没有归属，换个项目还在背别人的事，这是 bug 不是功能。
 *
 * 与桌面端的记忆系统（`packages/web/src/lib/memory/*`，语义/情景/工作三层 + BM25）
 * 的关系：那边是**产品级**记忆（有沉淀、评分、衰减、知识库接入），这里只做终端需要的最小闭环——
 * 一条一条记、按当前提问捞几条相关的、能列能删。刻意不引那套三层模型：CLI 一次运行就结束，
 * 没有「工作记忆」可言，硬套只会让一个单文件变成一座山。分词复用它的 `tokenize`，
 * 这样「记什么」和「捞什么」的口径与桌面端一致。
 *
 * 已知边界（写进 CHANGELOG，别让用户猜）：
 * - 只记**文字**，不记文件内容；也不自动记（`remember` 是模型显式调用，不是窃听）；
 * - 召回是关键词重叠，不是语义检索：问法与记法完全不共词时捞不到；
 * - 上限 200 条 / 单条 400 字，超了丢最旧的（记忆要能用完就扔，不该无限长）。
 */

import fs from "node:fs/promises";
import path from "node:path";
import { tokenize } from "../../../packages/web/src/lib/memory/tokenize.js";

/** 记忆文件：跟着仓库走，位置与 `.heming/*` 其余配置一致。 */
export const CLI_MEMORY_FILE = ".heming/memory.json";
/** 文件格式版本：将来换形状时用它判断能不能读。 */
export const CLI_MEMORY_VERSION = 1;
/** 条目上限：超了丢最旧的（终端记忆是「最近还算数的事」，不是档案）。 */
export const CLI_MEMORY_MAX_ENTRIES = 200;
/** 单条上限：一段能被完整念完的话，而不是一整篇文档。 */
export const CLI_MEMORY_MAX_TEXT = 400;
/** 一次最多注入几条：记忆是增强，不该把提问挤到后面。 */
export const CLI_MEMORY_RECALL_LIMIT = 5;
/** 注入段的总字数上限（含标题与缩进），超出就少放几条。 */
export const CLI_MEMORY_SECTION_MAX_CHARS = 1200;
/** 段标题：与「项目约定」「运行环境」同级，让模型一眼看出这是自己的记忆。 */
export const CLI_MEMORY_HEADING = "## 长期记忆（这个工作区记下的）";
/** 模型用来写记忆的工具名。 */
export const REMEMBER_TOOL = "remember";

/** 一条记忆：id 稳定（能删）、at 是写下时间（排序/展示用）、text 是正文。 */
export interface CliMemoryEntry {
  id: string;
  at: string;
  text: string;
}

/** 读文件的结果：`null` = 还没有记忆文件（不是错误）；`ok:false` = 有文件但读不动/格式坏。 */
export type CliMemoryLoad =
  | { ok: true; entries: CliMemoryEntry[]; source: string }
  | { ok: false; error: string; source: string }
  | null;

/** 记忆文件路径（正斜杠，调用方拿到的就是能直接给 fs 的绝对路径）。 */
export function memoryPath(cwd: string): string {
  return `${path.resolve(cwd).replace(/\\/g, "/")}/${CLI_MEMORY_FILE}`;
}

/** 归一正文：多行压成一行（记忆是「一句话」，不是文档）、去首尾空白、超长截断。 */
export function normalizeMemoryText(raw: string): string {
  const oneLine = raw.replace(/\s+/g, " ").trim();
  if (oneLine.length <= CLI_MEMORY_MAX_TEXT) return oneLine;
  // 按 UTF-16 码元硬切会把 emoji / 扩展汉字（代理对）劈成孤立的半截，
  // 写进 memory.json 后注入系统提示词就是非法 Unicode。截断点若落在高代理上，
  // 退一格再拼省略号，保证结果仍是完整码点串。
  let end = CLI_MEMORY_MAX_TEXT - 1;
  const last = oneLine.charCodeAt(end - 1);
  if (last >= 0xd800 && last <= 0xdbff) end -= 1;
  return `${oneLine.slice(0, end)}…`;
}

function isEntry(value: unknown): value is CliMemoryEntry {
  if (!value || typeof value !== "object" || Array.isArray(value)) return false;
  const item = value as Record<string, unknown>;
  return typeof item.id === "string" && item.id.length > 0 && typeof item.at === "string" && typeof item.text === "string";
}

/**
 * 解析记忆文件内容。
 *
 * 坏一条就整份不认（返回 `null`），而不是「能读几条算几条」：静默丢条目会让人以为
 * 自己记过的东西被模型忘了，那比明确报错难查得多。
 */
export function parseCliMemory(value: unknown): CliMemoryEntry[] | null {
  if (!value || typeof value !== "object" || Array.isArray(value)) return null;
  const file = value as Record<string, unknown>;
  if (file.version !== undefined && file.version !== CLI_MEMORY_VERSION) return null;
  const entries = file.entries;
  if (!Array.isArray(entries)) return null;
  // 数组是老 → 新：同一 id 重复出现时，后一条才是用户改过的最新版本，应该覆盖前一条。
  // 旧实现用 Set 先到先得，反而留下最旧的重复项，和下面「超出上限保留最新」的口径矛盾。
  // 文件可被手工编辑，复制一段改文字却忘改 id 是真实场景。
  const byId = new Map<string, CliMemoryEntry>();
  for (const item of entries) {
    if (!isEntry(item)) return null;
    const text = normalizeMemoryText(item.text);
    if (!text) continue;
    byId.set(item.id, { id: item.id, at: item.at, text });
  }
  // 超出上限时保留最新的（数组是老 → 新）。
  return [...byId.values()].slice(-CLI_MEMORY_MAX_ENTRIES);
}

/** 读工作区记忆；没有文件返回 `null`，读不动/格式坏返回 `ok:false`（附人能看懂的原因）。 */
export async function loadCliMemory(cwd: string): Promise<CliMemoryLoad> {
  const source = memoryPath(cwd);
  let raw: string;
  try {
    raw = await fs.readFile(source, "utf8");
  } catch (error) {
    if ((error as NodeJS.ErrnoException)?.code === "ENOENT") return null;
    return { ok: false, error: `读不到：${(error as Error).message}`, source };
  }
  let parsed: unknown;
  try {
    parsed = JSON.parse(raw.replace(/^\uFEFF/, ""));
  } catch (error) {
    return { ok: false, error: `不是合法 JSON：${(error as Error).message}`, source };
  }
  const entries = parseCliMemory(parsed);
  if (!entries) return { ok: false, error: "格式不对（需要 {\"version\":1,\"entries\":[{\"id\",\"at\",\"text\"}]}）", source };
  return { ok: true, entries, source };
}

/** 写回记忆：临时文件 + rename，半截写坏的文件比没有记忆更糟。 */
async function saveCliMemory(cwd: string, entries: CliMemoryEntry[]): Promise<void> {
  const target = memoryPath(cwd);
  await fs.mkdir(path.dirname(target), { recursive: true });
  const body = `${JSON.stringify({ version: CLI_MEMORY_VERSION, entries }, null, 2)}\n`;
  const tmp = `${target}.${process.pid}.tmp`;
  await fs.writeFile(tmp, body, "utf8");
  await fs.rename(tmp, target);
}

/** 新条目的 id：时间戳 + 随机后缀，够短、可复制、可删。 */
function newEntryId(now: Date, random: () => number): string {
  const suffix = Math.floor(random() * 36 ** 4)
    .toString(36)
    .padStart(4, "0");
  return `m-${now.getTime().toString(36)}-${suffix}`;
}

export interface CliMemoryAddOptions {
  now?: Date;
  random?: () => number;
}

/** 记一条。同一句话不重复写（模型很容易在相邻两轮里说同一件事）。 */
export async function addCliMemory(
  cwd: string,
  rawText: string,
  options: CliMemoryAddOptions = {},
): Promise<{ ok: true; entry: CliMemoryEntry; total: number; added: boolean } | { ok: false; error: string }> {
  const text = normalizeMemoryText(rawText ?? "");
  if (!text) return { ok: false, error: "要记的内容是空的" };
  const loaded = await loadCliMemory(cwd);
  if (loaded && !loaded.ok) return { ok: false, error: `记忆文件坏了：${loaded.error}（${loaded.source}）` };
  const entries = loaded ? loaded.entries : [];
  const existing = entries.find((entry) => entry.text === text);
  if (existing) return { ok: true, entry: existing, total: entries.length, added: false };
  const now = options.now ?? new Date();
  const entry: CliMemoryEntry = {
    id: newEntryId(now, options.random ?? Math.random),
    at: now.toISOString(),
    text,
  };
  const next = [...entries, entry].slice(-CLI_MEMORY_MAX_ENTRIES);
  try {
    await saveCliMemory(cwd, next);
  } catch (error) {
    return { ok: false, error: (error as Error).message };
  }
  return { ok: true, entry, total: next.length, added: true };
}

/** 删一条：认完整 id，也认 `heming memory` 列出来的序号（1 起）。 */
export async function removeCliMemory(
  cwd: string,
  key: string,
): Promise<{ ok: true; entry: CliMemoryEntry; total: number } | { ok: false; error: string }> {
  const loaded = await loadCliMemory(cwd);
  if (!loaded) return { ok: false, error: "这个工作区还没有记过任何东西" };
  if (!loaded.ok) return { ok: false, error: `记忆文件坏了：${loaded.error}（${loaded.source}）` };
  const trimmed = key.trim();
  let index = loaded.entries.findIndex((entry) => entry.id === trimmed);
  if (index < 0 && /^\d+$/.test(trimmed)) {
    const ordinal = Number(trimmed);
    if (ordinal >= 1 && ordinal <= loaded.entries.length) index = ordinal - 1;
  }
  if (index < 0) return { ok: false, error: `没有这条记忆：${trimmed}（先跑 heming memory 看看有哪些）` };
  const entry = loaded.entries[index]!;
  const next = loaded.entries.filter((_, i) => i !== index);
  try {
    await saveCliMemory(cwd, next);
  } catch (error) {
    return { ok: false, error: (error as Error).message };
  }
  return { ok: true, entry, total: next.length };
}

/**
 * 按当前提问捞相关的几条。
 *
 * 打分只有一件事：与提问共有的词元数（中文 bigram / ASCII 词，口径与桌面端一致）。
 * 同分时新的优先——「上周说过的偏好」和「刚才纠正过的偏好」冲突时，后者更该被带上。
 */
export function recallCliMemory(
  entries: readonly CliMemoryEntry[],
  query: string,
  limit = CLI_MEMORY_RECALL_LIMIT,
): CliMemoryEntry[] {
  const wanted = new Set(tokenize(query));
  if (wanted.size === 0 || entries.length === 0) return [];
  const scored: { entry: CliMemoryEntry; score: number }[] = [];
  for (const entry of entries) {
    let score = 0;
    for (const token of tokenize(entry.text)) if (wanted.has(token)) score += 1;
    if (score > 0) scored.push({ entry, score });
  }
  scored.sort((a, b) => b.score - a.score || b.entry.at.localeCompare(a.entry.at));
  return scored.slice(0, Math.max(0, limit)).map((item) => item.entry);
}

/** 注入段：没捞到就返回空串（调用方据此整段不注入，别留个空标题）。 */
export function memorySection(entries: readonly CliMemoryEntry[]): string {
  if (entries.length === 0) return "";
  const lines = [CLI_MEMORY_HEADING, ""];
  let used = CLI_MEMORY_HEADING.length;
  for (const entry of entries) {
    const line = `- ${entry.text}`;
    if (used + line.length + 1 > CLI_MEMORY_SECTION_MAX_CHARS) break;
    lines.push(line);
    used += line.length + 1;
  }
  // 一条都没放下就别给个光标题（标题会让人误以为下面还有内容）。
  return lines.length > 2 ? lines.join("\n") : "";
}

/** 给终端看的摘要：读到了几条、读不出来为什么。 */
export function describeCliMemory(load: CliMemoryLoad): string {
  if (load === null) return `记忆：还没有（记过的会存在 ${CLI_MEMORY_FILE}，下次运行自动带上相关的几条）。`;
  if (!load.ok) return `记忆：读不出来（${load.error}）——这次按没有记忆跑。`;
  if (load.entries.length === 0) return `记忆：文件是空的（${CLI_MEMORY_FILE}）。`;
  return `记忆：${load.entries.length} 条（来自 ${CLI_MEMORY_FILE}）。`;
}

/** `remember` 的工具声明：只收一段文字。 */
export function rememberSpec(): unknown {
  return {
    type: "function",
    function: {
      name: REMEMBER_TOOL,
      description: [
        "把一件「以后也要算数」的事记进这个工作区（写 .heming/memory.json），下次运行会自动带上相关的几条。",
        "只在用户明确要求记住、或用户给出长期有效的偏好/约定时调用；一次记一件事、写成一句完整的话。",
      ].join(""),
      parameters: {
        type: "object",
        properties: {
          text: {
            type: "string",
            description: `要记下的那句话（最多 ${CLI_MEMORY_MAX_TEXT} 字，超出会被截断）`,
          },
        },
        required: ["text"],
        additionalProperties: false,
      },
    },
  };
}

/** `remember` 的调用结果文案（交给模型，让它知道要不要再说一遍）。 */
export function rememberResultText(
  outcome: { ok: true; entry: CliMemoryEntry; total: number; added: boolean } | { ok: false; error: string },
): { ok: boolean; text: string } {
  if (!outcome.ok) {
    return {
      ok: false,
      text: `没能记下来：${outcome.error}。这是本机存储的问题，重试同样的调用不会好；告诉用户这件事没记住。`,
    };
  }
  if (!outcome.added) {
    return { ok: true, text: `这条已经记过了，没有重复写。这个工作区现在有 ${outcome.total} 条记忆。` };
  }
  return {
    ok: true,
    text: `已记下：${outcome.entry.text}（这个工作区现在有 ${outcome.total} 条记忆，下次运行会自动带上相关的几条）。`,
  };
}