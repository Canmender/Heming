import type { WsClientEvent, WsServerEvent } from "@heming/shared";
import { getToken, API_BASE, parseApiBase } from "./api.js";
import { utf8Length } from "./memory/storage.js";

export interface WsHandlers {
  onEvent: (e: WsServerEvent) => void;
  onOpen?: () => void;
  onClose?: () => void;
  /**
   * 发送失败回调（d.30 · P1-8）：队列溢出、无 token 发送等「没发出去」的显式告知。
   *
   * 为什么要有它：离线队列此前是**静默**的——帧被丢掉、或压根发不出去，
   * 用户以为在发、其实永远没发。宁可让上层弹一条「发送失败」的提示，
   * 也不要假装都发成功了。
   */
  onSendError?: (reason: string) => void;
}

export interface WsHandle {
  send: (payload: WsClientEvent) => void;
  close: () => void;
}

/** 离线队列上限（先到者为准）：帧数 100 或字节 4MB。 */
const QUEUE_MAX_FRAMES = 100;
const QUEUE_MAX_BYTES = 4 * 1024 * 1024;

/**
 * 派生 WebSocket 地址（可测纯函数，不含 token/路径）：
 * - apiBase 非空 → 先做形状校验（http(s) 绝对地址，非法抛统一文案），再派生（http→ws、https→wss）；
 * - apiBase 为空且页面 host 非空 → 按页面协议/域名（本地 dev vite 代理）；
 * - 两者皆空 → 抛清晰错误提示配置 VITE_API_BASE。
 */
export function resolveWsUrl(
  apiBase: string = API_BASE,
  loc: { protocol: string; host: string } = location,
): string {
  if (apiBase) {
    const u = parseApiBase(apiBase);
    const proto = u.protocol === "https:" ? "wss" : "ws";
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
  /** 离线队列：存帧（JSON.stringify 后的字符串），未就绪时暂存，连上后冲刷。 */
  const queue: string[] = [];
  /** 队列字节数（UTF-8）：与帧数一起决定何时算「满了」。 */
  let queueBytes = 0;

  /** 告知上层「有东西没发出去」；回调可选，且上层抛错也不该影响 WS 链路。 */
  const reportSendError = (reason: string) => {
    try {
      handlers.onSendError?.(reason);
    } catch {
      /* 上层回调抛错不该拖垮 WS */
    }
  };

  /** 入队一帧（带上限：帧数 100 或字节 4MB，先到者为准）。 */
  const enqueue = (frame: string) => {
    queue.push(frame);
    queueBytes += utf8Length(frame);
    let dropped = 0;
    // 丢**最旧**的帧：旧消息已经过时，新消息更有价值。
    // 但丢掉这件事必须显式告知上层——静默丢的话用户永远不知道有东西没发出去。
    while (queue.length > QUEUE_MAX_FRAMES || queueBytes > QUEUE_MAX_BYTES) {
      const old = queue.shift();
      if (old === undefined) break;
      queueBytes -= utf8Length(old);
      dropped += 1;
    }
    if (dropped > 0) reportSendError(`离线队列已满，已丢弃 ${dropped} 帧未发送`);
  };

  /** 安排一次退避重试（与断线重连同一条路径：1s → 2s → 4s … 上限 30s）。 */
  const scheduleRetry = () => {
    if (closed) return;
    const delay = Math.min(1000 * 2 ** attempt, 30_000);
    attempt += 1;
    timer = setTimeout(open, delay);
  };

  const open = () => {
    if (closed) return;
    const token = getToken();
    if (!token) {
      // 没有 token ⇒ 连上去也没法鉴权，所以**不建连**；但必须安排退避重试：
      // token 可能是「稍后才拿到」（登录流程中、或 401 重新登录后）。
      // 此前这里直接 return，等于把整条链路扔掉、永不重来——那才是真正的「死状态」。
      scheduleRetry();
      return;
    }
    // token 走**首帧**而不是 query：query 会进 nginx access_log 与任何中间代理日志。
    ws = new WebSocket(`${resolveWsUrl()}/api/ws`);
    ws.onopen = () => {
      attempt = 0;
      handlers.onOpen?.();
      // 首帧必须是 auth：服务端在收到它之前不登记 socket，
      // 业务帧先到会被当成「未鉴权事件」拒掉。
      // 同一 WebSocket 的 send 是有序的 → 先 send auth、再 splice 冲刷即保证顺序。
      try {
        ws?.send(JSON.stringify({ type: "auth", token }));
      } catch (e) {
        reportSendError(`鉴权帧发送失败：${(e as Error).message}`);
      }
      for (const frame of queue.splice(0)) ws?.send(frame);
      queueBytes = 0;
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
      scheduleRetry();
    };
  };

  open();

  return {
    send(payload) {
      const frame = JSON.stringify(payload);
      // 无 token ⇒ 没有任何连接会来，这些帧**永远发不出去**：
      // 排队等于假装它还在路上（用户以为在发、其实永远没发）。
      // 所以直接报错并 return，不入队。
      if (!getToken()) {
        reportSendError("未登录，消息未发送");
        return;
      }
      if (ws?.readyState === WebSocket.OPEN) ws.send(frame);
      else enqueue(frame);
    },
    close() {
      closed = true;
      if (timer) clearTimeout(timer);
      ws?.close();
    },
  };
}
