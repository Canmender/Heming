/**
 * 订阅某会话「未跑完的一轮」（d.196）。
 *
 * 为什么要有 hook 而不是让侧栏自己读：写标记发生在 ChatPage（一轮开始/收口），
 * 侧栏是另一个组件树，靠轮询或父组件重渲染都会慢一拍。这里订阅 resumePoint 的
 * 事件，一处写入、所有徽标同时更新。
 */

import { useEffect, useState } from "react";
import { loadResumePoint, subscribeResumePoints, type ResumePoint } from "./resumePoint.js";

export function useResumePoint(conversationId: string | undefined): ResumePoint | null {
  const [point, setPoint] = useState<ResumePoint | null>(() =>
    conversationId ? loadResumePoint(conversationId) : null,
  );

  useEffect(() => {
    if (!conversationId) {
      setPoint(null);
      return;
    }
    const refresh = () => setPoint(loadResumePoint(conversationId));
    refresh(); // 挂载时补读一次：首帧 useState 与订阅之间可能已经变化
    return subscribeResumePoints(refresh);
  }, [conversationId]);

  return point;
}
