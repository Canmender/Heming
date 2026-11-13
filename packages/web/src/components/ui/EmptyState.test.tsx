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
    // 图标槽走 d.125 的统一图标砖（.ui-icon-tile，40px/accent 8% 底）：读屏不重复念
    const iconSlot = screen.getByTestId("empty-icon").parentElement as HTMLElement;
    expect(iconSlot.className).toContain("ui-icon-tile");
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

  it("framed 变体自带卡片描边（空态自己就是一块卡片）", () => {
    const { container } = render(<EmptyState title="插件列表为空" framed />);
    const root = container.firstElementChild as HTMLElement;
    expect(root.className).toContain("ui-empty");
    expect(root.className).toContain("ui-card");
    expect(root.className).toContain("py-8");
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

  it("align=start：侧栏/卡片内左对齐（不再居中折断句子）", () => {
    const { container } = render(<EmptyState title="还没有其他成员。" align="start" compact />);
    const root = container.firstElementChild as HTMLElement;
    expect(root.className).toContain("items-start");
    expect(root.className).toContain("text-left");
    expect(root.className).toContain("py-5");
  });

  it("action 单数插槽：不包数组也渲染操作区，且 actions 优先", () => {
    const { rerender } = render(
      <EmptyState title="还没有日程" action={<button type="button">去连接</button>} />,
    );
    expect(screen.getByRole("button", { name: "去连接" })).toBeInTheDocument();

    rerender(
      <EmptyState
        title="还没有日程"
        action={<button type="button">单个</button>}
        actions={<button type="button">多个</button>}
      />,
    );
    expect(screen.getByRole("button", { name: "多个" })).toBeInTheDocument();
    expect(screen.queryByRole("button", { name: "单个" })).toBeNull();
  });
});
