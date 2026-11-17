import { afterEach, describe, expect, it } from "vitest";
import { act, cleanup, render, screen, waitFor } from "@testing-library/react";
import { RunningTurnBadge } from "./RunningTurnBadge.js";
import { useChatStore, type AgentStreamState } from "../store/chat.js";

/**
 * d.212：徽标本身只做一件事——把「这个会话此刻在跑」翻成一行字。
 * 口径在 `lib/agentRuntime/runningStreams.test.ts`，这里验「读 store 的接线对不对」。
 */

function streamOf(conversationId: string, status: AgentStreamState["status"] = "streaming"): AgentStreamState {
  return { agentId: "a1", conversationId, text: "", status, lastAt: 1_700_000_000_000 };
}

afterEach(() => {
  cleanup();
  useChatStore.setState({ streaming: {}, streamOwner: {} });
});

describe("RunningTurnBadge（d.212）", () => {
  it("本机在跑的会话显示「正在跑」", () => {
    useChatStore.setState({ streaming: { s1: streamOf("c1") }, streamOwner: { s1: true } });
    render(<RunningTurnBadge conversationId="c1" />);
    const badge = screen.getByText("正在跑");
    expect(badge).toBeInTheDocument();
    expect(badge.getAttribute("title")).toContain("还在跑");
    expect(badge.getAttribute("aria-label")).toBe("正在跑");
  });

  it("别的会话在跑时不显示（只标那一条）", () => {
    useChatStore.setState({ streaming: { s1: streamOf("c2") }, streamOwner: { s1: true } });
    render(<RunningTurnBadge conversationId="c1" />);
    expect(screen.queryByText("正在跑")).toBeNull();
  });

  it("没有本机流（只有别的设备的回声）时不显示", () => {
    useChatStore.setState({ streaming: { s1: streamOf("c1") }, streamOwner: {} });
    render(<RunningTurnBadge conversationId="c1" />);
    expect(screen.queryByText("正在跑")).toBeNull();
  });

  it("流收口后自己消失（订阅的不是一次快照）", async () => {
    useChatStore.setState({ streaming: { s1: streamOf("c1") }, streamOwner: { s1: true } });
    render(<RunningTurnBadge conversationId="c1" />);
    expect(screen.getByText("正在跑")).toBeInTheDocument();

    act(() => useChatStore.setState({ streaming: {}, streamOwner: {} }));
    await waitFor(() => expect(screen.queryByText("正在跑")).toBeNull());
  });
});
