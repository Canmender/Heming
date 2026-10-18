import { useCallback, useEffect, useRef, useState } from "react";
import type { WsClientEvent, WsServerEvent } from "@heming/shared";

/**
 * 语音通话状态机 hook（Task 3）。
 *
 * 仅桌面端（Electron）支持通话；网页端收到 invite 自动拒绝并提示。
 * 信令复用现有 WS 通道（voice_call_* 事件），媒体流 Mesh 点对点。
 * callId 由发起方用 crypto.randomUUID() 生成；通话状态不入库。
 */

export type VoiceCallStatus = "idle" | "ringing" | "active";

export interface IncomingCallInfo {
  callId: string;
  conversationId: string;
  /** 服务端当前未在 invite 事件中携带发起方 ID，首版留空由 UI 层按会话推导 */
  initiatorId: string;
}

export interface VoiceCallState {
  callId: string | null;
  conversationId: string | null;
  role: "caller" | "callee" | null;
  status: VoiceCallStatus;
  peerIds: string[];
  startedAt: number | null;
  muted: boolean;
  error: string | null;
  incoming: IncomingCallInfo | null;
}

interface PeerConn {
  userId: string;
  pc: RTCPeerConnection;
  stream?: MediaStream;
  state: "connecting" | "connected" | "disconnected";
}

export interface UseVoiceCallOptions {
  send: (event: WsClientEvent) => void;
  myUserId: string;
  /** 是否桌面端；网页端不支持通话，默认 true（由 Task 5 注入后精确判定） */
  isDesktop?: boolean;
  onIncomingCall?: (info: IncomingCallInfo) => void;
}

const DEFAULT_ICE_SERVERS: RTCIceServer[] = [
  { urls: "stun:stun.miwifi.com:3478" },
];

function getIceServers(): RTCIceServer[] {
  if (typeof window === "undefined") return DEFAULT_ICE_SERVERS;
  const injected = (window as unknown as { __heming_ice_servers?: RTCIceServer[] })
    .__heming_ice_servers;
  return injected && injected.length > 0 ? injected : DEFAULT_ICE_SERVERS;
}

function mapMediaError(err: unknown): string {
  if (err instanceof DOMException) {
    if (err.name === "NotAllowedError") return "麦克风权限被拒绝";
    if (err.name === "NotFoundError") return "未检测到麦克风设备";
  }
  return "语音通话不可用";
}

const IDLE_STATE: VoiceCallState = {
  callId: null,
  conversationId: null,
  role: null,
  status: "idle",
  peerIds: [],
  startedAt: null,
  muted: false,
  error: null,
  incoming: null,
};

