import type { WsServerEvent } from "@heming/shared";

/**
 * 会话事件的进程内总线（d.298）。
 *
 * 为什么需要它：HTTP 路由和 WebSocket 是两个入口，但「谁需要知道这件事」是业务语义，
 * 不该由入口决定。`POST /api/conversations/:id/messages/delete` 改完库之后要通知所有
 * 同会话的连接——那条链路在 `ws.ts` 里（`socketsByUser`），路由拿不到它。
 *
 * 为什么不用 EventEmitter：这里只需要「发布一条、谁订阅谁收」，没有通配符、没有
 * once、也不该有监听器泄漏的复杂度；一个 Set 就够了，订阅返回退订函数。
 *
 * 约定：
 * - 监听器抛错**不能**影响发布方——删除已经成功，广播失败只是「别的窗口晚一点知道」，
 *   不该让请求变成 500；
 * - 遍历时复制一份列表：监听器里退订不会让这一轮的其他人被跳过。
 */

export interface ConversationBroadcast {
  conversationId: string;
  event: WsServerEvent;
}

type Listener = (broadcast: ConversationBroadcast) => void;

const listeners = new Set<Listener>();

/** 订阅；返回退订函数（可重复调用）。 */
export function subscribeBroadcasts(listener: Listener): () => void {
  listeners.add(listener);
  return () => {
    listeners.delete(listener);
  };
}

/** 发布一条会话事件；没有订阅者时什么也不做。 */
export function publishBroadcast(broadcast: ConversationBroadcast): void {
  for (const listener of [...listeners]) {
    try {
      listener(broadcast);
    } catch {
      /* 广播失败不能影响请求本身：删除已经落库了 */
    }
  }
}

/** 清空订阅（测试隔离用；生产代码不调用）。 */
export function resetBroadcasts(): void {
  listeners.clear();
}

/** 当前订阅者数量（测试断言用）。 */
export function broadcastListenerCount(): number {
  return listeners.size;
}
