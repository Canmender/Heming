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
      <PageShell title="默认档">
        <div>内容</div>
      </PageShell>,
    );
    // 默认档从 full 改成 wide（d.138）：不传 width 的页面也有了统一行宽上限。
    const body = container.querySelector(".mx-auto.w-full");
    expect(body?.className).toContain("max-w-[1200px]");
    rerender(
      <PageShell title="通栏" width="full">
        <div>内容</div>
      </PageShell>,
    );
    expect(container.querySelector(".mx-auto.w-full")?.className).not.toContain("max-w-[");
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

  it("tabs 槽在页头正下方、通栏同内边距，且不随内容滚动（三页一级页签的统一位置）", () => {
    const { container } = render(
      <PageShell
        title="插件"
        tabs={
          <div role="tablist" aria-label="能力分区">
            <button type="button" role="tab" aria-selected="true">
              插件
            </button>
          </div>
        }
        headerExtra={<nav>筛选条</nav>}
      >
        <div>内容</div>
      </PageShell>,
    );
    const list = screen.getByRole("tablist", { name: "能力分区" });
    const row = list.parentElement as HTMLElement;
    // 与页头同一左右内边距（24 / 窄窗 16），页签的 -mb-px 下划线压住本行 border-b
    expect(row.className).toContain("border-b");
    expect(row.className).toContain("border-line-soft");
    expect(row.className).toContain("px-6");
    expect(row.className).toContain("max-[1199px]:px-4");

    // 顺序：页头 → 页签行 → headerExtra → 滚动内容
    const header = container.querySelector("header") as HTMLElement;
    expect(header.compareDocumentPosition(row) & Node.DOCUMENT_POSITION_FOLLOWING).toBeTruthy();
    const extra = screen.getByText("筛选条").parentElement as HTMLElement;
    expect(row.compareDocumentPosition(extra) & Node.DOCUMENT_POSITION_FOLLOWING).toBeTruthy();

    // 页签行固定：不在滚动容器里（滚动时页签不会跟着走）
    const scroller = container.querySelector(".overflow-y-auto") as HTMLElement;
    expect(scroller.contains(list)).toBe(false);
    expect(scroller.contains(screen.getByText("筛选条"))).toBe(false);
  });

  it("scroll=false 时也套宽度档位（此前传 width 被静默忽略）", () => {
    const { container } = render(
      <PageShell title="设置" width="readable" scroll={false}>
        <div>内容</div>
      </PageShell>,
    );
    const body = container.querySelector(".mx-auto.w-full");
    expect(body?.className).toContain("max-w-[960px]");
  });
});
