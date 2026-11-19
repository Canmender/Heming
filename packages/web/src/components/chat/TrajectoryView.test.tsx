import { afterEach, describe, expect, it } from "vitest";
import { cleanup, fireEvent, render, screen } from "@testing-library/react";
import { TrajectoryView } from "./TrajectoryView.js";
import type { ConversationProgress, ProgressStep } from "../../lib/progress/model.js";

/**
 * 「轨迹」页签（T32）：纯展示，进度对象由调用方用 `buildConversationProgress` 算好。
 *
 * 契约：
 * - `section[aria-label="本轮轨迹"][data-view-panel="trail"]` + h3「本轮轨迹」；
 * - `hasData=false` → EmptyState（h2「这一轮还没有轨迹」+ 说明）；
 * - 有数据但没有步骤 → 「这一轮没有可列出的步骤。」；
 * - 有步骤 → ol/li，每步含 label、状态词（STEP_TONES）、耗时、detail。
 */

function progress(over: Partial<ConversationProgress> = {}): ConversationProgress {
  return {
    phase: "done",
    headline: "这一轮已完成",
    steps: [],
    tools: [],
    thinking: "",
    counts: { total: 0, ok: 0, error: 0, denied: 0, running: 0 },
    pendingConfirms: 0,
    progress: { done: 0, total: 0 },
    hasData: false,
    ...over,
  };
}

function step(over: Partial<ProgressStep>): ProgressStep {
  return {
    id: "s1",
    kind: "tool",
    label: "调用 read_file",
    status: "ok",
    ...over,
  };
}

afterEach(() => cleanup());

describe("TrajectoryView · 本轮轨迹", () => {
  it("空态：还没有轨迹时出 h2 空态标题与说明（titleAs=h2）", () => {
    const { container } = render(<TrajectoryView progress={progress()} />);
    const section = container.querySelector('section[data-view-panel="trail"]')!;
    expect(section).toHaveAttribute("aria-label", "本轮轨迹");
    expect(screen.getByRole("heading", { level: 3, name: "本轮轨迹" })).toBeInTheDocument();
    expect(screen.getByRole("heading", { level: 2, name: "这一轮还没有轨迹" })).toBeInTheDocument();
    expect(screen.getByText("发送一条消息后，工具调用与步骤会按时间记在这里。")).toBeInTheDocument();
    expect(container.querySelector("ol")).toBeNull();
  });

  it("有数据但没有步骤：说明「没有可列出的步骤」，不编造步骤行", () => {
    const { container } = render(<TrajectoryView progress={progress({ hasData: true })} />);
    expect(screen.getByText("这一轮没有可列出的步骤。")).toBeInTheDocument();
    expect(container.querySelector("ol")).toBeNull();
    expect(screen.queryByRole("heading", { level: 2, name: "这一轮还没有轨迹" })).toBeNull();
  });

  it("步骤按顺序铺成 li：标签 + 状态词 + 耗时 + 详情", () => {
    const { container } = render(
      <TrajectoryView
        progress={progress({
          hasData: true,
          steps: [
            step({ id: "t1", label: "调用 read_file", status: "ok", endedAt: undefined, startedAt: undefined }),
            step({
              id: "t2",
              kind: "tool",
              label: "调用 run_shell",
              status: "error",
              detail: "命令不存在",
            }),
          ],
        })}
      />,
    );

    const items = container.querySelectorAll("ol > li");
    expect(items).toHaveLength(2);
    expect(items[0]!.textContent).toContain("调用 read_file");
    expect(items[0]!.textContent).toContain("完成"); // STEP_TONES.ok.label
    expect(items[1]!.textContent).toContain("调用 run_shell");
    expect(items[1]!.textContent).toContain("失败"); // STEP_TONES.error.label
    expect(items[1]!.textContent).toContain("命令不存在");
  });

  it("状态词覆盖进行中 / 已拒绝 / 等待确认（颜色之外有文字兜底）", () => {
    const { container } = render(
      <TrajectoryView
        progress={progress({
          hasData: true,
          steps: [
            step({ id: "a", label: "思考", kind: "think", status: "running" }),
            step({ id: "b", label: "调用 delete_file", status: "denied" }),
            step({ id: "c", label: "等待你确认 1 项工具调用", kind: "confirm", status: "waiting" }),
          ],
        })}
      />,
    );
    const items = [...container.querySelectorAll("ol > li")].map((li) => li.textContent);
    expect(items[0]).toContain("进行中");
    expect(items[1]).toContain("已拒绝");
    expect(items[2]).toContain("等待确认");
  });
});

