import { describe, it, expect, vi } from "vitest";
import { render, screen } from "@testing-library/react";
import { fireEvent } from "@testing-library/react";
import "@testing-library/jest-dom/vitest";
import { JobReadyBar } from "./JobReadyBar.js";
import type { WatchedJob } from "../lib/shell/jobWatch.js";

const finished: WatchedJob = { jobId: "job-1", running: false, exitCode: 0, stdout: "", stderr: "" };
const pending: WatchedJob = { jobId: "job-2", running: true, exitCode: null, stdout: "", stderr: "" };

describe("后台作业完成条（d.182）", () => {
  it("全部结束：说清是哪几个作业、给「继续」", async () => {
    const onContinue = vi.fn();
    render(<JobReadyBar jobs={[finished]} onContinue={onContinue} />);

    expect(screen.getByRole("status")).toBeInTheDocument();
    expect(screen.getByText(/后台作业已结束（1\/1）/)).toBeInTheDocument();
    expect(screen.getByText(/job-1：已结束（退出码 0）/)).toBeInTheDocument();

    fireEvent.click(screen.getByRole("button", { name: "继续" }));
    expect(onContinue).toHaveBeenCalledTimes(1);
  });

  it("还有在跑的：文案不能写成「已结束」，按钮改成「查看进展」", () => {
    render(<JobReadyBar jobs={[finished, pending]} pending onContinue={() => {}} />);

    expect(screen.getByText(/后台作业还没结束（1\/2 已结束）/)).toBeInTheDocument();
    expect(screen.getByRole("button", { name: "查看进展" })).toBeInTheDocument();
    expect(screen.queryByRole("button", { name: "继续" })).toBeNull();
  });

  it("退出码拿不到时写「未知」，不冒充成功", () => {
    render(<JobReadyBar jobs={[{ ...finished, exitCode: null }]} onContinue={() => {}} />);
    expect(screen.getByText(/已结束（退出码未知）/)).toBeInTheDocument();
  });

  it("有 onDismiss 才显示「收起」；没有就不留死按钮", async () => {
    const onDismiss = vi.fn();
    const { rerender } = render(<JobReadyBar jobs={[finished]} onContinue={() => {}} onDismiss={onDismiss} />);
    fireEvent.click(screen.getByRole("button", { name: "收起" }));
    expect(onDismiss).toHaveBeenCalledTimes(1);

    rerender(<JobReadyBar jobs={[finished]} onContinue={() => {}} />);
    expect(screen.queryByRole("button", { name: "收起" })).toBeNull();
  });

  it("空数组不渲染（没有作业就别占输入区高度）", () => {
    const { container } = render(<JobReadyBar jobs={[]} onContinue={() => {}} />);
    expect(container).toBeEmptyDOMElement();
  });

  it("是 status 而不是 alert：不抢焦点、不打断读屏", () => {
    render(<JobReadyBar jobs={[finished]} onContinue={() => {}} />);
    expect(screen.getByRole("status")).toHaveAttribute("aria-live", "polite");
    expect(screen.queryByRole("alert")).toBeNull();
  });
});
