import { render, screen, fireEvent } from "@testing-library/react";
import { describe, it, expect, vi } from "vitest";
import { VoiceCallPanel } from "./VoiceCallPanel.js";
import type { VoiceCallState } from "../lib/voiceCall.js";

const baseState: VoiceCallState = {
  callId: "c1",
  conversationId: "conv1",
  role: "caller",
  status: "ringing",
  peerIds: ["u2"],
  startedAt: null,
  muted: false,
  error: null,
  incoming: null,
};

describe("VoiceCallPanel", () => {
  it("status idle 时不渲染", () => {
    const { container } = render(
      <VoiceCallPanel
        state={{ ...baseState, status: "idle" }}
        peerNames={new Map()}
        onHangup={vi.fn()}
        onToggleMute={vi.fn()}
      />,
    );
    expect(container.firstChild).toBeNull();
  });

  it("ringing 状态显示参与者", () => {
    render(
      <VoiceCallPanel
        state={baseState}
        peerNames={new Map([["u2", "张三"]])}
        onHangup={vi.fn()}
        onToggleMute={vi.fn()}
      />,
    );
    expect(screen.getByText("张三")).toBeInTheDocument();
    expect(screen.getByText("正在呼叫…")).toBeInTheDocument();
  });

  it("active 状态显示计时器", () => {
    render(
      <VoiceCallPanel
        state={{ ...baseState, status: "active", startedAt: Date.now() }}
        peerNames={new Map([["u2", "李四"]])}
        onHangup={vi.fn()}
        onToggleMute={vi.fn()}
      />,
    );
    expect(screen.getByText(/^\d{2}:\d{2}$/)).toBeInTheDocument();
  });

  it("挂断按钮触发 onHangup", () => {
    const onHangup = vi.fn();
    render(
      <VoiceCallPanel
        state={{ ...baseState, status: "active", startedAt: Date.now() }}
        peerNames={new Map()}
        onHangup={onHangup}
        onToggleMute={vi.fn()}
      />,
    );
    fireEvent.click(screen.getByLabelText("挂断"));
    expect(onHangup).toHaveBeenCalled();
  });

  it("静音按钮触发 onToggleMute", () => {
    const onToggleMute = vi.fn();
    render(
      <VoiceCallPanel
        state={{ ...baseState, status: "active", startedAt: Date.now() }}
        peerNames={new Map()}
        onHangup={vi.fn()}
        onToggleMute={onToggleMute}
      />,
    );
    fireEvent.click(screen.getByLabelText("静音"));
    expect(onToggleMute).toHaveBeenCalled();
  });

  it("错误提示显示", () => {
    render(
      <VoiceCallPanel
        state={{ ...baseState, error: "麦克风权限被拒绝" }}
        peerNames={new Map()}
        onHangup={vi.fn()}
        onToggleMute={vi.fn()}
      />,
    );
    expect(screen.getByText("麦克风权限被拒绝")).toBeInTheDocument();
  });
});
