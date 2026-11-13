import { afterEach, describe, expect, it, vi } from "vitest";
import { cleanup, fireEvent, render, screen } from "@testing-library/react";
import { AsyncBoundary } from "./AsyncBoundary.js";

afterEach(() => cleanup());

/**
 * 三态边界：页面只描述「状态 + 说什么 + 能做什么」，容器语义由这里保证。
 * 重点断言读屏契约（status/alert）与既有基元的复用（骨架 aria-hidden、空态操作区）。
 */

describe("AsyncBoundary 三态分发", () => {
  it("ready：原样渲染内容，不产生 status/alert", () => {
    render(
      <AsyncBoundary status="ready">
        <p>真实内容</p>
      </AsyncBoundary>,
    );
    expect(screen.getByText("真实内容")).toBeInTheDocument();
    expect(screen.queryByRole("status")).toBeNull();
    expect(screen.queryByRole("alert")).toBeNull();
  });

  it("loading：role=status + aria-busy，默认读屏名「正在加载」，骨架块 aria-hidden", () => {
    const { container } = render(<AsyncBoundary status="loading" />);
    const status = screen.getByRole("status");
    expect(status).toHaveAttribute("aria-busy", "true");
    expect(status).toHaveAttribute("aria-label", "正在加载");
    // 默认占位是一张卡片骨架；骨架自身 aria-hidden，避免读屏重复播报
    expect(container.querySelector(".ui-card")).not.toBeNull();
    container.querySelectorAll(".ui-skeleton").forEach((el) => {
      expect(el).toHaveAttribute("aria-hidden", "true");
    });
  });

  it("loading：可换读屏名与占位节点", () => {
    render(
      <AsyncBoundary
        status="loading"
        loadingLabel="正在加载团队成员"
        loadingClassName="space-y-1.5"
        loadingFallback={<div data-testid="custom-skeleton" />}
      />,
    );
    expect(screen.getByRole("status")).toHaveAttribute("aria-label", "正在加载团队成员");
    expect(screen.getByRole("status").className).toContain("space-y-1.5");
    expect(screen.getByTestId("custom-skeleton")).toBeInTheDocument();
  });

  it("error：走 ErrorState（role=alert），标题/说明/错误码分层，重试只回调一次", () => {
    const onRetry = vi.fn();
    render(
      <AsyncBoundary
        status="error"
        errorTitle="名册加载失败：网络异常"
        errorDesc="请检查网络后重试。"
        errorCode="HTTP 503"
        onRetry={onRetry}
        errorCompact
      />,
    );
    const alert = screen.getByRole("alert");
    expect(alert).toHaveTextContent("名册加载失败：网络异常");
    expect(alert).toHaveTextContent("请检查网络后重试。");
    expect(alert).toHaveTextContent("HTTP 503");
    // compact 收紧留白（侧栏/卡片内）
    expect(alert.className).toContain("py-5");
    fireEvent.click(screen.getByRole("button", { name: "重试" }));
    expect(onRetry).toHaveBeenCalledTimes(1);
  });

  it("error：未传 errorTitle 时给中性兜底，不出现空标题", () => {
    render(<AsyncBoundary status="error" />);
    expect(screen.getByRole("alert")).toHaveTextContent("加载失败");
    expect(screen.queryByRole("button", { name: "重试" })).toBeNull();
  });

  it("empty：走 EmptyState，单个 emptyAction 渲染为操作区按钮", () => {
    const onNext = vi.fn();
    render(
      <AsyncBoundary
        status="empty"
        emptyTitle="还没有共享的日程"
        emptyDesc="连接信息中枢后会出现。"
        emptyAction={
          <button type="button" onClick={onNext}>
            去连接信息中枢
          </button>
        }
      />,
    );
    expect(screen.getByText("还没有共享的日程").className).toContain("ui-empty-title");
    expect(screen.getByText("连接信息中枢后会出现。")).toBeInTheDocument();
    fireEvent.click(screen.getByRole("button", { name: "去连接信息中枢" }));
    expect(onNext).toHaveBeenCalledTimes(1);
  });

  it("empty：emptyActions 优先于 emptyAction，framed 自带卡片描边", () => {
    render(
      <AsyncBoundary
        status="empty"
        emptyTitle="没有匹配的服务"
        emptyFramed
        emptyAction={<button type="button">单个</button>}
        emptyActions={
          <>
            <button type="button">清空筛选</button>
            <button type="button">重试</button>
          </>
        }
      />,
    );
    expect(screen.getByRole("button", { name: "清空筛选" })).toBeInTheDocument();
    expect(screen.getByRole("button", { name: "重试" })).toBeInTheDocument();
    expect(screen.queryByRole("button", { name: "单个" })).toBeNull();
    expect(screen.getByText("没有匹配的服务")).toBeInTheDocument();
    // EmptyState 根节点带 ui-card
    const root = screen.getByText("没有匹配的服务").parentElement as HTMLElement;
    expect(root.className).toContain("ui-card");
  });

  it("三态互斥：非 ready 时 children 不渲染", () => {
    render(
      <AsyncBoundary status="loading">
        <p>不该出现</p>
      </AsyncBoundary>,
    );
    expect(screen.queryByText("不该出现")).toBeNull();
  });
});