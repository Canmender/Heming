import type {
  EpisodicEntry,
  MemoryData,
  MemorySettings,
  SemanticEntry,
  StorageLike,
  WorkingTurn,
} from "./types.js";
import { GLOBAL_AGENT_ID } from "./types.js";
import {
  KEY_SIZE_LIMIT,
  MEMORY_KEYS,
  MEMORY_PENDING_KEY,
  createDefaultStorage,
  isPlainObject,
  readJson,
  utf8Length,
  writeJson,
} from "./storage.js";
import { tokenize } from "./tokenize.js";
import { SUMMARY_MAX, deterministicSummary, extractExplicitMemory, normalizeKey } from "./extract.js";
import type { VaultMemoryPointer } from "../vault/types.js";
import { VAULT_MEMORY_MAX } from "../vault/types.js";
import { enqueueMemoryWrite } from "./memoryWriteBack.js";

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

/**
 * 知识库指针条目的写入入参（d.114）。
 * 记忆层不 import `lib/vault/store`：由集成侧把 vault store 适配成 `VaultDocSource`，
 * 同步逻辑（vaultMemory.ts）负责产出这些入参，store 只负责落库。
 */
export interface VaultEntryInput {
  /** 库内相对路径，同时作为 `key`（≥ 24 字也原样保留，不归一化）。 */
  rel: string;
  vaultId: string;
  /** 文件 mtime（ISO）：`updatedAt` 直接吃它，同步结果因此与机器时钟无关。 */
  mtime: string;
  /** 内容 hash：与 mtime 一起决定「跳过还是更新」。 */
  hash: string;
  /** 摘要（≤ 500 字）。 */
  value: string;
  /** 归属智能体，缺省 `GLOBAL_AGENT_ID`（知识库是所有智能体共用的）。 */
  agentId?: string;
}

/** 知识库条目批量写入结果：**配额失败如实返回失败**，不静默吞掉。 */
export interface VaultUpsertResult {
  ok: boolean;
  /** 真正落库的条数。 */
  written: number;
  /** 落库时被本机配额挤掉的条数（>0 说明资源不够，`ok` 同时为 false）。 */
  dropped: number;
  /** 失败原因（中文，给界面直接展示）。 */
  error?: string;
}

export const DEFAULT_SETTINGS: MemorySettings = {
  enabled: true,
  autoCapture: true,
  retentionDays: 90,
  // 老用户默认开启：没有知识库条目时它不产生任何注入，升级不改变既有行为。
  vaultMemory: true,
};

const DAY_MS = 86_400_000;
/**
 * 沉淀计数表用的会话键分隔符：NUL。
 *
 * 为什么用 NUL 而不是空格或冒号：agentId / conversationId 都是自由文本，
 * 只有 NUL 不可能出现在用户数据里 ⇒ 拼接后可以无歧义地拆回去，
 * 也让「按 agentId 前缀清」「按 conversationId 后缀清」不会互相误伤。
 */
const SESSION_KEY_SEP = "\u0000";
let idSeq = 0;

function newId(prefix: string, nowMs: number): string {
  idSeq += 1;
  return `${prefix}-${nowMs.toString(36)}-${idSeq.toString(36)}-${Math.random().toString(36).slice(2, 6)}`;
}

/**
 * 知识库指针条目的**稳定** id：同一 rel 跨刷新、跨同步保持不变。
 *
 * 为什么不用 newId（含时间与随机）：个性化权重账本、召回日志都按 id 记；
 * 每次同步换 id 会让「这篇笔记被引用过几次」永远清零。用两段 FNV 变体凑够位数，
 * 纯函数、无依赖，同一 rel 在任何机器上都得到同一个 id。
 */
