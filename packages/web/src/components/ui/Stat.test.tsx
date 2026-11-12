import { afterEach, describe, expect, it, vi } from "vitest";
import { cleanup, render, screen } from "@testing-library/react";
import { fireEvent } from "@testing-library/react";
import { Stat } from "./Stat.js";

afterEach(() => cleanup());

describe("Stat（统计卡基元）", () => {
  it("不可下钻时渲染成静态卡：label / 数值 / 说明", () => {
    render(<Stat label="可用模型" value={3} hint="智能体可选的模型" />);
    expect(screen.getByText("可用模型")).toBeTruthy();
    expect(screen.getByText("3")).toBeTruthy();
    expect(screen.getByText("智能体可选的模型")).toBeTruthy();
    expect(screen.queryByRole("button")).toBeNull();
  });

  it("传 onOpen 时整张卡是按钮，可访问名默认「标题：数值」", () => {
    render(<Stat label="待处理" value={2} onOpen={() => {}} />);
    const card = screen.getByRole("button", { name: "待处理：2" });
    expect(card).toBeTruthy();
  });

  it("actionLabel 覆盖默认可访问名", () => {
    render(<Stat label="运行中任务" value={1} onOpen={() => {}} actionLabel="查看运行中的任务" />);
    expect(screen.getByRole("button", { name: "查看运行中的任务" })).toBeTruthy();
  });

  it("点击按钮只回调一次；键盘焦点环与悬停底在按钮上", () => {
    const onOpen = vi.fn();
    render(<Stat label="我的智能体" value={4} onOpen={onOpen} />);
    const card = screen.getByRole("button");
    expect(card.className).toContain("focus-visible:outline-2");
    expect(card.className).toContain("hover:bg-[var(--subtle)]");
    fireEvent.click(card);
    expect(onOpen).toHaveBeenCalledTimes(1);
  });
});
