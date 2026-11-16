/**
 * 长输出的「溢出文件」（spill）。
 *
 * 为什么要有这一块：工具结果的硬上限是 8000 字符（`MAX_TOOL_RESULT_CHARS`），
 * 超出就只留头 2/3 + 尾 1/3，中间那段**永久丢失**。短任务里这没问题——
 * 真需要就缩小参数重查一次。但长任务里最常见的失败恰恰是：
 * 一次 `run_command` 跑了 `pnpm build`、一次 `grep` 扫到 300 条、一次 `file_read`
 * 读了 5 万字配置——模型只看到头尾，中间那 90% 才是答案所在，它却连「该往哪查」都不知道，
 * 于是要么重复调用、要么凭头尾瞎猜。
 *
 * 做法：超限时把**完整文本**留在这里，只把「预览 + 一个 handle」交给模型；
 * 模型需要时用 `tool_output_read` 按字符窗口分段读回来。
 * 这与 DSH 的 `spill` 是同一个思路（它落会话私有文件）。
 *
 * 取舍写清楚：
 * - **内存**：一次会话里的长输出可能几十 MB，所以有总字符上限与条数上限，超出淘汰最旧；
 * - **最近一部分跨重启存活**（d.190）：内存里的完整文本有上限，落 localStorage 只保留
 *   **最近 600K 字符**——会话历史在重启后会被重新读出来，历史里那些「完整内容见 spill-3」
 *   的引用只有在 spill-3 还在时才对得上。超出这个额度或写不进去（配额满）时，
 *   handle 会在重启后明确说「已不在了」，而不是返回空字符串假装成功；
 * - **按字符而不是按行**：模型给的 offset/limit 都是字符数，切到半个汉字也无所谓，
 *   预览里已经写清「这是第几段、还有多少」。
 */

export interface SpillEntry {
  id: string;
  text: string;
  chars: number;
  /** 产生这条溢出的是哪个工具（只为渲染与调试，不参与读取逻辑）。 */
  tool?: string;
  createdAt: number;
}

export interface SpillPreview {
  id: string;
  chars: number;
  preview: string;
}

/** 同时保留多少条：长任务里工具调用可能上百次，留最近 40 条足够回溯。 */
export const MAX_SPILL_ITEMS = 40;
/** 总字符上限（约 4M 字符 ≈ 8MB UTF-8 中文）：超出按最旧淘汰。 */
export const MAX_SPILL_TOTAL_CHARS = 4_000_000;
/** 交给模型的预览长度：头 1200 字符足够看出「这是什么」，又不挤占本轮预算。 */
export const SPILL_PREVIEW_CHARS = 1_200;
/** 单次 `tool_output_read` 的默认与最大窗口。 */
export const SPILL_READ_DEFAULT = 8_000;
export const SPILL_READ_MAX = 40_000;
/** 落本机的键与额度（d.190）：只保最近一段，够对上重启后历史里的引用即可。 */
export const SPILL_PERSIST_KEY = "heming.spill.v1";
export const SPILL_PERSIST_MAX_CHARS = 600_000;

let seq = 0;
let clock = 0;
const entries = new Map<string, SpillEntry>();
/** 是否已经尝试从本机读回（只读一次；之后由内存为准）。 */
let hydrated = false;
/** 写入失败（通常是配额满）后不再反复尝试，避免每次溢出都抛一次异常。 */
let persistBroken = false;

function storage(): Storage | null {
  try {
    return typeof localStorage === "undefined" ? null : localStorage;
  } catch {
    return null; // 隐私模式/被禁用：退化成「只有内存」，功能不受影响
  }
}

function tick(): number {
  // 同毫秒连写时 Date.now() 会相等，淘汰顺序就变成「插入顺序」而不是「谁更旧」；
  // 用单调序号保证顺序稳定（lib/todo/store.ts 里踩过同一个坑）。
  clock = Math.max(clock + 1, Date.now());
  return clock;
}

