import { afterEach, describe, expect, it, vi } from "vitest";
import { buildTraceGraph, fetchTrace, shortTime, type TraceRoute } from "./magpieTrace.js";

/** 实时链路的纯函数（d.101）：读快照、节点图构建、状态口径。 */

const route = (overrides: Partial<TraceRoute> = {}): TraceRoute => ({
  id: 7,
  seq: 3,
  time: "2026-11-08T02:00:00Z",
  agent: "claude",
  model: "deepseek/deepseek-chat",
  provider: "deepseek",
  order: [{ id: "deepseek-key", provider: "deepseek", name: "DeepSeek", who: "工作号", kind: "key", model: "deepseek-chat" }],
  tries: [{ id: "deepseek-key", done: true, status: 200, ms: 1200 }],
  done: true,
  status: 200,
  ms: 1400,
  ...overrides,
});

afterEach(() => {
  vi.unstubAllGlobals();
});

describe("fetchTrace", () => {
  it("读网关快照：routes/seq 归一；HTTP 错误给人话", async () => {
    const fetchMock = vi.fn(async (_url: string, _init?: RequestInit) =>
      new Response(JSON.stringify({ seq: 9, now: "2026-11-08T02:00:00Z", routes: [route()] }), {
        status: 200,
        headers: { "content-type": "application/json" },
      }),
    );
    vi.stubGlobal("fetch", fetchMock);
    const snapshot = await fetchTrace("http://127.0.0.1:40000/v1");
    expect(snapshot.seq).toBe(9);
    expect(snapshot.routes).toHaveLength(1);
    expect(String(fetchMock.mock.calls[0][0])).toBe("http://127.0.0.1:40000/v1/magpie/trace");

    vi.stubGlobal("fetch", vi.fn(async () => new Response("nope", { status: 403 })));
    await expect(fetchTrace("http://127.0.0.1:40000/v1")).rejects.toThrow(/HTTP 403/);
  });

  it("形状不对（没有 routes）也拒绝，不装成空图", async () => {
    vi.stubGlobal("fetch", vi.fn(async () => new Response(JSON.stringify({ ok: true }), { status: 200 })));
    await expect(fetchTrace("http://x/v1")).rejects.toThrow(/缺少 routes/);
  });
});

describe("buildTraceGraph", () => {
  it("一条成功请求：agent 与账号各一个节点，状态 ok，行信息齐全", () => {
    const graph = buildTraceGraph([route()]);
    expect(graph.agents.map((n) => n.label)).toEqual(["claude"]);
    expect(graph.accounts.map((n) => n.label)).toEqual(["工作号"]);
    expect(graph.edges[0]).toMatchObject({ state: "ok", agent: "claude", model: "deepseek/deepseek-chat", account: "工作号" });
    expect(graph.rows[0]).toMatchObject({ account: "工作号", state: "ok" });
  });

  it("未结束 = live；失败 = failed；同一 agent/账号去重", () => {
    const graph = buildTraceGraph([
      route({ id: 1, done: false, status: undefined }),
      route({ id: 2, status: 429, error: "rate limited" }),
      route({ id: 3 }),
    ]);
    expect(graph.edges.map((e) => e.state)).toEqual(["live", "failed", "ok"]);
    expect(graph.agents).toHaveLength(1);
    expect(graph.accounts).toHaveLength(1);
    expect(graph.rows).toHaveLength(3);
  });

  it("落点优先取最后一次尝试（换过账号/Key 时才对）；没有尝试时取候选第一位", () => {
    const swapped = buildTraceGraph([
      route({
        order: [
          { id: "a", provider: "openai", name: "OpenAI", who: "主号", kind: "account", model: "gpt-4o" },
          { id: "b", provider: "openai", name: "OpenAI", who: "备用号", kind: "account", model: "gpt-4o" },
        ],
        tries: [
          { id: "a", done: true, status: 429 },
          { id: "b", done: true, status: 200 },
        ],
      }),
    ]);
    expect(swapped.accounts.map((n) => n.label)).toEqual(["备用号"]);
    expect(swapped.edges[0]?.state).toBe("ok");

    const noTries = buildTraceGraph([
      route({ tries: [], done: false, status: undefined, order: [{ id: "z", provider: "p", name: "P", who: "某 Key", kind: "key", model: "m" }] }),
    ]);
    expect(noTries.accounts.map((n) => n.label)).toEqual(["某 Key"]);
    expect(noTries.edges[0]?.state).toBe("live");
  });

  it("空快照 → 空图（页面显示引导，不伪造节点）", () => {
    expect(buildTraceGraph([])).toEqual({ agents: [], accounts: [], edges: [], rows: [] });
  });
});

describe("展示辅助", () => {
  it("shortTime 对坏时间给出 —", () => {
    expect(shortTime("not-a-time")).toBe("—");
    expect(shortTime("2026-11-08T02:03:04Z")).toMatch(/\d{2}:\d{2}:\d{2}/);
  });
});
