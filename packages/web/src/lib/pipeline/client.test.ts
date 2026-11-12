import { describe, expect, it, vi } from "vitest";
import {
  PipelineError,
  createPipelineClient,
  normalizeRun,
  type PipelineApproval,
  type PipelineClientOptions,
} from "./client.js";

/** 造一个够用的假 Response（只用到 ok/status/json）。 */
function jsonResponse(body: unknown, status = 200): Response {
  return {
    ok: status >= 200 && status < 300,
    status,
    json: async () => body,
  } as Response;
}

interface Route {
  /** 例：`POST /v1/runs`、`GET /v1/runs/r1`。 */
  match: string;
  responses: Response[];
}

function fakeFetch(routes: Route[]) {
  const calls: { url: string; method: string; headers: Record<string, string>; body?: string }[] = [];
  const impl = vi.fn(async (input: string, init?: RequestInit) => {
    const url = String(input);
    const method = (init?.method ?? "GET").toUpperCase();
    calls.push({
      url,
      method,
      headers: (init?.headers ?? {}) as Record<string, string>,
      body: typeof init?.body === "string" ? init.body : undefined,
    });
    const key = `${method} ${url.replace(/^https?:\/\/[^/]+/, "")}`;
    const route = routes.find((item) => item.match === key);
    if (!route || route.responses.length === 0) {
      throw new Error(`测试没配这条路由：${key}`);
    }
    const next = route.responses.length > 1 ? route.responses.shift()! : route.responses[0]!;
    return next;
  });
  return { impl: impl as unknown as typeof fetch, calls };
}

function makeClient(routes: Route[], extra: Partial<PipelineClientOptions> = {}) {
  const { impl, calls } = fakeFetch(routes);
  const sleeps: number[] = [];
  const client = createPipelineClient({
    baseUrl: "http://127.0.0.1:8000/",
    apiKey: "k-123",
    fetchImpl: impl,
    sleep: async (ms, signal) => {
      if (signal?.aborted) throw new PipelineError("aborted", "已中止（用户点了停止）");
      sleeps.push(ms);
    },
    ...extra,
  });
  return { client, calls, sleeps };
}

const RUNNING = () => jsonResponse({ run_id: "r1", status: "running", pending_approvals: [] });

function finished(overrides: Record<string, unknown> = {}) {
  return jsonResponse({
    run_id: "r1",
    status: "ok",
    pending_approvals: [],
    result: {
      run_id: "r1",
      status: "ok",
      answer: "装好了",
      citations: [{ doc_id: "doc-installer", chunk: 0, quote: "通用外壳" }],
      coverage: null,
      stop_reason: null,
      llm_calls: 4,
      tokens: 900,
      config_version: 2,
      error: null,
      ...overrides,
    },
  });
}

