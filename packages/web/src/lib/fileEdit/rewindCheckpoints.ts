/**
 * 轮次检查点（d.290）：`/rewind N` 的底料。
 *
 * 为什么要有：`turnWrites`（d.176/d.185）只能撤回「刚刚这一轮」，而长任务真正的痛点是
 * 「第三轮手滑改坏了，我想连那轮一起退回去」。codex / Claude Code 的 rewind 就是干这个的。
 *
 * 怎么做到的：桌面端的写盘备份是「每个路径一份、用一次就消费」（`file-fs.js` 的
 * `undoWrite`），没法按时间点批量还原；所以这里换一条更笨但更可靠的路——
 * **在写之前**用文件桥把目标文件的原内容读下来，按轮存进 localStorage。
 * 回滚时把 `before` 原样写回去，原本不存在的文件则删掉。
 *
 * d.292 起每轮还记一个「对话边界」（`afterMessageId`）：回退时把那之后的消息删掉，
 * 对话和文件一起退（只留你发的那句）。老数据没有边界信息，那就只退文件。
 *
 * d.335 起每轮还记下「跑过哪些命令」（`commands`）：`run_command` 改了什么文件抓不到原文，
 * 但至少要让人知道这一轮跑过命令——否则 `/rewind` 说「都退回去了」会让人误以为命令的破坏也退了。
 *
 * 已知边界（写进用户可见的文案，不藏）：
 * - 只覆盖和鸣自己的写工具（`file_write` / `file_edit` / `file_patch`）；
 *   `run_command` 之类绕过工具桥的改动抓不到，只能把命令本身列出来让人自己核对。
 * - 单个文件超过 200k 字符、或读出来是二进制 / GBK（写回会改编码）时不硬还原，记成 skipped。
 * - 对话只退「这一轮之后的消息」：别的窗口在这期间新发的消息也会一起消失（本地窗口优先）。
 * - localStorage 不可用或配额满时静默降级——宁可不记，也不能打断正在跑的一轮。
 */

import type { ToolBridge } from "../agentStream.js";
import { getFileBridge } from "./bridge.js";
import type { FileRoot } from "./paths.js";
import { FILE_EDIT_TOOL, FILE_PATCH_TOOL, FILE_WRITE_TOOL, targetsOfCall } from "./ruleTargets.js";
import { SHELL_TOOL } from "../shell/tool.js";

export const REWIND_CHECKPOINTS_KEY = "heming.rewindCheckpoints.v1";

/** 每个会话最多保留多少轮检查点；再多就淘汰最老的。 */
export const REWIND_MAX_TURNS = 20;

/** 最多保留多少个会话的检查点。 */
export const REWIND_MAX_SESSIONS = 20;

/** 单个文件超过这个字符数就不存（存了也多半写不回去，还容易把配额撑爆）。 */
export const REWIND_MAX_FILE_CHARS = 200_000;

/** 单轮抓取的总字符预算：一轮改了几十个大文件时，超出部分不记。 */
export const REWIND_MAX_TURN_CHARS = 1_000_000;

/** 每一轮顺手记下的那句提问最多留多少字（回退后放回输入框用）。 */
export const REWIND_MAX_PROMPT_CHARS = 2000;

/** 每轮最多记几条命令（`run_command` 的改动抓不到原文，至少要记下跑过什么）。 */
export const REWIND_MAX_COMMANDS = 10;

/** 单条命令描述最多留多少字（多行命令压成一行）。 */
export const REWIND_MAX_COMMAND_CHARS = 200;

/** 按字符数截断但不劈开 emoji 代理对（d.412 回归）。 */
function clipAtCharBoundary(text: string, max: number): string {
  if (text.length <= max) return text;
  let cut = max;
  const at = text.charCodeAt(cut - 1);
  if (at >= 0xd800 && at <= 0xdbff) {
    const next = text.charCodeAt(cut);
    if (next >= 0xdc00 && next <= 0xdfff) cut -= 1;
  }
  return text.slice(0, cut);
}

/** 抓不到 / 不能安全还原的原因。 */
export type RewindSkipReason = "too-large" | "binary" | "encoding" | "unreadable";

