import type { MemoryDrop, MemoryLayer } from "./format.js";
import type { StorageLike } from "./types.js";
import { createDefaultStorage, isPlainObject, readJson, utf8Length, writeJson } from "./storage.js";

/**
 * 召回日志（可观测性，d.27）：每次「带记忆的生成」留一档——召回几条、注入几条、
 * 哪些被预算裁掉、哪些被同键新值覆盖、回答里疑似用到了哪条。
 *
 * 为什么单独一个键而不是塞进既有存储：
 * - `heming.selfAudit.v1` 是自我修改的**回滚时间线**，混进召回日志会让回滚列表出现无关条目；
 * - 任务区 `TaskRecord` 只给「从任务区发起的流」建档，日常聊天不建档，日志要覆盖日常聊天；
 * - 记忆三层键是**用户数据**（可导出/导入），日志是**本机诊断数据**，导出时不该带走。
 *
 * 日志是本机调试辅助，不是用户资产：上限压得很小，满了丢最旧的，
 * 写失败一律静默——绝不影响发送与流式渲染。
 */

/** 日志键（与三层/设置键分桶，不参与记忆导出）。 */
export const RECALL_LOG_KEY = "heming.memory.recallLog.v1";

/** 环形上限：40 次生成（按每天 40 轮聊也就一天的量）。 */
export const RECALL_LOG_MAX = 40;
/** 字节上限：256KB，远小于单键通用护栏（1.2MB），宁可少留几档也不能吃配额。 */
export const RECALL_LOG_SIZE_LIMIT = 256 * 1024;
/** 注入内容在日志里只留前 120 字：够解释「这条注入了什么」，不需要全文。 */
const CONTENT_MAX = 120;
/** 触发查询（用户原话）留前 200 字。 */
const QUERY_MAX = 200;

/** 一条注入了什么（`id` 指向来源条目；工作层的聚合行 id 为 `focus`）。 */
export interface RecallRunItem {
  id: string;
  layer: MemoryLayer;
  /** 召回打分（旁路信息，可能缺失：如未参与排序的兜底项）。 */
  score?: number;
  /** 实际注入文本（已按预算截断，日志里再截一次到 120 字）。 */
  content: string;
  truncated: boolean;
}

/** 召回了却没注入的原因（与格式化层同一口径，避免两处各定一套枚举）。 */
export type RecallDropReason = MemoryDrop["reason"];

/** 日志里的一条「未注入」记录，结构即格式化层的 MemoryDrop。 */
export type RecallRunDrop = MemoryDrop;

/** 一次生成的召回档案。 */
export interface RecallRun {
  id: string;
  /** ISO 时间戳。 */
  at: string;
  agentId: string;
  conversationId: string;
  /** 当轮用户原话（截断）。 */
  query: string;
  /** 三层各召回多少条（注意：与注入条数可以不同）。 */
  recalled: { semantic: number; episodic: number; working: number };
  injected: RecallRunItem[];
  dropped: RecallRunDrop[];
  /** 疑似被回答引用的条目 id（判据见 attribution.ts）。 */
  used: string[];
}

/** 写入用的档案（`id`/`at` 由日志生成，调用方不需要提供）。 */
export type RecallRunInput = Omit<RecallRun, "id" | "at">;

const LAYERS: MemoryLayer[] = ["semantic", "episodic", "working"];

function layerOf(raw: unknown): MemoryLayer | null {
  return LAYERS.includes(raw as MemoryLayer) ? (raw as MemoryLayer) : null;
}

/* ------------------------------------------------------------------ 水合 */

function pickRun(raw: unknown): RecallRun | null {
  if (!isPlainObject(raw)) return null;
  if (typeof raw.id !== "string" || typeof raw.at !== "string") return null;
  if (typeof raw.agentId !== "string" || typeof raw.conversationId !== "string") return null;
  const injected: RecallRunItem[] = [];
  if (Array.isArray(raw.injected)) {
    for (const item of raw.injected) {
      if (!isPlainObject(item) || typeof item.id !== "string" || typeof item.content !== "string") continue;
      const layer = layerOf(item.layer);
      if (!layer) continue;
      injected.push({
        id: item.id,
        layer,
        ...(typeof item.score === "number" ? { score: item.score } : {}),
        content: item.content.slice(0, CONTENT_MAX),
        truncated: item.truncated === true,
      });
    }
  }
  const dropped: RecallRunDrop[] = [];
  if (Array.isArray(raw.dropped)) {
    for (const item of raw.dropped) {
      if (!isPlainObject(item) || typeof item.id !== "string") continue;
      const layer = layerOf(item.layer);
      if (!layer || (item.reason !== "budget" && item.reason !== "superseded")) continue;
      dropped.push({
        id: item.id,
        layer,
        reason: item.reason,
        ...(typeof item.content === "string" ? { content: item.content.slice(0, CONTENT_MAX) } : {}),
      });
    }
  }
  const counts = isPlainObject(raw.recalled) ? raw.recalled : {};
  const num = (v: unknown) => (typeof v === "number" && Number.isFinite(v) && v >= 0 ? v : 0);
  return {
    id: raw.id,
    at: raw.at,
    agentId: raw.agentId,
    conversationId: raw.conversationId,
    query: typeof raw.query === "string" ? raw.query.slice(0, QUERY_MAX) : "",
    recalled: { semantic: num(counts.semantic), episodic: num(counts.episodic), working: num(counts.working) },
    injected,
    dropped,
    used: Array.isArray(raw.used) ? raw.used.filter((v): v is string => typeof v === "string") : [],
  };
}

