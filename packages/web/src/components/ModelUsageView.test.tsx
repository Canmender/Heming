import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { fireEvent, render, screen, waitFor } from "@testing-library/react";
import { ModelUsageView } from "./ModelUsageView.js";
import { useLlmStore, DEFAULT_GATEWAY } from "../store/llm.js";

/** 用量页（d.110）：概览、柱状图、拆分、最近请求、周期切换。 */

const usage = {
  period: "30d",
  since: "2026-10-10T00:00:00+08:00",
  calls: 4,
  errors: 1,
  input: 1200,
  output: 800,
  cache_read: 300,
  cache_write: 0,
  cost: 0.25,
  unpriced: 2,
  series: [
    { label: "Oct 10", time: "1", calls: 0, errors: 0, input: 0, output: 0, cost: 0, unpriced: 0 },
    { label: "Oct 11", time: "2", calls: 4, errors: 1, input: 1200, output: 800, cost: 0.25, unpriced: 2 },
  ],
  agents: [{ id: "heming", name: "和鸣", calls: 4, errors: 1, input: 1200, output: 800, cost: 0.25 }],
  models: [{ id: "mock/mock-model", provider: "mock", model: "mock/mock-model", calls: 4, input: 1200, output: 800, cost: 0.25, timed: 4, ttft_ms: 3200 }],
  accounts: [],
};

const requests = {
  period: "30d",
  total: 4,
  rows: [
    { route_id: 1, t: "2026-11-08T10:00:00Z", agent: "heming", model: "mock/mock-model", req: "mock/mock-model", in: 3, out: 5, ms: 61, status: 200, cost: 0 },
  ],
};

/** 一条有首字、试过两次、最后被上游限流的请求：明细里要读得出这些。 */
const slowRequests = {
  period: "30d",
  total: 1,
  rows: [
    {
      route_id: 9,
      t: "2026-11-08T10:05:00Z",
      agent: "heming",
      model: "mock/mock-model",
      req: "mock/mock-model",
      in: 3,
      out: 5,
      ms: 900,
      ttft_ms: 720,
      sent_ms: 600,
      own_ms: 100,
      retried_ms: 200,
      queued_ms: 50,
      tries: 2,
      handed_on: true,
      err: "rate limited by the vendor",
      status: 429,
      cost: 0,
    },
  ],
};

function mockFetch(periodOverride?: string) {
  const fetchMock = vi.fn(async (input: string) => {
    const url = String(input);
    if (url.includes("/magpie/usage/requests")) {
      return new Response(JSON.stringify(requests), { status: 200, headers: { "content-type": "application/json" } });
    }
    return new Response(
      JSON.stringify(periodOverride ? { ...usage, period: periodOverride } : usage),
      { status: 200, headers: { "content-type": "application/json" } },
    );
  });
  vi.stubGlobal("fetch", fetchMock);
  return fetchMock;
}

beforeEach(() => {
  useLlmStore.setState({ gateway: { ...DEFAULT_GATEWAY, source: "desktop" } });
});

afterEach(() => {
  vi.unstubAllGlobals();
  vi.restoreAllMocks();
});

describe("ModelUsageView", () => {
  it("显示概览、柱状图、拆分与最近请求", async () => {
    mockFetch();
    render(<ModelUsageView onExportCsv={vi.fn()} />);
    expect((await screen.findAllByText("请求")).length).toBeGreaterThan(0);
    expect(screen.getAllByText("4").length).toBeGreaterThan(0);
    expect(screen.getByText(/1 次失败/)).toBeInTheDocument();
    expect(screen.getByRole("img", { name: "用量柱状图" })).toBeInTheDocument();
    expect(screen.getAllByText(/mock\/mock-model/).length).toBeGreaterThan(0);
    expect(screen.getByText("最近请求")).toBeInTheDocument();
    expect(screen.getByText("导出 CSV")).toBeInTheDocument();
    expect(await screen.findByText(/平均首字 800ms/)).toBeInTheDocument();
  });

  it("切换周期会用新周期重新取数；切「按 Agent」换拆分维度", async () => {
    const fetchMock = mockFetch();
    render(<ModelUsageView />);
    await screen.findByText("最近请求");
    fireEvent.click(screen.getByRole("button", { name: "7 天" }));
    await waitFor(() =>
      expect(fetchMock.mock.calls.some(([url]) => String(url).includes("period=7d"))).toBe(true),
    );
    fireEvent.click(screen.getByRole("button", { name: "按 Agent" }));
    expect(await screen.findByText("和鸣")).toBeInTheDocument();
  });

  it("最近请求读得出首字：慢在哪儿、试了几次、失败原因都挂在格子上", async () => {
    vi.stubGlobal(
      "fetch",
      vi.fn(async (input: string) =>
        String(input).includes("/magpie/usage/requests")
          ? new Response(JSON.stringify(slowRequests), { status: 200, headers: { "content-type": "application/json" } })
          : new Response(JSON.stringify(usage), { status: 200, headers: { "content-type": "application/json" } }),
      ),
    );
    render(<ModelUsageView />);
    const cell = await screen.findByTitle(/^首字 720ms（和鸣自己 100ms、先失败的那几次 200ms、排队 50ms、上游 250ms）$/);
    expect(cell).toHaveTextContent("720ms");
    expect(screen.getByText("这一试失败，交给了下一条")).toBeInTheDocument();
    expect(screen.getByTitle("rate limited by the vendor")).toHaveTextContent("429");
  });

  it("没有调用时给空态，不画空图", async () => {
    vi.stubGlobal(
      "fetch",
      vi.fn(async () =>
        new Response(
          JSON.stringify({ ...usage, calls: 0, series: [], agents: [], models: [], accounts: [] }),
          { status: 200, headers: { "content-type": "application/json" } },
        ),
      ),
    );
    render(<ModelUsageView />);
    expect(await screen.findByText("这个时间段还没有调用")).toBeInTheDocument();
    expect(screen.queryByRole("img", { name: "用量柱状图" })).toBeNull();
  });

  it("读不到用量：显示错误而不是空图", async () => {
    vi.stubGlobal("fetch", vi.fn(async () => new Response("no", { status: 503 })));
    render(<ModelUsageView />);
    await waitFor(() => expect(screen.getByRole("alert")).toHaveTextContent(/HTTP 503/));
  });
});
