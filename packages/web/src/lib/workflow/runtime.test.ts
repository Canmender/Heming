import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { createMemoryStorage } from "../memory/storage.js";
import type { StorageLike } from "../memory/types.js";
import { createWorkflow } from "./model.js";
import type { HttpRequestOptions, WorkflowExecution } from "./types.js";
import {
  WORKFLOW_STATIC_KEY,
  WORKFLOW_VARS_KEY,
  appendQuery,
  collectOutputItems,
  createHttpRequest,
  createStaticDataProvider,
  createWorkflowRuntime,
  prepareFetchBody,
  readWorkflowVars,
  resetWorkflowStaticCache,
  setWorkflowRuntimeStorage,
  sleep,
  writeWorkflowVars,
} from "./runtime.js";

const NOW = 1_700_000_000_000;

interface FakeResponseInit {
  status?: number;
  headers?: Record<string, string>;
  body?: string;
}

/** 拼一个 fetch 能返回的最小 Response 形状（jsdom 下不必构造真 Response）。 */
function fakeResponse(init: FakeResponseInit = {}): Response {
  const body = init.body ?? "";
  const headerMap = new Map(Object.entries(init.headers ?? {}));
  return {
    status: init.status ?? 200,
    headers: {
      forEach: (callback: (value: string, key: string) => void) => {
        headerMap.forEach((value, key) => callback(value, key));
      },
    },
    text: async () => body,
    arrayBuffer: async () => new TextEncoder().encode(body).buffer,
  } as unknown as Response;
}

let mem: StorageLike;

beforeEach(() => {
  mem = createMemoryStorage();
  setWorkflowRuntimeStorage(mem);
  resetWorkflowStaticCache();
});

afterEach(() => {
  vi.unstubAllGlobals();
  delete (window as unknown as { __heming_http?: unknown }).__heming_http;
});

describe("appendQuery", () => {
  it("保留已有查询串与 hash，并按编码追加", () => {
    expect(appendQuery("https://a.com/x")).toBe("https://a.com/x");
    expect(appendQuery("https://a.com/x", { q: "中 文" })).toBe(
      "https://a.com/x?q=%E4%B8%AD+%E6%96%87",
    );
    expect(appendQuery("https://a.com/x?a=1#frag", { b: "2" })).toBe(
      "https://a.com/x?a=1&b=2#frag",
    );
  });
});

describe("prepareFetchBody", () => {
  it("json 自动补 Content-Type 并序列化", () => {
    const result = prepareFetchBody({ method: "POST", url: "x", body: { a: 1 } });
    expect(result.headers["Content-Type"]).toBe("application/json");
    expect(result.body).toBe('{"a":1}');
  });

  it("用户自带 Content-Type 时不覆盖（大小写不敏感）", () => {
    const result = prepareFetchBody({
      method: "POST",
      url: "x",
      body: "raw",
      bodyType: "text",
      headers: { "content-type": "text/plain; charset=utf-8" },
    });
    expect(result.headers["Content-Type"]).toBeUndefined();
    expect(result.body).toBe("raw");
  });

  it("form 用 URLSearchParams 编码；none 不带 body", () => {
    const form = prepareFetchBody({
      method: "POST",
      url: "x",
      body: { a: "1", b: 2 },
      bodyType: "form",
    });
    expect(form.headers["Content-Type"]).toBe("application/x-www-form-urlencoded");
    expect(form.body).toBe("a=1&b=2");
    const none = prepareFetchBody({ method: "GET", url: "x", bodyType: "none" });
    expect(none.body).toBeUndefined();
  });
});

