import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import { renderHook, act } from "@testing-library/react";
import type { WsServerEvent } from "@heming/shared";
import { useVoiceCall } from "./voiceCall.js";

// ── WebRTC / getUserMedia 桩（jsdom 均不实现）──

class MockRTCPeerConnection {
  static instances: MockRTCPeerConnection[] = [];
  localDescription: RTCSessionDescription | null = null;
  remoteDescription: RTCSessionDescription | null = null;
  iceGatheringState = "complete";
  iceConnectionState = "new";
  connectionState = "new";
  closed = false;
  onicecandidate: ((e: RTCPeerConnectionIceEvent) => void) | null = null;
  ontrack: ((e: RTCTrackEvent) => void) | null = null;
  oniceconnectionstatechange: (() => void) | null = null;
  onconnectionstatechange: (() => void) | null = null;
  candidates: unknown[] = [];
  addedTracks: { track: unknown; stream: unknown }[] = [];

  constructor(public config: RTCConfiguration) {
    MockRTCPeerConnection.instances.push(this);
  }

  createOffer(): Promise<RTCSessionDescriptionInit> {
    return Promise.resolve({ type: "offer", sdp: "v=0 mock-offer" });
  }
  createAnswer(): Promise<RTCSessionDescriptionInit> {
    return Promise.resolve({ type: "answer", sdp: "v=0 mock-answer" });
  }
  setLocalDescription(desc: RTCSessionDescriptionInit): Promise<void> {
    this.localDescription = desc as RTCSessionDescription;
    return Promise.resolve();
  }
  setRemoteDescription(desc: RTCSessionDescriptionInit): Promise<void> {
    this.remoteDescription = desc as RTCSessionDescription;
    return Promise.resolve();
  }
  addIceCandidate(candidate: RTCIceCandidateInit): Promise<void> {
    this.candidates.push(candidate);
    return Promise.resolve();
  }
  addTrack(track: unknown, stream: unknown): RTCRtpSender {
    this.addedTracks.push({ track, stream });
    return { track } as RTCRtpSender;
  }
  close(): void {
    this.closed = true;
    this.iceConnectionState = "closed";
    this.connectionState = "closed";
  }
}

function installMediaStubs() {
  const trackStop = vi.fn();
  const stream = {
    getTracks: () => [{ stop: trackStop }],
    getAudioTracks: () => [{ stop: trackStop, enabled: true }],
  };
  const orig = Object.getOwnPropertyDescriptor(navigator, "mediaDevices");
  const getUserMedia = vi.fn().mockResolvedValue(stream);
  Object.defineProperty(navigator, "mediaDevices", {
    configurable: true,
    value: { getUserMedia, enumerateDevices: vi.fn().mockResolvedValue([]) },
  });
  return {
    trackStop,
    stream,
    getUserMedia,
    restore() {
      if (orig) Object.defineProperty(navigator, "mediaDevices", orig);
      else Reflect.deleteProperty(navigator, "mediaDevices");
    },
  };
}

function sendByType(send: ReturnType<typeof vi.fn>, type: string) {
  return send.mock.calls.filter((c: unknown[]) => (c[0] as { type: string }).type === type);
}

