/*
 * 终端侧的回退日志（d.336）：`heming rewind`。
 *
 * 为什么要有它：桌面端从 d.291 起有 `/rewind`（改坏了能退回去），终端一侧什么也没有——
 * `heming run --allow-danger "重构一半"` 之后想收手，只能指望 git 恰好是干净的。
 * 这里把同一套思路搬到 CLI，但存储与口径按终端的使用习惯重做：
 *
 * - 存哪儿：`.heming/rewind/<运行 id>.json`，一次运行一份。与 `.heming/memory.json` 同一个理由
 *   （仓库就是配置：跟 git 走、能 review、能手删）；一份放一个文件是为了让 git diff 只看这一轮，
 *   而不是每次都重写一个包含 20 轮原文的大 JSON。
 * - 抓什么：只抓**写工具**（`file_write` / `file_edit` / `file_patch`）在动手之前的原文。
 *   `run_command` 抓不到（命令要走哪条路径、改哪些文件，事后才知道）——这类改动退不回去，
 *   回执里必须说清楚，不能让「我跑过 rewind 了」变成虚假的安全感。
 * - 抓不到原文的怎么办：单文件超过 200k 字符、二进制、读失败，记一条 `skipped`，回退时跳过并点名。
 *   宁可少退，也不要把一份残缺内容盖回去。
 * - 上限：20 轮 / 单轮 1MB / 单轮 200 个文件。超了丢最旧的轮次，与桌面端同一加权思路。
 */

import { existsSync } from "node:fs";
import fs from "node:fs/promises";
import path from "node:path";

import type { FileRoot } from "../../../packages/web/src/lib/fileEdit/paths.js";
import { isFileWriteTool, targetsOfCall } from "../../../packages/web/src/lib/fileEdit/ruleTargets.js";

/** 回退日志目录（相对工作区）。 */
export const CLI_REWIND_DIR = ".heming/rewind";
export const CLI_REWIND_VERSION = 1;
/** 最多留多少轮。 */
export const CLI_REWIND_MAX_RUNS = 20;
/** 单个文件最多抓多少字符；超过就跳过（不硬退）。 */
export const CLI_REWIND_MAX_FILE_CHARS = 200_000;
/** 单轮最多抓多少字符（所有文件加起来）。 */
export const CLI_REWIND_MAX_RUN_CHARS = 1_000_000;
/** 单轮最多抓多少个文件。 */
export const CLI_REWIND_MAX_FILES = 200;

/**
 * 命令前后扫盘的上限（d.337）。
 *
 * 跑一条命令之前之后各扫一次工作区、比大小与改动时间，才知道它新建/改过/删掉了哪些文件——
 * 这是「命令改的东西」唯一能拿到的证据：内容没有原文，但**改动范围**能看一眼。
 * 扫描有上限：超过就直接放弃记录（扫不完的一份清单比没有清单更容易骗人）。
 */
export const CLI_REWIND_MAX_SCAN = 4000;

/** 一轮里最多记多少个命令改动（三个清单加起来）。 */
export const CLI_REWIND_MAX_COMMAND_FILES = 100;

/** 扫盘时跳过的目录名：这些地方要么是产物要么是别人家的，扫了只会慢。 */
export const CLI_REWIND_SCAN_SKIP = [
  ".git",
  "node_modules",
  "dist",
  "build",
  "out",
  ".next",
  ".cache",
  "__pycache__",
  ".venv",
  ".idea",
  ".vscode",
] as const;

export type RewindSkipReason = "too-large" | "binary" | "unreadable";

export interface RewindFile {
  /** 工作区相对路径（正斜杠）。 */
  path: string;
  /** 动手之前的原文；`null` = 当时这个文件还不存在（回退时删掉它）。 */
  before: string | null;
  /** 抓不到原文的原因（有它就说明 before 不可信、回退时跳过）。 */
  skipped?: RewindSkipReason;
}

