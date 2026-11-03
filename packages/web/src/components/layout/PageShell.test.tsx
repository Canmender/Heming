import { describe, it, expect } from "vitest";
import { render, screen } from "@testing-library/react";
import { PageShell } from "./PageShell.js";

describe("PageShell 布局与排版基元", () => {
  it("渲染页头标题/副标题/操作区，标题使用统一档位类", () => {
    render(
      <PageShell title="插件区" subtitle="只声明能力、不执行代码" actions={<button>安装</button>}>
        <div>内容</div>
      </PageShell>,
    );
    const title = screen.getByRole("heading", { level: 1 });
    expect(title).toHaveTextContent("插件区");
    expect(title.className).toContain("ui-page-title");
    expect(screen.getByText("只声明能力、不执行代码").className).toContain("ui-page-sub");
    expect(screen.getByRole("button", { name: "安装" })).toBeInTheDocument();
    expect(screen.getByText("内容")).toBeInTheDocument();
  });

  it("支持标题节点（带徽标/时间）与 headerExtra 行", () => {
    render(
      <PageShell title={<>你好，爱丽丝<span data-testid="badge">今天</span></>} headerExtra={<nav>页签</nav>}>
        <div>内容</div>
      </PageShell>,
    );
    expect(screen.getByTestId("badge")).toBeInTheDocument();
    expect(screen.getByText("页签")).toBeInTheDocument();
  });

  it("width 档位映射为内容宽度上限", () => {
    const { rerender, container } = render(
      <PageShell title="可读" width="readable">
        <div>内容</div>
      </PageShell>,
    );
    expect(container.querySelector(".mx-auto.w-full")?.className).toContain("max-w-[960px]");
    rerender(
      <PageShell title="窄" width="narrow">
        <div>内容</div>
      </PageShell>,
    );
    expect(container.querySelector(".mx-auto.w-full")?.className).toContain("max-w-[720px]");
    rerender(
      <PageShell title="通栏">
        <div>内容</div>
      </PageShell>,
    );
    const body = container.querySelector(".mx-auto.w-full");
    expect(body?.className).not.toContain("max-w-[");
  });

  it("scroll=false 时不生成滚动容器（双栏/三栏页面自管滚动）", () => {
    const { container } = render(
      <PageShell title="团队" scroll={false} bodyClassName="custom-body">
        <div>内容</div>
      </PageShell>,
    );
    expect(container.querySelector(".overflow-y-auto")).toBeNull();
    expect(container.querySelector(".custom-body")).toBeInTheDocument();
  });
});
