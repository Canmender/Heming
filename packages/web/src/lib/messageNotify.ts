import type { Message } from "@heming/shared";
import { useChatStore } from "../store/chat.js";
import { useNotificationStore } from "../store/notifications.js";
import { isMuted } from "./convPrefs.js";
import { conversationTitle } from "./conversationTitle.js";
import { notifyDesktop } from "./desktopNotify.js";

/**
 * 新消息的唯一提醒入口（聊天页其它会话 / 后台连接共用）。
 *
 * - 免打扰：应用内与系统通知都不发；未读由调用方照常计数；
 * - 应用内通知按 `message:<id>` 去重（push 返回 null 即已存在）；
 * - 系统通知正文固定，不泄露消息内容（E2E 尤其如此）。
 * - 调用契约：调用方必须先过滤自己发送的消息——本函数只负责提醒，不判断 sender。
 */
export function notifyIncomingMessage(m: Message): void {
  if (isMuted(m.conversationId)) return;
  const conv = useChatStore.getState().conversations.find((c) => c.id === m.conversationId);
  const title = conv ? conversationTitle(conv) : "新消息";
  const pushed = useNotificationStore.getState().push({
    kind: "message",
    key: `message:${m.id}`,
    title,
    ...(m.enc === "e2e" ? {} : m.payload.text ? { body: m.payload.text } : {}),
    conversationId: m.conversationId,
  });
  if (!pushed) return; // 重复提醒已在通知中心存在
  notifyDesktop({ title, body: "你有一条新消息", conversationId: m.conversationId });
}
