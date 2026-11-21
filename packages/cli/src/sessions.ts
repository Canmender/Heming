/**
 * CLI 会话存档：让 `heming run` 能接着上次聊（对标 codex 的 `resume` / `--continue`）。
 *
 * 为什么存在：本仓库的 CLI 之前是**单轮**的——`fetchHistory` 固定返回空数组，
 * 每跑一次就忘掉上一次说过什么。长任务里这很致命：第一步「读一遍仓库结构」，
 * 第二步要「按刚才看到的改」，用户只能把结论复制回 prompt 里。桌面端本来就有会话，
 * CLI 没有，就成了「同一件事在终端里做不到」。
 *
 * 设计取舍：
 * - **只存文字**（user 提问 + assistant 最终回答）。工具调用/中间话术不进存档：
 *   它们体积大、依赖当轮工具清单，重放旧 transcript 反而会让模型以为工具还在。
 * - **一个会话一个文件**（`<dir>/<id>.json`）。不用单个大 JSON：并发两个 `heming run`
 *   时后者会覆盖前者的整份记录。
 * - **写盘原子化**（临时文件 + rename）。CI 里半截 JSON 比「没有存档」更难查。
 * - **读的一侧全部容错**：坏文件跳过、缺字段补默认值、目录不存在当空。
 *   存档坏掉最多丢历史，绝不能让 `heming run` 起不来。
 * - **目录可覆盖**（`--session-dir` / `HEMING_CLI_SESSION_DIR`）：默认放用户主目录，
 *   但测试与「每个仓库一套会话」都需要换地方。
 */

import { promises as fs } from "node:fs";
import os from "node:os";
import path from "node:path";

/** 存档格式版本：将来字段变了靠它决定兼容策略（现在只认 1）。 */
export const SESSION_FORMAT_VERSION = 1;

/** 存档目录的环境变量名（与 `--session-dir` 等价，命令行优先）。 */
export const SESSION_DIR_ENV = "HEMING_CLI_SESSION_DIR";

/** 最多保留多少个会话：再多就按 `updatedAt` 从旧到新删掉。 */
export const MAX_SESSIONS = 50;

/** 单个会话最多存多少轮对话（一问一答算两条），超了丢最早的。 */
export const MAX_STORED_TURNS = 200;

/** 单条消息最多存多少字符：整份 README 当回答时不该把存档撑到几十 MB。 */
export const MAX_STORED_MESSAGE_CHARS = 20_000;

/** 存档 id 的字符集：只允许字母数字与短横线——`--resume` 的值会被拼进文件路径。 */
const SESSION_ID_RE = /^[0-9]{8}-[0-9]{6}-[a-z0-9]{4}$/;

/**
 * 比较工作目录用的规范形：解析成绝对路径、统一正斜杠、去末尾斜杠，
 * Windows 上再折成小写（同一个目录能写成 `D:/repo`、`d:\\Repo`）。
 */
function comparableCwd(value: string): string {
  const resolved = path.resolve(value.trim() || ".").replace(/\\/g, "/").replace(/\/+$/, "");
  return process.platform === "win32" ? resolved.toLowerCase() : resolved;
}

export type SessionRole = "user" | "assistant";

export interface SessionTurn {
  role: SessionRole;
  /** 纯文本内容（已按 `MAX_STORED_MESSAGE_CHARS` 截断）。 */
  text: string;
  /** 落盘时间（毫秒）。 */
  at: number;
}

export interface SessionRecord {
  version: number;
  id: string;
  createdAt: number;
  updatedAt: number;
  /** 当时的工作目录：`--continue` 优先接同一目录下的最近一次。 */
  cwd: string;
  /** 当时用的模型 id（只作展示，恢复时不强制沿用）。 */
  model: string;
  turns: SessionTurn[];
}

export interface SessionSummary {
  id: string;
  createdAt: number;
  updatedAt: number;
  cwd: string;
  model: string;
  turns: number;
  /** 最后一条 user 提问，供 `heming sessions` 一眼认出这是哪件事。 */
  lastPrompt: string;
}

export type ReadSessionResult = { ok: true; record: SessionRecord } | { ok: false; error: string };

