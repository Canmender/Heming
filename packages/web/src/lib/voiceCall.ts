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
  /**
   * 当前链路不稳定、正在做 ICE 重连的对端数量（d.25）。
   * 用数量而不是布尔：群聊里 1 路断开不该把整通电话染成「全部重连」。
   */
  reconnecting: number;
}

interface PeerConn {
  userId: string;
  pc: RTCPeerConnection;
  stream?: MediaStream;
  state: "connecting" | "connected" | "disconnected" | "reconnecting";
  /** 已发起的 ICE 重启次数；超过上限即放弃这条链路（挂断），不再无限重试。 */
  restarts: number;
  /** disconnected 观察期定时器：期间恢复就取消，持续中断才真的重启 ICE。 */
  probe: ReturnType<typeof setTimeout> | null;
}

export interface UseVoiceCallOptions {
  send: (event: WsClientEvent) => void;
  myUserId: string;
  /** 通话类型：语音（默认）或视频（视频时同时采集摄像头，远端视频轨一并接收）。 */
  mode?: "voice" | "video";
  /** 是否桌面端；网页端不支持通话，默认 true（由 Task 5 注入后精确判定） */
  isDesktop?: boolean;
  onIncomingCall?: (info: IncomingCallInfo) => void;
}

const DEFAULT_ICE_SERVERS: RTCIceServer[] = [
  { urls: "stun:stun.miwifi.com:3478" },
];

function getIceServers(): RTCIceServer[] {
  if (typeof window === "undefined") return DEFAULT_ICE_SERVERS;
  const injected = (window as unknown as { __heming_ice_servers_get?: () => RTCIceServer[] })
    .__heming_ice_servers_get?.();
  return injected && injected.length > 0 ? injected : DEFAULT_ICE_SERVERS;
}

/** 媒体约束：视频通话同时采集摄像头；音频恒定。 */
function mediaConstraints(mode: "voice" | "video"): MediaStreamConstraints {
  return mode === "video"
    ? { audio: true, video: { width: 640, height: 480, facingMode: "user" } }
    : { audio: true };
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
  reconnecting: 0,
};

/** ICE 重启观察期与上限（d.25 断线重连）。 */
export const RECONNECT_PROBE_MS = 3000;
export const RECONNECT_MAX_RESTARTS = 2;
/** ICE 彻底失败后的宽限期：给对端一次立即重启的机会，仍不通才收线。 */
export const ICE_GIVEUP_MS = 5000;

