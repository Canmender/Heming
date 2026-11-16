import { fireEvent, render, screen } from "@testing-library/react";
import "@testing-library/jest-dom/vitest";
import { describe, expect, it, vi } from "vitest";
import type { PanelJob } from "../lib/shell/jobPanel.js";
import { JobPanel } from "./JobPanel.js";

/** 造一条面板作业：默认在跑、刚起来。 */
function job(extra: Partial<PanelJob> = {}): PanelJob {
  return {
    id: "job-1",
    command: "pnpm -w test",
    cwd: "D:/repo",
    running: true,
    exitCode: null,
    startedAt: 1_000,
    finishedAt: null,
    bytes: 0,
    dropped: 0,
    ...extra,
  };
}

describe("JobPanel（d.203）", () => {
  it("没有作业时不渲染（它是一条状态条，不是常驻导航）", () => {
    const { container } = render(
      <JobPanel jobs={[]} canPreview onPreview={vi.fn()} onStop={vi.fn()} />,
    );
    expect(container).toBeEmptyDOMElement();
  });

  it("在跑的作业给状态、耗时、命令，只有它才有「停止」", () => {
    render(
      <JobPanel
        jobs={[
          job({ id: "job-1", startedAt: 1_000 }),
          job({ id: "job-2", running: false, exitCode: 0, startedAt: 1_000, finishedAt: 6_000 }),
        ]}
        now={31_000}
        canPreview
        onPreview={vi.fn()}
        onStop={vi.fn()}
      />,
    );
    expect(screen.getByText(/后台作业 · 2 条（1 条在跑）/)).toBeInTheDocument();
    expect(screen.getByText(/在跑 · 30s/)).toBeInTheDocument();
    expect(screen.getByText(/已完成 · 5s/)).toBeInTheDocument();
    expect(screen.getAllByRole("button", { name: "停止" })).toHaveLength(1);
  });

  it("点「停止」把 jobId 交回去（只停那一条）", () => {
    const onStop = vi.fn();
    render(<JobPanel jobs={[job({ id: "job-7" })]} now={1_000} canPreview={false} onPreview={vi.fn()} onStop={onStop} />);
    fireEvent.click(screen.getByRole("button", { name: "停止" }));
    expect(onStop).toHaveBeenCalledWith("job-7");
  });

  it("退出码非 0 显示「失败」并带退出码，没有退出码就如实说", () => {
    render(
      <JobPanel
        jobs={[
          job({ id: "job-1", running: false, exitCode: 2, finishedAt: 3_000 }),
          job({ id: "job-2", running: false, exitCode: null, finishedAt: 4_000 }),
        ]}
        now={10_000}
        canPreview={false}
        onPreview={vi.fn()}
        onStop={vi.fn()}
      />,
    );
    expect(screen.getByText(/失败（退出码 2）/)).toBeInTheDocument();
    expect(screen.getByText(/已结束（无退出码）/)).toBeInTheDocument();
  });

  it("支持预览时才出现「日志」按钮；点了把 jobId 交回去", () => {
    const onPreview = vi.fn();
    const { rerender } = render(
      <JobPanel jobs={[job()]} now={1_000} canPreview={false} onPreview={onPreview} onStop={vi.fn()} />,
    );
    expect(screen.queryByRole("button", { name: "日志" })).toBeNull();
    rerender(<JobPanel jobs={[job()]} now={1_000} canPreview onPreview={onPreview} onStop={vi.fn()} />);
    fireEvent.click(screen.getByRole("button", { name: "日志" }));
    expect(onPreview).toHaveBeenCalledWith("job-1");
  });

  it("丢过输出时必须写「日志不全」，预览被截时写「只显示最后一段」", () => {
    render(
      <JobPanel
        jobs={[job({ dropped: 2048, preview: "最后几行", previewCut: true })]}
        now={1_000}
        canPreview
        onPreview={vi.fn()}
        onStop={vi.fn()}
      />,
    );
    expect(screen.getByText(/日志不全（丢 2\.0KB）/)).toBeInTheDocument();
    expect(screen.getByTestId("job-output-job-1")).toHaveTextContent("最后几行");
    expect(screen.getByText(/只显示最后一段/)).toBeInTheDocument();
  });

  it("操作失败时把提示写出来，不静默", () => {
    render(
      <JobPanel
        jobs={[job()]}
        now={1_000}
        canPreview
        onPreview={vi.fn()}
        onStop={vi.fn()}
        notice="当前桌面端版本不支持停止后台作业（升级后可用）。"
      />,
    );
    expect(screen.getByText(/不支持停止后台作业/)).toBeInTheDocument();
  });
});
