import { describe, it, expect } from "vitest";
import type { ConversationContentHit } from "./api.js";
import {
  CONTENT_SEARCH_LIMIT,
  CONTENT_SEARCH_MIN_CHARS,
  contentSearchErrorText,
  hitsByConversation,
  hitsOutsideList,
  shouldSearchContent,
} from "./conversationSearch.js";

function hit(conversationId: string, snippet = "…命中…"): ConversationContentHit {
  return {
    conversationId,
    conversationTitle: null,
    lastMessageAt: null,
    messageId: `m-${conversationId}`,
    senderType: "user",
    createdAt: "2026-11-16T00:00:00.000Z",
    snippet,
  };
}

describe("conversationSearch（d.197 左栏内容搜索的纯逻辑）", () => {
  it("少于两个字符不发请求（与服务端下限一致）", () => {
    expect(CONTENT_SEARCH_MIN_CHARS).toBe(2);
    expect(shouldSearchContent("")).toBe(false);
    expect(shouldSearchContent("   ")).toBe(false);
    expect(shouldSearchContent("a")).toBe(false);
    expect(shouldSearchContent(" ab ")).toBe(true);
    expect(shouldSearchContent("全部通过")).toBe(true);
    // 单个 emoji 看着是一个字符，UTF-16 length 却是 2 —— 按码点算才是 1，不该发请求。
    expect(shouldSearchContent("😀")).toBe(false);
    expect(shouldSearchContent("😀a")).toBe(true);
  });

  it("命中按会话收口：同一会话多条只留第一条", () => {
    const map = hitsByConversation([hit("c1", "第一"), hit("c1", "第二"), hit("c2")]);
    expect(map.size).toBe(2);
    expect(map.get("c1")?.snippet).toBe("第一");
  });

  it("页外命中：只保留不在已加载会话列表里的那些", () => {
    const known = new Set(["c1"]);
    expect(hitsOutsideList([hit("c1"), hit("c9")], known).map((h) => h.conversationId)).toEqual(["c9"]);
    expect(hitsOutsideList([hit("c1")], known)).toEqual([]);
    expect(hitsOutsideList([], known)).toEqual([]);
  });

  it("失败文案：带原因时说清原因，且都交代「当前只按会话名匹配」", () => {
    expect(contentSearchErrorText(new Error("http 500"))).toBe(
      "内容搜索失败：http 500（当前只按会话名匹配）",
    );
    expect(contentSearchErrorText(new Error(""))).toBe("内容搜索失败（当前只按会话名匹配）");
    expect(contentSearchErrorText("non-error")).toBe("内容搜索失败（当前只按会话名匹配）");
  });

  it("一次最多要 20 条（服务端上限 50，侧栏一屏放不下更多）", () => {
    expect(CONTENT_SEARCH_LIMIT).toBe(20);
  });
});
