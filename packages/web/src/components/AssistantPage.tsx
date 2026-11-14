import { useCallback, useEffect, useMemo, useState } from "react";
import type { Conversation } from "@heming/shared";
import { SYSTEM_AGENT_ID } from "@heming/shared";
import { useChatStore } from "../store/chat.js";
import { useUiStore } from "../store/ui.js";
import { useLlmStore } from "../store/llm.js";
import { resolveBoundProfile } from "../lib/llmRoute.js";
import { ChatPage } from "./ChatPage.js";
import { ConfirmDialog } from "./ConfirmDialog.js";
import { clearDraft } from "../lib/drafts.js";
import { ConversationRail } from "./assistant/ConversationRail.js";
import { conversationTitle } from "./assistant/conversationTitle.js";
import { Button } from "./ui/Button.js";
import { EmptyState } from "./ui/EmptyState.js";

/**
 * 会话页（单智能体 · 会话模式，对齐 Codex / Claude Code）。
 *
 * 产品只剩**一个内置智能体**（`SYSTEM_AGENT`，不可创建/修改/删除），所以本页不再有
 * 一级 Tab、没有智能体选择页/名册/编辑页，也没有多智能体协作视图：
 *
 * - 左侧：`ConversationRail`，全部会话一条扁平列表（新建会话直接建 fresh 会话）；
 * - 右侧：有选中会话时是「状态条 + embedded ChatPage」，没有选中时是新建会话空态。
 *
 * 会话与模型数据全部来自既有 store（`useChatStore` / `useUiStore` / `useLlmStore`），
 * 本页不新增第二套状态。
 *
 * 意图消费：命令面板「新建会话」投递 `paletteIntent = new-session`，本页消费即建一段
 * fresh 会话（token 变化触发、消费即清，天然幂等）。旧导航意图（tasks / chat）已没有
 * 对应视图可切，读到就清掉，避免残留意图被别的页面消费。
 */
