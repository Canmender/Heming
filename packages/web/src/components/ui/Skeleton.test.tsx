import { afterEach, describe, expect, it } from "vitest";
import { cleanup, render } from "@testing-library/react";
import { SkeletonBlock, SkeletonCard, SkeletonLine } from "./Skeleton.js";

afterEach(() => cleanup());

describe("Skeleton 统一骨架", () => {
  it("SkeletonLine 使用 .ui-skeleton，可叠加尺寸类", () => {
    const { container } = render(<SkeletonLine className="h-7 rounded-lg" />);
    const el = container.firstElementChild as HTMLElement;
    expect(el.className).toContain("ui-skeleton");
    expect(el.className).toContain("h-7");
    expect(el.className).toContain("rounded-lg");
    expect(el).toHaveAttribute("aria-hidden", "true");
    // 没有内联 style：尺寸全部走 class，主题/动效由 CSS 统一
    expect(el.getAttribute("style")).toBeNull();
  });

  it("SkeletonBlock 默认 h-24 通栏；传 className 覆盖尺寸", () => {
    const { container, rerender } = render(<SkeletonBlock />);
    expect((container.firstElementChild as HTMLElement).className).toContain("h-24");
    rerender(<SkeletonBlock className="h-40 rounded-xl" />);
    const el = container.firstElementChild as HTMLElement;
    expect(el.className).toContain("ui-skeleton");
    expect(el.className).toContain("h-40");
    expect(el.className).not.toContain("h-24");
  });

  it("SkeletonCard 渲染卡片轮廓 + 可指定行数，最后一行更短", () => {
    const { container } = render(<SkeletonCard lines={3} />);
    const card = container.firstElementChild as HTMLElement;
    // d.138：卡片轮廓（圆角/描边/底色/阴影）走 .ui-card 基元，不再手写 rounded-xl
    expect(card.className).toContain("ui-card");
    expect(card).toHaveAttribute("aria-hidden", "true");
    // 1 行标题 + 3 行正文
    const lines = card.querySelectorAll(".ui-skeleton");
    expect(lines).toHaveLength(4);
    expect(lines[lines.length - 1].className).toContain("w-3/5");
  });

  it("SkeletonCard lines=0 只保留标题行（不产生空的 flex 子项噪音）", () => {
    const { container } = render(<SkeletonCard lines={0} />);
    expect(container.querySelectorAll(".ui-skeleton")).toHaveLength(1);
  });
});
