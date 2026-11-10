/**
 * 会话名称：Claude Code 侧栏把「会话名」当作一级信息（而不是智能体名）。
 *
 * d.128 起服务端会话模型有可选 `title`（首条消息后由客户端 PATCH 写入），优先用它；
 * 没有 title（旧会话/尚未发消息）时**从已有数据确定性推导**：
 *
 * 1. 已加载消息里的**首条用户消息**（正文或附件名）→ 截断成一句摘要；
 * 2. 没有可读正文（消息还没加载 / 全是密文 / 只有助手消息）→ 最后活跃时间兜底；
 * 3. 完全新会话 → 「新的对话」。
 *
 * 纯函数：无网络、无时钟依赖（时间格式化由 `formatDayClock` 统一口径），
 * 会话栏按会话缓存即可，不会因为每次渲染得到不同名字。
 */
import type { Conversation, Message } from "@heming/shared";
import { formatDayClock } from "../../lib/formatTime.js";

/** 会话名截断长度（按码点，避免把 emoji 劈成半个）。 */
export const CONVERSATION_TITLE_MAX = 24;

/** 新会话的兜底名。 */
export const NEW_CONVERSATION_TITLE = "新的对话";

function clip(text: string, max = CONVERSATION_TITLE_MAX): string {
  const chars = [...text];
  if (chars.length <= max) return text;
  return `${chars.slice(0, max).join("")}…`;
}

/** 首条用户消息的可读文本：正文优先，纯附件消息退回文件名。 */
function firstUserText(messages: readonly Message[] | undefined): string {
  if (!messages || messages.length === 0) return "";
  for (const m of messages) {
    if (m.senderType !== "user") continue;
    const text = (m.payload.text ?? "").replace(/\s+/g, " ").trim();
    if (text) return text;
    const fileName = (m.payload.file?.name ?? "").trim();
    if (fileName) return fileName;
    // 首条用户消息是密文（payload 占位为空）：无法读正文，继续找下一条可读的。
  }
  return "";
}

/**
 * 会话显示名。
 *
 * @param conv 会话（只用 agent/lastMessageAt 两个字段，便于测试构造）
 * @param messages 该会话已加载的消息（store.messages[convId]，未加载传 undefined）
 */
export function conversationTitle(
  conv: Pick<Conversation, "lastMessageAt" | "title">,
  messages?: readonly Message[],
): string {
  const custom = (conv.title ?? "").trim();
  if (custom) return clip(custom, 32);
  const text = firstUserText(messages);
  if (text) return clip(text);
  const at = conv.lastMessageAt;
  if (at) {
    const label = formatDayClock(at);
    if (label) return clip(`${label} 的对话`, 32);
  }
  return NEW_CONVERSATION_TITLE;
}
