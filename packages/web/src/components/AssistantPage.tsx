import { useCallback, useEffect, useMemo, useState } from "react";
import type { Agent } from "@heming/shared";
import { useSessionTab } from "../lib/sessionState.js";
import { useChatStore } from "../store/chat.js";
import { useUiStore } from "../store/ui.js";
import { useLlmStore } from "../store/llm.js";
import { resolveBoundProfile } from "../lib/llmRoute.js";
import { ChatPage } from "./ChatPage.js";
import { CollabView } from "./collaboration/CollabView.js";
import { PageShell } from "./layout/PageShell.js";
import { PAGE_TABLIST, pageTabClass } from "../lib/ui/tabStyles.js";
import { ConversationRail } from "./assistant/ConversationRail.js";
import { AgentPicker } from "./assistant/AgentPicker.js";
import { AgentRosterView } from "./assistant/AgentRosterView.js";
import { AgentEditorView } from "./assistant/AgentEditorView.js";
import {
  ASSISTANT_STORED_TABS,
  ASSISTANT_TAB_ITEMS,
  ASSISTANT_TAB_KEY,
  isLegacyAssistantTab,
  normalizeAssistantTab,
  type AssistantTab,
  type StoredAssistantTab,
} from "./assistant/tabs.js";

/**
 * 智能体页（d.126 阶段 B：三个一级 Tab）。
 *
 * - **对话**：左栏是 Claude Code 风格会话栏（顶部新建/搜索，按智能体分组，
 *   组内一级信息是**会话名**，当前会话高亮）；主区在选中会话时嵌 `ChatPage`
 *   （embedded，隐藏它自己的「返回工作区」），没有选中时是智能体选择页。
 * - **协作**：Multi-Agent 多人工作台（`CollabView` 原样收进）。
 * - **智能体**：名册（系统/自建分组、模型绑定状态、搜索）；新建/编辑进入
 *   **页内编辑视图**（`AgentEditorView`，不再弹窗），保存/取消后回名册。
 *
 * 三个视图**同一时刻只渲染一个**：切走的分支直接卸载，不会出现两处同时订阅同一条流。
 * 会话与名册数据全部来自既有 store（`useChatStore` / `useUiStore` / `useLlmStore`），
 * 本页不新增第二套状态。
 *
 * 旧 sessionStorage 值 `work` / `chat` / `tasks` 统一归一为「对话」（不丢会话记忆）；
 * `pageView` 意图（tasks / chat）也都落到「对话」。
 */

/** 智能体 Tab 的两种页面态：名册 / 编辑页（新建或编辑）。 */
type AgentEditorState =
  | { mode: "create"; startAt: "name" | "templates" }
  | { mode: "edit"; agent: Agent };