describe("agent-pipeline 客户端", () => {
  it("提交后轮询到终态，并把 snake_case 收敛成 camelCase", async () => {
    const { client, calls, sleeps } = makeClient([
      { match: "POST /v1/runs", responses: [jsonResponse({ run_id: "r1", status: "running" }, 202)] },
      {
        match: "GET /v1/runs/r1",
        responses: [RUNNING(), jsonResponse({ run_id: "r1", status: "running", pending_approvals: [] }), finished()],
      },
    ]);

    const run = await client.run({ goal: "把安装器补成通用外壳", mode: "react", coverageTarget: 0.9 });

    expect(run).toMatchObject({
      runId: "r1",
      status: "ok",
      answer: "装好了",
      llmCalls: 4,
      tokens: 900,
      configVersion: 2,
      coverage: null,
      stopReason: null,
      error: null,
    });
    expect(run.citations).toEqual([{ doc_id: "doc-installer", chunk: 0, quote: "通用外壳" }]);
    // baseUrl 末尾斜杠被吃掉、鉴权头带上、请求体是 snake_case（服务端 pydantic 只认这个）
    expect(calls[0]!.url).toBe("http://127.0.0.1:8000/v1/runs");
    expect(calls[0]!.headers.Authorization).toBe("Bearer k-123");
    expect(JSON.parse(calls[0]!.body!)).toMatchObject({ mode: "react", coverage_target: 0.9 });
    // 两次「还在跑」各睡一个轮询间隔
    expect(sleeps).toEqual([500, 500]);
  });

  it("429（并发满）不是错误：退避后重提一次", async () => {
    const { client, calls, sleeps } = makeClient([
      {
        match: "POST /v1/runs",
        responses: [jsonResponse({ detail: "并发已满，请稍后重试" }, 429), jsonResponse({ run_id: "r1", status: "running" }, 202)],
      },
      { match: "GET /v1/runs/r1", responses: [finished()] },
    ]);

    const run = await client.run({ goal: "x" });

    expect(run.status).toBe("ok");
    expect(calls.filter((c) => c.method === "POST")).toHaveLength(2);
    expect(sleeps[0]).toBe(1_000); // Retry-After 缺失时按 1s 兜底
  });

  it("非 2xx 抛 PipelineError(http)，带上服务端 detail", async () => {
    const { client } = makeClient([
      { match: "POST /v1/runs", responses: [jsonResponse({ detail: "mode 只能是 react 或 adversarial" }, 422)] },
    ]);

    await expect(client.run({ goal: "x" })).rejects.toMatchObject({
      kind: "http",
      status: 422,
      detail: "mode 只能是 react 或 adversarial",
    });
  });

  it("连不上服务时是 network 错误，不是「流水线挂了」", async () => {
    const client = createPipelineClient({
      baseUrl: "http://127.0.0.1:9",
      fetchImpl: (async () => {
        throw new TypeError("fetch failed");
      }) as unknown as typeof fetch,
    });

    await expect(client.run({ goal: "x" })).rejects.toMatchObject({ kind: "network" });
  });

  it("用户中止：抛 aborted，不再继续轮询", async () => {
    const controller = new AbortController();
    const { client } = makeClient(
      [
        { match: "POST /v1/runs", responses: [jsonResponse({ run_id: "r1", status: "running" }, 202)] },
        { match: "GET /v1/runs/r1", responses: [RUNNING()] },
      ],
      {
        sleep: async () => {
          controller.abort(); // 第一次轮询等待时用户点了停止
          const error = new PipelineError("aborted", "已中止（用户点了停止）");
          throw error;
        },
      },
    );

    await expect(client.run({ goal: "x" }, { signal: controller.signal })).rejects.toMatchObject({ kind: "aborted" });
  });

  it("run 超时：请求取消后抛 timeout（不让服务端继续白烧模型）", async () => {
    let clock = 0;
    const { client, calls } = makeClient(
      [
        { match: "POST /v1/runs", responses: [jsonResponse({ run_id: "r1", status: "running" }, 202)] },
        { match: "GET /v1/runs/r1", responses: [RUNNING()] },
        { match: "POST /v1/runs/r1/cancel", responses: [jsonResponse({ ok: true }, 202)] },
      ],
      { now: () => clock, runTimeoutMs: 1_000, sleep: async () => void (clock += 400) },
    );

    await expect(client.run({ goal: "x" })).rejects.toMatchObject({ kind: "timeout" });
    expect(calls.some((c) => c.url.endsWith("/cancel"))).toBe(true);
  });

  it("解构出来的 run 也能在超时时请求取消（方法里的 this 不能当依赖）", async () => {
    let clock = 0;
    const { client, calls } = makeClient(
      [
        { match: "POST /v1/runs", responses: [jsonResponse({ run_id: "r1", status: "running" }, 202)] },
        { match: "GET /v1/runs/r1", responses: [RUNNING()] },
        { match: "POST /v1/runs/r1/cancel", responses: [jsonResponse({ ok: true }, 202)] },
      ],
      { now: () => clock, runTimeoutMs: 1_000, sleep: async () => void (clock += 400) },
    );
    const { run } = client;

    await expect(run({ goal: "x" })).rejects.toMatchObject({ kind: "timeout" });
    expect(calls.some((c) => c.url.endsWith("/cancel"))).toBe(true);
  });

  it("待审批的工具调用交给调用方裁决，并回填 /approve", async () => {
    const approval: PipelineApproval = {
      call_id: "c9",
      tool: "run_command",
      arguments: { command: "npm test" },
      requested_at: 1,
      timeout_s: 300,
    };
    const seen: PipelineApproval[] = [];
    const { client, calls } = makeClient(
      [
        { match: "POST /v1/runs", responses: [jsonResponse({ run_id: "r1", status: "running" }, 202)] },
        {
          match: "GET /v1/runs/r1",
          responses: [jsonResponse({ run_id: "r1", status: "running", pending_approvals: [approval] }), finished()],
        },
        { match: "POST /v1/runs/r1/approve", responses: [jsonResponse({ ok: true })] },
      ],
      {
        onPendingApproval: async (item) => {
          seen.push(item);
          return true;
        },
      },
    );

    const run = await client.run({ goal: "跑测试" });

    expect(run.status).toBe("ok");
    expect(seen).toEqual([approval]);
    const approve = calls.find((c) => c.url.endsWith("/approve"));
    expect(approve?.body).toBe(JSON.stringify({ call_id: "c9", approved: true }));
  });

  it("没有裁决回调时不动 pending（服务端超时自己按拒绝收口）", async () => {
    const { client, calls } = makeClient([
      { match: "POST /v1/runs", responses: [jsonResponse({ run_id: "r1", status: "running" }, 202)] },
      {
        match: "GET /v1/runs/r1",
        responses: [
          jsonResponse({ run_id: "r1", status: "running", pending_approvals: [{ call_id: "c1", tool: "run_command", arguments: {}, requested_at: 0, timeout_s: 300 }] }),
          finished(),
        ],
      },
    ]);

    await expect(client.run({ goal: "x" })).resolves.toMatchObject({ status: "ok" });
    expect(calls.some((c) => c.url.endsWith("/approve"))).toBe(false);
  });

  it("health 只保留认识的字段", async () => {
    const { client } = makeClient([
      { match: "GET /health", responses: [jsonResponse({ ok: true, tools: ["http_get", 42, "knowledge_search"], running: 2, junk: 1 })] },
    ]);

    await expect(client.health()).resolves.toEqual({ ok: true, tools: ["http_get", "knowledge_search"], running: 2 });
  });
});

describe("normalizeRun", () => {
  it("字段缺失/类型不对时给安全默认值，不抛错", () => {
    const run = normalizeRun({ status: "queued" }, "fallback");
    expect(run).toMatchObject({ runId: "fallback", status: "running", answer: "", citations: [], coverage: null, llmCalls: 0 });
  });

  it("坏的引用与非整数 chunk 被丢掉", () => {
    const run = normalizeRun({
      run_id: "r2",
      status: "ok",
      result: {
        run_id: "r2",
        status: "ok",
        citations: [
          { doc_id: "a", chunk: 0, quote: "q" },
          { doc_id: "", chunk: 1, quote: "空 id" },
          { doc_id: "b", chunk: "1", quote: "chunk 不是整数" },
          null,
        ],
      },
    }, "r2");
    expect(run.citations).toEqual([{ doc_id: "a", chunk: 0, quote: "q" }]);
  });

  it("error 状态把原因带到 error 字段", () => {
    const run = normalizeRun({ run_id: "r3", status: "error", error: "LLMError: 上游 500" }, "r3");
    expect(run.status).toBe("error");
    expect(run.error).toBe("LLMError: 上游 500");
  });
});