/** 存档目录：显式参数 > 环境变量 > `~/.heming/cli-sessions`。 */
export function sessionDir(explicit?: string): string {
  const chosen = explicit?.trim() || process.env[SESSION_DIR_ENV]?.trim();
  if (chosen) return path.resolve(chosen);
  return path.join(os.homedir(), ".heming", "cli-sessions");
}

/** 生成会话 id：`20261118-144230-ab12`（时间可读，尾部随机防同秒撞车）。 */
export function newSessionId(now: number = Date.now(), random: () => number = Math.random): string {
  const date = new Date(now);
  const pad = (value: number, width = 2) => String(value).padStart(width, "0");
  const stamp =
    `${date.getFullYear()}${pad(date.getMonth() + 1)}${pad(date.getDate())}-` +
    `${pad(date.getHours())}${pad(date.getMinutes())}${pad(date.getSeconds())}`;
  const tail = Math.floor(random() * 36 ** 4)
    .toString(36)
    .padStart(4, "0")
    .slice(-4);
  return `${stamp}-${tail}`;
}

/** 会话文件路径；id 不合法时返回 null（绝不让 `../` 之类拼进路径）。 */
export function sessionFile(dir: string, id: string): string | null {
  const normalized = id.trim().toLowerCase();
  if (!SESSION_ID_RE.test(normalized)) return null;
  return path.join(dir, `${normalized}.json`);
}

/** 把一条消息裁到存档上限：超长时留开头并注明截断，别让读者以为原文就这么短。 */
function clipText(text: string): string {
  const value = String(text);
  if (value.length <= MAX_STORED_MESSAGE_CHARS) return value;
  // 按码元截会劈开恰落在边界上的 emoji 代理对，孤立代理写进存档再喂回模型就是损坏文本。
  // 末尾若是落单高位代理就退一格（与 shell/tool.ts 的 clip 同口径）。
  let cut = MAX_STORED_MESSAGE_CHARS;
  const boundary = value.charCodeAt(cut - 1);
  if (boundary >= 0xd800 && boundary <= 0xdbff) cut -= 1;
  return `${value.slice(0, cut)}\n…（超过 ${MAX_STORED_MESSAGE_CHARS} 字，存档只留前面这些）`;
}

/** 只留最后 `MAX_STORED_TURNS` 条：会话越长，越早期的内容越该让位。 */
function clipTurns(turns: readonly SessionTurn[]): SessionTurn[] {
  if (turns.length <= MAX_STORED_TURNS) return [...turns];
  return turns.slice(turns.length - MAX_STORED_TURNS);
}

/** 把任意 JSON 值收敛成 SessionRecord；形状不对返回 null（坏存档当没存档）。 */
function asRecord(value: unknown): SessionRecord | null {
  if (!value || typeof value !== "object" || Array.isArray(value)) return null;
  const raw = value as Record<string, unknown>;
  if (typeof raw.id !== "string" || !SESSION_ID_RE.test(raw.id)) return null;
  const createdAt = typeof raw.createdAt === "number" ? raw.createdAt : 0;
  const updatedAt = typeof raw.updatedAt === "number" ? raw.updatedAt : createdAt;
  const cwd = typeof raw.cwd === "string" ? raw.cwd : "";
  const model = typeof raw.model === "string" ? raw.model : "";
  const turns: SessionTurn[] = [];
  if (Array.isArray(raw.turns)) {
    for (const item of raw.turns) {
      if (!item || typeof item !== "object" || Array.isArray(item)) continue;
      const turn = item as Record<string, unknown>;
      if (turn.role !== "user" && turn.role !== "assistant") continue;
      if (typeof turn.text !== "string") continue;
      const at = typeof turn.at === "number" ? turn.at : 0;
      turns.push({ role: turn.role, text: turn.text, at });
    }
  }
  return {
    version: typeof raw.version === "number" ? raw.version : SESSION_FORMAT_VERSION,
    id: raw.id,
    createdAt,
    updatedAt,
    cwd,
    model,
    turns,
  };
}

