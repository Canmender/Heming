import type { CSSProperties } from "react";
import { Avatar } from "./Avatar.js";

/** 选择器条目：名册 Agent 行的子集（avatar 允许 null，直接吃 Agent[]）。 */
export interface MentionItem {
  id: string;
  name: string;
  avatar?: string | null;
}

/**
 * @ 选择器 · 输入栏上方浮层卡片（头像 + 名，浅灰令牌样式）：
 * MVP 交互 = 点击条目回调 onPick；Esc 关闭由 ChatPage 在输入框 keydown 处理（焦点天然在输入栏）。
 * 候选过滤也在 ChatPage（本群 agent 数据源所在），本组件只负责展示与回调。
 */
export function MentionPicker({
  items,
  onPick,
  anchorStyle,
}: {
  items: MentionItem[];
  onPick: (item: MentionItem) => void;
  anchorStyle?: CSSProperties;
}) {
  return (
    <div
      className="absolute bottom-full left-5 z-30 mb-2 max-h-56 w-64 overflow-y-auto rounded-lg border border-line bg-white py-1 shadow-card"
      style={anchorStyle}
    >
      {items.length === 0 ? (
        <p className="px-3 py-2 text-[12px] text-muted">群内暂无智能体</p>
      ) : (
        items.map((it) => (
          <button
            key={it.id}
            type="button"
            className="flex w-full items-center gap-2 px-3 py-1.5 text-left text-[13px] hover:bg-[#f3f3f3]"
            onClick={() => onPick(it)}
          >
            <Avatar user={{ displayName: it.name, avatar: it.avatar ?? undefined }} size={22} />
            <span>{it.name}</span>
          </button>
        ))
      )}
    </div>
  );
}