export function AssistantPage() {
  const conversations = useChatStore((s) => s.conversations);
  const messages = useChatStore((s) => s.messages);
  const loadWorkspace = useChatStore((s) => s.loadWorkspace);
  /** 首帧是否已拉到工作区 / 首帧失败原因（store 只在首帧写，后台刷新失败不推翻已就绪）。 */
  const workspaceReady = useChatStore((s) => s.workspaceReady);
  const workspaceError = useChatStore((s) => s.workspaceError);
  const openAgent = useChatStore((s) => s.openAgent);
  const renameConversation = useChatStore((s) => s.renameConversation);
  const deleteConversation = useChatStore((s) => s.deleteConversation);
  const conversationsHasMore = useChatStore((s) => s.conversationsHasMore);
  const conversationsLoadingMore = useChatStore((s) => s.conversationsLoadingMore);
  const loadMoreConversations = useChatStore((s) => s.loadMoreConversations);
  const activeConversationId = useUiStore((s) => s.activeConversationId);
  const openConversation = useUiStore((s) => s.openConversation);
  /** 一次性命令面板意图：`new-session` = 直接开始一段新会话（消费即清）。 */
  const paletteIntent = useUiStore((s) => s.paletteIntent);
  const consumePaletteIntent = useUiStore((s) => s.consumePaletteIntent);
  const pageView = useUiStore((s) => s.pageView);

  // 绑定状态只用于状态条上的「模型已绑定」提示。
  const llmBindings = useLlmStore((s) => s.bindings);
  const llmRoutes = useLlmStore((s) => s.routes);
  const llmProfiles = useLlmStore((s) => s.profiles);

  /** 正在新建会话（防重；同时作为 rail 的 busy 态）。 */
  const [opening, setOpening] = useState(false);
  /** 新建 / 改名 / 删除 / 加载更多的失败原因：进 rail 底部错误区，不挡列表。 */
  const [error, setError] = useState("");
  /** 待确认删除的会话：rail 只发请求，二次确认在页面上统一做。 */
  const [deleteTarget, setDeleteTarget] = useState<Conversation | null>(null);

  // 旧导航意图（tasks / chat）已没有对应视图可切：读走即清，避免残留意图被别的页面消费。
  useEffect(() => {
    if (pageView) useUiStore.getState().consumePageView();
  }, [pageView]);

  // 会话从服务端取：会话页是独立入口，不依赖用户先去别的页。
  // 首帧失败由 store 记录（workspaceError，仅首帧写）并上屏 + 给「重试」；
  // 后台刷新失败不提示——旧数据仍可用，弹一次「失败」反而更吓人。
  useEffect(() => {
    void loadWorkspace().catch(() => {
      /* 错误已由 store 记录，这里不重复处理 */
    });
  }, [loadWorkspace]);

  const retryLoad = useCallback(() => {
    void loadWorkspace().catch(() => {});
  }, [loadWorkspace]);

  /**
   * 新建一段 fresh 会话并打开：单智能体下不再需要「先选一个智能体」。
   * 所有「新建会话」入口（rail 顶部、rail 空态、主区空态、命令面板意图）共用它。
   */
  const startNewConversation = useCallback(async () => {
    if (opening) return;
    setOpening(true);
    setError("");
    try {
      // fresh：每段对话彼此独立保存，绝不复用上一段（Claude Code 式多段对话）。
      const convId = await openAgent(SYSTEM_AGENT_ID, { fresh: true });
      openConversation(convId);
    } catch (err) {
      setError(err instanceof Error && err.message ? `新建会话失败：${err.message}` : "新建会话失败");
    } finally {
      setOpening(false);
    }
  }, [opening, openAgent, openConversation]);

  // 命令面板「新建会话」意图的消费点：本页是懒加载路由，可能晚一帧才挂载，
  // 所以放在挂载后的 effect 里读；token 变化即触发（同一种意图连点两次也各自消费）。
  useEffect(() => {
    if (paletteIntent?.kind !== "new-session") return;
    // 正有一段在新建：先不清意图，等 `opening` 落回 false 后这个 effect 再跑一次再消费，
    // 否则意图会被「这次新建」吞掉。
    if (opening) return;
    consumePaletteIntent();
    void startNewConversation();
  }, [paletteIntent, consumePaletteIntent, startNewConversation, opening]);

  const activeConv = conversations.find((c) => c.id === activeConversationId);
  const activeAgentBound = useMemo(
    () => (activeConv ? Boolean(resolveBoundProfile(activeConv.agent.id)) : false),
    // llm* 一并进 deps：绑定变化后「模型已绑定」提示要跟着变
    [activeConv, llmBindings, llmRoutes, llmProfiles],
  );

  /** 会话改名：失败时把原因放进页内错误条（rail 保留输入供重试）。 */
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
  const deleteTitle = deleteTarget
    ? conversationTitle(deleteTarget, messages[deleteTarget.id])
    : "";

  /** 首载失败的提示文案：只在还没成功过时提示（成功过的后台刷新失败不提示）。 */
  const loadFailure = !workspaceReady && workspaceError ? `会话列表加载失败：${workspaceError}` : null;

  return (
    <div className="flex h-full min-h-0 min-w-0 flex-col bg-surface">
      {/* 视觉上不再有厚页头（复刻 ChatGPT / Claude 的极简对话布局）；h1 保留给读屏与设计审计。 */}
      <h1 className="sr-only">会话</h1>
      <div className="flex min-h-0 flex-1 flex-col">
        {loadFailure ? (
          <div
            role="alert"
            className="ui-alert ui-alert-danger mx-3 mt-3 flex flex-wrap items-center gap-2"
          >
            <span className="min-w-0 flex-1">{loadFailure}</span>
            <Button type="button" size="sm" variant="ghost" onClick={retryLoad}>
              重试
            </Button>
          </div>
        ) : null}
        <div className="flex min-h-0 flex-1">
          <ConversationRail
            conversations={conversations}
            activeConversationId={activeConversationId}
            messages={messages}
            opening={opening}
            error={error}
            onOpen={openConversation}
            onNewConversation={() => void startNewConversation()}
            onRename={(id, title) => renameConversationTitle(id, title)}
            onDeleteRequest={(conv) => setDeleteTarget(conv)}
            hasMore={conversationsHasMore}
            loadingMore={conversationsLoadingMore}
            onLoadMore={() => {
              void loadMoreConversations().catch((err) => {
                setError(
                  err instanceof Error && err.message
                    ? `加载更多失败：${err.message}`
                    : "加载更多失败",
                );
              });
            }}
          />

          <section className="flex min-w-0 flex-1 flex-col">
            {activeConv ? (
              <>
                {/* 会话顶部元信息条：极轻的一行（会话归属 / 模型绑定 / 去模型页），
                    无边框、无底色；下方 ChatPage 自己的顶栏只留通道状态与 ghost 图标。 */}
                <div className="flex h-10 shrink-0 items-center gap-2 px-5 text-ui-xs text-muted">
                  <span className="min-w-0 truncate">与 {activeConv.agent.name} 的会话</span>
                  <span
                    className={`shrink-0 rounded-full border px-2 py-px ${
                      activeAgentBound
                        ? "border-line text-muted"
                        : "border-warn-line bg-warn-soft text-warn"
                    }`}
                    title={activeAgentBound ? undefined : "还没有绑定模型，发送会失败"}
                  >
                    {activeAgentBound ? "模型已绑定" : "未绑定模型"}
                  </span>
                  <span className="ml-auto flex items-center gap-1">
                    <Button
                      size="sm"
                      variant="ghost"
                      className="ui-hit text-muted"
                      onClick={() => useUiStore.getState().setPage("model")}
                    >
                      模型设置
                    </Button>
                  </span>
                </div>
                <div className="flex min-h-0 flex-1 flex-col">
                  {/* embedded：隐藏 ChatPage 自己的「返回工作区」按钮（返回会切页并卸载会话）。 */}
                  <ChatPage embedded />
                </div>
              </>
            ) : (
              <div className="flex min-h-0 flex-1 items-center justify-center px-6 py-10">
                <EmptyState
                  className="max-w-[360px]"
                  title="开始新会话"
                  desc="每段会话彼此独立保存；也可以从左侧选择历史会话继续。"
                  actions={
                    <Button
                      type="button"
                      size="md"
                      variant="primary"
                      busy={opening}
                      onClick={() => void startNewConversation()}
                    >
                      {opening ? "新建中…" : "新建会话"}
                    </Button>
                  }
                />
              </div>
            )}
          </section>
        </div>
      </div>
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
    </div>
  );
}