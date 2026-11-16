import { describe, expect, it, vi } from "vitest";
import { render, screen } from "@testing-library/react";
import { fireEvent } from "@testing-library/react";
import { PlanReadyBar } from "./PlanReadyBar.js";

/**
 * 「计划已就绪」条（d.173）。
 *
 * 它只做一件事：把「方案出来了、还没动文件」变成一个能点的按钮。
 * 因此测试只关心三件事——话说清楚了、点执行只触发一次、可以不执行而是接着聊。
 */
describe("PlanReadyBar（d.173）", () => {
  it("说清楚现在只给了方案、文件还没动", () => {
    render(<PlanReadyBar onExecute={() => {}} />);
    expect(screen.getByRole("status")).toHaveTextContent("计划模式");
    expect(screen.getByRole("status")).toHaveTextContent("只给了方案");
    expect(screen.getByRole("status")).toHaveTextContent("文件还没有改动");
  });

  it("点「接受计划，开始执行」只回调一次", () => {
    const onExecute = vi.fn();
    render(<PlanReadyBar onExecute={onExecute} />);
    fireEvent.click(screen.getByRole("button", { name: "接受计划，开始执行" }));
    expect(onExecute).toHaveBeenCalledTimes(1);
  });

  it("有「继续讨论」时才渲染它，点了只收起、不执行", () => {
    const onExecute = vi.fn();
    const onDismiss = vi.fn();
    const { rerender } = render(<PlanReadyBar onExecute={onExecute} onDismiss={onDismiss} />);
    fireEvent.click(screen.getByRole("button", { name: "继续讨论" }));
    expect(onDismiss).toHaveBeenCalledTimes(1);
    expect(onExecute).not.toHaveBeenCalled();

    rerender(<PlanReadyBar onExecute={onExecute} />);
    expect(screen.queryByRole("button", { name: "继续讨论" })).toBeNull();
  });

  it("是 status 而不是 alert：它不需要打断读屏", () => {
    render(<PlanReadyBar onExecute={() => {}} />);
    const bar = screen.getByRole("status");
    expect(bar).toHaveAttribute("aria-live", "polite");
    expect(screen.queryByRole("alert")).toBeNull();
  });
});
