/**
 * 左栏「内容搜索」的纯逻辑（d.197）。
 *
 * 会话名搜索是本地过滤（已有），内容搜索要问服务端（正文存在服务端，且只在「我所在的
 * 会话」里找）。这里只放与 React 无关的判定与合并逻辑，方便直接测：
 * - 什么时候值得发请求（词太短就不发）；
 * - 结果怎么并到已有会话列表上（命中会话可能根本不在当前这一页）；
 * - 失败时给用户看什么话。
 */
import type { ConversationContentHit } from "./api.js";

/** 少于这个长度不发请求：1 个字符几乎能命中所有消息，等于没搜。与服务端下限一致。 */
export const CONTENT_SEARCH_MIN_CHARS = 2;

/** 输入停顿多久才发请求：逐字发送会把「会话内容搜索」打成每条按键一个请求。 */
export const CONTENT_SEARCH_DEBOUNCE_MS = 250;

/** 一次最多要多少条命中（服务端上限 50，这里保守取 20：侧栏一屏放不下更多）。 */
export const CONTENT_SEARCH_LIMIT = 20;

/** 是否值得为这个查询发内容搜索请求。 */
export function shouldSearchContent(query: string): boolean {
  return query.trim().length >= CONTENT_SEARCH_MIN_CHARS;
}

/** 把命中按会话收口成 Map：同一个会话只留第一条（服务端本来就只回最新一条）。 */
export function hitsByConversation(
  hits: readonly ConversationContentHit[],
): Map<string, ConversationContentHit> {
  const map = new Map<string, ConversationContentHit>();
  for (const hit of hits) {
    if (!map.has(hit.conversationId)) map.set(hit.conversationId, hit);
  }
  return map;
}

/**
 * 命中的会话里，哪些**不在当前已加载的会话列表**里。
 *
 * 左栏是分页拉取的（首屏 30 条），命中完全可能落在更早的页里。这些会话没法按工作区分组
 * 渲染，单独列在「更早的会话里也有命中」一节——不能默默丢掉，否则用户会以为没搜到。
 */
export function hitsOutsideList(
  hits: readonly ConversationContentHit[],
  knownConversationIds: ReadonlySet<string>,
): ConversationContentHit[] {
  return hits.filter((hit) => !knownConversationIds.has(hit.conversationId));
}

/** 内容搜索失败时栏底的一句话（不把 status/堆栈丢给用户）。 */
export function contentSearchErrorText(error: unknown): string {
  const reason = error instanceof Error && error.message ? error.message : "";
  return reason ? `内容搜索失败：${reason}（当前只按会话名匹配）` : "内容搜索失败（当前只按会话名匹配）";
}