export function useVoiceCall(opts: UseVoiceCallOptions) {
  const { send, myUserId, isDesktop = true, onIncomingCall } = opts;
  const [state, setState] = useState<VoiceCallState>(IDLE_STATE);

  const localStreamRef = useRef<MediaStream | null>(null);
  const peersRef = useRef<Map<string, PeerConn>>(new Map());
  const pendingInvitesRef = useRef<Map<string, IncomingCallInfo & { sdp: string }>>(new Map());
  /**
   * 被叫 accept 之前收到的远端 ICE candidate 暂存区（按 callId 分组）。
   * 发起方在 setLocalDescription 后立即 trickle host candidates，此时被叫可能
   * 尚未点「接听」、peersRef 仍为空；若直接丢弃会导致媒体通道迟迟建不起来。
   * accept() 建好 PC 并 setRemoteDescription(offer) 后再 flush。
   */
  const pendingCandidatesRef = useRef<Map<string, RTCIceCandidateInit[]>>(new Map());
  const callIdRef = useRef<string | null>(null);
  const conversationIdRef = useRef<string | null>(null);

  /** 清理所有 PC 与本地流（不发信令） */
  const cleanupResources = useCallback(() => {
    for (const [, peer] of peersRef.current) peer.pc.close();
    peersRef.current.clear();
    pendingCandidatesRef.current.clear();
    if (localStreamRef.current) {
      for (const track of localStreamRef.current.getTracks()) track.stop();
      localStreamRef.current = null;
    }
    callIdRef.current = null;
    conversationIdRef.current = null;
  }, []);

  /** 挂断：发送 hangup 信令并清理资源 */
  const hangup = useCallback(() => {
    const convId = conversationIdRef.current;
    const cid = callIdRef.current;
    cleanupResources();
    if (cid && convId) {
      send({ type: "voice_call_hangup", conversationId: convId, callId: cid });
    }
    setState(IDLE_STATE);
  }, [send, cleanupResources]);

  const createPeerConnection = useCallback(
    (peerId: string): RTCPeerConnection => {
      const pc = new RTCPeerConnection({ iceServers: getIceServers() });
      pc.onicecandidate = (e) => {
        if (e.candidate && callIdRef.current && conversationIdRef.current) {
          send({
            type: "voice_call_ice",
            conversationId: conversationIdRef.current,
            callId: callIdRef.current,
            candidate: e.candidate.candidate,
          });
        }
      };
      pc.ontrack = (e) => {
        const peer = peersRef.current.get(peerId);
        if (peer) {
          peer.stream = e.streams[0];
          peer.state = "connected";
        }
      };
      pc.oniceconnectionstatechange = () => {
        if (pc.iceConnectionState === "failed") {
          // ICE 失败 5s 后重连，仍失败则挂断
          setTimeout(() => {
            if (callIdRef.current && pc.iceConnectionState === "failed") {
              hangup();
            }
          }, 5000);
        }
      };
      return pc;
    },
    [send, hangup],
  );

  /** 发起通话：获取本地流 → 为每个 peer 创建 PC → createOffer → 发送 invite */
  const call = useCallback(
    async (conversationId: string, peerIds: string[]) => {
      if (!isDesktop) {
        setState((s) => ({ ...s, error: "仅桌面端支持语音通话" }));
        return;
      }
      if (callIdRef.current) {
        setState((s) => ({ ...s, error: "已有通话进行中" }));
        return;
      }
      try {
        const stream = await navigator.mediaDevices.getUserMedia({ audio: true });
        localStreamRef.current = stream;
        const callId = crypto.randomUUID();
        callIdRef.current = callId;
        conversationIdRef.current = conversationId;

        for (const peerId of peerIds) {
          const pc = createPeerConnection(peerId);
          peersRef.current.set(peerId, { userId: peerId, pc, state: "connecting" });
          for (const track of stream.getTracks()) pc.addTrack(track, stream);
          const offer = await pc.createOffer();
          await pc.setLocalDescription(offer);
          send({
            type: "voice_call_invite",
            conversationId,
            callId,
            sdp: offer.sdp ?? "",
          });
        }

        setState({
          callId,
          conversationId,
          role: "caller",
          status: "ringing",
          peerIds,
          startedAt: null,
          muted: false,
          error: null,
          incoming: null,
        });
      } catch (err) {
        // getUserMedia 成功后若 createOffer/setLocalDescription 抛错，
        // callIdRef/localStreamRef 已写入，必须回滚，否则后续 call() 会被
        // 「已有通话进行中」挡住且本地流泄漏。
        cleanupResources();
        setState((s) => ({ ...s, error: mapMediaError(err) }));
      }
    },
    [isDesktop, send, createPeerConnection, cleanupResources],
  );

  /** 接听来电：获取本地流 → 创建 PC → setRemoteDescription(offer) → createAnswer → 发送 accept */
  const accept = useCallback(
    async (callId: string) => {
      const invite = pendingInvitesRef.current.get(callId);
      if (!invite) return;
      try {
        const stream = await navigator.mediaDevices.getUserMedia({ audio: true });
        localStreamRef.current = stream;
        callIdRef.current = callId;
        conversationIdRef.current = invite.conversationId;

        const pc = createPeerConnection(invite.initiatorId);
        peersRef.current.set(invite.initiatorId, {
          userId: invite.initiatorId,
          pc,
          state: "connecting",
        });
        for (const track of stream.getTracks()) pc.addTrack(track, stream);
        await pc.setRemoteDescription({ type: "offer", sdp: invite.sdp });
        // flush accept 之前缓存的远端 candidates（此时 PC 已就绪）
        const pending = pendingCandidatesRef.current.get(callId);
        if (pending) {
          for (const cand of pending) pc.addIceCandidate(cand).catch(() => {});
          pendingCandidatesRef.current.delete(callId);
        }
        const answer = await pc.createAnswer();
        await pc.setLocalDescription(answer);
        send({
          type: "voice_call_accept",
          conversationId: invite.conversationId,
          callId,
          sdp: answer.sdp ?? "",
        });
        pendingInvitesRef.current.delete(callId);
        setState({
          callId,
          conversationId: invite.conversationId,
          role: "callee",
          status: "active",
          peerIds: [invite.initiatorId],
          startedAt: Date.now(),
          muted: false,
          error: null,
          incoming: null,
        });
      } catch (err) {
        setState((s) => ({ ...s, error: mapMediaError(err) }));
      }
    },
    [send, createPeerConnection],
  );

  /** 拒接来电：发送 reject 信令并回到 idle */
  const reject = useCallback(
    (callId: string, reason: "busy" | "decline" | "timeout") => {
      const invite = pendingInvitesRef.current.get(callId);
      if (!invite) return;
      send({
        type: "voice_call_reject",
        conversationId: invite.conversationId,
        callId,
        reason,
      });
      pendingInvitesRef.current.delete(callId);
      // 收到 invite 时已把 status=ringing / callId / role=callee 写入 state，
      // 拒接后必须整体复位，否则 UI 面板会卡在 ringing。
      cleanupResources();
      setState(IDLE_STATE);
    },
    [send, cleanupResources],
  );

  /** 静音切换 */
  const toggleMute = useCallback(() => {
    const stream = localStreamRef.current;
    if (!stream) return;
    for (const track of stream.getAudioTracks()) track.enabled = !track.enabled;
    setState((s) => ({ ...s, muted: !s.muted }));
  }, []);

  /** 处理服务端 voice_call_* 事件 */
  const handleServerEvent = useCallback(
    (event: WsServerEvent) => {
      switch (event.type) {
        case "voice_call_invite": {
          if (!isDesktop) {
            // 网页端不支持通话，自动拒绝并提示用户
            send({
              type: "voice_call_reject",
              conversationId: event.conversationId,
              callId: event.callId,
              reason: "busy",
            });
            setState((s) => ({ ...s, error: "仅桌面端支持语音通话" }));
            return;
          }
          if (callIdRef.current) {
            // 正在通话中，拒绝新来电
            send({
              type: "voice_call_reject",
              conversationId: event.conversationId,
              callId: event.callId,
              reason: "busy",
            });
            return;
          }
          const info: IncomingCallInfo = {
            callId: event.callId,
            conversationId: event.conversationId,
            initiatorId: "",
          };
          pendingInvitesRef.current.set(event.callId, { ...info, sdp: event.sdp });
          // 记下 callId：accept 之前若先收到远端 ICE（caller 已 trickle），
          // voice_call_ice 分支据此判定属于本次来电并缓存；hangup-before-accept 也依赖它。
          callIdRef.current = event.callId;
          onIncomingCall?.(info);
          setState((s) => ({
            ...s,
            callId: event.callId,
            conversationId: event.conversationId,
            role: "callee",
            status: "ringing",
            peerIds: [""],
            startedAt: null,
            muted: false,
            error: null,
            incoming: info,
          }));
          break;
        }
        case "voice_call_accept": {
          // 对方接听，将 answer SDP 设为本端 PC 的远端描述。
          // 限制：voice_call_accept 无 peerId/initiatorId，mesh 场景会把同一条 answer
          // 应用到所有 connecting PC，导致 setRemoteDescription 错配（catch 兜底后该 PC
          // 永久停在 connecting）。根治需 Task 1 在契约中为 accept/ice 增加 initiatorId。
          for (const [, peer] of peersRef.current) {
            if (peer.state === "connecting") {
              peer.pc
                .setRemoteDescription({ type: "answer", sdp: event.sdp })
                .catch(() => {});
              peer.state = "connected";
            }
          }
          setState((s) => ({
            ...s,
            status: "active",
            startedAt: s.startedAt ?? Date.now(),
          }));
          break;
        }
        case "voice_call_reject": {
          cleanupResources();
          const reasonMsg =
            event.reason === "busy"
              ? "对方忙"
              : event.reason === "decline"
                ? "对方已拒绝"
                : "通话超时";
          setState({ ...IDLE_STATE, error: reasonMsg });
          break;
        }
        case "voice_call_hangup": {
          if (event.callId === callIdRef.current) {
            cleanupResources();
            setState(IDLE_STATE);
          }
          break;
        }
        case "voice_call_ice": {
          if (event.callId !== callIdRef.current) break;
          if (peersRef.current.size === 0) {
            // 被叫尚未 accept（peersRef 为空）：缓存 candidate，accept() 建 PC 后 flush。
            const buf = pendingCandidatesRef.current.get(event.callId) ?? [];
            buf.push({ candidate: event.candidate });
            pendingCandidatesRef.current.set(event.callId, buf);
            break;
          }
          // 添加 ICE candidate 到所有 PC。
          // 限制：1:1 精确；mesh 场景 candidate 不携带对端标识，会广播到所有 PC
          //（与 voice_call_accept 同源问题，需 Task 1 契约补充 initiatorId 才能根治）。
          for (const [, peer] of peersRef.current) {
            peer.pc.addIceCandidate({ candidate: event.candidate }).catch(() => {});
          }
          break;
        }
      }
    },
    [isDesktop, send, cleanupResources, onIncomingCall],
  );

  // 组件卸载时清理所有资源
  useEffect(() => {
    return () => {
      for (const [, peer] of peersRef.current) peer.pc.close();
      if (localStreamRef.current) {
        for (const track of localStreamRef.current.getTracks()) track.stop();
      }
    };
  }, []);

  return {
    state,
    call,
    accept,
    reject,
    hangup,
    toggleMute,
    handleServerEvent,
  };
}
