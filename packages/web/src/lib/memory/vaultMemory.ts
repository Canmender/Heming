/**
 * 知识库 ↔ 语义记忆的双向绑定（d.114 · 规格 §5.1）。
 *
 * 依赖倒置：本文件**不 import** `lib/vault/store`（那层由界面/索引并行实现中），
 * 只依赖一个结构化的 `VaultDocSource` 接口。集成侧（应用启动时）把 vault store
 * 适配成它并 `setVaultDocSource(...)`；测试用内存假实现，两侧互不阻塞。
 *
 * 核心口径：**记忆条目不存笔记正文**，只存「指针 + 摘要」。
 * 为什么：
 * - 知识库文件是唯一事实来源，用户随时会在我们的编辑器或 Obsidian 里改它；
 *   把正文复制进 localStorage 会立刻多出第二份真相（改一处忘一处、同步必然过期）；
 * - 本机记忆配额（1.2MB/键）不该被用户的笔记量绑死；
 * - 注入时用条目自带的摘要（同步路径、不读文件），需要全文时才按指针去读。
 *
 * 一切都是确定性的：无模型调用、无随机、无时钟依赖（摘要取文件 mtime）。
 */

import type { SemanticEntry } from "./types.js";
import { GLOBAL_AGENT_ID } from "./types.js";
import type { MemoryStore } from "./store.js";
import type { VaultMemoryPointer } from "../vault/types.js";
import {
  VAULT_INJECT_MAX_CHARS,
  VAULT_INJECT_PER_NOTE_CHARS,
  VAULT_MEMORY_MAX,
} from "../vault/types.js";

/** 摘要长度上限（与语义条目的 value 上限一致）。 */
export const VAULT_SUMMARY_MAX = 500;

/**
 * 记忆层看到的「知识库只读源」。
 *
 * 只给记忆需要的最小面：
 * - `docs()` 一次拿到全库可纳入的文档（rel/mtime/hash/text）——索引层已经算好 hash，
 *   记忆层不重复遍历文件；
 * - `read(rel)` 按需取正文（预览/未来的异步注入路径）；
 * - `write(req)` 只走智能体写通道（桌面端 `vault:apply` 会再夹一次 `allowedWriteDirs`）；
 * - `allowedWriteDirs()` 让记忆层在**写之前**就知道能不能写，失败原因更具体。
 */
export interface VaultDocSource {
  docs(): Promise<{ vaultId: string; rel: string; mtime: string; hash: string; text: string }[]>;
  read(rel: string): Promise<string | null>;
  write(req: { vaultId: string; rel: string; text: string; mode?: "overwrite" | "append" }): Promise<void>;
  allowedWriteDirs(): string[];
}

/* ------------------------------------------------------------ 注册中心 */

let registeredSource: VaultDocSource | null = null;

/**
 * 注册/注销知识库源（应用启动时调用一次；测试也可用来注入假实现）。
 *
 * 注册后：记忆页的「同步知识库」可用，沉淀写回也会自动开始落盘
 * （写回队列在 `memoryWriteBack.ts`，这里只负责登记源可用性）。
 */
export function setVaultDocSource(source: VaultDocSource | null): void {
  registeredSource = source;
  if (source) {
    // 注册前就排队的写回请求（例如启动早期的一轮显式记忆）在这里补一次 flush。
    // 动态 import 避免「注册中心 ← 写回模块」的静态循环依赖。
    void (async () => {
      try {
        const { flushMemoryWriteBack } = await import("./memoryWriteBack.js");
        await flushMemoryWriteBack();
      } catch {
        /* 写回失败由内存审计上报，注册本身不抛 */
      }
    })();
  }
}

/** 当前已注册的知识库源（未注册返回 null）。 */
export function getVaultDocSource(): VaultDocSource | null {
  return registeredSource;
}

/** 知识库是否已接入（注入路径据此判断「源不可用」）。 */
export function isVaultSourceAvailable(): boolean {
  return registeredSource !== null;
}

/* ------------------------------------------------------------ 文本摘要 */

/** 去掉 YAML frontmatter（`---` 包起来的那段）；不合法/缺失时原样返回。 */
export function stripFrontmatter(text: string): string {
  const source = String(text ?? "").replace(/^\uFEFF/, "");
  const lines = source.split(/\r?\n/);
  if (!lines.length || lines[0].trim() !== "---") return source;
  for (let i = 1; i < lines.length; i++) {
    if (lines[i].trim() === "---") return lines.slice(i + 1).join("\n");
  }
  // 只有开头没有结尾：按没有 frontmatter 处理（宁可多给一段，也不吞掉全文）。
  return source;
}

