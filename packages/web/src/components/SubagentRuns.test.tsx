import { fireEvent, render, screen } from "@testing-library/react";
import "@testing-library/jest-dom/vitest";
import { beforeEach, describe, expect, it, vi } from "vitest";
import type { SubagentRun } from "../lib/agentRuntime/subagentRuns.js";
import {
  enqueueSubagentJob,
  resetSubagentJobs,
} from "../lib/agentRuntime/subagentJobs.js";
import { SubagentRuns } from "./SubagentRuns.js";

/** 造一条运行记录：默认在跑、第 0 轮。 */
function run(extra: Partial<SubagentRun> = {}): SubagentRun {
  return {
    id: "sub-1",
    task: "查 docs 里的安装说明",
    role: null,
    status: "running",
    round: 0,
    tool: null,
    note: null,
    startedAt: 1_000,
    endedAt: null,
    ...extra,
  };
}

describe("SubagentRuns（d.200）", () => {
  beforeEach(() => {
    resetSubagentJobs();
  });

  it("后台排队的也报数（d.349）：派了 6 个时不会只显示 5 个", () => {
    for (let index = 0; index < 6; index++) {
      enqueueSubagentJob({
        conversationId: "c1",
        agentId: "a1",
        agentName: "和小鸣",
        label: "通用子代理",
        task: `查第 ${index + 1} 件`,
        taskId: `bg-${index}`,
        run: () => new Promise(() => {}),
      });
    }
    render(<SubagentRuns runs={[]} onStop={vi.fn()} />);
    expect(screen.getByText(/0 个在跑 · 1 个排队/)).toBeInTheDocument();
  });

  it("两个在跑时列出两行事实：轮次 + 正在调的工具", () => {
    render(
      <SubagentRuns
        runs={[
          run({ id: "sub-1", round: 2, tool: "file_grep" }),
          run({ id: "sub-2", task: "查日志里的报错", round: 1 }),
        ]}
        onStop={vi.fn()}
      />,
    );
    expect(screen.getByText(/只读子代理 · 2 个在跑/)).toBeInTheDocument();
    expect(screen.getByText(/第 2 轮 · 正在 file_grep/)).toBeInTheDocument();
    expect(screen.getByText(/第 1 轮 · 思考中/)).toBeInTheDocument();
  });

  it("点「停止」把回调交回去（只中断子代理，不要再自己猜）", () => {
    const onStop = vi.fn();
    render(<SubagentRuns runs={[run()]} onStop={onStop} />);
    fireEvent.click(screen.getByRole("button", { name: "停止" }));
    expect(onStop).toHaveBeenCalledTimes(1);
  });

  it("没有在跑的就不渲染（收口之后不能留一条常驻状态条）", () => {
    const { container } = render(
      <SubagentRuns
        runs={[
          run({ status: "done", round: 2, endedAt: 2_000 }),
          run({ id: "sub-2", status: "failed", note: "已中断" }),
        ]}
        onStop={vi.fn()}
      />,
    );
    expect(container).toBeEmptyDOMElement();
  });

  it("刚派出的那条说「刚派出」，不编一个不存在的轮次", () => {
    render(<SubagentRuns runs={[run({ round: 0 })]} onStop={vi.fn()} />);
    expect(screen.getByText(/刚派出/)).toBeInTheDocument();
  });

  it("任务书太长时压成一行，不把轮次信息挤出去", () => {
    const long = "很长的任务描述".repeat(20);
    render(<SubagentRuns runs={[run({ task: long })]} onStop={vi.fn()} />);
    const item = screen.getByTitle(long);
    expect(item.textContent).toContain("…");
    expect(item.textContent?.length ?? 0).toBeLessThan(long.length);
  });

  it("团队任务显示成员角色，而不只是「第 2 个」（d.347）", () => {
    render(
      <SubagentRuns
        runs={[run({ id: "team-1-sec", role: "安全审查", task: "按威胁模型逐条对" })]}
        onStop={vi.fn()}
      />,
    );
    const item = screen.getByTitle("按威胁模型逐条对");
    expect(item.textContent).toContain("「安全审查」");
    expect(item.textContent).toContain("按威胁模型逐条对");
  });

  it("授权写盘时标题如实写「可写」，不继续冒充只读（d.202）", () => {
    render(<SubagentRuns runs={[run()]} writable onStop={vi.fn()} />);
    expect(screen.getByText(/子代理（可写） · 1 个在跑/)).toBeInTheDocument();
    expect(screen.queryByText(/只读子代理/)).toBeNull();
  });
});
