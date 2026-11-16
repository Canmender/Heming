import { describe, it, expect, vi } from "vitest";
import { render, screen, fireEvent } from "@testing-library/react";
import "@testing-library/jest-dom/vitest";
import { RoundLimitHint } from "./RoundLimitHint.js";
import { LONG_TASK_MAX_ROUNDS, LONG_TASK_MAX_SEGMENTS } from "../lib/agentRuntime/longTask.js";

describe("RoundLimitHint（d.167.4.103）", () => {
  it("说明这一轮用满多少轮、分几段，而不是只说「到上限了」", () => {
    render(<RoundLimitHint onContinue={() => {}} />);
    const hint = screen.getByRole("status");
    expect(hint).toHaveTextContent(`${LONG_TASK_MAX_ROUNDS} 轮`);
    expect(hint).toHaveTextContent(`${LONG_TASK_MAX_SEGMENTS} 段`);
    expect(hint).toHaveTextContent("任务可能还没做完");
  });

  it("点「继续」调一次 onContinue（继续 = 续写，不是重发原提问）", () => {
    const onContinue = vi.fn();
    render(<RoundLimitHint onContinue={onContinue} />);
    fireEvent.click(screen.getByRole("button", { name: "继续" }));
    expect(onContinue).toHaveBeenCalledTimes(1);
  });

  it("给了 onDismiss 才有「收起」；收起不触发继续", () => {
    const onContinue = vi.fn();
    const onDismiss = vi.fn();
    render(<RoundLimitHint onContinue={onContinue} onDismiss={onDismiss} />);
    fireEvent.click(screen.getByRole("button", { name: "收起" }));
    expect(onDismiss).toHaveBeenCalledTimes(1);
    expect(onContinue).not.toHaveBeenCalled();
  });

  it("没有 onDismiss 时不渲染「收起」（任务区/嵌入式场景不留死按钮）", () => {
    render(<RoundLimitHint onContinue={() => {}} />);
    expect(screen.queryByRole("button", { name: "收起" })).toBeNull();
  });

  it("是 status 而不是 alert：播报一次、不打断读屏", () => {
    render(<RoundLimitHint onContinue={() => {}} />);
    expect(screen.getByRole("status")).toHaveAttribute("aria-live", "polite");
    expect(screen.queryByRole("alert")).toBeNull();
  });

  it("预算收口时说「内容太多」而不是「轮次用完」（d.176.4.105）", () => {
    render(<RoundLimitHint reason="budget" onContinue={vi.fn()} />);
    const bar = screen.getByRole("status");
    expect(bar.textContent).toContain("工具返回的内容太多");
    expect(bar.textContent).toContain("预算");
    expect(bar.textContent).not.toContain("36 轮");
    // 入口不变：仍然是一次点击的「继续」。
    expect(screen.getByRole("button", { name: "继续" })).toBeInTheDocument();
  });
});