/** 按码点截断（中文/代理对安全），超长以「…」收尾。 */
export function clipText(text: string, max: number): string {
  const chars = [...String(text ?? "")];
  if (chars.length <= max) return text;
  return `${chars.slice(0, Math.max(0, max - 1)).join("")}…`;
}

/**
 * 笔记 → 摘要：首个标题 + 首段（≤ 500 字），确定性、零成本。
 *
 * 交给模型看的是「这篇笔记大概讲什么」，不是全文；所以只取标题与第一段。
 * 代码块里的 `#` 不算标题（否则贴一段 shell 注释就会把标题带歪）。
 */
export function summarizeVaultDoc(text: string): string {
  const body = stripFrontmatter(String(text ?? ""));
  const lines = body.split(/\r?\n/);
  let title = "";
  let paragraph = "";
  let inFence = false;
  const buffer: string[] = [];

  for (const line of lines) {
    const trimmed = line.trim();
    if (trimmed.startsWith("```") || trimmed.startsWith("~~~")) {
      inFence = !inFence;
      continue;
    }
    if (inFence) continue;
    if (!trimmed) {
      if (buffer.length) {
        paragraph = buffer.join(" ");
        break;
      }
      continue;
    }
    const heading = /^#{1,6}\s+(.+)$/.exec(trimmed);
    if (heading) {
      if (!title && !buffer.length) {
        title = heading[1].trim();
        continue;
      }
      // 首段之前的第二个标题：说明这篇没有正文段落，直接拿标题当摘要。
      if (!paragraph) break;
    }
    buffer.push(trimmed);
  }
  if (!paragraph && buffer.length) paragraph = buffer.join(" ");

  const combined = title && paragraph ? `${title}：${paragraph}` : title || paragraph;
  if (combined) return clipText(combined, VAULT_SUMMARY_MAX);
  // 既无标题也无段落（例如只有表格/图片）：退回正文首行，别给空摘要。
  const fallback = body.replace(/\s+/g, " ").trim();
  return clipText(fallback, VAULT_SUMMARY_MAX);
}

/**
 * 记录文档的稳定 hash：优先用索引层算好的 `hash`；缺失时用纯函数兜底。
 * FNV-1a 两路拼 16 进制，足够做「内容变没变」的判据，且不依赖 WebCrypto
 * （测试环境与主线程都一致）。
 */
export function hashVaultText(text: string): string {
  let h1 = 0x811c9dc5;
  let h2 = 0x1000193;
  const source = String(text ?? "");
  for (let i = 0; i < source.length; i++) {
    const code = source.charCodeAt(i);
    h1 = Math.imul(h1 ^ code, 0x01000193);
    h2 = Math.imul(h2 ^ code, 0x85ebca6b);
  }
  return `${(h1 >>> 0).toString(16).padStart(8, "0")}${(h2 >>> 0).toString(16).padStart(8, "0")}`;
}

/* ------------------------------------------------------------ 正文片段 */

/** 一条正文片段（`resolveExcerpt` 的返回）。 */
export interface VaultExcerpt {
  rel: string;
  text: string;
  /** 原文是否因预算被截断。 */
  truncated: boolean;
  /** 实际返回的字符数（按码点）。 */
  chars: number;
}

function clipExcerpt(rel: string, text: string, budget: number): VaultExcerpt {
  const chars = [...text];
  if (chars.length <= budget) return { rel, text, truncated: false, chars: chars.length };
  if (budget <= 0) return { rel, text: "", truncated: true, chars: 0 };
  const clipped = `${chars.slice(0, Math.max(0, budget - 1)).join("")}…`;
  return { rel, text: clipped, truncated: true, chars: [...clipped].length };
}

function normalizeBudget(value: number | undefined, fallback: number): number {
  if (typeof value !== "number" || !Number.isFinite(value) || value <= 0) return fallback;
  return Math.floor(value);
}

/**
 * 按指针取一条笔记的正文片段（**异步**，永远不抛）。
 *
 * 预算：默认单条 `VAULT_INJECT_PER_NOTE_CHARS`（400 字），且不超过整轮上限
 * `VAULT_INJECT_MAX_CHARS`（调用方传 budget 时自行收敛）。读不到（文件被删/无权限）
 * 返回 null —— 由调用方决定是否回退到条目里的摘要。
 *
 * 注意：**注入路径不用它**（`agentRuntime/context.ts` 是同步函数，注入用条目自带的
 * `value` 摘要）；它给记忆页预览与将来的异步路径用。
 */
