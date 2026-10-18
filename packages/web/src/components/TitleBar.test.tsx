import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import { render } from "@testing-library/react";
import { TitleBar } from "./TitleBar.js";

describe("TitleBar", () => {
  beforeEach(() => {
    vi.restoreAllMocks();
  });

  afterEach(() => {
    // 清掉注入的 heming，避免污染其他用例
    delete (window as unknown as { heming?: unknown }).heming;
  });

  it("浏览器环境（无 window.heming）渲染 null", () => {
    const { container } = render(<TitleBar />);
    expect(container.firstChild).toBeNull();
  });

  it("桌面端（有 window.heming）渲染拖拽带", () => {
    (window as unknown as { heming: unknown }).heming = { platform: "win32" };
    const { container } = render(<TitleBar />);
    const bar = container.querySelector(".desktop-titlebar");
    expect(bar).not.toBeNull();
  });

  it("拖拽带走 CSS 类承载 env 定位与拖拽属性", () => {
    (window as unknown as { heming: unknown }).heming = { platform: "win32" };
    const { container } = render(<TitleBar />);
    const bar = container.querySelector(".desktop-titlebar") as HTMLElement;
    expect(bar.classList.contains("desktop-titlebar")).toBe(true);
  });
});
