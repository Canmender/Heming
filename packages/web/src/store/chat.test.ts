import { describe, it, expect, beforeEach } from "vitest";
import type { Message } from "@heming/shared";
import { useChatStore } from "./chat.js";

const msg = (id: string, text: string): Message => ({
  id,
  conversationId: "c1",
  senderType: "user",
  senderId: "u1",
  payload: { text },
  replyTo: null,
  createdAt: "2026-10-13T00:00:00.000Z",
});

describe("chat store", () => {
  beforeEach(() => {
    useChatStore.setState({ conversations: [], friends: [], incoming: [], messages: {} });
  });

  it("appendMessage 追加消息", () => {
    useChatStore.getState().appendMessage(msg("m1", "一"));
    useChatStore.getState().appendMessage(msg("m2", "二"));
    const list = useChatStore.getState().messages["c1"];
    expect(list?.map((m) => m.id)).toEqual(["m1", "m2"]);
  });

  it("appendMessage 对相同 id 去重（重连重放）", () => {
    useChatStore.getState().appendMessage(msg("m1", "一"));
    useChatStore.getState().appendMessage(msg("m1", "一改"));
    expect(useChatStore.getState().messages["c1"]).toHaveLength(1);
  });

  it("setMessages 整体覆盖", () => {
    useChatStore.getState().appendMessage(msg("m1", "一"));
    useChatStore.getState().setMessages("c1", [msg("m9", "终")]);
    expect(useChatStore.getState().messages["c1"]).toHaveLength(1);
    expect(useChatStore.getState().messages["c1"]?.[0].id).toBe("m9");
  });
});
