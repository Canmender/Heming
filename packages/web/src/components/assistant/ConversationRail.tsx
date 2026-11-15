import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import type { ReactNode } from "react";
import type { Conversation, Message, Workspace } from "@heming/shared";
import { EmptyState } from "../ui/EmptyState.js";
import { ChevronIcon, FolderIcon, MoreIcon, PlusIcon, SearchIcon } from "../icons.js";
import { formatClock } from "../../lib/formatTime.js";
import { hasDraft, subscribeDrafts } from "../../lib/drafts.js";
import { conversationTitle } from "./conversationTitle.js";
import { Button } from "../ui/Button.js";
import {
  groupConversations,
  UNGROUPED_ID,
  type WorkspaceGroup,
} from "../../lib/workspace/group.js";
import { WorkspaceDialog, type WorkspaceDialogMode } from "./WorkspaceDialog.js";

/**
 * 会话左栏（单智能体 · 会话模式，对齐 Codex / Claude Code）。
 *
 * 产品只剩一个内置智能体，所以这里**不按智能体分组**；一级信息是**工作区**
 * （本机一个文件夹），二级信息是**会话名**（d.147.4.91.11）。
 *
 * 结构：
 * - 顶部：「工作区」+ 搜索 / 新建工作区两个图标；下面整行「新对话」主按钮；
 * - 列表按工作区分组（`groupConversations`）：组头 = 文件夹图标 + 名称 + 会话数 +
 *   折叠 chevron，组头右侧 hover 出「+」直接在该组新建；会话行左缩进 20px；
 * - 当前会话高亮（`aria-current`），含活动会话的组头浅底；有草稿的会话带「草稿」；
 * - 搜索只匹配会话名，命中时忽略折叠状态（`aria-expanded` 与实际渲染一致）；
 * - 常驻不可折叠（d.147.4.89）：折叠会把会话入口藏起来，而侧栏同时承担导航；
 * - 栏顶与栏底各留一个插槽（主导航 / 设置 + 账户），由 `Sidebar` 组装。
 *
 * 会话名优先用服务端 `title`（d.128）；没有标题时由 `conversationTitle` 从已加载消息推导，
 * 未加载消息的会话回落为最后活跃时间。悬停行尾「更多」可改名/移动/删除
 *（删除由调用方二次确认，移动走 `WorkspaceDialog`）。
 */

/** 一次工作区弹窗的打开参数：`new` 新建工作区，`move` 移动某段会话。 */
interface RailDialogState {
  mode: WorkspaceDialogMode;
  /** move 模式：要移动的会话。 */
  conversationId?: string;
  /** move 模式：会话当前工作区（回填输入框）。 */
  initialPath?: string;
}