function pickRuns(raw: unknown): RecallRun[] {
  if (!Array.isArray(raw)) return [];
  const out: RecallRun[] = [];
  for (const item of raw) {
    const run = pickRun(item);
    if (run) out.push(run);
  }
  return out;
}

let idSeq = 0;

function newRunId(nowMs: number): string {
  idSeq += 1;
  return `rr-${nowMs.toString(36)}-${idSeq.toString(36)}-${Math.random().toString(36).slice(2, 6)}`;
}

/** 按条数与字节双上限裁剪：新→旧累加，塞不下的旧档直接丢弃；至少留最新一档。 */
function trim(runs: RecallRun[]): RecallRun[] {
  const newestFirst = [...runs].sort((a, b) => Date.parse(b.at) - Date.parse(a.at));
  const kept: RecallRun[] = [];
  let bytes = 2; // "[]"
  for (const run of newestFirst) {
    if (kept.length >= RECALL_LOG_MAX) break;
    const cost = utf8Length(JSON.stringify(run)) + 1;
    // 首档无条件保留：否则一条超长档案会让整个日志永远写不进任何东西。
    if (kept.length && bytes + cost > RECALL_LOG_SIZE_LIMIT) break;
    kept.push(run);
    bytes += cost;
  }
  return kept.reverse();
}

/* ------------------------------------------------------------------ 存储 */

export class RecallLog {
  constructor(
    private storage: StorageLike = createDefaultStorage(),
    private nowMs: () => number = () => Date.now(),
  ) {}

  /** 全部日志，按时间**升序**（最旧在前；UI 自行倒序展示）。损坏条目在此被丢掉。 */
  list(): RecallRun[] {
    return readJson<RecallRun[]>(this.storage, RECALL_LOG_KEY, [], (raw) => pickRuns(raw));
  }

  /**
   * 追加一档，返回写入后的档案；**输入不符合契约时返回 null**（不抛）。
   * 返回 null 有两种：入参被拒，或落盘失败/超配额（数据只在本次会话内存里留过一下）。
   */
  record(input: RecallRunInput): RecallRun | null {
    if (!input || typeof input !== "object") return null;
    if (!Array.isArray(input.injected) || !Array.isArray(input.dropped)) return null;
    const now = this.nowMs();
    const run: RecallRun = {
      id: newRunId(now),
      at: new Date(now).toISOString(),
      agentId: input.agentId ?? "",
      conversationId: input.conversationId ?? "",
      query: (input.query ?? "").slice(0, QUERY_MAX),
      recalled: {
        semantic: input.recalled?.semantic ?? 0,
        episodic: input.recalled?.episodic ?? 0,
        working: input.recalled?.working ?? 0,
      },
      injected: input.injected
        .filter((item) => item && typeof item.id === "string" && typeof item.content === "string")
        .map((item) => ({ ...item, content: item.content.slice(0, CONTENT_MAX) })),
      dropped: input.dropped.filter((item) => item && typeof item.id === "string"),
      used: Array.isArray(input.used) ? input.used.filter((id) => typeof id === "string") : [],
    };
    const runs = trim([...this.list(), run]);
    // 日志用自己的字节护栏（比单键通用护栏小得多）：写不下就返回 null，调用方静默降级。
    return writeJson(this.storage, RECALL_LOG_KEY, runs, RECALL_LOG_SIZE_LIMIT) ? run : null;
  }

  /** 清空日志（记忆区的「清除诊断数据」）。 */
  clear(): void {
    try {
      this.storage.removeItem(RECALL_LOG_KEY);
    } catch {
      /* 静默 */
    }
  }
}

/**
 * 条目 id → 最后一次被注入 / 最后一次疑似命中的时间。
 * 一次遍历建索引：记忆卡要按条目逐个显示，用「每个 id 扫一遍日志」会是 O(卡数 × 日志数)。
 */
export function buildTouchIndex(runs: RecallRun[]): Map<string, { injectedAt: string; usedAt: string }> {
  const index = new Map<string, { injectedAt: string; usedAt: string }>();
  const touch = (id: string, at: string, field: "injectedAt" | "usedAt") => {
    const current = index.get(id) ?? { injectedAt: "", usedAt: "" };
    if (at > current[field]) current[field] = at;
    index.set(id, current);
  };
  for (const run of runs) {
    for (const item of run.injected) touch(item.id, run.at, "injectedAt");
    for (const id of run.used) touch(id, run.at, "usedAt");
  }
  return index;
}
