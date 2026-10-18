import { useState, useEffect, useRef } from "react";
import type { VoiceCallState } from "../lib/voiceCall.js";
import { PhoneOffIcon, MicIcon, MicOffIcon, VolumeIcon } from "./icons.js";

interface VoiceCallPanelProps {
  state: VoiceCallState;
  peerNames: Map<string, string>;
  onHangup: () => void;
  onToggleMute: () => void;
}

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

export function VoiceCallPanel({ state, peerNames, onHangup, onToggleMute }: VoiceCallPanelProps) {
  const [duration, setDuration] = useState(0);
  const timerRef = useRef<number | null>(null);

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

  if (state.status === "idle") return null;

  return (
    <div className="fixed inset-0 z-50 flex items-center justify-center bg-[#1a1a2e]">
      <div className="flex flex-col items-center gap-8 text-white">
        <div className="text-[12px] text-gray-400">语音通话</div>

        {/* 参与者列表 */}
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

        {/* 通话时长 */}
        {state.status === "active" && (
          <div className="text-[28px] font-light tabular-nums text-white">
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
          <button
            type="button"
            aria-label="扬声器"
            className="flex h-14 w-14 items-center justify-center rounded-full bg-[#3b82f6] text-white transition hover:bg-[#2563eb]"
          >
            <VolumeIcon width={22} height={22} />
          </button>
        </div>
      </div>
    </div>
  );
}
