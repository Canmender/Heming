import { useEffect, useMemo, useState } from "react";
import type { Agent } from "@heming/shared";
import { useChatStore } from "../store/chat.js";
import { useUiStore } from "../store/ui.js";
import { ChatPage } from "./ChatPage.js";
import { AgentFormModal } from "./AgentFormModal.js";
import { Avatar } from "./Avatar.js";
import { AssistantIcon, PlusIcon } from "./icons.js";

/**
 * 智能体页（原聊天页转正）：
 * 左栏是智能体名册（系统智能体在前、自建在后），右栏是与所选智能体的对话。
 *
 * 这里只存在「用户 ↔ 智能体」一种会话，智能体在本机运行（系统提示词、模型 Key、
 * 工具与记忆都不出设备）；团队页只收真实成员，智能体的任务与轨迹留在本页。
 * 会话复用 ChatPage（E2E/流式/附件/HITL/任务全部沿用），不另起发送链路。
 */
export function AssistantPage() {
  const conversations = useChatStore((s) => s.conversations);
  const agentsRoster = useChatStore((s) => s.agentsRoster);
  const loadWorkspace = useChatStore((s) => s.loadWorkspace);
  const loadAgentsRoster = useChatStore((s) => s.loadAgentsRoster);
  const openAgent = useChatStore((s) => s.openAgent);
  const activeConversationId = useUiStore((s) => s.activeConversationId);
  const openingConversation = useUiStore((s) => s.openConversation);

  const [openingId, setOpeningId] = useState<string | null>(null);
  const [error, setError] = useState("");
  const [createOpen, setCreateOpen] = useState(false);
  const [editing, setEditing] = useState<Agent | null>(null);

  // 名册与会话都从服务端取：智能体页是独立入口，不依赖用户先去别的页。
  useEffect(() => {
    void loadWorkspace().catch(() => {
      /* 离线时保留已有的本机会话态 */
    });
    void loadAgentsRoster().catch(() => {
      /* 名册失败只影响列表；错误在下方提示一次 */
    });
  }, [loadWorkspace, loadAgentsRoster]);

  const sortedAgents = useMemo(() => {
    return [...agentsRoster].sort((a, b) => {
      if (a.id === "system-assistant") return -1;
      if (b.id === "system-assistant") return 1;
      return a.name.localeCompare(b.name, "zh");
    });
  }, [agentsRoster]);

  const convByAgent = useMemo(() => {
    const map = new Map<string, (typeof conversations)[number]>();
    for (const c of conversations) map.set(c.agent.id, c);
    return map;
  }, [conversations]);

  const activeConv = conversations.find((c) => c.id === activeConversationId);
  const systemAgent = sortedAgents.find((a) => a.id === "system-assistant");

  const startChat = async (agent: Agent) => {
    if (openingId) return;
    setOpeningId(agent.id);
    setError("");
    try {
      // 服务端幂等：已有会话直接复用，不重复建
      const convId = await openAgent(agent.id);
      openingConversation(convId);
    } catch (err) {
      setError(err instanceof Error && err.message ? err.message : "打开会话失败");
    } finally {
      setOpeningId(null);
    }
  };

  return (
    <div className="flex h-full min-h-0">
      <aside className="flex w-[240px] shrink-0 flex-col border-r border-line-soft">
        <header className="flex items-center gap-2 border-b border-line-soft px-3 py-2.5">
          <AssistantIcon width={17} height={17} />
          <span className="text-[13px] font-bold">智能体</span>
          <span className="rounded border border-line px-1 text-[9px] text-muted">本机</span>
          <span className="text-[10px] text-muted">{sortedAgents.length}</span>
          <button
            type="button"
            aria-label="新建智能体"
            title="新建智能体"
            onClick={() => setCreateOpen(true)}
            className="ml-auto flex h-[24px] w-[24px] items-center justify-center rounded-md text-[#666] hover:bg-[#f0f0f0] hover:text-ink"
          >
            <PlusIcon width={14} height={14} />
          </button>
        </header>

        <div className="min-h-0 flex-1 overflow-y-auto p-1.5">
          {sortedAgents.length === 0 ? (
            <p className="px-2 py-6 text-center text-[12px] leading-5 text-muted">
              还没有智能体。
              <br />
              点右上角「+」建一个。
            </p>
          ) : (
            sortedAgents.map((agent) => {
              const conv = convByAgent.get(agent.id);
              const active = conv && conv.id === activeConversationId;
              const busy = openingId === agent.id;
              return (
                <div key={agent.id} className="group relative mb-1">
                  <button
                    type="button"
                    aria-label={`与智能体 ${agent.name} 对话`}
                    aria-current={active ? "true" : undefined}
                    disabled={busy}
                    onClick={() => void startChat(agent)}
                    className={`flex w-full items-center gap-2 rounded-lg px-2 py-1.5 text-left transition-colors disabled:opacity-60 ${
                      active ? "bg-[#f0f0f0]" : "hover:bg-[#f7f7f7]"
                    }`}
                  >
                    <Avatar
                      user={{ displayName: agent.name, avatar: agent.avatar ?? undefined }}
                      size={26}
                    />
                    <span className="min-w-0 flex-1">
                      <span className="block truncate text-[12px] font-medium">{agent.name}</span>
                      <span className="block truncate text-[10px] text-muted">
                        {busy
                          ? "正在打开…"
                          : conv?.lastMessageAt
                            ? "最近有对话"
                            : agent.id === "system-assistant"
                              ? "和鸣系统智能体"
                              : agent.description || "暂无对话"}
                      </span>
                    </span>
                  </button>
                  <button
                    type="button"
                    aria-label={`编辑智能体：${agent.name}`}
                    onClick={() => setEditing(agent)}
                    className="absolute right-1.5 top-1/2 -translate-y-1/2 rounded px-1 py-0.5 text-[10px] text-muted opacity-0 hover:bg-[#e9e9e9] hover:text-ink group-hover:opacity-100"
                  >
                    编辑
                  </button>
                </div>
              );
            })
          )}
        </div>

        {error && <p className="border-t border-line-soft px-3 py-2 text-[11px] text-[#b42318]">{error}</p>}
        <p className="border-t border-line-soft px-3 py-2 text-[10px] leading-4 text-muted">
          智能体在本机运行：模型 Key、工具与记忆不出设备；消息不进团队动向。
        </p>
      </aside>

      <section className="flex min-w-0 flex-1 flex-col">
        {activeConv ? (
          <ChatPage />
        ) : (
          <div className="flex h-full flex-col items-center justify-center gap-3 px-8 text-center">
            <span className="flex h-16 w-16 items-center justify-center rounded-2xl border border-line-soft bg-[#fafafa] text-[#98a2b3]">
              <AssistantIcon width={30} height={30} />
            </span>
            <div className="text-[14px] font-bold">选择一个智能体开始</div>
            <p className="max-w-[420px] text-[12px] leading-6 text-muted">
              {"把任务交给本机智能体：它可以对话、调用本机工具、执行任务。人类私聊与群聊已从这个版本移除；团队页只展示真实成员的任务与日程动向。"}
            </p>
            {systemAgent && (
              <button
                type="button"
                onClick={() => void startChat(systemAgent)}
                className="rounded-lg bg-ink px-3 py-1.5 text-[12px] font-medium text-white"
              >
                和小鸣聊聊
              </button>
            )}
          </div>
        )}
      </section>

      <AgentFormModal open={createOpen} mode="create" onClose={() => setCreateOpen(false)} />
      <AgentFormModal
        open={!!editing}
        mode="edit"
        {...(editing ? { agent: editing } : {})}
        onClose={() => setEditing(null)}
      />
    </div>
  );
}
