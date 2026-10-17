import type {
  EpisodicEntry,
  MemoryData,
  MemorySettings,
  SemanticEntry,
  StorageLike,
  WorkingTurn,
} from "./types.js";
import {
  KEY_SIZE_LIMIT,
  MEMORY_KEYS,
  createDefaultStorage,
  isPlainObject,
  readJson,
  utf8Length,
  writeJson,
} from "./storage.js";
import { tokenize } from "./tokenize.js";
import { SUMMARY_MAX, deterministicSummary, extractExplicitMemory, normalizeKey } from "./extract.js";

/**
 * 三层记忆核心库（设计 §2/§3/§8）：三层各自独立存储、独立淘汰，全部写本机
 * localStorage（经 StorageLike 抽象），损坏回退空集、写入异常静默。
 */

/** Working：每会话轮次上限 / 过期阈值。 */
export const WORKING_LIMIT = 40;
export const WORKING_TTL_MS = 2 * 60 * 60 * 1000;
/** Episodic：每智能体上限。 */
export const EPISODIC_LIMIT = 500;
/** Semantic：每智能体上限。 */
export const SEMANTIC_LIMIT = 300;
/** 每累计多少轮成功对话沉淀 1 条情景记忆。 */
export const SEDIMENT_EVERY = 6;
/** 时间衰减半衰期（天）；召回与淘汰共用。 */
export const EPISODIC_HALF_LIFE_DAYS = 14;
/** 显式指令入库的置信度（设计 §2.3）。 */
export const EXPLICIT_CONFIDENCE = 0.9;
/** 导出格式版本。 */
export const EXPORT_VERSION = 1;

export const DEFAULT_SETTINGS: MemorySettings = {
  enabled: true,
  autoCapture: true,
  retentionDays: 90,
};

const DAY_MS = 86_400_000;
let idSeq = 0;

function newId(prefix: string, nowMs: number): string {
  idSeq += 1;
  return `${prefix}-${nowMs.toString(36)}-${idSeq.toString(36)}-${Math.random().toString(36).slice(2, 6)}`;
}

/** 时间衰减：14 天半衰期（设计 §2.2/§4），未来时间按 1 计。 */
export function recencyScore(at: string, nowMs: number, halfLifeDays = EPISODIC_HALF_LIFE_DAYS): number {
  const t = Date.parse(at);
  if (!Number.isFinite(t)) return 0;
  const days = Math.max(0, (nowMs - t) / DAY_MS);
  return Math.pow(0.5, days / halfLifeDays);
}

/* ------------------------------------------------------------------ 水合 */

function pickWorking(raw: unknown): Record<string, WorkingTurn[]> {
  if (!isPlainObject(raw)) return {};
  const out: Record<string, WorkingTurn[]> = {};
  for (const [key, list] of Object.entries(raw)) {
    if (!Array.isArray(list)) continue;
    const items: WorkingTurn[] = [];
    for (const item of list) {
      if (!isPlainObject(item)) continue;
      if (
        typeof item.id !== "string" ||
        typeof item.conversationId !== "string" ||
        typeof item.agentId !== "string" ||
        typeof item.userText !== "string" ||
        typeof item.assistantText !== "string" ||
        typeof item.at !== "string"
      ) {
        continue;
      }
      items.push({
        id: item.id,
        conversationId: item.conversationId,
        agentId: item.agentId,
        userText: item.userText,
        assistantText: item.assistantText,
        at: item.at,
        ...(item.partial === true ? { partial: true } : {}),
      });
    }
    if (items.length) out[key] = items;
  }
  return out;
}

