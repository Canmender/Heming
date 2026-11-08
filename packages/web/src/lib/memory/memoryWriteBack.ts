/**
 * 记忆 → 知识库写回（d.114 · 规格 §5.2）。
 *
 * 三类沉淀各自写进 `inbox/` 的独立文件：
 * - `explicit`：用户明说「记住…」；
 * - `consolidate`：记忆页「立即整理」提炼出来的；
 * - `review`：复盘分身自评写入的。
 *
 * 两条原则：
 * 1. **失败不静默**：写不进去（无库 / 无写权限 / 库为空 / 桥报错）时返回失败结果，
 *    并推一条通知中心消息；记忆条目本身照常保存（写回是附加动作，不是保存的前置条件）。
 * 2. **不阻塞同步链路**：`recordTurn` 等调用点都在同步函数里，写回只能入队后异步落盘；
 *    队列按 (kind, agentId, key) 去重，同一件事反复沉淀不会堆一串重复请求。
 *
 * 去重口径（规格 §5.2）：同一 key 已有 `inbox/memory-<key>-<yyyymmdd>.md` 时**追加**
 * `## 更新 YYYY-MM-DD` 小节而不是新建文件；不同日期首次写入才新建。
 */

import type { MemoryStore } from "./store.js";
import { getVaultDocSource, type VaultDocSource } from "./vaultMemory.js";

/** 三类写回来源。 */
export type MemoryWriteKind = "explicit" | "consolidate" | "review";

/** 一条待写回的记忆。 */
export interface MemoryWriteRequest {
  kind: MemoryWriteKind;
  key: string;
  value: string;
  agentId: string;
  /** 写入时间（ISO）；文件名日期与 frontmatter createdAt 用它。缺省为现在。 */
  at?: string;
}

/** 单条写回结果（返回值即「上报」：调用方/界面都能直接展示 reason）。 */
export interface MemoryWriteResult {
  ok: boolean;
  kind: MemoryWriteKind;
  key: string;
  /** 目标相对路径（失败时也可能有候选路径，便于排查）。 */
  rel: string;
  /** true = 追加到已有文件；false = 新建。 */
  appended: boolean;
  /** 失败原因（中文）。 */
  error?: string;
}

/** 队列上限：写回是附加动作，积压时丢最旧，不让内存与请求无限膨胀。 */
const QUEUE_LIMIT = 200;
/** 一轮 flush 最多处理几批（flush 过程中新入队的请求顺带处理）。 */
const FLUSH_ROUNDS = 3;
/** 知识库智能体写通道的固定目录。 */
export const MEMORY_INBOX_DIR = "inbox";
/** 写回文件前缀。 */
export const MEMORY_WRITE_PREFIX = "memory-";

type ErrorHandler = (info: { result: MemoryWriteResult; request: MemoryWriteRequest }) => void;

/** 队列：键 = kind + agentId + key，后写覆盖先写（保留最新内容）。 */
const pending = new Map<string, MemoryWriteRequest>();
let errorHandler: ErrorHandler | null = null;
let flushPromise: Promise<FlushResult> | null = null;

function queueKeyOf(request: MemoryWriteRequest): string {
  return `${request.kind}\u0000${request.agentId}\u0000${request.key}`;
}

/**
 * 入队一条写回请求（同步、不抛）。
 *
 * 为什么入队而不是直接 await：调用点（`MemoryStore.recordTurn`）在同步事务里，
 * 改成 async 会污染整条聊天主链路；写回失败也不该让「记住这句话」失败。
 */
export function enqueueMemoryWrite(request: MemoryWriteRequest): void {
  const key = String(request.key ?? "").trim();
  const value = String(request.value ?? "").trim();
  if (!key || !value) return;
  const item: MemoryWriteRequest = {
    kind: request.kind,
    key,
    value,
    agentId: String(request.agentId ?? ""),
    ...(request.at ? { at: request.at } : {}),
  };
  const qk = queueKeyOf(item);
  pending.delete(qk);
  pending.set(qk, item);
  while (pending.size > QUEUE_LIMIT) {
    const oldest = pending.keys().next().value as string | undefined;
    if (oldest === undefined) break;
    pending.delete(oldest);
  }
  // 未接入知识库时只留在队列里（接入后 setVaultDocSource 会补一次 flush）。
  if (getVaultDocSource()) void flushMemoryWriteBack();
}

