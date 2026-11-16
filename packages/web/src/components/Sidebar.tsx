import { useCallback, useEffect, useState } from "react";
import type { Conversation } from "@heming/shared";
import { useChatStore } from "../store/chat.js";
import { useUiStore } from "../store/ui.js";
import { clearDraft } from "../lib/drafts.js";
import { searchConversationContent } from "../lib/api.js";
import { CONTENT_SEARCH_LIMIT } from "../lib/conversationSearch.js";
import { startNewConversationIn } from "../lib/newConversation.js";
import { ConversationRail } from "./assistant/ConversationRail.js";
import { conversationTitle } from "./assistant/conversationTitle.js";
import { AccountMenu } from "./AccountMenu.js";
import { SidebarNav, sidebarRowClass } from "./SidebarNav.js";
import { ConfirmDialog } from "./ConfirmDialog.js";
import { GearIcon } from "./icons.js";
import { Button } from "./ui/Button.js";

/**
 * 当前活动会话所在工作区（`null` = 未分组/无活动会话）。
 *
 * 命令面板「新建会话」没有工作区上下文，用这个把新会话落到用户正在看的那个
 * 文件夹里（栏头「新对话」按钮是菜单选择，不走这里）。读 `getState()` 而不是订阅：
 * 只在事件触发的那一刻需要一次快照，订阅会让侧栏跟着 workspace 变化重渲染。
 */
function activeWorkspaceOf(): string | null {
  const state = useChatStore.getState();
  const active = state.conversations.find((conv) => conv.id === useUiStore.getState().activeConversationId);
  return active?.workspace?.trim() || null;
}

/**
 * 常驻会话侧栏（应用外壳的一部分，所有页面都在左侧）。
 *
 * 为什么从 AssistantPage 里搬出来：导航轨删除后，会话列表不再是「会话页的一个子视图」，
 * 而是与顶栏同级的外壳结构——从设置页也应该能一眼看到并切回历史会话。数据与动作
 * 仍然是会话 store 那一套，本组件只负责把 rail 需要的东西接上（含新建/改名/删除的
 * 失败提示与二次确认），不新增第二套状态。
 *
 * 会话从服务端取：侧栏挂载即拉一次，不依赖用户先去某个页面。
 *
 * d.147.4.91.11：会话按**工作区**（本机文件夹）分组，工作区清单与首帧会话**并列**
 * 拉取——分组是列表的一级结构，晚一拍到会让整栏先闪一下「未分组」。
 */
