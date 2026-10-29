import type { Message } from "@heming/shared";
import { useChatStore } from "../store/chat.js";
import { useNotificationStore } from "../store/notifications.js";
import { isMuted } from "./convPrefs.js";
import { conversationTitle } from "./conversationTitle.js";
import { notifyDesktop } from "./desktopNotify.js";

/**
 * 同一会话的系统通知合并窗口：窗口内只弹第一声，避免消息风暴刷屏。
 * 应用内通知仍逐条（按 `message:<id>` 去重），免打扰路径不变。
 */
const DESKTOP_NOTIFY_COALESCE_MS = 5000;
/** 每个会话最近一次请求系统通知的时间（毫秒）。 */
const lastDesktopAt = new Map<string, number>();

/** 测试隔离：清空合并窗口记录（模块级状态跨用例存活）。 */
export function resetMessageNotifyForTest(): void {
  lastDesktopAt.clear();
}

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
  const now = Date.now();
  if (now - (lastDesktopAt.get(m.conversationId) ?? 0) >= DESKTOP_NOTIFY_COALESCE_MS) {
    lastDesktopAt.set(m.conversationId, now);
    notifyDesktop({ title, body: "你有一条新消息", conversationId: m.conversationId });
  }
}