/** 当前积压条数（测试/记忆页展示用）。 */
export function pendingMemoryWriteCount(): number {
  return pending.size;
}

/** 注入失败上报器（测试用；缺省走通知中心）。传 null 恢复默认。 */
export function setMemoryWriteErrorHandler(handler: ErrorHandler | null): void {
  errorHandler = handler;
}

/** 测试用：清空队列与上报器。 */
export function resetMemoryWriteBack(): void {
  pending.clear();
  errorHandler = null;
  flushPromise = null;
}

/** flush 结果（可观测：写入几条、失败几条、为什么没写）。 */
export interface FlushResult {
  written: number;
  failed: number;
  /** 队列里还剩多少条（正常为 0；异常时会 >0 并在下次 flush 继续）。 */
  remaining: number;
  /** 整体跳过的原因（未接入知识库时）。 */
  skippedReason?: string;
}

export interface FlushOptions {
  source?: VaultDocSource;
  store?: MemoryStore;
  now?: () => number;
  /** 显式指定目标库；缺省按已存在文件/库内首个文档推断。 */
  vaultId?: string;
}

/**
 * 把队列里的写回请求落盘（异步、不抛）。
 *
 * 同一时刻只跑一轮：重复调用共享同一个 promise，避免两轮 flush 抢同一文件。
 */
export function flushMemoryWriteBack(options: FlushOptions = {}): Promise<FlushResult> {
  if (!flushPromise) {
    flushPromise = doFlush(options).finally(() => {
      flushPromise = null;
    });
  }
  return flushPromise;
}

async function doFlush(options: FlushOptions): Promise<FlushResult> {
  const source = options.source ?? getVaultDocSource();
  if (!source) {
    return {
      written: 0,
      failed: 0,
      remaining: pending.size,
      skippedReason: "知识库未接入：没有可写的 VaultDocSource",
    };
  }
  let written = 0;
  let failed = 0;
  for (let round = 0; round < FLUSH_ROUNDS && pending.size > 0; round++) {
    const batch = [...pending.values()];
    pending.clear();
    for (const request of batch) {
      const result = await writeBackMemory(source, request, options);
      if (result.ok) {
        written += 1;
      } else {
        failed += 1;
        reportFailure(result, request);
      }
    }
  }
  return { written, failed, remaining: pending.size };
}

/** 默认上报器：推通知中心；自身异常静默（上报失败不能反过来炸写回）。 */
function reportFailure(result: MemoryWriteResult, request: MemoryWriteRequest): void {
  if (errorHandler) {
    try {
      errorHandler({ result, request });
    } catch {
      /* 上报器异常不外溢 */
    }
    return;
  }
  void (async () => {
    try {
      const { useNotificationStore } = await import("../../store/notifications.js");
      const day = (result.rel.match(/(\d{8})\.md$/) ?? [])[1] ?? "";
      useNotificationStore.getState().push({
        kind: "memory",
        key: `memory-vault-write:${request.kind}:${request.key}:${day || "unknown"}`,
        title: `知识库写回失败：${request.key}`,
        body: `${result.error ?? "未知原因"}（记忆条目已保存）`,
      });
    } catch {
      /* 通知模块不可用（如单测环境未加载）→ 只留返回值 */
    }
  })();
}

/* ------------------------------------------------------------ 单条写回 */

