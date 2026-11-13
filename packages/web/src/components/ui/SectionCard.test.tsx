import { afterEach, describe, expect, it } from "vitest";
import { cleanup, render, screen } from "@testing-library/react";
import { SectionCard } from "./SectionCard.js";

afterEach(() => cleanup());

describe("SectionCard 分区卡片", () => {
  it("走 .ui-card，标题/说明/动作/内容分区排版", () => {
    const { container } = render(
      <SectionCard
        icon={<svg data-testid="sec-icon" />}
        title="模型来源"
        description="从本地或远程加载模型。"
        action={<button type="button">刷新</button>}
      >
        <p>内容区</p>
      </SectionCard>,
    );
    const root = container.firstElementChild as HTMLElement;
    expect(root.tagName).toBe("SECTION");
    expect(root.className).toContain("ui-card");
    expect(root.className).toContain("p-4");
    expect(screen.getByText("模型来源")).toBeInTheDocument();
    expect(screen.getByText("从本地或远程加载模型。").className).toContain("ui-caption");
    expect(screen.getByRole("button", { name: "刷新" })).toBeInTheDocument();
    expect(screen.getByText("内容区").parentElement?.className).toContain("mt-3");
    expect(screen.getByTestId("sec-icon").parentElement).toHaveClass("text-muted");
  });

  it("可省略图标/说明/动作；className 追加在卡片上", () => {
    const { container } = render(
      <SectionCard title="运行状态" className="col-span-2">
        <span>ok</span>
      </SectionCard>,
    );
    const root = container.firstElementChild as HTMLElement;
    expect(root.className).toContain("ui-card");
    expect(root.className).toContain("col-span-2");
    expect(screen.queryByRole("button")).toBeNull();
  });

  it("标题支持 React 节点（调用方自备标题层级），不强行塞 hN", () => {
    const { container } = render(
      <SectionCard title={<h2>知识库</h2>}>
        <span />
      </SectionCard>,
    );
    expect(screen.getByRole("heading", { level: 2, name: "知识库" })).toBeInTheDocument();
    expect(container.querySelector("section h1, section h3")).toBeNull();
  });
});