export function Sidebar() {
  const conversations = useChatStore((s) => s.conversations);
  const messages = useChatStore((s) => s.messages);
  /** 左栏工作区清单（分组来源；拉不到时 store 退化成「未分组」一组）。 */
  const workspaces = useChatStore((s) => s.workspaces);
  const loadWorkspace = useChatStore((s) => s.loadWorkspace);
  const loadWorkspaces = useChatStore((s) => s.loadWorkspaces);
  const addWorkspace = useChatStore((s) => s.addWorkspace);
  const moveConversation = useChatStore((s) => s.moveConversation);
  const openConversation = useUiStore((s) => s.openConversation);
  const requestMessageJump = useUiStore((s) => s.requestMessageJump);
  const page = useUiStore((s) => s.page);
  const setPage = useUiStore((s) => s.setPage);
  const activeConversationId = useUiStore((s) => s.activeConversationId);
  const renameConversation = useChatStore((s) => s.renameConversation);
  const deleteConversation = useChatStore((s) => s.deleteConversation);
  const conversationsHasMore = useChatStore((s) => s.conversationsHasMore);
  const conversationsLoadingMore = useChatStore((s) => s.conversationsLoadingMore);
  const loadMoreConversations = useChatStore((s) => s.loadMoreConversations);
  /** 一次性命令面板意图：`new-session` = 直接开始一段新会话（消费即清）。 */
  const paletteIntent = useUiStore((s) => s.paletteIntent);
  /** 会话页空态发来的「打开工作区选择」信号（自增计数器）。 */
  const newSessionPickerRequest = useUiStore((s) => s.newSessionPickerRequest);
  const consumePaletteIntent = useUiStore((s) => s.consumePaletteIntent);

  /** 正在新建会话（防重；同时作为 rail 的 busy 态）。 */
  const [opening, setOpening] = useState(false);
  /** 新建 / 改名 / 删除 / 加载更多的失败原因：进 rail 底部错误区，不挡列表。 */
  const [error, setError] = useState("");
  /** 待确认删除的会话：rail 只发请求，二次确认统一放在侧栏做。 */
  const [deleteTarget, setDeleteTarget] = useState<Conversation | null>(null);

  // 首帧并行拉两件事：本地工作区路径（首帧要显示）+ 工作区清单（分组）。
  // 清单失败在 store 里静默退化成空数组（只剩「未分组」组），不打扰用户；
  // 路径失败由 store 记录（workspaceError），会话页负责提示 + 重试——侧栏在
  // 每一页都在，后台刷新失败不该每页都喊一次。
  useEffect(() => {
    void loadWorkspace().catch(() => {
      /* 错误已由 store 记录，这里不重复处理 */
    });
    void loadWorkspaces();
  }, [loadWorkspace, loadWorkspaces]);

  /**
   * 新建一段 fresh 会话，落到指定工作区（`null` = 未分组）。
   *
   * 顺序（切页 → 打开会话）由 `startNewConversationIn` 保证，这里只管
   * 防重、清理旧错误与失败提示；rail 的栏头按钮与组头「+」都走这一个入口。
   */
  const startNew = useCallback(
    async (workspace: string | null) => {
      if (opening) return;
      setOpening(true);
      setError("");
      try {
        await startNewConversationIn(workspace);
      } catch (err) {
        setError(
          err instanceof Error && err.message ? `新建会话失败：${err.message}` : "新建会话失败",
        );
      } finally {
        setOpening(false);
      }
    },
    [opening],
  );

  /**
   * d.197：会话内容搜索的请求入口。
   *
   * 必须是 `useCallback`：rail 的搜索 effect 以它为依赖，每次渲染都换新函数会让
   * 防抖定时器被反复重建（打字时永远发不出去，或者一发就重复发）。
   */
  const searchContent = useCallback(
    (query: string) => searchConversationContent(query, { limit: CONTENT_SEARCH_LIMIT }),
    [],
  );

  /**
   * d.198：左栏搜索命中 → 打开会话并落到那条消息。
   *
   * 先 `openConversation`（它会顺手清掉上一次没落位的跳转意图），再投递本次跳转；
   * 顺序反了会被那次清理抹掉。真正滚动与高亮由 ChatPage 消费投递槽后完成。
   */
  const openMessage = useCallback(
    (conversationId: string, messageId: string) => {
      openConversation(conversationId);
      requestMessageJump(conversationId, messageId);
    },
    [openConversation, requestMessageJump],
  );

  // 命令面板「新建会话」意图的消费点：侧栏常驻，所以任意页面点都能立刻建。
  // token 变化即触发（同一种意图连点两次也各自消费）；正有一段在新建时先不消费，
  // 等 `opening` 落回 false 后这个 effect 再跑一次，否则意图会被「这次新建」吞掉。
  useEffect(() => {
    if (paletteIntent?.kind !== "new-session") return;
    if (opening) return;
    consumePaletteIntent();
    void startNew(activeWorkspaceOf());
  }, [paletteIntent, consumePaletteIntent, startNew, opening]);

  /** 会话改名：失败时把原因放进栏底错误区（rail 保留输入供重试）。 */
  const renameConversationTitle = async (convId: string, title: string) => {
    try {
      await renameConversation(convId, title);
      setError("");
    } catch (err) {
      setError(err instanceof Error && err.message ? `改名失败：${err.message}` : "改名失败");
      throw err;
    }
  };

  /** 删除会话（二次确认后）：删的是整段对话与消息；正停在这段时回空态。 */
  const confirmDeleteConversation = async () => {
    if (!deleteTarget) return;
    const id = deleteTarget.id;
    setDeleteTarget(null);
    try {
      await deleteConversation(id);
      setError("");
      clearDraft(id);
      if (activeConversationId === id) useUiStore.setState({ activeConversationId: null });
    } catch (err) {
      setError(err instanceof Error && err.message ? `删除会话失败：${err.message}` : "删除会话失败");
    }
  };

  /** 待删会话的显示名：服务端 title → 首条消息 → 时间兜底（与 rail 一致）。 */
  const deleteTitle = deleteTarget ? conversationTitle(deleteTarget, messages[deleteTarget.id]) : "";

  return (
    <>
      <ConversationRail
        conversations={conversations}
        workspaces={workspaces}
        activeConversationId={activeConversationId}
        messages={messages}
        opening={opening}
        error={error}
        onOpen={openConversation}
        onOpenMessage={openMessage}
        onNewConversation={(workspace) => void startNew(workspace)}
        newSessionRequest={newSessionPickerRequest}
        onRename={(id, title) => renameConversationTitle(id, title)}
        onDeleteRequest={(conv) => setDeleteTarget(conv)}
        onMoveConversation={moveConversation}
        onAddWorkspace={addWorkspace}
        onError={setError}
        hasMore={conversationsHasMore}
        loadingMore={conversationsLoadingMore}
        onSearchContent={searchContent}
        onLoadMore={() => {
          void loadMoreConversations().catch((err) => {
            setError(
              err instanceof Error && err.message ? `加载更多失败：${err.message}` : "加载更多失败",
            );
          });
        }}
        topNav={<SidebarNav />}
        footer={
          <div className="flex flex-col gap-0.5">
            {/* 设置固定在栏底、账户之上：用户要的「设置放左下角」。 */}
            <button
              type="button"
              aria-current={page === "settings" ? "page" : undefined}
              onClick={() => setPage("settings")}
              className={sidebarRowClass(page === "settings")}
            >
              <GearIcon width={16} height={16} aria-hidden="true" className="shrink-0" />
              <span className="min-w-0 flex-1 truncate">设置</span>
            </button>
            <AccountMenu />
          </div>
        }
      />
      {deleteTarget ? (
        <ConfirmDialog
          title="删除这段会话"
          onCancel={() => setDeleteTarget(null)}
          footer={
            <>
              <Button type="button" onClick={() => setDeleteTarget(null)} size="md" variant="ghost">
                取消
              </Button>
              <Button
                type="button"
                onClick={() => void confirmDeleteConversation()}
                size="md" variant="danger"
              >
                删除
              </Button>
            </>
          }
        >
          <p className="text-ui-sm leading-6">
            删除「{deleteTitle}」？这段会话的消息会一起删除，不可恢复；
            其他会话不受影响。
          </p>
        </ConfirmDialog>
      ) : null}
    </>
  );
}
