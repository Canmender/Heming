import { describe, it, expect, beforeEach, vi } from "vitest";
import type { Message } from "@heming/shared";
import { notifyIncomingMessage } from "./messageNotify.js";
import { setMuted, resetConvPrefsForTest } from "./convPrefs.js";
import { useChatStore } from "../store/chat.js";
import { useNotificationStore } from "../store/notifications.js";

const msg = (over: Partial<Message> = {}): Message => ({
  id: "m1",
  conversationId: "c1",
  senderType: "user",
  senderId: "u2",
  payload: { text: "你好" },
  replyTo: null,
  createdAt: "2026-10-28T01:00:00.000Z",
  recalledAt: null,
  enc: "plain",
  ...over,
});

beforeEach(() => {
  localStorage.clear();
  resetConvPrefsForTest();
  useNotificationStore.getState().clearAll();
  useChatStore.setState({
    conversations: [
      {
        id: "c1",
        type: "direct",
        peer: { id: "u2", username: "bob", displayName: "鲍勃" },
        unreadCount: 0,
      },
    ],
  });
  (window as unknown as { __heming_notify?: unknown }).__heming_notify = {
    message: vi.fn(),
    onOpen: vi.fn(() => () => {}),
  };
  vi.spyOn(document, "hasFocus").mockReturnValue(false);
});

describe("messageNotify", () => {
  it("应用内通知 + 系统通知：标题为会话名，系统正文固定，不带消息内容", () => {
    notifyIncomingMessage(msg());
    const item = useNotificationStore.getState().items[0];
    expect(item.title).toBe("鲍勃");
    expect(item.body).toBe("你好");
    expect(window.__heming_notify!.message).toHaveBeenCalledWith({
      title: "鲍勃",
      body: "你有一条新消息",
      conversationId: "c1",
    });
  });

  it("E2E 消息应用内不带正文；系统通知仍固定文案", () => {
    notifyIncomingMessage(msg({ enc: "e2e", payload: { text: "" } }));
    expect(useNotificationStore.getState().items[0].body).toBe("");
    expect(window.__heming_notify!.message).toHaveBeenCalled();
  });

  it("免打扰：应用内与系统通知都不发", () => {
    setMuted("c1", true);
    notifyIncomingMessage(msg());
    expect(useNotificationStore.getState().items).toHaveLength(0);
    expect(window.__heming_notify!.message).not.toHaveBeenCalled();
  });

  it("窗口聚焦时不请求系统通知；桥缺失时静默", () => {
    vi.mocked(document.hasFocus).mockReturnValue(true);
    notifyIncomingMessage(msg());
    expect(window.__heming_notify!.message).not.toHaveBeenCalled();
    delete (window as unknown as { __heming_notify?: unknown }).__heming_notify;
    vi.mocked(document.hasFocus).mockReturnValue(false);
    expect(() => notifyIncomingMessage(msg({ id: "m2" }))).not.toThrow();
  });
});
