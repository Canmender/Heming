import { useEffect } from "react";
import type { WsServerEvent } from "@heming/shared";
import { connectWs } from "./ws.js";
import { useAuthStore } from "../store/auth.js";
import { useChatStore } from "../store/chat.js";
import { notifyIncomingMessage } from "./messageNotify.js";

/**
 * 后台连接的事件处理（非聊天页）：只做感知，不解密正文。
 *
 * 未读/最近活跃/通知三件事与聊天页「其它会话」路径共用同一套 store 与提醒入口，
 * 避免两处口径分叉。
 */
export function handleBackgroundEvent(e: WsServerEvent): void {
  const me = useAuthStore.getState().user?.id;
  if (e.type === "message_new") {
    const m = e.message;
    // 契约：notifyIncomingMessage 不判断 sender，自己发的必须先在这里过滤
    if (m.senderId === me) return;
    const fresh = useChatStore.getState().bumpUnread(m.conversationId, m.createdAt, m.id);
    if (fresh) notifyIncomingMessage(m);
    // 未知会话（工作区列表里还没有）：提醒照发，并整体刷新一次工作区补齐会话行
    if (!useChatStore.getState().conversations.some((c) => c.id === m.conversationId)) {
      void useChatStore.getState().loadWorkspace().catch(() => {});
    }
  } else if (e.type === "read_update") {
    if (e.userId === me) useChatStore.getState().clearUnread(e.conversationId, e.at);
  }
}

/** 非聊天页驻留的后台连接：进入聊天页即关闭，交给 ChatPage 自己的连接。 */
export function useBackgroundMessages(active: boolean): void {
  useEffect(() => {
    if (!active) return;
    let alive = true;
    const handle = connectWs({
      onEvent: (e) => {
        if (alive) handleBackgroundEvent(e);
      },
      onOpen: () => {
        // 断线期间可能错过事件：连上即刷新工作区（未读数由服务端事实补齐）
        void useChatStore.getState().loadWorkspace().catch(() => {});
      },
    });
    return () => {
      alive = false;
      handle.close();
    };
  }, [active]);
}
