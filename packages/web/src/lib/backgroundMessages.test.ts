import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { Message } from "@heming/shared";
import { handleBackgroundEvent } from "./backgroundMessages.js";
import { useAuthStore } from "../store/auth.js";
import { useChatStore } from "../store/chat.js";
import { useUiStore } from "../store/ui.js";
import { useNotificationStore } from "../store/notifications.js";
import { resetConvPrefsForTest } from "./convPrefs.js";
import { msgCache } from "./e2eSession.js";
import { resetMessageNotifyForTest } from "./messageNotify.js";
import {
  registerChatSocket,
  resetChatSocketPresenceForTest,
} from "./chatSocketPresence.js";

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
  resetMessageNotifyForTest();
  resetChatSocketPresenceForTest();
  useUiStore.setState({ activeConversationId: null });
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

afterEach(() => {
  resetChatSocketPresenceForTest();
  useUiStore.setState({ activeConversationId: null });
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

  it("message_recalled：只清本机明文缓存，不通知、不改未读", () => {
    msgCache.append("c1", {
      id: "bg-rec",
      senderId: "u2",
      at: Date.parse("2026-10-28T02:00:00.000Z"),
      plain: { kind: "text", text: "撤回前的正文" },
    });
    expect(msgCache.peek("c1")).toHaveLength(1);

    handleBackgroundEvent({
      type: "message_recalled",
      conversationId: "c1",
      messageId: "bg-rec",
      at: "2026-10-28T03:00:00.000Z",
    });

    expect(msgCache.peek("c1")).toEqual([]);
    expect(useChatStore.getState().conversations[0].unreadCount).toBe(0);
    expect(useNotificationStore.getState().items).toHaveLength(0);
    expect(window.__heming_notify!.message).not.toHaveBeenCalled();
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

  it("交接窗口：ChatPage 已挂载且消息属于当前可见会话 → 不记未读、不提醒", () => {
    useChatStore.setState({
      conversations: [
        {
          id: "c1",
          type: "direct",
          peer: { id: "u2", username: "bob", displayName: "鲍勃" },
          unreadCount: 0,
          lastMessageAt: null,
        },
        {
          id: "c2",
          type: "direct",
          peer: { id: "u3", username: "carol", displayName: "卡罗尔" },
          unreadCount: 0,
          lastMessageAt: null,
        },
      ],
    });
    const release = registerChatSocket();
    useUiStore.setState({ activeConversationId: "c1" });
    try {
      // 当前可见会话：由 ChatPage 自己 append / 标已读，后台不能再记一次
      handleBackgroundEvent({ type: "message_new", message: msg("handoff1", "正在看的会话") });
      const visible = useChatStore.getState().conversations.find((c) => c.id === "c1")!;
      expect(visible.unreadCount).toBe(0);
      expect(useNotificationStore.getState().items).toHaveLength(0);
      expect(window.__heming_notify!.message).not.toHaveBeenCalled();

      // 其它会话：交接期间仍要能感知（不能一刀切静默）
      handleBackgroundEvent({
        type: "message_new",
        message: { ...msg("handoff2", "别处的新消息"), conversationId: "c2" },
      });
      const other = useChatStore.getState().conversations.find((c) => c.id === "c2")!;
      expect(other.unreadCount).toBe(1);
      expect(useNotificationStore.getState().items).toHaveLength(1);
      expect(window.__heming_notify!.message).toHaveBeenCalledTimes(1);
    } finally {
      release();
    }
  });
});