function prune(): void {
  while (entries.size > MAX_SPILL_ITEMS) {
    const oldest = entries.keys().next().value as string | undefined;
    if (oldest === undefined) break;
    entries.delete(oldest);
  }
  let total = 0;
  for (const entry of entries.values()) total += entry.chars;
  while (total > MAX_SPILL_TOTAL_CHARS && entries.size > 0) {
    const oldest = entries.keys().next().value as string | undefined;
    if (oldest === undefined) break;
    const gone = entries.get(oldest);
    entries.delete(oldest);
    total -= gone?.chars ?? 0;
  }
}

/**
 * 把内存里最近的一段写到本机（新→旧，直到额度用完）。
 *
 * 为什么不是全量：localStorage 只有几 MB，一次会话的溢出内容可能远超；
 * 这里只保「最近 600K 字符」，重启后能对上的就是会话尾部那些引用——
 * 而会话尾部正是「刚被截断、模型下一步就要用」的那部分。
 */
function persist(): void {
  if (persistBroken) return;
  const store = storage();
  if (!store) return;
  const items: Array<{ id: string; at: number; text: string }> = [];
  let total = 0;
  const newestFirst = [...entries.values()].reverse();
  for (const entry of newestFirst) {
    if (total + entry.chars > SPILL_PERSIST_MAX_CHARS) break;
    items.push({ id: entry.id, at: entry.createdAt, text: entry.text });
    total += entry.chars;
  }
  try {
    store.setItem(SPILL_PERSIST_KEY, JSON.stringify({ v: 1, items }));
  } catch {
    // 配额满/被禁用：放弃持久化，但内存里的内容照常可用。
    persistBroken = true;
    try {
      store.removeItem(SPILL_PERSIST_KEY);
    } catch {
      /* 连删都失败就随它去 */
    }
  }
}

/** 首次读取前把本机那份读回内存（坏数据直接丢掉，不阻断功能）。 */
function hydrate(): void {
  if (hydrated) return;
  hydrated = true;
  const store = storage();
  if (!store) return;
  let raw: string | null = null;
  try {
    raw = store.getItem(SPILL_PERSIST_KEY);
  } catch {
    return;
  }
  if (!raw) return;
  try {
    const parsed = JSON.parse(raw) as {
      v?: unknown;
      items?: Array<{ id?: unknown; at?: unknown; text?: unknown }>;
    };
    if (!parsed || parsed.v !== 1 || !Array.isArray(parsed.items)) {
      store.removeItem(SPILL_PERSIST_KEY);
      return;
    }
    let total = 0;
    /*
     * 本机那份是「新→旧」存的（这样额度不够时优先保最近的），但内存里的 Map 必须
     * **旧→新**插入：`prune()` 靠 `entries.keys().next()` 当作最旧那条来淘汰。
     * 顺序反了会变成「先淘汰最新的」——d.181 的 `listSpills` 与淘汰顺序都在盯着这点。
     */
    for (const item of [...parsed.items].reverse()) {
      if (entries.size >= MAX_SPILL_ITEMS) break;
      const id = item?.id;
      const text = item?.text;
      if (typeof id !== "string" || !/^spill-\d+$/.test(id)) continue;
      if (typeof text !== "string") continue;
      if (entries.has(id) || text.length > MAX_SPILL_TOTAL_CHARS) continue;
      if (total + text.length > MAX_SPILL_TOTAL_CHARS) break;
      const at = typeof item.at === "number" && Number.isFinite(item.at) ? item.at : Date.now();
      entries.set(id, { id, text, chars: text.length, createdAt: at });
      total += text.length;
      const n = Number(id.slice("spill-".length));
      if (Number.isFinite(n)) seq = Math.max(seq, n);
      clock = Math.max(clock, at);
    }
  } catch {
    try {
      store.removeItem(SPILL_PERSIST_KEY);
    } catch {
      /* 同上 */
    }
  }
}

/**
 * 存一条溢出文本，返回 handle 与预览。空文本不该走到这里（调用方只在超限时调用）。
 */