/** 一轮里对某个文件抓到的「改之前」。 */
export interface CheckpointFile {
  /** 绝对路径（正斜杠，与 `ToolBridge.execute` 返回的 `writes` 一致）。 */
  path: string;
  /** 写之前的内容；`null` = 那一轮之前这个文件还不存在（回滚时删除它）。 */
  before: string | null;
  /** 有值 = 这份没抓到可还原的内容，回滚时跳过并如实汇报。 */
  skipped?: RewindSkipReason;
}

/** 一轮的检查点。 */
export interface TurnCheckpoint {
  id: string;
  /** 这一轮落盘的时间（ms）。 */
  at: number;
  /** 关联的助手消息 id（有就记，方便以后把「回退到哪条消息」接起来）。 */
  messageId?: string;
  /**
   * 这一轮开始之前的「对话边界」：发这句之前会话里最后一条消息的 id
   * （`null` = 当时会话是空的，`undefined` = 老数据不知道边界）。
   *
   * 回退时把边界之后的消息删掉，就等于把对话退回到这一轮之前。
   */
  afterMessageId?: string | null;
  /**
   * 这一轮你发的那句（最多 2000 字）。回退后放回输入框：
   * 它的消息跟着对话一起退掉了，不还回去就等于让你重打一遍。
   */
  prompt?: string;
  /**
   * 这一轮在本机跑过的命令（最多 `REWIND_MAX_COMMANDS` 条，每条一句话）。
   *
   * 命令改了哪些文件、改之前是什么样，这里**都不知道**——记下来是为了回退时如实说清
   * 「这几条命令带来的改动没有原文可还原」，而不是让人以为整轮都退干净了。
   */
  commands?: string[];
  files: CheckpointFile[];
}

/** 回滚计划：要写回去的内容、要删掉的文件、以及跳过的那些。 */
export interface RewindPlan {
  /** 这次回退多少轮。 */
  turns: number;
  restore: { path: string; content: string }[];
  remove: string[];
  skipped: { path: string; reason: RewindSkipReason }[];
  /**
   * 对话要退到哪一条之后（窗口里最早那条有边界的检查点的 `afterMessageId`）；
   * 整窗都没有边界信息时是 `undefined` —— 那就只退文件、不动对话。
   */
  afterMessageId?: string | null;
  /** 这一轮你发的那句（窗口里最早那条有记录的），回退后放回输入框。 */
  prompt?: string;
  /** 窗口里跑过的命令（去重、按时间先后，最多 10 条）：它们改的东西退不回去。 */
  commands: string[];
}

type Store = Record<string, TurnCheckpoint[]>;

const STORAGE_READ_ERRORS = new Set(["invalid-path", "outside-roots", "no-roots"]);

let loaded = false;
let store: Store = {};

/** 每轮抓取的缓冲区（只在内存里，收口时一次性落库）。 */
interface TurnBuffer {
  at: number;
  messageId?: string;
  afterMessageId?: string | null;
  prompt?: string;
  /** 这一轮跑过的命令（见 `TurnCheckpoint.commands`）。 */
  commands: string[];
  /** 按路径去重、保留最早那份 `before`（这一轮第一次动它之前的样子才是要回到的样子）。 */
  files: Map<string, CheckpointFile>;
  chars: number;
}

const buffers = new Map<string, TurnBuffer>();
let sequence = 0;

function isSkipReason(value: unknown): value is RewindSkipReason {
  return value === "too-large" || value === "binary" || value === "encoding" || value === "unreadable";
}

function isCheckpointFile(value: unknown): value is CheckpointFile {
  if (!value || typeof value !== "object") return false;
  const item = value as Partial<CheckpointFile>;
  if (typeof item.path !== "string" || item.path.length === 0) return false;
  if (!(item.before === null || typeof item.before === "string")) return false;
  return item.skipped === undefined || isSkipReason(item.skipped);
}

