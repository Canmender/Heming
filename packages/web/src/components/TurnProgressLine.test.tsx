import { render, screen } from "@testing-library/react";
import { describe, expect, it } from "vitest";

import { TurnProgressLine } from "./TurnProgressLine.js";
import type { TurnProgress } from "../lib/agentRuntime/turnProgress.js";

const AT = 1_700_000_000_000;

/** 拼一条完整进度（d.218 起多了 startedAt / tools / done / endedAt）。 */
function progress(overrides: Partial<TurnProgress> = {}): TurnProgress {
  return {
    round: 1,
    phase: "round",
    tool: null,
    at: AT,
    startedAt: AT,
    tools: 0,
    done: false,
    endedAt: null,
    ...overrides,
  };
}

describe("主对话进度行（d.214）", () => {
  it("没有进度就什么都不渲染（不留空白条）", () => {
    const { container } = render(<TurnProgressLine progress={null} />);
    expect(screen.queryByTestId("turn-progress")).toBeNull();
    expect(container.textContent).toBe("");
  });

  it("执行工具时说清第几步、在调哪个工具、已经跑了多久", () => {
    render(
      <TurnProgressLine
        progress={progress({ round: 3, phase: "tool", tool: "file_grep", tools: 2 })}
        now={AT + 42_000}
      />,
    );
    const line = screen.getByTestId("turn-progress");
    expect(line.textContent).toContain("第 3 步 · 正在执行 file_grep");
    expect(line.textContent).toContain("已跑 42 秒");
    expect(line.getAttribute("role")).toBe("status");
    expect(line.getAttribute("data-done")).toBe("false");
  });

  it("模型在想下一步时不假装在调工具", () => {
    render(<TurnProgressLine progress={progress({ round: 1 })} now={AT + 3_000} />);
    expect(screen.getByTestId("turn-progress").textContent).toContain("第 1 步 · 正在想下一步");
  });

  it("跑过一分钟就把秒换成「x 分」", () => {
    render(<TurnProgressLine progress={progress({ round: 2 })} now={AT + 95_000} />);
    expect(screen.getByTestId("turn-progress").textContent).toContain("已跑 1 分 35 秒");
  });
});

describe("收口小结（d.218）", () => {
  it("收口后不再显示「已跑」，改成一行「上一轮」小结", () => {
    render(
      <TurnProgressLine
        progress={progress({
          round: 3,
          tools: 5,
          startedAt: AT,
          at: AT + 72_000,
          done: true,
          endedAt: AT + 72_000,
        })}
        now={AT + 999_000}
      />,
    );
    const line = screen.getByTestId("turn-progress");
    expect(line.textContent).toContain("上一轮：5 步 · 用时 1 分 12 秒");
    // 收口后时钟不再走：用别的时间渲染也不该冒出「已跑」
    expect(line.textContent).not.toContain("已跑");
    expect(line.getAttribute("data-done")).toBe("true");
  });

  it("收口后左侧不再有呼吸点（否则看着像还在跑）", () => {
    const { container } = render(
      <TurnProgressLine progress={progress({ done: true, endedAt: AT + 5_000 })} now={AT + 60_000} />,
    );
    const dot = container.querySelector('[aria-hidden="true"]');
    expect(dot?.className).not.toContain("animate-pulse");
  });
});
