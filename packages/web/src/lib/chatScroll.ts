/**
 * 会话消息列表的阅读位置（d.83）：刷新/切回来仍停在原来读到的地方。
 *
 * 存储口径与页面/Tab 快照一致：**sessionStorage（刷新保留、关窗清空）**。
 * 每次使用（一次渲染进程会话）记住自己读到哪，关掉应用再开回到最新消息。
 *
 * 为什么不用 localStorage：阅读位置是「这一次使用」的上下文，不是需要长期记住的偏好；
 * 而且 localStorage 会被记忆导出/清理等流程牵扯，没必要。
 *
 * 为什么按会话 id 分键：同一个 convId 的阅读位置只对它自己有意义；切到别的会话
 * 不该被上一个会话的位置影响（切会话仍然从最新开始看，见 ChatPage 的切会话 effect）。
 */

const PREFIX = "heming.chatScroll.v1:";

export interface ChatScrollSnapshot {
  /** 滚动容器 scrollTop（px）。 */
  top: number;
  /** 当时是否贴着最新消息：贴底就继续贴底，不强行恢复像素位置。 */
  atBottom: boolean;
  /** 当时的窗口大小（d.33 窗口化只增不减）：恢复时至少要展开到这一窗，否则深历史回不去。 */
  windowCount: number;
}

/** 合法的会话 id：uuid / 安全字符；超长或怪字符不写盘（避免存储键被污染）。 */
function safeConvId(convId: string): string | null {
  if (typeof convId !== "string" || !convId.trim()) return null;
  if (convId.length > 128) return null;
  return /^[A-Za-z0-9_-]+$/.test(convId) ? convId : null;
}

function storage(): Pick<Storage, "getItem" | "setItem"> | null {
  if (typeof window === "undefined") return null;
  try {
    return window.sessionStorage;
  } catch {
    return null;
  }
}

export function chatScrollKey(convId: string): string {
  return `${PREFIX}${convId}`;
}

/** 读某会话的阅读位置；缺失/脏值/不合法一律回落 null（别猜，回最新消息最安全）。 */
export function readChatScroll(
  convId: string,
  store: Pick<Storage, "getItem"> | null = storage(),
): ChatScrollSnapshot | null {
  const id = safeConvId(convId);
  if (!id || !store) return null;
  try {
    const raw = store.getItem(chatScrollKey(id));
    if (!raw) return null;
    const parsed: unknown = JSON.parse(raw);
    if (!parsed || typeof parsed !== "object") return null;
    const data = parsed as { top?: unknown; atBottom?: unknown; windowCount?: unknown };
    const top = typeof data.top === "number" && Number.isFinite(data.top) && data.top >= 0 ? data.top : NaN;
    const windowCount =
      typeof data.windowCount === "number" && Number.isInteger(data.windowCount) && data.windowCount > 0
        ? Math.min(data.windowCount, 10_000)
        : NaN;
    if (!Number.isFinite(top) || !Number.isFinite(windowCount)) return null;
    return { top, atBottom: data.atBottom === true, windowCount };
  } catch {
    return null;
  }
}

/** 写某会话的阅读位置；写失败/非法 id 静默（刷新回最新消息不是错误）。 */
export function writeChatScroll(
  convId: string,
  snapshot: ChatScrollSnapshot,
  store: Pick<Storage, "setItem"> | null = storage(),
): void {
  const id = safeConvId(convId);
  if (!id || !store) return;
  const top = Number.isFinite(snapshot.top) && snapshot.top >= 0 ? Math.round(snapshot.top) : 0;
  const windowCount =
    Number.isInteger(snapshot.windowCount) && snapshot.windowCount > 0
      ? Math.min(snapshot.windowCount, 10_000)
      : 1;
  try {
    store.setItem(
      chatScrollKey(id),
      JSON.stringify({ top, atBottom: snapshot.atBottom === true, windowCount }),
    );
  } catch {
    /* 配额满/隐私模式：忽略 */
  }
}
