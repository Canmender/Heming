/**
 * 路由懒加载占位（PageFallback → 页面骨架）的契约。
 *
 * d39 的 `settleRoutedPage()` 依赖 `data-testid="page-fallback"` 判断「目标页 chunk 尚未挂上」，
 * 所以这个锚点必须始终存在；同时体验优化轮要求它看起来像页面骨架而不是一行居中灰字。
 * 这里只做结构与静态性断言（纯静态、无定时器：不 fake timers 也不推进时间）。
 */
import { describe, it, expect, afterEach } from "vitest";
import { render, screen, cleanup } from "@testing-library/react";
import { PageFallback } from "./App.js";

vi.mock("./lib/appPresence.js", () => ({ useAppPresence: () => undefined }));

describe("PageFallback（页面骨架）", () => {
  afterEach(() => cleanup());

  it("保留 d39 锚点，并对读屏播报加载状态", () => {
    render(<PageFallback />);
    const root = screen.getByTestId("page-fallback");
    expect(root).toBeTruthy();
    expect(root.getAttribute("role")).toBe("status");
    expect(root.getAttribute("aria-busy")).toBe("true");
    expect(screen.getByText("正在加载页面")).toBeTruthy();
  });

  it("呈页面骨架结构：左列 + 内容区 + 顶部标题条，而不是一行文字", () => {
    const { container } = render(<PageFallback />);
    const root = screen.getByTestId("page-fallback");
    // 结构：两个直接子块（左列 + 内容区）
    expect(root.children.length).toBeGreaterThanOrEqual(2);
    // 顶部标题条：内容区里第一个块有下边框（border-b）且是 flex 行
    const content = root.lastElementChild as HTMLElement;
    const header = content.firstElementChild as HTMLElement;
    expect(header.className).toContain("border-b");
    expect(header.className).toContain("flex");
    // 骨架块数量足够撑出「页面」观感（不是纯文本）
    expect(container.querySelectorAll("div").length).toBeGreaterThan(8);
  });

  it("不遮挡交互（pointer-events-none）且没有内联定时器/动画", () => {
    render(<PageFallback />);
    const root = screen.getByTestId("page-fallback");
    expect(root.className).toContain("pointer-events-none");
    expect(root.getAttribute("style")).toBeNull();
  });
});
