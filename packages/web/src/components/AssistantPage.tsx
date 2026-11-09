import { useCallback, useEffect, useMemo, useState } from "react";
import { useSessionTab } from "../lib/sessionState.js";
import type { Agent } from "@heming/shared";
import { useChatStore } from "../store/chat.js";
import { useUiStore } from "../store/ui.js";
import { useLlmStore } from "../store/llm.js";
import { resolveBoundProfile } from "../lib/llmRoute.js";
import { ChatPage } from "./ChatPage.js";
import { AgentFormModal } from "./AgentFormModal.js";
import { Avatar } from "./Avatar.js";
import { CollabView } from "./collaboration/CollabView.js";
import { AssistantIcon, PlusIcon } from "./icons.js";
import { PageShell } from "./layout/PageShell.js";
import { PAGE_TABLIST, pageTabClass } from "../lib/ui/tabStyles.js";

/**
 * 智能体页（d.67 导航合并；本轮改为「任务 / 协作」两个视图）：
 *
 * - **任务**：会话驱动的标准智能体工作台。左栏是智能体名册（可折叠），右栏复用
 *   ChatPage（E2E/流式/附件/HITL/任务全部沿用），不另起发送链路。
 * - **协作**：Multi-Agent 多人工作台（components/collaboration/CollabView），
 *   由本机编排器驱动多个智能体依次发言；与 ChatPage 互斥渲染。
 *
 * 两个视图**同一时刻只渲染一个**：切走的分支直接卸载，不会出现两处同时订阅同一个
 * 流、抢着消费 taskDraft/pendingAttachment。
 *
 * 智能体在本机运行：系统提示词、模型 Key、工具与记忆都不出设备；团队页只收真实成员，
 * 智能体的任务与轨迹留在本页。
 */

type AssistantTab = "work" | "collab";
/** 存储里可能残留旧版 "chat" / "tasks"，读的时候统一归一为 "work"，不丢会话记忆。 */
type StoredAssistantTab = AssistantTab | "chat" | "tasks";

