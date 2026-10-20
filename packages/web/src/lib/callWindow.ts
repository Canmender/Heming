/**
 * 通话窗口：把通话 UI 放到独立窗口里（用户要求「语音和视频聊天点击后应该开启一个新窗口」）。
 *
 * 为什么要独立窗口：通话面板盖满主界面（fixed inset-0），用户无法一边看消息一边通话。
 * 独立窗口同时解决「主界面被遮挡」和「窗口可拖动/可置顶」两件事。
 *
 * 状态边界：新窗口是**独立渲染进程**（Electron 下是独立 BrowserWindow），有自己的 WS 连接
 * 与 RTCPeerConnection；因此发起通话这一步必须由新窗口自己做，主窗口只负责开窗。
 * 同源（app://heming 或同站点）意味着 localStorage 里的 token 天然共享，不需要额外传凭证。
 */

export type CallMode = "voice" | "video";

export interface CallWindowParams {
  conversationId: string;
  /** 被叫用户 id 列表（群聊 Mesh：逐个邀请）。 */
  peerIds: string[];
  mode: CallMode;
  /** 窗口标题（会话名），仅用于展示。 */
  title?: string;
}

/** 窗口名固定：重复点击复用同一个通话窗口，不会开出一堆。 */
export const CALL_WINDOW_NAME = "heming-call";

/** 窗口尺寸：竖版窄窗，足够放视频网格与按钮，又不挡主窗口。 */
export const CALL_WINDOW_FEATURES = "popup=yes,width=420,height=640,left=200,top=120";

/**
 * 构造通话窗口 URL（纯函数，便于单测）。
 * 基址取当前页面去掉 query/hash 的部分，保证同源。
 */
export function buildCallWindowUrl(baseHref: string, p: CallWindowParams): string {
  const base = baseHref.split("#")[0].split("?")[0];
  const q = new URLSearchParams({
    hemingWindow: "call",
    conv: p.conversationId,
    peers: p.peerIds.join(","),
    mode: p.mode,
  });
  if (p.title) q.set("title", p.title);
  return `${base}?${q.toString()}`;
}

/** 从 location.search 还原参数；不是通话窗口或参数不合法时返回 null。 */
export function parseCallWindowParams(search: string): CallWindowParams | null {
  const q = new URLSearchParams(search);
  if (q.get("hemingWindow") !== "call") return null;
  const conversationId = q.get("conv") ?? "";
  if (!conversationId) return null;
  const peers = (q.get("peers") ?? "").split(",").map((s) => s.trim()).filter(Boolean);
  if (peers.length === 0) return null;
  const mode: CallMode = q.get("mode") === "video" ? "video" : "voice";
  return { conversationId, peerIds: peers, mode, title: q.get("title") ?? undefined };
}

/**
 * 打开通话窗口。返回 false 表示被浏览器弹窗拦截（调用方应回退到页内面板）。
 * Electron 侧由主进程 `setWindowOpenHandler` 放行该 URL 并套用窗口参数。
 */
export function openCallWindow(p: CallWindowParams): boolean {
  try {
    const url = buildCallWindowUrl(window.location.href, p);
    const win = window.open(url, CALL_WINDOW_NAME, CALL_WINDOW_FEATURES);
    if (!win) return false;
    win.focus();
    return true;
  } catch {
    return false;
  }
}
