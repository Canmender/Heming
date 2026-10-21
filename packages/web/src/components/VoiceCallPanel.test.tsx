import { render, screen, fireEvent, act } from "@testing-library/react";
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
  reconnecting: 0,
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
    // 用 testid 而非 getByText 正则：文本节点可能带空白/换行，
    // /^\d{2}:\d{2}$/ 对原始节点不稳（依赖 testing-library 的空白归一化）
    expect(screen.getByTestId("call-duration")).toHaveTextContent(/^\d{2}:\d{2}$/);
  });

  it("reconnecting 大于 0 时给出重连提示（不弹错误条）", () => {
    render(
      <VoiceCallPanel
        state={{ ...baseState, status: "active", startedAt: Date.now(), reconnecting: 1 }}
        peerNames={new Map([["u2", "李四"]])}
        onHangup={vi.fn()}
        onToggleMute={vi.fn()}
      />,
    );
    expect(screen.getByRole("status")).toHaveTextContent("连接中断，正在重连…");
    expect(screen.queryByRole("alert")).toBeNull();
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

  it("callee ringing：面板内渲染接听/拒绝按钮，点击触发回调", () => {
    const onAccept = vi.fn();
    const onReject = vi.fn();
    render(
      <VoiceCallPanel
        state={{ ...baseState, role: "callee", peerIds: [] }}
        peerNames={new Map()}
        onHangup={vi.fn()}
        onToggleMute={vi.fn()}
        onAccept={onAccept}
        onReject={onReject}
      />,
    );
    // 按钮在全屏面板内（z-50），不被遮挡
    fireEvent.click(screen.getByLabelText("接听"));
    fireEvent.click(screen.getByLabelText("拒绝"));
    expect(onAccept).toHaveBeenCalledTimes(1);
    expect(onReject).toHaveBeenCalledTimes(1);
  });

  it("callee ringing：不渲染空名参与者灰点（peerIds 为空）", () => {
    const { container } = render(
      <VoiceCallPanel
        state={{ ...baseState, role: "callee", peerIds: [] }}
        peerNames={new Map()}
        onHangup={vi.fn()}
        onToggleMute={vi.fn()}
        onAccept={vi.fn()}
        onReject={vi.fn()}
      />,
    );
    // 来电文案仍在，但不出现空的参与者名节点
    expect(screen.getByText("来电")).toBeInTheDocument();
    expect(container.querySelectorAll(".h-3.w-3.rounded-full")).toHaveLength(0);
  });

  it("caller ringing：不渲染接听/拒绝按钮", () => {
    render(
      <VoiceCallPanel
        state={baseState}
        peerNames={new Map([["u2", "张三"]])}
        onHangup={vi.fn()}
        onToggleMute={vi.fn()}
        onAccept={vi.fn()}
        onReject={vi.fn()}
      />,
    );
    expect(screen.queryByLabelText("接听")).not.toBeInTheDocument();
    expect(screen.queryByLabelText("拒绝")).not.toBeInTheDocument();
  });

  it("idle + error：渲染轻量错误提示条（非全屏），TTL 后消失", () => {
    vi.useFakeTimers();
    try {
      const { container } = render(
        <VoiceCallPanel
          state={{ ...baseState, status: "idle", error: "麦克风权限被拒绝" }}
          peerNames={new Map()}
          onHangup={vi.fn()}
          onToggleMute={vi.fn()}
        />,
      );
      const bar = screen.getByRole("alert");
      expect(bar).toHaveTextContent("麦克风权限被拒绝");
      // 非全屏：不带 fixed inset-0
      expect(container.querySelector(".fixed.inset-0")).toBeNull();

      act(() => {
        vi.advanceTimersByTime(3000);
      });
      expect(screen.queryByRole("alert")).not.toBeInTheDocument();
    } finally {
      vi.useRealTimers();
    }
  });

  it("idle 且无 error：不渲染任何内容", () => {
    const { container } = render(
      <VoiceCallPanel
        state={{ ...baseState, status: "idle", error: null }}
        peerNames={new Map()}
        onHangup={vi.fn()}
        onToggleMute={vi.fn()}
      />,
    );
    expect(container.firstChild).toBeNull();
  });

  it("扬声器按钮为 disabled 死按钮（无 aria-label，不可被读屏当可交互）", () => {
    render(
      <VoiceCallPanel
        state={{ ...baseState, status: "active", startedAt: Date.now() }}
        peerNames={new Map()}
        onHangup={vi.fn()}
        onToggleMute={vi.fn()}
      />,
    );
    const speaker = screen.getByTestId("speaker-btn");
    expect(speaker).toBeDisabled();
    expect(screen.queryByLabelText("扬声器")).not.toBeInTheDocument();
  });
});
