import { describe, it, expect, beforeEach, vi } from "vitest";
import {
  chatSocketCount,
  chatSocketVersion,
  registerChatSocket,
  resetChatSocketPresenceForTest,
  subscribeChatSocket,
} from "./chatSocketPresence.js";

beforeEach(() => {
  resetChatSocketPresenceForTest();
});

describe("chatSocketPresence", () => {
  it("注册/注销改变计数与版本", () => {
    expect(chatSocketCount()).toBe(0);
    const v0 = chatSocketVersion();
    const off = registerChatSocket();
    expect(chatSocketCount()).toBe(1);
    expect(chatSocketVersion()).toBeGreaterThan(v0);
    off();
    expect(chatSocketCount()).toBe(0);
  });

  it("多个实例并存计数累加；注销幂等", () => {
    const a = registerChatSocket();
    const b = registerChatSocket();
    expect(chatSocketCount()).toBe(2);
    a();
    a();
    expect(chatSocketCount()).toBe(1);
    b();
    expect(chatSocketCount()).toBe(0);
  });

  it("订阅者在注册/注销时收到通知；取消订阅后不再收到；单个订阅者抛错不影响其它", () => {
    const good = vi.fn();
    const bad = vi.fn(() => {
      throw new Error("boom");
    });
    const offGood = subscribeChatSocket(good);
    const offBad = subscribeChatSocket(bad);

    const release = registerChatSocket();
    expect(good).toHaveBeenCalledTimes(1);
    expect(bad).toHaveBeenCalledTimes(1);
    release();
    expect(good).toHaveBeenCalledTimes(2);

    offGood();
    offBad();
    registerChatSocket()(); // 再注册/注销一轮
    expect(good).toHaveBeenCalledTimes(2);
  });
});
