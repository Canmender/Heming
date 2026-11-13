import { afterEach, describe, expect, it, vi } from "vitest";
import { cleanup, fireEvent, render, screen } from "@testing-library/react";
import { createRef } from "react";
import { IconButton } from "./IconButton.js";

afterEach(() => cleanup());

/**
 * 图标按钮：没有读屏名的图标按钮是「无名按钮」，且命中区必须 ≥32×32。
 * 这两条是 ③-2 的验收口径，用测试钉住，避免以后有人手写回 <button><svg/></button>。
 */

describe("IconButton 基元", () => {
  it("用 label 当读屏名，默认 type=button，命中区 32×32", () => {
    render(<IconButton label="关闭提示" icon={<svg data-testid="ico" />} />);
    const btn = screen.getByRole("button", { name: "关闭提示" });
    expect(btn).toHaveAttribute("aria-label", "关闭提示");
    expect(btn).toHaveAttribute("title", "关闭提示");
    expect(btn).toHaveAttribute("type", "button");
    expect(btn.className).toContain("h-8");
    expect(btn.className).toContain("w-8");
  });

  it("图标是装饰：容器 aria-hidden，图标名不进按钮名", () => {
    render(<IconButton label="更多操作" icon={<svg data-testid="ico" />} />);
    expect(screen.getByTestId("ico").parentElement).toHaveAttribute("aria-hidden", "true");
    expect(screen.getByRole("button", { name: "更多操作" })).toBeInTheDocument();
  });

  it("焦点可见：带统一焦点环，且 reduced-motion 下不跑过渡", () => {
    render(<IconButton label="刷新" icon={<svg />} />);
    const btn = screen.getByRole("button", { name: "刷新" });
    expect(btn.className).toContain("focus-visible:outline-2");
    expect(btn.className).toContain("motion-reduce:transition-none");
  });

  it("点击透传，disabled 时不再触发", () => {
    const onClick = vi.fn();
    const { rerender } = render(<IconButton label="关闭" icon={<svg />} onClick={onClick} />);
    screen.getByRole("button", { name: "关闭" }).click();
    expect(onClick).toHaveBeenCalledTimes(1);
    rerender(<IconButton label="关闭" icon={<svg />} onClick={onClick} disabled />);
    fireEvent.click(screen.getByRole("button", { name: "关闭" }));
    expect(onClick).toHaveBeenCalledTimes(1);
  });

  it("ref 落到真实 button；className 只追加布局类", () => {
    const ref = createRef<HTMLButtonElement>();
    render(<IconButton ref={ref} label="关闭" icon={<svg />} className="ml-auto" />);
    expect(ref.current).toBeInstanceOf(HTMLButtonElement);
    expect(screen.getByRole("button", { name: "关闭" }).className).toContain("ml-auto");
  });
});