function vaultEntryId(rel: string): string {
  let h1 = 0x811c9dc5;
  let h2 = 0x1000193;
  for (let i = 0; i < rel.length; i++) {
    const code = rel.charCodeAt(i);
    h1 = Math.imul(h1 ^ code, 0x01000193);
    h2 = Math.imul(h2 ^ code, 0x85ebca6b);
  }
  return `v-${(h1 >>> 0).toString(36)}-${(h2 >>> 0).toString(36)}`;
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
      const updatedAt = typeof item.updatedAt === "string" ? item.updatedAt : now;
      const vault = item.source === "vault" ? pickVaultPointer(item.vault) : null;
      // 知识库条目是**指针型**：没有合法指针就无法定位文件，等同坏条目降级为普通手动记忆，
      // 而不是整条丢弃（用户至少还能看到那段摘要并手动删掉）。
      const isVault = vault !== null;
      items.push({
        id: item.id,
        agentId: item.agentId,
        // vault 的 key 是 rel（可能含目录与 `.md`，长度远超 24 字）：
        // 不能走 normalizeKey 的 24 字截断，否则不同目录下的同名文件会撞成一个键。
        key: isVault ? String(item.key).slice(0, 300) : normalizeKey(item.key),
        value: item.value.slice(0, 500),
        scope: item.scope === "agent" ? "agent" : "user",
        confidence: typeof item.confidence === "number" && Number.isFinite(item.confidence) ? item.confidence : 0.5,
        pinned: item.pinned === true,
        source: isVault
          ? "vault"
          : item.source === "explicit" || item.source === "consolidate" || item.source === "manual"
            ? item.source
            : "manual",
        createdAt: typeof item.createdAt === "string" ? item.createdAt : now,
        updatedAt,
        // 老数据没有 metaUpdatedAt：以 updatedAt 顶替，**不填成"现在"**。
        // 填成现在会凭空造出一批「刚刚整理过」的假象；顶替最稳（不迁移、不报错）。
        metaUpdatedAt: typeof item.metaUpdatedAt === "string" ? item.metaUpdatedAt : updatedAt,
        ...(isVault ? { vault } : {}),
      });
    }
    if (items.length) out[key] = items;
  }
  return out;
}

/** 校验并归一一条知识库指针；字段缺失/类型不符视为没有指针（返回 null）。 */
function pickVaultPointer(raw: unknown): VaultMemoryPointer | null {
  if (!isPlainObject(raw)) return null;
  if (
    typeof raw.vaultId !== "string" ||
    typeof raw.rel !== "string" ||
    typeof raw.mtime !== "string" ||
    typeof raw.hash !== "string" ||
    !raw.vaultId ||
    !raw.rel
  ) {
    return null;
  }
  return { vaultId: raw.vaultId, rel: raw.rel, mtime: raw.mtime, hash: raw.hash };
}

