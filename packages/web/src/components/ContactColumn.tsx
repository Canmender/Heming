import type { Conversation } from "@heming/shared";
import { activeConversationsOf, useChatStore } from "../store/chat.js";
import { useUiStore, type ContactKind } from "../store/ui.js";
import { useAuthStore } from "../store/auth.js";
import { Avatar } from "./Avatar.js";

/**
 * 雷达旁竖列：群聊 / 人类 / 智能体 分段（与雷达扇区同口径），浅灰分割线划分；
 * 头像逐项 rollIn 错峰滚入。点头像切 detailContact（右侧详情卡随动）。
 */
export function ContactColumn() {
  // 归档会话不进主列表（只在归档页出现）
  const conversations = activeConversationsOf(useChatStore((s) => s.conversations));
  const friends = useChatStore((s) => s.friends);
  const agentsRoster = useChatStore((s) => s.agentsRoster);
  const agentIdsInGroups = useChatStore((s) => s.agentIdsInGroups);
  const me = useAuthStore((s) => s.user);
  const active = useUiStore((s) => s.detailContact);
  const openContactDetail = useUiStore((s) => s.openContactDetail);

  const groups = conversations.filter(
    (c): c is Extract<Conversation, { type: "group" }> => c.type === "group",
  );
  const humans = friends.map((f) => f.user);
  // 扇区简化裁决（与雷达一致）：出现在我任一群 members 的名册项 ∪ 自己拥有的名册项
  const agents = agentsRoster.filter(
    (a) => agentIdsInGroups.has(a.id) || (me != null && a.owner_id === me.id),
  );

  const sections: {
    label: string;
    kind: ContactKind;
    items: { id: string; name: string; avatar?: string }[];
  }[] = [
    { label: "群聊", kind: "group", items: groups.map((g) => ({ id: g.id, name: g.name })) },
    {
      label: "人类",
      kind: "human",
      items: humans.map((u) => ({ id: u.id, name: u.displayName, avatar: u.avatar })),
    },
    {
      label: "智能体",
      kind: "agent",
      items: agents.map((a) => ({ id: a.id, name: a.name, avatar: a.avatar ?? undefined })),
    },
  ];

  let idx = 0;
  return (
    <aside
      className="flex w-[84px] shrink-0 flex-col items-center gap-1 overflow-y-auto border-r border-line-soft py-3"
      aria-label="联系人列"
    >
      <style>{`@keyframes rollIn { from { opacity:0; transform:translateX(-16px);} }
aside[aria-label="联系人列"] a, aside[aria-label="联系人列"] button { animation: rollIn .34s ease backwards; }`}</style>
      {sections.map((sec, si) => (
        <div key={sec.label} className="flex w-full flex-col items-center">
          {si > 0 && <div className="my-2 h-px w-14 bg-[#e6e6e6]" />}
          <div className="mb-1 text-[9px] font-bold tracking-wider text-[#bbb]">{sec.label}</div>
          {sec.items.map((it) => {
            const delay = `${idx++ * 0.03}s`;
            const current = active?.kind === sec.kind && active.id === it.id;
            return (
              <button
                key={it.id}
                type="button"
                aria-label={`查看 ${it.name}`}
                aria-current={current || undefined}
                style={{ animationDelay: delay }}
                className={`flex w-[76px] flex-col items-center gap-0.5 rounded-lg px-1 py-1.5 transition-colors hover:bg-[#f7f7f7]${
                  current ? " bg-[#f3f3f3]" : ""
                }`}
                onClick={() => openContactDetail(sec.kind, it.id)}
              >
                <Avatar user={{ displayName: it.name, avatar: it.avatar }} size={32} />
                <span className="w-full truncate text-center text-[10px] text-[#555]">{it.name}</span>
              </button>
            );
          })}
          {sec.items.length === 0 && <div className="text-[9px] text-[#ccc]">暂无</div>}
        </div>
      ))}
    </aside>
  );
}