describe("createHttpRequest", () => {
  it("桌面桥存在时优先走桥（无 CORS）", async () => {
    const request = vi.fn(async (_options: Record<string, unknown>) => ({
      ok: true,
      statusCode: 201,
      headers: { "content-type": "application/json" },
      body: { ok: true },
    }));
    (window as unknown as { __heming_http?: unknown }).__heming_http = {
      available: true,
      request,
    };
    const httpRequest = createHttpRequest();
    const response = await httpRequest({
      method: "POST",
      url: "https://example.com/api?x=1",
      body: { hello: "世界" },
    });
    expect(response.statusCode).toBe(201);
    expect(response.body).toEqual({ ok: true });
    expect(request).toHaveBeenCalledTimes(1);
    const call = request.mock.calls[0]?.[0] as Record<string, unknown>;
    expect(call.url).toBe("https://example.com/api?x=1");
    expect(call.method).toBe("POST");
  });

  it("桌面桥返回失败时抛中文错误", async () => {
    (window as unknown as { __heming_http?: unknown }).__heming_http = {
      available: true,
      request: async () => ({ ok: false, error: "主进程拒绝：域名不在白名单" }),
    };
    await expect(
      createHttpRequest()({ method: "GET", url: "https://example.com" }),
    ).rejects.toThrow("主进程拒绝：域名不在白名单");
  });

  it("无桥时走 fetch，json 响应解析成对象", async () => {
    const fetchMock = vi.fn(async () => fakeResponse({ body: '{"a":1}' }));
    vi.stubGlobal("fetch", fetchMock);
    const response = await createHttpRequest()({
      method: "GET",
      url: "https://example.com",
      headers: { "X-Test": "1" },
    });
    expect(response.statusCode).toBe(200);
    expect(response.body).toEqual({ a: 1 });
    expect(response.rawBody).toBe('{"a":1}');
    const fetchCall = fetchMock.mock.calls[0] as unknown as [string, RequestInit];
    expect(fetchCall[0]).toBe("https://example.com");
    expect(fetchCall[1].method).toBe("GET");
  });

  it("声明 json 但返回非 JSON 时回退文本", async () => {
    vi.stubGlobal("fetch", vi.fn(async () => fakeResponse({ body: "<html>出错</html>" })));
    const response = await createHttpRequest()({
      method: "GET",
      url: "https://example.com",
      responseType: "json",
    });
    expect(response.body).toBe("<html>出错</html>");
  });

  it("responseType=base64 返回 base64 字符串", async () => {
    vi.stubGlobal("fetch", vi.fn(async () => fakeResponse({ body: "hello" })));
    const response = await createHttpRequest()({
      method: "GET",
      url: "https://example.com",
      responseType: "base64",
    });
    expect(response.body).toBe(btoa("hello"));
    expect(response.size).toBe(5);
  });

  it("fetch 失败时给出「CORS 限制、桌面版可直连」的中文提示", async () => {
    vi.stubGlobal(
      "fetch",
      vi.fn(async () => {
        throw new TypeError("Failed to fetch");
      }),
    );
    await expect(
      createHttpRequest()({ method: "GET", url: "https://example.com" }),
    ).rejects.toThrow("浏览器端受 CORS 限制，桌面版可直连");
  });

  it("超时/中止给出可读错误", async () => {
    vi.stubGlobal(
      "fetch",
      vi.fn(
        (_url: string, init: RequestInit) =>
          new Promise((_resolve, reject) => {
            init.signal?.addEventListener("abort", () => {
              const error = new Error("aborted");
              error.name = "AbortError";
              reject(error);
            });
          }),
      ),
    );
    await expect(
      createHttpRequest()({ method: "GET", url: "https://example.com", timeoutMs: 5 }),
    ).rejects.toThrow("HTTP 请求超时");
  });

  it("拒绝非 http/https 地址", async () => {
    await expect(
      createHttpRequest()({ method: "GET", url: "file:///etc/passwd" }),
    ).rejects.toThrow("只支持 http/https");
  });
});

describe("sleep", () => {
  it("到点 resolve，abort 时 reject 中文错误", async () => {
    await expect(sleep(1)).resolves.toBeUndefined();
    const controller = new AbortController();
    const promise = sleep(10_000, controller.signal);
    controller.abort();
    await expect(promise).rejects.toThrow("执行已取消");
  });
});