function pickSettings(raw: unknown): MemorySettings {
  if (!isPlainObject(raw)) return { ...DEFAULT_SETTINGS };
  const vaultMemoryMax =
    typeof raw.vaultMemoryMax === "number" && Number.isFinite(raw.vaultMemoryMax) && raw.vaultMemoryMax > 0
      ? Math.floor(raw.vaultMemoryMax)
      : undefined;
  return {
    enabled: typeof raw.enabled === "boolean" ? raw.enabled : DEFAULT_SETTINGS.enabled,
    autoCapture: typeof raw.autoCapture === "boolean" ? raw.autoCapture : DEFAULT_SETTINGS.autoCapture,
    retentionDays:
      typeof raw.retentionDays === "number" && Number.isFinite(raw.retentionDays) && raw.retentionDays > 0
        ? raw.retentionDays
        : DEFAULT_SETTINGS.retentionDays,
    // 老数据没有该键 → 默认 true（不迁移、不报错；关掉它是用户显式动作，不由升级代劳）。
    vaultMemory: typeof raw.vaultMemory === "boolean" ? raw.vaultMemory : DEFAULT_SETTINGS.vaultMemory,
    // 可选字段：缺失时**不写空键**，让 getSettings() 与老版本导出的设置对象逐字相等。
    ...(vaultMemoryMax !== undefined ? { vaultMemoryMax } : {}),
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

/* --------------------------------------------------------------- 沉淀计数 */

/**
 * 沉淀计数表的水合：`{ [会话键]: 计数 }`。
 *
 * 容错：坏 JSON → 空表；非对象 → 空表；单条值不是有限非负整数 → **只丢这一条**（其余保留）。
 * 单条容错是刻意的：一个会话的计数坏了，不该连累别的会话的沉淀节奏。
 */
function pickPending(raw: unknown): Map<string, number> {
  const out = new Map<string, number>();
  if (!isPlainObject(raw)) return out;
  for (const [key, value] of Object.entries(raw)) {
    if (typeof value !== "number" || !Number.isFinite(value) || value < 0) continue;
    out.set(key, Math.floor(value));
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
  /**
   * 会话 → 距上次沉淀已累计的成功轮次。
   *
   * **落盘**（`heming.memory.pending.v1`）：以前只在内存里，刷新页面/重启客户端就归零，
   * 于是「每 6 轮沉淀一次」的阈值永远攒不满 ⇒ 长会话永远沉淀不出来。
   * 落盘后计数能跨会话存活，才谈得上「节奏」。
   */
  private readonly pending = new Map<string, number>();

  constructor(storage?: StorageLike, now?: () => number) {
    this.storage = storage ?? createDefaultStorage();
    this.now = now ?? (() => Date.now());
    this.data = this.load();
    // 坏 JSON / 非对象都在 pickPending 里回落成空表（读侧容错，坏计数器不该挡住启动）
    const rawPending = readJson<unknown>(this.storage, MEMORY_PENDING_KEY, null);
    for (const [key, count] of pickPending(rawPending)) {
      this.pending.set(key, count);
    }
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
        // 沉淀写回知识库（d.114）：入队 + 异步落盘，失败只上报、不影响记忆本身。
        enqueueMemoryWrite({ kind: "explicit", key: explicit.key, value: explicit.value, agentId });
      }

      const key = `${agentId}\u0000${conversationId}`;
      const turns = (this.pending.get(key) ?? 0) + 1;
      if (turns < SEDIMENT_EVERY) {
        this.pending.set(key, turns);
        this.savePending();
        return;
      }
      this.pending.set(key, 0);
      this.savePending();
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

  /** 清空单个会话的短期记忆（记忆页「清空当前会话」）。 */
  clearConversation(conversationId: string): void {
    // 沉淀计数也要清：会话都没了，攒着的轮次不该继续算进下一次沉淀。
    this.clearPendingForConversation(conversationId);
    if (!(conversationId in this.data.working)) return;
    const next = { ...this.data.working };
    delete next[conversationId];
    this.data.working = next;
    this.saveWorking();
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

  /**
   * 语义记忆：pinned 在前，其余按更新时间倒序。
   *
   * **含全局共用条目**（用户要求「长期记忆所有智能体公用」）：把 `GLOBAL_AGENT_ID`
   * 桶与本智能体桶合并返回。全局条目排前面——它们是被全体共用的既定事实，
   * 比某个智能体的私有观察更值得优先占据提示词预算。
   */
  semantic(agentId: string): SemanticEntry[] {
    const own = this.data.semantic[agentId] ?? [];
    const shared = agentId === GLOBAL_AGENT_ID ? [] : this.data.semantic[GLOBAL_AGENT_ID] ?? [];
    return [...shared, ...own].sort((a, b) => {
      if (a.pinned !== b.pinned) return a.pinned ? -1 : 1;
      return Date.parse(b.updatedAt) - Date.parse(a.updatedAt);
    });
  }

  /** 只取全局共用桶（记忆区「数据库」标签展示用——那里看到的就是全部智能体的公用记忆）。 */
  semanticGlobal(): SemanticEntry[] {
    return [...(this.data.semantic[GLOBAL_AGENT_ID] ?? [])].sort((a, b) => {
      if (a.pinned !== b.pinned) return a.pinned ? -1 : 1;
      return Date.parse(b.updatedAt) - Date.parse(a.updatedAt);
    });
  }

  /** 该条目是否属于全局共用桶（界面标注「公用」用）。 */
  static isGlobal(entry: SemanticEntry): boolean {
    return entry.agentId === GLOBAL_AGENT_ID;
  }

  /**
   * 按（归一后的）主题键查一条语义记忆：外部模块判断「是更新还是新增」时用它，
   * 避免各自复制一份键归一逻辑导致口径漂移（复盘写入就靠它避免重复占额度）。
   */
  findSemantic(agentId: string, key: string): SemanticEntry | undefined {
    const normalized = normalizeKey(key) || "未命名";
    // 先查本智能体桶再查全局桶：同名 key 以更具体的那个为准
    return (this.data.semantic[String(agentId ?? "")] ?? []).find((e) => e.key === normalized)
      ?? (agentId === GLOBAL_AGENT_ID
        ? undefined
        : (this.data.semantic[GLOBAL_AGENT_ID] ?? []).find((e) => e.key === normalized));
  }

  /**
   * 同 agentId + key 更新而非追加：保留 id/createdAt/pinned，
   * 刷新 value/updatedAt（scope/confidence/source 以本次入参为准）。
   * 超 300 条时淘汰 confidence × recency 最低的非 pinned 条目。
   *
   * **updatedAt 与 metaUpdatedAt 一起刷**：upsert 总是覆盖 value（内容变了），
   * 而 source/confidence 也可能变 ⇒ 两个时间都算「刚动过」。
   */
  upsertSemantic(input: {
    agentId: string;
    key: string;
    value: string;
    source: SemanticEntry["source"];
    confidence?: number;
    scope?: SemanticEntry["scope"];
    /** 显式指定落哪个桶；省略即落全局共用桶（用户要求长期记忆所有智能体公用）。 */
    bucket?: string;
  }): SemanticEntry {
    // 两个概念必须分开：
    // - bucket：这条数据**存在哪个桶**（省略=全局共用桶）
    // - agentId：这条数据**是谁写的**（始终是真实智能体 id，界面要显示、clearAgent 要按它清理）
    // 早先把两者混为一谈，会让全局桶里的条目 agentId 也变成 "__global__"，
    // 于是既看不出是谁沉淀的，清空某个智能体时也清不掉它。
    const bucket = String(input.bucket ?? GLOBAL_AGENT_ID);
    const ownerId = String(input.agentId ?? "");
    const key = normalizeKey(input.key) || "未命名";
    const value = String(input.value ?? "").slice(0, 500);
    const nowIso = new Date(this.now()).toISOString();
    const list = this.data.semantic[bucket] ?? [];
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
        metaUpdatedAt: nowIso,
      };
      next = list.map((e) => (e.id === existing.id ? entry : e));
    } else {
      entry = {
        id: newId("s", this.now()),
        agentId: ownerId,
        key,
        value,
        scope: input.scope ?? "user",
        confidence: input.confidence ?? 0.6,
        pinned: false,
        source: input.source,
        createdAt: nowIso,
        updatedAt: nowIso,
        metaUpdatedAt: nowIso,
      };
      next = [...list, entry];
    }

    if (next.length > SEMANTIC_LIMIT) {
      // 配额只按「普通语义条目」算：知识库指针条目另有上限（`VAULT_MEMORY_MAX`）。
      // 混在一起的话，同步一篇 500 条的知识库后随便再存一条普通记忆，
      // 就会把用户的旧长期记忆按分数挤掉——那不是配额守卫该干的事。
      const plain = next.filter((e) => e.source !== "vault");
      const excess = plain.length - SEMANTIC_LIMIT;
      if (excess > 0) {
        const nowMs = this.now();
        const evictable = plain
          .filter((e) => !e.pinned)
          .map((e) => ({ id: e.id, score: e.confidence * recencyScore(e.updatedAt, nowMs), at: e.updatedAt }))
          .sort((a, b) => a.score - b.score || (a.at < b.at ? -1 : 1))
          .slice(0, excess)
          .map((x) => x.id);
        const drop = new Set(evictable);
        next = next.filter((e) => !drop.has(e.id));
      }
    }

    this.data.semantic = { ...this.data.semantic, [bucket]: next };
    this.saveSemantic();
    return entry;
  }

  /** 在一个桶内按 id 找条目，返回 [桶名, 下标]。找不到返回 null。 */
  private locateSemantic(id: string, preferred: string): [string, number] | null {
    const preferredList = this.data.semantic[preferred] ?? [];
    const inPreferred = preferredList.findIndex((e) => e.id === id);
    if (inPreferred >= 0) return [preferred, inPreferred];
    // 语义记忆默认落全局桶，调用方传的 agentId 可能不是它所在的桶。
    // id 是全局唯一的，因此可以安全地扫一遍其余桶——只有全局与本智能体两个候选，
    // 直接显式查这两处即可，不必全表遍历。
    for (const bucket of [GLOBAL_AGENT_ID, preferred]) {
      const list = this.data.semantic[bucket] ?? [];
      const index = list.findIndex((e) => e.id === id);
      if (index >= 0) return [bucket, index];
    }
    return null;
  }

  /**
   * 局部改一条语义记忆。
   *
   * **updatedAt / metaUpdatedAt 分开刷**（d.30 P1-3）：
   * - `value` 或 `key` 真的变了 → 两个时间都刷新（内容变了）；
   * - 只改 `pinned` / `confidence` → **只刷 metaUpdatedAt**，`updatedAt` 原样保留。
   *
   * 为什么：recency 与淘汰打分都吃 `updatedAt`。早先把两者绑死，用户改一个错别字
   * 就会让这条记忆在系统眼里「刚刚更新过」⇒ recency 满血、冷门判定失效。
   * 「给人看的时效」与「机器用的时效」必须能分开。
   */
  updateSemantic(
    agentId: string,
    id: string,
    patch: Partial<Pick<SemanticEntry, "key" | "value" | "pinned" | "confidence">>,
  ): void {
    // 条目可能在全局桶（默认落点），不保证在传入的 agentId 桶里
    const found = this.locateSemantic(id, String(agentId ?? ""));
    if (!found) return;
    const [bucket, index] = found;
    const list = this.data.semantic[bucket] ?? [];
    const current = list[index];
    const nextKey = patch.key !== undefined ? normalizeKey(patch.key) || current.key : current.key;
    const nextValue = patch.value !== undefined ? String(patch.value).slice(0, 500) : current.value;
    // 内容是否真的变了：key/value 任一不同即算内容变更（去掉「传了但值一样」的情况）。
    const contentChanged = nextKey !== current.key || nextValue !== current.value;
    // 元数据是否被动了：patch 里带了 pinned / confidence 即算「被人动过」。
    const metaTouched = patch.pinned !== undefined || patch.confidence !== undefined;
    const nowIso = new Date(this.now()).toISOString();
    const updated: SemanticEntry = {
      ...current,
      ...(patch.key !== undefined ? { key: nextKey } : {}),
      ...(patch.value !== undefined ? { value: nextValue } : {}),
      ...(patch.pinned !== undefined ? { pinned: !!patch.pinned } : {}),
      ...(patch.confidence !== undefined ? { confidence: patch.confidence } : {}),
      // 内容变了 → updatedAt 与 metaUpdatedAt 一起刷新；
      // 只动元数据 → 只刷 metaUpdatedAt，updatedAt 原样保留（recency 不受影响）；
      // 什么都没变 → 两个时间都不动。
      ...(contentChanged
        ? { updatedAt: nowIso, metaUpdatedAt: nowIso }
        : metaTouched
          ? { metaUpdatedAt: nowIso }
          : {}),
    };
    const next = [...list];
    next[index] = updated;
    // 写回所在的那个桶（可能是全局桶），不是传入的 agentId
    this.data.semantic = { ...this.data.semantic, [bucket]: next };
    this.saveSemantic();
  }

  removeSemantic(agentId: string, id: string): void {
    const found = this.locateSemantic(id, String(agentId ?? ""));
    if (!found) return;
    const [bucket] = found;
    const list = (this.data.semantic[bucket] ?? []).filter((e) => e.id !== id);
    const next = { ...this.data.semantic };
    if (list.length) next[bucket] = list;
    else delete next[bucket];
    this.data.semantic = next;
    this.saveSemantic();
  }

  /* --------------------------------------------------------------- vault */

  /**
   * 全部知识库指针条目（跨桶汇总，按 rel 升序）。
   *
   * 排序固定而不是按 updatedAt：同步与召回都要在同一份输入上得到同一份输出，
   * 桶的遍历顺序不该影响行为（确定性契约）。
   */
  vaultEntries(): SemanticEntry[] {
    const all: SemanticEntry[] = [];
    for (const list of Object.values(this.data.semantic)) {
      for (const entry of list) if (entry.source === "vault") all.push(entry);
    }
    return all.sort((a, b) => (a.key < b.key ? -1 : a.key > b.key ? 1 : 0));
  }

  /** 知识库指针条目的上限：设置里的 `vaultMemoryMax`（缺省 = `VAULT_MEMORY_MAX`）。 */
  vaultMemoryLimit(): number {
    const raw = this.data.settings.vaultMemoryMax;
    return typeof raw === "number" && Number.isFinite(raw) && raw > 0 ? Math.floor(raw) : VAULT_MEMORY_MAX;
  }

  /**
   * 批量写入/更新知识库指针条目（**只碰 `source: "vault"`**，其它来源的条目原样不动）。
   *
   * 返回结构刻意区分「没写进去」的两种原因：
   * - 本机配额把条目挤掉了 → `dropped > 0`；
   * - localStorage 写失败（配额满/隐私模式）→ `ok: false` + `error`。
   * 两者都必须让调用方（记忆页/同步结果）看见，静默失败会让用户以为知识库已纳入。
   */
  upsertVaultEntries(inputs: VaultEntryInput[]): VaultUpsertResult {
    if (!inputs.length) return { ok: true, written: 0, dropped: 0 };
    const bucket = GLOBAL_AGENT_ID;
    const list = this.data.semantic[bucket] ?? [];
    const inputByKey = new Map<string, VaultEntryInput>();
    for (const input of inputs) {
      const rel = String(input.rel ?? "");
      if (!rel) continue;
      inputByKey.set(rel, input);
    }
    if (!inputByKey.size) return { ok: true, written: 0, dropped: 0 };

    const build = (prev: SemanticEntry | undefined, input: VaultEntryInput): SemanticEntry => {
      const rel = String(input.rel);
      const at = typeof input.mtime === "string" && input.mtime ? input.mtime : new Date(this.now()).toISOString();
      return {
        id: prev?.id ?? vaultEntryId(rel),
        agentId: String(input.agentId ?? prev?.agentId ?? GLOBAL_AGENT_ID),
        key: rel.slice(0, 300),
        value: String(input.value ?? "").slice(0, 500),
        scope: "user",
        confidence: prev?.confidence ?? 0.6,
        pinned: false,
        source: "vault",
        createdAt: prev?.createdAt ?? at,
        // updatedAt 跟文件 mtime 走，不跟"同步时刻"走：知识库的时间语义属于文件。
        updatedAt: at,
        metaUpdatedAt: at,
        vault: {
          vaultId: String(input.vaultId ?? prev?.vault?.vaultId ?? ""),
          rel,
          mtime: String(input.mtime ?? ""),
          hash: String(input.hash ?? ""),
        },
      };
    };

    const merged: SemanticEntry[] = [];
    const replaced = new Set<string>();
    for (const entry of list) {
      if (entry.source !== "vault") {
        merged.push(entry);
        continue;
      }
      const input = inputByKey.get(entry.key);
      if (!input) {
        merged.push(entry);
        continue;
      }
      merged.push(build(entry, input));
      replaced.add(entry.key);
    }
    for (const [rel, input] of inputByKey) {
      if (!replaced.has(rel)) merged.push(build(undefined, input));
    }

    this.data.semantic = { ...this.data.semantic, [bucket]: merged };
    const persisted = this.saveSemantic();
    // 配额守卫可能又挤掉条目：以落库后的真实状态为准回报，而不是报「我提交了几条」。
    const present = new Set(
      (this.data.semantic[bucket] ?? []).filter((e) => e.source === "vault").map((e) => e.key),
    );
    const dropped = [...inputByKey.keys()].filter((rel) => !present.has(rel.slice(0, 300))).length;
    if (!persisted) {
      return {
        ok: false,
        // 没写进本机存储 = 没有一条真正落库（内存态仍可用，但不算「已纳入」）。
        written: 0,
        dropped,
        error: "本机存储配额不足：知识库条目未能写入本机（当前仅保留在内存里）",
      };
    }
    if (dropped > 0) {
      return {
        ok: false,
        written: inputByKey.size - dropped,
        dropped,
        error: `本机存储配额不足：有 ${dropped} 篇知识库笔记未能纳入记忆`,
      };
    }
    return { ok: true, written: inputByKey.size, dropped: 0 };
  }

  /** 删除指定 rel 的知识库指针条目（只删 `source: "vault"`），返回删除条数。 */
  removeVaultEntries(keys: Iterable<string>): number {
    const drop = new Set(keys);
    if (!drop.size) return 0;
    let removed = 0;
    const next: Record<string, SemanticEntry[]> = { ...this.data.semantic };
    for (const [bucket, list] of Object.entries(this.data.semantic)) {
      const kept = list.filter((entry) => {
        const hit = entry.source === "vault" && drop.has(entry.key);
        if (hit) removed += 1;
        return !hit;
      });
      if (kept.length) next[bucket] = kept;
      else delete next[bucket];
    }
    if (removed) {
      this.data.semantic = next;
      this.saveSemantic();
    }
    return removed;
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
    // 全局桶里的条目也是这个智能体写的，一并清掉——
    // 否则「清空该智能体的记忆」后，它沉淀的公用长期记忆还留着，说不清是谁的。
    // 条件是 `!==`（保留**别的**智能体写的），不是 `===`。
    const globalLeft = (semantic[GLOBAL_AGENT_ID] ?? []).filter((e) => e.agentId !== agentId);
    if (globalLeft.length) semantic[GLOBAL_AGENT_ID] = globalLeft;
    else delete semantic[GLOBAL_AGENT_ID];
    // 只清这个 agent 名下的会话计数：别的 agent 还在攒轮次，不能连坐。
    this.clearPendingForAgent(agentId);
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
    this.clearPendingAll();
    this.saveWorking();
    this.saveEpisodic();
    this.saveSemantic();
    writeJson(this.storage, MEMORY_KEYS.settings, this.data.settings);
    return { ok: true };
  }

  /* ---------------------------------------------------------------- 落盘 */

  /**
   * 沉淀计数落盘（`heming.memory.pending.v1`）。
   *
   * 每次计数变化写一次——这是低频操作（每轮对话一次），不值得为它做节流。
   * 写入失败静默：计数器丢了只会退回「重新开始攒」，不该影响聊天主链路。
   */
  private savePending(): void {
    const table: Record<string, number> = {};
    for (const [key, count] of this.pending) table[key] = count;
    writeJson(this.storage, MEMORY_PENDING_KEY, table);
  }

  /** 清掉某个会话在所有 agent 名下的计数（会话键形如 `${agentId}\u0000${conversationId}`）。 */
  private clearPendingForConversation(conversationId: string): void {
    let changed = false;
    for (const key of [...this.pending.keys()]) {
      // 用后缀匹配会话 id：agentId 里含同样文字时不会误伤（分隔符是 NUL，agentId 不含它）
      if (key.endsWith(SESSION_KEY_SEP + conversationId)) {
        this.pending.delete(key);
        changed = true;
      }
    }
    if (changed) this.savePending();
  }

  /** 清掉某个 agent 名下所有会话的计数。 */
  private clearPendingForAgent(agentId: string): void {
    let changed = false;
    for (const key of [...this.pending.keys()]) {
      if (key.startsWith(agentId + SESSION_KEY_SEP)) {
        this.pending.delete(key);
        changed = true;
      }
    }
    if (changed) this.savePending();
  }

  /** 全清（导入全量时用）。 */
  private clearPendingAll(): void {
    this.pending.clear();
    this.savePending();
  }

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

  /**
   * 语义层落盘：返回「是否真的写进本机存储」。
   *
   * 以前这里忽略 writeJson 的返回值（静默降级）。知识库同步需要如实上报配额失败，
   * 所以把布尔值返回给能用上它的调用方；其它既有调用方不读返回值，行为不变。
   */
  private saveSemantic(): boolean {
    const nowMs = this.now();
    const guarded = guardScoredSize<SemanticEntry>(
      this.data.semantic,
      KEY_SIZE_LIMIT,
      (e) => e.confidence * recencyScore(e.updatedAt, nowMs),
      (e) => e.updatedAt,
      (e) => e.pinned,
    );
    this.data.semantic = guarded;
    return writeJson(this.storage, MEMORY_KEYS.semantic, guarded);
  }
}
