import { describe, expect, it } from "vitest";
import type { WsServerEvent } from "@heming/shared";
import {
  EMPTY_UNREAD,
  applyUnreadEvent,
  totalUnread,
  type PetUnreadState,
} from "./petUnread.js";

const ME = "u-me";

/** 构造一个最小 message_new 事件（只填归约真正读到的字段）。 */
function msgEvent(senderId: string, conversationId: string, id = "m1"): WsServerEvent {
  return {
    type: "message_new",
    message: { id, conversationId, senderId, createdAt: "2026-11-02T00:00:00.000Z" },
  } as unknown as WsServerEvent;
}

function readEvent(conversationId: string, userId: string): WsServerEvent {
  return { type: "read_update", conversationId, userId, at: "2026-11-02T00:00:00.000Z" } as WsServerEvent;
}

/** 连续归约多个事件，便于断言终态。 */
function reduce(events: WsServerEvent[], meId: string | null = ME, from: PetUnreadState = EMPTY_UNREAD) {
  return events.reduce((s, e) => applyUnreadEvent(s, e, meId), from);
}

describe("未读归约 · 新消息", () => {
  it("别人发的计入对应会话，并成为跳转目标", () => {
    const s = reduce([msgEvent("u-other", "c1")]);
    expect(s.byConv).toEqual({ c1: 1 });
    expect(s.latestConvId).toBe("c1");
    expect(totalUnread(s)).toBe(1);
  });

  it("同一会话多条累加", () => {
    const s = reduce([msgEvent("u-other", "c1"), msgEvent("u-other", "c1")]);
    expect(s.byConv).toEqual({ c1: 2 });
  });

  it("不同会话分开计数，跳转目标跟最后一条", () => {
    const s = reduce([msgEvent("u-other", "c1"), msgEvent("u-other", "c2")]);
    expect(s.byConv).toEqual({ c1: 1, c2: 1 });
    expect(s.latestConvId).toBe("c2");
    expect(totalUnread(s)).toBe(2);
  });

  it("自己发的消息不计未读（不该让自己的桌宠冒红点）", () => {
    const s = reduce([msgEvent(ME, "c1")]);
    expect(s).toEqual(EMPTY_UNREAD);
  });

  it("未登录（meId 为空）一律不计数", () => {
    const s = reduce([msgEvent("u-other", "c1")], null);
    expect(s).toEqual(EMPTY_UNREAD);
  });

  it("不改动传入的状态（纯函数）", () => {
    const before: PetUnreadState = { byConv: { c1: 1 }, latestConvId: "c1" };
    const snapshot = JSON.parse(JSON.stringify(before));
    applyUnreadEvent(before, msgEvent("u-other", "c1"), ME);
    expect(before).toEqual(snapshot);
  });
});

describe("未读归约 · 已读清零", () => {
  it("自己已读某会话 → 该会话未读清空", () => {
    const s = reduce([msgEvent("u-other", "c1"), readEvent("c1", ME)]);
    expect(s.byConv).toEqual({});
    expect(s.latestConvId).toBeNull();
    expect(totalUnread(s)).toBe(0);
  });

  it("别人已读不影响我的未读", () => {
    const s = reduce([msgEvent("u-other", "c1"), readEvent("c1", "u-other")]);
    expect(s.byConv).toEqual({ c1: 1 });
  });

  it("清掉跳转目标时改指向剩余未读会话（有红点就一定有去处）", () => {
    const s = reduce([
      msgEvent("u-other", "c1"),
      msgEvent("u-other", "c2"),
      readEvent("c2", ME),
    ]);
    expect(s.byConv).toEqual({ c1: 1 });
    expect(s.latestConvId).toBe("c1");
  });

  it("清掉非跳转目标时跳转目标不变", () => {
    const s = reduce([
      msgEvent("u-other", "c1"),
      msgEvent("u-other", "c2"),
      readEvent("c1", ME),
    ]);
    expect(s.latestConvId).toBe("c2");
  });

  it("对本来就没未读的会话发已读：状态整体不变（引用相等）", () => {
    const before: PetUnreadState = { byConv: {}, latestConvId: null };
    expect(applyUnreadEvent(before, readEvent("c9", ME), ME)).toBe(before);
  });
});

describe("未读归约 · 其它事件", () => {
  it("撤回不是新消息：不清未读也不改跳转目标", () => {
    const before: PetUnreadState = { byConv: { c1: 2 }, latestConvId: "c1" };
    const ev = { type: "message_recalled", conversationId: "c1", messageId: "m1" } as WsServerEvent;
    expect(applyUnreadEvent(before, ev, ME)).toBe(before);
  });

  it("无关事件原样返回", () => {
    const before: PetUnreadState = { byConv: { c1: 1 }, latestConvId: "c1" };
    const ev = { type: "typing", userId: "u-other", conversationId: "c1", at: "" } as unknown as WsServerEvent;
    expect(applyUnreadEvent(before, ev, ME)).toBe(before);
  });
});

describe("未读总数", () => {
  it("空状态为 0", () => {
    expect(totalUnread(EMPTY_UNREAD)).toBe(0);
  });
  it("跨会话求和", () => {
    expect(totalUnread({ byConv: { a: 3, b: 2, c: 1 }, latestConvId: "c" })).toBe(6);
  });
});
