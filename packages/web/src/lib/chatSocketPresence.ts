/**
 * 当前有多少个 ChatPage 实例持有（或将持有）WS 连接。
 *
 * 页面名不足以判断：任务区会嵌入一个 ChatPage（embedded），此时 App 壳
 * 不能再开后台连接，否则同一条消息会被两条连接各处理一次，
 * 对用户正在看的会话产生伪未读/多余通知。
 */
let count = 0;
let version = 0;
const listeners = new Set<() => void>();

function notify(): void {
  version += 1;
  for (const listener of [...listeners]) {
    try {
      listener();
    } catch {
      /* 订阅者异常不影响其它订阅 */
    }
  }
}

/** ChatPage 挂载时注册；返回幂等的注销函数（重复调用只减一次）。 */
export function registerChatSocket(): () => void {
  count += 1;
  notify();
  let done = false;
  return () => {
    if (done) return;
    done = true;
    count = Math.max(0, count - 1);
    notify();
  };
}

export function chatSocketCount(): number {
  return count;
}

/** 供 useSyncExternalStore 取快照：每次注册/注销递增。 */
export function chatSocketVersion(): number {
  return version;
}

export function subscribeChatSocket(listener: () => void): () => void {
  listeners.add(listener);
  return () => {
    listeners.delete(listener);
  };
}

/** 测试隔离：清掉计数、版本与订阅者假象（listeners 保留其自身订阅生命周期）。 */
export function resetChatSocketPresenceForTest(): void {
  count = 0;
  version = 0;
}
