import { useCallback, useEffect, useMemo, useState } from "react";
import { useSessionTab } from "../lib/sessionState.js";
import type { Agent } from "@heming/shared";
import { useChatStore } from "../store/chat.js";
import { useUiStore } from "../store/ui.js";
import { useLlmStore } from "../store/llm.js";
import { resolveBoundProfile } from "../lib/llmRoute.js";
import { formatClock, formatDayClock } from "../lib/formatTime.js";
import { getDraft, hasDraft, subscribeDrafts } from "../lib/drafts.js";
import { ChatPage } from "./ChatPage.js";
import { AgentFormModal } from "./AgentFormModal.js";
import { Avatar } from "./Avatar.js";
import { CollabView } from "./collaboration/CollabView.js";
import { AssistantIcon, PlusIcon, SearchIcon } from "./icons.js";
import { PageShell } from "./layout/PageShell.js";
import { PAGE_TABLIST, pageTabClass } from "../lib/ui/tabStyles.js";

/**
 * 智能体页（d.67 导航合并；本轮把「名册」和「对话」的主次调换）：
 *
 * - **左栏是对话**：每段与智能体的会话一行（按最近活跃排序），点一行就进那段对话。
 *   以前左栏列的是智能体名册，看起来像「先选人再开聊」，对话一多就找不到入口。
 * - **页面里选智能体**：没有选中对话时，主区就是智能体选择页（系统/自建分组、
 *   模型绑定状态、新建与模板入口）；对话进行中也可以通过顶部「切换智能体」回到这里。
 * - **协作**：Multi-Agent 多人工作台（components/collaboration/CollabView）。
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

/** 对话列表的排序键：最近活跃在前，没有消息的排最后。 */
function lastActivityOf(conv: { lastMessageAt?: string | null }): number {
  const at = conv.lastMessageAt ? Date.parse(conv.lastMessageAt) : NaN;
  return Number.isFinite(at) ? at : 0;
}

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

  // 绑定状态只用于「模型已绑定」提示与选择页的可用性标记。
  const llmBindings = useLlmStore((s) => s.bindings);
  const llmRoutes = useLlmStore((s) => s.routes);
  const llmProfiles = useLlmStore((s) => s.profiles);

  const [openingId, setOpeningId] = useState<string | null>(null);
  const [error, setError] = useState("");
  const [createOpen, setCreateOpen] = useState(false);
  /** 新建弹窗打开时焦点落点：名称 / 第一个模板。 */
  const [createStartAt, setCreateStartAt] = useState<"name" | "templates">("name");
  const [editing, setEditing] = useState<Agent | null>(null);
  /**
   * 默认落在「对话」。key 沿用 v1 以保留会话记忆；旧值 chat/tasks 在读取时
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
  /** 左栏对话搜索。 */
  const [convQuery, setConvQuery] = useState("");
  /** 选择页的智能体搜索（≥5 个才显示，不给一两条数据配搜索框）。 */
  const [agentQuery, setAgentQuery] = useState("");
  /** 左栏可折叠：把横向空间让给对话。 */
  const [railCollapsed, setRailCollapsed] = useState(false);
  /** 草稿变更时重渲染左栏预览（草稿是本机数据，不参与排序）。 */
  const [, setDraftsTick] = useState(0);
  useEffect(() => subscribeDrafts(() => setDraftsTick((n) => n + 1)), []);

  // 命令面板「新建智能体」的消费点（d.60）。
  // 面板只投一次内存意图并切到本页；本页是懒加载路由，可能晚一帧才挂载，
  // 所以在「挂载后 effect」里读，读到就打开新建弹窗并消费（token 变化即触发，幂等）。
  const paletteIntent = useUiStore((s) => s.paletteIntent);
  const consumePaletteIntent = useUiStore((s) => s.consumePaletteIntent);
  useEffect(() => {
    if (paletteIntent?.kind !== "agent-create") return;
    setCreateStartAt("name");
    setCreateOpen(true);
    // 新建/编辑智能体是选择页的动作：从「协作」走命令面板过来时切回对话，
    // 否则建完关掉弹窗，用户看到的还是协作设置，会以为没生效。
    setTab("work");
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
    if (view === "tasks" || view === "chat") setTab("work");
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

  const sortedConversations = useMemo(() => {
    return [...conversations].sort((a, b) => lastActivityOf(b) - lastActivityOf(a));
  }, [conversations]);

  const filteredConversations = useMemo(() => {
    const q = convQuery.trim().toLowerCase();
    if (!q) return sortedConversations;
    return sortedConversations.filter((c) => {
      const name = c.agent.name.toLowerCase();
      const desc = (c.agent.description ?? "").toLowerCase();
      return name.includes(q) || desc.includes(q);
    });
  }, [sortedConversations, convQuery]);

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
  /** 选择页同时有系统/自建时才打分组标题；只有一类时不加噪。 */
  const showGroupLabels = systemAgents.length > 0 && ownAgents.length > 0;
  const showAgentSearch = agentsRoster.length >= 5;
  const showConvSearch = conversations.length >= 5;

  const activeConv = conversations.find((c) => c.id === activeConversationId);
  const activeAgentBound = useMemo(
    () => (activeConv ? Boolean(resolveBoundProfile(activeConv.agent.id)) : false),
    [activeConv, llmBindings, llmRoutes, llmProfiles],
  );

  const boundOf = useCallback(
    (agentId: string) => Boolean(resolveBoundProfile(agentId)),
    [llmBindings, llmRoutes, llmProfiles],
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

  /** 回到选择页：清空当前会话，主区显示智能体列表（对话仍在左栏，随时可点回来）。 */
  const backToPicker = () => {
    setAgentQuery("");
    useUiStore.setState({ activeConversationId: null });
  };

  /** 对话行预览：草稿 > 最近活跃 > 智能体简介。只读本机，不拉消息正文。 */
  const convPreview = (conv: (typeof conversations)[number]) => {
    if (hasDraft(conv.id)) {
      const draft = getDraft(conv.id).replace(/\s+/g, " ").trim();
      return draft ? `草稿：${draft.length > 26 ? `${draft.slice(0, 26)}…` : draft}` : "有草稿";
    }
    if (conv.lastMessageAt) return `最近有对话 · ${formatDayClock(conv.lastMessageAt)}`;
    return conv.agent.description || "还没有消息";
  };

  const openCreate = (startAt: "name" | "templates") => {
    setCreateStartAt(startAt);
    setCreateOpen(true);
  };

  /** 左栏对话列表（展开/折叠两态复用选中态与无障碍属性）。 */
  const renderConversationList = (dense: boolean) => {
    if (sortedConversations.length === 0) {
      if (dense) return null;
      return (
        <div className="ui-empty px-2 py-6">
          <p className="ui-empty-title">还没有对话</p>
          <p className="ui-empty-desc">在右侧选一个智能体，开始第一段对话。</p>
          <button
            type="button"
            onClick={backToPicker}
            className="ui-btn ui-btn-sm ui-btn-primary mt-2 w-full"
          >
            选择智能体
          </button>
        </div>
      );
    }
    if (filteredConversations.length === 0) {
      return (
        <div className="ui-empty px-2 py-6">
          <p className="ui-empty-title">没有匹配的对话</p>
          <p className="ui-empty-desc">换个关键词试试，或清空搜索。</p>
          <button
            type="button"
            className="ui-btn ui-btn-sm ui-btn-ghost"
            onClick={() => setConvQuery("")}
          >
            清空搜索
          </button>
        </div>
      );
    }
    return filteredConversations.map((conv) => {
      const active = conv.id === activeConversationId;
      if (dense) {
        return (
          <button
            key={conv.id}
            type="button"
            title={conv.agent.name}
            aria-label={`打开与 ${conv.agent.name} 的对话`}
            aria-current={active ? "true" : undefined}
            onClick={() => openingConversation(conv.id)}
            className={`mb-1 flex w-full justify-center rounded-lg p-1 transition-colors ${
              active ? "bg-[var(--subtle-4)]" : "hover:bg-[var(--subtle-2)]"
            }`}
          >
            <Avatar
              user={{ displayName: conv.agent.name, avatar: conv.agent.avatar ?? undefined }}
              size={26}
            />
          </button>
        );
      }
      return (
        <button
          key={conv.id}
          type="button"
          aria-label={`打开与 ${conv.agent.name} 的对话`}
          aria-current={active ? "true" : undefined}
          onClick={() => openingConversation(conv.id)}
          className={`mb-1 flex w-full items-start gap-2 rounded-lg px-2 py-1.5 text-left transition-colors ${
            active ? "bg-[var(--subtle-4)]" : "hover:bg-[var(--subtle-2)]"
          }`}
        >
          <Avatar
            user={{ displayName: conv.agent.name, avatar: conv.agent.avatar ?? undefined }}
            size={26}
          />
          <span className="min-w-0 flex-1">
            <span className="flex items-center gap-1.5">
              <span className="ui-body-sm min-w-0 flex-1 truncate font-medium">
                {conv.agent.name}
              </span>
              {conv.lastMessageAt ? (
                <span className="ui-micro shrink-0 text-muted">
                  {formatClock(conv.lastMessageAt)}
                </span>
              ) : null}
            </span>
            <span className="ui-caption mt-0.5 block truncate">{convPreview(conv)}</span>
          </span>
        </button>
      );
    });
  };

  /** 智能体选择页（主区）：分组卡片 + 搜索 + 新建入口。 */
  const renderAgentPicker = () => {
    const groups = showGroupLabels
      ? [
          { key: "system", label: "系统智能体", agents: systemAgents },
          { key: "own", label: "自建智能体", agents: ownAgents },
        ]
      : [{ key: "all", label: "", agents: filteredAgents }];

    return (
      <div className="min-h-0 flex-1 overflow-y-auto">
        <div className="mx-auto w-full max-w-[960px] px-6 py-5 max-[1199px]:px-4">
          <div className="flex flex-wrap items-start justify-between gap-3">
            <div className="min-w-0">
              <h2 className="ui-section-title">选择智能体</h2>
              <p className="ui-body-sm mt-1">
                选一个智能体开始对话；已有的对话都在左边，随时可以点回去。
              </p>
            </div>
            <div className="flex flex-wrap items-center gap-2">
              <button
                type="button"
                onClick={() => openCreate("templates")}
                className="ui-btn ui-btn-md ui-btn-ghost"
              >
                从模板创建
              </button>
              <button
                type="button"
                onClick={() => openCreate("name")}
                className="ui-btn ui-btn-md ui-btn-primary"
              >
                <PlusIcon width={14} height={14} />
                新建智能体
              </button>
            </div>
          </div>

          {showAgentSearch ? (
            <div className="relative mt-4">
              <SearchIcon
                width={14}
                height={14}
                className="pointer-events-none absolute left-2.5 top-1/2 -translate-y-1/2 text-muted"
              />
              <input
                aria-label="搜索智能体"
                value={agentQuery}
                onChange={(e) => setAgentQuery(e.target.value)}
                placeholder="搜索智能体…"
                className="ui-input w-full pl-8"
              />
            </div>
          ) : null}

          {sortedAgents.length === 0 ? (
            <div className="ui-empty mt-8">
              <p className="ui-empty-title">还没有智能体</p>
              <p className="ui-empty-desc">从模板开始最快：选个预设、改个名字就能用。</p>
              <div className="ui-empty-actions">
                <button
                  type="button"
                  onClick={() => openCreate("name")}
                  className="ui-btn ui-btn-md ui-btn-primary"
                >
                  新建智能体
                </button>
                <button
                  type="button"
                  onClick={() => openCreate("templates")}
                  className="ui-btn ui-btn-md ui-btn-ghost"
                >
                  从模板创建
                </button>
              </div>
            </div>
          ) : filteredAgents.length === 0 ? (
            <div className="ui-empty mt-8">
              <p className="ui-empty-title">没有匹配的智能体</p>
              <p className="ui-empty-desc">换个名字试试，或清空关键词。</p>
              <button
                type="button"
                className="ui-btn ui-btn-md ui-btn-ghost"
                onClick={() => setAgentQuery("")}
              >
                清空搜索
              </button>
            </div>
          ) : (
            groups
              .filter((g) => g.agents.length > 0)
              .map((group) => (
                <section key={group.key} className="mt-5">
                  {group.label ? (
                    <h3 className="ui-micro mb-2 text-muted">{group.label}</h3>
                  ) : null}
                  <div className="grid gap-3 [grid-template-columns:repeat(auto-fill,minmax(260px,1fr))]">
                    {group.agents.map((agent) => {
                      const busy = openingId === agent.id;
                      const bound = boundOf(agent.id);
                      return (
                        <div
                          key={agent.id}
                          className="group relative flex min-w-0 flex-col rounded-xl border border-line-soft bg-white p-3 transition-colors hover:border-line"
                        >
                          <button
                            type="button"
                            aria-label={`与智能体 ${agent.name} 对话`}
                            disabled={busy}
                            onClick={() => void startChat(agent)}
                            className="flex min-w-0 items-start gap-2.5 text-left disabled:opacity-60"
                          >
                            <Avatar
                              user={{
                                displayName: agent.name,
                                avatar: agent.avatar ?? undefined,
                              }}
                              size={32}
                            />
                            <span className="min-w-0 flex-1">
                              <span className="ui-body-sm block truncate font-medium">
                                {agent.name}
                              </span>
                              <span className="ui-caption mt-0.5 line-clamp-2 block min-h-[34px] leading-[17px]">
                                {busy
                                  ? "正在打开…"
                                  : agent.description ||
                                    (agent.id === "system-assistant"
                                      ? "和鸣内置智能体"
                                      : "还没有简介")}
                              </span>
                            </span>
                          </button>
                          <div className="mt-2 flex items-center gap-2">
                            <span
                              className={`ui-chip ${bound ? "" : "text-[var(--danger)]"}`}
                              title={
                                bound
                                  ? "该智能体已绑定模型"
                                  : "该智能体还没有绑定模型，发送会失败"
                              }
                            >
                              {bound ? "模型已绑定" : "未绑定模型"}
                            </span>
                            <span className="ml-auto flex items-center gap-1">
                              <button
                                type="button"
                                aria-label={`编辑智能体：${agent.name}`}
                                title="编辑智能体"
                                onClick={() => setEditing(agent)}
                                className="ui-micro rounded-sm px-1.5 py-0.5 text-muted opacity-70 hover:bg-[var(--subtle-3)] hover:text-ink hover:opacity-100 focus:opacity-100"
                              >
                                编辑
                              </button>
                              <button
                                type="button"
                                aria-label={`与智能体 ${agent.name} 开始对话`}
                                disabled={busy}
                                onClick={() => void startChat(agent)}
                                className="ui-btn ui-btn-sm ui-btn-ghost"
                              >
                                {busy ? "打开中…" : "开始对话"}
                              </button>
                            </span>
                          </div>
                        </div>
                      );
                    })}
                  </div>
                </section>
              ))
          )}
        </div>
      </div>
    );
  };

  return (
    <PageShell
      title="智能体"
      subtitle="左边是对话，页面里选智能体开聊；也可以让多个智能体分工协作完成同一件事。模型 Key、工具和记忆都留在本机。"
      scroll={false}
      headerExtra={
        <div
          className={`${PAGE_TABLIST} flex-wrap items-center gap-2 border-b border-line-soft px-6 pt-2`}
          role="tablist"
          aria-label="智能体视图"
        >
          {[
            { key: "work" as const, label: "对话" },
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
                  aria-label="展开对话列表"
                  title="展开对话列表"
                  onClick={() => setRailCollapsed(false)}
                  className="flex h-7 w-7 items-center justify-center rounded-md text-[#666] hover:bg-[var(--subtle-4)] hover:text-ink"
                >
                  ›
                </button>
              </header>
              <div className="min-h-0 flex-1 overflow-y-auto p-1.5">
                {renderConversationList(true)}
              </div>
              <button
                type="button"
                aria-label="新建对话"
                title="新建对话"
                onClick={backToPicker}
                className="mx-auto mb-2 flex h-7 w-7 items-center justify-center rounded-md text-[#666] hover:bg-[var(--subtle-4)] hover:text-ink"
              >
                <PlusIcon width={14} height={14} />
              </button>
            </aside>
          ) : (
            <aside className="flex w-[264px] shrink-0 flex-col border-r border-line-soft">
              <header className="flex items-center gap-2 border-b border-line-soft px-3 py-2.5">
                <AssistantIcon width={17} height={17} />
                <span className="ui-section-title min-w-0 truncate">我的对话</span>
                <span className="ui-micro rounded-sm border border-line px-1">本机</span>
                <span className="ui-micro">{sortedConversations.length}</span>
                <button
                  type="button"
                  aria-label="收起对话列表"
                  title="收起对话列表"
                  onClick={() => setRailCollapsed(true)}
                  className="ml-auto flex h-[24px] w-[20px] items-center justify-center rounded-md text-[13px] text-[#666] hover:bg-[var(--subtle-4)] hover:text-ink"
                >
                  ‹
                </button>
                <button
                  type="button"
                  aria-label="新建对话"
                  title="新建对话"
                  onClick={backToPicker}
                  className="flex h-[24px] items-center gap-1 rounded-md px-1.5 text-[12px] text-[#666] hover:bg-[var(--subtle-4)] hover:text-ink"
                >
                  <PlusIcon width={14} height={14} />
                  <span>新建</span>
                </button>
              </header>

              {showConvSearch ? (
                <div className="border-b border-line-soft px-2 py-1.5">
                  <input
                    aria-label="搜索对话"
                    value={convQuery}
                    onChange={(e) => setConvQuery(e.target.value)}
                    placeholder="搜索对话…"
                    className="w-full rounded-lg border border-line px-2 py-1 text-[12px] outline-hidden focus:border-ink"
                  />
                </div>
              ) : null}
              <div className="min-h-0 flex-1 overflow-y-auto p-1.5">
                {renderConversationList(false)}
              </div>

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
                {/* 对话顶部状态条：当前智能体 / 模型绑定 / 回到选择页。
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
                        const agent = agentsRoster.find((a) => a.id === activeConv.agent.id);
                        if (agent) setEditing(agent);
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
                  <ChatPage />
                </div>
              </>
            ) : (
              renderAgentPicker()
            )}
          </section>
        </div>
      ) : (
        <CollabView
          agents={sortedAgents}
          onCreateAgent={() => openCreate("name")}
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
