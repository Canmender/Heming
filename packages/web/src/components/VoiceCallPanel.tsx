import { useState, useEffect, useRef } from "react";
import type { VoiceCallState } from "../lib/voiceCall.js";
import { PhoneIcon, PhoneOffIcon, MicIcon, MicOffIcon, VolumeIcon } from "./icons.js";

interface VoiceCallPanelProps {
  state: VoiceCallState;
  peerNames: Map<string, string>;
  onHangup: () => void;
  onToggleMute: () => void;
  /** 被叫接听（仅 ringing && role === "callee" 时渲染） */
  onAccept?: () => void;
  /** 被叫拒接（仅 ringing && role === "callee" 时渲染） */
  onReject?: () => void;
}

/** 错误提示条自动消失时长（毫秒）。 */
const ERROR_BAR_TTL_MS = 3000;

function formatDuration(ms: number): string {
  const s = Math.floor(ms / 1000);
  const m = Math.floor(s / 60);
  const h = Math.floor(m / 60);
  const ss = s % 60;
  const mm = m % 60;
  if (h > 0)
    return `${h}:${mm.toString().padStart(2, "0")}:${ss.toString().padStart(2, "0")}`;
  return `${mm.toString().padStart(2, "0")}:${ss.toString().padStart(2, "0")}`;
}

export function VoiceCallPanel({
  state,
  peerNames,
  onHangup,
  onToggleMute,
  onAccept,
  onReject,
}: VoiceCallPanelProps) {
  const [duration, setDuration] = useState(0);
  const timerRef = useRef<number | null>(null);
  /** 错误提示条可见性：idle + error 时挂载，TTL 到后自清（非全屏，不挡会话）。 */
  const [errorBarVisible, setErrorBarVisible] = useState(false);

  useEffect(() => {
    if (state.status === "active" && state.startedAt) {
      timerRef.current = window.setInterval(() => {
        setDuration(Date.now() - state.startedAt!);
      }, 1000);
    }
    return () => {
      if (timerRef.current) clearInterval(timerRef.current);
    };
  }, [state.status, state.startedAt]);

  // 错误提示条：仅在 idle + error 时出现；error 变化即重置 TTL，
  // 避免「先 idle 无错 → 出错」与「错误持续存在」两种情形下计时错乱。
  useEffect(() => {
    if (state.status !== "idle" || !state.error) {
      setErrorBarVisible(false);
      return;
    }
    setErrorBarVisible(true);
    const t = window.setTimeout(() => setErrorBarVisible(false), ERROR_BAR_TTL_MS);
    return () => window.clearTimeout(t);
  }, [state.status, state.error]);

  // 被叫 ringing：接听/拒绝按钮渲染在面板内（全屏 z-50），不再依赖被面板
  // 遮挡的 ChatPage 横幅——否则被叫只能挂断、无法接听。
  const showCalleeActions = state.status === "ringing" && state.role === "callee";

  // 参与者列表：callee 在 accept 之前不知道对端是谁（peerIds 为空），
  // 此时不渲染空名灰点，改显示「来电」文案。
  const showPeerList = !(state.status === "ringing" && state.role === "callee");

  if (state.status === "idle") {
    // 轻量错误提示条（非全屏）：call() 失败时 status 保持 idle，
    // 全屏面板不渲染，错误必须在此独立可见。
    if (state.error && errorBarVisible) {
      return (
        <div
          role="alert"
          className="fixed left-1/2 top-4 z-50 -translate-x-1/2 rounded-lg border border-[#e6e6e6] bg-white px-4 py-2 text-[13px] text-[#b42318] shadow-card"
        >
          {state.error}
        </div>
      );
    }
    return null;
  }

  return (
    <div className="fixed inset-0 z-50 flex items-center justify-center bg-[#1a1a2e]">
      <div className="flex flex-col items-center gap-8 text-white">
        <div className="text-[12px] text-gray-400">语音通话</div>

        {/* 参与者列表 */}
        {showPeerList && (
          <div className="flex flex-col items-center gap-3">
            {state.peerIds.map((peerId) => (
              <div key={peerId} className="flex items-center gap-3">
                <div
                  className={`h-3 w-3 rounded-full ${
                    state.status === "active" ? "bg-[#4ade80] animate-pulse" : "bg-gray-500"
                  }`}
                />
                <span className="text-[16px]">{peerNames.get(peerId) ?? peerId}</span>
              </div>
            ))}
            {state.status === "ringing" && (
              <span className="text-[14px] text-gray-300">
                {state.role === "caller" ? "正在呼叫…" : "来电"}
              </span>
            )}
          </div>
        )}
        {/* 被叫 ringing：面板内直接给接听/拒绝（全屏 z-50 之上，可见可点） */}
        {showCalleeActions && (
          <div className="flex flex-col items-center gap-3">
            <span className="text-[14px] text-gray-300">来电</span>
            <div className="flex items-center gap-4">
              <button
                type="button"
                aria-label="接听"
                className="flex h-14 w-14 items-center justify-center rounded-full bg-[#4ade80] text-white transition hover:bg-[#22c55e]"
                onClick={onAccept}
              >
                <PhoneIcon width={22} height={22} />
              </button>
              <button
                type="button"
                aria-label="拒绝"
                className="flex h-14 w-14 items-center justify-center rounded-full bg-[#ef4444] text-white transition hover:bg-[#dc2626]"
                onClick={onReject}
              >
                <PhoneOffIcon width={22} height={22} />
              </button>
            </div>
          </div>
        )}

        {/* 通话时长 */}
        {state.status === "active" && (
          <div
            data-testid="call-duration"
            className="text-[28px] font-light tabular-nums text-white"
          >
            {formatDuration(duration)}
          </div>
        )}

        {/* 错误提示 */}
        {state.error && (
          <div className="text-[14px] text-red-400">{state.error}</div>
        )}

        {/* 操作按钮 */}
        <div className="flex items-center gap-6">
          <button
            type="button"
            aria-label={state.muted ? "取消静音" : "静音"}
            className="flex h-14 w-14 items-center justify-center rounded-full bg-[#3b82f6] text-white transition hover:bg-[#2563eb]"
            onClick={onToggleMute}
          >
            {state.muted ? <MicOffIcon width={22} height={22} /> : <MicIcon width={22} height={22} />}
          </button>
          <button
            type="button"
            aria-label="挂断"
            className="flex h-14 w-14 items-center justify-center rounded-full bg-[#ef4444] text-white transition hover:bg-[#dc2626]"
            onClick={onHangup}
          >
            <PhoneOffIcon width={22} height={22} />
          </button>
          {/* 扬声器：暂无实现。保留可聚焦形态但标注 disabled，避免读屏软件
              把死按钮误认为可交互；不挂 aria-label（无功能即无名）。 */}
          <button
            type="button"
            disabled
            aria-disabled="true"
            data-testid="speaker-btn"
            className="flex h-14 w-14 items-center justify-center rounded-full bg-[#3b82f6] text-white transition hover:bg-[#2563eb] disabled:cursor-not-allowed disabled:opacity-40"
          >
            <VolumeIcon width={22} height={22} />
          </button>
        </div>
      </div>
    </div>
  );
}
