import { useEffect, useMemo, useState } from "react";
import type { Agent } from "@heming/shared";
import { useChatStore } from "../store/chat.js";
import { useUiStore } from "../store/ui.js";
import { ChatPage } from "./ChatPage.js";
import { TaskAreaPage } from "./TaskAreaPage.js";
import { AgentFormModal } from "./AgentFormModal.js";
import { Avatar } from "./Avatar.js";
import { AssistantIcon, PlusIcon } from "./icons.js";
import { PageShell } from "./layout/PageShell.js";

/**
 * 智能体页：
 * 左栏是智能体名册（系统智能体在前、自建在后），右栏是与所选智能体的对话。
 *
 * 这里只存在「用户 ↔ 智能体」一种会话，智能体在本机运行（系统提示词、模型 Key、
 * 工具与记忆都不出设备）；团队页只收真实成员，智能体的任务与轨迹留在本页。
 * 会话复用 ChatPage（E2E/流式/附件/HITL/任务全部沿用），不另起发送链路。
 *
 * d.67 导航合并：原「通用智能体」页（任务区）并进来做「任务」Tab。
 * 两个 Tab 都嵌 ChatPage，所以**同一时刻只渲染一个**：非当前 Tab 的分支直接卸载，
 * 不会出现两个消息列表同时订阅同一个流、抢着消费 taskDraft/pendingAttachment。
 */

type AssistantTab = "chat" | "tasks";