/** 文件名里可用的 key（去掉路径分隔符与 Windows 保留字符，限长）。 */
export function memoryFileKey(key: string): string {
  const cleaned = String(key ?? "")
    .trim()
    .replace(/[\s/\\:*?"<>|#%]+/g, "-")
    .replace(/-+/g, "-")
    .replace(/^-|-$/g, "");
  return (cleaned || "未命名").slice(0, 40);
}

/** 写入日期：`yyyy-MM-dd` 与文件名用的 `yyyymmdd`。 */
function dateParts(iso: string): { display: string; compact: string } {
  const day = iso.slice(0, 10);
  return { display: day, compact: day.replace(/-/g, "") };
}

/** 知识库是否允许写 `inbox/`；不允许时给出具体原因（而不是笼统「失败」）。 */
function checkWritableDirs(source: VaultDocSource): string | null {
  let dirs: string[] = [];
  try {
    dirs = source.allowedWriteDirs() ?? [];
  } catch {
    return "无法读取知识库的可写目录";
  }
  if (!dirs.length) return "知识库当前对智能体只读（可写目录为空），请到知识库页开启写入目录";
  const normalized = dirs.map((dir) => String(dir).replace(/^\/+|\/+$/g, ""));
  if (!normalized.some((dir) => dir === MEMORY_INBOX_DIR || dir.startsWith(`${MEMORY_INBOX_DIR}/`))) {
    return `知识库未允许写入 ${MEMORY_INBOX_DIR}/ 目录（当前可写：${normalized.join("、")}）`;
  }
  return null;
}

/** 已有同 key 文件（取最新一期；文件名里的日期可字典序比较）。 */
function findExistingRel(
  docs: { vaultId: string; rel: string }[],
  fileKey: string,
): { rel: string; vaultId: string } | null {
  const prefix = `${MEMORY_INBOX_DIR}/${MEMORY_WRITE_PREFIX}${fileKey}-`;
  const matches = docs
    .filter((doc) => doc.rel.startsWith(prefix) && doc.rel.endsWith(".md"))
    .sort((a, b) => (a.rel < b.rel ? 1 : a.rel > b.rel ? -1 : 0));
  return matches[0] ?? null;
}

/** 新建文件的完整内容（frontmatter + 正文）。 */
export function buildMemoryNote(input: {
  key: string;
  value: string;
  agentId: string;
  kind: MemoryWriteKind;
  createdAt: string;
}): string {
  return [
    "---",
    "source: heming-memory",
    `key: ${JSON.stringify(input.key)}`,
    `agentId: ${JSON.stringify(input.agentId)}`,
    `createdAt: ${JSON.stringify(input.createdAt)}`,
    `kind: ${input.kind}`,
    "---",
    "",
    input.value,
    "",
  ].join("\n");
}

/** 追加到已有文件的小节。 */
export function buildMemoryUpdateSection(input: { value: string; at: string }): string {
  return `## 更新 ${dateParts(input.at).display}\n\n${input.value}\n`;
}

/**
 * 写回一条记忆（异步、不抛，返回结果即上报）。
 *
 * 目标文件名固定 `inbox/memory-<key>-<yyyymmdd>.md`；同 key 已有文件则追加
 * `## 更新 YYYY-MM-DD` 小节（规格 §5.2 的去重口径）。
 * 记忆条目本身由调用方在此之前已经保存，这里失败**不回滚**。
 */
export async function writeBackMemory(
  source: VaultDocSource,
  request: MemoryWriteRequest,
  options: FlushOptions = {},
): Promise<MemoryWriteResult> {
  const at = request.at ?? new Date(options.now ? options.now() : Date.now()).toISOString();
  const fileKey = memoryFileKey(request.key);
  const { compact } = dateParts(at);
  const rel = `${MEMORY_INBOX_DIR}/${MEMORY_WRITE_PREFIX}${fileKey}-${compact}.md`;
  const base: MemoryWriteResult = { ok: false, kind: request.kind, key: request.key, rel, appended: false };

  const denied = checkWritableDirs(source);
  if (denied) return { ...base, error: denied };

  let docs: { vaultId: string; rel: string }[] = [];
  try {
    docs = (await source.docs()).map((doc) => ({ vaultId: doc.vaultId, rel: doc.rel }));
  } catch (err) {
    return { ...base, error: `读取知识库目录失败：${err instanceof Error ? err.message : String(err)}` };
  }

  const existing = findExistingRel(docs, fileKey);
  const vaultId = options.vaultId ?? existing?.vaultId ?? docs[0]?.vaultId ?? "";
  if (!vaultId) {
    return { ...base, error: "知识库为空，无法确定写入目标库" };
  }

  try {
    if (existing) {
      await source.write({
        vaultId,
        rel: existing.rel,
        text: buildMemoryUpdateSection({ value: request.value, at }),
        mode: "append",
      });
      return { ...base, ok: true, rel: existing.rel, appended: true };
    }
    await source.write({
      vaultId,
      rel,
      text: buildMemoryNote({
        key: request.key,
        value: request.value,
        agentId: request.agentId,
        kind: request.kind,
        createdAt: at,
      }),
      mode: "overwrite",
    });
    return { ...base, ok: true, rel, appended: false };
  } catch (err) {
    return { ...base, error: `写入知识库失败：${err instanceof Error ? err.message : String(err)}` };
  }
}
