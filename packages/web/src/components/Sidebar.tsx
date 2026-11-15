import { useCallback, useEffect, useState } from "react";
import type { Conversation } from "@heming/shared";
import { useChatStore } from "../store/chat.js";
import { useUiStore } from "../store/ui.js";
import { clearDraft } from "../lib/drafts.js";
import { startNewConversation } from "../lib/newConversation.js";
import { ConversationRail } from "./assistant/ConversationRail.js";
import { conversationTitle } from "./assistant/conversationTitle.js";
import { AccountMenu } from "./AccountMenu.js";
import { SidebarNav, sidebarRowClass } from "./SidebarNav.js";
import { ConfirmDialog } from "./ConfirmDialog.js";
import { GearIcon } from "./icons.js";
import { Button } from "./ui/Button.js";

/**
 * 常驻会话侧栏（应用外壳的一部分，所有页面都在左侧）。
 *
 * 为什么从 AssistantPage 里搬出来：导航轨删除后，会话列表不再是「会话页的一个子视图」，
 * 而是与顶栏同级的外壳结构——从设置页也应该能一眼看到并切回历史会话。数据与动作
 * 仍然是会话 store 那一套，本组件只负责把 rail 需要的东西接上（含新建/改名/删除的
 * 失败提示与二次确认），不新增第二套状态。
 *
 * 会话从服务端取：侧栏挂载即拉一次，不依赖用户先去某个页面。
 */
export function Sidebar() {
  const conversations = useChatStore((s) => s.conversations);
  const messages = useChatStore((s) => s.messages);
  const loadWorkspace = useChatStore((s) => s.loadWorkspace);
  const openConversation = useUiStore((s) => s.openConversation);
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
  const consumePaletteIntent = useUiStore((s) => s.consumePaletteIntent);

  /** 正在新建会话（防重；同时作为 rail 的 busy 态）。 */
  const [opening, setOpening] = useState(false);
  /** 新建 / 改名 / 删除 / 加载更多的失败原因：进 rail 底部错误区，不挡列表。 */
  const [error, setError] = useState("");
  /** 待确认删除的会话：rail 只发请求，二次确认统一放在侧栏做。 */
  const [deleteTarget, setDeleteTarget] = useState<Conversation | null>(null);

  // 首帧失败由 store 记录（workspaceError，仅首帧写），会话页负责提示 + 重试；
  // 这里故意不弹错误——侧栏在每一页都在，后台刷新失败不该每页都喊一次。
  useEffect(() => {
    void loadWorkspace().catch(() => {
      /* 错误已由 store 记录，这里不重复处理 */
    });
  }, [loadWorkspace]);

  const startNew = useCallback(async () => {
    if (opening) return;
    setOpening(true);
    setError("");
    try {
      await startNewConversation();
    } catch (err) {
      setError(err instanceof Error && err.message ? `新建会话失败：${err.message}` : "新建会话失败");
    } finally {
      setOpening(false);
    }
  }, [opening]);

  // 命令面板「新建会话」意图的消费点：侧栏常驻，所以任意页面点都能立刻建。
  // token 变化即触发（同一种意图连点两次也各自消费）；正有一段在新建时先不消费，
  // 等 `opening` 落回 false 后这个 effect 再跑一次，否则意图会被「这次新建」吞掉。
  useEffect(() => {
    if (paletteIntent?.kind !== "new-session") return;
    if (opening) return;
    consumePaletteIntent();
    void startNew();
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
        activeConversationId={activeConversationId}
        messages={messages}
        opening={opening}
        error={error}
        onOpen={openConversation}
        onNewConversation={() => void startNew()}
        onRename={(id, title) => renameConversationTitle(id, title)}
        onDeleteRequest={(conv) => setDeleteTarget(conv)}
        hasMore={conversationsHasMore}
        loadingMore={conversationsLoadingMore}
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
