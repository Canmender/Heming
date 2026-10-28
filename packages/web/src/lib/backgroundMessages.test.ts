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
    loadWorkspace: vi.fn(async () => {}),
  });
});

describe("backgroundMessages", () => {
  it("他人消息：未读 +1、最近活跃更新、通知一次", () => {
    handleBackgroundEvent({ type: "message_new", message: msg("bg1", "你好") });
    const c = useChatStore.getState().conversations[0];
    expect(c.unreadCount).toBe(1);
    expect(c.lastMessageAt).toBe("2026-10-28T02:00:00.000Z");
    expect(useNotificationStore.getState().items).toHaveLength(1);
  });

  it("重复消息 id 不重复提醒；自己发的消息忽略", () => {
    handleBackgroundEvent({ type: "message_new", message: msg("bg2", "你好") });
    handleBackgroundEvent({ type: "message_new", message: msg("bg2", "你好") });
    expect(useChatStore.getState().conversations[0].unreadCount).toBe(1);
    expect(useNotificationStore.getState().items).toHaveLength(1);

    handleBackgroundEvent({
      type: "message_new",
      message: { ...msg("bg3", "我发的"), senderId: "u1" },
    });
    expect(useChatStore.getState().conversations[0].unreadCount).toBe(1);
    expect(useNotificationStore.getState().items).toHaveLength(1);
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
});
