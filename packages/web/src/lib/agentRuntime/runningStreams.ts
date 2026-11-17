/**
 * 侧栏「哪几个会话正在跑」（d.212）。
 *
 * 为什么需要它：长任务里最常见的错觉是「屏幕没动 = 它没在干活」。在会话 A 里派了一轮
 * 要跑几分钟的活，切到会话 B 看别的东西，左栏里 A 和别的会话长得一模一样——用户会以为
 * 那一轮已经停了，于是回去重发一遍，或者干脆把整个应用关掉。
 *
 * 口径（三条，都是为了不撒谎）：
 *
 * 1. **只认本机起的流**：`streamOwner[id]` 为真才算。WebSocket 回声也会往 `streaming`
 *    里写条目（别的窗口/别的设备起的同一条流），那不是「这个窗口在跑」的事实，跟着
 *    点一下就会在左栏闪出别的设备的进度，误导性比不显示更大。
 * 2. **只认 `status === "streaming"`**：`error` 已经收场（界面上是错误消息 + 「重试」），
 *    留着标记会让人以为还在等一个已经失败的结果。
 * 3. **按会话去重、无会话的条目丢弃**：一个会话在同一时刻只可能有一条本机主流，但
 *    store 里曾经出现过同会话两条（重连/重试的残留），去重后左栏只亮一个点。
 *
 * 纯函数：输入是两个 store 切片，输出是会话 id 列表，不读时间、不读存储——测试可以直接
 * 摆数据验口径，不用起界面。
 */

/** `streaming` 切片里这一层需要的字段（结构化类型，不反向依赖 store）。 */
export interface RunningStreamLike {
  conversationId: string;
  status: string;
}

/** 计算「正在跑」的会话 id 列表（顺序按 `streaming` 的键序，调用方按需再说）。 */
export function runningConversationIds(
  streaming: Record<string, RunningStreamLike | undefined>,
  streamOwner: Record<string, true | undefined>,
): string[] {
  if (!streaming || typeof streaming !== "object") return [];
  if (!streamOwner || typeof streamOwner !== "object") return [];
  /** 用 Set 而不是 `includes`：条目虽少，但这一步在每个会话行上都会算。 */
  const seen = new Set<string>();
  const out: string[] = [];
  for (const [id, state] of Object.entries(streaming)) {
    if (!state || state.status !== "streaming") continue;
    if (streamOwner[id] !== true) continue;
    const conversationId = typeof state.conversationId === "string" ? state.conversationId.trim() : "";
    if (!conversationId || seen.has(conversationId)) continue;
    seen.add(conversationId);
    out.push(conversationId);
  }
  return out;
}

/** 单个会话是否正在跑（左栏每一行用；口径同 `runningConversationIds`）。 */
export function isConversationRunning(
  conversationId: string,
  streaming: Record<string, RunningStreamLike | undefined>,
  streamOwner: Record<string, true | undefined>,
): boolean {
  const id = String(conversationId ?? "").trim();
  if (!id) return false;
  return runningConversationIds(streaming, streamOwner).includes(id);
}
