import { afterEach, describe, expect, it, vi } from "vitest";
import {
  broadcastListenerCount,
  publishBroadcast,
  resetBroadcasts,
  subscribeBroadcasts,
} from "./events.js";

afterEach(() => {
  resetBroadcasts();
});

describe("会话事件总线（d.298）", () => {
  it("订阅后能收到发布的事件，退订后不再收", () => {
    const seen: string[] = [];
    const off = subscribeBroadcasts(({ conversationId, event }) => {
      seen.push(`${conversationId}:${event.type}`);
    });

    publishBroadcast({
      conversationId: "c1",
      event: { type: "messages_deleted", conversationId: "c1", ids: ["m1"] },
    });
    off();
    publishBroadcast({
      conversationId: "c1",
      event: { type: "messages_deleted", conversationId: "c1", ids: ["m2"] },
    });

    expect(seen).toEqual(["c1:messages_deleted"]);
    expect(broadcastListenerCount()).toBe(0);
  });

  it("退订函数可重复调用：第二次不报错、也不会误删别人的订阅", () => {
    const a = vi.fn();
    const b = vi.fn();
    const offA = subscribeBroadcasts(a);
    subscribeBroadcasts(b);

    offA();
    offA();

    publishBroadcast({
      conversationId: "c1",
      event: { type: "messages_deleted", conversationId: "c1", ids: ["m1"] },
    });

    expect(a).not.toHaveBeenCalled();
    expect(b).toHaveBeenCalledTimes(1);
  });

  it("一个监听器抛错不影响发布方，也不影响其它监听器", () => {
    const good = vi.fn();
    subscribeBroadcasts(() => {
      throw new Error("boom");
    });
    subscribeBroadcasts(good);

    expect(() =>
      publishBroadcast({
        conversationId: "c1",
        event: { type: "messages_deleted", conversationId: "c1", ids: ["m1"] },
      }),
    ).not.toThrow();
    expect(good).toHaveBeenCalledTimes(1);
  });

  it("监听器里退订自己：本轮其它监听器照常收到（遍历用快照）", () => {
    const other = vi.fn();
    const off = subscribeBroadcasts(() => {
      off();
    });
    subscribeBroadcasts(other);

    publishBroadcast({
      conversationId: "c1",
      event: { type: "messages_deleted", conversationId: "c1", ids: ["m1"] },
    });

    expect(other).toHaveBeenCalledTimes(1);
  });

  it("没有订阅者时发布是空操作", () => {
    expect(broadcastListenerCount()).toBe(0);
    expect(() =>
      publishBroadcast({
        conversationId: "c1",
        event: { type: "messages_deleted", conversationId: "c1", ids: ["m1"] },
      }),
    ).not.toThrow();
  });
});
