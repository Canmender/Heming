import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { fireEvent, render, screen, waitFor } from "@testing-library/react";
import { ModelTraceView } from "./ModelTraceView.js";
import { useLlmStore, DEFAULT_GATEWAY } from "../store/llm.js";

/** 实时链路节点视图（d.101）：快照 → 节点/连线/列表/详情。 */

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
      order: [{ id: "k1", provider: "deepseek", name: "DeepSeek", who: "工作号", kind: "key", model: "deepseek-chat" }],
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
      order: [{ id: "a2", provider: "openai", name: "OpenAI", who: "备用号", kind: "account", model: "gpt-4o" }],
      tries: [{ id: "a2", done: false }],
      done: false,
    },
  ],
};

function mockFetch(body: unknown, status = 200) {
  vi.stubGlobal(
    "fetch",
    vi.fn(async () => new Response(JSON.stringify(body), { status, headers: { "content-type": "application/json" } })),
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
  it("画出客户端/账号节点、统计进行中，并列出请求", async () => {
    mockFetch(snapshot);
    render(<ModelTraceView />);
    expect(await screen.findByText(/2 个请求 · 1 进行中 · 1 成功 · 0 失败/)).toBeInTheDocument();
    expect(screen.getByRole("img", { name: "路由节点图" })).toBeInTheDocument();
    expect(screen.getAllByText("claude").length).toBeGreaterThan(0);
    expect(screen.getAllByText("工作号").length).toBeGreaterThan(0);
    expect(screen.getAllByText(/deepseek\/deepseek-chat/).length).toBeGreaterThan(0);
    // 进行中的请求有流动圆点，成功/失败没有
    expect(screen.getByTestId("trace-edge-2").querySelector("animateMotion")).not.toBeNull();
    expect(screen.getByTestId("trace-edge-1").querySelector("animateMotion")).toBeNull();
  });

  it("点行打开详情（尝试列表、token）；关闭按钮收回", async () => {
    mockFetch(snapshot);
    render(<ModelTraceView />);
    await screen.findByText(/2 个请求/);
    fireEvent.click(screen.getByText("deepseek/deepseek-chat"));
    expect(screen.getByText("请求 #1")).toBeInTheDocument();
    expect(screen.getByText(/k1/)).toBeInTheDocument();
    expect(screen.getByText("320")).toBeInTheDocument();
    fireEvent.click(screen.getByRole("button", { name: "关闭详情" }));
    expect(screen.queryByText("请求 #1")).not.toBeInTheDocument();
  });

  it("按状态筛选：只看进行中/失败，清除筛选恢复", async () => {
    mockFetch(snapshot);
    render(<ModelTraceView />);
    await screen.findByText(/2 个请求/);
    fireEvent.click(screen.getByRole("button", { name: "进行中" }));
    expect(screen.getByTestId("trace-edge-2")).toBeInTheDocument();
    expect(screen.queryByTestId("trace-edge-1")).toBeNull();
    // 关闭了过滤后两条都在
    fireEvent.click(screen.getByRole("button", { name: "清除筛选" }));
    expect(screen.getByTestId("trace-edge-1")).toBeInTheDocument();
    expect(screen.getByTestId("trace-edge-2")).toBeInTheDocument();
  });

  it("没有请求时给引导，不伪造节点", async () => {
    mockFetch({ seq: 0, now: "2026-11-08T02:00:00Z", routes: [] });
    render(<ModelTraceView />);
    expect(await screen.findByText("还没有请求经过")).toBeInTheDocument();
    expect(screen.queryByRole("img", { name: "路由节点图" })).toBeNull();
  });

  it("停掉网关/读不到 trace：显示错误而不是空图", async () => {
    mockFetch({ error: "no" }, 403);
    render(<ModelTraceView />);
    await waitFor(() => expect(screen.getByRole("alert")).toHaveTextContent(/HTTP 403/));
  });
});
