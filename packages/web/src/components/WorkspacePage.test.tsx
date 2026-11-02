import { describe, it, expect, beforeEach, vi } from "vitest";
import { fireEvent, render, screen } from "@testing-library/react";
import { WorkspacePage } from "./WorkspacePage.js";
import { useUiStore } from "../store/ui.js";

/**
 * 去 IM 后工作区不再承载联系人雷达/会话概览：本文件只锁
 * 「共享文件 → 助手对话」这条说明与入口。
 */
describe("WorkspacePage", () => {
  beforeEach(() => {
    vi.restoreAllMocks();
    useUiStore.setState({ page: "workspace", activeConversationId: null });
  });

  it("渲染工作区说明与共享文件边界", () => {
    render(<WorkspacePage />);
    expect(screen.getByText("工作区")).toBeInTheDocument();
    expect(screen.getByText("共享文件与智能体对话")).toBeInTheDocument();
    expect(screen.getByText("上传")).toBeInTheDocument();
    expect(screen.getByText("隐私边界")).toBeInTheDocument();
  });

  it("「去智能体对话」切到智能体页", () => {
    render(<WorkspacePage />);
    fireEvent.click(screen.getByRole("button", { name: "去智能体对话" }));
    expect(useUiStore.getState().page).toBe("chat");
  });
});