export function AssistantPage() {
  const conversations = useChatStore((s) => s.conversations);
  const messages = useChatStore((s) => s.messages);
  const agentsRoster = useChatStore((s) => s.agentsRoster);
  const loadWorkspace = useChatStore((s) => s.loadWorkspace);
  const loadAgentsRoster = useChatStore((s) => s.loadAgentsRoster);
  const openAgent = useChatStore((s) => s.openAgent);
  const activeConversationId = useUiStore((s) => s.activeConversationId);
  const openingConversation = useUiStore((s) => s.openConversation);
  /** 一次性视图意图（d.67）：旧「通用智能体」链接折叠成 chat + pageView="tasks"。 */
  const pageView = useUiStore((s) => s.pageView);

  // 绑定状态只用于「模型已绑定」提示与名册/选择页的可用性标记。
  const llmBindings = useLlmStore((s) => s.bindings);
  const llmRoutes = useLlmStore((s) => s.routes);
  const llmProfiles = useLlmStore((s) => s.profiles);

  const [openingId, setOpeningId] = useState<string | null>(null);
  const [error, setError] = useState("");
  /** 智能体 Tab 的页面态：null = 名册；有值 = 编辑页（新建/编辑）。 */
  const [editor, setEditor] = useState<AgentEditorState | null>(null);

  /**
   * 默认落在「对话」。key 沿用 v1 以保留会话记忆；旧值 `work` / `chat` / `tasks`
   * 在读取时归一为 `chat`（见 assistant/tabs.ts），绝不落到空白视图。
   */
  const [storedTab, setStoredTab] = useSessionTab<StoredAssistantTab>(
    ASSISTANT_TAB_KEY,
    "chat",
    ASSISTANT_STORED_TABS,
  );
  const tab: AssistantTab = normalizeAssistantTab(storedTab);
  const setTab = useCallback(
    (next: AssistantTab) => {
      setStoredTab(next);
    },
    [setStoredTab],
  );
  // 读到旧键就顺手回写规范化值：之后刷新不再走归一分支（记忆保留，枚举干净）。
  useEffect(() => {
    if (isLegacyAssistantTab(storedTab)) setStoredTab(normalizeAssistantTab(storedTab));
  }, [storedTab, setStoredTab]);

  // 命令面板「新建智能体」的消费点（d.60）。
  // 面板只投一次内存意图并切到本页；本页是懒加载路由，可能晚一帧才挂载，
  // 所以在「挂载后 effect」里读，读到就打开编辑页并消费（token 变化即触发，幂等）。
  const paletteIntent = useUiStore((s) => s.paletteIntent);
  const consumePaletteIntent = useUiStore((s) => s.consumePaletteIntent);
  useEffect(() => {
    if (paletteIntent?.kind !== "agent-create") return;
    // 新建/编辑是「智能体」Tab 的动作：从任何 Tab 走命令面板过来都切过去，
    // 否则建完回到「协作」，用户会以为没生效。
    setTab("agents");
    setEditor({ mode: "create", startAt: "name" });
    consumePaletteIntent();
  }, [paletteIntent, consumePaletteIntent, setTab]);

  // 视图意图消费（d.67）：旧 setPage("tasks")、通知中心 focusTask 等落在本页时切到对话。
  // 读走即清，避免切走再回来仍被上一次跳转钉在某个 Tab。
  //
  // openConversation（通知/系统通知「打开某个会话」）会投 pageView="chat"：
  // 它必须把当前 Tab 切回对话并显示该会话，否则会话会在看不见的视图下打开。
  useEffect(() => {
    if (!pageView) return;
    const view: string | null = useUiStore.getState().consumePageView();
    if (view === "tasks" || view === "chat") setTab("chat");
  }, [pageView, setTab]);

  // 对话与名册都从服务端取：智能体页是独立入口，不依赖用户先去别的页。
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

  const activeConv = conversations.find((c) => c.id === activeConversationId);
  const activeAgentBound = useMemo(
    () => (activeConv ? Boolean(resolveBoundProfile(activeConv.agent.id)) : false),
    // llm* 一并进 deps：绑定变化后「模型已绑定」提示要跟着变（与 boundOf 同口径）
    [activeConv, llmBindings, llmRoutes, llmProfiles],
  );

  const boundOf = useCallback(
    (agentId: string) => Boolean(resolveBoundProfile(agentId)),
    [llmBindings, llmRoutes, llmProfiles],
  );

  /** 打开/复用与某智能体的会话；成功后切回「对话」Tab（从名册过来也能直接进对话）。 */
  const startChat = async (agentId: string) => {
    if (openingId) return;
    setOpeningId(agentId);
    setError("");
    try {
      // 服务端幂等：已有会话直接复用，不重复建
      const convId = await openAgent(agentId);
      openingConversation(convId);
      setTab("chat");
    } catch (err) {
      setError(err instanceof Error && err.message ? err.message : "打开会话失败");
    } finally {
      setOpeningId(null);
    }
  };

  /** 回到选择页：清空当前会话，主区显示智能体列表（对话仍在左栏，随时可点回来）。 */
  const backToPicker = () => {
    useUiStore.setState({ activeConversationId: null });
  };

  /** 打开智能体编辑页（智能体 Tab）。 */
  const openAgentEditor = (agent: Agent) => {
    setTab("agents");
    setEditor({ mode: "edit", agent });
  };
  /** 新建智能体：从选择页/名册/协作/命令面板都能进同一个编辑页。 */
  const openAgentCreate = (startAt: "name" | "templates") => {
    setTab("agents");
    setEditor({ mode: "create", startAt });
  };
  const closeAgentEditor = () => setEditor(null);

  /** 创建成功：直接切回对话并打开那段会话（复用 openAgent + openConversation，不新增路由）。 */
  const onAgentCreated = (created: Agent) => {
    setEditor(null);
    setTab("chat");
    void startChat(created.id);
  };

  /** Tab 键盘导航：左右方向键切换、Home/End 到两端（tablist 的标准键盘语义）。 */
  const onTabKeyDown = (e: React.KeyboardEvent<HTMLButtonElement>, index: number) => {
    const count = ASSISTANT_TAB_ITEMS.length;
    let next = index;
    if (e.key === "ArrowRight") next = (index + 1) % count;
    else if (e.key === "ArrowLeft") next = (index - 1 + count) % count;
    else if (e.key === "Home") next = 0;
    else if (e.key === "End") next = count - 1;
    else return;
    e.preventDefault();
    const key = ASSISTANT_TAB_ITEMS[next].key;
    setTab(key);
    document.getElementById(`assistant-tab-${key}`)?.focus();
  };

  const renderChatTab = () => (
    <div className="flex min-h-0 flex-1">
      <ConversationRail
        conversations={conversations}
        activeConversationId={activeConversationId}
        messages={messages}
        openingId={openingId}
        error={error}
        onOpen={openingConversation}
        onNewConversation={backToPicker}
        onNewForAgent={(agentId) => void startChat(agentId)}
      />

      <section className="flex min-w-0 flex-1 flex-col">
        {activeConv ? (
          <>
            {/* 对话顶部状态条：当前智能体 / 模型绑定 / 编辑与切换。
                ChatPage 自己的标题栏负责会话内操作，这里只补全局上下文。 */}
            <div className="flex h-8 shrink-0 items-center gap-2 border-b border-line-soft px-4 ui-caption">
              <span className="ui-body-sm font-medium">对话</span>
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
              <span className="ml-auto flex items-center gap-1">
                <button
                  type="button"
                  onClick={() => {
                    const agent =
                      agentsRoster.find((a) => a.id === activeConv.agent.id) ?? activeConv.agent;
                    openAgentEditor(agent);
                  }}
                  className="rounded-sm px-1.5 py-0.5 text-[11px] text-muted hover:bg-[var(--subtle-3)] hover:text-ink"
                >
                  编辑智能体
                </button>
                <button
                  type="button"
                  onClick={backToPicker}
                  className="rounded-sm px-1.5 py-0.5 text-[11px] text-muted hover:bg-[var(--subtle-3)] hover:text-ink"
                >
                  切换智能体
                </button>
              </span>
              <span className="hidden sm:inline">本机运行 · 不进团队动向</span>
            </div>
            <div className="flex min-h-0 flex-1 flex-col">
              {/* embedded：隐藏 ChatPage 自己的「返回工作区」按钮（返回会切页并卸载会话）。 */}
              <ChatPage embedded />
            </div>
          </>
        ) : (
          <AgentPicker
            agents={sortedAgents}
            boundOf={boundOf}
            openingId={openingId}
            onStartChat={(agentId) => void startChat(agentId)}
            onEdit={openAgentEditor}
            onCreate={openAgentCreate}
          />
        )}
      </section>
    </div>
  );

  const renderAgentsTab = () =>
    editor ? (
      <AgentEditorView
        key={`${editor.mode}-${editor.mode === "edit" ? editor.agent.id : editor.startAt}`}
        mode={editor.mode}
        {...(editor.mode === "edit" ? { agent: editor.agent } : { startAt: editor.startAt })}
        onCreated={onAgentCreated}
        onClose={closeAgentEditor}
      />
    ) : (
      <AgentRosterView
        agents={sortedAgents}
        boundOf={boundOf}
        openingId={openingId}
        error={error}
        onStartChat={(agentId) => void startChat(agentId)}
        onEdit={openAgentEditor}
        onCreate={openAgentCreate}
      />
    );

  return (
    <PageShell
      title="智能体"
      subtitle="左边是按智能体分组的对话；也可以让多个智能体分工协作，或在名册里管理智能体。模型 Key、工具和记忆都留在本机。"
      scroll={false}
      headerExtra={
        <div
          className={`${PAGE_TABLIST} flex-wrap items-center gap-2 border-b border-line-soft px-6 pt-2`}
          role="tablist"
          aria-label="智能体视图"
        >
          {ASSISTANT_TAB_ITEMS.map((t, index) => (
            <button
              key={t.key}
              id={`assistant-tab-${t.key}`}
              type="button"
              role="tab"
              aria-selected={tab === t.key}
              aria-controls={`assistant-panel-${t.key}`}
              tabIndex={tab === t.key ? 0 : -1}
              onClick={() => setTab(t.key)}
              onKeyDown={(e) => onTabKeyDown(e, index)}
              className={pageTabClass(tab === t.key)}
            >
              {t.label}
            </button>
          ))}
        </div>
      }
    >
      <div
        id={`assistant-panel-${tab}`}
        role="tabpanel"
        aria-labelledby={`assistant-tab-${tab}`}
        className="flex min-h-0 flex-1 flex-col"
      >
        {tab === "chat" ? (
          renderChatTab()
        ) : tab === "collab" ? (
          <CollabView agents={sortedAgents} onCreateAgent={() => openAgentCreate("name")} />
        ) : (
          renderAgentsTab()
        )}
      </div>
    </PageShell>
  );
}
