import type { WsClientEvent, WsServerEvent } from "@heming/shared";
import { getToken, API_BASE } from "./api.js";

export interface WsHandlers {
  onEvent: (e: WsServerEvent) => void;
  onOpen?: () => void;
  onClose?: () => void;
}

export interface WsHandle {
  send: (payload: WsClientEvent) => void;
  close: () => void;
}

/**
 * 派生 WebSocket 地址（可测纯函数，不含 token/路径）：
 * - apiBase 非空 → 由其派生（http→ws、https→wss），覆盖桌面 file:// 页面；
 * - apiBase 为空且页面 host 非空 → 按页面协议/域名（本地 dev vite 代理）；
 * - 两者皆空 → 抛清晰错误提示配置 VITE_API_BASE。
 */
export function resolveWsUrl(
  apiBase: string = API_BASE,
  loc: { protocol: string; host: string } = location,
): string {
  if (apiBase) {
    const u = new URL(apiBase);
    const proto = u.protocol === "https:" || u.protocol === "wss:" ? "wss" : "ws";
    return `${proto}://${u.host}`;
  }
  if (!loc.host) throw new Error("未配置 VITE_API_BASE：file:// 页面需指向服务端绝对地址");
  const proto = loc.protocol === "https:" ? "wss" : "ws";
  return `${proto}://${loc.host}`;
}

export function connectWs(handlers: WsHandlers): WsHandle {
  let ws: WebSocket | null = null;
  let closed = false;
  let attempt = 0;
  let timer: ReturnType<typeof setTimeout> | null = null;
  const queue: string[] = [];

  const open = () => {
    if (closed) return;
    const token = getToken();
    if (!token) return;
    ws = new WebSocket(`${resolveWsUrl()}/api/ws?token=${token}`);
    ws.onopen = () => {
      attempt = 0;
      handlers.onOpen?.();
      for (const frame of queue.splice(0)) ws?.send(frame);
    };
    ws.onmessage = (e) => {
      try {
        handlers.onEvent(JSON.parse(e.data) as WsServerEvent);
      } catch {
        /* 忽略无法解析的帧 */
      }
    };
    ws.onclose = () => {
      handlers.onClose?.();
      if (closed) return;
      const delay = Math.min(1000 * 2 ** attempt, 30_000);
      attempt += 1;
      timer = setTimeout(open, delay);
    };
  };

  open();

  return {
    send(payload) {
      const frame = JSON.stringify(payload);
      if (ws?.readyState === WebSocket.OPEN) ws.send(frame);
      else queue.push(frame);
    },
    close() {
      closed = true;
      if (timer) clearTimeout(timer);
      ws?.close();
    },
  };
}