function pickEpisodic(raw: unknown, nowMs: number): Record<string, EpisodicEntry[]> {
  if (!isPlainObject(raw)) return {};
  const fallbackAt = new Date(nowMs).toISOString();
  const out: Record<string, EpisodicEntry[]> = {};
  for (const [key, list] of Object.entries(raw)) {
    if (!Array.isArray(list)) continue;
    const items: EpisodicEntry[] = [];
    for (const item of list) {
      if (!isPlainObject(item)) continue;
      if (typeof item.id !== "string" || typeof item.agentId !== "string" || typeof item.summary !== "string") {
        continue;
      }
      const summary = item.summary.slice(0, SUMMARY_MAX);
      items.push({
        id: item.id,
        agentId: item.agentId,
        conversationId: typeof item.conversationId === "string" ? item.conversationId : "",
        summary,
        keywords: Array.isArray(item.keywords)
          ? item.keywords.filter((k): k is string => typeof k === "string")
          : tokenize(summary).slice(0, 12),
        at: typeof item.at === "string" ? item.at : fallbackAt,
        importance:
          typeof item.importance === "number" && Number.isFinite(item.importance) ? item.importance : 0.5,
        sourceTurns: typeof item.sourceTurns === "number" && Number.isFinite(item.sourceTurns) ? item.sourceTurns : 0,
      });
    }
    if (items.length) out[key] = items;
  }
  return out;
}

function pickSemantic(raw: unknown, nowMs: number): Record<string, SemanticEntry[]> {
  if (!isPlainObject(raw)) return {};
  const fallbackAt = new Date(nowMs).toISOString();
  const out: Record<string, SemanticEntry[]> = {};
  for (const [key, list] of Object.entries(raw)) {
    if (!Array.isArray(list)) continue;
    const items: SemanticEntry[] = [];
    for (const item of list) {
      if (!isPlainObject(item)) continue;
      if (
        typeof item.id !== "string" ||
        typeof item.agentId !== "string" ||
        typeof item.key !== "string" ||
        typeof item.value !== "string"
      ) {
        continue;
      }
      const now = new Date(nowMs).toISOString();
      items.push({
        id: item.id,
        agentId: item.agentId,
        key: normalizeKey(item.key),
        value: item.value.slice(0, 500),
        scope: item.scope === "agent" ? "agent" : "user",
        confidence: typeof item.confidence === "number" && Number.isFinite(item.confidence) ? item.confidence : 0.5,
        pinned: item.pinned === true,
        source:
          item.source === "explicit" || item.source === "consolidate" || item.source === "manual"
            ? item.source
            : "manual",
        createdAt: typeof item.createdAt === "string" ? item.createdAt : now,
        updatedAt: typeof item.updatedAt === "string" ? item.updatedAt : now,
      });
    }
    if (items.length) out[key] = items;
  }
  return out;
}

function pickSettings(raw: unknown): MemorySettings {
  if (!isPlainObject(raw)) return { ...DEFAULT_SETTINGS };
  return {
    enabled: typeof raw.enabled === "boolean" ? raw.enabled : DEFAULT_SETTINGS.enabled,
    autoCapture: typeof raw.autoCapture === "boolean" ? raw.autoCapture : DEFAULT_SETTINGS.autoCapture,
    retentionDays:
      typeof raw.retentionDays === "number" && Number.isFinite(raw.retentionDays) && raw.retentionDays > 0
        ? raw.retentionDays
        : DEFAULT_SETTINGS.retentionDays,
  };
}

/* ------------------------------------------------------- 单键体积配额守卫 */

/** 工作记忆超 1.2MB：从最长的会话列表开始丢最旧轮次。 */
function guardWorkingSize(
  working: Record<string, WorkingTurn[]>,
  limit: number,
): Record<string, WorkingTurn[]> {
  let out = working;
  while (utf8Length(JSON.stringify(out)) > limit) {
    let target: string | null = null;
    let size = -1;
    for (const [key, list] of Object.entries(out)) {
      const bytes = utf8Length(JSON.stringify(list));
      if (bytes > size) {
        size = bytes;
        target = key;
      }
    }
    if (target === null) break;
    const list = out[target];
    const next = { ...out };
    if (list.length <= 1) delete next[target];
    else next[target] = list.slice(1);
    out = next;
  }
  return out;
}

/**
 * 情景/语义超 1.2MB：按分数（重要度或置信度 × recency）最低者先淘汰。
 * `isProtected` 标记「永不淘汰」的条目（语义 pinned）：若只剩受保护条目，停止淘汰，
 * 交给 writeJson 拒写（数据留在内存里，不影响使用）。
 */