export function spillText(text: string, tool?: string): SpillPreview {
  hydrate();
  const raw = String(text ?? "");
  seq += 1;
  const id = `spill-${seq}`;
  const entry: SpillEntry = { id, text: raw, chars: raw.length, createdAt: tick(), ...(tool ? { tool } : {}) };
  entries.set(id, entry);
  prune();
  persist();
  return { id, chars: raw.length, preview: raw.slice(0, SPILL_PREVIEW_CHARS) };
}

export type SpillReadResult =
  | { ok: true; id: string; text: string; offset: number; limit: number; total: number; hasMore: boolean }
  | { ok: false; error_code: "spill-not-found" | "spill-invalid-args"; hint: string; text: string };

/**
 * 按字符窗口读回一段。`offset` 从 0 开始，`limit` 缺省 8000、上限 40000。
 *
 * 找不到时**必须报错**而不是返回空串：模型会把空串当成「这段没内容」，
 * 然后基于「读过了」继续往下写——这是最坏的静默失败。
 */
export function readSpill(rawId: string, offset?: number, limit?: number): SpillReadResult {
  hydrate();
  const id = String(rawId ?? "").trim();
  if (!id) {
    return {
      ok: false,
      error_code: "spill-invalid-args",
      hint: "缺 id：用工具结果里给出的 spill-<数字>（形如 spill-3）",
      text: "读取完整输出失败：没有给 id。",
    };
  }
  const entry = entries.get(id);
  if (!entry) {
    return {
      ok: false,
      error_code: "spill-not-found",
      hint:
        "这条溢出内容已经不在了（内存里只保留最近 40 条；本机重启后只保留最近 600K 字符的溢出）。改用工具重新取一次，或者缩小参数范围，别在这里重试。",
      text: `读取完整输出失败：没有 ${id} 这条记录。`,
    };
  }
  const start = Number.isFinite(offset) ? Math.max(0, Math.floor(offset as number)) : 0;
  const size = Number.isFinite(limit) ? Math.floor(limit as number) : SPILL_READ_DEFAULT;
  if (size <= 0) {
    return {
      ok: false,
      error_code: "spill-invalid-args",
      hint: "limit 必须是正整数（字符数），缺省 8000",
      text: "读取完整输出失败：limit 不合法。",
    };
  }
  if (start >= entry.chars) {
    return {
      ok: false,
      error_code: "spill-invalid-args",
      hint: `offset 超出了这条内容的长度（共 ${entry.chars} 字符），从 0 到 ${Math.max(0, entry.chars - 1)} 之间取。`,
      text: `读取完整输出失败：offset ${start} 越界（共 ${entry.chars} 字符）。`,
    };
  }
  const bounded = Math.min(size, SPILL_READ_MAX);
  const text = entry.text.slice(start, start + bounded);
  return {
    ok: true,
    id,
    text,
    offset: start,
    limit: bounded,
    total: entry.chars,
    hasMore: start + text.length < entry.chars,
  };
}

/** 列出还留着的溢出（用于测试与排查；不暴露给模型）。 */
export function listSpills(): Array<{ id: string; chars: number; tool?: string }> {
  hydrate();
  return [...entries.values()].map((entry) => ({ id: entry.id, chars: entry.chars, ...(entry.tool ? { tool: entry.tool } : {}) }));
}

/** 清空（测试与「新会话」用）：内存与本机那份一起清，避免下次 hydrate 又捡回来。 */
export function resetSpills(): void {
  entries.clear();
  seq = 0;
  clock = 0;
  hydrated = false;
  persistBroken = false;
  const store = storage();
  if (store) {
    try {
      store.removeItem(SPILL_PERSIST_KEY);
    } catch {
      /* 清不掉也不影响内存语义 */
    }
  }
}

/** 仅供测试与诊断：当前总字符数。 */
export function spillTotalChars(): number {
  hydrate();
  let total = 0;
  for (const entry of entries.values()) total += entry.chars;
  return total;
}