export interface ConversationRailProps {
  /** 全量会话（组件内会重新按最近活跃排序，不依赖调用方顺序）。 */
  conversations: Conversation[];
  /** 左栏工作区清单（store.workspaces）：分组来源；清单里的空工作区也会成组。 */
  workspaces: Workspace[];
  activeConversationId: string | null;
  /** 已加载消息（store.messages）：用于推导会话名前缀。 */
  messages: Record<string, Message[]>;
  /** 正在新建会话（按钮 busy 态；调用方用同一个标志防重）。 */
  opening?: boolean;
  /** 新建/改名/加载更多失败的原因（显示在栏底，不挡列表）。 */
  error?: string;
  onOpen: (conversationId: string) => void;
  /**
   * 新建一段 fresh 会话并落到指定工作区（`null` = 未分组）。
   *
   * 主按钮用「当前活动会话所在工作区 → 刚新建的工作区 → 未分组」；
   * 组头「+」用该组的路径。真正的建会话动作由调用方（Sidebar）执行。
   */
  onNewConversation: (workspace: string | null) => void;
  /** 会话改名（行内菜单）：服务端 PATCH 由调用方负责。 */
  onRename: (conversationId: string, title: string) => void | Promise<void>;
  /** 请求删除会话（调用方弹二次确认，rail 不直接删）。 */
  onDeleteRequest: (conv: Conversation) => void;
  /** 把会话挪到工作区（`null` = 移出工作区/未分组）；失败抛错，rail 转 `onError`。 */
  onMoveConversation: (conversationId: string, workspace: string | null) => Promise<void>;
  /** 新建一个工作区（同路径幂等）；失败抛错，rail 转 `onError`。 */
  onAddWorkspace: (path: string) => Promise<void>;
  /** 工作区相关动作失败的原因（交调用方显示在栏底错误区，不挡列表）。 */
  onError?: (message: string) => void;
  /** 还有下一页会话（服务端 limit 分页）；搜索时不显示。 */
  hasMore?: boolean;
  loadingMore?: boolean;
  onLoadMore?: () => void;
  /**
   * 栏顶插槽（d.147.4.89）：常驻主导航（插件/团队/模型/知识库/插件页）挂在这里。
   *
   * 放插槽而不是搬进 rail：会话列表是「数据」，导航是「外壳」；两者都由
   * `Sidebar` 组装，rail 只负责给它们排位置，不反过来知道有哪些页面。
   */
  topNav?: ReactNode;
  /**
   * 栏底常驻插槽：设置入口 + 账户头像与菜单挂在这里。
   *
   * 栏不再可折叠，所以这里直接收一个节点——不再需要按「收起态/展开态」
   * 给调用方两种排法（d.147.4.88 的 `renderFooter(collapsed)` 已退场）。
   */
  footer?: ReactNode;
}

/** 最近活跃排序键：没有消息的排最后。 */
function lastActivityOf(conv: Pick<Conversation, "lastMessageAt">): number {
  const at = conv.lastMessageAt ? Date.parse(conv.lastMessageAt) : NaN;
  return Number.isFinite(at) ? at : 0;
}

/** 错误对象 → 可读原因（空串表示服务端没给细节）。 */
function reasonOf(err: unknown): string {
  return err instanceof Error && err.message ? err.message : "";
}