function guardScoredSize<T extends { id: string }>(
  record: Record<string, T[]>,
  limit: number,
  scoreOf: (item: T) => number,
  atOf: (item: T) => string,
  isProtected?: (item: T) => boolean,
): Record<string, T[]> {
  let out = record;
  while (utf8Length(JSON.stringify(out)) > limit) {
    const flat: { agent: string; item: T; score: number }[] = [];
    for (const [agent, list] of Object.entries(out)) {
      for (const item of list) {
        if (isProtected?.(item)) continue;
        flat.push({ agent, item, score: scoreOf(item) });
      }
    }
    if (!flat.length) break;
    flat.sort((a, b) => a.score - b.score || (atOf(a.item) < atOf(b.item) ? -1 : 1));
    const victim = flat[0];
    const next = { ...out };
    const kept = out[victim.agent].filter((item) => item.id !== victim.item.id);
    if (kept.length) next[victim.agent] = kept;
    else delete next[victim.agent];
    out = next;
  }
  return out;
}

/* ------------------------------------------------------------------- Store */

/**
 * 三层记忆入口。构造时可注入 `StorageLike` 与 `now()`：
 * 前者便于测试断言落盘/模拟配额异常，后者让 2h 过期、14 天衰减可被确定性验证。
 */
export class MemoryStore {
  private readonly storage: StorageLike;
  private readonly now: () => number;
  private data: MemoryData;
  /** 会话 → 距上次沉淀已累计的成功轮次（仅本实例内存态，不落盘）。 */
  private readonly pending = new Map<string, number>();

  constructor(storage?: StorageLike, now?: () => number) {
    this.storage = storage ?? createDefaultStorage();
    this.now = now ?? (() => Date.now());
    this.data = this.load();
  }

  private load(): MemoryData {
    const nowMs = this.now();
    return {
      working: readJson(this.storage, MEMORY_KEYS.working, {}, pickWorking),
      episodic: readJson(this.storage, MEMORY_KEYS.episodic, {}, (raw) => pickEpisodic(raw, nowMs)),
      semantic: readJson(this.storage, MEMORY_KEYS.semantic, {}, (raw) => pickSemantic(raw, nowMs)),
      // 设置缺键即用默认值（enabled/autoCapture 默认开，不能退化成 undefined）
      settings: readJson(this.storage, MEMORY_KEYS.settings, { ...DEFAULT_SETTINGS }, pickSettings),
    };
  }

  /** 注入时钟的读取口（召回/格式化等纯函数需要同一时间基准）。 */
  nowMs(): number {
    return this.now();
  }

  /* ------------------------------------------------------------- settings */

  getSettings(): MemorySettings {
    return { ...this.data.settings };
  }

  updateSettings(patch: Partial<MemorySettings>): void {
    this.data.settings = pickSettings({ ...this.data.settings, ...patch });
    writeJson(this.storage, MEMORY_KEYS.settings, this.data.settings);
  }

  /* -------------------------------------------------------------- working */

  /**
   * 追加一轮对话（成功或中断都记）。`at` 缺省用注入时钟，`partial=true` 标记中断轮次。
   */
  appendTurn(t: Omit<WorkingTurn, "id" | "at"> & { at?: string; partial?: boolean }): void {
    const at = t.at ?? new Date(this.now()).toISOString();
    const turn: WorkingTurn = {
      id: newId("w", this.now()),
      conversationId: String(t.conversationId ?? ""),
      agentId: String(t.agentId ?? ""),
      userText: String(t.userText ?? ""),
      assistantText: String(t.assistantText ?? ""),
      at,
      ...(t.partial ? { partial: true } : {}),
    };
    const list = [...(this.data.working[turn.conversationId] ?? []), turn].slice(-WORKING_LIMIT);
    this.data.working = { ...this.data.working, [turn.conversationId]: list };
    this.saveWorking();
  }