function isTurnCheckpoint(value: unknown): value is TurnCheckpoint {
  if (!value || typeof value !== "object") return false;
  const item = value as Partial<TurnCheckpoint>;
  return (
    typeof item.id === "string" &&
    item.id.length > 0 &&
    typeof item.at === "number" &&
    Number.isFinite(item.at) &&
    Array.isArray(item.files) &&
    item.files.every(isCheckpointFile) &&
    (item.messageId === undefined || typeof item.messageId === "string") &&
    (item.afterMessageId === undefined || item.afterMessageId === null || typeof item.afterMessageId === "string") &&
    (item.prompt === undefined || typeof item.prompt === "string") &&
    (item.commands === undefined ||
      (Array.isArray(item.commands) && item.commands.every((command) => typeof command === "string")))
  );
}

/** 命令压成一行并截断：检查点里存的是一句人话，不是完整脚本。 */
function normalizeCommandText(raw: string): string {
  const oneLine = raw.replace(/\s+/g, " ").trim();
  if (!oneLine) return "";
  return oneLine.length > REWIND_MAX_COMMAND_CHARS ? `${clipAtCharBoundary(oneLine, REWIND_MAX_COMMAND_CHARS)}…` : oneLine;
}

/** 去重、保序、限量：同一轮跑两次同样的命令只记一条。 */
function normalizeCommands(value: readonly string[] | undefined): string[] {
  if (!value || value.length === 0) return [];
  const out: string[] = [];
  for (const raw of value) {
    const text = normalizeCommandText(raw);
    if (!text || out.includes(text)) continue;
    out.push(text);
    if (out.length >= REWIND_MAX_COMMANDS) break;
  }
  return out;
}

function readStorage(): Store {
  if (typeof localStorage === "undefined") return {};
  try {
    const raw = localStorage.getItem(REWIND_CHECKPOINTS_KEY);
    if (!raw) return {};
    const parsed: unknown = JSON.parse(raw);
    if (!parsed || typeof parsed !== "object") return {};
    const out: Store = {};
    for (const [conversationId, list] of Object.entries(parsed as Record<string, unknown>)) {
      if (!conversationId || !Array.isArray(list)) continue;
      const checkpoints = list.filter(isTurnCheckpoint).map((item) => ({
        id: item.id,
        at: item.at,
        files: item.files.map((file) =>
          file.skipped ? { path: file.path, before: file.before, skipped: file.skipped } : { path: file.path, before: file.before },
        ),
        ...(item.messageId ? { messageId: item.messageId } : {}),
        ...(item.afterMessageId !== undefined ? { afterMessageId: item.afterMessageId } : {}),
        ...(item.prompt ? { prompt: item.prompt } : {}),
        ...(item.commands && item.commands.length > 0 ? { commands: item.commands } : {}),
      }));
      if (checkpoints.length > 0) out[conversationId] = checkpoints;
    }
    return out;
  } catch {
    return {};
  }
}

function writeStorage(value: Store): void {
  if (typeof localStorage === "undefined") return;
  try {
    if (Object.keys(value).length === 0) localStorage.removeItem(REWIND_CHECKPOINTS_KEY);
    else localStorage.setItem(REWIND_CHECKPOINTS_KEY, JSON.stringify(value));
  } catch {
    // 配额满 / 隐私模式：内存里仍然对，只是重启后丢。绝不抛。
  }
}

function ensureLoaded(): void {
  if (loaded) return;
  loaded = true;
  store = readStorage();
}

function latestAt(list: readonly TurnCheckpoint[]): number {
  let latest = 0;
  for (const item of list) if (item.at > latest) latest = item.at;
  return latest;
}

/** 按保留上限裁剪（会话数 + 每会话轮数）；会返回新对象，不改入参。 */
function prune(value: Store, keepConversationId?: string): Store {
  const sessions = Object.entries(value);
  if (sessions.length > REWIND_MAX_SESSIONS) {
    const sorted = [...sessions].sort((a, b) => latestAt(b[1]) - latestAt(a[1]));
    const keep = new Set(sorted.slice(0, REWIND_MAX_SESSIONS).map(([id]) => id));
    if (keepConversationId) keep.add(keepConversationId);
    for (const [id] of sessions) if (!keep.has(id)) delete value[id];
  }
  for (const [id, list] of Object.entries(value)) {
    if (list.length <= REWIND_MAX_TURNS) continue;
    value[id] = [...list].sort((a, b) => a.at - b.at).slice(-REWIND_MAX_TURNS);
  }
  return value;
}

