import { msgCache } from "../e2eSession.js";

/**
 * 流式草稿的本地留底（d.363）。
 *
 * 问题是「生成到一半刷新 / 关窗口，那半截字就没了」——服务端只有 finish 之后才有正文，
 * 而流式正文只活在本机内存里（`store/chat.ts` 的 `streaming`）。DSH 靠「快照 + 游标」
 * 补这一段；我们没有服务端流，能复用的是**已经存在的加密明文缓存**（`msgCache`）。
 *
 * 所以这里不新开存储、也不落明文到 localStorage：草稿就是一条合成 id（`live:<streamId>`）
 * 的 `CachedMsg`，与别的明文走同一条加密容器；正常收口时删掉，只有「没走到收口」
 * 的条目会活到下一次启动，被当成「上次中断的草稿」显示出来。
 */
export const LIVE_DRAFT_PREFIX = "live:";

/** 少于这些字不存：短回复刷新重发成本极低，存了只会让「上次中断」频繁误报。 */
export const LIVE_DRAFT_MIN_CHARS = 20;

/** 最多认这么多条草稿：一次刷新最多也就是「每个会话同时跑的那几条」。 */
export const LIVE_DRAFT_CAP = 4;

/**
 * 留底间隔（毫秒）。
 *
 * 草稿要过加密容器再落盘，逐帧写会把主线程拖住；3 秒一次意味着最多丢最近几秒的字，
 * 但内存与写盘都不受影响。数字来自「用户能接受的缺口」而不是性能测试。
 */
export const LIVE_DRAFT_INTERVAL_MS = 3_000;

export interface LiveDraft {
  streamId: string;
  agentId: string;
  at: number;
  text: string;
}

function draftId(streamId: string): string {
  return `${LIVE_DRAFT_PREFIX}${streamId}`;
}

/**
 * 存一条草稿。返回是否真的写了（太短就不写）。
 *
 * 注意这里**覆盖**同 streamId 的旧条目：流式草稿是「最新累计」，不是增量。
 */
export function saveLiveDraft(
  conversationId: string,
  draft: { streamId: string; agentId: string; text: string },
  now: number = Date.now(),
): boolean {
  const text = draft.text;
  if (text.trim().length < LIVE_DRAFT_MIN_CHARS) return false;
  if (!conversationId || !draft.streamId) return false;
  const id = draftId(draft.streamId);
  // 同一条流会被反复覆盖：先删再写，别让缓存里出现两条同 id 的条目
  // （`msgCache` 的 append 不做去重，重复 id 会让解码后的视图对不上）。
  msgCache.remove(conversationId, id);
  msgCache.append(conversationId, {
    id,
    senderId: draft.agentId,
    at: now,
    plain: { kind: "text", text },
  });
  return true;
}

/** 这个会话里还留着的草稿（正常收口的都会在收口时删掉）。 */
export function listLiveDrafts(conversationId: string): LiveDraft[] {
  if (!conversationId) return [];
  const out: LiveDraft[] = [];
  for (const entry of msgCache.peek(conversationId)) {
    if (!entry.id.startsWith(LIVE_DRAFT_PREFIX)) continue;
    const text = entry.plain.kind === "text" ? (entry.plain.text ?? "") : "";
    if (text.trim().length < LIVE_DRAFT_MIN_CHARS) continue;
    out.push({
      streamId: entry.id.slice(LIVE_DRAFT_PREFIX.length),
      agentId: entry.senderId,
      at: entry.at,
      text,
    });
  }
  return out.sort((a, b) => a.at - b.at).slice(-LIVE_DRAFT_CAP);
}

/** 正常收口 / 用户放弃时删掉：留着会被下一次启动当成「上次中断」。 */
export function clearLiveDraft(conversationId: string, streamId: string): void {
  if (!conversationId || !streamId) return;
  msgCache.remove(conversationId, draftId(streamId));
}

/** 清掉整个会话的草稿（切会话时不需要，只有测试与「清空本地缓存」用得上）。 */
export function clearLiveDrafts(conversationId: string): void {
  for (const draft of listLiveDrafts(conversationId)) clearLiveDraft(conversationId, draft.streamId);
}