/** useVoiceCall 的 idle 快照基线（与模块内 IDLE_STATE 保持一致） */
const IDLE_STATE_EXPECT = {
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

describe("useVoiceCall", () => {
  let media: ReturnType<typeof installMediaStubs>;

  beforeEach(() => {
    MockRTCPeerConnection.instances = [];
    media = installMediaStubs();
    vi.stubGlobal("RTCPeerConnection", MockRTCPeerConnection);
  });

  afterEach(() => {
    vi.unstubAllGlobals();
    media.restore();
  });

  it("call() 发起通话：获取本地流、为每个 peer 创建 PC、发送 invite", async () => {
    const send = vi.fn();
    const { result } = renderHook(() => useVoiceCall({ send, myUserId: "u1" }));

    await act(async () => {
      await result.current.call("c1", ["u2", "u3"]);
    });

    expect(media.getUserMedia).toHaveBeenCalledWith({ audio: true });
    expect(MockRTCPeerConnection.instances).toHaveLength(2);
    const invites = sendByType(send, "voice_call_invite");
    expect(invites).toHaveLength(2);
    for (const c of invites) {
      expect(c[0]).toMatchObject({
        type: "voice_call_invite",
        conversationId: "c1",
        callId: expect.any(String),
        sdp: expect.stringContaining("mock-offer"),
      });
    }
    const callIds = new Set(invites.map((c: unknown[]) => (c[0] as { callId: string }).callId));
    expect(callIds.size).toBe(1); // 同一通话的所有 invite 共用 callId
    expect(result.current.state.status).toBe("ringing");
    expect(result.current.state.role).toBe("caller");
  });

  it("hangup() 关闭所有 PC、停止本地流、发送 hangup", async () => {
    const send = vi.fn();
    const { result } = renderHook(() => useVoiceCall({ send, myUserId: "u1" }));

    await act(async () => {
      await result.current.call("c1", ["u2"]);
    });
    const callId = result.current.state.callId!;

    act(() => {
      result.current.hangup();
    });

    expect(MockRTCPeerConnection.instances[0].closed).toBe(true);
    expect(media.trackStop).toHaveBeenCalled();
    const hangups = sendByType(send, "voice_call_hangup");
    expect(hangups).toHaveLength(1);
    expect(hangups[0][0]).toMatchObject({
      type: "voice_call_hangup",
      conversationId: "c1",
      callId,
    });
    expect(result.current.state.status).toBe("idle");
  });

  it("收到 invite 触发 onIncomingCall 回调，状态进入 ringing", () => {
    const onIncomingCall = vi.fn();
    const send = vi.fn();
    const { result } = renderHook(() =>
      useVoiceCall({ send, myUserId: "u1", onIncomingCall }),
    );

    act(() => {
      result.current.handleServerEvent({
        type: "voice_call_invite",
        conversationId: "c1",
        callId: "call-x",
        sdp: "v=0 mock-offer-from-u2",
      } as WsServerEvent);
    });

    expect(onIncomingCall).toHaveBeenCalledWith(
      expect.objectContaining({ callId: "call-x", conversationId: "c1" }),
    );
    expect(result.current.state).toMatchObject({
      callId: "call-x",
      conversationId: "c1",
      role: "callee",
      status: "ringing",
    });
  });

  it("accept() 应答来电：创建 PC、setRemoteDescription(offer)、发送 accept", async () => {
    const send = vi.fn();
    const { result } = renderHook(() => useVoiceCall({ send, myUserId: "u1" }));

    act(() => {
      result.current.handleServerEvent({
        type: "voice_call_invite",
        conversationId: "c1",
        callId: "call-y",
        sdp: "v=0 mock-offer",
      } as WsServerEvent);
    });

    await act(async () => {
      await result.current.accept("call-y");
    });

    expect(MockRTCPeerConnection.instances).toHaveLength(1);
    const pc = MockRTCPeerConnection.instances[0];
    expect(pc.remoteDescription).toMatchObject({ type: "offer", sdp: "v=0 mock-offer" });
    const accepts = sendByType(send, "voice_call_accept");
    expect(accepts).toHaveLength(1);
    expect(accepts[0][0]).toMatchObject({
      type: "voice_call_accept",
      callId: "call-y",
      sdp: expect.stringContaining("mock-answer"),
    });
    expect(result.current.state.status).toBe("active");
  });

  it("reject() 拒接来电：发送 reject 信令", () => {
    const send = vi.fn();
    const { result } = renderHook(() => useVoiceCall({ send, myUserId: "u1" }));

    act(() => {
      result.current.handleServerEvent({
        type: "voice_call_invite",
        conversationId: "c1",
        callId: "call-z",
        sdp: "v=0",
      } as WsServerEvent);
    });

    act(() => {
      result.current.reject("call-z", "decline");
    });

    const rejects = sendByType(send, "voice_call_reject");
    expect(rejects).toHaveLength(1);
    expect(rejects[0][0]).toMatchObject({
      type: "voice_call_reject",
      callId: "call-z",
      reason: "decline",
    });
    expect(result.current.state.status).toBe("idle");
  });

  it("reject() 后状态完整复位到 idle，面板不卡在 ringing", () => {
    const onIncomingCall = vi.fn();
    const send = vi.fn();
    const { result } = renderHook(() =>
      useVoiceCall({ send, myUserId: "u1", onIncomingCall }),
    );

    act(() => {
      result.current.handleServerEvent({
        type: "voice_call_invite",
        conversationId: "c1",
        callId: "call-reject-state",
        sdp: "v=0 mock-offer",
      } as WsServerEvent);
    });
    expect(result.current.state).toMatchObject({
      callId: "call-reject-state",
      role: "callee",
      status: "ringing",
      incoming: expect.objectContaining({ callId: "call-reject-state" }),
    });

    act(() => {
      result.current.reject("call-reject-state", "decline");
    });

    expect(result.current.state).toEqual(IDLE_STATE_EXPECT);
  });

  it("收到 accept 进入 active 状态", async () => {
    const send = vi.fn();
    const { result } = renderHook(() => useVoiceCall({ send, myUserId: "u1" }));
    await act(async () => {
      await result.current.call("c1", ["u2"]);
    });

    act(() => {
      result.current.handleServerEvent({
        type: "voice_call_accept",
        conversationId: "c1",
        callId: result.current.state.callId!,
        sdp: "v=0 mock-answer",
      } as WsServerEvent);
    });

    expect(result.current.state.status).toBe("active");
    expect(result.current.state.startedAt).not.toBeNull();
  });

  it("收到对端 hangup 进入 idle", async () => {
    const send = vi.fn();
    const { result } = renderHook(() => useVoiceCall({ send, myUserId: "u1" }));
    await act(async () => {
      await result.current.call("c1", ["u2"]);
    });
    const callId = result.current.state.callId!;

    act(() => {
      result.current.handleServerEvent({
        type: "voice_call_hangup",
        conversationId: "c1",
        callId,
      } as WsServerEvent);
    });

    expect(result.current.state.status).toBe("idle");
    expect(MockRTCPeerConnection.instances[0].closed).toBe(true);
  });

  it("收到 voice_call_ice 添加 ICE candidate", async () => {
    const send = vi.fn();
    const { result } = renderHook(() => useVoiceCall({ send, myUserId: "u1" }));
    await act(async () => {
      await result.current.call("c1", ["u2"]);
    });

    await act(async () => {
      await result.current.handleServerEvent({
        type: "voice_call_ice",
        conversationId: "c1",
        callId: result.current.state.callId!,
        candidate: "candidate:1 1 udp 2130706431 1.2.3.4 9999 typ host",
      } as WsServerEvent);
    });

    const pc = MockRTCPeerConnection.instances[0];
    expect(pc.candidates).toHaveLength(1);
    expect(pc.candidates[0]).toMatchObject({
      candidate: "candidate:1 1 udp 2130706431 1.2.3.4 9999 typ host",
    });
  });

  it("通话中收到新 invite 自动拒绝（busy）", async () => {
    const send = vi.fn();
    const { result } = renderHook(() => useVoiceCall({ send, myUserId: "u1" }));
    await act(async () => {
      await result.current.call("c1", ["u2"]);
    });

    act(() => {
      result.current.handleServerEvent({
        type: "voice_call_invite",
        conversationId: "c9",
        callId: "call-other",
        sdp: "v=0",
      } as WsServerEvent);
    });

    const rejects = sendByType(send, "voice_call_reject");
    expect(rejects).toHaveLength(1);
    expect(rejects[0][0]).toMatchObject({
      type: "voice_call_reject",
      callId: "call-other",
      reason: "busy",
    });
    // 原有通话不受影响
    expect(result.current.state.status).toBe("ringing");
  });

  it("网页端收到 invite 自动拒绝（busy）并设置 error 提示", () => {
    const send = vi.fn();
    const { result } = renderHook(() =>
      useVoiceCall({ send, myUserId: "u1", isDesktop: false }),
    );

    act(() => {
      result.current.handleServerEvent({
        type: "voice_call_invite",
        conversationId: "c1",
        callId: "call-web",
        sdp: "v=0",
      } as WsServerEvent);
    });

    const rejects = sendByType(send, "voice_call_reject");
    expect(rejects).toHaveLength(1);
    expect(rejects[0][0]).toMatchObject({
      type: "voice_call_reject",
      callId: "call-web",
      reason: "busy",
    });
    expect(result.current.state.error).toBe("仅桌面端支持语音通话");
    expect(result.current.state.status).toBe("idle");
  });

  it("网页端发起 call() 直接报错，不发送信令", async () => {
    const send = vi.fn();
    const { result } = renderHook(() =>
      useVoiceCall({ send, myUserId: "u1", isDesktop: false }),
    );

    await act(async () => {
      await result.current.call("c1", ["u2"]);
    });

    expect(result.current.state.error).toBe("仅桌面端支持语音通话");
    expect(result.current.state.status).toBe("idle");
    expect(send).not.toHaveBeenCalled();
  });

  it("call() 失败后清理资源，后续 call() 不被旧 callId 挡住", async () => {
    const origDesc = Object.getOwnPropertyDescriptor(MockRTCPeerConnection.prototype, "createOffer");
    const proto = MockRTCPeerConnection.prototype;
    let failOnce = true;
    proto.createOffer = vi.fn(() => {
      if (failOnce) {
        failOnce = false;
        return Promise.reject(new Error("boom"));
      }
      return Promise.resolve({ type: "offer", sdp: "v=0 mock-offer" });
    });
    try {
      const send = vi.fn();
      const { result } = renderHook(() => useVoiceCall({ send, myUserId: "u1" }));

      await act(async () => {
        await result.current.call("c1", ["u2"]);
      });
      expect(result.current.state.error).toBe("语音通话不可用");

      // 第二次 call() 不应报「已有通话进行中」；邀请仍应发送
      await act(async () => {
        await result.current.call("c1", ["u2"]);
      });
      const invites = sendByType(send, "voice_call_invite");
      expect(invites).toHaveLength(1);

      // 麦克风流必须已停止
      expect(media.trackStop).toHaveBeenCalled();
    } finally {
      if (origDesc) {
        Object.defineProperty(proto, "createOffer", origDesc);
      }
    }
  });

  it("accept 前收到的远端 ICE candidate 被暂存并在 accept 后 flush", async () => {
    const send = vi.fn();
    const { result } = renderHook(() => useVoiceCall({ send, myUserId: "u1" }));

    act(() => {
      result.current.handleServerEvent({
        type: "voice_call_invite",
        conversationId: "c1",
        callId: "call-pending-ice",
        sdp: "v=0 mock-offer",
      } as WsServerEvent);
    });

    // 被叫尚未 accept，peersRef 为空 → candidate 应被暂存而非丢弃
    await act(async () => {
      await result.current.handleServerEvent({
        type: "voice_call_ice",
        conversationId: "c1",
        callId: "call-pending-ice",
        candidate: "candidate:1 1 udp 2130706431 1.2.3.4 9999 typ host",
      } as WsServerEvent);
    });
    expect(MockRTCPeerConnection.instances).toHaveLength(0);

    await act(async () => {
      await result.current.accept("call-pending-ice");
    });

    const pc = MockRTCPeerConnection.instances[0];
    expect(pc.candidates).toHaveLength(1);
    expect(pc.candidates[0]).toMatchObject({
      candidate: "candidate:1 1 udp 2130706431 1.2.3.4 9999 typ host",
    });
  });

  it("getUserMedia 失败设置 error", async () => {
    media.getUserMedia.mockRejectedValue(new DOMException("denied", "NotAllowedError"));
    const send = vi.fn();
    const { result } = renderHook(() => useVoiceCall({ send, myUserId: "u1" }));

    await act(async () => {
      await result.current.call("c1", ["u2"]);
    });

    expect(result.current.state.error).toBe("麦克风权限被拒绝");
    expect(MockRTCPeerConnection.instances).toHaveLength(0);
  });

  it("toggleMute 切换静音状态", async () => {
    const send = vi.fn();
    const { result } = renderHook(() => useVoiceCall({ send, myUserId: "u1" }));
    await act(async () => {
      await result.current.call("c1", ["u2"]);
    });

    expect(result.current.state.muted).toBe(false);
    act(() => {
      result.current.toggleMute();
    });
    expect(result.current.state.muted).toBe(true);
    act(() => {
      result.current.toggleMute();
    });
    expect(result.current.state.muted).toBe(false);
  });
});