export interface RewindRun {
  id: string;
  at: string;
  files: RewindFile[];
  /** 这一轮里的命令改了什么（没有原文，只有范围）。没有命令改动时不写这个字段。 */
  commandChanges?: CommandChanges;
}

/**
 * 命令改动清单：比的是「跑之前」与「跑之后」两次扫盘的差。
 *
 * 只有范围没有内容，所以：
 * - `created` 能真的退——它们跑之前不存在，删掉就回到了当时的样子；
 * - `modified` / `deleted` 退不回去（没有原文），只能点名让人用 git 核对。
 */
export interface CommandChanges {
  created: string[];
  modified: string[];
  deleted: string[];
}

/** 一次扫盘的快照：相对路径 → 大小与改动时间（不比内容，太慢）。 */
export type CommandManifest = Map<string, { size: number; mtimeMs: number }>;

export interface CliRewindJournal {
  /** 在写工具动手之前调用：按这次调用的目标路径抓一份原文。 */
  note(call: { name: string; arguments: string }): Promise<void>;
  /** 这一轮抓了多少个文件。 */
  size(): number;
  /** 命令动手之前扫一遍工作区（拿不到清单 → null，等于这条命令不记录范围）。 */
  beginCommand(): Promise<CommandManifest | null>;
  /** 命令跑完之后再扫一遍，把差集记进这一轮。 */
  endCommand(before: CommandManifest | null): Promise<void>;
  /** 收尾：有内容才落盘，返回落盘的那一轮（没有改动 → null）。 */
  close(): Promise<RewindRun | null>;
}

export type CliRewindsLoad =
  | { ok: true; runs: RewindRun[] }
  | { ok: false; error: string; source: string }
  | null;

export interface CliRewindPlan {
  /** 要退几轮。 */
  turns: number;
  /** 要写回原样的文件。 */
  restore: { path: string; content: string }[];
  /** 当时还不存在，要删掉的文件。 */
  remove: string[];
  /** 抓不到原文、退不回去的文件。 */
  skipped: { path: string; reason: RewindSkipReason }[];
  /** 命令改过内容或删掉的文件：没有原文，退不回去，只点名（老存档没有这一项）。 */
  commandLost?: { path: string; how: "modified" | "deleted" }[];
}

export type CliRewindApply =
  | { ok: true; written: number; deleted: number; failed: { path: string; error: string }[] }
  | { ok: false; error: string };

/** 回退日志目录的绝对路径（正斜杠）。 */
export function rewindDir(cwd: string): string {
  return `${path.resolve(cwd).replace(/\\/g, "/")}/${CLI_REWIND_DIR}`;
}

/** 一轮的存档文件路径。 */
export function rewindRunPath(cwd: string, id: string): string {
  return `${rewindDir(cwd)}/${id.replace(/[^a-z0-9-]/gi, "_")}.json`;
}

/**
 * 新的运行 id：时间戳 + 四位随机，字典序即时间序。
 *
 * 用时间戳而不是自增序号：两轮之间可能还有别的机器/别的人在同一工作区跑，
 * 自增要读一遍目录才知道下一个是多少，冲突了还会覆盖别人的存档。
 */
export function newRewindId(now: Date = new Date(), random: () => number = Math.random): string {
  const suffix = Math.floor(random() * 0x10000)
    .toString(16)
    .padStart(4, "0");
  const at = now.toISOString().replace(/[-:.TZ]/g, "").slice(0, 14);
  return `${at}-${suffix}`;
}

/** 把参数里的绝对路径换回工作区相对路径（日志里只存相对路径：换台机器也能对上）。 */
function relOf(cwd: string, absolute: string): string | null {
  const root = path.resolve(cwd);
  const abs = path.resolve(absolute);
  const rel = path.relative(root, abs);
  if (!rel || rel.startsWith("..") || path.isAbsolute(rel)) return null;
  return rel.replace(/\\/g, "/");
}

