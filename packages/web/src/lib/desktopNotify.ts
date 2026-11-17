export interface DesktopNotifyPayload {
  title: string;
  body: string;
  conversationId?: string;
}

/**
 * 系统通知开关的存储键（d.208）。
 *
 * 默认开：它只在「窗口不在前台」时才会真的弹（见 `notifyDesktop` 的三个前提），
 * 不是噪音；但确实有人不想被系统弹窗打扰，所以给一个能关的开关。
 */
export const DESKTOP_NOTIFY_KEY = "heming.desktopNotify.v1";

function readEnabled(): boolean {
  if (typeof localStorage === "undefined") return true;
  try {
    const raw = localStorage.getItem(DESKTOP_NOTIFY_KEY);
    // 只认显式的 "0"：没存过（新装/旧版升级）按开处理。
    return raw !== "0";
  } catch {
    return true;
  }
}

/** 系统通知是否开启（缺省开）。 */
export function isDesktopNotifyEnabled(): boolean {
  return readEnabled();
}

/** 开关系统通知；返回写入后的状态。 */
export function setDesktopNotifyEnabled(enabled: boolean): boolean {
  const next = enabled === true;
  try {
    localStorage.setItem(DESKTOP_NOTIFY_KEY, next ? "1" : "0");
  } catch {
    /* 存储不可用就按内存里的入参返回，不影响本轮 */
  }
  return next;
}

/**
 * 请求桌面主进程弹系统通知。
 *
 * 三个前提缺一不可：有桥（桌面端）、窗口不在前台、调用不抛。
 * 窗口聚焦时应用内通知已经足够，再弹系统通知是噪音；用户关了开关也不弹。
 */
export function notifyDesktop(payload: DesktopNotifyPayload): boolean {
  if (typeof window === "undefined") return false;
  if (!readEnabled()) return false;
  const bridge = window.__heming_notify;
  if (!bridge || typeof bridge.message !== "function") return false;
  if (typeof document !== "undefined" && typeof document.hasFocus === "function" && document.hasFocus()) {
    return false;
  }
  try {
    bridge.message(payload);
    return true;
  } catch {
    return false;
  }
}

/**
 * 订阅「用户点了系统通知」（d.208）。
 *
 * 主进程点击通知会把主窗口拉回前台并发 `notify:open`（d.39 的通知桥早就有这条回传，
 * 只是一直没人接）——接上之后点通知就能回到那个会话，而不是回到「某个」会话。
 */
export function onDesktopNotifyOpen(handler: (conversationId: string | null) => void): () => void {
  if (typeof window === "undefined") return () => {};
  const bridge = window.__heming_notify;
  if (!bridge || typeof bridge.onOpen !== "function") return () => {};
  try {
    const off = bridge.onOpen((conversationId) => {
      try {
        handler(conversationId ?? null);
      } catch {
        /* 界面回调异常不影响通知链路 */
      }
    });
    return typeof off === "function" ? off : () => {};
  } catch {
    return () => {};
  }
}
