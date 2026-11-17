/**
 * 侧栏会话行上的「正在跑」徽标（d.212）。
 *
 * 为什么要有：在会话 A 里派了一轮要跑几分钟的活，切到会话 B 看别的，左栏里 A 与其它
 * 会话长得一模一样——用户会以为那一轮已经停了，于是回去重发一遍，或者干脆关掉应用。
 * 「未跑完」（d.196）说的是**过去**没跑完，这个说的是**此刻**还在跑，两者不能互相替代。
 *
 * 口径：只说明「这一窗口正在跑」，不写进度、不写百分比（那是子代理/作业面板的事）。
 * 流一收口（成功或出错）就消失；不闪烁、不留痕。
 */

import { useRunningConversations } from "../lib/agentRuntime/useRunningConversations.js";

export function RunningTurnBadge({ conversationId }: { conversationId: string }) {
  const running = useRunningConversations();
  if (!running.has(conversationId)) return null;
  return (
    <span className="ui-chip shrink-0" title="这一轮还在跑：模型或工具正在工作" aria-label="正在跑">
      正在跑
    </span>
  );
}
