import { useEffect, useMemo, useRef, useState } from "react";
import type { Conversation, Message } from "@heming/shared";
import { Avatar } from "../Avatar.js";
import { PlusIcon, SearchIcon } from "../icons.js";
import { formatClock } from "../../lib/formatTime.js";
import { hasDraft, subscribeDrafts } from "../../lib/drafts.js";
import { conversationTitle } from "./conversationTitle.js";

/**
 * 对话左栏（d.126 阶段 B）：Claude Code 风格会话栏。
 *
 * 结构（对齐参考图）：
 * - 顶部动作行：「新建对话」+「搜索」；
 * - 会话按**智能体分组**（组标题 = 智能体名，组右侧 `＋` 直接开该智能体的新对话）；
 * - 组内按最近活跃排序，**一级信息是会话名**（不是智能体名——名字在组标题上）；
 * - 当前会话高亮（`aria-current`），有草稿的会话带「草稿」标识；
 * - 可折叠成头像窄栏，把横向空间让给对话；整个列表保持 Tab 可达。
 *
 * 会话名由 `conversationTitle` 从已加载消息推导（服务端没有 title 字段，
 * 也不在本轮扩 store），未加载消息的会话回落为最后活跃时间。
 */

export interface ConversationRailProps {
  /** 全量会话（组件内会重新按最近活跃排序，不依赖调用方顺序）。 */
  conversations: Conversation[];
  activeConversationId: string | null;
  /** 已加载消息（store.messages）：用于推导会话名前缀。 */
  messages: Record<string, Message[]>;
  /** 正在打开的智能体 id（新建会话按钮的 busy 态）。 */
  openingId?: string | null;
  /** 打开会话失败的原因（显示在栏底，不挡列表）。 */
  error?: string;
  onOpen: (conversationId: string) => void;
  /** 顶部「新建对话」：回到主区的智能体选择页（由用户挑智能体）。 */
  onNewConversation: () => void;
  /** 组右侧 `＋`：直接打开/新建与该智能体的会话。 */
  onNewForAgent: (agentId: string) => void;
}

/** 最近活跃排序键：没有消息的排最后。 */
function lastActivityOf(conv: Pick<Conversation, "lastMessageAt">): number {
  const at = conv.lastMessageAt ? Date.parse(conv.lastMessageAt) : NaN;
  return Number.isFinite(at) ? at : 0;
}

interface ConversationGroup {
  agentId: string;
  agentName: string;
  items: Conversation[];
}

/** 按智能体分组；组顺序 = 组内最近活跃时间（会话列表已按活跃倒序，首次出现即最活跃）。 */
function groupByAgent(
  conversations: Conversation[],
  query: string,
  messages: Record<string, Message[]>,
): ConversationGroup[] {
  const q = query.trim().toLowerCase();
  const groups = new Map<string, ConversationGroup>();
  for (const conv of conversations) {
    const title = conversationTitle(conv, messages[conv.id]).toLowerCase();
    const agentName = conv.agent.name.toLowerCase();
    if (q && !title.includes(q) && !agentName.includes(q)) continue;
    const existing = groups.get(conv.agent.id);
    if (existing) existing.items.push(conv);
    else {
      groups.set(conv.agent.id, {
        agentId: conv.agent.id,
        agentName: conv.agent.name,
        items: [conv],
      });
    }
  }
  return [...groups.values()];
}