/** 解析一轮的存档；形状不对返回 null（坏文件跳过，不让它毁掉整份列表）。 */
export function parseRewindRun(value: unknown): RewindRun | null {
  if (!value || typeof value !== "object") return null;
  const raw = value as Record<string, unknown>;
  if (raw.version !== CLI_REWIND_VERSION) return null;
  if (typeof raw.id !== "string" || !raw.id) return null;
  if (typeof raw.at !== "string" || !raw.at) return null;
  if (!Array.isArray(raw.files)) return null;
  const files: RewindFile[] = [];
  for (const item of raw.files) {
    if (!item || typeof item !== "object") continue;
    const file = item as Record<string, unknown>;
    if (typeof file.path !== "string" || !file.path) continue;
    if (file.path.includes("..") || path.isAbsolute(file.path)) continue;
    const before = file.before;
    if (before !== null && typeof before !== "string") continue;
    const skipped =
      file.skipped === "too-large" || file.skipped === "binary" || file.skipped === "unreadable"
        ? file.skipped
        : undefined;
    files.push({
      path: file.path.replace(/\\/g, "/"),
      before: skipped ? null : (before as string | null),
      ...(skipped ? { skipped } : {}),
    });
  }
  const commandChanges = parseCommandChanges(raw.commandChanges);
  return { id: raw.id, at: raw.at, files, ...(commandChanges ? { commandChanges } : {}) };
}

/** 解析命令改动清单；形状不对就整块丢掉（不让坏字段影响文件那半）。 */
function parseCommandChanges(value: unknown): CommandChanges | null {
  if (!value || typeof value !== "object") return null;
  const raw = value as Record<string, unknown>;
  const pick = (list: unknown): string[] => {
    if (!Array.isArray(list)) return [];
    const out: string[] = [];
    for (const item of list) {
      if (typeof item !== "string" || !item) continue;
      if (item.includes("..") || path.isAbsolute(item)) continue;
      out.push(item.replace(/\\/g, "/"));
    }
    return out.slice(0, CLI_REWIND_MAX_COMMAND_FILES);
  };
  const created = pick(raw.created);
  const modified = pick(raw.modified);
  const deleted = pick(raw.deleted);
  if (created.length === 0 && modified.length === 0 && deleted.length === 0) return null;
  return { created, modified, deleted };
}

/** 扫一遍工作区：相对路径 → 大小 + 改动时间。超上限就返回 null（扫不完就别报）。 */
export async function scanWorkspaceFiles(
  cwd: string,
  max: number = CLI_REWIND_MAX_SCAN,
): Promise<CommandManifest | null> {
  const root = path.resolve(cwd);
  const skip = new Set<string>(CLI_REWIND_SCAN_SKIP);
  const out: CommandManifest = new Map();
  let truncated = false;
  const walk = async (dir: string): Promise<void> => {
    if (truncated) return;
    let entries: { name: string; isDirectory(): boolean; isFile(): boolean }[];
    try {
      entries = await fs.readdir(dir, { withFileTypes: true });
    } catch {
      return;
    }
    for (const entry of entries) {
      if (truncated) return;
      const abs = path.join(dir, entry.name);
      const rel = path.relative(root, abs).replace(/\\/g, "/");
      if (!rel) continue;
      if (entry.isDirectory()) {
        if (skip.has(entry.name) || rel === CLI_REWIND_DIR) continue;
        await walk(abs);
        continue;
      }
      if (!entry.isFile()) continue;
      if (out.size >= max) {
        truncated = true;
        return;
      }
      try {
        const stat = await fs.stat(abs);
        out.set(rel, { size: stat.size, mtimeMs: stat.mtimeMs });
      } catch {
        // 刚好被删掉/没权限：跳过这一个，不影响整份清单。
      }
    }
  };
  await walk(root);
  return truncated ? null : out;
}

/** 两次扫盘的差：新建 / 改过 / 删掉。 */
export function diffManifests(before: CommandManifest, after: CommandManifest): CommandChanges {
  const created: string[] = [];
  const modified: string[] = [];
  const deleted: string[] = [];
  for (const [rel, now] of after) {
    const then = before.get(rel);
    if (!then) {
      created.push(rel);
      continue;
    }
    if (then.size !== now.size || then.mtimeMs !== now.mtimeMs) modified.push(rel);
  }
  for (const rel of before.keys()) {
    if (!after.has(rel)) deleted.push(rel);
  }
  created.sort();
  modified.sort();
  deleted.sort();
  return { created, modified, deleted };
}

