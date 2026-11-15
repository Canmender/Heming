import { describe, expect, it, vi } from "vitest";
import { fireEvent, render, screen, within } from "@testing-library/react";
import { ProgressPanel } from "./ProgressPanel.js";

/**
 * 会话进度栏（空壳，d.150 精简外壳）。
 *
 * 纯展示组件：开合由 App 的 `progressOpen` state 控制，这里只收 `onClose`。
 * 契约（REFACTOR-BRIEF / T7）：`aside aria-label="会话进度"`（complementary）+
 * 栏头 h2「会话进度」+ 关闭 IconButton label「关闭会话进度」+ 空态标题
 * 「这一轮还没有进度」与一句说明。
 */
describe("ProgressPanel 会话进度栏", () => {
  it("渲染为右侧 complementary 栏：标题「会话进度」+ 可关闭", () => {
    const onClose = vi.fn();
    render(<ProgressPanel onClose={onClose} />);

    const panel = screen.getByRole("complementary", { name: "会话进度" });
    expect(panel.tagName).toBe("ASIDE");
    expect(
      within(panel).getByRole("heading", { level: 2, name: "会话进度" }),
    ).toBeInTheDocument();

    fireEvent.click(within(panel).getByRole("button", { name: "关闭会话进度" }));
    expect(onClose).toHaveBeenCalledTimes(1);
  });

  it("空态：标题「这一轮还没有进度」+ 说明文案（无进度项）", () => {
    render(<ProgressPanel onClose={() => {}} />);

    expect(
      screen.getByRole("heading", { level: 2, name: "这一轮还没有进度" }),
    ).toBeInTheDocument();
    expect(
      screen.getByText("工具调用、任务步骤和待确认事项会显示在这里。"),
    ).toBeInTheDocument();
  });
});