export function ConversationRail({
  conversations,
  activeConversationId,
  messages,
  openingId = null,
  error = "",
  onOpen,
  onNewConversation,
  onNewForAgent,
}: ConversationRailProps) {
  const [collapsed, setCollapsed] = useState(false);
  const [searchOpen, setSearchOpen] = useState(false);
  const [query, setQuery] = useState("");
  const searchRef = useRef<HTMLInputElement>(null);
  /** 草稿变更时重渲染列表（草稿是本机数据，不参与排序）。 */
  const [, setDraftsTick] = useState(0);
  useEffect(() => subscribeDrafts(() => setDraftsTick((n) => n + 1)), []);
  // 点「搜索」后再聚焦：输入框是条件渲染的，必须等它挂载。
  useEffect(() => {
    if (searchOpen) searchRef.current?.focus();
  }, [searchOpen]);

  const sorted = useMemo(
    () => [...conversations].sort((a, b) => lastActivityOf(b) - lastActivityOf(a)),
    [conversations],
  );
  const groups = useMemo(
    () => groupByAgent(sorted, query, messages),
    [sorted, query, messages],
  );
  const hasQuery = query.trim() !== "";

  const closeSearch = () => {
    setQuery("");
    setSearchOpen(false);
  };

  const titleOf = (conv: Conversation): string =>
    conversationTitle(conv, messages[conv.id]);

  /** 会话行：一级信息 = 会话名，右侧时间；有草稿时补「草稿」标识。 */
  const renderRow = (conv: Conversation) => {
    const active = conv.id === activeConversationId;
    const title = titleOf(conv);
    const draft = hasDraft(conv.id);
    return (
      <button
        key={conv.id}
        type="button"
        title={draft ? `${title}（有草稿）` : title}
        aria-label={`打开与 ${conv.agent.name} 的对话：${title}`}
        aria-current={active ? "true" : undefined}
        onClick={() => onOpen(conv.id)}
        className={`mb-0.5 flex w-full items-center gap-1.5 rounded-md px-2 py-1.5 text-left transition-colors ${
          active ? "bg-[var(--subtle-4)]" : "hover:bg-[var(--subtle-2)]"
        }`}
      >
        <span className="ui-body-sm min-w-0 flex-1 truncate">{title}</span>
        {draft ? (
          <span className="ui-chip shrink-0" title="有未发送的草稿">
            草稿
          </span>
        ) : null}
        {conv.lastMessageAt ? (
          <span className="ui-micro shrink-0 text-muted">
            {formatClock(conv.lastMessageAt)}
          </span>
        ) : null}
      </button>
    );
  };

  const renderEmpty = () => {
    if (sorted.length === 0) {
      return (
        <div className="ui-empty px-2 py-6">
          <p className="ui-empty-title">还没有对话</p>
          <p className="ui-empty-desc">在右侧选一个智能体，开始第一段对话。</p>
          <button
            type="button"
            onClick={onNewConversation}
            className="ui-btn ui-btn-sm ui-btn-primary mt-2 w-full"
          >
            选择智能体
          </button>
        </div>
      );
    }
    return (
      <div className="ui-empty px-2 py-6">
        <p className="ui-empty-title">没有匹配的对话</p>
        <p className="ui-empty-desc">换个关键词试试，或清空搜索。</p>
        <button type="button" className="ui-btn ui-btn-sm ui-btn-ghost" onClick={closeSearch}>
          清空搜索
        </button>
      </div>
    );
  };

  if (collapsed) {
    return (
      <aside className="flex w-[60px] shrink-0 flex-col border-r border-line-soft">
        <header className="flex items-center justify-center border-b border-line-soft py-2">
          <button
            type="button"
            aria-label="展开对话列表"
            title="展开对话列表"
            onClick={() => setCollapsed(false)}
            className="flex h-7 w-7 items-center justify-center rounded-md text-[#666] hover:bg-[var(--subtle-4)] hover:text-ink"
          >
            ›
          </button>
        </header>
        <div className="min-h-0 flex-1 overflow-y-auto p-1.5">
          {sorted.map((conv) => {
            const active = conv.id === activeConversationId;
            const title = titleOf(conv);
            return (
              <button
                key={conv.id}
                type="button"
                title={title}
                aria-label={`打开与 ${conv.agent.name} 的对话：${title}`}
                aria-current={active ? "true" : undefined}
                onClick={() => onOpen(conv.id)}
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
          })}
        </div>
        <button
          type="button"
          aria-label="新建对话"
          title="新建对话"
          onClick={onNewConversation}
          className="mx-auto mb-2 flex h-7 w-7 items-center justify-center rounded-md text-[#666] hover:bg-[var(--subtle-4)] hover:text-ink"
        >
          <PlusIcon width={14} height={14} />
        </button>
      </aside>
    );
  }

  return (
    <aside className="flex w-[264px] shrink-0 flex-col border-r border-line-soft">
      <header className="flex items-center gap-2 border-b border-line-soft px-3 py-2.5">
        <span className="ui-section-title min-w-0 truncate">对话</span>
        <span className="ui-micro text-muted">{sorted.length}</span>
        <button
          type="button"
          aria-label="收起对话列表"
          title="收起对话列表"
          onClick={() => setCollapsed(true)}
          className="ml-auto flex h-[24px] w-[20px] items-center justify-center rounded-md text-[13px] text-[#666] hover:bg-[var(--subtle-4)] hover:text-ink"
        >
          ‹
        </button>
      </header>

      {/* 顶部动作：新建对话 / 搜索（对齐参考图 New / Search）。 */}
      <div className="flex items-center gap-1.5 border-b border-line-soft px-2 py-1.5">
        <button
          type="button"
          aria-label="新建对话"
          title="新建对话：先选一个智能体"
          onClick={onNewConversation}
          className="ui-btn ui-btn-sm ui-btn-ghost min-w-0 flex-1 justify-start"
        >
          <PlusIcon width={14} height={14} />
          <span className="truncate">新建对话</span>
        </button>
        <button
          type="button"
          aria-label="搜索"
          title={searchOpen ? "收起搜索" : "搜索对话"}
          aria-expanded={searchOpen}
          aria-controls="assistant-conversation-search"
          onClick={() => (searchOpen ? closeSearch() : setSearchOpen(true))}
          className={`flex h-7 w-7 shrink-0 items-center justify-center rounded-md transition-colors ${
            searchOpen
              ? "bg-[var(--subtle-4)] text-ink"
              : "text-[#666] hover:bg-[var(--subtle-4)] hover:text-ink"
          }`}
        >
          <SearchIcon width={14} height={14} />
        </button>
      </div>

      {searchOpen ? (
        <div id="assistant-conversation-search" className="border-b border-line-soft px-2 py-1.5">
          <input
            ref={searchRef}
            type="search"
            aria-label="搜索对话"
            value={query}
            onChange={(e) => setQuery(e.target.value)}
            onKeyDown={(e) => {
              if (e.key === "Escape") {
                e.stopPropagation();
                closeSearch();
              }
            }}
            placeholder="搜索对话…"
            className="w-full rounded-lg border border-line px-2 py-1 text-[12px] outline-hidden focus:border-ink"
          />
        </div>
      ) : null}

      <div className="min-h-0 flex-1 overflow-y-auto p-1.5">
        {groups.length === 0
          ? renderEmpty()
          : groups.map((group) => (
              <section
                key={group.agentId}
                aria-label={`${group.agentName} 的对话`}
                className="mb-1.5"
              >
                <div className="flex items-center gap-1 px-2 py-1">
                  <span className="ui-micro min-w-0 flex-1 truncate" title={group.agentName}>
                    {group.agentName}
                  </span>
                  <span className="ui-micro text-muted">{group.items.length}</span>
                  <button
                    type="button"
                    aria-label={`新建与 ${group.agentName} 的对话`}
                    // 服务端对同一智能体幂等（已有会话直接复用），提示里说实话，别让用户以为会多出一段
                    title={`新建与 ${group.agentName} 的对话（已有会话会直接打开）`}
                    disabled={openingId === group.agentId}
                    onClick={() => onNewForAgent(group.agentId)}
                    className="flex h-5 w-5 items-center justify-center rounded-sm text-[#666] hover:bg-[var(--subtle-3)] hover:text-ink disabled:opacity-50"
                  >
                    <PlusIcon width={12} height={12} />
                  </button>
                </div>
                {group.items.map(renderRow)}
              </section>
            ))}
        {hasQuery && groups.length > 0 ? (
          <p className="ui-caption px-2 py-1">
            {groups.reduce((n, g) => n + g.items.length, 0)} 条匹配
          </p>
        ) : null}
      </div>

      {error && (
        <p role="alert" className="border-t border-line-soft px-3 py-2 text-[11px] text-[#b42318]">
          {error}
        </p>
      )}
      <p className="ui-caption border-t border-line-soft px-3 py-2 leading-4">
        智能体在本机运行：模型 Key、工具与记忆不出设备；消息不进团队动向。
      </p>
    </aside>
  );
}