  /** 会话工作记忆：过滤 2h 前过期轮次，按时间先后返回（最多 40 轮）。 */
  working(conversationId: string, agentId?: string): WorkingTurn[] {
    const cutoff = this.now() - WORKING_TTL_MS;
    return (this.data.working[conversationId] ?? [])
      .filter((t) => t.conversationId === conversationId)
      .filter((t) => agentId === undefined || t.agentId === agentId)
      .filter((t) => {
        const at = Date.parse(t.at);
        return Number.isFinite(at) ? at >= cutoff : false;
      })
      .sort((a, b) => Date.parse(a.at) - Date.parse(b.at));
  }

  /**
   * 成功轮次的写入管道（设计 §3）：Working 追加 → 显式指令入 Semantic →
   * 每 6 轮沉淀 1 条 Episodic。整段 try/catch 静默，记忆失败不影响聊天主链路。
   */
  recordTurn(agentId: string, conversationId: string, userText: string, assistantText: string): void {
    try {
      if (!this.data.settings.enabled) return;
      this.appendTurn({ conversationId, agentId, userText, assistantText });
      if (!this.data.settings.autoCapture) return;

      const explicit = extractExplicitMemory(userText);
      if (explicit) {
        this.upsertSemantic({
          agentId,
          key: explicit.key,
          value: explicit.value,
          source: "explicit",
          confidence: EXPLICIT_CONFIDENCE,
        });
      }

      const key = `${agentId}\u0000${conversationId}`;
      const turns = (this.pending.get(key) ?? 0) + 1;
      if (turns < SEDIMENT_EVERY) {
        this.pending.set(key, turns);
        return;
      }
      this.pending.set(key, 0);
      const window = this.working(conversationId, agentId).slice(-SEDIMENT_EVERY);
      if (!window.length) return;
      this.addEpisodic({
        agentId,
        conversationId,
        summary: deterministicSummary(window[0].userText, window[window.length - 1].assistantText),
        sourceTurns: window.length,
      });
    } catch {
      /* 记忆任何异常都不外溢（设计 §3） */
    }
  }

  /* ------------------------------------------------------------- episodic */

  /** 情景记忆：过滤 retentionDays 之前的条目，最新在前。 */
  episodic(agentId: string): EpisodicEntry[] {
    const cutoff = this.now() - this.data.settings.retentionDays * DAY_MS;
    return (this.data.episodic[agentId] ?? [])
      .filter((e) => {
        const at = Date.parse(e.at);
        return Number.isFinite(at) ? at >= cutoff : false;
      })
      .sort((a, b) => Date.parse(b.at) - Date.parse(a.at));
  }

  /** 追加情景条目：摘要截 400 字、keywords 取摘要分词前 12；超 500 条按分数淘汰。 */
  addEpisodic(input: {
    agentId: string;
    conversationId: string;
    summary: string;
    sourceTurns?: number;
  }): EpisodicEntry {
    const nowMs = this.now();
    const summary = String(input.summary ?? "").slice(0, SUMMARY_MAX);
    const entry: EpisodicEntry = {
      id: newId("e", nowMs),
      agentId: String(input.agentId ?? ""),
      conversationId: String(input.conversationId ?? ""),
      summary,
      keywords: tokenize(summary).slice(0, 12),
      at: new Date(nowMs).toISOString(),
      importance: 0.5,
      sourceTurns: input.sourceTurns ?? 0,
    };
    let list = [...(this.data.episodic[entry.agentId] ?? []), entry];
    if (list.length > EPISODIC_LIMIT) {
      const excess = list.length - EPISODIC_LIMIT;
      const drop = new Set(
        list
          .map((e) => ({ id: e.id, score: e.importance * recencyScore(e.at, nowMs), at: e.at }))
          .sort((a, b) => a.score - b.score || (a.at < b.at ? -1 : 1))
          .slice(0, excess)
          .map((x) => x.id),
      );
      list = list.filter((e) => !drop.has(e.id));
    }
    this.data.episodic = { ...this.data.episodic, [entry.agentId]: list };
    this.saveEpisodic();
    return entry;
  }

  removeEpisodic(agentId: string, id: string): void {
    const list = (this.data.episodic[agentId] ?? []).filter((e) => e.id !== id);
    const next = { ...this.data.episodic };
    if (list.length) next[agentId] = list;
    else delete next[agentId];
    this.data.episodic = next;
    this.saveEpisodic();
  }

