/**
 * 侧栏「未跑完」徽标（d.196）。
 *
 * 覆盖：没有标记时不渲染（不占位）、有标记时出现、收口后消失、只认本会话。
 */

import { beforeEach, describe, expect, it } from "vitest";
import { act, render, screen } from "@testing-library/react";
import "@testing-library/jest-dom/vitest";
import { UnfinishedTurnBadge } from "./UnfinishedTurnBadge.js";
import {
  clearTurnRunning,
  markTurnRunning,
  resetResumePoint,
} from "../lib/agentRuntime/resumePoint.js";

function mark(conversationId: string) {
  markTurnRunning({
    conversationId,
    streamId: `s-${conversationId}`,
    agentId: "system-assistant",
    agentName: "和小鸣",
    startedAt: Date.now(),
  });
}

describe("UnfinishedTurnBadge", () => {
  beforeEach(() => {
    localStorage.clear();
    resetResumePoint();
  });

  it("没有未跑完的一轮时不渲染任何东西", () => {
    const { container } = render(<UnfinishedTurnBadge conversationId="c1" />);
    expect(container).toBeEmptyDOMElement();
  });

  it("本会话有标记时显示「未跑完」，并说明去哪里接着做", () => {
    mark("c1");
    render(<UnfinishedTurnBadge conversationId="c1" />);
    const chip = screen.getByText("未跑完");
    expect(chip).toBeInTheDocument();
    expect(chip).toHaveAttribute("title", expect.stringContaining("继续"));
  });

  it("别的会话的标记不会显示在这个会话上", () => {
    mark("c2");
    const { container } = render(<UnfinishedTurnBadge conversationId="c1" />);
    expect(container).toBeEmptyDOMElement();
  });

  it("收口后徽标跟着消失（靠订阅，不轮询）", () => {
    mark("c1");
    render(<UnfinishedTurnBadge conversationId="c1" />);
    expect(screen.getByText("未跑完")).toBeInTheDocument();
    act(() => clearTurnRunning("c1"));
    expect(screen.queryByText("未跑完")).toBeNull();
  });

  it("挂载后新开始的标记也会显示（订阅生效）", () => {
    render(<UnfinishedTurnBadge conversationId="c1" />);
    expect(screen.queryByText("未跑完")).toBeNull();
    act(() => mark("c1"));
    expect(screen.getByText("未跑完")).toBeInTheDocument();
  });
});
