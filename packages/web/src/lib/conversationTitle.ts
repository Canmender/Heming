import type { Conversation } from "@heming/shared";

/** 三态会话的显示名（通知标题用；与 ChatPage 头部口径一致）。 */
export function conversationTitle(conv: Conversation): string {
  if (conv.type === "direct") return conv.peer.displayName;
  if (conv.type === "agent") return conv.agent.name;
  return `${conv.name}（${conv.memberCount} 人）`;
}
