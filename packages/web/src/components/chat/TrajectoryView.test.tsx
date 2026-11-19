import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { cleanup, fireEvent, render, screen, within } from "@testing-library/react";
import type { Message } from "@heming/shared";
import { TrajectoryView } from "./TrajectoryView.js";
import { useChatStore } from "../../store/chat.js";
import type { ConversationProgress, ProgressStep } from "../../lib/progress/model.js";

/**
 * 「轨迹」页签（d.351，按 DSH 的 ledger 重做）：整段会话的账本。
 *
 * 契约：
 * - `section[aria-label="会话轨迹"][data-view-panel="trail"]` + h3「轨迹」；
 * - 没有消息也没有进度 → EmptyState（h2「还没有轨迹」）；
 * - 有消息 → 按用户消息分轮，轮内列用户/思考/工具/回答，表头「步/类型/内容/状态/耗时」；
 * - 工具栏：搜索、折叠轮次、时长/等宽；筛选时给「命中 / 总数」；
 * - 行可点开看参数与结果全文。
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
  return { id: "s1", kind: "tool", label: "调用 read_file", status: "ok", ...over };
}

function message(over: Partial<Message> & { steps?: unknown; tools?: unknown }): Message {
  return {
    id: "m1",
    conversationId: "c1",
    senderType: "agent",
    senderId: "a1",
    payload: { text: "" },
    createdAt: "2026-11-19T00:00:00.000Z",
    enc: "plain",
    ...over,
  } as Message;
}

/** 一轮完整对话：用户发问 → 想 → 读文件 → 回答。 */
function oneTurn(): Message[] {
  return [
    message({ id: "u1", senderType: "user", senderId: "me", payload: { text: "帮我看看登录为什么会失败" } }),
    message({
      id: "a1",
      payload: { text: "问题在 token 过期判断。" },
      steps: [
        { kind: "think", text: "先看登录入口" },
        { kind: "tool", toolId: "t1" },
        { kind: "think", text: "再看 token 校验" },
      ],
      tools: [
        {
          id: "t1",
          name: "read_file",
          args: '{ "path": "src/login.ts" }',
          status: "ok",
          result: "第 42 行：token 已过期",
          startedAt: 1_000,
          endedAt: 1_500,
        },
      ],
    }),
  ];
}

beforeEach(() => {
  useChatStore.setState({ messages: {} });
});

afterEach(() => cleanup());

describe("TrajectoryView · 会话账本", () => {
  it("空态：没有消息也没有进度时出 h2 空态，不编造表格", () => {
    const { container } = render(<TrajectoryView progress={progress()} conversationId="c1" />);
    const section = container.querySelector('section[data-view-panel="trail"]')!;
    expect(section).toHaveAttribute("aria-label", "会话轨迹");
    expect(screen.getByRole("heading", { level: 3, name: "轨迹" })).toBeInTheDocument();
    expect(screen.getByRole("heading", { level: 2, name: "还没有轨迹" })).toBeInTheDocument();
    expect(container.querySelector("table")).toBeNull();
  });

  it("按用户消息分轮：用户、思考、工具、回答都在同一轮里，顺序就是发生顺序", () => {
    useChatStore.setState({ messages: { c1: oneTurn() } });
    render(<TrajectoryView progress={progress()} conversationId="c1" />);

    expect(screen.getByTestId("trajectory-summary")).toHaveTextContent("1 轮 · 5 步");
    expect(screen.getByTestId("trajectory-summary")).toHaveTextContent("1 次工具调用");

    const table = screen.getByRole("table");
    // 用户那一行 + 三个 agent 行 + 分组头
    const rows = within(table).getAllByRole("row");
    const text = rows.map((row) => row.textContent ?? "").join("\n");
    expect(text).toContain("第 1 轮");
    expect(text).toContain("帮我看看登录为什么会失败");
    expect(text).toContain("用户");
    expect(text).toContain("先看登录入口");
    expect(text).toContain("调用 read_file");
    expect(text).toContain("问题在 token 过期判断。");
    expect(text).toContain("完成");
  });

  it("两轮对话：各自分组，时间线也给出两根", () => {
    useChatStore.setState({
      messages: {
        c1: [
          ...oneTurn(),
          message({ id: "u2", senderType: "user", senderId: "me", payload: { text: "那要怎么修？" } }),
          message({ id: "a2", payload: { text: "改成比较过期时间。" } }),
        ],
      },
    });
    render(<TrajectoryView progress={progress()} conversationId="c1" />);

    expect(screen.getByTestId("trajectory-summary")).toHaveTextContent("2 轮");
    const table = screen.getByRole("table");
    const groups = within(table)
      .getAllByRole("rowgroup")
      .map((group) => group.textContent ?? "");
    // 两个 tbody 里各有一个「第 N 轮」分组头
    expect(within(table).getByText("第 1 轮")).toBeInTheDocument();
    expect(within(table).getByText("第 2 轮")).toBeInTheDocument();
    expect(groups.length).toBeGreaterThanOrEqual(2);
    const timeline = screen.getByTestId("trajectory-timeline");
    expect(timeline.querySelectorAll("button")).toHaveLength(2);
  });

  it("小结里带上工具耗时与全程跨度（d.381）", () => {
    const turn = oneTurn();
    const agent = turn[1] as unknown as { tools: unknown[] } & Message;
    agent.tools = [
      { id: "t1", name: "read_file", args: '{"path":"src/login.ts"}', status: "ok", result: "ok", startedAt: 1_000, endedAt: 5_000 },
    ];
    useChatStore.setState({ messages: { c1: turn } });
    render(<TrajectoryView progress={progress()} conversationId="c1" />);
    const summary = screen.getByTestId("trajectory-summary");
    expect(summary).toHaveTextContent("工具 4.0 秒");
    expect(summary).toHaveTextContent("全程 4.0 秒");
  });

  it("没有时间戳的老消息不编耗时", () => {
    useChatStore.setState({
      messages: { c1: [message({ id: "a9", payload: { text: "老消息" }, steps: [{ kind: "think", text: "想过" }] })] },
    });
    render(<TrajectoryView progress={progress()} conversationId="c1" />);
    expect(screen.getByTestId("trajectory-summary")).not.toHaveTextContent("全程");
    expect(screen.getByTestId("trajectory-summary")).not.toHaveTextContent("工具 ");
  });
  it("正在跑的那一步会接在最后一轮末尾，并标「进行中」", () => {
    useChatStore.setState({ messages: { c1: oneTurn() } });
    render(
      <TrajectoryView
        conversationId="c1"
        progress={progress({
          hasData: true,
          phase: "acting",
          steps: [step({ id: "live1", label: "调用 file_grep", status: "running" })],
          tools: [{ id: "live1", name: "file_grep", args: "", status: "running", startedAt: 2_000 }],
        })}
      />,
    );
    const table = screen.getByRole("table");
    expect(table.textContent).toContain("调用 file_grep");
    expect(table.textContent).toContain("进行中");
  });
});

