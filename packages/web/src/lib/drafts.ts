/**
 * 按会话持久化的输入框草稿（d.31 · P2-1）。
 *
 * 背景：`ChatPage` 是**常驻底层**的（保持 WS 与流式状态，切会话不卸载），
 * 而草稿原是组件态 ⇒ 上一个会话写一半的字会直接带进下一个会话；刷新还全丢。
 *
 * 设计要点：
 * - **一个会话一个键**（`heming.draft.<convId>`），值里带最后修改时间（`{ text, at }`）——
 *   不另起索引键，避免「索引与正文不同步」这类经典问题。
 * - **LRU 上限 20 个会话**：与明文缓存用同一把尺子。草稿不是什么资产，
 *   但也不该无限增长把 5MB 的配额啃掉。
 * - **单条截尾 2000 字**：草稿是「还没发出去的话」，不是存档。
 * - **本机数据不出设备**：草稿不进任何导出、不上云。
 */

/** 草稿键前缀：一个会话一键。 */
export const DRAFT_PREFIX = "heming.draft.";

/** 保留的会话草稿数上限（超出按最久未修改淘汰）。 */
export const MAX_DRAFTS = 20;

/** 单条草稿的字符上限，超出截尾。 */
export const MAX_DRAFT_CHARS = 2000;

/** 截尾标记：让人一眼看出「后面还有，只是没存全」。 */
const ELLIPSIS = "…";

/**
 * 草稿存储的最小形状。
 *
 * 需要 `length` / `key(i)` 是因为 LRU 淘汰要**列出全部草稿键**；
 * 本仓记忆/任务用的 `StorageLike` 没有列键能力，所以这里单独定义一份。
 * jsdom 与浏览器里的 `localStorage` 天然满足这个形状。
 */
export interface DraftStorage {
  readonly length: number;
  key(index: number): string | null;
  getItem(key: string): string | null;
  setItem(key: string, value: string): void;
  removeItem(key: string): void;
}

/** 纯内存实现：localStorage 不可用（隐私模式 / SSR）时的兜底，只在本次会话有效。 */
export function createMemoryDraftStorage(): DraftStorage {
  const map = new Map<string, string>();
  return {
    get length() {
      return map.size;
    },
    key: (index) => [...map.keys()][index] ?? null,
    getItem: (key) => (map.has(key) ? (map.get(key) as string) : null),
    setItem: (key, value) => {
      map.set(key, value);
    },
    removeItem: (key) => {
      map.delete(key);
    },
  };
}

let storage: DraftStorage | null = null;

/** 取当前存储：默认 localStorage；访问本身可能抛（隐私模式），整段兜住。 */
function getStorage(): DraftStorage {
  if (storage) return storage;
  try {
    if (typeof localStorage !== "undefined" && localStorage) return localStorage;
  } catch {
    /* 隐私模式下访问 localStorage 可能直接抛 SecurityError */
  }
  return (storage = createMemoryDraftStorage());
}

/** 测试注入点：传 null 恢复默认（jsdom 的 localStorage）。 */
export function setDraftStorage(next: DraftStorage | null): void {
  storage = next;
}

/** 一条草稿的落盘形状。 */
interface StoredDraft {
  text: string;
  /** 最后修改时间（毫秒），LRU 淘汰的依据。 */
  at: number;
}

/**
 * 单调递增的时间戳。
 *
 * 为什么不是裸 `Date.now()`：同一毫秒里连续保存多条草稿（测试、批量粘贴）时时间戳会撞，
 * LRU 排序随即退化成「存储的插入顺序」——重写过的旧键在 Map 里位置不变，
 * 于是**刚编辑过的反而先被淘汰**。这里在撞秒时强制 +1，保证顺序严格单调。
 */
let lastDraftAt = 0;

function nextDraftAt(): number {
  const now = Date.now();
  lastDraftAt = now > lastDraftAt ? now : lastDraftAt + 1;
  return lastDraftAt;
}

/** 截尾到上限字符数（按码点切，避免把 emoji 劈成半个）。 */
export function clipDraft(text: string): string {
  const chars = [...text];
  if (chars.length <= MAX_DRAFT_CHARS) return text;
  return `${chars.slice(0, Math.max(0, MAX_DRAFT_CHARS - 1)).join("")}${ELLIPSIS}`;
}

/** 解析存下来的草稿；坏数据一律当作空草稿（绝不抛）。 */
function parseDraft(raw: string | null): StoredDraft | null {
  if (raw == null) return null;
  try {
    const parsed: unknown = JSON.parse(raw);
    if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) return null;
    const { text, at } = parsed as Record<string, unknown>;
    if (typeof text !== "string") return null;
    return { text, at: typeof at === "number" && Number.isFinite(at) ? at : 0 };
  } catch {
    return null;
  }
}

function draftKey(convId: string): string {
  return `${DRAFT_PREFIX}${convId}`;
}

/** 列出当前全部草稿键（只比较键名，不读值）。 */
function listDraftKeys(): string[] {
  const store = getStorage();
  const out: string[] = [];
  try {
    for (let i = 0; i < store.length; i += 1) {
      const key = store.key(i);
      if (key && key.startsWith(DRAFT_PREFIX)) out.push(key);
    }
  } catch {
    /* 列不出来就当没有 */
  }
  return out;
}

/**
 * 读某会话的草稿（没有则空串）。
 *
 * 任何异常（存储抛错、坏 JSON）都回落空串——草稿坏了不该拦住人打字。
 */
export function getDraft(convId: string): string {
  if (!convId) return "";
  try {
    return parseDraft(getStorage().getItem(draftKey(convId)))?.text ?? "";
  } catch {
    return "";
  }
}

/**
 * 写某会话的草稿。
 *
 * - 空串（或纯空白）视为删除：发完就该清，不留空壳；
 * - 超出上限截尾；
 * - 写完做一次 LRU 淘汰。
 */
export function setDraft(convId: string, text: string): void {
  if (!convId) return;
  try {
    const store = getStorage();
    if (!text.trim()) {
      store.removeItem(draftKey(convId));
      return;
    }
    const clip = clipDraft(text);
    const value: StoredDraft = { text: clip, at: nextDraftAt() };
    store.setItem(draftKey(convId), JSON.stringify(value));
    pruneDrafts();
  } catch {
    /* 配额满 / 隐私模式：草稿只在内存里（本次输入不丢，刷新会丢），不抛 */
  }
}

/** 删某会话的草稿（发送成功后调用）。 */
export function clearDraft(convId: string): void {
  if (!convId) return;
  try {
    getStorage().removeItem(draftKey(convId));
  } catch {
    /* 删不掉也只能这样 */
  }
}

/**
 * 清理超过 LRU 上限的旧草稿。
 *
 * 读每个草稿的 `at` 排序、删最旧的。草稿最多 21 条、每条 ≤ 2000 字，
 * 这点解析开销可以忽略；换来的是不引入第二个索引键。
 */
export function pruneDrafts(): void {
  try {
    const store = getStorage();
    const keys = listDraftKeys();
    if (keys.length <= MAX_DRAFTS) return;

    const rows = keys.map((key) => ({
      key,
      at: parseDraft(store.getItem(key))?.at ?? 0,
    }));
    rows.sort((a, b) => a.at - b.at); // 最旧在前
    for (const row of rows.slice(0, rows.length - MAX_DRAFTS)) {
      store.removeItem(row.key);
    }
  } catch {
    /* 清理失败不影响读写 */
  }
}