  /* ------------------------------------------------------------- semantic */

  /** 语义记忆：pinned 在前，其余按更新时间倒序。 */
  semantic(agentId: string): SemanticEntry[] {
    return [...(this.data.semantic[agentId] ?? [])].sort((a, b) => {
      if (a.pinned !== b.pinned) return a.pinned ? -1 : 1;
      return Date.parse(b.updatedAt) - Date.parse(a.updatedAt);
    });
  }

  /**
   * 同 agentId + key 更新而非追加：保留 id/createdAt/pinned，
   * 刷新 value/updatedAt（scope/confidence/source 以本次入参为准）。
   * 超 300 条时淘汰 confidence × recency 最低的非 pinned 条目。
   */
  upsertSemantic(input: {
    agentId: string;
    key: string;
    value: string;
    source: SemanticEntry["source"];
    confidence?: number;
    scope?: SemanticEntry["scope"];
  }): SemanticEntry {
    const agentId = String(input.agentId ?? "");
    const key = normalizeKey(input.key) || "未命名";
    const value = String(input.value ?? "").slice(0, 500);
    const nowIso = new Date(this.now()).toISOString();
    const list = this.data.semantic[agentId] ?? [];
    const existing = list.find((e) => e.key === key);

    let entry: SemanticEntry;
    let next: SemanticEntry[];
    if (existing) {
      entry = {
        ...existing,
        value,
        scope: input.scope ?? existing.scope,
        confidence: input.confidence ?? existing.confidence,
        source: input.source,
        updatedAt: nowIso,
      };
      next = list.map((e) => (e.id === existing.id ? entry : e));
    } else {
      entry = {
        id: newId("s", this.now()),
        agentId,
        key,
        value,
        scope: input.scope ?? "user",
        confidence: input.confidence ?? 0.6,
        pinned: false,
        source: input.source,
        createdAt: nowIso,
        updatedAt: nowIso,
      };
      next = [...list, entry];
    }

    if (next.length > SEMANTIC_LIMIT) {
      const nowMs = this.now();
      const excess = next.length - SEMANTIC_LIMIT;
      const evictable = next
        .filter((e) => !e.pinned)
        .map((e) => ({ id: e.id, score: e.confidence * recencyScore(e.updatedAt, nowMs), at: e.updatedAt }))
        .sort((a, b) => a.score - b.score || (a.at < b.at ? -1 : 1))
        .slice(0, excess)
        .map((x) => x.id);
      const drop = new Set(evictable);
      next = next.filter((e) => !drop.has(e.id));
    }

    this.data.semantic = { ...this.data.semantic, [agentId]: next };
    this.saveSemantic();
    return entry;
  }

  updateSemantic(
    agentId: string,
    id: string,
    patch: Partial<Pick<SemanticEntry, "key" | "value" | "pinned" | "confidence">>,
  ): void {
    const list = this.data.semantic[agentId] ?? [];
    const index = list.findIndex((e) => e.id === id);
    if (index < 0) return;
    const current = list[index];
    const updated: SemanticEntry = {
      ...current,
      ...(patch.key !== undefined ? { key: normalizeKey(patch.key) || current.key } : {}),
      ...(patch.value !== undefined ? { value: String(patch.value).slice(0, 500) } : {}),
      ...(patch.pinned !== undefined ? { pinned: !!patch.pinned } : {}),
      ...(patch.confidence !== undefined ? { confidence: patch.confidence } : {}),
      updatedAt: new Date(this.now()).toISOString(),
    };
    const next = [...list];
    next[index] = updated;
    this.data.semantic = { ...this.data.semantic, [agentId]: next };
    this.saveSemantic();
  }

  removeSemantic(agentId: string, id: string): void {
    const list = (this.data.semantic[agentId] ?? []).filter((e) => e.id !== id);
    const next = { ...this.data.semantic };
    if (list.length) next[agentId] = list;
    else delete next[agentId];
    this.data.semantic = next;
    this.saveSemantic();
  }