function sortNewestFirst(list: readonly TurnCheckpoint[]): TurnCheckpoint[] {
  return [...list].sort((a, b) => b.at - a.at);
}

/** 某会话的检查点：最近的排最前。没有记录时返回空数组（引用稳定）。 */
export function getTurnCheckpoints(conversationId: string): readonly TurnCheckpoint[] {
  ensureLoaded();
  if (!conversationId) return EMPTY;
  return sortNewestFirst(store[conversationId] ?? []);
}

const EMPTY: readonly TurnCheckpoint[] = Object.freeze([]);

/** 直接落一整轮检查点（抓取路径与测试都用它）。返回该会话现在的轮数。 */
export function recordTurnCheckpoint(
  conversationId: string,
  checkpoint: Omit<TurnCheckpoint, "id"> & { id?: string },
  now = Date.now(),
): number {
  ensureLoaded();
  const files = checkpoint.files.filter(isCheckpointFile);
  const commands = normalizeCommands(checkpoint.commands);
  // 只跑了命令、没走写工具的轮次也要留：不然回退时连「这轮跑过命令」都不会被提起。
  if (!conversationId || (files.length === 0 && commands.length === 0)) return store[conversationId]?.length ?? 0;
  const at = Number.isFinite(checkpoint.at) ? checkpoint.at : now;
  const id = checkpoint.id && checkpoint.id.length > 0 ? checkpoint.id : `turn-${at}-${(sequence += 1)}`;
  const entry: TurnCheckpoint = {
    id,
    at,
    files: files.map((file) =>
      file.skipped ? { path: file.path, before: file.before, skipped: file.skipped } : { path: file.path, before: file.before },
    ),
    ...(checkpoint.messageId ? { messageId: checkpoint.messageId } : {}),
    // d.292：边界与提问必须跟着落盘，否则「退文件也退对话」只在内存里成立
    ...(checkpoint.afterMessageId !== undefined ? { afterMessageId: checkpoint.afterMessageId } : {}),
    ...(checkpoint.prompt ? { prompt: checkpoint.prompt } : {}),
    // d.335：命令本身要留下来，回退时才能说清「哪些改动抓不到原文」
    ...(commands.length > 0 ? { commands } : {}),
  };
  const current = store[conversationId] ?? [];
  // 同一轮重复落（收口可能被调两次）就替换，不叠加。
  const next = [...current.filter((item) => item.id !== id), entry].sort((a, b) => a.at - b.at);
  store = prune({ ...store, [conversationId]: next }, conversationId);
  writeStorage(store);
  return store[conversationId]?.length ?? 0;
}

/** 丢掉最近 `count` 轮（回滚成功后调用：退回去的轮次不该还能再退一次）。 */
export function dropTurnCheckpoints(conversationId: string, count: number): number {
  ensureLoaded();
  if (!conversationId || !Number.isFinite(count) || count <= 0) return store[conversationId]?.length ?? 0;
  const current = store[conversationId] ?? [];
  if (current.length === 0) return 0;
  const keep = sortNewestFirst(current).slice(Math.trunc(count));
  const next = { ...store };
  if (keep.length === 0) delete next[conversationId];
  else next[conversationId] = [...keep].sort((a, b) => a.at - b.at);
  store = next;
  writeStorage(store);
  return store[conversationId]?.length ?? 0;
}

/** 清掉某个会话的检查点（不影响文件本身）。 */
export function clearTurnCheckpoints(conversationId: string): void {
  ensureLoaded();
  buffers.delete(conversationId);
  if (!store[conversationId]) return;
  const next = { ...store };
  delete next[conversationId];
  store = next;
  writeStorage(store);
}

/** 清空全部（测试与「重置本地数据」用）。 */
export function resetRewindCheckpoints(): void {
  loaded = true;
  store = {};
  buffers.clear();
  sequence = 0;
  writeStorage(store);
}

/**
 * 回滚计划：退回最近 `turns` 轮。
 *
 * 同一文件在窗口里被改过多次时，要回到**窗口最早那一轮动手之前**的样子——
 * 所以从老到新扫、每路径只取第一次出现的那份（最新的那份是中间态，写回去会少退几轮）。
 *
 * 返回 null = 没有那么多轮可退（调用方按「没那么多」回话，不要静默当成成功）。
 */
