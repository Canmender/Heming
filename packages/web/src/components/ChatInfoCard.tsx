import type { Conversation } from "@heming/shared";
import { Avatar } from "./Avatar.js";
import { convLabel } from "./ChatPage.js";

/** 会话信息卡（三横线点击弹出）：direct=对方资料；agent=智能体名片；group=群名与人数。 */
export function ChatInfoCard({
  conv,
  onClose,
}: {
  conv: Conversation;
  onClose: () => void;
}) {
  // 三态会话（direct / agent 一对一 / group）各取各字段，集中一处避免漏改
  const label = convLabel(conv);
  return (
    <div
      className="absolute right-3 top-full z-40 mt-1 w-[230px] rounded-xl border border-[#ececec] bg-white p-3.5 shadow-card"
      style={{ animation: "chatpop .18s ease" }}
    >
      <style>{`@keyframes chatpop { from { opacity:0; transform:translateY(-6px);} }`}</style>
      <div className="flex items-center gap-2.5">
        <Avatar
          user={{ displayName: label.name, avatar: label.avatar }}
          size={40}
          className="border-2 border-white shadow-card"
        />
        <div className="min-w-0 flex-1">
          <div className="truncate text-[14px] font-extrabold">{label.name}</div>
          <div className="text-[11px] text-muted">
            {conv.type === "direct"
              ? `@${conv.peer.username}`
              : conv.type === "agent"
                ? conv.agent.description || "智能体"
                : `${conv.memberCount} 人`}
          </div>
        </div>
        <button
          type="button"
          aria-label="关闭会话信息"
          className="rounded p-1 text-muted hover:bg-[#f3f3f3]"
          onClick={onClose}
        >
          ×
        </button>
      </div>
      <div className="mt-2.5 border-t border-[#f1f1f1] pt-2 text-[11px] text-muted">
        {conv.type === "direct" ? "好友 · 1:1 会话" : "群聊会话"}
      </div>
    </div>
  );
}