  /* ----------------------------------------------------------- 批量/导出 */

  /** 清空某智能体的三层记忆（Working 按 agentId 摘除，其余整键删除）。 */
  clearAgent(agentId: string): void {
    const working: Record<string, WorkingTurn[]> = {};
    for (const [conversationId, list] of Object.entries(this.data.working)) {
      const kept = list.filter((t) => t.agentId !== agentId);
      if (kept.length) working[conversationId] = kept;
    }
    const episodic = { ...this.data.episodic };
    const semantic = { ...this.data.semantic };
    delete episodic[agentId];
    delete semantic[agentId];
    this.pending.clear();
    this.data = { ...this.data, working, episodic, semantic };
    this.saveWorking();
    this.saveEpisodic();
    this.saveSemantic();
  }

  /** 导出全量（含设置）：`{ version: 1, exportedAt, data }`。 */
  exportAll(): string {
    return JSON.stringify(
      { version: EXPORT_VERSION, exportedAt: new Date(this.now()).toISOString(), data: this.data },
      null,
      2,
    );
  }

  /**
   * 导入全量：整体替换本机记忆（含设置）。校验版本与结构，
   * 失败返回具体错误且不动现有数据；条目级损坏只丢坏条目。
   */
  importAll(json: string): { ok: true } | { ok: false; error: string } {
    let parsed: unknown;
    try {
      parsed = JSON.parse(json);
    } catch {
      return { ok: false, error: "JSON 解析失败：不是合法的记忆导出内容" };
    }
    if (!isPlainObject(parsed)) return { ok: false, error: "导出内容结构不正确：应为对象" };
    if (parsed.version !== EXPORT_VERSION) {
      return { ok: false, error: `版本不支持：期望 ${EXPORT_VERSION}，实际 ${String(parsed.version)}` };
    }
    if (!isPlainObject(parsed.data)) return { ok: false, error: "导出内容结构不正确：缺少 data" };
    const data = parsed.data;
    const shaped = ["working", "episodic", "semantic", "settings"].some((k) => k in data);
    if (!shaped) return { ok: false, error: "导出内容结构不正确：data 缺少记忆字段" };
    for (const field of ["working", "episodic", "semantic", "settings"] as const) {
      if (field in data && data[field] !== undefined && !isPlainObject(data[field])) {
        return { ok: false, error: `导出内容结构不正确：${field} 应为对象` };
      }
    }

    const nowMs = this.now();
    this.data = {
      working: pickWorking(data.working),
      episodic: pickEpisodic(data.episodic, nowMs),
      semantic: pickSemantic(data.semantic, nowMs),
      settings: pickSettings(data.settings),
    };
    this.pending.clear();
    this.saveWorking();
    this.saveEpisodic();
    this.saveSemantic();
    writeJson(this.storage, MEMORY_KEYS.settings, this.data.settings);
    return { ok: true };
  }

  /* ---------------------------------------------------------------- 落盘 */

  private saveWorking(): void {
    const guarded = guardWorkingSize(this.data.working, KEY_SIZE_LIMIT);
    this.data.working = guarded;
    writeJson(this.storage, MEMORY_KEYS.working, guarded);
  }

  private saveEpisodic(): void {
    const nowMs = this.now();
    const guarded = guardScoredSize<EpisodicEntry>(
      this.data.episodic,
      KEY_SIZE_LIMIT,
      (e) => e.importance * recencyScore(e.at, nowMs),
      (e) => e.at,
    );
    this.data.episodic = guarded;
    writeJson(this.storage, MEMORY_KEYS.episodic, guarded);
  }

  private saveSemantic(): void {
    const nowMs = this.now();
    const guarded = guardScoredSize<SemanticEntry>(
      this.data.semantic,
      KEY_SIZE_LIMIT,
      (e) => e.confidence * recencyScore(e.updatedAt, nowMs),
      (e) => e.updatedAt,
      (e) => e.pinned,
    );
    this.data.semantic = guarded;
    writeJson(this.storage, MEMORY_KEYS.semantic, guarded);
  }
}
