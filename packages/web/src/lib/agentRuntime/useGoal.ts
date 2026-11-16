/**
 * 订阅「当前会话的目标」的 React hook（d.201）。
 *
 * 与 `lib/todo/useTodos.ts` 同一套路：store 是模块级内存 + localStorage，`/goal` 命令或
 * 别的组件改了目标后，组件不会自动重渲，必须订阅。挂载时补读一次，避免初始化与订阅
 * 之间漏掉变更。
 */
import { useEffect, useState } from "react";
import { getGoal, subscribeGoals, type SessionGoal } from "../agentRuntime/goal.js";

/** 某个会话的目标（没有返回 null；别的会话变更不触发重算）。 */
export function useGoal(conversationId: string | undefined): SessionGoal | null {
  const [goal, setGoal] = useState<SessionGoal | null>(() =>
    conversationId ? getGoal(conversationId) : null,
  );

  useEffect(() => {
    const read = () => setGoal(conversationId ? getGoal(conversationId) : null);
    read();
    return subscribeGoals((changed) => {
      if (changed && conversationId && changed !== conversationId) return;
      read();
    });
  }, [conversationId]);

  return goal;
}
