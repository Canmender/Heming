import { SYSTEM_AGENT_ID } from "@heming/shared";
import { useChatStore } from "../store/chat.js";
import { useUiStore } from "../store/ui.js";

/**
 * 新建一段 fresh 会话并打开（单智能体，无需再选人）。
 *
 * 为什么抽成独立函数而不是留在某个组件里：侧栏「新对话」、会话页空态、命令面板意图
 * 三个入口都要「建一段、切到会话页、选中它」，且顺序有讲究——`setPage("chat")` 会清掉
 * 选中会话（离开页面的纪律），所以必须**先切页、再 openConversation**，否则刚建好的
 * 会话立刻被清空，用户看到空态。把顺序固化成一处，避免第三个入口再踩一遍。
 *
 * 失败时抛错，由调用方转成各自位置的提示文案（侧栏栏底 / 页面空态）。
 */
export async function startNewConversation(): Promise<void> {
  await startNewConversationIn(null);
}

/**
 * 新建一段 fresh 会话并打开，落在指定工作区（`null` = 未分组）。
 *
 * 侧栏组头的「+」用它把新对话直接建在某个文件夹下；工作区只是归属标签，
 * 不会因此让会话拿到本机文件读写能力。
 */
export async function startNewConversationIn(workspace: string | null): Promise<void> {
  // fresh：每段对话彼此独立保存，绝不复用上一段（Claude Code 式多段对话）。
  const convId = await useChatStore
    .getState()
    .openAgent(SYSTEM_AGENT_ID, { fresh: true, ...(workspace ? { workspace } : {}) });
  const ui = useUiStore.getState();
  if (ui.page !== "chat") ui.setPage("chat");
  ui.openConversation(convId);
}
