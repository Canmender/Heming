import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { fireEvent, render, screen, waitFor } from "@testing-library/react";
import { ModelTraceView } from "./ModelTraceView.js";
import { useLlmStore, DEFAULT_GATEWAY } from "../store/llm.js";

/** 实时链路节点图（d.104）：节点/连线/状态色/筛选/详情/空态。 */

const snapshot = {
  seq: 5,
  now: "2026-11-08T02:00:00Z",
  routes: [
    {
      id: 1,
      seq: 5,
      time: "2026-11-08T02:00:00Z",
      agent: "claude",
      model: "deepseek/deepseek-chat",
      provider: "deepseek",
      order: [
        { id: "k1", provider: "deepseek", name: "DeepSeek", who: "工作号", kind: "key", model: "deepseek-chat" },
      ],
      tries: [{ id: "k1", done: true, status: 200, ms: 900 }],
      done: true,
      status: 200,
      ms: 1200,
      tokens: 320,
    },
    {
      id: 2,
      seq: 6,
      time: "2026-11-08T02:00:03Z",
      agent: "codex",
      model: "gpt-4o",
      provider: "openai",
      order: [
        { id: "a2", provider: "openai", name: "OpenAI", who: "备用号", kind: "account", model: "gpt-4o" },
      ],
      tries: [{ id: "a2", done: false }],
      done: false,
    },
  ],
};

function mockFetch(body: unknown, status = 200) {
  vi.stubGlobal(
    "fetch",
    vi.fn(
      async () =>
        new Response(JSON.stringify(body), {
          status,
          headers: { "content-type": "application/json" },
        }),
    ),
  );
}

beforeEach(() => {
  useLlmStore.setState({ gateway: { ...DEFAULT_GATEWAY, source: "desktop" } });
});

afterEach(() => {
  vi.unstubAllGlobals();
  vi.restoreAllMocks();
});

describe("ModelTraceView", () => {
  it("画出客户端/账号节点与状态色；进行中的连线有流动效果", async () => {
    mockFetch(snapshot);
    render(<ModelTraceView />);
    expect(await screen.findByRole("img", { name: "路由节点图" })).toBeInTheDocument();
    expect(screen.getByText(/模型服务正在做的决定/)).toBeInTheDocument();
    expect(screen.getAllByText("claude").length).toBeGreaterThan(0);
    expect(screen.getAllByText("工作号").length).toBeGreaterThan(0);
    // 进行中的连线带 rta-flow；完成的没有
    expect(screen.getByTestId("trace-edge-2").querySelector(".rta-flow")).not.toBeNull();
    expect(screen.getByTestId("trace-edge-1").querySelector(".rta-flow")).toBeNull();
    // 最近请求记录
    expect(screen.getByText("最近请求是怎么走的")).toBeInTheDocument();
    // 统计大数字
    expect(screen.getByText("请求")).toBeInTheDocument();
    expect(screen.getByText("改道")).toBeInTheDocument();
  });

  it("点最近请求打开详情；关闭收回", async () => {
    mockFetch(snapshot);
    render(<ModelTraceView />);
    await screen.findByRole("img", { name: "路由节点图" });
    fireEvent.click(screen.getByText(/由 工作号 回答/));
    expect(screen.getByText("请求详情")).toBeInTheDocument();
    expect(screen.getByText(/落点：工作号/)).toBeInTheDocument();
    expect(screen.getByText(/token：320/)).toBeInTheDocument();
    fireEvent.click(screen.getByRole("button", { name: "关闭" }));
    expect(screen.queryByText("请求详情")).not.toBeInTheDocument();
  });

  it("按状态筛选：只看进行中，再切回全部", async () => {
    mockFetch(snapshot);
    render(<ModelTraceView />);
    await screen.findByRole("img", { name: "路由节点图" });
    fireEvent.click(screen.getByRole("button", { name: "进行中" }));
    expect(screen.getByTestId("trace-edge-2")).toBeInTheDocument();
    expect(screen.queryByTestId("trace-edge-1")).toBeNull();
    fireEvent.click(screen.getByRole("button", { name: "全部" }));
    expect(screen.getByTestId("trace-edge-1")).toBeInTheDocument();
  });

  it("没有请求时给引导，不伪造节点", async () => {
    mockFetch({ seq: 0, now: "2026-11-08T02:00:00Z", routes: [] });
    render(<ModelTraceView />);
    expect(await screen.findByText("还没有请求经过")).toBeInTheDocument();
    expect(screen.queryByRole("img", { name: "路由节点图" })).toBeNull();
  });

  it("读不到路由记录：显示错误而不是空图", async () => {
    mockFetch({ error: "no" }, 403);
    render(<ModelTraceView />);
    await waitFor(() => expect(screen.getByRole("alert")).toHaveTextContent(/HTTP 403/));
  });
});
