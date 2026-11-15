import { useCallback, useEffect, useState } from "react";
import { useChatStore } from "../store/chat.js";
import { useUiStore } from "../store/ui.js";
import { startNewConversation } from "../lib/newConversation.js";
import { ChatPage } from "./ChatPage.js";
import { Button } from "./ui/Button.js";
import { EmptyState } from "./ui/EmptyState.js";

/**
 * 会话页：只剩「对话本体」。
 *
 * 导航轨删除后，会话列表搬到常驻侧栏（`Sidebar`），页面顶部那条「与 X 的会话 / 模型绑定」
 * 元信息条也去掉了——ChatPage 自己的极简顶栏本来就带智能体名与通道状态，两条叠在一起
 * 是同一件事说两遍。本页现在只负责：有选中会话就渲染对话，没有就给一个新建入口。
 */
export function AssistantPage() {
  const conversations = useChatStore((s) => s.conversations);
  const workspaceReady = useChatStore((s) => s.workspaceReady);
  const workspaceError = useChatStore((s) => s.workspaceError);
  const loadWorkspace = useChatStore((s) => s.loadWorkspace);
  const activeConversationId = useUiStore((s) => s.activeConversationId);
  const pageView = useUiStore((s) => s.pageView);

  /** 空态里点「新建会话」：失败原因就地显示（侧栏同时也会显示各自那份）。 */
  const [error, setError] = useState("");
  const [opening, setOpening] = useState(false);

  // 旧导航意图（tasks / chat）已没有对应视图可切：读走即清，避免残留意图被别的页面消费。
  useEffect(() => {
    if (pageView) useUiStore.getState().consumePageView();
  }, [pageView]);

  const retryLoad = useCallback(() => {
    void loadWorkspace().catch(() => {});
  }, [loadWorkspace]);

  const onCreate = async () => {
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
  };

  /** 首载失败的提示文案：只在还没成功过时提示（成功过的后台刷新失败不提示）。 */
  const loadFailure = !workspaceReady && workspaceError ? `会话列表加载失败：${workspaceError}` : null;
  const activeConv = conversations.find((c) => c.id === activeConversationId);

  return (
    <div className="flex h-full min-h-0 min-w-0 flex-col bg-surface">
      {/* 视觉上不再有厚页头（复刻 ChatGPT / Claude 的极简对话布局）；h1 保留给读屏与设计审计。 */}
      <h1 className="sr-only">会话</h1>
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
      {error ? (
        <p role="alert" className="mx-3 mt-2 text-ui-sm text-danger">
          {error}
        </p>
      ) : null}
      {activeConv ? (
        <div className="flex min-h-0 flex-1 flex-col">
          <ChatPage />
        </div>
      ) : (
        <div className="flex min-h-0 flex-1 items-center justify-center px-6 py-10">
          <EmptyState
            className="max-w-[360px]"
            titleAs="h2"
            title="开始新会话"
            desc="每段会话彼此独立保存；也可以从左侧会话列表继续历史会话。"
            actions={
              <Button
                type="button"
                size="md"
                variant="primary"
                busy={opening}
                onClick={() => void onCreate()}
              >
                {opening ? "新建中…" : "新建会话"}
              </Button>
            }
          />
        </div>
      )}
    </div>
  );
}