export async function resolveExcerpt(
  source: VaultDocSource,
  entry: Pick<SemanticEntry, "key" | "vault"> | VaultMemoryPointer,
  charBudget: number = VAULT_INJECT_PER_NOTE_CHARS,
): Promise<VaultExcerpt | null> {
  const pointer = "vault" in entry && entry.vault ? entry.vault : null;
  const rel = pointer?.rel ?? ("key" in entry ? entry.key : "");
  if (!rel) return null;
  const budget = Math.min(normalizeBudget(charBudget, VAULT_INJECT_PER_NOTE_CHARS), VAULT_INJECT_MAX_CHARS);
  try {
    const raw = await source.read(rel);
    if (typeof raw !== "string") return null;
    const body = stripFrontmatter(raw).trim();
    return clipExcerpt(rel, body, budget);
  } catch {
    return null;
  }
}

/**
 * 整轮解析多条片段：总预算 `VAULT_INJECT_MAX_CHARS`（1200 字），单条 ≤ 400 字。
 * 预算用尽后的条目不再读文件，进 `skipped` 并带原因（可观测，不静默）。
 */
export async function resolveExcerpts(
  source: VaultDocSource,
  entries: Pick<SemanticEntry, "key" | "vault">[],
  totalBudget: number = VAULT_INJECT_MAX_CHARS,
): Promise<{
  excerpts: VaultExcerpt[];
  skipped: { rel: string; reason: string }[];
  chars: number;
}> {
  const total = normalizeBudget(totalBudget, VAULT_INJECT_MAX_CHARS);
  const excerpts: VaultExcerpt[] = [];
  const skipped: { rel: string; reason: string }[] = [];
  let remaining = total;
  for (const entry of entries) {
    const rel = entry.vault?.rel ?? entry.key ?? "";
    if (!rel) {
      skipped.push({ rel: "", reason: "条目没有知识库指针" });
      continue;
    }
    if (remaining <= 0) {
      skipped.push({ rel, reason: `整轮注入预算（${total} 字）已用尽` });
      continue;
    }
    const budget = Math.min(VAULT_INJECT_PER_NOTE_CHARS, remaining);
    const excerpt = await resolveExcerpt(source, entry, budget);
    if (!excerpt) {
      skipped.push({ rel, reason: "读取失败或笔记已不存在" });
      continue;
    }
    excerpts.push(excerpt);
    remaining -= excerpt.chars;
  }
  return { excerpts, skipped, chars: total - remaining };
}

/* ------------------------------------------------------------ 增量同步 */

/** 同步选项：测试注入 store/时钟/上限，生产只传 source。 */
export interface VaultSyncOptions {
  store?: MemoryStore;
  /** 纳入上限（缺省读设置里的 `vaultMemoryMax`，再缺省 `VAULT_MEMORY_MAX`）。 */
  max?: number;
  now?: () => number;
}

/** 一次同步的结果（给记忆页展示，也给日志/测试断言）。 */
export interface VaultSyncResult {
  /** 是否全部成功（配额失败/读取异常时为 false，`error` 说明原因）。 */
  ok: boolean;
  /** 源返回的文档总数（截断前）。 */
  scanned: number;
  /** 新增纳入的篇数。 */
  added: number;
  /** 内容或 mtime 变化、已更新的篇数。 */
  updated: number;
  /** 文件已消失、已从记忆里删除的篇数。 */
  removed: number;
  /** hash 与 mtime 都没变、直接跳过的篇数。 */
  skipped: number;
  /** 超过上限被截断的篇数（0 = 未截断）。 */
  truncated: number;
  /** 截断原因（中文；未截断时为空串）。 */
  truncatedReason: string;
  /** 同步后记忆里的知识库条目总数。 */
  total: number;
  /** 同步时刻（ISO；只用于展示，不参与摘要/打分的确定性口径）。 */
  at: string;
  error?: string;
}

let lastSyncResult: VaultSyncResult | null = null;

/** 最近一次同步结果（会话内保留；记忆页刷新后仍能显示「被截断」状态）。 */
export function lastVaultSync(): VaultSyncResult | null {
  return lastSyncResult;
}

/** 测试用：清掉最近一次同步记录。 */
export function resetVaultSyncState(): void {
  lastSyncResult = null;
}

/**
 * 增量同步知识库 → 语义记忆（纯逻辑，无界面依赖）。
 *
 * 口径（规格 §5.1）：
 * - hash 与 mtime 都没变 → 跳过（不重写 localStorage）；
 * - 新增 → 插入指针条目；变化 → 原地更新（id 稳定，权重账本不断线）；
 * - 文件从库里消失 → 删除对应条目；
 * - 文档数超过上限 → 按 mtime 降序保留最新 N 篇，其余截断，并在返回值里报数。
 *
 * 失败如实返回（`ok:false` + `error`），不抛给界面：同步是后台动作，
 * 界面只负责把结果显示出来。
 */
