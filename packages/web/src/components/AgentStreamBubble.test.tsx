import { describe, it, expect, vi } from "vitest";
import { render, screen, fireEvent } from "@testing-library/react";
import { AgentStreamBubble } from "./AgentStreamBubble.js";

describe("AgentStreamBubble", () => {
  it("streaming 态显示名字与累积文本", () => {
    render(<AgentStreamBubble name="和小鸣" text="你好" status="streaming" />);
    expect(screen.getByText("和小鸣")).toBeInTheDocument();
    expect(screen.getByText(/你好/)).toBeInTheDocument();
    expect(screen.getByText("▌")).toBeInTheDocument();
  });

  it("error 态显示原因与重试回调", () => {
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
    fireEvent.click(screen.getByText("重试"));
    expect(retry).toHaveBeenCalled();
  });
});
