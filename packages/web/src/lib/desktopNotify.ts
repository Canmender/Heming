export interface DesktopNotifyPayload {
  title: string;
  body: string;
  conversationId?: string;
}

/**
 * 请求桌面主进程弹系统通知。
 *
 * 三个前提缺一不可：有桥（桌面端）、窗口不在前台、调用不抛。
 * 窗口聚焦时应用内通知已经足够，再弹系统通知是噪音。
 */
export function notifyDesktop(payload: DesktopNotifyPayload): boolean {
  if (typeof window === "undefined") return false;
  const bridge = window.__heming_notify;
  if (!bridge || typeof bridge.message !== "function") return false;
  if (typeof document !== "undefined" && document.hasFocus()) return false;
  try {
    bridge.message(payload);
    return true;
  } catch {
    return false;
  }
}
