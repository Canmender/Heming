import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { cleanup, fireEvent, render, screen, within } from "@testing-library/react";
import { ProgressPanel } from "./ProgressPanel.js";
import { useChatStore } from "../store/chat.js";
import type { AgentStreamState } from "../store/chat.js";

/**
 * 右侧「会话进度」面板（d.147.4.88）。
 *
 * 面板是**纯展示层**：数据由 `useConversationProgress(conversationId)` 从既有 store
 * （streaming / messages / HITL pending）推导，所以这里既测空态，也用真实的 store
 * 输入驱动四个 section（本轮进度 / 动态流程图 / 任务步骤 / 工具调用），
 * 不 mock 推导逻辑——否则「面板说成功、模型还在跑」这类矛盾测不出来。
 *
 * 开合不在这里测：开关是 ChatPage header 右上角那颗按钮，见 ChatPage.test。
 */
const base: AgentStreamState = {
  agentId: "system-assistant",
  conversationId: "c1",
  status: "streaming",
  text: "",
  lastAt: 1,
};

function setStream(patch: Partial<AgentStreamState> = {}): void {
  useChatStore.setState({ streaming: { s1: { ...base, ...patch } } });
}

beforeEach(() => {
  useChatStore.setState({ streaming: {}, messages: {} });
});

afterEach(() => cleanup());

describe("ProgressPanel · 空态", () => {
  it("渲染为右侧 complementary 栏：栏头「会话进度」+ 关闭按钮 + 空态标题", () => {
    const onClose = vi.fn();
    render(<ProgressPanel conversationId={null} onClose={onClose} />);

    const panel = screen.getByRole("complementary", { name: "会话进度" });
    expect(panel.tagName).toBe("ASIDE");
    expect(within(panel).getByRole("heading", { level: 2, name: "会话进度" })).toBeInTheDocument();
    expect(
      within(panel).getByRole("heading", { level: 2, name: "这一轮还没有进度" }),
    ).toBeInTheDocument();
    // 没有数据时不画进度条、不出四个 section 标题（空标题比没有更让人以为没加载出来）
    expect(within(panel).queryByRole("progressbar")).toBeNull();
    expect(within(panel).queryByRole("heading", { level: 3, name: "本轮进度" })).toBeNull();

    fireEvent.click(within(panel).getByRole("button", { name: "关闭会话进度" }));
    expect(onClose).toHaveBeenCalledTimes(1);
  });

  it("别的会话在流式，也不串进当前面板（conversationId 不匹配 = 空态）", () => {
    useChatStore.setState({
      streaming: {
        other: { ...base, conversationId: "c2", reasoning: "别的会话在思考" },
      },
    });
    render(<ProgressPanel conversationId={null} onClose={() => {}} />);

    expect(
      screen.getByRole("heading", { level: 2, name: "这一轮还没有进度" }),
    ).toBeInTheDocument();
    expect(screen.queryByRole("progressbar")).toBeNull();
  });
});

describe("ProgressPanel · 有数据", () => {
  it("四个 section 齐全，且进度条/流程图/步骤/工具都来自同一份推导", () => {
    setStream({
      reasoning: "先读一下文件，再总结",
      text: "正在整理会议纪要",
      tools: [
        {
          id: "t1",
          name: "read_file",
          args: "{}",
          status: "ok",
          result: "文件内容",
          startedAt: 1,
          endedAt: 12,
        },
      ],
    });
    render(<ProgressPanel conversationId="c1" onClose={() => {}} />);

    const panel = screen.getByRole("complementary", { name: "会话进度" });
    for (const title of ["本轮进度", "动态流程图", "任务步骤", "工具调用"]) {
      expect(within(panel).getByRole("heading", { level: 3, name: title })).toBeInTheDocument();
    }

    // 有工具在跑 → 阶段「正在调用工具」；思考+工具已完成、回答在生成 ⇒ done/total = 2/3
    expect(within(panel).getByTestId("progress-headline")).toHaveTextContent("正在调用工具");
    const bar = within(panel).getByRole("progressbar", { name: "本轮步骤进度" });
    expect(bar).toHaveAttribute("aria-valuenow", "2");
    expect(bar).toHaveAttribute("aria-valuemax", "3");
    expect(within(panel).getByTestId("progress-flow")).toBeInTheDocument();
    expect(within(panel).getByTestId("progress-flow-node-t1")).toBeInTheDocument();
    // 同一步骤会同时出现在「动态流程图」和「任务步骤」里（两处都是真实的读屏内容）。
    expect(within(panel).getAllByText("调用 read_file").length).toBeGreaterThanOrEqual(2);
    expect(within(panel).getByTestId("progress-counts")).toHaveTextContent("工具 1 次");
    expect(within(panel).queryByRole("heading", { level: 2, name: "这一轮还没有进度" })).toBeNull();
  });
});
