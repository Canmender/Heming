import { afterEach, describe, expect, it } from "vitest";
import { cleanup, render, screen } from "@testing-library/react";
import { EmptyState } from "./EmptyState.js";

afterEach(() => cleanup());

describe("EmptyState 统一空态", () => {
  it("渲染图标/标题/说明/操作，并使用 .ui-empty* 基元", () => {
    const { container } = render(
      <EmptyState
        icon={<svg data-testid="empty-icon" />}
        title="还没有自动化任务"
        desc="可以把同步归档设成每天定时执行。"
        actions={<button type="button">新建自动化</button>}
      />,
    );
    const root = container.firstElementChild as HTMLElement;
    expect(root.className).toContain("ui-empty");
    expect(screen.getByText("还没有自动化任务").className).toContain("ui-empty-title");
    expect(screen.getByText("可以把同步归档设成每天定时执行。").className).toContain(
      "ui-empty-desc",
    );
    expect(screen.getByRole("button", { name: "新建自动化" })).toBeInTheDocument();
    // 图标槽是 32px 的装饰件：读屏不重复念
    const iconSlot = screen.getByTestId("empty-icon").parentElement as HTMLElement;
    expect(iconSlot.className).toContain("h-8");
    expect(iconSlot.className).toContain("w-8");
    expect(iconSlot).toHaveAttribute("aria-hidden", "true");
  });

  it("只给 title 时也能工作（无图标/说明/操作不渲染空壳）", () => {
    const { container } = render(<EmptyState title="当前没有人在线" />);
    const root = container.firstElementChild as HTMLElement;
    expect(root.className).toContain("ui-empty");
    expect(screen.getByText("当前没有人在线")).toBeInTheDocument();
    expect(container.querySelector(".ui-empty-desc")).toBeNull();
    expect(container.querySelector(".ui-empty-actions")).toBeNull();
  });

  it("compact 收紧卡片内空态的留白（py-5），并保留外部 className", () => {
    const { container } = render(
      <EmptyState title="暂无智能体" compact className="text-left" />,
    );
    const root = container.firstElementChild as HTMLElement;
    expect(root.className).toContain("ui-empty");
    expect(root.className).toContain("py-5");
    expect(root.className).toContain("text-left");
  });

  it("标题/说明支持 React 节点（保留强调与换行语义）", () => {
    render(
      <EmptyState
        title={
          <>
            还没有<strong>团队动向</strong>
          </>
        }
        desc={<span>成员开启共享后会出现摘要。</span>}
      />,
    );
    expect(screen.getByText("团队动向", { selector: "strong" })).toBeInTheDocument();
    expect(screen.getByText("成员开启共享后会出现摘要。")).toBeInTheDocument();
  });
});