export async function syncVault(
  source: VaultDocSource,
  options: VaultSyncOptions = {},
): Promise<VaultSyncResult> {
  const now = options.now ?? (() => Date.now());
  const at = new Date(now()).toISOString();
  const store = options.store ?? (await resolveDefaultStore());
  const empty: VaultSyncResult = {
    ok: true,
    scanned: 0,
    added: 0,
    updated: 0,
    removed: 0,
    skipped: 0,
    truncated: 0,
    truncatedReason: "",
    total: 0,
    at,
  };

  try {
    const rawDocs = await source.docs();
    const docs = (Array.isArray(rawDocs) ? rawDocs : []).filter(
      (doc) => doc && typeof doc.rel === "string" && doc.rel.length > 0,
    );
    const limit = Math.max(
      1,
      Math.floor(options.max ?? (typeof store.vaultMemoryLimit === "function" ? store.vaultMemoryLimit() : VAULT_MEMORY_MAX)),
    );
    // 按 mtime 降序、rel 升序：同一批输入在任何机器上都得到同一份截断结果。
    const sorted = [...docs].sort((a, b) => {
      const diff = mtimeMs(b.mtime) - mtimeMs(a.mtime);
      if (diff) return diff;
      return a.rel < b.rel ? -1 : a.rel > b.rel ? 1 : 0;
    });
    const kept = sorted.slice(0, limit);
    const truncated = sorted.length - kept.length;

    const existing = new Map(store.vaultEntries().map((entry) => [entry.key, entry]));
    const toUpsert: Parameters<MemoryStore["upsertVaultEntries"]>[0] = [];
    let added = 0;
    let updated = 0;
    let skipped = 0;
    for (const doc of kept) {
      const text = typeof doc.text === "string" ? doc.text : "";
      const hash = typeof doc.hash === "string" && doc.hash ? doc.hash : hashVaultText(text);
      const mtime = typeof doc.mtime === "string" ? doc.mtime : "";
      const prev = existing.get(doc.rel);
      const unchanged =
        prev?.vault !== undefined &&
        prev.vault.hash === hash &&
        prev.vault.mtime === mtime &&
        prev.vault.vaultId === doc.vaultId;
      if (unchanged) {
        skipped += 1;
        continue;
      }
      if (prev) updated += 1;
      else added += 1;
      toUpsert.push({
        rel: doc.rel,
        vaultId: String(doc.vaultId ?? ""),
        mtime,
        hash,
        value: summarizeVaultDoc(text),
      });
    }

    // 先删后写：上限收紧时先腾出位置，避免「新旧混着」卡在配额上。
    const keepSet = new Set(kept.map((doc) => doc.rel));
    const removeKeys = [...existing.keys()].filter((rel) => !keepSet.has(rel));
    const removed = removeKeys.length ? store.removeVaultEntries(removeKeys) : 0;

    let upsert: { ok: boolean; written: number; dropped: number; error?: string } = {
      ok: true,
      written: 0,
      dropped: 0,
    };
    if (toUpsert.length) upsert = store.upsertVaultEntries(toUpsert);

    const total = store.vaultEntries().length;
    const result: VaultSyncResult = {
      ...empty,
      ok: upsert.ok,
      scanned: docs.length,
      added,
      updated,
      removed,
      skipped,
      truncated,
      truncatedReason:
        truncated > 0
          ? `超过纳入上限（${limit} 篇），已按修改时间保留最新 ${limit} 篇，其余 ${truncated} 篇未纳入`
          : "",
      total,
      ...(upsert.error ? { error: upsert.error } : {}),
    };
    lastSyncResult = result;
    return result;
  } catch (err) {
    const result: VaultSyncResult = {
      ...empty,
      ok: false,
      error: `知识库同步失败：${err instanceof Error ? err.message : String(err)}`,
    };
    lastSyncResult = result;
    return result;
  }
}

/** mtime 毫秒；不可解析按 0（最旧），保证排序确定。 */
function mtimeMs(mtime: unknown): number {
  const t = typeof mtime === "string" ? Date.parse(mtime) : NaN;
  return Number.isFinite(t) ? t : 0;
}

/** 缺省 store 用模块级单例；动态 import 避免 index ↔ vaultMemory 的静态循环。 */
async function resolveDefaultStore(): Promise<MemoryStore> {
  const { memoryStore } = await import("./index.js");
  return memoryStore;
}

/* ------------------------------------------------------------ 设置捷径 */

/** 「知识库参与记忆」是否开启（唯一真源：`MemorySettings.vaultMemory`）。 */
export function isVaultMemoryEnabled(store: MemoryStore): boolean {
  try {
    return store.getSettings().vaultMemory !== false;
  } catch {
    return true;
  }
}

/** 给注入层用的默认 agentId（知识库条目全部落全局桶）。 */
export const VAULT_ENTRY_AGENT_ID = GLOBAL_AGENT_ID;