const ASSISTANT_TAB_KEY = "heming.tab.assistant.v1";
const ASSISTANT_TABS = ["work", "collab", "chat", "tasks"] as const;

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

  // 绑定状态只用于任务视图顶部的「模型已绑定」提示；协作视图自己算可用名单。
  const llmBindings = useLlmStore((s) => s.bindings);
  const llmRoutes = useLlmStore((s) => s.routes);
  const llmProfiles = useLlmStore((s) => s.profiles);

  const [openingId, setOpeningId] = useState<string | null>(null);
  const [error, setError] = useState("");
  const [createOpen, setCreateOpen] = useState(false);
  /** 新建弹窗打开时焦点落点：名册「＋ 新建」→ 名称；「从模板创建」→ 第一个模板。 */
  const [createStartAt, setCreateStartAt] = useState<"name" | "templates">("name");
  const [editing, setEditing] = useState<Agent | null>(null);
  /**
   * 默认落在「任务」。key 沿用 v1 以保留会话记忆；旧值 chat/tasks 在读取时
   * 归一为 work（见下方 `tab` 推导），绝不落到空白视图。
   */
  const [storedTab, setStoredTab] = useSessionTab<StoredAssistantTab>(
    ASSISTANT_TAB_KEY,
    "work",
    ASSISTANT_TABS,
  );
  const tab: AssistantTab = storedTab === "collab" ? "collab" : "work";
  const setTab = useCallback(
    (next: AssistantTab) => {
      setStoredTab(next);
    },
    [setStoredTab],
  );
  /** 名册搜索：智能体多了以后按名称/简介找（<5 个时不显示，不给一两条数据配搜索框）。 */
  const [agentQuery, setAgentQuery] = useState("");
  /** 左栏可折叠：协作/宽屏时把横向空间让给会话。 */
  const [railCollapsed, setRailCollapsed] = useState(false);

  // 命令面板「新建智能体」的消费点（d.60）。
  // 面板只投一次内存意图并切到本页；本页是懒加载路由，可能晚一帧才挂载，
  // 所以在「挂载后 effect」里读，读到就打开新建弹窗并消费（token 变化即触发，幂等）。
  const paletteIntent = useUiStore((s) => s.paletteIntent);
  const consumePaletteIntent = useUiStore((s) => s.consumePaletteIntent);
  useEffect(() => {
    if (paletteIntent?.kind !== "agent-create") return;
    setCreateStartAt("name");
    setCreateOpen(true);
    // 新建/编辑智能体是名册侧的动作：从「协作」走命令面板过来时切回任务，
    // 否则建完关掉弹窗，用户看到的还是协作设置，会以为没生效。
    setTab("work");
    consumePaletteIntent();
  }, [paletteIntent, consumePaletteIntent, setTab]);

  // 视图意图消费（d.67）：旧 setPage("tasks")、通知中心 focusTask 等落在本页时切到任务。
  // 读走即清，避免切走再回来仍被上一次跳转钉在任务 Tab。
  //
  // openConversation（通知/系统通知「打开某个会话」）会投 pageView="chat"：
  // 它必须把当前 Tab 切回任务并显示该会话，否则会话会在看不见的视图下打开。
  useEffect(() => {
    if (!pageView) return;
    const view: string | null = useUiStore.getState().consumePageView();
    if (view === "tasks" || view === "chat") setTab("work");
  }, [pageView, setTab]);

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

  /** 搜索：按名称/简介过滤（大小写不敏感、去空白）。 */
  const filteredAgents = useMemo(() => {
    const q = agentQuery.trim().toLowerCase();
    if (!q) return sortedAgents;
    return sortedAgents.filter(
      (a) =>
        a.name.toLowerCase().includes(q) ||
        (a.description ?? "").toLowerCase().includes(q),
    );
  }, [sortedAgents, agentQuery]);
  const systemAgents = filteredAgents.filter((a) => a.id === "system-assistant");
  const ownAgents = filteredAgents.filter((a) => a.id !== "system-assistant");
  /** 名册里同时有系统/自建时才打分组标题；只有一类时不加噪。 */
  const showGroupLabels = systemAgents.length > 0 && ownAgents.length > 0;
  const showSearch = agentsRoster.length >= 5;

  const convByAgent = useMemo(() => {
    const map = new Map<string, (typeof conversations)[number]>();
    for (const c of conversations) map.set(c.agent.id, c);
    return map;
  }, [conversations]);

  const activeConv = conversations.find((c) => c.id === activeConversationId);
  const systemAgent = sortedAgents.find((a) => a.id === "system-assistant");
  const activeAgentBound = useMemo(
    () => (activeConv ? Boolean(resolveBoundProfile(activeConv.agent.id)) : false),
    [activeConv, llmBindings, llmRoutes, llmProfiles],
  );

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

  /** 名册列表（同一段 JSX 在展开/折叠两态复用选中态与无障碍属性）。 */
  const renderAgentList = (dense: boolean) => {
    if (sortedAgents.length === 0) {
      if (dense) return null; // 折叠态只留底部「+」，不放整块空态
      return (
        <div className="ui-empty px-2 py-6">
          <p className="ui-empty-title">还没有自建智能体</p>
          <p className="ui-empty-desc">从模板开始最快：选个预设、改个名字就能用。</p>
          <div className="ui-empty-actions flex-col items-stretch">
            <button
              type="button"
              onClick={() => {
                setCreateStartAt("name");
                setCreateOpen(true);
              }}
              className="ui-btn ui-btn-sm ui-btn-primary w-full"
            >
              新建智能体
            </button>
            <button
              type="button"
              onClick={() => {
                setCreateStartAt("templates");
                setCreateOpen(true);
              }}
              className="ui-btn ui-btn-sm ui-btn-ghost w-full"
            >
              从模板创建
            </button>
          </div>
        </div>
      );
    }
    if (filteredAgents.length === 0) {
      return (
        <div className="ui-empty px-2 py-6">
          <p className="ui-empty-title">没有匹配的智能体</p>
          <p className="ui-empty-desc">换个名字试试，或清空关键词。</p>
          <button
            type="button"
            className="ui-btn ui-btn-sm ui-btn-ghost"
            onClick={() => setAgentQuery("")}
          >
            清空搜索
          </button>
        </div>
      );
    }
    // 分组 + 搜索：系统智能体在前（同一组内按名称），自建在后
    const groups = showGroupLabels
      ? [
          { key: "system", label: "系统智能体", agents: systemAgents },
          { key: "own", label: "自建智能体", agents: ownAgents },
        ]
      : [{ key: "all", label: "", agents: filteredAgents }];

    return groups
      .filter((g) => g.agents.length > 0)
      .map((group) => (
        <div key={group.key}>
          {group.label && !dense ? (
            <div className="px-2 pb-1 pt-2 ui-micro text-muted">{group.label}</div>
          ) : null}
          {group.agents.map((agent) => {
            const conv = convByAgent.get(agent.id);
            const active = conv && conv.id === activeConversationId;
            const busy = openingId === agent.id;

            if (dense) {
              return (
                <button
                  key={agent.id}
                  type="button"
                  title={agent.name}
                  aria-label={`与智能体 ${agent.name} 对话`}
                  aria-current={active ? "true" : undefined}
                  disabled={busy}
                  onClick={() => void startChat(agent)}
                  className={`mb-1 flex w-full justify-center rounded-lg p-1 transition-colors disabled:opacity-60 ${
                    active ? "bg-[var(--subtle-4)]" : "hover:bg-[var(--subtle-2)]"
                  }`}
                >
                  <Avatar
                    user={{ displayName: agent.name, avatar: agent.avatar ?? undefined }}
                    size={26}
                  />
                </button>
              );
            }

            return (
              <div key={agent.id} className="group relative mb-1">
                <button
                  type="button"
                  aria-label={`与智能体 ${agent.name} 对话`}
                  aria-current={active ? "true" : undefined}
                  disabled={busy}
                  onClick={() => void startChat(agent)}
                  className={`flex w-full items-center gap-2 rounded-lg px-2 py-1.5 text-left transition-colors disabled:opacity-60 ${
                    active ? "bg-[var(--subtle-4)]" : "hover:bg-[var(--subtle-2)]"
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
                            ? "和鸣内置智能体"
                            : agent.description || "暂无对话"}
                    </span>
                  </span>
                </button>
                {/* 编辑按钮常显（低对比，悬停/聚焦加深）：纯 hover 可见在触控板/键盘上等于没有 */}
                <button
                  type="button"
                  aria-label={`编辑智能体：${agent.name}`}
                  title="编辑智能体"
                  onClick={() => setEditing(agent)}
                  className="ui-micro absolute right-1.5 top-1/2 flex h-6 -translate-y-1/2 items-center rounded-sm px-1.5 text-muted opacity-60 hover:bg-[var(--subtle-3)] hover:text-ink hover:opacity-100 focus:opacity-100"
                >
                  编辑
                </button>
              </div>
            );
          })}
        </div>
      ));
  };

  return (
    <PageShell
      title="智能体"
      subtitle="和智能体对话、派任务；也可以让多个智能体分工协作完成同一件事。模型 Key、工具和记忆都留在本机。"
      scroll={false}
      headerExtra={
        <div
          className={`${PAGE_TABLIST} flex-wrap items-center gap-2 border-b border-line-soft px-6 pt-2`}
          role="tablist"
          aria-label="智能体视图"
        >
          {[
            { key: "work" as const, label: "任务" },
            { key: "collab" as const, label: "协作" },
          ].map((t) => (
            <button
              key={t.key}
              type="button"
              role="tab"
              aria-selected={tab === t.key}
              onClick={() => setTab(t.key)}
              className={pageTabClass(tab === t.key)}
            >
              {t.label}
            </button>
          ))}
        </div>
      }
    >
      {tab === "work" ? (
        <div className="flex min-h-0 flex-1">
          {railCollapsed ? (
            <aside className="flex w-[60px] shrink-0 flex-col border-r border-line-soft">
              <header className="flex items-center justify-center border-b border-line-soft py-2">
                <button
                  type="button"
                  aria-label="展开智能体名册"
                  title="展开名册"
                  onClick={() => setRailCollapsed(false)}
                  className="flex h-7 w-7 items-center justify-center rounded-md text-[#666] hover:bg-[var(--subtle-4)] hover:text-ink"
                >
                  ›
                </button>
              </header>
              <div className="min-h-0 flex-1 overflow-y-auto p-1.5">{renderAgentList(true)}</div>
              <button
                type="button"
                aria-label="新建智能体"
                title="新建智能体"
                onClick={() => {
                  setCreateStartAt("name");
                  setCreateOpen(true);
                }}
                className="mx-auto mb-2 flex h-7 w-7 items-center justify-center rounded-md text-[#666] hover:bg-[var(--subtle-4)] hover:text-ink"
              >
                <PlusIcon width={14} height={14} />
              </button>
            </aside>
          ) : (
            <aside className="flex w-[264px] shrink-0 flex-col border-r border-line-soft">
              <header className="flex items-center gap-2 border-b border-line-soft px-3 py-2.5">
                <AssistantIcon width={17} height={17} />
                {/* d.62：左栏列表表头用统一 section 档；徽标/数量用 micro 档 */}
                <span className="ui-section-title min-w-0 truncate">我的智能体</span>
                <span className="ui-micro rounded-sm border border-line px-1">本机</span>
                <span className="ui-micro">{sortedAgents.length}</span>
                <button
                  type="button"
                  aria-label="收起智能体名册"
                  title="收起名册"
                  onClick={() => setRailCollapsed(true)}
                  className="ml-auto flex h-[24px] w-[20px] items-center justify-center rounded-md text-[13px] text-[#666] hover:bg-[var(--subtle-4)] hover:text-ink"
                >
                  ‹
                </button>
                <button
                  type="button"
                  aria-label="新建智能体"
                  title="新建智能体"
                  onClick={() => {
                    setCreateStartAt("name");
                    setCreateOpen(true);
                  }}
                  className="flex h-[24px] items-center gap-1 rounded-md px-1.5 text-[12px] text-[#666] hover:bg-[var(--subtle-4)] hover:text-ink"
                >
                  <PlusIcon width={14} height={14} />
                  <span>新建</span>
                </button>
              </header>

              {showSearch ? (
                <div className="border-b border-line-soft px-2 py-1.5">
                  <input
                    aria-label="搜索智能体"
                    value={agentQuery}
                    onChange={(e) => setAgentQuery(e.target.value)}
                    placeholder="搜索智能体…"
                    className="w-full rounded-lg border border-line px-2 py-1 text-[12px] outline-hidden focus:border-ink"
                  />
                </div>
              ) : null}
              <div className="min-h-0 flex-1 overflow-y-auto p-1.5">{renderAgentList(false)}</div>

              {error && (
                <p className="border-t border-line-soft px-3 py-2 text-[11px] text-[#b42318]">
                  {error}
                </p>
              )}
              <p className="ui-caption border-t border-line-soft px-3 py-2 leading-4">
                智能体在本机运行：模型 Key、工具与记忆不出设备；消息不进团队动向。
              </p>
            </aside>
          )}

          <section className="flex min-w-0 flex-1 flex-col">
            {activeConv ? (
              <>
                {/* 任务视图顶部状态条：当前智能体 / 会话状态 / 模型绑定。
                    ChatPage 自己的标题栏负责会话内操作，这里只补全局上下文。 */}
                <div className="flex h-8 shrink-0 items-center gap-2 border-b border-line-soft px-4 ui-caption">
                  <span className="ui-body-sm font-medium">任务</span>
                  <span aria-hidden>·</span>
                  <span className="min-w-0 truncate">与 {activeConv.agent.name} 的会话</span>
                  <span
                    className={`ui-chip ${activeAgentBound ? "" : "text-[var(--danger)]"}`}
                    title={
                      activeAgentBound
                        ? "该智能体已绑定模型"
                        : "该智能体还没有绑定模型，发送会失败"
                    }
                  >
                    {activeAgentBound ? "模型已绑定" : "未绑定模型"}
                  </span>
                  <span className="ml-auto hidden sm:inline">本机运行 · 不进团队动向</span>
                </div>
                <div className="flex min-h-0 flex-1 flex-col">
                  <ChatPage />
                </div>
              </>
            ) : (
              <div className="flex h-full flex-col items-center justify-center gap-3 px-6 text-center">
                <span className="flex h-16 w-16 items-center justify-center rounded-2xl border border-line-soft bg-[#fafafa] text-[#98a2b3]">
                  <AssistantIcon width={30} height={30} />
                </span>
                <div className="ui-section-title">选择一个智能体开始</div>
                <p className="ui-body-sm max-w-[520px] leading-6">
                  {"从左边选一个智能体就能直接对话；没有合适的，点左栏右上角「新建」创建一个。"}
                </p>
                <div className="flex flex-wrap items-center justify-center gap-2">
                  {systemAgent && (
                    <button
                      type="button"
                      onClick={() => void startChat(systemAgent)}
                      className="ui-btn ui-btn-md ui-btn-primary"
                    >
                      和小鸣聊聊
                    </button>
                  )}
                  <button
                    type="button"
                    onClick={() => {
                      setCreateStartAt("name");
                      setCreateOpen(true);
                    }}
                    className="ui-btn ui-btn-md ui-btn-ghost"
                  >
                    新建一个智能体
                  </button>
                </div>
              </div>
            )}
          </section>
        </div>
      ) : (
        <CollabView
          agents={sortedAgents}
          onCreateAgent={() => {
            setCreateStartAt("name");
            setCreateOpen(true);
          }}
        />
      )}

      <AgentFormModal
        open={createOpen}
        mode="create"
        startAt={createStartAt}
        onCreated={(created) => {
          // 创建成功直接开聊：复用既有 openAgent + openConversation，不新增页面/路由。
          // 失败只落到本页的错误条，不阻塞弹窗关闭。
          setTab("work");
          void startChat(created);
        }}
        onClose={() => setCreateOpen(false)}
      />
      <AgentFormModal
        open={!!editing}
        mode="edit"
        {...(editing ? { agent: editing } : {})}
        onClose={() => setEditing(null)}
      />
    </PageShell>
  );
}