export function planRewind(conversationId: string, turns: number): RewindPlan | null {
  ensureLoaded();
  if (!conversationId) return null;
  const total = Math.trunc(turns);
  if (!Number.isFinite(total) || total < 1) return null;
  const newest = sortNewestFirst(store[conversationId] ?? []);
  if (newest.length === 0 || total > newest.length) return null;
  const window = newest.slice(0, total).sort((a, b) => a.at - b.at);
  const seen = new Set<string>();
  const plan: RewindPlan = { turns: total, restore: [], remove: [], skipped: [], commands: [] };
  for (const checkpoint of window) {
    // 对话边界取窗口里最早那条有记录的：退到那一轮开始之前，才是这一整个窗口之前
    if (plan.afterMessageId === undefined && checkpoint.afterMessageId !== undefined) {
      plan.afterMessageId = checkpoint.afterMessageId;
    }
    if (plan.prompt === undefined && checkpoint.prompt) plan.prompt = checkpoint.prompt;
    // 命令按时间先后拼起来（去重、限量）：它们改的东西一律退不回去，必须让人看见。
    for (const command of checkpoint.commands ?? []) {
      if (plan.commands.includes(command) || plan.commands.length >= REWIND_MAX_COMMANDS) continue;
      plan.commands.push(command);
    }
    for (const file of checkpoint.files) {
      if (seen.has(file.path)) continue;
      seen.add(file.path);
      if (file.skipped) plan.skipped.push({ path: file.path, reason: file.skipped });
      else if (file.before === null) plan.remove.push(file.path);
      else plan.restore.push({ path: file.path, content: file.before });
    }
  }
  return plan;
}

function describeAgo(at: number, now: number): string {
  const delta = Math.max(0, now - at);
  if (delta < 60_000) return "刚刚";
  if (delta < 3_600_000) return `${Math.floor(delta / 60_000)} 分钟前`;
  if (delta < 86_400_000) return `${Math.floor(delta / 3_600_000)} 小时前`;
  return `${Math.floor(delta / 86_400_000)} 天前`;
}

function shortName(path: string): string {
  const parts = path.split("/");
  return parts[parts.length - 1] ?? path;
}

const EMPTY_HINT =
  "还没有可回滚的检查点：先让它真的改过文件（`/rewind` 靠写盘前抓到的原内容还原，`run_command` 改的文件抓不到）。";

/** `/rewind` 不带参数时的说明：最近几轮、各改了什么、怎么退。 */
export function describeTurnCheckpoints(conversationId: string, now = Date.now()): string {
  const list = getTurnCheckpoints(conversationId);
  if (list.length === 0) return EMPTY_HINT;
  const lines = list.map((checkpoint, index) => {
    const names = checkpoint.files.slice(0, 3).map((file) => shortName(file.path));
    const more = checkpoint.files.length > names.length ? ` 等 ${checkpoint.files.length} 个` : "";
    const skipped = checkpoint.files.filter((file) => file.skipped).length;
    const skippedText = skipped > 0 ? `，其中 ${skipped} 个抓不到原文（会跳过）` : "";
    const commandCount = checkpoint.commands?.length ?? 0;
    const commandText = commandCount > 0 ? `，跑过 ${commandCount} 条命令（改的东西退不回去）` : "";
    return `${index + 1}. ${describeAgo(checkpoint.at, now)} · ${checkpoint.files.length} 个文件（${names.join("、")}${more}）${skippedText}${commandText}`;
  });
  return [
    `可回滚的检查点（共 ${list.length} 轮）：`,
    ...lines,
    `发 \`/rewind 1\` 退回最近一轮、\`/rewind ${Math.min(2, list.length)}\` 退回 ${Math.min(2, list.length)} 轮（数字越大退得越多）。文件退回去，这几轮的对话也一起退掉（只留你发的那句）。`,
  ].join("\n");
}

