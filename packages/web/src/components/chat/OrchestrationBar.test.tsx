import { afterEach, describe, expect, it, vi } from "vitest";
import { cleanup, fireEvent, render, screen, within } from "@testing-library/react";
import { OrchestrationBar, type ChatView } from "./OrchestrationBar.js";

/**
 * 编排条（T32）：纯展示组件，只验「props 怎么变成 DOM」，不碰 store。
 *
 * 契约：
 * - 根节点 `data-testid="chat-orchestration"`；
 * - 第一行 h2 = title；chips：`[data-chip="tools"]`「N 个工具调用」、
 *   `[data-chip="tasks"]`「N 个后台任务」；派发在对话里完成，没有独立的协作页 chip；
 * - 第二行 `role="tablist" aria-label="会话视图"`，三个 tab（对话/轨迹/上下文）
 *   带 `data-view`、`aria-selected`、`aria-controls`。
 */

function renderBar(over: Partial<Parameters<typeof OrchestrationBar>[0]> = {}) {
  const props = {
    title: "周会纪要",
    toolsCount: 3,
    tasksCount: 1,
    view: "chat" as ChatView,
    onViewChange: vi.fn(),
    ...over,
  };
  render(<OrchestrationBar {...props} />);
  return props;
}

afterEach(() => cleanup());

describe("OrchestrationBar · 编排事实与视图页签", () => {
  it("标题取会话名；两个 chip 显示真实计数，没有「标准模式」与协作页入口", () => {
    renderBar();
    expect(screen.getByTestId("chat-orchestration")).toBeInTheDocument();
    expect(screen.getByRole("heading", { level: 2, name: "周会纪要" })).toBeInTheDocument();

    expect(screen.queryByRole("button", { name: "多智能体协作" })).toBeNull();
    expect(document.querySelector('[data-chip="collab"]')).toBeNull();
    expect(screen.queryByText("标准模式")).toBeNull();
    expect(screen.getByText("3 个工具调用")).toHaveAttribute("data-chip", "tools");
    expect(screen.getByText("1 个后台任务")).toHaveAttribute("data-chip", "tasks");
  });

  it("计数为 0 也如实显示（不藏 chip、不编数字）", () => {
    renderBar({ toolsCount: 0, tasksCount: 0 });
    expect(screen.getByText("0 个工具调用")).toBeInTheDocument();
    expect(screen.getByText("0 个后台任务")).toBeInTheDocument();
  });

  it("页签固定三个、顺序为 对话/轨迹/上下文，当前 view 标 aria-selected", () => {
    renderBar();
    const tablist = screen.getByRole("tablist", { name: "会话视图" });
    const tabs = within(tablist).getAllByRole("tab");
    expect(tabs.map((t) => t.textContent)).toEqual(["对话", "轨迹", "上下文"]);
    expect(tabs.map((t) => t.getAttribute("data-view"))).toEqual(["chat", "trail", "context"]);
    expect(tabs[0]).toHaveAttribute("aria-selected", "true");
    expect(tabs[1]).toHaveAttribute("aria-selected", "false");
    // aria-controls 指向对应面板 id，页签与面板一一对应
    expect(tabs[1]).toHaveAttribute("aria-controls", "chat-view-panel-trail");
  });

  it("view=context 时只选中上下文页签", () => {
    renderBar({ view: "context" });
    expect(screen.getByRole("tab", { name: "上下文" })).toHaveAttribute("aria-selected", "true");
    expect(screen.getByRole("tab", { name: "对话" })).toHaveAttribute("aria-selected", "false");
  });

  it("点页签把目标 view 交给 onViewChange（组件自己不存状态）", () => {
    const props = renderBar({ view: "chat" });
    fireEvent.click(screen.getByRole("tab", { name: "轨迹" }));
    expect(props.onViewChange).toHaveBeenCalledWith("trail");
    fireEvent.click(screen.getByRole("tab", { name: "上下文" }));
    expect(props.onViewChange).toHaveBeenLastCalledWith("context");
  });

  it("leading / right 槽位渲染在标题左侧与行尾", () => {
    renderBar({
      leading: <button type="button">返回</button>,
      right: <button type="button">会话进度</button>,
    });
    expect(screen.getByRole("button", { name: "返回" })).toBeInTheDocument();
    expect(screen.getByRole("button", { name: "会话进度" })).toBeInTheDocument();
    // 阅读顺序：返回 → 标题
    const heading = screen.getByRole("heading", { level: 2, name: "周会纪要" });
    expect(
      screen.getByRole("button", { name: "返回" }).compareDocumentPosition(heading) &
        Node.DOCUMENT_POSITION_FOLLOWING,
    ).toBeTruthy();
  });
});