export function AssistantPage() {
  const conversations = useChatStore((s) => s.conversations);
  const agentsRoster = useChatStore((s) => s.agentsRoster);
  const loadWorkspace = useChatStore((s) => s.loadWorkspace);
  const loadAgentsRoster = useChatStore((s) => s.loadAgentsRoster);
  const openAgent = useChatStore((s) => s.openAgent);
  const activeConversationId = useUiStore((s) => s.activeConversationId);
  const openingConversation = useUiStore((s) => s.openConversation);
  /** 一次性视图意图（d.67）：旧「通用智能体」链接折叠成 chat + pageView="tasks"。 */
  const pageView = useUiStore((s) => s.pageView);

  const [openingId, setOpeningId] = useState<string | null>(null);
  const [error, setError] = useState("");
  const [createOpen, setCreateOpen] = useState(false);
  const [editing, setEditing] = useState<Agent | null>(null);
  /** 默认落在「对话」：导航里这一项的主体是聊天，任务只是它的第二个视图。 */
  const [tab, setTab] = useState<AssistantTab>("chat");

  // 命令面板「新建智能体」的消费点（d.60）。
  // 面板只投一次内存意图并切到本页；本页是懒加载路由，可能晚一帧才挂载，
  // 所以在「挂载后 effect」里读，读到就打开新建弹窗并消费（token 变化即触发，幂等）。
  const paletteIntent = useUiStore((s) => s.paletteIntent);
  const consumePaletteIntent = useUiStore((s) => s.consumePaletteIntent);
  useEffect(() => {
    if (paletteIntent?.kind !== "agent-create") return;
    setCreateOpen(true);
    // 新建/编辑智能体是名册侧的动作：从「任务」 Tab 走命令面板过来时切回对话，
    // 否则建完关掉弹窗，用户看到的还是任务列表，会以为没生效。
    setTab("chat");
    consumePaletteIntent();
  }, [paletteIntent, consumePaletteIntent]);

  // 视图意图消费（d.67）：旧 setPage("tasks")、通知中心 focusTask 等落在本页时切到「任务」。
  // 读走即清，避免切走再回来仍被上一次跳转钉在任务 Tab。
  //
  // 另外预留 "chat"：通知中心/系统通知「打开某个会话」走的是 `openConversation`，
  // 它只改 activeConversationId 不改 pageView；如果用户当时正停在「任务」Tab，
  // 会话会在看不见的 Tab 下打开。宿主页若能收到「对话视图」意图就切回对话。
  // 目前 PageView 只有 board/tasks/skills/interfaces，"chat" 是向前兼容的写法：
  // 未投递时不会命中，不改变现有行为。
  useEffect(() => {
    if (!pageView) return;
    const view: string | null = useUiStore.getState().consumePageView();
    if (view === "tasks") setTab("tasks");
    else if (view === "chat") setTab("chat");
  }, [pageView]);

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
    <PageShell
      title="智能体"
      subtitle="在本机与智能体对话、派任务；模型 Key、工具与记忆都不出设备。"
      scroll={false}
      headerExtra={
        <div
          className="flex flex-wrap items-center gap-2 bg-[#fbfbfb] px-6 py-2"
          role="tablist"
          aria-label="智能体视图"
        >
          {[
            { key: "chat" as const, label: "对话" },
            { key: "tasks" as const, label: "任务" },
          ].map((t) => (
            <button
              key={t.key}
              type="button"
              role="tab"
              aria-selected={tab === t.key}
              onClick={() => setTab(t.key)}
              className={`rounded-lg px-2.5 py-1 text-[13px] ${
                tab === t.key ? "bg-ink font-semibold text-white" : "text-muted hover:bg-[#f3f3f3]"
              }`}
            >
              {t.label}
            </button>
          ))}
          <span className="ui-micro ml-auto">
            任务视图来自原「通用智能体」：运行记录、目标模板、报告与分叉都在这里
          </span>
        </div>
      }
    >
      {tab === "chat" ? (
        <div className="flex min-h-0 flex-1">
          <aside className="flex w-[240px] shrink-0 flex-col border-r border-line-soft">
            <header className="flex items-center gap-2 border-b border-line-soft px-3 py-2.5">
              <AssistantIcon width={17} height={17} />
              {/* d.62：左栏列表表头用统一 section 档；徽标/数量用 micro 档 */}
              <span className="ui-section-title min-w-0 truncate">我的智能体</span>
              <span className="ui-micro rounded-sm border border-line px-1">本机</span>
              <span className="ui-micro">{sortedAgents.length}</span>
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
                <p className="ui-body-sm px-2 py-6 text-center leading-5">
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
                          <span className="ui-body-sm block truncate font-medium">{agent.name}</span>
                          <span className="ui-caption block truncate">
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
                        className="ui-micro absolute right-1.5 top-1/2 -translate-y-1/2 rounded-sm px-1 py-0.5 opacity-0 hover:bg-[#e9e9e9] hover:text-ink group-hover:opacity-100"
                      >
                        编辑
                      </button>
                    </div>
                  );
                })
              )}
            </div>

            {error && (
              <p className="border-t border-line-soft px-3 py-2 text-[11px] text-[#b42318]">{error}</p>
            )}
            <p className="ui-caption border-t border-line-soft px-3 py-2 leading-4">
              智能体在本机运行：模型 Key、工具与记忆不出设备；消息不进团队动向。
            </p>
          </aside>

          <section className="flex min-w-0 flex-1 flex-col">
            {activeConv ? (
              <ChatPage />
            ) : (
              <div className="flex h-full flex-col items-center justify-center gap-3 px-6 text-center">
                <span className="flex h-16 w-16 items-center justify-center rounded-2xl border border-line-soft bg-[#fafafa] text-[#98a2b3]">
                  <AssistantIcon width={30} height={30} />
                </span>
                <div className="ui-section-title">选择一个智能体开始</div>
                <p className="ui-body-sm max-w-[520px] leading-6">
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
        </div>
      ) : (
        /* 任务视图：复用原「通用智能体」页主体，只去掉它自己的页头标题，
           避免和本页 PageShell 的 h1 叠成两个标题。 */
        <TaskAreaPage embedded />
      )}

      <AgentFormModal open={createOpen} mode="create" onClose={() => setCreateOpen(false)} />
      <AgentFormModal
        open={!!editing}
        mode="edit"
        {...(editing ? { agent: editing } : {})}
        onClose={() => setEditing(null)}
      />
    </PageShell>
  );
}