/** 读这个工作区里的所有轮次（新的在前）。 */
export async function listCliRewinds(cwd: string): Promise<CliRewindsLoad> {
  const dir = rewindDir(cwd);
  if (!existsSync(dir)) return null;
  let names: string[];
  try {
    names = await fs.readdir(dir);
  } catch (error) {
    return { ok: false, error: error instanceof Error ? error.message : String(error), source: dir };
  }
  const runs: RewindRun[] = [];
  for (const name of names) {
    if (!name.endsWith(".json")) continue;
    const source = `${dir}/${name}`;
    try {
      const text = await fs.readFile(source, "utf8");
      const parsed = parseRewindRun(JSON.parse(text.replace(/^\uFEFF/, "")) as unknown);
      if (parsed) runs.push(parsed);
    } catch {
      // 坏文件跳过：一份存档坏了不该让人看不到其它轮次。
    }
  }
  runs.sort((a, b) => b.id.localeCompare(a.id));
  return { ok: true, runs };
}

/**
 * 算出「退最近 N 轮」要做什么。
 *
 * 与桌面端同一口径：**每个文件只取窗口里最早的那份原文**，这样退回去的是「这几轮开始之前」的
 * 状态，而不是中间某一轮。同一个文件如果一会儿被写过、一会儿被删过，也按最早的来。
 */
export function planCliRewind(runs: readonly RewindRun[], turns: number): CliRewindPlan | null {
  const count = Math.trunc(turns);
  if (!Number.isFinite(count) || count < 1 || count > runs.length) return null;
  const window = runs.slice(0, count); // 新的在前
  const earliest = new Map<string, RewindFile>();
  for (let i = window.length - 1; i >= 0; i -= 1) {
    for (const file of window[i]!.files) {
      if (!earliest.has(file.path)) earliest.set(file.path, file);
    }
  }
  const restore: { path: string; content: string }[] = [];
  const remove: string[] = [];
  const skipped: { path: string; reason: RewindSkipReason }[] = [];
  for (const [key, file] of earliest) {
    if (file.skipped) {
      skipped.push({ path: key, reason: file.skipped });
      continue;
    }
    if (file.before === null) remove.push(key);
    else restore.push({ path: key, content: file.before });
  }
  /*
   * 命令新建的文件也能退（它们跑之前不存在，删掉就对了）；命令改过内容或删掉的，
   * 没有原文，只能点名。写入工具也碰过的路径以工具那份原文为准，不重复处理。
   */
  const createdByCommand = new Set<string>();
  const lost = new Map<string, "modified" | "deleted">();
  for (let i = window.length - 1; i >= 0; i -= 1) {
    const changes = window[i]!.commandChanges;
    if (!changes) continue;
    for (const rel of changes.created) createdByCommand.add(rel);
    for (const rel of changes.modified) if (!lost.has(rel)) lost.set(rel, "modified");
    for (const rel of changes.deleted) if (!lost.has(rel)) lost.set(rel, "deleted");
  }
  for (const rel of createdByCommand) {
    if (earliest.has(rel) || skipped.some((item) => item.path === rel)) continue;
    remove.push(rel);
  }
  const commandLost = [...lost.entries()]
    .filter(([rel]) => !earliest.has(rel) && !createdByCommand.has(rel))
    .map(([rel, how]) => ({ path: rel, how }))
    .sort((a, b) => a.path.localeCompare(b.path));
  restore.sort((a, b) => a.path.localeCompare(b.path));
  remove.sort();
  skipped.sort((a, b) => a.path.localeCompare(b.path));
  return { turns: count, restore, remove, skipped, commandLost };
}

