import type { WsClientEvent, WsServerEvent } from "@heming/shared";
import { getToken } from "./api.js";

export interface WsHandlers {
  onEvent: (e: WsServerEvent) => void;
  onOpen?: () => void;
  onClose?: () => void;
}

export interface WsHandle {
  send: (payload: WsClientEvent) => void;
  close: () => void;
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
    const proto = location.protocol === "https:" ? "wss" : "ws";
    ws = new WebSocket(`${proto}://${location.host}/api/ws?token=${token}`);
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