describe("TrajectoryView · 工具栏（d.351）", () => {
  it("搜索只留命中步骤，并给「命中 / 总数」；无命中时给一句可操作的说明", () => {
    useChatStore.setState({ messages: { c1: oneTurn() } });
    const { container } = render(<TrajectoryView progress={progress()} conversationId="c1" />);
    const search = screen.getByRole("searchbox", { name: "搜索轨迹" });
    fireEvent.change(search, { target: { value: "src/login.ts" } });
    expect(screen.getByTestId("trajectory-filter-count")).toHaveTextContent("1 / 5 步");
    expect(container.querySelector("table")!.textContent).not.toContain("帮我看看登录为什么会失败");

    fireEvent.change(search, { target: { value: "根本没有这个词" } });
    expect(screen.getByTestId("trajectory-no-match")).toHaveTextContent("没有匹配的步骤");
  });

  it("折叠全部轮次：只剩分组头与「本轮已折叠」，再点展开", () => {
    useChatStore.setState({ messages: { c1: oneTurn() } });
    const { container } = render(<TrajectoryView progress={progress()} conversationId="c1" />);
    fireEvent.click(screen.getByRole("button", { name: "⊟ 折叠轮次" }));
    expect(container.querySelector("table")!.textContent).toContain("本轮已折叠");
    expect(container.querySelector("table")!.textContent).not.toContain("先看登录入口");
    fireEvent.click(screen.getByRole("button", { name: "⊞ 展开轮次" }));
    expect(container.querySelector("table")!.textContent).toContain("先看登录入口");
  });

  it("点一行展开参数与结果全文", () => {
    useChatStore.setState({ messages: { c1: oneTurn() } });
    const { container } = render(<TrajectoryView progress={progress()} conversationId="c1" />);
    const row = within(screen.getByRole("table"))
      .getAllByRole("row")
      .find((item) => item.textContent?.includes("调用 read_file"))!;
    fireEvent.click(row);
    expect(container.textContent).toContain('{ "path": "src/login.ts" }');
    expect(container.textContent).toContain("第 42 行：token 已过期");
  });

  it("时长/等宽是个开关，不影响数据本身", () => {
    useChatStore.setState({ messages: { c1: oneTurn() } });
    render(<TrajectoryView progress={progress()} conversationId="c1" />);
    const toggle = screen.getByRole("button", { name: "时长按等宽显示" });
    expect(toggle).toHaveAttribute("aria-pressed", "false");
    fireEvent.click(toggle);
    expect(toggle).toHaveAttribute("aria-pressed", "true");
    // 工具那一步有起止时间：真实耗时 500ms
    expect(screen.getByRole("table").textContent).toContain("500ms");
  });
});




  it("每轮标题写出这一轮花了多久（d.401）", () => {
    useChatStore.setState({
      messages: {
        c1: [
          message({ id: "u1", senderType: "user", payload: { text: "帮我查两处" } }),
          message({
            id: "a1",
            payload: { text: "查完了" },
            senderType: "agent",
            tools: [
              { id: "t1", name: "read_file", args: "{}", status: "ok", result: "a", startedAt: 1_000, endedAt: 5_000 },
            ],
          }),
        ],
      },
    });
    render(<TrajectoryView progress={progress({ hasData: false })} conversationId="c1" />);
    expect(screen.getByRole("button", { name: /第 1 轮/ }).textContent).toContain("4.0s");
  });