/** 一个文件「写之前」的抓取结果：null = 这个目标不用记（目录、路径非法等）。 */
export async function captureFileBefore(
  bridge: { read(payload: { roots: FileRoot[]; path: string }): Promise<unknown> },
  roots: FileRoot[],
  absolute: string,
): Promise<CheckpointFile | null> {
  let response: unknown;
  try {
    response = await bridge.read({ roots, path: absolute });
  } catch {
    return { path: absolute, before: null, skipped: "unreadable" };
  }
  if (!response || typeof response !== "object") return { path: absolute, before: null, skipped: "unreadable" };
  const result = response as { ok?: boolean; content?: unknown; encoding?: unknown; code?: unknown };
  if (result.ok === true) {
    if (typeof result.content !== "string") return { path: absolute, before: null, skipped: "unreadable" };
    if (result.encoding === "gbk") return { path: absolute, before: null, skipped: "encoding" };
    if (result.content.length > REWIND_MAX_FILE_CHARS) return { path: absolute, before: null, skipped: "too-large" };
    return { path: absolute, before: result.content };
  }
  const code = typeof result.code === "string" ? result.code : "";
  // 文件还不存在 = 这一轮是新建，回滚时删掉它就是「改之前的样子」。
  if (code === "not-found") return { path: absolute, before: null };
  if (code === "too-large") return { path: absolute, before: null, skipped: "too-large" };
  if (code === "binary") return { path: absolute, before: null, skipped: "binary" };
  // 路径本身不合法（越界、符号链接）：这次写也多半会被拒，不用记。
  if (STORAGE_READ_ERRORS.has(code)) return null;
  return { path: absolute, before: null, skipped: "unreadable" };
}

function openBuffer(conversationId: string, now: number): TurnBuffer {
  const existing = buffers.get(conversationId);
  if (existing) return existing;
  const created: TurnBuffer = { at: now, files: new Map(), chars: 0, commands: [] };
  buffers.set(conversationId, created);
  return created;
}

/** 这一轮已经开始抓取了（同一轮重复调用不重置，否则最早那份 before 会被覆盖）。 */
export function beginRewindTurn(
  conversationId: string,
  now = Date.now(),
  messageId?: string,
  afterMessageId?: string | null,
  prompt?: string,
): void {
  if (!conversationId) return;
  const buffer = openBuffer(conversationId, now);
  if (messageId && !buffer.messageId) buffer.messageId = messageId;
  // `null`（当时会话是空的）也要记下，才与「不知道边界」的 undefined 区分开
  if (afterMessageId !== undefined && buffer.afterMessageId === undefined) {
    buffer.afterMessageId = afterMessageId;
  }
  const trimmedPrompt = prompt?.trim();
  if (trimmedPrompt && !buffer.prompt) buffer.prompt = clipAtCharBoundary(trimmedPrompt, REWIND_MAX_PROMPT_CHARS);
}

/** 记一个文件（同路径只留最早那份；超预算直接丢，返回是否记下）。 */
export function noteRewindFile(conversationId: string, file: CheckpointFile, now = Date.now()): boolean {
  if (!conversationId || !file.path) return false;
  const buffer = openBuffer(conversationId, now);
  if (buffer.files.has(file.path)) return false;
  const size = file.before?.length ?? 0;
  if (buffer.chars + size > REWIND_MAX_TURN_CHARS) return false;
  buffer.files.set(file.path, file);
  buffer.chars += size;
  return true;
}

/** 记一条这一轮跑过的命令（同一条只记一次；超过上限就丢，返回是否记下）。 */
export function noteRewindCommand(conversationId: string, command: string, now = Date.now()): boolean {
  if (!conversationId) return false;
  const text = normalizeCommandText(command);
  if (!text) return false;
  const buffer = openBuffer(conversationId, now);
  if (buffer.commands.includes(text) || buffer.commands.length >= REWIND_MAX_COMMANDS) return false;
  buffer.commands.push(text);
  return true;
}