describe("全局变量与静态数据", () => {
  it("变量读写走 64KB 键", () => {
    expect(readWorkflowVars(mem)).toEqual({});
    expect(writeWorkflowVars({ cursor: 1 }, mem)).toBe(true);
    expect(readWorkflowVars(mem)).toEqual({ cursor: 1 });
    expect(mem.getItem(WORKFLOW_VARS_KEY)).toBeTruthy();
  });

  it("静态数据可写、落盘、清缓存后仍能读回", () => {
    const provider = createStaticDataProvider();
    const globalData = provider.getWorkflowStaticData("wf-1");
    globalData.cursor = 42;
    const nodeData = provider.getNodeStaticData("wf-1", "node-1");
    nodeData.seen = ["a"];
    expect(mem.getItem(WORKFLOW_STATIC_KEY)).toContain('"cursor":42');

    resetWorkflowStaticCache();
    const again = createStaticDataProvider();
    expect(again.getWorkflowStaticData("wf-1").cursor).toBe(42);
    expect(again.getNodeStaticData("wf-1", "node-1").seen).toEqual(["a"]);
  });
});

describe("collectOutputItems", () => {
  it("取最晚跑完节点的最后一个有数据的输出口", () => {
    const execution: WorkflowExecution = {
      id: "e-1",
      workflowId: "wf-1",
      workflowName: "测试",
      mode: "subworkflow",
      status: "success",
      startedAt: NOW,
      runData: {
        a: [
          {
            startTime: NOW,
            executionTime: 10,
            executionIndex: 0,
            source: [],
            status: "success",
            data: { main: [[{ json: { from: "a" } }]] },
            itemsTotal: 1,
          },
        ],
        b: [
          {
            startTime: NOW + 100,
            executionTime: 10,
            executionIndex: 0,
            source: [],
            status: "success",
            data: { main: [[], [{ json: { from: "b" } }]] },
            itemsTotal: 1,
          },
        ],
      },
    };
    expect(collectOutputItems(execution)).toEqual([{ json: { from: "b" } }]);
  });

  it("没有 runData 时返回空数组", () => {
    expect(
      collectOutputItems({
        id: "e",
        workflowId: "wf",
        workflowName: "x",
        mode: "manual",
        status: "success",
        startedAt: NOW,
        runData: {},
      }),
    ).toEqual([]);
  });
});

describe("createWorkflowRuntime", () => {
  it("组装出全部依赖，overrides 覆盖同名依赖", () => {
    const httpRequest = vi.fn(async () => ({
      statusCode: 200,
      headers: {},
      body: null,
    }));
    const runtime = createWorkflowRuntime({ httpRequest });
    expect(runtime.deps.httpRequest).toBe(httpRequest);
    expect(typeof runtime.deps.sleep).toBe("function");
    expect(typeof runtime.deps.runUserCode).toBe("function");
    expect(typeof runtime.deps.getCredential).toBe("function");
    expect(typeof runtime.deps.executeSubWorkflow).toBe("function");
    expect(typeof runtime.deps.staticData?.getWorkflowStaticData).toBe("function");
  });

  it("子流程找不到时给中文错误", async () => {
    const runtime = createWorkflowRuntime();
    const runner = runtime.deps.executeSubWorkflow;
    if (!runner) throw new Error("缺少 executeSubWorkflow 依赖");
    await expect(
      runner({
        workflowId: "wf-missing",
        mode: "subworkflow",
        parentExecutionId: "exec-1",
        inputData: [],
      }),
    ).rejects.toThrow("找不到要执行的子工作流");
  });

  it("子流程不允许被调用时给中文错误", async () => {
    const workflow = createWorkflow({ name: "不允许被调", now: NOW });
    workflow.settings.callerPolicy = "none";
    const { useWorkflowStore } = await import("./store.js");
    useWorkflowStore.setState({ workflows: [workflow], selectedId: null });
    const runtime = createWorkflowRuntime();
    const runner = runtime.deps.executeSubWorkflow;
    if (!runner) throw new Error("缺少 executeSubWorkflow 依赖");
    await expect(
      runner({
        workflowId: workflow.id,
        mode: "subworkflow",
        parentExecutionId: "exec-1",
        inputData: [],
      }),
    ).rejects.toThrow("不允许被其它工作流调用");
  });
});

describe("HTTP 参数类型", () => {
  it("options 里 query/body 形状与引擎契约一致", () => {
    const options: HttpRequestOptions = {
      method: "POST",
      url: "https://x",
      query: { a: "1" },
      headers: {},
      body: { x: 1 },
      bodyType: "json",
      timeoutMs: 1000,
      followRedirects: false,
      responseType: "json",
    };
    expect(prepareFetchBody(options).body).toBe('{"x":1}');
  });
});
