/**
 * 按会话分的插话队列（d.226）。
 *
 * 为什么要有这个注册表：插话队列以前是**一个**共享实例，而两个会话是可以同时各跑
 * 一轮的（点开左栏另一条会话接着发就行）。共享一个队列时，A 会话插的话会被 B 会话
 * 的下一轮先取走——谁都不报错，但上下文串了：B 的模型突然看到一句没人对它说的话。
 *
 * 所以队列按会话分开，`of(conversationId)` 拿到的是那个会话自己的队；同一会话多次
 * 取回同一个实例（不然排队就白排）。`clear()` 只用于会话被删/整轮收口后的显式清空，
 * 平时不需要清——队列随会话走。
 */
import { createSteerQueue, type SteerQueue } from "./steer.js";

export interface SteerQueueRegistry {
  /** 取某个会话的插话队列；同一 id 永远返回同一个实例。 */
  of(conversationId: string): SteerQueue;
  /** 已经建过队列的会话数（测试与调试用；不是「有几条排队」）。 */
  size(): number;
  /** 清掉一个会话的队列；不给 id 则全清。 */
  clear(conversationId?: string): void;
}

export function createSteerQueueRegistry(): SteerQueueRegistry {
  const queues = new Map<string, SteerQueue>();
  return {
    of: (conversationId: string): SteerQueue => {
      const existing = queues.get(conversationId);
      if (existing) return existing;
      const created = createSteerQueue();
      queues.set(conversationId, created);
      return created;
    },
    size: (): number => queues.size,
    clear: (conversationId?: string): void => {
      if (conversationId === undefined) {
        queues.clear();
        return;
      }
      queues.delete(conversationId);
    },
  };
}
