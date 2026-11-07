/**
 * 「停止某个会话正在跑的所有流」的跨组件登记表（d.86）。
 *
 * 为什么需要它：中断能力原本只在 ChatPage 内部（`runsRef` + abortAll），
 * 而任务区右栏的「确定性汇总」是另一个组件——用户在那里看到「运行中」，
 * 却没有任何停止入口（审计 P1-3）。把「哪个会话由谁负责中断」登记成一张表，
 * 汇总卡就能按 conversationId 找到真正的执行者，而不必把 ChatPage 的内部状态上提。
 *
 * 约束：
 * - 只登记「当前挂载的 ChatPage 实例」，卸载即注销（不会把中断发给已销毁的组件）；
 * - 同一会话多个实例（理论上不该有）后登记的覆盖先登记的，注销时只注销自己那一个。
 */

type AbortFn = () => void;

const handlers = new Map<string, AbortFn>();

/** 登记某会话的中断函数；返回注销函数（幂等）。 */
export function registerConversationAbort(conversationId: string, abort: AbortFn): () => void {
  handlers.set(conversationId, abort);
  return () => {
    if (handlers.get(conversationId) === abort) handlers.delete(conversationId);
  };
}

/**
 * 请求中断某会话正在跑的流。
 * @returns 是否找到了正在运行的执行者（false = 该会话当前不在任何挂载中的页面里）。
 */
export function abortConversation(conversationId: string): boolean {
  const abort = handlers.get(conversationId);
  if (!abort) return false;
  abort();
  return true;
}

/** 测试用：清空登记表（生产不调用）。 */
export function resetConversationAbortsForTests(): void {
  handlers.clear();
}
