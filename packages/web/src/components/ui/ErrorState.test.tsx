import { afterEach, describe, expect, it, vi } from "vitest";
import { cleanup, render, screen } from "@testing-library/react";
import { fireEvent } from "@testing-library/react";
import { ErrorState } from "./ErrorState.js";

afterEach(() => cleanup());

describe("ErrorState（失败态基元）", () => {
  it("用 role=alert 播报，标题与说明分两层", () => {
    render(<ErrorState title="历史消息加载失败" desc="网络中断，请稍后再试。" />);
    const alert = screen.getByRole("alert");
    expect(alert).toHaveTextContent("历史消息加载失败");
    expect(alert).toHaveTextContent("网络中断，请稍后再试。");
  });

  it("不传 onRetry 时不渲染重试按钮（不可重试的错误）", () => {
    render(<ErrorState title="没有权限查看这条记录" />);
    expect(screen.queryByRole("button", { name: "重试" })).toBeNull();
  });

  it("传 onRetry 时渲染重试按钮，点击只回调一次", () => {
    const onRetry = vi.fn();
    render(<ErrorState title="加载失败" onRetry={onRetry} />);
    fireEvent.click(screen.getByRole("button", { name: "重试" }));
    expect(onRetry).toHaveBeenCalledTimes(1);
  });

  it("retryLabel 可改文案（如「重新加载」）", () => {
    render(<ErrorState title="加载失败" onRetry={vi.fn()} retryLabel="重新加载" />);
    expect(screen.getByRole("button", { name: "重新加载" })).toBeTruthy();
  });

  it("compact 变体收紧上下留白，用于卡片内部", () => {
    const { container } = render(<ErrorState compact title="加载失败" />);
    expect(container.firstChild).toHaveProperty("className");
    expect(String((container.firstChild as HTMLElement).className)).toContain("py-5");
  });
});
