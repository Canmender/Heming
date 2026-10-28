import { describe, it, expect, beforeEach, vi } from "vitest";
import type { Message } from "@heming/shared";
import { handleBackgroundEvent } from "./backgroundMessages.js";
import { useAuthStore } from "../store/auth.js";
import { useChatStore } from "../store/chat.js";
import { useNotificationStore } from "../store/notifications.js";
import { resetConvPrefsForTest } from "./convPrefs.js";

// 每个用例用独立消息 id：store 内的 seenIncoming 去重表是模块级、跨用例存活的，
// 复用 id 会让后一个用例的「首次到达」被前一个用例吞掉。
const msg = (id: string, text: string): Message => ({
  id,
  conversationId: "c1",
  senderType: "user",
  senderId: "u2",
  payload: { text },
  replyTo: null,
  createdAt: "2026-10-28T02:00:00.000Z",
  recalledAt: null,
  enc: "plain",
});

beforeEach(() => {
  vi.restoreAllMocks();
  localStorage.clear();
  resetConvPrefsForTest();
  useNotificationStore.getState().clearAll();
  useAuthStore.setState({ user: { id: "u1", username: "alice", displayName: "爱丽丝" } });
  useChatStore.setState({
    conversations: [
      {
        id: "c1",
        type: "direct",
        peer: { id: "u2", username: "bob", displayName: "鲍勃" },
        unreadCount: 0,
        lastMessageAt: null,
      },
    ],
    messages: {},
    plainById: {},
    loadWorkspace: vi.fn(async () => {}),
  });
  (window as unknown as { __heming_notify?: unknown }).__heming_notify = {
    message: vi.fn(),
    onOpen: vi.fn(() => () => {}),
  };
  vi.spyOn(document, "hasFocus").mockReturnValue(false);
});

describe("backgroundMessages", () => {
  it("他人消息：未读 +1、最近活跃更新、通知一次", () => {
    handleBackgroundEvent({ type: "message_new", message: msg("bg1", "你好") });
    const c = useChatStore.getState().conversations[0];
    expect(c.unreadCount).toBe(1);
    expect(c.lastMessageAt).toBe("2026-10-28T02:00:00.000Z");
    expect(useNotificationStore.getState().items).toHaveLength(1);
  });

  it("后台只做感知：不写入消息列表与明文缓存（不解密、不 append）", () => {
    handleBackgroundEvent({ type: "message_new", message: msg("bg5", "你好") });
    expect(useChatStore.getState().messages).toEqual({});
    expect(useChatStore.getState().plainById).toEqual({});
  });

  it("重复消息 id 不重复提醒；自己发的消息忽略", () => {
    handleBackgroundEvent({ type: "message_new", message: msg("bg2", "你好") });
    handleBackgroundEvent({ type: "message_new", message: msg("bg2", "你好") });
    expect(useChatStore.getState().conversations[0].unreadCount).toBe(1);
    expect(useNotificationStore.getState().items).toHaveLength(1);
    // 系统通知同样只弹一次（不只查通知中心）
    expect(window.__heming_notify!.message).toHaveBeenCalledTimes(1);

    handleBackgroundEvent({
      type: "message_new",
      message: { ...msg("bg3", "我发的"), senderId: "u1" },
    });
    expect(useChatStore.getState().conversations[0].unreadCount).toBe(1);
    expect(useNotificationStore.getState().items).toHaveLength(1);
    expect(window.__heming_notify!.message).toHaveBeenCalledTimes(1);
  });

  it("read_update（自己）清零并写 lastReadAt", () => {
    useChatStore.setState({
      conversations: [
        {
          id: "c1",
          type: "direct",
          peer: { id: "u2", username: "bob", displayName: "鲍勃" },
          unreadCount: 3,
          lastReadAt: null,
        },
      ],
    });
    handleBackgroundEvent({
      type: "read_update",
      conversationId: "c1",
      userId: "u1",
      at: "2026-10-28T03:00:00.000Z",
    });
    const c = useChatStore.getState().conversations[0];
    expect(c.unreadCount).toBe(0);
    expect(c.lastReadAt).toBe("2026-10-28T03:00:00.000Z");
  });

  it("read_update（他人）不动自己的未读", () => {
    useChatStore.setState({
      conversations: [
        {
          id: "c1",
          type: "direct",
          peer: { id: "u2", username: "bob", displayName: "鲍勃" },
          unreadCount: 3,
          lastReadAt: null,
        },
      ],
    });
    handleBackgroundEvent({
      type: "read_update",
      conversationId: "c1",
      userId: "u2",
      at: "2026-10-28T03:00:00.000Z",
    });
    expect(useChatStore.getState().conversations[0].unreadCount).toBe(3);
  });

  it("未知会话：触发一次 loadWorkspace，仍提醒一次", () => {
    useChatStore.setState({ conversations: [] });
    const load = vi.fn(async () => {});
    useChatStore.setState({ loadWorkspace: load });
    handleBackgroundEvent({
      type: "message_new",
      message: { ...msg("bg4", "新会话"), conversationId: "c9" },
    });
    expect(load).toHaveBeenCalledTimes(1);
    expect(useNotificationStore.getState().items).toHaveLength(1);
  });

  it("未知会话：刷新在途时并发消息复用同一次刷新，落定后可再次刷新", async () => {
    useChatStore.setState({ conversations: [] });
    const releases: Array<() => void> = [];
    const load = vi.fn(
      () =>
        new Promise<void>((resolve) => {
          releases.push(resolve);
        }),
    );
    useChatStore.setState({ loadWorkspace: load });

    handleBackgroundEvent({
      type: "message_new",
      message: { ...msg("bg7", "陌生会话一"), conversationId: "c7" },
    });
    handleBackgroundEvent({
      type: "message_new",
      message: { ...msg("bg8", "陌生会话二"), conversationId: "c8" },
    });
    expect(load).toHaveBeenCalledTimes(1);

    releases.shift()!();
    // 等 catch/finally 的微任务走完（flag 复位）
    await new Promise<void>((resolve) => setTimeout(resolve, 0));
    handleBackgroundEvent({
      type: "message_new",
      message: { ...msg("bg9", "另一个陌生会话"), conversationId: "c9" },
    });
    expect(load).toHaveBeenCalledTimes(2);
    releases.shift()!();
  });
});