describe("TrajectoryView · 事实条与工具表（d.346）", () => {
  it("序号、类别标签、参数预览与汇总条：只报已有事实", () => {
    const { container } = render(
      <TrajectoryView
        progress={progress({
          hasData: true,
          steps: [
            step({ id: "s1", kind: "think", label: "想下一步", status: "ok" }),
            step({ id: "s2", label: "调用 read_file", status: "ok", detail: "读到了 20 行" }),
          ],
          tools: [
            {
              id: "s2",
              name: "read_file",
              args: "{ \"path\": \"src/a.ts\" }",
              status: "ok",
              startedAt: 1000,
              endedAt: 1500,
            },
          ],
          counts: { total: 1, ok: 1, error: 0, denied: 0, running: 0 },
        })}
      />,
    );
    const summary = screen.getByTestId("trajectory-summary");
    expect(summary).toHaveTextContent("2 个步骤");
    expect(summary).toHaveTextContent("1 次工具调用");
    const items = container.querySelectorAll("ol > li");
    expect(items[0]!.textContent).toContain("#1");
    expect(items[0]!.textContent).toContain("思考");
    expect(items[1]!.textContent).toContain("工具");
    expect(items[1]!.textContent).toContain("参数：{ \"path\": \"src/a.ts\" }");
    // 工具表只在有 ToolTrace 时出现，且耗时取首尾时间差。
    const table = screen.getByRole("table");
    expect(table).toHaveTextContent("read_file");
    expect(table).toHaveTextContent("500ms");
  });

  it("没有工具轨迹时不渲染工具表", () => {
    render(<TrajectoryView progress={progress({ hasData: true, steps: [step({ id: "s1" })] })} />);
    expect(screen.queryByRole("table")).toBeNull();
  });
});

describe("TrajectoryView · 工具栏（d.350，参考 DSH）", () => {
  const twoSteps = () =>
    progress({
      hasData: true,
      steps: [
        step({ id: "s1", kind: "think", label: "先看看仓库结构", status: "ok" }),
        step({ id: "s2", label: "调用 read_file", status: "ok", detail: "读到了 20 行" }),
      ],
      tools: [
        {
          id: "s2",
          name: "read_file",
          args: '{ "path": "src/a.ts" }',
          status: "ok",
          startedAt: 1000,
          endedAt: 1500,
        },
      ],
      counts: { total: 1, ok: 1, error: 0, denied: 0, running: 0 },
    });

  it("关键词只筛命中步骤，并给「命中 / 总数」；工具表在筛选时收起", () => {
    const { container } = render(<TrajectoryView progress={twoSteps()} />);
    const search = screen.getByRole("searchbox", { name: "搜索轨迹" });
    fireEvent.change(search, { target: { value: "a.ts" } });
    expect(container.querySelectorAll("ol > li")).toHaveLength(1);
    expect(screen.getByTestId("trajectory-filter-count")).toHaveTextContent("1 / 2 步");
    expect(screen.queryByRole("table")).toBeNull();
  });

  it("类别 chip 能只看工具；没有命中时给一句可操作的说明", () => {
    const { container } = render(<TrajectoryView progress={twoSteps()} />);
    fireEvent.click(screen.getByRole("button", { name: /^工具 1$/ }));
    expect(container.querySelectorAll("ol > li")).toHaveLength(1);
    fireEvent.change(screen.getByRole("searchbox", { name: "搜索轨迹" }), {
      target: { value: "根本没有这个词" },
    });
    expect(container.querySelectorAll("ol > li")).toHaveLength(0);
    expect(screen.getByTestId("trajectory-no-match")).toHaveTextContent("没有匹配的步骤");
  });
});