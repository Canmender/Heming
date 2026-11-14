import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import type { Conversation, Message } from "@heming/shared";
import { Avatar } from "../Avatar.js";
import { EmptyState } from "../ui/EmptyState.js";
import { ChevronIcon, MoreIcon, PlusIcon, SearchIcon } from "../icons.js";
import { formatClock } from "../../lib/formatTime.js";
import { hasDraft, subscribeDrafts } from "../../lib/drafts.js";
import { conversationTitle } from "./conversationTitle.js";
import { Button } from "../ui/Button.js";

/**
 * 会话左栏（单智能体 · 会话模式，对齐 Codex / Claude Code）。
 *
 * 产品只剩一个内置智能体，所以这里**不再按智能体分组**：全部会话是一条扁平列表，
 * 一级信息是**会话名**（不是智能体名）。
 *
 * 结构：
 * - 顶部：「会话」+ 数量；动作行「新建会话」+「搜索」；
 * - 列表按最近活跃排序；当前会话高亮（`aria-current`），有草稿的会话带「草稿」标识；
 * - 搜索只匹配会话标题；
 * - 可折叠成头像窄栏，把横向空间让给对话；整个列表保持 Tab 可达。
 *
 * 会话名优先用服务端 `title`（d.128）；没有标题时由 `conversationTitle` 从已加载消息推导，
 * 未加载消息的会话回落为最后活跃时间。悬停行尾「更多」可改名/删除（删除由调用方二次确认）。
 */

export interface ConversationRailProps {
  /** 全量会话（组件内会重新按最近活跃排序，不依赖调用方顺序）。 */
  conversations: Conversation[];
  activeConversationId: string | null;
  /** 已加载消息（store.messages）：用于推导会话名前缀。 */
  messages: Record<string, Message[]>;
  /** 正在新建会话（按钮 busy 态；调用方用同一个标志防重）。 */
  opening?: boolean;
  /** 新建/改名/加载更多失败的原因（显示在栏底，不挡列表）。 */
  error?: string;
  onOpen: (conversationId: string) => void;
  /** 顶部「新建会话」：直接新建一段 fresh 会话（单智能体，无需再选人）。 */
  onNewConversation: () => void;
  /** 会话改名（行内菜单）：服务端 PATCH 由调用方负责。 */
  onRename: (conversationId: string, title: string) => void | Promise<void>;
  /** 请求删除会话（调用方弹二次确认，rail 不直接删）。 */
  onDeleteRequest: (conv: Conversation) => void;
  /** 还有下一页会话（服务端 limit 分页）；搜索时不显示。 */
  hasMore?: boolean;
  loadingMore?: boolean;
  onLoadMore?: () => void;
}

/** 最近活跃排序键：没有消息的排最后。 */
function lastActivityOf(conv: Pick<Conversation, "lastMessageAt">): number {
  const at = conv.lastMessageAt ? Date.parse(conv.lastMessageAt) : NaN;
  return Number.isFinite(at) ? at : 0;
}