async function readJsonFile(file: string): Promise<unknown> {
  try {
    return JSON.parse(await fs.readFile(file, "utf8"));
  } catch {
    // 文件不存在 / 不是 JSON / 没权限：都当「没有这份存档」。
    return null;
  }
}

/**
 * 列出存档：按 `updatedAt` 从新到旧，坏文件跳过。
 *
 * `limit` 缺省 `MAX_SESSIONS`（界面/列表用）；传 `Infinity` 取全部——
 * 裁剪旧文件时必须看到全量，否则「已返回上限条数」会让它误以为没有超量文件可删。
 */
export async function listSessions(dir: string = sessionDir(), limit: number = MAX_SESSIONS): Promise<SessionRecord[]> {
  let names: string[];
  try {
    names = await fs.readdir(dir);
  } catch {
    return [];
  }
  const records: SessionRecord[] = [];
  for (const name of names) {
    if (!name.endsWith(".json")) continue;
    const id = name.slice(0, -".json".length);
    if (!SESSION_ID_RE.test(id)) continue;
    const record = asRecord(await readJsonFile(path.join(dir, name)));
    // 文件名与内部 id 不一致：说明文件被手工改过，按文件名认（用户 resume 的是文件名）。
    if (!record) continue;
    records.push(record.id === id ? record : { ...record, id });
  }
  records.sort((a, b) => b.updatedAt - a.updatedAt);
  return limit === Infinity ? records : records.slice(0, Math.max(0, limit));
}

/** 摘要（`heming sessions` 用）：只留一眼能认出来的字段。 */
export function summarize(record: SessionRecord): SessionSummary {
  const lastUser = [...record.turns].reverse().find((turn) => turn.role === "user");
  return {
    id: record.id,
    createdAt: record.createdAt,
    updatedAt: record.updatedAt,
    cwd: record.cwd,
    model: record.model,
    turns: record.turns.length,
    lastPrompt: lastUser ? lastUser.text.replace(/\s+/g, " ").slice(0, 80) : "",
  };
}

/** 读一份存档；不存在 / 坏掉返回 null。 */
export async function readSession(dir: string, id: string): Promise<SessionRecord | null> {
  const file = sessionFile(dir, id);
  if (!file) return null;
  const record = asRecord(await readJsonFile(file));
  if (!record) return null;
  return record.id === id.toLowerCase() ? record : { ...record, id: id.toLowerCase() };
}

/** 写一份存档：建目录 → 裁剪 → 临时文件 + rename → 顺手把超量的旧会话删掉。 */
export async function writeSession(dir: string, record: SessionRecord): Promise<string> {
  const file = sessionFile(dir, record.id);
  if (!file) throw new Error(`会话 id 不合法：${record.id}`);
  await fs.mkdir(dir, { recursive: true });
  const payload: SessionRecord = {
    ...record,
    version: SESSION_FORMAT_VERSION,
    turns: clipTurns(record.turns).map((turn) => ({ ...turn, text: clipText(turn.text) })),
  };
  const temp = `${file}.tmp`;
  await fs.writeFile(temp, `${JSON.stringify(payload, null, 2)}\n`, "utf8");
  await fs.rename(temp, file);
  await pruneSessions(dir, record.id);
  return file;
}

/** 超出 `MAX_SESSIONS` 时删最旧的；刚写的这份永远保留。 */
async function pruneSessions(dir: string, keepId: string): Promise<void> {
  // 必须取全量：用默认的 MAX_SESSIONS 上限时这里永远只有 ≤50 条，
  // 旧的超量文件根本看不到，裁剪分支从不触发（旧会话会无限堆积）。
  const records = await listSessions(dir, Infinity);
  if (records.length <= MAX_SESSIONS) return;
  const doomed = records.slice(MAX_SESSIONS).filter((record) => record.id !== keepId);
  for (const record of doomed) {
    const file = sessionFile(dir, record.id);
    if (!file) continue;
    try {
      await fs.unlink(file);
    } catch {
      // 删不掉就算了：存档多留一条不影响正确性。
    }
  }
}

/**
 * 把 `--resume` 的值解析成一份存档。
 *
 * 支持**唯一前缀**（`--resume 20261118-14`）：让人不必每次抄整串 id。
 * 匹配到多份时列出来让人选，而不是猜一个——猜错等于接到别的任务上，
 * 那比「没接上」糟糕得多。
 */
