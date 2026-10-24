import { describe, it, expect, vi } from "vitest";
import { render, screen, fireEvent } from "@testing-library/react";
import { AgentStreamBubble } from "./AgentStreamBubble.js";

describe("AgentStreamBubble", () => {
  it("streaming 态显示名字与累积文本", () => {
    render(<AgentStreamBubble name="和小鸣" text="你好" status="streaming" />);
    expect(screen.getByText("和小鸣")).toBeInTheDocument();
    expect(screen.getByText(/你好/)).toBeInTheDocument();
    expect(document.body.textContent).toContain("▌");
  });

  it("error 态显示原因与继续生成回调", () => {
    const retry = vi.fn();
    render(
      <AgentStreamBubble
        name="和小鸣"
        text="半"
        status="error"
        errorMessage="HTTP 401"
        onRetry={retry}
      />,
    );
    expect(screen.getByText(/HTTP 401/)).toBeInTheDocument();
    // A2：错误行动作统一为「继续生成」
    fireEvent.click(screen.getByText("继续生成"));
    expect(retry).toHaveBeenCalled();
  });
});

describe("AgentStreamBubble 可视化（思考过程 / 工具调用）", () => {
  it("思考过程：流式中默认展开，可折叠；结束后自动收起", () => {
    const { rerender } = render(
      <AgentStreamBubble name="和小鸣" text="" status="streaming" reasoning="先分析一下问题" />,
    );
    expect(screen.getByText("思考过程")).toBeInTheDocument();
    expect(screen.getByText("先分析一下问题")).toBeInTheDocument();
    expect(screen.getByText(/7 字/)).toBeInTheDocument();

    // 手动折叠
    fireEvent.click(screen.getByRole("button", { name: "思考过程" }));
    expect(screen.queryByText("先分析一下问题")).not.toBeInTheDocument();

    // 再次展开
    fireEvent.click(screen.getByRole("button", { name: "思考过程" }));
    expect(screen.getByText("先分析一下问题")).toBeInTheDocument();

    // 流式结束 → 自动收起
    rerender(<AgentStreamBubble name="和小鸣" text="答案" status="error" reasoning="先分析一下问题" />);
    expect(screen.queryByText("先分析一下问题")).not.toBeInTheDocument();
  });

  it("工具调用：显示名称/状态/耗时，展开看参数与结果", () => {
    render(
      <AgentStreamBubble
        name="和小鸣"
        text=""
        status="streaming"
        tools={[
          {
            id: "t1",
            name: "srv__echo",
            args: '{"q":"hi"}',
            status: "ok",
            result: "回声：hi",
            startedAt: 1000,
            endedAt: 1120,
          },
          {
            id: "t2",
            name: "srv__now",
            args: "{}",
            status: "running",
            startedAt: 2000,
          },
        ]}
      />,
    );
    expect(screen.getByText("srv__echo")).toBeInTheDocument();
    expect(screen.getByText("完成")).toBeInTheDocument();
    expect(screen.getByText("120ms")).toBeInTheDocument();
    expect(screen.getByText("srv__now")).toBeInTheDocument();
    expect(screen.getByText("调用中")).toBeInTheDocument();
    // 结果默认折叠在 details 里（DOM 中可见但不可见文本仍可查询）
    expect(screen.getByText("回声：hi")).toBeInTheDocument();
    expect(screen.getByText('{"q":"hi"}')).toBeInTheDocument();
  });

  it("工具失败用错误态展示", () => {
    render(
      <AgentStreamBubble
        name="和小鸣"
        text=""
        status="streaming"
        tools={[
          {
            id: "t1",
            name: "srv__boom",
            args: "{}",
            status: "error",
            result: "工具调用失败：连接断了",
            startedAt: 1,
            endedAt: 2,
          },
        ]}
      />,
    );
    expect(screen.getByText("失败")).toBeInTheDocument();
    expect(screen.getByText(/连接断了/)).toBeInTheDocument();
  });

  it("没有思考过程与工具时，不渲染这两块（保持旧结构）", () => {
    render(<AgentStreamBubble name="和小鸣" text="你好" status="streaming" />);
    expect(screen.queryByText("思考过程")).not.toBeInTheDocument();
    expect(screen.queryByText("调用中")).not.toBeInTheDocument();
  });
});