export function ConversationRail({
  conversations,
  activeConversationId,
  messages,
  opening = false,
  error = "",
  onOpen,
  onNewConversation,
  onRename,
  onDeleteRequest,
  hasMore = false,
  loadingMore = false,
  onLoadMore,
}: ConversationRailProps) {
  const [collapsed, setCollapsed] = useState(false);
  // 极窄视口（≤900）自动收起成头像栏：264px 固定宽在 375 视口下会把对话区挤成一条缝。
  // 只在「进入窄视口」时自动收；用户手动展开仍然生效，不做反向强制。
  useEffect(() => {
    if (typeof window === "undefined" || typeof window.matchMedia !== "function") return;
    const mq = window.matchMedia("(max-width: 900px)");
    if (mq.matches) setCollapsed(true);
    const onChange = (e: MediaQueryListEvent) => {
      if (e.matches) setCollapsed(true);
    };
    mq.addEventListener("change", onChange);
    return () => mq.removeEventListener("change", onChange);
  }, []);
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

  const titleOf = useCallback(
    (conv: Conversation): string => conversationTitle(conv, messages[conv.id]),
    [messages],
  );
  const sorted = useMemo(
    () => [...conversations].sort((a, b) => lastActivityOf(b) - lastActivityOf(a)),
    [conversations],
  );
  /** 扁平列表 + 只按会话名过滤（单智能体：智能体名不再有区分度）。 */
  const visible = useMemo(() => {
    const q = query.trim().toLowerCase();
    if (!q) return sorted;
    return sorted.filter((conv) => titleOf(conv).toLowerCase().includes(q));
  }, [sorted, query, titleOf]);
  const hasQuery = query.trim() !== "";

  const closeSearch = () => {
    setQuery("");
    setSearchOpen(false);
  };

  /** d.128：会话行操作菜单 + 行内改名。 */
  const [menuFor, setMenuFor] = useState<string | null>(null);
  const [renamingId, setRenamingId] = useState<string | null>(null);
  const [renameValue, setRenameValue] = useState("");

  // 点菜单外关闭（回退焦点不抢：菜单只是轻量操作壳）
  useEffect(() => {
    if (!menuFor) return;
    const onDown = (e: Event) => {
      const target = e.target as HTMLElement | null;
      if (!target?.closest("[data-conv-menu]")) setMenuFor(null);
    };
    document.addEventListener("pointerdown", onDown);
    return () => document.removeEventListener("pointerdown", onDown);
  }, [menuFor]);

  const startRename = (conv: Conversation) => {
    setMenuFor(null);
    setRenamingId(conv.id);
    setRenameValue(titleOf(conv));
  };
  const cancelRename = () => {
    setRenamingId(null);
    setRenameValue("");
  };
  const commitRename = async (conv: Conversation) => {
    const next = renameValue.trim();
    if (!next || next === titleOf(conv)) {
      cancelRename();
      return;
    }
    try {
      await onRename(conv.id, next);
      cancelRename();
    } catch {
      /* 失败保留输入：用户可改完再试，错误提示由调用方（AssistantPage）负责 */
    }
  };

  /** 会话行：一级信息 = 会话名，右侧时间；悬停/聚焦出「更多」操作（改名/删除）。 */
  const renderRow = (conv: Conversation) => {
    const active = conv.id === activeConversationId;
    const title = titleOf(conv);
    const draft = hasDraft(conv.id);

    if (renamingId === conv.id) {
      return (
        <div
          key={conv.id}
          className="mb-0.5 flex items-center gap-1 rounded-md bg-subtle-3 px-2 py-1"
        >
          <input
            aria-label="会话名称"
            autoFocus
            value={renameValue}
            onChange={(e) => setRenameValue(e.target.value)}
            onKeyDown={(e) => {
              if (e.key === "Enter") {
                e.preventDefault();
                void commitRename(conv);
              } else if (e.key === "Escape") {
                e.preventDefault();
                cancelRename();
              }
            }}
            className="ui-input h-7 min-w-0 flex-1 text-ui-sm"
          />
          <Button
            type="button"
            aria-label="保存会话名称"
            size="sm" variant="primary"
            onClick={() => void commitRename(conv)}
          >
            保存
          </Button>
          <Button
            type="button"
            aria-label="取消重命名"
            size="sm" variant="ghost"
            onClick={cancelRename}
          >
            取消
          </Button>
        </div>
      );
    }

    return (
      <div
        key={conv.id}
        className={`group relative mb-0.5 flex items-center rounded-md transition-colors ${
          active ? "bg-subtle-4" : "hover:bg-subtle-2"
        }`}
      >
        <button
          type="button"
          title={draft ? `${title}（有草稿）` : title}
          aria-label={`打开会话：${title}`}
          aria-current={active ? "true" : undefined}
          onClick={() => onOpen(conv.id)}
          className="flex min-w-0 flex-1 items-center gap-1.5 rounded-md px-2 py-1.5 text-left"
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
        <button
          type="button"
          aria-label={`会话操作：${title}`}
          aria-haspopup="menu"
          aria-expanded={menuFor === conv.id}
          onClick={() => setMenuFor((cur) => (cur === conv.id ? null : conv.id))}
          className={`mr-1 rounded-sm p-1 text-muted transition-opacity hover:bg-subtle-3 hover:text-ink focus:opacity-100 ${
            menuFor === conv.id ? "opacity-100" : "opacity-0 group-hover:opacity-100"
          }`}
        >
          <MoreIcon width={14} height={14} aria-hidden="true" />
        </button>
        {menuFor === conv.id ? (
          <div
            role="menu"
            data-conv-menu
            className="absolute right-1 top-full z-30 mt-1 w-32 rounded-lg border border-line bg-surface p-1 text-ui-sm ui-overlay-shadow"
          >
            <button
              type="button"
              role="menuitem"
              className="block w-full rounded-sm px-2 py-1 text-left hover:bg-subtle-3"
              onClick={() => startRename(conv)}
            >
              重命名
            </button>
            <button
              type="button"
              role="menuitem"
              className="block w-full rounded-sm px-2 py-1 text-left text-danger hover:bg-subtle-3"
              onClick={() => {
                setMenuFor(null);
                onDeleteRequest(conv);
              }}
            >
              删除
            </button>
          </div>
        ) : null}
      </div>
    );
  };

  const renderEmpty = () => {
    if (sorted.length === 0) {
      return (
        <EmptyState
          className="px-2 py-6"
          title="还没有会话"
          actions={
            <Button
              type="button"
              onClick={onNewConversation}
              busy={opening}
              size="sm" variant="primary" className="w-full"
            >
              新建会话
            </Button>
          }
        />
      );
    }
    return (
      <EmptyState
        className="px-2 py-6"
        title="没有匹配的会话"
        actions={
          <Button type="button" size="sm" variant="ghost" onClick={closeSearch}>
            清空搜索
          </Button>
        }
      />
    );
  };

  if (collapsed) {
    return (
      <aside className="flex w-[60px] shrink-0 flex-col border-r border-line-soft">
        <header className="flex items-center justify-center border-b border-line-soft py-2">
          <button
            type="button"
            aria-label="展开会话列表"
            title="展开会话列表"
            onClick={() => setCollapsed(false)}
            className="ui-hit flex h-7 w-7 items-center justify-center rounded-md text-muted hover:bg-subtle-4 hover:text-ink"
          >
            <ChevronIcon width={14} height={14} aria-hidden="true" />
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
                aria-label={`打开会话：${title}`}
                aria-current={active ? "true" : undefined}
                onClick={() => onOpen(conv.id)}
                className={`mb-1 flex w-full justify-center rounded-lg p-1 transition-colors ${
                  active ? "bg-subtle-4" : "hover:bg-subtle-2"
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
          aria-label="新建会话"
          title="新建会话"
          disabled={opening}
          onClick={onNewConversation}
          className="ui-hit mx-auto mb-2 flex h-7 w-7 items-center justify-center rounded-md text-muted hover:bg-subtle-4 hover:text-ink disabled:opacity-50"
        >
          <PlusIcon width={14} height={14} />
        </button>
      </aside>
    );
  }

  return (
    <aside className="flex w-[264px] shrink-0 flex-col border-r border-line-soft">
      <header className="flex items-center gap-2 border-b border-line-soft px-3 py-2.5">
        {/* 二级标题：页头 h1 是「会话」，栏头用 h2 给读屏用户两级大纲（设计审计门槛）。 */}
        <h2 className="ui-section-title min-w-0 truncate">会话列表</h2>
        <span className="ui-micro text-muted">{sorted.length}</span>
        <button
          type="button"
          aria-label="收起会话列表"
          title="收起会话列表"
          onClick={() => setCollapsed(true)}
          className="ui-hit ml-auto flex h-[24px] w-[20px] items-center justify-center rounded-md text-muted hover:bg-subtle-4 hover:text-ink"
        >
          <ChevronIcon width={14} height={14} className="rotate-180" aria-hidden="true" />
        </button>
      </header>

      {/* 顶部动作：新建会话 / 搜索（对齐参考图 New / Search）。 */}
      <div className="flex items-center gap-1.5 border-b border-line-soft px-2 py-1.5">
        <Button
          type="button"
          aria-label="新建会话"
          title="新建会话"
          onClick={onNewConversation}
          busy={opening}
          size="sm" variant="ghost" className="min-w-0 flex-1 justify-start"
        >
          <PlusIcon width={14} height={14} />
          <span className="truncate">新建会话</span>
        </Button>
        <button
          type="button"
          aria-label="搜索"
          title={searchOpen ? "收起搜索" : "搜索会话"}
          aria-expanded={searchOpen}
          aria-controls="assistant-conversation-search"
          onClick={() => (searchOpen ? closeSearch() : setSearchOpen(true))}
          className={`ui-hit flex h-7 w-7 shrink-0 items-center justify-center rounded-md transition-colors ${
            searchOpen
              ? "bg-subtle-4 text-ink"
              : "text-muted hover:bg-subtle-4 hover:text-ink"
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
            aria-label="搜索会话"
            value={query}
            onChange={(e) => setQuery(e.target.value)}
            onKeyDown={(e) => {
              if (e.key === "Escape") {
                e.stopPropagation();
                closeSearch();
              }
            }}
            placeholder="搜索会话…"
            className="w-full rounded-lg border border-line px-2 py-1 text-ui-sm outline-hidden focus:border-ink"
          />
        </div>
      ) : null}

      <div className="min-h-0 flex-1 overflow-y-auto p-1.5">
        {visible.length === 0 ? renderEmpty() : visible.map(renderRow)}
        {hasQuery && visible.length > 0 ? (
          <p className="ui-caption px-2 py-1">{visible.length} 条匹配</p>
        ) : null}
        {hasMore && !hasQuery ? (
          <Button
            type="button"
            disabled={loadingMore}
            onClick={onLoadMore}
            size="sm" variant="ghost" className="mt-1 w-full"
          >
            {loadingMore ? "加载中…" : "加载更多会话"}
          </Button>
        ) : null}
      </div>

      {error && (
        <p role="alert" className="border-t border-line-soft px-3 py-2 ui-body-sm text-danger">
          {error}
        </p>
      )}
      {/* 隐私边界必留：压成一条状态行（页头已有「本机运行」）。 */}
      <p className="ui-caption border-t border-line-soft px-3 py-2">
        本机运行 · Key 与记忆不出设备
      </p>
    </aside>
  );
}