export async function resolveSession(dir: string, ref: string): Promise<ReadSessionResult> {
  const wanted = ref.trim().toLowerCase();
  if (!wanted) return { ok: false, error: "--resume 需要一个会话 id（用 heming sessions 查看）" };
  if (!/^[0-9a-z-]+$/.test(wanted)) {
    return { ok: false, error: `会话 id 只能含数字、小写字母与短横线，收到「${ref}」` };
  }
  const exact = await readSession(dir, wanted);
  if (exact) return { ok: true, record: exact };
  const records = await listSessions(dir);
  if (records.length === 0) {
    return {
      ok: false,
      error: `没有找到任何会话存档（目录：${dir}）。先跑一次 heming run 再 --resume。`,
    };
  }
  const matches = records.filter((record) => record.id.startsWith(wanted));
  if (matches.length === 0) {
    return {
      ok: false,
      error: `没有匹配「${ref}」的会话（目录：${dir}）。用 heming sessions 看有哪些。`,
    };
  }
  if (matches.length > 1) {
    const listed = matches
      .slice(0, 5)
      .map((record) => `  ${record.id}  ${summarize(record).lastPrompt || "（没有提问）"}`)
      .join("\n");
    return {
      ok: false,
      error: `「${ref}」匹配到 ${matches.length} 个会话，请写得更具体一些：\n${listed}`,
    };
  }
  return { ok: true, record: matches[0]! };
}

/** `--continue`：接「同一工作目录下最近一次」；没有同目录的就接全局最近的。 */
export async function latestSession(dir: string, cwd?: string): Promise<SessionRecord | null> {
  const records = await listSessions(dir);
  if (records.length === 0) return null;
  if (!cwd) return records[0] ?? null;
  const target = comparableCwd(cwd);
  const sameDir = records.find((record) => record.cwd && comparableCwd(record.cwd) === target);
  return sameDir ?? records[0] ?? null;
}

/** 把存档里的轮次转成模型历史：只认 user/assistant 文字（见文件头取舍）。 */
export function toHistory(record: SessionRecord | null): { role: SessionRole; content: string }[] {
  if (!record) return [];
  return record.turns
    .filter((turn) => turn.text.trim().length > 0)
    .map((turn) => ({ role: turn.role, content: turn.text }));
}

/** 追加本轮问答，返回新的记录（不落盘，落盘由调用方决定）。 */
export function appendTurn(
  record: SessionRecord | null,
  input: { id: string; cwd: string; model: string; prompt: string; answer: string; now?: number },
): SessionRecord {
  const now = input.now ?? Date.now();
  const base: SessionRecord = record ?? {
    version: SESSION_FORMAT_VERSION,
    id: input.id,
    createdAt: now,
    updatedAt: now,
    cwd: input.cwd,
    model: input.model,
    turns: [],
  };
  const turns = [...base.turns, { role: "user" as const, text: clipText(input.prompt), at: now }];
  // 回答为空（失败 / 被中断）时只留提问：下次接上时模型至少知道你问过什么。
  if (input.answer.trim()) {
    turns.push({ role: "assistant" as const, text: clipText(input.answer), at: now });
  }
  return {
    ...base,
    updatedAt: now,
    cwd: input.cwd || base.cwd,
    model: input.model || base.model,
    turns: clipTurns(turns),
  };
}

/** 给人看的一行摘要（`heming run` 收尾打印用）。 */
export function describeSession(record: SessionRecord): string {
  const summary = summarize(record);
  const when = new Date(record.updatedAt || record.createdAt);
  const stamp = Number.isNaN(when.getTime())
    ? "未知时间"
    : `${when.getFullYear()}-${String(when.getMonth() + 1).padStart(2, "0")}-${String(when.getDate()).padStart(2, "0")} ` +
      `${String(when.getHours()).padStart(2, "0")}:${String(when.getMinutes()).padStart(2, "0")}`;
  return `${summary.id} · ${stamp} · ${summary.turns} 条 · ${summary.lastPrompt || "（没有提问）"}`;
}
