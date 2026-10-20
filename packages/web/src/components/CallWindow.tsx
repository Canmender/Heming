import { useCallback, useEffect, useRef, useState } from "react";
import type { WsClientEvent, WsServerEvent } from "@heming/shared";
import { useAuthStore } from "../store/auth.js";
import { connectWs, type WsHandle } from "../lib/ws.js";
import { useVoiceCall } from "../lib/voiceCall.js";
import { parseCallWindowParams } from "../lib/callWindow.js";
import { MicIcon, MicOffIcon, PhoneOffIcon, PhoneIcon, VolumeIcon } from "./icons.js";

/**
 * 独立通话窗口（`?hemingWindow=call&conv=…&peers=…&mode=voice|video`）。
 *
 * 与主窗口的关系：**完全独立的一路客户端**——自己的 WS、自己的 RTCPeerConnection。
 * 同源所以共用 localStorage 里的 token，不用传凭证；主窗口只负责 `window.open`。
 * 发起通话在本窗口内完成（mounted 后 WS 一连上就 call）。
 */
export function CallWindow() {
  const params = useRef(parseCallWindowParams(window.location.search)).current;
  const user = useAuthStore((s) => s.user);
  const restore = useAuthStore((s) => s.restore);

  const [connected, setConnected] = useState(false);
  const [notice, setNotice] = useState<string | null>(null);
  const wsRef = useRef<WsHandle | null>(null);

  // 发送函数用 ref 转发：hook 需要稳定的 send 引用，而 WS 句柄在连接后才就绪。
  const sendRef = useRef<(e: WsClientEvent) => void>(() => {});
  const send = useCallback((e: WsClientEvent) => sendRef.current(e), []);

  // 没有登录态时先尝试恢复（同源 token 一般在，刷新窗口也不至于失败）。
  useEffect(() => {
    if (!user) void restore();
  }, [user, restore]);

  const voice = useVoiceCall({
    send,
    myUserId: user?.id ?? "",
    isDesktop: typeof window !== "undefined" && !!window.heming,
    mode: params?.mode ?? "voice",
  });

  // handleServerEvent 每次渲染可能变；用 ref 取最新，避免因它重建 WS。
  const handleRef = useRef(voice.handleServerEvent);
  useEffect(() => {
    handleRef.current = voice.handleServerEvent;
  }, [voice.handleServerEvent]);

  useEffect(() => {
    if (!user?.id) return;
    const handle = connectWs({
      onEvent: (e: WsServerEvent) => {
        if (e.type.startsWith("voice_call")) handleRef.current(e);
      },
      onOpen: () => setConnected(true),
      onClose: () => setConnected(false),
    });
    wsRef.current = handle;
    sendRef.current = handle.send;
    return () => {
      handle.close();
      wsRef.current = null;
    };
  }, [user?.id]);

  // WS 一就绪就发起通话（只发一次）
  const startedRef = useRef(false);
  useEffect(() => {
    if (!params || !connected || startedRef.current) return;
    if (voice.state.status !== "idle") return;
    startedRef.current = true;
    void voice.call(params.conversationId, params.peerIds);
  }, [connected, params, voice]);

  // 本地视频轨挂到 <video>
  const localVideoRef = useRef<HTMLVideoElement | null>(null);
  useEffect(() => {
    const el = localVideoRef.current;
    if (el && voice.localStream) el.srcObject = voice.localStream;
  }, [voice.localStream]);

  const close = () => window.close();
  const hangup = () => {
    voice.hangup();
    // 等 hangup 信令发出后再关窗
    window.setTimeout(close, 250);
  };

  if (!params) {
    return (
      <Shell title="通话">
        <p className="text-[13px] text-muted">通话参数缺失，请从聊天窗口重新发起。</p>
      </Shell>
    );
  }

  if (!user) {
    return (
      <Shell title={params.title ?? "通话"}>
        <p className="text-[13px] text-muted">请在主窗口登录后再发起通话。</p>
      </Shell>
    );
  }

  const statusText =
    voice.state.error ??
    (voice.state.status === "ringing"
      ? voice.state.role === "caller"
        ? "正在呼叫…"
        : "来电振铃中…"
      : voice.state.status === "active"
        ? "通话中"
        : connected
          ? "正在建立连接…"
          : "连接中…");

  const remoteEntries = Object.entries(voice.remoteStreams);

  return (
    <Shell title={params.title ?? (params.mode === "video" ? "视频通话" : "语音通话")}>
      <div className="flex min-h-0 flex-1 flex-col gap-3">
        {params.mode === "video" ? (
          <div className="grid min-h-0 flex-1 grid-cols-1 gap-2 overflow-auto">
            <video
              ref={localVideoRef}
              autoPlay
              playsInline
              muted
              className="w-full rounded-lg bg-[#111] object-cover"
            />
            {remoteEntries.map(([peerId, stream]) => (
              <RemoteVideo key={peerId} stream={stream} peerId={peerId} />
            ))}
            {remoteEntries.length === 0 && (
              <p className="text-center text-[12px] text-muted">等待对方画面…</p>
            )}
          </div>
        ) : (
          <div className="flex min-h-0 flex-1 flex-col items-center justify-center gap-2">
            <span className="flex h-16 w-16 items-center justify-center rounded-full bg-[#ececec] text-[20px] font-bold text-[#555]">
              {(params.title ?? "通").charAt(0)}
            </span>
            <p className="text-[12px] text-muted">{params.peerIds.length} 人在线</p>
          </div>
        )}

        <p role="status" className={`text-center text-[12px] ${voice.state.error ? "text-[#b42318]" : "text-muted"}`}>
          {statusText}
        </p>

        <div className="flex items-center justify-center gap-3 pb-1">
          <button
            type="button"
            aria-label={voice.state.muted ? "取消静音" : "静音"}
            onClick={voice.toggleMute}
            className={`flex h-11 w-11 items-center justify-center rounded-full border transition-colors ${
              voice.state.muted
                ? "border-ink bg-ink text-white"
                : "border-line bg-white text-[#555] hover:bg-[#f7f7f7]"
            }`}
          >
            {voice.state.muted ? <MicOffIcon width={18} height={18} /> : <MicIcon width={18} height={18} />}
          </button>
          <button
            type="button"
            aria-label="挂断"
            onClick={hangup}
            className="flex h-11 w-11 items-center justify-center rounded-full bg-[#b42318] text-white hover:bg-[#9a1d14]"
          >
            <PhoneOffIcon width={18} height={18} />
          </button>
          <button
            type="button"
            aria-label="关闭窗口"
            onClick={close}
            className="flex h-11 w-11 items-center justify-center rounded-full border border-line bg-white text-[#555] hover:bg-[#f7f7f7]"
          >
            <VolumeIcon width={18} height={18} />
          </button>
        </div>
      </div>
    </Shell>
  );
}

function RemoteVideo({ stream, peerId }: { stream: MediaStream; peerId: string }) {
  const ref = useRef<HTMLVideoElement | null>(null);
  useEffect(() => {
    if (ref.current) ref.current.srcObject = stream;
  }, [stream]);
  return (
    <video
      ref={ref}
      autoPlay
      playsInline
      data-peer={peerId}
      className="w-full rounded-lg bg-[#111] object-cover"
    />
  );
}

function Shell({ title, children }: { title: string; children: React.ReactNode }) {
  return (
    <div className="flex h-screen flex-col bg-[#fafafa]">
      <header className="flex items-center gap-2 border-b border-line-soft bg-white px-4 py-2.5">
        <PhoneIcon width={15} height={15} />
        <h1 className="text-[13px] font-bold">{title}</h1>
      </header>
      <div className="flex min-h-0 flex-1 flex-col p-4">{children}</div>
    </div>
  );
}
