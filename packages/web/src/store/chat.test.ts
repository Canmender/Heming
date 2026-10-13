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

const msgAt = (id: string, text: string, createdAt: string): Message => ({
  ...msg(id, text),
  createdAt,
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

  it("setMessages 合并历史：fetch 期间已入列的新消息不被覆盖", () => {
    // 交错：历史响应落定前，message_new 已经 appendMessage 入列
    useChatStore.getState().appendMessage(msgAt("mNew", "新", "2026-10-13T00:00:05.000Z"));
    useChatStore.getState().setMessages("c1", [
      msgAt("m1", "历史1", "2026-10-13T00:00:01.000Z"),
      msgAt("m2", "历史2", "2026-10-13T00:00:02.000Z"),
    ]);
    const ids = useChatStore.getState().messages["c1"].map((m) => m.id);
    expect(ids).toEqual(["m1", "m2", "mNew"]);
    expect(new Set(ids).size).toBe(ids.length);
  });

  it("setMessages 与本地同 id 去重（历史快照与广播交错）", () => {
    useChatStore.getState().appendMessage(msgAt("m1", "本地", "2026-10-13T00:00:01.000Z"));
    useChatStore.getState().setMessages("c1", [
      msgAt("m1", "历史", "2026-10-13T00:00:01.000Z"),
      msgAt("m2", "历史2", "2026-10-13T00:00:02.000Z"),
    ]);
    const ids = useChatStore.getState().messages["c1"].map((m) => m.id);
    expect(ids).toEqual(["m1", "m2"]);
  });

  it("setMessages 本地独有消息按 createdAt 插入历史中间", () => {
    useChatStore.getState().setMessages("c1", [
      msgAt("m1", "历史1", "2026-10-13T00:00:01.000Z"),
      msgAt("m3", "历史3", "2026-10-13T00:00:03.000Z"),
    ]);
    useChatStore.getState().appendMessage(msgAt("m2", "迟到", "2026-10-13T00:00:02.000Z"));
    useChatStore.getState().setMessages("c1", [
      msgAt("m1", "历史1", "2026-10-13T00:00:01.000Z"),
      msgAt("m3", "历史3", "2026-10-13T00:00:03.000Z"),
    ]);
    const ids = useChatStore.getState().messages["c1"].map((m) => m.id);
    expect(ids).toEqual(["m1", "m2", "m3"]);
  });
});
