import { useSyncExternalStore } from "react";
import type { Conversation } from "@heming/shared";
import { Avatar } from "./Avatar.js";
import { convLabel } from "./ChatPage.js";
import { BellIcon } from "./icons.js";
import {
  convPrefsVersion,
  isMuted,
  setMuted,
  subscribeConvPrefs,
} from "../lib/convPrefs.js";

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
  // 偏好变更时刷新（开关状态不是 React state，订阅版本号驱动重渲染）
  useSyncExternalStore(subscribeConvPrefs, convPrefsVersion, () => 0);
  const muted = isMuted(conv.id);
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
      <button
        type="button"
        role="switch"
        aria-checked={muted}
        aria-label="免打扰"
        onClick={() => setMuted(conv.id, !muted)}
        className={`mt-2.5 flex w-full items-center justify-between rounded-lg border px-2.5 py-2 text-[12px] transition-colors ${
          muted ? "border-[#f0d58c] bg-[#fff7e6] text-[#b45309]" : "border-line text-[#555] hover:bg-[#fafafa]"
        }`}
      >
        <span className="flex items-center gap-1.5">
          <BellIcon width={15} height={15} />
          免打扰
        </span>
        <span className="text-[11px]">{muted ? "已开启免打扰" : "关闭"}</span>
      </button>
      <div className="mt-2.5 border-t border-[#f1f1f1] pt-2 text-[11px] text-muted">
        {conv.type === "direct" ? "好友 · 1:1 会话" : "群聊会话"}
      </div>
    </div>
  );
}
