/**
 * 「这一轮把更早的对话折叠成摘要了」这件事，得让人看见（d.217）。
 *
 * 背景：长任务跑到十几轮后，`prepareHistory` 会按预算把更早的消息折成一段摘要
 * （d.183 起还能手动 `/compact`）。但界面从头到尾**什么都不说**——用户看到的现象是
 * 「它怎么突然忘了我刚说的规矩」「我刚才让它别动那个文件，它又动了」，于是归因成
 * 「这模型不行」，而不是「那一轮之前的历史已经变成摘要了」。
 *
 * 口径：
 * - 只报事实：折叠了几条、什么时候折的；不解释「为什么模型会忘」（那是推断）；
 * - 按会话记，只留最近一次（用户关心的是「现在这轮是不是被压过」）；
 * - 只存内存 + localStorage 静默降级，坏数据丢弃；
 * - 会话里的原文一条都没删——被折的只是**发给模型的请求**，这点必须在文案里说清楚。
 */

export interface ContextFold {
  /** 被折进摘要的原始消息条数。 */
  foldedCount: number;
  /** 发生时间（毫秒时间戳）。 */
  at: number;
}

export const CONTEXT_FOLD_KEY = "heming.contextFold.v1";
export const MAX_CONTEXT_FOLD_SESSIONS = 20;

const store = new Map<string, ContextFold>();
let loaded = false;

function storage(): Storage | null {
  try {
    return typeof globalThis.localStorage === "undefined" ? null : globalThis.localStorage;
  } catch {
    return null;
  }
}

function isFold(value: unknown): value is ContextFold {
  if (!value || typeof value !== "object") return false;
  const fold = value as Partial<ContextFold>;
  return (
    typeof fold.foldedCount === "number" &&
    Number.isFinite(fold.foldedCount) &&
    fold.foldedCount > 0 &&
    typeof fold.at === "number" &&
    Number.isFinite(fold.at) &&
    fold.at > 0
  );
}

function load(): void {
  if (loaded) return;
  loaded = true;
  const bag = storage();
  if (!bag) return;
  try {
    const raw = bag.getItem(CONTEXT_FOLD_KEY);
    if (!raw) return;
    const parsed: unknown = JSON.parse(raw);
    if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) return;
    for (const [conversationId, value] of Object.entries(parsed as Record<string, unknown>)) {
      if (conversationId && isFold(value)) store.set(conversationId, { foldedCount: value.foldedCount, at: value.at });
    }
  } catch {
    /* 读失败就当没有 */
  }
}

function persist(): void {
  const bag = storage();
  if (!bag) return;
  try {
    // 只留最近的若干会话，避免长年累积把 storage 撑满
    const entries = [...store.entries()].sort((a, b) => b[1].at - a[1].at).slice(0, MAX_CONTEXT_FOLD_SESSIONS);
    const out: Record<string, ContextFold> = {};
    for (const [conversationId, fold] of entries) out[conversationId] = fold;
    bag.setItem(CONTEXT_FOLD_KEY, JSON.stringify(out));
  } catch {
    /* 配额满等一律静默：这是旁路提示，不值得让主流程失败 */
  }
}

/** 记一次折叠。`foldedCount <= 0` 视为没折叠（不覆盖上一次的真实记录）。 */
export function recordContextFold(conversationId: string, foldedCount: number, now = Date.now()): void {
  if (!conversationId) return;
  if (!Number.isFinite(foldedCount) || foldedCount <= 0) return;
  load();
  store.set(conversationId, { foldedCount: Math.trunc(foldedCount), at: now });
  persist();
}

/** 最近一次折叠；没有就是 null（拷贝，调用方改不脏内部）。 */
export function getContextFold(conversationId: string): ContextFold | null {
  if (!conversationId) return null;
  load();
  const fold = store.get(conversationId);
  return fold ? { foldedCount: fold.foldedCount, at: fold.at } : null;
}

export function clearContextFold(conversationId?: string): void {
  load();
  if (conversationId) {
    if (!store.delete(conversationId)) return;
  } else {
    if (store.size === 0) return;
    store.clear();
  }
  persist();
}

export function resetContextFolds(): void {
  store.clear();
  loaded = true;
  const bag = storage();
  try {
    bag?.removeItem(CONTEXT_FOLD_KEY);
  } catch {
    /* 忽略 */
  }
}

/** 折叠当下给用户看的一句话（ChatPage 的提示位用；说清「原文没删」）。 */
export function foldNoticeText(foldedCount: number): string {
  const count = Number.isFinite(foldedCount) && foldedCount > 0 ? Math.trunc(foldedCount) : 0;
  return (
    `上下文接近上限：更早的 ${count} 条消息已经折成摘要发给模型（会话里的原文一条没删）。` +
    "如果它忘了之前的要求，把关键约束再说一遍，或者先发 /compact 手动压一次再继续。"
  );
}

/** 距今多久（分钟口径，给状态自检用，不依赖具体时间格式）。 */
export function foldAgeMinutes(fold: ContextFold, now = Date.now()): number {
  const age = now - fold.at;
  if (!Number.isFinite(age) || age <= 0) return 0;
  return Math.floor(age / 60_000);
}

export function formatFoldAgeMinutes(minutes: number): string {
  if (!Number.isFinite(minutes) || minutes <= 0) return "刚刚";
  if (minutes < 60) return `${Math.floor(minutes)} 分钟前`;
  const hours = Math.floor(minutes / 60);
  if (hours < 24) return `${hours} 小时前`;
  return `${Math.floor(hours / 24)} 天前`;
}
