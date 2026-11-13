import { afterEach, describe, expect, it, vi } from "vitest";
import { cleanup, render, screen } from "@testing-library/react";
import { createRef } from "react";
import { Button } from "./Button.js";

afterEach(() => cleanup());

describe("Button 基元", () => {
  it("默认 primary + md，样式仍走 .ui-btn-*", () => {
    render(<Button>保存</Button>);
    const btn = screen.getByRole("button", { name: "保存" });
    expect(btn.className).toContain("ui-btn");
    expect(btn.className).toContain("ui-btn-md");
    expect(btn.className).toContain("ui-btn-primary");
    expect(btn).toHaveAttribute("type", "button");
  });

  it("variant/size 由 props 决定，className 只追加布局类", () => {
    render(
      <Button variant="ghost" size="sm" className="mt-auto">
        取消
      </Button>,
    );
    const btn = screen.getByRole("button", { name: "取消" });
    expect(btn.className).toContain("ui-btn-sm");
    expect(btn.className).toContain("ui-btn-ghost");
    expect(btn.className).toContain("mt-auto");
    // 不允许调用方用 className 再塞一套尺寸/颜色
    expect(btn.className).not.toContain("ui-btn-md");
  });

  it("busy：同时禁用并置 aria-busy，避免重复点击", () => {
    render(<Button busy>保存中…</Button>);
    const btn = screen.getByRole("button", { name: "保存中…" });
    expect(btn).toBeDisabled();
    expect(btn).toHaveAttribute("aria-busy", "true");
  });

  it("leadingIcon 是装饰：容器 aria-hidden，图标名不进按钮名", () => {
    render(<Button leadingIcon={<svg data-testid="ico" />}>新建</Button>);
    expect(screen.getByRole("button", { name: "新建" })).toBeInTheDocument();
    expect(screen.getByTestId("ico").parentElement).toHaveAttribute("aria-hidden", "true");
  });

  it("ref 落到真实 button 上", () => {
    const ref = createRef<HTMLButtonElement>();
    render(<Button ref={ref}>确定</Button>);
    expect(ref.current).toBeInstanceOf(HTMLButtonElement);
  });

  it("点击行为透传，disabled 时不再触发", () => {
    const onClick = vi.fn();
    const { rerender } = render(<Button onClick={onClick}>去</Button>);
    screen.getByRole("button", { name: "去" }).click();
    expect(onClick).toHaveBeenCalledTimes(1);
    rerender(
      <Button onClick={onClick} disabled>
        去
      </Button>,
    );
    screen.getByRole("button", { name: "去" }).click();
    expect(onClick).toHaveBeenCalledTimes(1);
  });

  it("焦点可见：所有按钮都带统一焦点环，且 reduced-motion 下不跑过渡", () => {
    render(<Button variant="ghost">刷新</Button>);
    const btn = screen.getByRole("button", { name: "刷新" });
    expect(btn.className).toContain("focus-visible:outline-2");
    expect(btn.className).toContain("focus-visible:outline-offset-2");
    expect(btn.className).toContain("motion-reduce:transition-none");
  });

  it("调用方 className 已带焦点环时不重复追加（withFocusRing 去重）", () => {
    render(<Button className="focus-visible:outline focus-visible:outline-info">保存</Button>);
    const btn = screen.getByRole("button", { name: "保存" });
    expect(btn.className.match(/focus-visible:outline-2/g) ?? []).toHaveLength(0);
    expect(btn.className).toContain("focus-visible:outline-info");
  });
});