/** 工作区内的绝对路径；越界（`..`、绝对路径）返回 null。 */
function resolveInside(cwd: string, rel: string): string | null {
  if (!rel || path.isAbsolute(rel) || rel.split(/[\\/]/).includes("..")) return null;
  const root = path.resolve(cwd);
  const abs = path.resolve(root, rel);
  const back = path.relative(root, abs);
  if (!back || back.startsWith("..") || path.isAbsolute(back)) return null;
  return abs;
}

/** 真正动手：写回原文、删掉当时还不存在的文件。 */
export async function applyCliRewind(cwd: string, plan: CliRewindPlan): Promise<CliRewindApply> {
  const failed: { path: string; error: string }[] = [];
  let written = 0;
  let deleted = 0;
  for (const item of plan.restore) {
    const abs = resolveInside(cwd, item.path);
    if (!abs) {
      failed.push({ path: item.path, error: "路径跑出工作区，没有还原" });
      continue;
    }
    try {
      await fs.mkdir(path.dirname(abs), { recursive: true });
      await fs.writeFile(abs, item.content, "utf8");
      written += 1;
    } catch (error) {
      failed.push({ path: item.path, error: error instanceof Error ? error.message : String(error) });
    }
  }
  for (const rel of plan.remove) {
    const abs = resolveInside(cwd, rel);
    if (!abs) {
      failed.push({ path: rel, error: "路径跑出工作区，没有删除" });
      continue;
    }
    try {
      await fs.rm(abs, { force: true });
      deleted += 1;
    } catch (error) {
      failed.push({ path: rel, error: error instanceof Error ? error.message : String(error) });
    }
  }
  if (failed.length > 0 && written === 0 && deleted === 0) {
    return { ok: false, error: `一个都没退回去：${failed[0]!.path}（${failed[0]!.error}）` };
  }
  return { ok: true, written, deleted, failed };
}

/** 退过之后把这些轮次从日志里删掉（退过一次不能退第二次，否则会拿旧原文盖新状态）。 */
export async function dropCliRewindRuns(cwd: string, runs: readonly RewindRun[]): Promise<number> {
  let removed = 0;
  for (const run of runs) {
    try {
      await fs.rm(rewindRunPath(cwd, run.id), { force: true });
      removed += 1;
    } catch {
      // 删不掉就算了：多留一轮不影响正确性，只是下次还能再退一次。
    }
  }
  return removed;
}

/** `heming rewind` 的列表文案。 */
export function describeCliRewinds(load: CliRewindsLoad, cwd: string, now: Date = new Date()): string {
  const dir = `${path.resolve(cwd).replace(/\\/g, "/")}/${CLI_REWIND_DIR}`;
  if (load === null) {
    return [
      `这个工作区还没有任何回退记录（${dir} 还不存在）。`,
      "hemin run 每次改文件都会在动手前留一份原文；跑过一次就会出现在这里。",
    ].join("\n");
  }
  if (!load.ok) {
    return `回退记录读不出来：${load.error}（${load.source}）`;
  }
  if (load.runs.length === 0) {
    return `回退目录是空的（${dir}）：还没有哪一轮改过文件。`;
  }
  const lines = [`可回退的运行（${dir}，共 ${load.runs.length} 轮，新的在前）：`];
  for (const [index, run] of load.runs.entries()) {
    const changed = run.files.filter((file) => file.skipped === undefined);
    const skipped = run.files.length - changed.length;
    const ago = describeAgo(run.at, now);
    const names = changed
      .slice(0, 3)
      .map((file) => file.path)
      .join("、");
    const more = changed.length > 3 ? ` 等 ${changed.length} 个` : "";
    const skipNote = skipped > 0 ? `，另有 ${skipped} 个没抓到原文` : "";
    const changes = run.commandChanges;
    const commandNote = changes
      ? `，命令新建 ${changes.created.length} / 改过 ${changes.modified.length} / 删掉 ${changes.deleted.length}`
      : "";
    lines.push(`  ${index + 1}. ${run.id}  ${ago}  ${changed.length} 个文件（${names || "无"}${more}）${skipNote}${commandNote}`);
  }
  lines.push(
    "",
    "退回最近一轮：heming rewind 1　退回最近三轮：heming rewind 3",
    "写工具改的文件按原文还原；命令新建的文件会删掉，命令改过内容或删掉的文件退不回去。",
  );
  return lines.join("\n");
}

