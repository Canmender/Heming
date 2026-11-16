import { fireEvent, render, screen } from "@testing-library/react";
import "@testing-library/jest-dom/vitest";
import { describe, expect, it, vi } from "vitest";
import { ResumeBar } from "./ResumeBar.js";

describe("「接着做」提示条（d.189）", () => {
  it("用户停止的文案：说清是「你停下了」，不是「出错了」", () => {
    render(<ResumeBar reason="aborted" onContinue={() => {}} />);
    const bar = screen.getByRole("status", { name: "继续上次的任务" });
    expect(bar).toHaveTextContent("这一轮被你停下了");
    expect(bar.textContent).not.toMatch(/出错|失败/);
  });

  it("应用重启的文案：说清是「上次没跑完」，并提示原因可能是关窗/重启", () => {
    render(<ResumeBar reason="interrupted" onContinue={() => {}} />);
    const bar = screen.getByRole("status", { name: "继续上次的任务" });
    expect(bar).toHaveTextContent("上次这一轮没有跑完");
    expect(bar).toHaveTextContent("窗口关闭或应用重启");
  });

  it("点「继续」只回调一次（续跑要花真实 token，不能重复触发）", () => {
    const onContinue = vi.fn();
    render(<ResumeBar reason="aborted" onContinue={onContinue} />);
    fireEvent.click(screen.getByRole("button", { name: "继续" }));
    expect(onContinue).toHaveBeenCalledTimes(1);
  });

  it("有收起就给按钮，没有就不给（不留一个点了没反应的按钮）", () => {
    const { rerender } = render(<ResumeBar reason="aborted" onContinue={() => {}} />);
    expect(screen.queryByRole("button", { name: "收起" })).toBeNull();
    rerender(<ResumeBar reason="aborted" onContinue={() => {}} onDismiss={() => {}} />);
    expect(screen.getByRole("button", { name: "收起" })).toBeInTheDocument();
  });

  it("是 status 不是 alert（不是错误，别打断读屏）", () => {
    render(<ResumeBar reason="interrupted" onContinue={() => {}} />);
    expect(screen.queryByRole("alert")).toBeNull();
    expect(screen.getByRole("status", { name: "继续上次的任务" })).toHaveAttribute(
      "aria-live",
      "polite",
    );
  });
});
