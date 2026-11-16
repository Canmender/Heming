import { fireEvent, render, screen } from "@testing-library/react";
import "@testing-library/jest-dom/vitest";
import { describe, expect, it, vi } from "vitest";
import { GoalBar } from "./GoalBar.js";

describe("GoalBar（d.201）", () => {
  it("有目标时把终点写在输入框上方，并给「完成」「清除」两个动作", () => {
    render(
      <GoalBar goal={{ text: "把登录改成扫码", createdAt: 1_000 }} onDone={vi.fn()} onClear={vi.fn()} />,
    );
    expect(screen.getByTestId("goal-bar")).toBeInTheDocument();
    expect(screen.getByText("把登录改成扫码")).toBeInTheDocument();
    expect(screen.getByRole("button", { name: "完成" })).toBeInTheDocument();
    expect(screen.getByRole("button", { name: "清除" })).toBeInTheDocument();
  });

  it("点「完成」把回调交回去（是否摘掉目标由上层决定）", () => {
    const onDone = vi.fn();
    render(<GoalBar goal={{ text: "目标", createdAt: 1 }} onDone={onDone} onClear={vi.fn()} />);
    fireEvent.click(screen.getByRole("button", { name: "完成" }));
    expect(onDone).toHaveBeenCalledTimes(1);
  });

  it("点「清除」同样只交回回调，不自己改存储", () => {
    const onClear = vi.fn();
    render(<GoalBar goal={{ text: "目标", createdAt: 1 }} onDone={vi.fn()} onClear={onClear} />);
    fireEvent.click(screen.getByRole("button", { name: "清除" }));
    expect(onClear).toHaveBeenCalledTimes(1);
  });

  it("没有目标就整条不渲染（不占位置、不留空条）", () => {
    const { container } = render(<GoalBar goal={null} onDone={vi.fn()} onClear={vi.fn()} />);
    expect(container).toBeEmptyDOMElement();
  });

  it("长目标压一行，但 title 保留全文（鼠标停上去能看全）", () => {
    const long = "把整条下单链路从创建到支付到发货全部改成新的状态机".repeat(4);
    render(<GoalBar goal={{ text: long, createdAt: 1 }} onDone={vi.fn()} onClear={vi.fn()} />);
    expect(screen.getByTitle(long)).toBeInTheDocument();
  });
});