function describeAgo(at: string, now: Date): string {
  const then = Date.parse(at);
  if (!Number.isFinite(then)) return at;
  const minutes = Math.floor((now.getTime() - then) / 60_000);
  if (minutes < 1) return "刚刚";
  if (minutes < 60) return `${minutes} 分钟前`;
  const hours = Math.floor(minutes / 60);
  if (hours < 24) return `${hours} 小时前`;
  const days = Math.floor(hours / 24);
  return `${days} 天前`;
}

/** 回退之后的回执（用户要能一眼看出「退了什么、什么没退」）。 */
export function describeCliRewindResult(
  plan: CliRewindPlan,
  apply: CliRewindApply,
  dropped: number,
): string {
  if (!apply.ok) return apply.error;
  const parts: string[] = [];
  if (apply.written > 0) parts.push(`还原 ${apply.written} 个文件`);
  if (apply.deleted > 0) parts.push(`删掉 ${apply.deleted} 个当时还不存在的文件`);
  if (parts.length === 0) parts.push("没有文件需要改");
  const lines = [`已退回 ${plan.turns} 轮：${parts.join("、")}。`];
  if (plan.skipped.length > 0) {
    const names = plan.skipped.slice(0, 3).map((item) => item.path).join("、");
    const more = plan.skipped.length > 3 ? ` 等 ${plan.skipped.length} 个` : "";
    lines.push(`抓不到原文、没有退：${names}${more}（太大 / 二进制 / 读不出来）。`);
  }
  if (apply.failed.length > 0) {
    const first = apply.failed[0]!;
    lines.push(`有 ${apply.failed.length} 个没退成功，例如 ${first.path}（${first.error}）。`);
  }
  const lost = plan.commandLost ?? [];
  if (lost.length > 0) {
    const names = lost.slice(0, 3).map((item) => item.path).join("、");
    const more = lost.length > 3 ? ` 等 ${lost.length} 个` : "";
    lines.push(`命令改过内容或删掉的 ${lost.length} 个文件没有原文，退不回去：${names}${more}。`);
  }
  lines.push(
    dropped > 0
      ? `这 ${dropped} 轮的记录已删除（退过一次不能退第二次）。`
      : "记录没能删除，下次还能再退一次。",
  );
  lines.push("注意：命令（run_command）新建的文件已经一并删掉；它改过内容或删掉的文件没有原文，退不回去——用 git 或自己的备份核对。");
  return lines.join("\n");
}