export function useVoiceCall(opts: UseVoiceCallOptions) {
  const { send, myUserId, isDesktop = true, onIncomingCall, mode = "voice" } = opts;
  const [state, setState] = useState<VoiceCallState>(IDLE_STATE);
  /**
   * 本地/远端媒体流（视频窗口用）：ref 负责生命周期清理，state 负责触发重渲染。
   * 语音通话下它们只用于「有没有流」的判断，不渲染画面。
   */
  const [localStream, setLocalStream] = useState<MediaStream | null>(null);
  const [remoteStreams, setRemoteStreams] = useState<Record<string, MediaStream>>({});

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
    for (const [, peer] of peersRef.current) {
      if (peer.probe) clearTimeout(peer.probe);
      peer.pc.close();
    }
    peersRef.current.clear();
    pendingCandidatesRef.current.clear();
    if (localStreamRef.current) {
      for (const track of localStreamRef.current.getTracks()) track.stop();
      localStreamRef.current = null;
    }
    setLocalStream(null);
    setRemoteStreams({});
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

  /** 把「几路链路正在重连」同步到对外状态（UI 只看数量，不碰 RTCPeerConnection）。 */
  const syncReconnecting = useCallback(() => {
    const bad = [...peersRef.current.values()].filter(
      (peer) => peer.state === "disconnected" || peer.state === "reconnecting",
    ).length;
    setState((s) => (s.reconnecting === bad ? s : { ...s, reconnecting: bad }));
  }, []);

  /** 放弃重连：先正常收线（让对端也结束），再留一条能看懂的错误文案。 */
  const giveUp = useCallback(() => {
    hangup();
    setState({ ...IDLE_STATE, error: "连接已断开，请重新呼叫" });
  }, [hangup]);

  /**
   * ICE 重启：给这条链路换一套 ICE 凭据重新协商（`iceRestart: true` 的新 offer 经
   * `voice_call_reconnect` 送出，对端回 answer，候选照常走 `voice_call_ice`）。
   *
   * 为什么不用 invite/accept 复用：那两条带振铃与接听语义，通话中途重发会让对端
   * 再弹一次来电、并把服务端 call 状态打回 ringing。
   *
   * 群聊取舍：某一路彻底救不回来时整通收线，而不是把那个对端悄悄摘掉——
   * 摘掉只对自己生效，对端仍以为四人在会，比全体散会更难解释。
   */
  const restartPeer = useCallback(
    async (peer: PeerConn) => {
      if (peer.probe) {
        clearTimeout(peer.probe);
        peer.probe = null;
      }
      const cid = callIdRef.current;
      const convId = conversationIdRef.current;
      if (!cid || !convId) return; // 通话已结束：迟到的 ICE 回调直接忽略
      if (peer.restarts >= RECONNECT_MAX_RESTARTS) {
        giveUp();
        return;
      }
      peer.restarts += 1;
      peer.state = "reconnecting";
      syncReconnecting();
      try {
        const offer = await peer.pc.createOffer({ iceRestart: true });
        const sdp = offer.sdp ?? "";
        if (!sdp) {
          giveUp();
          return;
        }
        await peer.pc.setLocalDescription(offer);
        send({
          type: "voice_call_reconnect",
          conversationId: convId,
          callId: cid,
          sdp,
          sdpType: "offer",
        });
      } catch {
        giveUp();
      }
    },
    [send, syncReconnecting, giveUp],
  );

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
          syncReconnecting();
        }
        const incoming = e.streams[0];
        if (incoming) setRemoteStreams((prev) => ({ ...prev, [peerId]: incoming }));
      };
      pc.oniceconnectionstatechange = () => {
        const peer = peersRef.current.get(peerId);
        if (!peer || !callIdRef.current) return; // 已挂断/未建联：忽略关闭中的回调
        const ice = pc.iceConnectionState;
        if (ice === "connected" || ice === "completed") {
          if (peer.probe) {
            clearTimeout(peer.probe);
            peer.probe = null;
          }
          peer.restarts = 0; // 链路恢复即重置重连预算
          peer.state = "connected";
          syncReconnecting();
          return;
        }
        if (ice === "disconnected") {
          // 抖动很常见（切 Wi-Fi、NAT 超时），先观察 3s 再决定是否真的重启 ICE
          if (peer.probe || peer.state === "reconnecting") return;
          peer.state = "disconnected";
          syncReconnecting();
          peer.probe = setTimeout(() => {
            peer.probe = null;
            void restartPeer(peer);
          }, RECONNECT_PROBE_MS);
          return;
        }
        if (ice === "failed") {
          if (peer.probe) {
            clearTimeout(peer.probe);
            peer.probe = null;
          }
          if (peer.restarts < RECONNECT_MAX_RESTARTS) {
            void restartPeer(peer);
            return;
          }
          // 预算用尽：再给 5s 宽限（链路可能自己爬回来），仍不通就收线
          peer.probe = setTimeout(() => {
            peer.probe = null;
            if (pc.iceConnectionState === "failed") giveUp();
          }, ICE_GIVEUP_MS);
        }
      };
      return pc;
    },
    [send, syncReconnecting, restartPeer, giveUp],
  );

  /** PeerConn 出厂态（`restarts`/`probe` 是重连账本，两处建 PC 都要带上）。 */
  const makePeer = (userId: string, pc: RTCPeerConnection): PeerConn => ({
    userId,
    pc,
    state: "connecting",
    restarts: 0,
    probe: null,
  });

  /** 发起通话：获取本地流 → 为每个 peer 创建 PC → createOffer → 发送 invite */
  const call = useCallback(
    async (conversationId: string, peerIds: string[]) => {
      if (!isDesktop) {
        setState((s) => ({ ...s, error: "仅桌面端支持语音通话" }));
        return;
      }
      if (peerIds.length === 0) return;
      if (callIdRef.current) {
        setState((s) => ({ ...s, error: "已有通话进行中" }));
        return;
      }
      try {
        const stream = await navigator.mediaDevices.getUserMedia(mediaConstraints(mode));
        localStreamRef.current = stream;
        setLocalStream(stream);
        const callId = crypto.randomUUID();
        callIdRef.current = callId;
        conversationIdRef.current = conversationId;

        for (const peerId of peerIds) {
          const pc = createPeerConnection(peerId);
          peersRef.current.set(peerId, makePeer(peerId, pc));
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
          reconnecting: 0,
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
        const stream = await navigator.mediaDevices.getUserMedia(mediaConstraints(mode));
        localStreamRef.current = stream;
        setLocalStream(stream);
        callIdRef.current = callId;
        conversationIdRef.current = invite.conversationId;

        const pc = createPeerConnection(invite.initiatorId);
        peersRef.current.set(invite.initiatorId, makePeer(invite.initiatorId, pc));
        for (const track of stream.getTracks()) pc.addTrack(track, stream);
        await pc.setRemoteDescription({ type: "offer", sdp: invite.sdp });
        // C2：flush accept 之前缓存的远端 candidates（此时 PC 已就绪）。
        // 按对端精确：只把属于本对端的 candidate 加进本 PC。
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
          reconnecting: 0,
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
          // C2：invite 带 fromUserId（服务端从认证身份填，防伪造）——被叫此刻即知对端身份
          const info: IncomingCallInfo = {
            callId: event.callId,
            conversationId: event.conversationId,
            initiatorId: event.fromUserId,
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
            // C2：invite 带 fromUserId → peerIds 填 [fromUserId]（面板可显示对端名）；
            // accept() 之后用 invite.initiatorId 覆盖，保证多对端场景精确。
            peerIds: [event.fromUserId],
            startedAt: null,
            muted: false,
            error: null,
            incoming: info,
            reconnecting: 0,
          }));
          break;
        }
        case "voice_call_accept": {
          // 对方接听，将 answer SDP 设为对端 PC 的远端描述。
          // C2：accept 带 fromUserId → 只把 answer 应用到该对端的 PC（Mesh 精确路由，
          // 不再广播到所有 connecting PC——旧实现会把 answer 错配到其他 peer）。
          // 无匹配 PC 的异常时序兜底全量应用，避免对端永久卡 connecting。
          const peers = [...peersRef.current.values()];
          const matched = peers.filter((p) => p.userId === event.fromUserId);
          const targets = matched.length > 0 ? matched : peers;
          for (const peer of targets) {
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
            reconnecting: 0,
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
          // C2：ice 带 fromUserId → 只加入该对端的 PC（Mesh 精确路由）。
          // 未知对端（尚未 accept/未在 peersRef）的 candidate 缓存待 accept 后 flush。
          const peer = peersRef.current.get(event.fromUserId);
          if (peer) {
            peer.pc.addIceCandidate({ candidate: event.candidate }).catch(() => {});
          } else {
            const buf = pendingCandidatesRef.current.get(event.callId) ?? [];
            buf.push({ candidate: event.candidate });
            pendingCandidatesRef.current.set(event.callId, buf);
          }
          break;
        }
        case "voice_call_reconnect": {
          // ICE 重启的重新协商（d.25）：对端发来 offer → 本端答 answer；
          // 收到 answer → 直接作为远端描述应用。candidate 仍走 voice_call_ice 老通道。
          if (event.callId !== callIdRef.current) break;
          const peer = peersRef.current.get(event.fromUserId);
          // 首屏协商还没完成（connecting）时不接受第二次 offer——会把还在飞的
          // 初始协商搞乱；此时链路本来就还没通过 ICE，重连由对端自己负责。
          if (!peer || peer.state === "connecting") break;
          void (async () => {
            try {
              if (event.sdpType === "offer") {
                await peer.pc.setRemoteDescription({ type: "offer", sdp: event.sdp });
                const answer = await peer.pc.createAnswer();
                await peer.pc.setLocalDescription(answer);
                const cid = callIdRef.current;
                const convId = conversationIdRef.current;
                const sdp = answer.sdp ?? "";
                if (cid && convId && sdp) {
                  send({
                    type: "voice_call_reconnect",
                    conversationId: convId,
                    callId: cid,
                    sdp,
                    sdpType: "answer",
                  });
                }
              } else {
                await peer.pc.setRemoteDescription({ type: "answer", sdp: event.sdp });
              }
            } catch {
              /* 重连窗口内本端可能正在收线：SDP 应用失败无需额外处理，ICE 回调会收尾 */
            }
          })();
          break;
        }
      }
    },
    [isDesktop, send, cleanupResources, onIncomingCall],
  );

  // 组件卸载时清理所有资源
  useEffect(() => {
    return () => {
      for (const [, peer] of peersRef.current) {
        if (peer.probe) clearTimeout(peer.probe);
        peer.pc.close();
      }
      if (localStreamRef.current) {
        for (const track of localStreamRef.current.getTracks()) track.stop();
      }
    };
  }, []);

  return {
    state,
    localStream,
    remoteStreams,
    call,
    accept,
    reject,
    hangup,
    toggleMute,
    handleServerEvent,
  };
}
