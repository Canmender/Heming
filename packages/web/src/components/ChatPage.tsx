import { useEffect, useRef, useState } from "react";
import { useChatStore } from "../store/chat.js";
import { useUiStore } from "../store/ui.js";
import { useAuthStore } from "../store/auth.js";
import { fetchMessages } from "../lib/api.js";
import { connectWs, type WsHandle } from "../lib/ws.js";
import { ChevronIcon } from "./icons.js";

export function ChatPage() {
  const convId = useUiStore((s) => s.activeConversationId)!;
  const leave = useUiStore((s) => s.leaveConversation);
  const conversations = useChatStore((s) => s.conversations);
  const messages = useChatStore((s) => s.messages[convId] ?? []);
  const setMessages = useChatStore((s) => s.setMessages);
  const appendMessage = useChatStore((s) => s.appendMessage);
  const me = useAuthStore((s) => s.user);
  const [draft, setDraft] = useState("");
  const [connected, setConnected] = useState(false);
  const wsHandleRef = useRef<WsHandle | null>(null);
  const bottomRef = useRef<HTMLDivElement | null>(null);

  const peer = conversations.find((c) => c.id === convId)?.peer;

  useEffect(() => {
    void fetchMessages(convId).then((msgs) => setMessages(convId, msgs));
  }, [convId, setMessages]);

  useEffect(() => {
    const handle = connectWs({
      onEvent: (e) => {
        if (e.type === "message_new" && e.message.conversationId === convId) {
          appendMessage(e.message);
        } else if (e.type === "error") {
          console.warn(`[${e.code}] ${e.message}`);
        }
      },
      onOpen: () => setConnected(true),
      onClose: () => setConnected(false),
    });
    wsHandleRef.current = handle;
    return () => {
      handle.close();
      wsHandleRef.current = null;
    };
  }, [convId, appendMessage]);

  useEffect(() => {
    bottomRef.current?.scrollIntoView({ behavior: "smooth" });
  }, [messages.length]);

  const send = (e: React.FormEvent) => {
    e.preventDefault();
    const text = draft.trim();
    if (!text) return;
    wsHandleRef.current?.send({
      type: "send_message",
      conversationId: convId,
      payload: { text },
    });
    setDraft("");
  };

  return (
    <div className="flex h-full flex-col">
      <header className="flex items-center gap-2 border-b border-line-soft px-5 py-3">
        <button
          type="button"
          aria-label="返回"
          className="rounded p-1 text-muted hover:bg-[#f3f3f3]"
          onClick={leave}
        >
          <ChevronIcon width={15} height={15} className="rotate-180" />
        </button>
        <span className="text-[14px] font-bold">{peer?.displayName ?? "会话"}</span>
        <span className="text-[12px] text-muted">{connected ? "已连接" : "连接中…"}</span>
      </header>
      <div className="flex-1 overflow-y-auto px-5 py-4">
        {messages.map((m) => (
          <div
            key={m.id}
            className={`mb-3 max-w-[70%] rounded-lg border border-line px-3 py-2 text-[13px] shadow-card ${
              m.senderId === me?.id ? "ml-auto bg-white" : "bg-[#f7f7f7]"
            }`}
          >
            <div className="mb-0.5 text-[10px] text-muted">
              {m.senderId === me?.id ? "我" : peer?.displayName}
            </div>
            {m.payload.text}
          </div>
        ))}
        <div ref={bottomRef} />
      </div>
      <form onSubmit={send} className="flex gap-2 border-t border-line-soft px-5 py-3">
        <input
          className="flex-1 rounded-lg border border-line px-3 py-2 text-sm outline-none focus:border-[#bbb]"
          placeholder="输入消息…"
          value={draft}
          onChange={(e) => setDraft(e.target.value)}
        />
        <button type="submit" className="rounded-lg bg-ink px-4 py-2 text-sm font-bold text-white">
          发送
        </button>
      </form>
    </div>
  );
}
