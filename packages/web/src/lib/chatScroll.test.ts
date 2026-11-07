import { describe, expect, it } from "vitest";
import { chatScrollKey, readChatScroll, writeChatScroll } from "./chatScroll.js";

/** 会话阅读位置：按会话分键、脏值回落、存储不可用不抛。 */
describe("lib/chatScroll", () => {
  it("写入/读取往返，按会话 id 分键互不影响", () => {
    sessionStorage.clear();
    writeChatScroll("c1", { top: 420.4, atBottom: false, windowCount: 120 });
    writeChatScroll("c2", { top: 0, atBottom: true, windowCount: 60 });

    expect(readChatScroll("c1")).toEqual({ top: 420, atBottom: false, windowCount: 120 });
    expect(readChatScroll("c2")).toEqual({ top: 0, atBottom: true, windowCount: 60 });
    expect(sessionStorage.getItem(chatScrollKey("c1"))).toBeTruthy();
    // 不认识的会话没有记录
    expect(readChatScroll("c3")).toBeNull();
  });

  it("脏值/坏 JSON/非法字段回落 null（宁可回最新消息，不猜位置）", () => {
    sessionStorage.clear();
    sessionStorage.setItem(chatScrollKey("c1"), "{oops");
    expect(readChatScroll("c1")).toBeNull();

    sessionStorage.setItem(chatScrollKey("c1"), JSON.stringify({ top: -5, windowCount: 60 }));
    expect(readChatScroll("c1")).toBeNull();

    sessionStorage.setItem(chatScrollKey("c1"), JSON.stringify({ top: 10, windowCount: 0 }));
    expect(readChatScroll("c1")).toBeNull();

    sessionStorage.setItem(chatScrollKey("c1"), JSON.stringify({ top: 10, windowCount: 60 }));
    expect(readChatScroll("c1")).toEqual({ top: 10, atBottom: false, windowCount: 60 });
  });

  it("非法会话 id 不写盘；存储不可用时不抛", () => {
    sessionStorage.clear();
    writeChatScroll("bad id with spaces", { top: 1, atBottom: false, windowCount: 60 });
    expect(sessionStorage.length).toBe(0);

    const broken = {
      getItem: () => {
        throw new Error("blocked");
      },
      setItem: () => {
        throw new Error("blocked");
      },
    };
    expect(() =>
      writeChatScroll("c1", { top: 1, atBottom: false, windowCount: 60 }, broken),
    ).not.toThrow();
    expect(readChatScroll("c1", broken)).toBeNull();
  });

  it("windowCount 超上限被截断（存储键不该被撑爆）", () => {
    sessionStorage.clear();
    writeChatScroll("c1", { top: 0, atBottom: false, windowCount: 999_999 });
    expect(readChatScroll("c1")?.windowCount).toBe(10_000);
  });
});