/** 收口：把这一轮抓到的落成检查点并清空缓冲。没抓到东西就返回 null（不留空轮）。 */
export function closeRewindTurn(conversationId: string, now = Date.now()): TurnCheckpoint | null {
  const buffer = buffers.get(conversationId);
  buffers.delete(conversationId);
  // 只跑了命令、一个文件也没写工具的轮次也要留：它恰恰是最需要提醒「退不回去」的那种。
  if (!buffer || (buffer.files.size === 0 && buffer.commands.length === 0)) return null;
  const files = [...buffer.files.values()].sort((a, b) => a.path.localeCompare(b.path));
  const entry: TurnCheckpoint = {
    id: `turn-${buffer.at}-${(sequence += 1)}`,
    at: buffer.at,
    files,
    ...(buffer.messageId ? { messageId: buffer.messageId } : {}),
    ...(buffer.afterMessageId !== undefined ? { afterMessageId: buffer.afterMessageId } : {}),
    ...(buffer.prompt ? { prompt: buffer.prompt } : {}),
    ...(buffer.commands.length > 0 ? { commands: [...buffer.commands] } : {}),
  };
  const count = recordTurnCheckpoint(conversationId, entry, now);
  return count > 0 ? entry : null;
}

/**
 * 给工具桥套一层「写之前先抓原文」。
 *
 * 包在**最里层**（capability registry 的桥外面、子代理/工作流/面板包装的内侧），
 * 这样主模型、子代理、工作流的写盘都会经过它；只在真正执行前抓，闸门拒绝时不抓——
 * 被拒的调用没改文件，记下来只会让用户以为退回去会变。
 */
export function withRewindCapture(
  bridge: ToolBridge,
  options: { conversationId: () => string; roots: () => FileRoot[]; now?: () => number },
): ToolBridge {
  const now = options.now ?? (() => Date.now());
  const wrapped: ToolBridge = {
    tools: bridge.tools,
    execute: async (call, execOptions) => {
      await captureForCall(call, options, now()).catch(() => undefined);
      return bridge.execute(call, execOptions);
    },
  };
  if (bridge.meta) wrapped.meta = bridge.meta;
  return wrapped;
}

const CAPTURED_TOOLS: readonly string[] = [FILE_WRITE_TOOL, FILE_EDIT_TOOL, FILE_PATCH_TOOL];

/** 从 `run_command` 的参数里取出那句命令（拿不到就退回整段参数，至少让人看出跑过什么）。 */
function commandOfCall(argsJson: string): string {
  try {
    const parsed: unknown = JSON.parse(argsJson);
    if (parsed && typeof parsed === "object") {
      const record = parsed as Record<string, unknown>;
      for (const key of ["command", "cmd", "script"]) {
        const value = record[key];
        if (typeof value === "string" && value.trim()) return value;
      }
    }
  } catch {
    // 参数不是 JSON：照原样记下来
  }
  return argsJson;
}

/** 回退时补一句：这一轮回退覆盖不到命令造成的改动。没有命令返回空串。 */
export function describeShellCommandsNote(commands: readonly string[]): string {
  if (commands.length === 0) return "";
  const shown = commands.slice(0, 3).map((command) => `\`${command}\``);
  const more = commands.length > shown.length ? ` 等 ${commands.length} 条` : "";
  return `另外这一轮跑过 ${commands.length} 条命令（${shown.join("、")}${more}）：命令改了哪些文件这里看不到，也没有原文，退不回去——需要的话用 git 或自己的备份核对。`;
}

async function captureForCall(
  call: { name: string; arguments: string },
  options: { conversationId: () => string; roots: () => FileRoot[] },
  now: number,
): Promise<void> {
  // 命令不抓原文（抓不到），但要把命令本身记下来：回退时才能如实说「这部分退不回去」。
  if (call.name === SHELL_TOOL) {
    const conversationId = options.conversationId();
    if (!conversationId) return;
    noteRewindCommand(conversationId, commandOfCall(call.arguments), now);
    return;
  }
  if (!CAPTURED_TOOLS.includes(call.name)) return;
  const conversationId = options.conversationId();
  if (!conversationId) return;
  const fileBridge = getFileBridge();
  if (!fileBridge?.read) return;
  const roots = options.roots();
  if (roots.length === 0) return;
  const targets = targetsOfCall({ name: call.name, argsJson: call.arguments }, roots);
  if (!targets) return;
  for (let index = 0; index < targets.absolute.length; index += 1) {
    if (targets.kinds?.[index] === "dir") continue;
    const captured = await captureFileBefore(fileBridge, roots, targets.absolute[index]!);
    if (captured) noteRewindFile(conversationId, captured, now);
  }
}
