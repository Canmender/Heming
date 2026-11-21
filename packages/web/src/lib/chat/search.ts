/**
 * 会话内搜索：在**本机已解密的明文**里找关键词。
 *
 * 纯函数、不读存储、不联网：调用方负责把消息整理成 `{id, text, recalled}`。
 * 一条消息最多算一个命中（跳转以消息为单位），`count` 是该条消息里的出现次数，
 * 便于界面显示「第 2 条 · 共 4 处」而不是假装每处都是独立可跳转结果。
 */

export interface SearchableMessage {
  id: string;
  text: string;
  /** 已撤回的消息不参与搜索（正文已不可见）。 */
  recalled?: boolean;
}

export interface MessageSearchHit {
  id: string;
  /** 该消息内首次出现的位置（用于展示上下文，不用于切片）。 */
  index: number;
  /** 该消息内出现次数。 */
  count: number;
}

/** 查找命中：大小写不敏感，按消息原顺序返回。 */
export function findMessageHits(
  messages: SearchableMessage[],
  query: string,
): MessageSearchHit[] {
  const needle = query.trim().toLowerCase();
  if (!needle) return [];

  const hits: MessageSearchHit[] = [];
  for (const message of messages) {
    if (message.recalled || !message.text) continue;
    const haystack = message.text.toLowerCase();
    const index = haystack.indexOf(needle);
    if (index < 0) continue;

    let count = 0;
    let from = 0;
    while (from <= haystack.length - needle.length) {
      const found = haystack.indexOf(needle, from);
      if (found < 0) break;
      count += 1;
      from = found + needle.length;
    }
    hits.push({ id: message.id, index, count });
  }
  return hits;
}

/** 命中位置在消息序列里的下标；找不到回退 -1（用于「下一条」循环）。 */
export function hitPosition(hits: MessageSearchHit[], messageId: string | null): number {
  if (!messageId) return -1;
  return hits.findIndex((h) => h.id === messageId);
}

/** 循环取下一个命中：delta=1 向后、-1 向前；空列表返回 null。 */
export function stepHit(
  hits: MessageSearchHit[],
  currentId: string | null,
  delta: 1 | -1,
): MessageSearchHit | null {
  if (hits.length === 0) return null;
  const current = hitPosition(hits, currentId);
  const next = current < 0 ? 0 : (current + delta + hits.length) % hits.length;
  return hits[next];
}

/** 结果面板里的一行：命中消息 + 命中处前后的一小段（d.235）。 */
export interface SearchHitRow {
  id: string;
  /** 该消息内的出现次数（与 `MessageSearchHit.count` 一致）。 */
  count: number;
  /** 单行摘要：命中处前后各取若干字，越界处补「…」。 */
  excerpt: string;
}

/** 摘要里命中处前后各留多少字。 */
export const SEARCH_EXCERPT_PAD = 26;

/**
 * 取「命中处附近的一小段」（d.235）。
 *
 * 为什么要单独做：命中的消息可能是一整篇长文/日志，直接把正文塞进结果面板等于把
 * 聊天记录又贴一遍；而只显示「第 2 条」又让人没法判断是不是要找的那条。
 * 这里把换行压成空格（面板一行一条），在**压平后的文本里重新找一次关键词**再取前后 `pad` 个字——
 * 不能直接用 `MessageSearchHit.index`：那个下标是在原始文本（含换行）里算的，
 * 压平之后会偏，取出来的片段可能根本不含关键词。
 */
export function excerptAround(
  text: string,
  needle: string,
  pad: number = SEARCH_EXCERPT_PAD,
): string {
  if (!text) return "";
  const flat = text.replace(/\s+/g, " ").trim();
  if (!flat) return "";
  const query = needle.trim();
  // 在原串上做不区分大小写的查找：不能用 flat.toLowerCase().indexOf(...)，
  // 因为某些字符小写化会变长（如 İ → i̇，1 码元变 2），拿到的下标再去切原串
  // 就会错位，把关键词本身切掉。正则在原文上匹配，下标天然对得上原串。
  // 查询串里的正则元字符要转义，避免把 '.', '(', '[' 等当语法。
  let found = 0;
  if (query) {
    const escaped = query.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
    try {
      found = flat.search(new RegExp(escaped, "i"));
    } catch {
      found = flat.indexOf(query); // 极端查询串正则构造失败时退回朴素查找
    }
  }
  const at = found >= 0 ? found : 0;
  const safePad = Math.max(0, pad);
  let start = Math.max(0, at - safePad);
  let end = Math.min(flat.length, at + Math.max(0, query.length) + safePad);
  // 起止点都按码点边界收口：落在代理对中间就挪开，别把 emoji 劈成落单代理。
  // start 落在低代理（前一个正好是高代理）→ 整体让掉这个字；
  // end 落在高代理（后一个是低代理）→ 退一格把这个字让给右侧。
  if (start > 0) {
    const c = flat.charCodeAt(start);
    const prev = flat.charCodeAt(start - 1);
    if (c >= 0xdc00 && c <= 0xdfff && prev >= 0xd800 && prev <= 0xdbff) start += 1;
  }
  if (end < flat.length && end > 0) {
    const c = flat.charCodeAt(end - 1);
    if (c >= 0xd800 && c <= 0xdbff) end -= 1;
  }
  const head = start > 0 ? "…" : "";
  const tail = end < flat.length ? "…" : "";
  return `${head}${flat.slice(start, end)}${tail}`;
}

/**
 * 把命中列表配成结果面板的行（保持命中顺序）。
 *
 * 与 `findMessageHits` 分开：那个只回答「命中在哪几条消息里」，这里负责「每条给一句能认出来的摘要」。
 */
export function buildSearchRows(
  messages: SearchableMessage[],
  hits: MessageSearchHit[],
  query: string,
  pad: number = SEARCH_EXCERPT_PAD,
): SearchHitRow[] {
  const needle = query.trim();
  if (hits.length === 0 || !needle) return [];
  const byId = new Map(messages.map((m) => [m.id, m]));
  const rows: SearchHitRow[] = [];
  for (const hit of hits) {
    const message = byId.get(hit.id);
    rows.push({
      id: hit.id,
      count: hit.count,
      excerpt: excerptAround(message?.text ?? "", needle, pad),
    });
  }
  return rows;
}
