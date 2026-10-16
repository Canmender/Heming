import { useState } from "react";
import { useChatStore } from "../store/chat.js";
import { useUiStore, type ContactKind } from "../store/ui.js";
import { useAuthStore } from "../store/auth.js";
import { Avatar } from "./Avatar.js";
import { AgentFormModal } from "./AgentFormModal.js";

/**
 * 联系人详情卡：头像大卡 + 类型信息 + 发消息/编辑/返回雷达。
 * 人类/群发消息直进会话（无直聊的先 openDirect）；智能体仅展示（M2 无 1:1 会话，发消息禁用）。
 */
export function ContactDetail({ target }: { target: { kind: ContactKind; id: string } }) {
  const conversations = useChatStore((s) => s.conversations);
  const friends = useChatStore((s) => s.friends);
  const agentsRoster = useChatStore((s) => s.agentsRoster);
  const agentIdsInGroups = useChatStore((s) => s.agentIdsInGroups);
  const messages = useChatStore((s) => s.messages);
  const openDirect = useChatStore((s) => s.openDirect);
  const me = useAuthStore((s) => s.user);
  const openConversation = useUiStore((s) => s.openConversation);
  const closeContactDetail = useUiStore((s) => s.closeContactDetail);
  const [editAgent, setEditAgent] = useState(false);

  const group =
    target.kind === "group"
      ? conversations.find((c) => c.id === target.id && c.type === "group")
      : undefined;
  const human =
    target.kind === "human" ? friends.map((f) => f.user).find((u) => u.id === target.id) : undefined;
  const agent = target.kind === "agent" ? agentsRoster.find((a) => a.id === target.id) : undefined;

  if (!group && !human && !agent) {
    return (
      <div className="flex h-full flex-col items-center justify-center gap-3 text-muted">
        <p className="text-[13px]">未找到该联系人</p>
        <button
          type="button"
          className="rounded-lg border border-line px-3 py-1.5 text-[12px] shadow-card"
          onClick={closeContactDetail}
        >
          返回雷达
        </button>
      </div>
    );
  }

  const title = group?.name ?? human?.displayName ?? agent?.name ?? "";
  const kindLabel = target.kind === "group" ? "群聊" : target.kind === "human" ? "人类" : "智能体";
  const directConv = human
    ? conversations.find((c) => c.type === "direct" && c.peer.id === human.id)
    : undefined;
  const convForLast = group ?? directConv;
  const lastMsg = convForLast ? (messages[convForLast.id] ?? []).slice(-1)[0] : undefined;
  const agentOwned = agent != null && me != null && agent.owner_id === me.id;
  const inGroup = agent != null && agentIdsInGroups.has(agent.id);

  const onSend = () => {
    if (group) {
      openConversation(group.id);
    } else if (human) {
      const go = (id: string) => openConversation(id);
      if (directConv) go(directConv.id);
      else void openDirect(human.id).then(go);
    }
  };

  return (
    <div className="flex h-full flex-col items-center justify-center gap-4 p-8">
      <div className="w-[340px] rounded-2xl border border-[#ececec] bg-white p-6 shadow-card">
        <div className="flex items-center gap-3.5">
          <Avatar
            user={{ displayName: title, avatar: human?.avatar ?? agent?.avatar ?? undefined }}
            size={40}
            className="border-2 border-white shadow-card"
          />
          <div className="min-w-0">
            <div className="truncate text-[17px] font-extrabold">{title}</div>
            <div className="text-[11px] text-muted">
              {kindLabel}
              {human ? ` · @${human.username}` : ""}
              {group ? ` · ${group.memberCount} 人` : ""}
              {agent ? (inGroup ? " · 已入群" : " · 未入群") : ""}
            </div>
          </div>
        </div>
        {agent?.description && (
          <p className="mt-3 border-t border-[#f1f1f1] pt-3 text-[12px] leading-relaxed text-[#555]">
            {agent.description}
          </p>
        )}
        {lastMsg && (
          <p className="mt-2 truncate text-[11px] text-muted">
            最近消息：{lastMsg.payload.text || "(附件)"}
          </p>
        )}
        <div className="mt-4 flex gap-2">
          {agentOwned && agent && (
            <button
              type="button"
              className="flex-1 rounded-lg border border-line py-2 text-[12px] shadow-card"
              onClick={() => setEditAgent(true)}
            >
              编辑
            </button>
          )}
          <button
            type="button"
            disabled={!!agent}
            title={agent ? "智能体对话在群内 @" : undefined}
            className="flex-1 rounded-lg bg-ink py-2 text-[12px] font-bold text-white disabled:cursor-default disabled:bg-[#e6e6e6] disabled:text-[#999]"
            onClick={onSend}
          >
            发消息
          </button>
        </div>
        <button
          type="button"
          className="mt-2 w-full rounded-lg border border-line py-1.5 text-[12px] text-muted shadow-card"
          onClick={closeContactDetail}
        >
          返回雷达
        </button>
      </div>
      {editAgent && agent && (
        <AgentFormModal key={agent.id} open mode="edit" agent={agent} onClose={() => setEditAgent(false)} />
      )}
    </div>
  );
}
