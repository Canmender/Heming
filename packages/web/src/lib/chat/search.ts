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