/** 一轮运行期间的抓取缓冲：同路径只留最早的那份原文。 */
export function createCliRewindJournal(options: {
  cwd: string;
  conversationId?: string;
  now?: () => Date;
  random?: () => number;
}): CliRewindJournal {
  const cwd = path.resolve(options.cwd);
  const now = options.now ?? (() => new Date());
  const random = options.random ?? Math.random;
  const roots: FileRoot[] = [{ path: cwd.replace(/\\/g, "/"), mode: "write", name: "work" }];
  const files = new Map<string, RewindFile>();
  const commandChanges: CommandChanges = { created: [], modified: [], deleted: [] };
  let chars = 0;

  const commandCount = (): number =>
    commandChanges.created.length + commandChanges.modified.length + commandChanges.deleted.length;

  const noteChanges = (changes: CommandChanges): void => {
    for (const [key, list] of Object.entries(changes) as [keyof CommandChanges, string[]][]) {
      for (const rel of list) {
        if (commandCount() >= CLI_REWIND_MAX_COMMAND_FILES) return;
        if (commandChanges[key].includes(rel)) continue;
        commandChanges[key].push(rel);
      }
    }
  };

  const record = (rel: string, file: RewindFile): void => {
    if (files.has(rel) || files.size >= CLI_REWIND_MAX_FILES) return;
    files.set(rel, file);
  };

  return {
    size: () => files.size,

    async note(call) {
      if (!isFileWriteTool(call.name)) return;
      let targets: ReturnType<typeof targetsOfCall>;
      try {
        targets = targetsOfCall({ name: call.name, argsJson: call.arguments }, roots);
      } catch {
        return; // 参数不是 JSON 之类：桥自己会报参数错误，这里不必抢着说话。
      }
      if (!targets) return;
      for (const [index, absolute] of targets.absolute.entries()) {
        if (targets.kinds?.[index] === "dir") continue;
        const rel = relOf(cwd, absolute);
        if (!rel) continue; // 根外：闸门会拒，不该进日志。
        if (files.has(rel)) continue;
        let stat;
        try {
          stat = await fs.stat(absolute);
        } catch {
          // 不存在 = 这次是新建，回退时删掉它。
          record(rel, { path: rel, before: null });
          continue;
        }
        if (!stat.isFile()) continue;
        if (stat.size > CLI_REWIND_MAX_FILE_CHARS * 4) {
          record(rel, { path: rel, before: null, skipped: "too-large" });
          continue;
        }
        let content: string;
        try {
          content = await fs.readFile(absolute, "utf8");
        } catch {
          record(rel, { path: rel, before: null, skipped: "unreadable" });
          continue;
        }
        if (content.includes("\u0000")) {
          record(rel, { path: rel, before: null, skipped: "binary" });
          continue;
        }
        if (content.length > CLI_REWIND_MAX_FILE_CHARS || chars + content.length > CLI_REWIND_MAX_RUN_CHARS) {
          record(rel, { path: rel, before: null, skipped: "too-large" });
          continue;
        }
        chars += content.length;
        record(rel, { path: rel, before: content });
      }
    },

    async beginCommand() {
      return scanWorkspaceFiles(cwd);
    },

    async endCommand(before) {
      if (!before) return; // 前面那次扫盘没扫成（太大/读不了）：这次只当没有范围可记。
      const after = await scanWorkspaceFiles(cwd);
      if (!after) return;
      noteChanges(diffManifests(before, after));
    },

    async close() {
      if (files.size === 0 && commandCount() === 0) return null;
      const at = now();
      const run: RewindRun = {
        id: newRewindId(at, random),
        at: at.toISOString(),
        files: [...files.values()].sort((a, b) => a.path.localeCompare(b.path)),
        ...(commandCount() > 0
          ? {
              commandChanges: {
                created: [...commandChanges.created].sort(),
                modified: [...commandChanges.modified].sort(),
                deleted: [...commandChanges.deleted].sort(),
              },
            }
          : {}),
      };
      const dir = rewindDir(cwd);
      const target = rewindRunPath(cwd, run.id);
      try {
        await fs.mkdir(dir, { recursive: true });
        // 先写临时文件再改名：半截 JSON 比没有存档更难查。
        await fs.writeFile(`${target}.${process.pid}.tmp`, `${JSON.stringify({ version: CLI_REWIND_VERSION, ...run }, null, 2)}\n`, "utf8");
        await fs.rename(`${target}.${process.pid}.tmp`, target);
      } catch {
        return null; // 写不进去（只读盘、权限）就算了：回退是加分项，不能让它拖垮这次运行。
      }
      await pruneOldRuns(cwd);
      return run;
    },
  };
}

/** 只留最近 N 轮（按 id 的字典序即时间序）。 */
async function pruneOldRuns(cwd: string): Promise<void> {
  try {
    const names = (await fs.readdir(rewindDir(cwd))).filter((name) => name.endsWith(".json")).sort();
    const extra = names.length - CLI_REWIND_MAX_RUNS;
    if (extra <= 0) return;
    for (const name of names.slice(0, extra)) {
      await fs.rm(`${rewindDir(cwd)}/${name}`, { force: true });
    }
  } catch {
    // 清理失败不影响本次存档。
  }
}