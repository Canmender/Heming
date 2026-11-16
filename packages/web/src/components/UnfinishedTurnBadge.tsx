/**
 * 侧栏会话行上的「未跑完」徽标（d.196）。
 *
 * 为什么要有：多会话来回看的时候，「哪一段活还没做完」完全看不见——只有打开那个会话
 * 才会弹出「继续」条。长任务最怕的就是「我以为它做完了」「我忘了还有一半没跑」。
 *
 * 口径：只说明「这一轮没跑完」，不猜进度、不催用户；不代表任务失败（用户主动停下也算）。
 */

import { useResumePoint } from "../lib/agentRuntime/useResumePoint.js";

export function UnfinishedTurnBadge({ conversationId }: { conversationId: string }) {
  const point = useResumePoint(conversationId);
  if (!point) return null;
  return (
    <span className="ui-chip" title="这一轮没有跑完：打开会话可以点「继续」">
      未跑完
    </span>
  );
}