export function ConversationRail({
  conversations,
  workspaces,
  activeConversationId,
  messages,
  opening = false,
  error = "",
  onOpen,
  onNewConversation,
  onRename,
  onDeleteRequest,
  onMoveConversation,
  onAddWorkspace,
  onError,
  hasMore = false,
  loadingMore = false,
  onLoadMore,
  topNav,
  footer,
}: ConversationRailProps) {
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
  /** 扁平列表 + 只按会话名过滤（单智能体：工作区/智能体名都不参与搜索）。 */
  const visible = useMemo(() => {
    const q = query.trim().toLowerCase();
    if (!q) return sorted;
    return sorted.filter((conv) => titleOf(conv).toLowerCase().includes(q));
  }, [sorted, query, titleOf]);
  const hasQuery = query.trim() !== "";

  /** 组 → 会话（未分组永远最后；清单里的空组也显示）。 */
  const groups = useMemo(() => groupConversations(visible, workspaces), [visible, workspaces]);

  /** 折叠状态按「组 id」记：`UNGROUPED_ID` 表示未分组组，不会与真实路径冲突。 */
  const [collapsedPaths, setCollapsedPaths] = useState<Set<string>>(() => new Set());
  const toggleGroup = useCallback((groupId: string) => {
    setCollapsedPaths((prev) => {
      const next = new Set(prev);
      if (next.has(groupId)) next.delete(groupId);
      else next.add(groupId);
      return next;
    });
  }, []);

  /** 含活动会话的组 id（高亮用；不受搜索过滤影响，避免搜索时高亮消失）。 */
  const activeGroupId = useMemo(() => {
    const active = conversations.find((conv) => conv.id === activeConversationId);
    if (!active) return null;
    return active.workspace?.trim() || UNGROUPED_ID;
  }, [conversations, activeConversationId]);

  /**
   * 栏头新建工作区后，把它记成「新对话」的落点：用户刚选完文件夹，
   * 下一个新对话理应建在这里（不自动建会话——避免点错就多出一段空对话）。
   */
  const [preferredWorkspace, setPreferredWorkspace] = useState<string | null>(null);
  const activeWorkspace = useMemo(() => {
    const active = conversations.find((conv) => conv.id === activeConversationId);
    return active?.workspace?.trim() || null;
  }, [conversations, activeConversationId]);
  /** 新对话落点：活动会话的工作区 → 刚新建的工作区 → 未分组。 */
  const newConversationWorkspace = activeWorkspace ?? preferredWorkspace;

  const closeSearch = () => {
    setQuery("");
    setSearchOpen(false);
  };

  /** d.128：会话行操作菜单 + 行内改名。 */
  const [menuFor, setMenuFor] = useState<string | null>(null);
  const [renamingId, setRenamingId] = useState<string | null>(null);
  const [renameValue, setRenameValue] = useState("");

  /** 工作区弹窗（新建 / 移动共用一套壳）。 */
  const [dialog, setDialog] = useState<RailDialogState | null>(null);
  const [dialogBusy, setDialogBusy] = useState(false);

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

  /** 栏头「新建工作区」：打开 new 模式弹窗，不选目录也可以取消。 */
  const openNewWorkspaceDialog = () => {
    setMenuFor(null);
    setDialog({ mode: "new" });
  };

  /** 会话 ⋯ →「移动到工作区…」：回填会话当前工作区，方便原地确认。 */
  const openMoveDialog = (conv: Conversation) => {
    setMenuFor(null);
    setDialog({
      mode: "move",
      conversationId: conv.id,
      initialPath: conv.workspace?.trim() ?? "",
    });
  };

  /** 取消弹窗：提交中不响应（避免把在途请求的结果丢在半路）。 */
  const cancelDialog = () => {
    if (!dialogBusy) setDialog(null);
  };

  /** 确认弹窗：新建工作区 / 移动会话。失败交给 `onError`（栏底错误区）。 */
  const confirmDialog = async (path: string | null) => {
    if (!dialog || dialogBusy) return;
    setDialogBusy(true);
    try {
      if (dialog.mode === "new") {
        if (!path) return;
        await onAddWorkspace(path);
        setPreferredWorkspace(path);
      } else if (dialog.conversationId) {
        await onMoveConversation(dialog.conversationId, path);
      }
      setDialog(null);
    } catch (err) {
      const reason = reasonOf(err);
      const what = dialog.mode === "new" ? "新建工作区失败" : "移动会话失败";
      onError?.(reason ? `${what}：${reason}` : what);
    } finally {
      setDialogBusy(false);
    }
  };

  /** 会话行：一级信息 = 会话名，右侧时间；悬停/聚焦出「更多」操作（改名/移动/删除）。 */
  const renderRow = (conv: Conversation) => {
    const active = conv.id === activeConversationId;
    const title = titleOf(conv);
    const draft = hasDraft(conv.id);

    if (renamingId === conv.id) {
      return (
        <div
          key={conv.id}
          className="mb-0.5 ml-5 flex items-center gap-1 rounded-lg bg-subtle-3 px-2 py-1"
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
        className={`group relative mb-0.5 ml-5 flex items-center rounded-lg transition-colors ${
          active ? "bg-subtle-3" : "hover:bg-subtle-2"
        }`}
      >
        <button
          type="button"
          title={draft ? `${title}（有草稿）` : title}
          aria-label={`打开会话：${title}`}
          aria-current={active ? "true" : undefined}
          onClick={() => onOpen(conv.id)}
          className="flex min-w-0 flex-1 items-center gap-1.5 rounded-lg px-2.5 py-2 text-left"
        >
          <span className={`min-w-0 flex-1 truncate text-ui-sm ${active ? "text-ink" : "text-body"}`}>
            {title}
          </span>
          {draft ? (
            <span className="ui-chip shrink-0" title="有未发送的草稿">
              草稿
            </span>
          ) : null}
          {conv.lastMessageAt ? (
            <span className="shrink-0 text-ui-xs tabular-nums text-muted">
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
          className={`mr-1 rounded-md p-1 text-muted transition-opacity hover:bg-subtle-3 hover:text-ink focus:opacity-100 ${
            menuFor === conv.id ? "opacity-100" : "opacity-0 group-hover:opacity-100"
          }`}
        >
          <MoreIcon width={14} height={14} aria-hidden="true" />
        </button>
        {menuFor === conv.id ? (
          <div
            role="menu"
            data-conv-menu
            className="absolute right-1 top-full z-30 mt-1 w-40 rounded-lg border border-line bg-surface p-1 text-ui-sm ui-overlay-shadow"
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
              data-conv-menu-move
              className="block w-full rounded-sm px-2 py-1 text-left hover:bg-subtle-3"
              onClick={() => openMoveDialog(conv)}
            >
              移动到工作区…
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

  /**
   * 一个工作区组：组头（可折叠）+ 会话行。
   *
   * 折叠状态只记在组件里（本机 UI 偏好，不进服务端）：`aria-expanded` 由
   * 「是否搜索」与折叠集合共同决定——搜索命中时强制展开，两者始终一致。
   */
  const renderGroup = (group: WorkspaceGroup) => {
    const groupId = group.path ?? UNGROUPED_ID;
    const expanded = hasQuery || !collapsedPaths.has(groupId);
    const active = activeGroupId === groupId;
    return (
      <div key={groupId} className="mb-0.5">
        <div
          className={`group flex items-center rounded-lg transition-colors ${
            active ? "bg-subtle-2" : "hover:bg-subtle-2"
          }`}
        >
          <button
            type="button"
            aria-label={`工作区：${group.name}`}
            aria-expanded={expanded}
            data-workspace-group={groupId}
            onClick={() => toggleGroup(groupId)}
            className="flex min-w-0 flex-1 items-center gap-1.5 rounded-lg px-2.5 py-1.5 text-left"
          >
            <FolderIcon width={14} height={14} aria-hidden="true" className="shrink-0 text-muted" />
            <span className={`min-w-0 flex-1 truncate text-ui-sm ${active ? "text-ink" : "text-body"}`}>
              {group.name}
            </span>
            <ChevronIcon
              width={12}
              height={12}
              aria-hidden="true"
              className={`shrink-0 text-muted transition-transform motion-reduce:transition-none ${
                expanded ? "rotate-90" : ""
              }`}
            />
          </button>
          <button
            type="button"
            aria-label={`在 ${group.name} 新建对话`}
            title={`在 ${group.name} 新建对话`}
            data-workspace-add={groupId}
            onClick={() => onNewConversation(group.path)}
            className="mr-1 flex h-6 w-6 items-center justify-center rounded-md text-muted opacity-0 transition-opacity hover:bg-subtle-3 hover:text-ink focus-visible:opacity-100 group-hover:opacity-100 group-focus-within:opacity-100 motion-reduce:transition-none"
          >
            <PlusIcon width={12} height={12} aria-hidden="true" />
          </button>
        </div>
        {expanded ? (
          <div data-workspace-group-body={groupId} className="mt-0.5">
            {group.conversations.map(renderRow)}
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
              onClick={() => onNewConversation(null)}
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

  /** 无会话且无工作区 → 纯空态；否则始终渲染组（刚建的空工作区不能凭空消失）。 */
  const showEmptyState = (sorted.length === 0 && workspaces.length === 0) || (hasQuery && visible.length === 0);

  return (
    <aside className="flex w-[268px] shrink-0 flex-col border-r border-line-soft bg-subtle">
      {/* 栏顶：常驻主导航（由 Sidebar 组装；插件页接在知识库之后）。 */}
      {topNav}

      <header className="flex items-center gap-1 px-3 pb-1 pt-2">
        {/* 栏头只有「工作区」+ 两个图标：文件夹分组是本栏的一级结构，
            产品名已经在顶栏的手写标志里，这里不再复读（d.147.4.89 的纪律）。 */}
        <h2 className="min-w-0 flex-1 truncate text-ui-sm font-medium text-muted">工作区</h2>
        <button
          type="button"
          aria-label="搜索会话"
          title={searchOpen ? "收起搜索" : "搜索会话"}
          aria-expanded={searchOpen}
          aria-controls="assistant-conversation-search"
          data-testid="rail-search-toggle"
          onClick={() => {
            if (searchOpen) {
              closeSearch();
            } else {
              setSearchOpen(true);
              searchRef.current?.focus();
            }
          }}
          className="ui-hit flex h-7 w-7 items-center justify-center rounded-md text-muted transition-colors hover:bg-subtle-2 hover:text-ink"
        >
          <SearchIcon width={14} height={14} aria-hidden="true" />
        </button>
        <button
          type="button"
          aria-label="新建工作区"
          title="新建工作区"
          data-testid="rail-new-workspace"
          onClick={openNewWorkspaceDialog}
          className="ui-hit flex h-7 w-7 items-center justify-center rounded-md text-muted transition-colors hover:bg-subtle-2 hover:text-ink"
        >
          {/* 图标集里没有 FolderPlusIcon（不改 icons.tsx），用一个 9px 的「+」叠在
              文件夹右下角，视觉上就是「文件夹 + 加号」。 */}
          <span className="relative inline-flex" aria-hidden="true">
            <FolderIcon width={16} height={16} />
            <PlusIcon
              width={12}
              height={12}
              className="absolute -bottom-1 -right-1 rounded-full bg-subtle"
            />
          </span>
        </button>
      </header>

      {/* 主操作：整行圆角「新对话」按钮（这一栏唯一的高饱和大按钮）。 */}
      <div className="px-2 pb-2 pt-1">
        <Button
          type="button"
          aria-label="新建会话"
          title="新建会话"
          onClick={() => onNewConversation(newConversationWorkspace)}
          busy={opening}
          size="md"
          variant="primary"
          className="w-full justify-center"
        >
          <PlusIcon width={16} height={16} aria-hidden="true" />
          新对话
        </Button>
      </div>

      {/* 搜索：默认收起，点栏头放大镜才展开（对齐参考图的图标式入口，不占一行）。
          `#assistant-conversation-search` 容器常驻，`aria-controls` 永远指向存在的节点。 */}
      <div id="assistant-conversation-search" className="relative mx-2">
        {searchOpen ? (
          <>
            <span className="pointer-events-none absolute left-1 top-1/2 flex h-6 w-6 -translate-y-1/2 items-center justify-center text-muted">
              <SearchIcon width={14} height={14} aria-hidden="true" />
            </span>
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
              className="mb-1 h-8 w-full rounded-lg border border-line-strong bg-surface pl-8 pr-2 text-ui-sm outline-hidden transition-colors placeholder:text-placeholder"
            />
          </>
        ) : null}
      </div>

      <div className="min-h-0 flex-1 overflow-y-auto px-1.5 pb-2">
        {showEmptyState ? renderEmpty() : groups.map(renderGroup)}
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
        <p role="alert" className="border-t border-line-soft px-3 py-2 text-ui-sm text-danger">
          {error}
        </p>
      )}
      {/* 栏底：设置入口 + 账户（头像 + 菜单）。原来这里是一行「本机运行 · Key 与
          记忆不出设备」的隐私声明——按用户要求去掉正文，位置让给身份与设置。 */}
      {footer ? (
        <div className="shrink-0 border-t border-line-soft p-1.5">{footer}</div>
      ) : null}

      {dialog ? (
        <WorkspaceDialog
          open
          mode={dialog.mode}
          initialPath={dialog.initialPath}
          busy={dialogBusy}
          onCancel={cancelDialog}
          onConfirm={(path) => void confirmDialog(path)}
        />
      ) : null}
    </aside>
  );
}
