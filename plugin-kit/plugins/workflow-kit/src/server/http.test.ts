/**
 * HTTP REST 层测试：起真实临时端口，用 fetch 走完整传输链路。
 *
 * 覆盖：健康检查 / CORS 预检 / 节点与模板 / 工作流 CRUD / 导入导出 /
 * 执行启动与轮询 / 执行记录 / 凭据 / 设置 / 通知 / 静态页与路径穿越 / 请求体上限。
 *
 * 说明：这里用「假 Runtime」而不是真引擎——本文件验的是 HTTP 契约（形状/状态码/
 * 轮询/落库时机），引擎语义由 src/engine 的测试负责。真 Runtime 的联调在
 * `pnpm test` 全量门禁里由 main 装配覆盖。
 */

import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { AddressInfo } from "node:net";
import { afterAll, beforeAll, beforeEach, describe, expect, it } from "vitest";
import type { Workflow, WorkflowExecution } from "../types.js";
import type { WorkflowConfig } from "./config.js";
import { createHttpServer } from "./http.js";
import { createRuntime } from "./runtime.js";
import { createStore, type Store } from "./storage.js";
import { registerCoreNodes } from "../nodes/core/index.js";
import { getNodeType, registerNodeType } from "../registry.js";

// ---------------------------------------------------------------------------
// 测试夹具：临时目录 + 真实 Store + 假 Runtime
// ---------------------------------------------------------------------------

let rootDir = "";
let dataDir = "";
let store: Store;
let server: ReturnType<typeof createHttpServer>;
let base = "";

const runtimeState = {
  stopped: 0,
  failNext: false,
  seq: 0,
  running: new Set<string>(),
  live: new Map<string, WorkflowExecution>(),
  lastOptions: null as null | { mode?: string; startNodeId?: string; inputData?: unknown },
};

const fakeRuntime = {
  async runWorkflow(
    workflow: Workflow,
    options: {
      mode?: WorkflowExecution["mode"];
      startNodeId?: string;
      inputData?: unknown;
      onEvent?: (event: { type: string; execution?: WorkflowExecution }) => void;
    } = {},
  ): Promise<WorkflowExecution> {
    runtimeState.lastOptions = {
      ...(options.mode ? { mode: options.mode } : {}),
      ...(options.startNodeId ? { startNodeId: options.startNodeId } : {}),
      ...(options.inputData !== undefined ? { inputData: options.inputData } : {}),
    };
    if (runtimeState.failNext) {
      runtimeState.failNext = false;
      throw new Error(`工作流「${workflow.name}」正在运行，等它结束再试`);
    }
    const executionId = `exec-test-${++runtimeState.seq}`;
    const execution: WorkflowExecution = {
      id: executionId,
      workflowId: workflow.id,
      workflowName: workflow.name,
      mode: options.mode ?? "manual",
      status: "running",
      startedAt: Date.now(),
      runData: {},
    };
    runtimeState.running.add(workflow.id);
    runtimeState.live.set(executionId, execution);
    options.onEvent?.({ type: "executionStart", execution });

    await delay(10);

    const firstNodeId = workflow.nodes[0]?.id ?? "node-placeholder";
    execution.runData = {
      [firstNodeId]: [
        {
          startTime: execution.startedAt,
          executionTime: 3,
          executionIndex: 0,
          source: [],
          status: "success",
          data: { main: [[{ json: { ok: true } }]] },
          itemsTotal: 1,
        },
      ],
    };
    execution.status = "success";
    execution.finishedAt = Date.now();
    execution.durationMs = 3;
    execution.triggerData = [{ json: { started: true } }];
    options.onEvent?.({ type: "executionFinish", execution });
    runtimeState.running.delete(workflow.id);
    return execution;
  },
  getLiveExecution: (id: string) => runtimeState.live.get(id),
  isRunning: (workflowId: string) => runtimeState.running.has(workflowId),
  stop: () => {
    runtimeState.stopped += 1;
    return true;
  },
};

function delay(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

/** 注册核心节点 + 集成节点的「桩」：模板/节点清单接口需要它们，但不依赖真实现。 */
function registerTestNodes(): void {
  registerCoreNodes();
  const stubTypes = [
    "notification",
    "llm",
    "mcpTool",
    "infohubAgenda",
    "infohubSearch",
    "infohubSync",
    "dateTime",
    "crypto",
    "xml",
  ];
  for (const type of stubTypes) {
    if (getNodeType(type)) continue;
    registerNodeType({
      description: {
        type,
        displayName: `测试桩 ${type}`,
        group: "output",
        description: "测试桩节点",
        icon: "test",
        inputs: 1,
        outputs: 1,
        properties: [],
        version: 1,
      },
      execute: async () => [],
    });
  }
}

function resetState(): void {
  for (const workflow of store.listWorkflows()) store.removeWorkflow(workflow.id);
  store.clearExecutions();
  for (const credential of store.listCredentials()) store.removeCredential(credential.id);
  runtimeState.stopped = 0;
  runtimeState.failNext = false;
  runtimeState.lastOptions = null;
  runtimeState.seq = 0;
  runtimeState.running.clear();
  runtimeState.live.clear();
}

interface ApiResult {
  status: number;
  headers: Headers;
  body: any;
}

async function api(path: string, init: RequestInit = {}): Promise<ApiResult> {
  const response = await fetch(`${base}${path}`, init);
  const text = await response.text();
  let body: any = text;
  try {
    body = text ? JSON.parse(text) : null;
  } catch {
    /* 保留文本（静态页/错误页） */
  }
  return { status: response.status, headers: response.headers, body };
}

function jsonInit(method: string, value?: unknown): RequestInit {
  return {
    method,
    headers: { "content-type": "application/json" },
    ...(value === undefined ? {} : { body: JSON.stringify(value) }),
  };
}

async function waitForExecution(executionId: string, expected = "success"): Promise<any> {
  const deadline = Date.now() + 3000;
  while (Date.now() < deadline) {
    const detail = await api(`/api/executions/${executionId}`);
    if (detail.body?.status === expected) return detail.body;
    await delay(15);
  }
  throw new Error(`执行 ${executionId} 未在 3 秒内到达状态 ${expected}`);
}

async function createWorkflowThroughApi(name = "测试流程"): Promise<any> {
  const created = await api("/api/workflows", jsonInit("POST", { name }));
  expect(created.status).toBe(200);
  return created.body;
}

function makeConfig(): WorkflowConfig {
  return {
    host: "127.0.0.1",
    port: 0,
    dataDir,
    rootDir,
    maxExecutionMs: 60_000,
  };
}

beforeAll(async () => {
  rootDir = mkdtempSync(join(tmpdir(), "wf-http-test-"));
  dataDir = join(rootDir, "data");
  mkdirSync(join(rootDir, "public"), { recursive: true });
  writeFileSync(
    join(rootDir, "public", "index.html"),
    '<!doctype html><html><body><h1 id="app">编辑器首页</h1><script src="/static/app.js"></script></body></html>',
    "utf8",
  );
  writeFileSync(join(rootDir, "public", "app.js"), "window.__WF_TEST__ = true;\n", "utf8");
  writeFileSync(join(rootDir, "public", "style.css"), "body { color: #111; }\n", "utf8");
  writeFileSync(join(rootDir, "secret.txt"), "TOP-SECRET-DO-NOT-LEAK", "utf8");

  registerTestNodes();
  store = createStore(dataDir);
  const config = makeConfig();
  server = createHttpServer({
    store,
    runtime: fakeRuntime as never,
    scheduler: { running: true, status: () => ({ running: true }) },
    config,
    version: "test-0.1.0",
  });
  await new Promise<void>((resolve) => {
    server.listen(0, "127.0.0.1", () => resolve());
  });
  const address = server.address() as AddressInfo;
  base = `http://127.0.0.1:${address.port}`;
});

beforeEach(() => {
  resetState();
});

afterAll(async () => {
  await new Promise<void>((resolve) => {
    server.close(() => resolve());
  });
  rmSync(rootDir, { recursive: true, force: true });
});

// ---------------------------------------------------------------------------
// 健康检查 / CORS / 元数据
// ---------------------------------------------------------------------------

describe("健康检查与元数据", () => {
  it("GET /api/health 返回版本、运行时长与调度器状态", async () => {
    const result = await api("/api/health");
    expect(result.status).toBe(200);
    expect(result.body.ok).toBe(true);
    expect(result.body.version).toBe("test-0.1.0");
    expect(typeof result.body.uptimeMs).toBe("number");
    expect(result.body.scheduler).toEqual({ running: true });
  });

  it("OPTIONS 预检返回 204 与完整 CORS 头（含 mcp-session-id）", async () => {
    const result = await api("/api/workflows", { method: "OPTIONS" });
    expect(result.status).toBe(204);
    expect(result.headers.get("access-control-allow-origin")).toBe("*");
    expect(result.headers.get("access-control-allow-methods")).toContain("DELETE");
    const allowedHeaders = result.headers.get("access-control-allow-headers") ?? "";
    expect(allowedHeaders).toContain("content-type");
    expect(allowedHeaders).toContain("mcp-session-id");
  });

  it("普通响应也带 CORS 头", async () => {
    const result = await api("/api/health");
    expect(result.headers.get("access-control-allow-origin")).toBe("*");
  });

  it("GET /api/node-types 返回节点描述数组", async () => {
    const result = await api("/api/node-types");
    expect(result.status).toBe(200);
    expect(Array.isArray(result.body)).toBe(true);
    const manual = result.body.find((item: any) => item.type === "manualTrigger");
    expect(manual).toBeTruthy();
    expect(manual.displayName).toBeTruthy();
    expect(Array.isArray(manual.properties)).toBe(true);
    expect(result.body.some((item: any) => item.type === "notification")).toBe(true);
  });

  it("GET /api/templates 只返回模板元数据（不回工作流 JSON）", async () => {
    const result = await api("/api/templates");
    expect(result.status).toBe(200);
    expect(result.body.length).toBeGreaterThanOrEqual(3);
    for (const template of result.body) {
      expect(typeof template.id).toBe("string");
      expect(typeof template.name).toBe("string");
      expect(typeof template.description).toBe("string");
      expect(template.workflow).toBeUndefined();
    }
  });

  it("未知 /api 路径返回 404 与 {ok:false,error}", async () => {
    const result = await api("/api/nope");
    expect(result.status).toBe(404);
    expect(result.body.ok).toBe(false);
    expect(typeof result.body.error).toBe("string");
  });
});

// ---------------------------------------------------------------------------
// 工作流 CRUD / 模板 / 导入导出
// ---------------------------------------------------------------------------

describe("工作流 CRUD", () => {
  it("从空白创建、列表摘要、读取、更新、删除", async () => {
    const created = await createWorkflowThroughApi("空白流程");
    expect(created.id).toBeTruthy();
    expect(created.name).toBe("空白流程");

    const list = await api("/api/workflows");
    expect(list.status).toBe(200);
    expect(list.body).toHaveLength(1);
    expect(list.body[0]).toMatchObject({
      id: created.id,
      name: "空白流程",
      active: false,
      nodeCount: 0,
      triggerCount: 0,
    });

    const detail = await api(`/api/workflows/${created.id}`);
    expect(detail.status).toBe(200);
    expect(detail.body.id).toBe(created.id);

    const updatedPayload = {
      ...created,
      name: "改名后的流程",
      nodes: [
        {
          id: "n1",
          name: "手动触发",
          type: "manualTrigger",
          position: { x: 80, y: 80 },
          parameters: {},
        },
      ],
    };
    const updated = await api(`/api/workflows/${created.id}`, jsonInit("PUT", updatedPayload));
    expect(updated.status).toBe(200);
    expect(updated.body.ok).toBe(true);
    expect(updated.body.workflow.name).toBe("改名后的流程");
    expect(updated.body.workflow.nodes).toHaveLength(1);
    expect(Array.isArray(updated.body.issues)).toBe(true);

    const deleted = await api(`/api/workflows/${created.id}`, { method: "DELETE" });
    expect(deleted.status).toBe(200);
    expect(deleted.body.ok).toBe(true);
    expect((await api(`/api/workflows/${created.id}`)).status).toBe(404);
  });

  it("GET/PUT/DELETE 不存在的工作流都返回 404", async () => {
    expect((await api("/api/workflows/not-exist")).status).toBe(404);
    expect((await api("/api/workflows/not-exist", jsonInit("PUT", {}))).status).toBe(404);
    expect((await api("/api/workflows/not-exist", { method: "DELETE" })).status).toBe(404);
  });

  it("启用/停用与复制", async () => {
    const created = await createWorkflowThroughApi("可复制流程");

    const activated = await api(`/api/workflows/${created.id}/active`, jsonInit("POST", { active: true }));
    expect(activated.status).toBe(200);
    expect(activated.body.workflow.active).toBe(true);

    const duplicates = await api(`/api/workflows/${created.id}/duplicate`, jsonInit("POST", {}));
    expect(duplicates.status).toBe(200);
    expect(duplicates.body.id).not.toBe(created.id);
    expect(duplicates.body.name).toBe("可复制流程 副本");

    const badActive = await api(`/api/workflows/${created.id}/active`, jsonInit("POST", { active: "yes" }));
    expect(badActive.status).toBe(400);
  });

  it("从模板创建工作流", async () => {
    const templates = await api("/api/templates");
    const templateId = templates.body[0].id;
    const created = await api("/api/workflows", jsonInit("POST", { fromTemplateId: templateId }));
    expect(created.status).toBe(200);
    expect(created.body.nodes.length).toBeGreaterThan(0);

    const unknownTemplate = await api("/api/workflows", jsonInit("POST", { fromTemplateId: "nope" }));
    expect(unknownTemplate.status).toBe(400);
  });

  it("导出为 n8n 形状后能重新导入（连接按节点名）", async () => {
    const imported = await api(
      "/api/workflows/import",
      jsonInit("POST", {
        json: {
          name: "导入样本",
          nodes: [
            { id: "a", name: "开始", type: "n8n-nodes-base.manualTrigger", position: { x: 0, y: 0 }, parameters: {} },
            {
              id: "b",
              name: "请求",
              type: "n8n-nodes-base.httpRequest",
              position: { x: 200, y: 0 },
              parameters: { url: "https://example.com" },
            },
          ],
          connections: { 开始: { main: [[{ node: "请求", type: "main", index: 0 }]] } },
        },
      }),
    );
    expect(imported.status).toBe(200);
    expect(imported.body.ok).toBe(true);
    expect(imported.body.workflow.nodes).toHaveLength(2);
    expect(imported.body.workflow.nodes.map((node: any) => node.type)).toEqual(["manualTrigger", "httpRequest"]);
    expect(imported.body.warnings).toEqual([]);

    const exported = await api(`/api/workflows/${imported.body.workflow.id}/export`);
    expect(exported.status).toBe(200);
    expect(exported.body.nodes).toHaveLength(2);
    expect(exported.body.connections["开始"].main[0][0].node).toBe("请求");
    expect(exported.body.settings.timezone).toBe("local");

    const reimported = await api("/api/workflows/import", jsonInit("POST", { json: exported.body }));
    expect(reimported.status).toBe(200);
    expect(reimported.body.workflow.id).not.toBe(imported.body.workflow.id);
    expect(reimported.body.workflow.nodes).toHaveLength(2);
  });

  it("导入未知节点类型时保留节点并给出 warning", async () => {
    const result = await api(
      "/api/workflows/import",
      jsonInit("POST", {
        json: {
          name: "含未知节点",
          nodes: [
            {
              id: "x",
              name: "未知",
              type: "n8n-nodes-base.someUnknownNode",
              position: { x: 0, y: 0 },
              parameters: {},
            },
          ],
          connections: {},
        },
      }),
    );
    expect(result.status).toBe(200);
    expect(result.body.workflow.nodes[0].type).toBe("someUnknownNode");
    expect(result.body.warnings.length).toBe(1);
    expect(result.body.warnings[0]).toContain("someUnknownNode");
  });

  it("非法 JSON body 返回 400", async () => {
    const response = await fetch(`${base}/api/workflows`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: "{not-json",
    });
    expect(response.status).toBe(400);
    const body = (await response.json()) as any;
    expect(body.ok).toBe(false);
    expect(body.error).toContain("JSON");
  });

  it("超过 5MB 的 JSON body 返回 413", async () => {
    const huge = JSON.stringify({ json: "x".repeat(6 * 1024 * 1024) });
    const response = await fetch(`${base}/api/workflows`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: huge,
    });
    expect(response.status).toBe(413);
    const body = (await response.json()) as any;
    expect(body.ok).toBe(false);
    expect(body.error).toContain("5MB");
  });
});

// ---------------------------------------------------------------------------
// 执行：启动 / 轮询 / 记录 / 停止 / 重跑
// ---------------------------------------------------------------------------

describe("执行", () => {
  it("POST run 立即返回 executionId，轮询到 success 后详情含 runData", async () => {
    const workflow = await createWorkflowThroughApi("跑一次的流程");
    const started = await api(`/api/workflows/${workflow.id}/run`, jsonInit("POST", {}));
    expect(started.status).toBe(200);
    expect(started.body.ok).toBe(true);
    expect(typeof started.body.executionId).toBe("string");

    const detail = await waitForExecution(started.body.executionId);
    expect(detail.workflowId).toBe(workflow.id);
    expect(Object.keys(detail.runData).length).toBeGreaterThan(0);

    // 列表接口不含 runData；执行记录已自动落库。
    const list = await api("/api/executions");
    expect(list.status).toBe(200);
    expect(list.body).toHaveLength(1);
    expect(list.body[0]).not.toHaveProperty("runData");
    expect(list.body[0].status).toBe("success");
  });

  it("执行详情优先返回 Runtime 内存里的进行中执行", async () => {
    const workflow = await createWorkflowThroughApi("内存态优先");
    const started = await api(`/api/workflows/${workflow.id}/run`, jsonInit("POST", {}));
    await waitForExecution(started.body.executionId);

    // 模拟「已落库的记录是旧状态，内存里的实时态更新」：详情应返回内存里的。
    const live = runtimeState.live.get(started.body.executionId);
    expect(live).toBeTruthy();
    live!.status = "running";
    const detail = await api(`/api/executions/${started.body.executionId}`);
    expect(detail.body.status).toBe("running");
  });

  it("执行结束后列表摘要带 lastStatus（lastRunAt 由调度器维护，手动运行不改）", async () => {
    const workflow = await createWorkflowThroughApi("摘要状态");
    const started = await api(`/api/workflows/${workflow.id}/run`, jsonInit("POST", {}));
    await waitForExecution(started.body.executionId);

    const list = await api("/api/workflows");
    const item = list.body.find((entry: any) => entry.id === workflow.id);
    expect(item.lastStatus).toBe("success");
    // 手动运行不能写 lastRunAt：调度器以它为下次触发基准，写了会顺延定时计划。
    expect(item.lastRunAt).toBeUndefined();
  });

  it("工作流正在运行时再次 run 返回 409", async () => {
    const workflow = await createWorkflowThroughApi("并发限制");
    runtimeState.failNext = true;
    const started = await api(`/api/workflows/${workflow.id}/run`, jsonInit("POST", {}));
    expect(started.status).toBe(409);
    expect(started.body.ok).toBe(false);
    expect(started.body.error).toContain("正在运行");
  });

  it("POST stop 调用 runtime.stop 并返回是否真的停下", async () => {
    const workflow = await createWorkflowThroughApi("可停止");
    const stopped = await api(`/api/workflows/${workflow.id}/stop`, jsonInit("POST", {}));
    expect(stopped.status).toBe(200);
    expect(stopped.body).toEqual({ ok: true, stopped: true });
    expect(runtimeState.stopped).toBe(1);
  });

  it("按事件重跑并删除执行记录", async () => {
    const workflow = await createWorkflowThroughApi("可重跑");
    const first = await api(`/api/workflows/${workflow.id}/run`, jsonInit("POST", {}));
    await waitForExecution(first.body.executionId);

    const retried = await api(`/api/executions/${first.body.executionId}/retry`, jsonInit("POST", {}));
    expect(retried.status).toBe(200);
    expect(retried.body.ok).toBe(true);
    expect(retried.body.executionId).not.toBe(first.body.executionId);
    await waitForExecution(retried.body.executionId);

    expect((await api(`/api/executions/${first.body.executionId}`, { method: "DELETE" })).status).toBe(200);
    // 真实 Runtime 会把刚结束的执行留在内存 30 秒；详情接口按契约优先读内存态，
    // 所以测试里先清掉内存态再断言「已删除」。
    runtimeState.live.delete(first.body.executionId);
    expect((await api(`/api/executions/${first.body.executionId}`)).status).toBe(404);
  });

  it("按 workflowId 过滤执行记录", async () => {
    const a = await createWorkflowThroughApi("A");
    const b = await createWorkflowThroughApi("B");
    const runA = await api(`/api/workflows/${a.id}/run`, jsonInit("POST", {}));
    await waitForExecution(runA.body.executionId);
    const runB = await api(`/api/workflows/${b.id}/run`, jsonInit("POST", {}));
    await waitForExecution(runB.body.executionId);

    const filtered = await api(`/api/executions?workflowId=${a.id}&limit=10`);
    expect(filtered.status).toBe(200);
    expect(filtered.body).toHaveLength(1);
    expect(filtered.body[0].workflowId).toBe(a.id);
  });
});

// ---------------------------------------------------------------------------
// 凭据 / 设置 / 通知
// ---------------------------------------------------------------------------

describe("凭据与设置", () => {
  it("凭据 CRUD：保存后列表不回密钥值，改名不清空密钥", async () => {
    const created = await api(
      "/api/credentials",
      jsonInit("POST", { name: "我的Token", type: "bearerToken", data: { token: "tok-123" } }),
    );
    expect(created.status).toBe(200);
    expect(created.body).toMatchObject({ name: "我的Token", type: "bearerToken" });
    expect(created.body.id).toBeTruthy();
    expect(JSON.stringify(created.body)).not.toContain("tok-123");

    const list = await api("/api/credentials");
    expect(list.body).toHaveLength(1);
    expect(list.body[0]).toMatchObject({ id: created.body.id, name: "我的Token", type: "bearerToken" });

    const renamed = await api(`/api/credentials/${created.body.id}`, jsonInit("PUT", { name: "改名Token" }));
    expect(renamed.status).toBe(200);
    expect(renamed.body.name).toBe("改名Token");
    // 改名后旧记录被移除，列表只剩一条。
    expect((await api("/api/credentials")).body).toHaveLength(1);

    const secret = await store.getCredentialData("bearerToken", renamed.body.id);
    expect(secret).toEqual({ token: "tok-123" });

    expect((await api(`/api/credentials/${renamed.body.id}`, { method: "DELETE" })).status).toBe(200);
    expect((await api("/api/credentials")).body).toHaveLength(0);
  });

  it("非法凭据类型/缺字段返回 400 中文错误", async () => {
    const badType = await api(
      "/api/credentials",
      jsonInit("POST", { name: "坏类型", type: "nope", data: {} }),
    );
    expect(badType.status).toBe(400);
    expect(badType.body.ok).toBe(false);

    const missing = await api(
      "/api/credentials",
      jsonInit("POST", { name: "缺字段", type: "httpBasic", data: { username: "u" } }),
    );
    expect(missing.status).toBe(400);
    expect(missing.body.error).toContain("密码");
  });

  it("设置读写：返回模型连接状态但绝不回 apiKey", async () => {
    const initial = await api("/api/settings");
    expect(initial.status).toBe(200);
    expect(initial.body.vars).toEqual({});

    const saved = await api(
      "/api/settings",
      jsonInit("PUT", {
        vars: { city: "上海" },
        llm: { baseUrl: "https://api.example.com/v1", apiKey: "secret-key-123", model: "demo-model" },
      }),
    );
    expect(saved.status).toBe(200);
    expect(saved.body.vars).toEqual({ city: "上海" });
    expect(saved.body.llm).toEqual({
      configured: true,
      baseUrl: "https://api.example.com/v1",
      model: "demo-model",
    });
    expect(JSON.stringify(saved.body)).not.toContain("secret-key-123");

    const readBack = await api("/api/settings");
    expect(readBack.body.vars).toEqual({ city: "上海" });
  });

  it("GET /api/notifications 返回最近通知", async () => {
    store.addNotification({ title: "测试通知", body: "内容", workflowId: "wf-x" });
    const result = await api("/api/notifications");
    expect(result.status).toBe(200);
    expect(result.body[0].title).toBe("测试通知");
    expect(result.body[0].workflowId).toBe("wf-x");
  });
});

// ---------------------------------------------------------------------------
// 真实 Runtime 联调（端到端）
// ---------------------------------------------------------------------------

describe("真实 Runtime 联调", () => {
  it("手动触发 → Set：REST 启动异步执行并能轮询到真实节点输出", async () => {
    const realRuntime = createRuntime(store, makeConfig());
    const realServer = createHttpServer({
      store,
      runtime: realRuntime,
      scheduler: { running: false },
      config: makeConfig(),
      version: "test-real",
    });
    await new Promise<void>((resolve) => {
      realServer.listen(0, "127.0.0.1", () => resolve());
    });
    const realBase = `http://127.0.0.1:${(realServer.address() as AddressInfo).port}`;
    try {
      const importedResponse = await fetch(`${realBase}/api/workflows/import`, {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({
          json: {
            name: "真实执行",
            nodes: [
              { id: "n1", name: "手动触发", type: "manualTrigger", position: { x: 80, y: 80 }, parameters: {} },
              {
                id: "n2",
                name: "整理",
                type: "set",
                position: { x: 300, y: 80 },
                parameters: { mode: "manual", fields: [{ name: "hello", value: "world" }] },
              },
            ],
            connections: { n1: { main: [[{ node: "n2", type: "main", index: 0 }]] } },
          },
        }),
      });
      expect(importedResponse.status).toBe(200);
      const imported = (await importedResponse.json()) as any;

      const runResponse = await fetch(`${realBase}/api/workflows/${imported.workflow.id}/run`, {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: "{}",
      });
      expect(runResponse.status).toBe(200);
      const run = (await runResponse.json()) as any;
      expect(typeof run.executionId).toBe("string");

      const deadline = Date.now() + 5000;
      let detail: any = null;
      while (Date.now() < deadline) {
        const response = await fetch(`${realBase}/api/executions/${run.executionId}`);
        if (response.status === 200) {
          detail = await response.json();
          if (detail.status === "success" || detail.status === "error") break;
        }
        await delay(20);
      }

      expect(detail?.status).toBe("success");
      expect(detail.workflowId).toBe(imported.workflow.id);
      const setRuns = detail.runData["n2"] as any[] | undefined;
      expect(setRuns && setRuns.length).toBeGreaterThan(0);
      expect(setRuns?.[0]?.data?.main?.[0]?.[0]?.json?.hello).toBe("world");
    } finally {
      await new Promise<void>((resolve) => {
        realServer.close(() => resolve());
      });
    }
  });
});

// ---------------------------------------------------------------------------
// 静态文件与安全
// ---------------------------------------------------------------------------

describe("静态文件与路径穿越", () => {
  it("GET / 返回 index.html，/static/* 返回对应资源", async () => {
    const index = await api("/");
    expect(index.status).toBe(200);
    expect(index.headers.get("content-type")).toContain("text/html");
    expect(index.body).toContain("编辑器首页");

    const script = await api("/static/app.js");
    expect(script.status).toBe(200);
    expect(script.headers.get("content-type")).toContain("javascript");
    expect(script.body).toContain("__WF_TEST__");

    const css = await api("/static/style.css");
    expect(css.status).toBe(200);
    expect(css.headers.get("content-type")).toContain("text/css");
  });

  it("前端路由回落到 index.html；/static/ 缺文件则 404", async () => {
    const spa = await api("/workflows/123/edit");
    expect(spa.status).toBe(200);
    expect(spa.body).toContain("编辑器首页");

    const missing = await api("/static/missing.js");
    expect(missing.status).toBe(404);
    expect(missing.body.ok).toBe(false);
  });

  it("编码的路径穿越拿不到 public 之外的文件", async () => {
    const response = await fetch(`${base}/static/%2e%2e/%2e%2e/secret.txt`);
    const text = await response.text();
    expect(text).not.toContain("TOP-SECRET-DO-NOT-LEAK");
    expect([200, 404]).toContain(response.status);
    if (response.status === 200) expect(text).toContain("编辑器首页");
  });

  it("MCP 接口非 POST 返回 405", async () => {
    const result = await api("/mcp");
    expect(result.status).toBe(405);
    expect(result.body.ok).toBe(false);
  });
});

describe("CORS 来源白名单（自检修复）", () => {
  it("陌生网页来源返回 403 且不回 CORS 头", async () => {
    const result = await api("/api/health", { headers: { origin: "https://evil.example" } });
    expect(result.status).toBe(403);
    expect(result.headers.get("access-control-allow-origin")).toBeNull();
  });

  it("和鸣客户端来源 app://heming 回显 Origin", async () => {
    const result = await api("/api/health", { headers: { origin: "app://heming" } });
    expect(result.status).toBe(200);
    expect(result.headers.get("access-control-allow-origin")).toBe("app://heming");
    expect(result.headers.get("vary")).toBe("Origin");
  });

  it("本机 localhost 来源放行", async () => {
    const result = await api("/api/health", { headers: { origin: "http://localhost:5173" } });
    expect(result.status).toBe(200);
    expect(result.headers.get("access-control-allow-origin")).toBe("http://localhost:5173");
  });

  it("陌生来源的预检直接 403（不进入 OPTIONS 204 分支）", async () => {
    const result = await api("/api/workflows", {
      method: "OPTIONS",
      headers: { origin: "https://evil.example", "access-control-request-method": "POST" },
    });
    expect(result.status).toBe(403);
    expect(result.headers.get("access-control-allow-origin")).toBeNull();
  });
});

describe("P0：节点详情 / 试跑 / MCP 发现（REST）", () => {
  it("GET /api/node-types/:type 返回完整 schema，未知类型 404", async () => {
    const detail = await api("/api/node-types/httpRequest");
    expect(detail.status).toBe(200);
    expect(detail.body.type).toBe("httpRequest");
    const url = (detail.body.properties as Array<Record<string, any>>).find((item) => item.name === "url");
    expect(url?.required).toBe(true);
    const missing = await api("/api/node-types/noSuchType");
    expect(missing.status).toBe(404);
  });

  it("POST /api/workflows/:id/test 用 pinData 试跑", async () => {
    const created = await createWorkflowThroughApi("REST 试跑");
    const workflow = {
      ...created,
      nodes: [
        { id: "t1", name: "手动触发", type: "manualTrigger", position: { x: 0, y: 0 }, parameters: {} },
        { id: "s1", name: "设置字段", type: "set", position: { x: 200, y: 0 }, parameters: {} },
      ],
      connections: { t1: { main: [[{ node: "s1", type: "main", index: 0 }]] } },
    };
    const saved = await api(`/api/workflows/${created.id}`, jsonInit("PUT", workflow));
    expect(saved.status).toBe(200);

    const tested = await api(
      `/api/workflows/${created.id}/test`,
      jsonInit("POST", { pinData: { t1: [{ json: { seed: 1 } }] }, timeoutMs: 3000 }),
    );
    expect(tested.status).toBe(200);
    expect(tested.body.ok).toBe(true);
    expect(tested.body.status).toBe("success");
    expect(tested.body.pinnedNodeIds).toContain("t1");

    // pinData 不应写回存储
    const stored = await api(`/api/workflows/${created.id}`);
    const trigger = (stored.body.nodes as Array<Record<string, any>>).find((node) => node.id === "t1");
    expect(trigger?.pinData).toBeUndefined();
  });

  it("POST /api/mcp/discover 能列出本服务工具", async () => {
    const result = await api("/api/mcp/discover", jsonInit("POST", { url: `${base}/mcp` }));
    expect(result.status).toBe(200);
    expect(result.body.total).toBe(26);
    const names = (result.body.tools as Array<{ name: string }>).map((item) => item.name);
    expect(names).toContain("credential_list");
    expect(names).toContain("workflow_test");
  });

  it("非 http(s) 地址的 MCP 发现被拒绝", async () => {
    const result = await api("/api/mcp/discover", jsonInit("POST", { url: "file:///etc/passwd" }));
    expect(result.status).toBe(400);
  });
});

describe("P1 REST：搜索 / 版本历史 / 恢复", () => {
  it("GET /api/workflows?query=&tag= 过滤", async () => {
    const created = await createWorkflowThroughApi("发票汇总");
    const workflow = { ...created, tags: ["财务"] };
    await api(`/api/workflows/${created.id}`, jsonInit("PUT", workflow));
    await createWorkflowThroughApi("每日提醒");

    const byQuery = await api("/api/workflows?query=%E5%8F%91%E7%A5%A8");
    expect(byQuery.status).toBe(200);
    expect((byQuery.body.workflows as Array<{ id: string }>).map((item) => item.id)).toEqual([created.id]);

    const byTag = await api("/api/workflows?tag=%E8%B4%A2%E5%8A%A1");
    expect((byTag.body.workflows as Array<{ id: string }>).map((item) => item.id)).toEqual([created.id]);
  });

  it("GET 版本列表 / 版本详情，POST 恢复", async () => {
    const created = await createWorkflowThroughApi("版本甲");
    const workflow = {
      ...created,
      nodes: [
        { id: "t1", name: "手动触发", type: "manualTrigger", position: { x: 0, y: 0 }, parameters: {} },
      ],
      connections: {},
    };
    await api(`/api/workflows/${created.id}`, jsonInit("PUT", workflow));
    const second = { ...workflow, name: "版本乙" };
    await api(`/api/workflows/${created.id}`, jsonInit("PUT", second));

    const versions = await api(`/api/workflows/${created.id}/versions`);
    expect(versions.status).toBe(200);
    expect(versions.body.total).toBeGreaterThanOrEqual(1);
    const versionId = versions.body.versions[0].versionId as string;

    const detail = await api(`/api/workflows/${created.id}/versions/${versionId}`);
    expect(detail.status).toBe(200);
    expect(detail.body.workflow).toBeTruthy();

    const restored = await api(`/api/workflows/${created.id}/restore`, jsonInit("POST", { versionId }));
    expect(restored.status).toBe(200);
    expect(restored.body.ok).toBe(true);
    const current = await api(`/api/workflows/${created.id}`);
    expect(current.body.name).toBe("版本甲");
  });

  it("恢复不存在的版本返回 404", async () => {
    const created = await createWorkflowThroughApi("无版本");
    const result = await api(`/api/workflows/${created.id}/restore`, jsonInit("POST", { versionId: "nope" }));
    expect(result.status).toBe(404);
  });
});

describe("AI Builder（REST）", () => {
  it("配置模型后生成工作流；默认不保存", async () => {
    const llmWorkflow = {
      name: "REST AI 生成",
      nodes: [
        { id: "n1", name: "手动触发", type: "manualTrigger", position: { x: 0, y: 0 }, parameters: {} },
        {
          id: "n2",
          name: "设置字段",
          type: "set",
          position: { x: 240, y: 0 },
          parameters: { mode: "manual", fields: [{ name: "ok", value: true }], includeOtherFields: true },
        },
      ],
      connections: { n1: { main: [[{ node: "n2", type: "main", index: 0 }]] } },
      settings: {
        timezone: "local",
        saveDataSuccessExecution: "all",
        saveDataErrorExecution: "all",
        saveManualExecutions: true,
        callerPolicy: "any",
      },
      active: false,
    };
    const settings = await api("/api/settings", jsonInit("PUT", {
      llm: { baseUrl: "https://llm.example/v1", apiKey: "k", model: "test-model" },
    }));
    expect(settings.status).toBe(200);
    expect(process.env.WF_LLM_MODEL).toBe("test-model");

    const originalFetch = globalThis.fetch;
    (globalThis as { fetch: typeof fetch }).fetch = (async (input: RequestInfo | URL, init?: RequestInit) => {
      const url = String(input instanceof Request ? input.url : input);
      if (!url.includes("llm.example")) return originalFetch(input, init);
      return new Response(
        JSON.stringify({ choices: [{ message: { content: JSON.stringify({ plan: ["测试"], workflow: llmWorkflow }) } }] }),
        { status: 200, headers: { "content-type": "application/json" } },
      );
    }) as typeof fetch;
    try {
      const generated = await api("/api/ai/workflow", jsonInit("POST", { request: "手动触发后设置字段" }));
      expect(generated.status).toBe(200);
      expect(generated.body.saved, JSON.stringify(generated.body)).toBe(false);
      expect(generated.body.workflow.nodes).toHaveLength(2);
      const list = await api("/api/workflows?query=REST%20AI");
      expect((list.body.workflows as unknown[]).length).toBe(0);
    } finally {
      (globalThis as { fetch: typeof fetch }).fetch = originalFetch;
      await api("/api/settings", jsonInit("PUT", { llm: null }));
      delete process.env.WF_LLM_BASE_URL;
      delete process.env.WF_LLM_API_KEY;
      delete process.env.WF_LLM_MODEL;
    }
  });
});

describe("Webhook 触发器", () => {
  async function createWebhookWorkflow(token = ""): Promise<any> {
    const created = await createWorkflowThroughApi("Webhook 流程");
    const workflow = {
      ...created,
      active: false,
      nodes: [
        {
          id: "wh1",
          name: "Webhook 触发",
          type: "webhookTrigger",
          position: { x: 0, y: 0 },
          parameters: { path: "", method: "POST", ...(token ? { authToken: token } : {}) },
        },
        {
          id: "s1",
          name: "设置字段",
          type: "set",
          position: { x: 240, y: 0 },
          parameters: { mode: "manual", fields: [{ name: "ok", value: true }], includeOtherFields: true },
        },
      ],
      connections: { wh1: { main: [[{ node: "s1", type: "main", index: 0 }]] } },
    };
    const saved = await api(`/api/workflows/${created.id}`, jsonInit("PUT", workflow));
    expect(saved.status).toBe(200);
    const activated = await api(`/api/workflows/${created.id}/active`, jsonInit("POST", { active: true }));
    expect(activated.status).toBe(200);
    return created.id as string;
  }

  it("请求体能触发工作流并进入执行数据", async () => {
    const id = await createWebhookWorkflow();
    const triggered = await fetch(`${base}/webhook/${id}`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ hello: "world" }),
    });
    expect(triggered.status).toBe(202);
    const body = (await triggered.json()) as { executionId: string };
    const execution = await waitForExecution(body.executionId);
    expect(execution.status).toBe("success");
    // 真实数据流由 audit-probe 覆盖；这里验证 webhook 路由把起点与请求体正确传给运行时。
    const options = runtimeState.lastOptions;
    expect(options?.mode).toBe("trigger");
    expect(options?.startNodeId).toBe("wh1");
    expect((options?.inputData as Array<{ json: Record<string, unknown> }>)[0]?.json.hello).toBe("world");
  });

  it("访问令牌/方法/停用三种拒绝", async () => {
    const id = await createWebhookWorkflow("sec-token");
    const missing = await fetch(`${base}/webhook/${id}`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: "{}",
    });
    expect(missing.status).toBe(401);
    const wrongMethod = await fetch(`${base}/webhook/${id}`, {
      method: "GET",
      headers: { "x-webhook-token": "sec-token" },
    });
    expect(wrongMethod.status).toBe(405);
    const ok = await fetch(`${base}/webhook/${id}`, {
      method: "POST",
      headers: { "content-type": "application/json", "x-webhook-token": "sec-token" },
      body: "{}",
    });
    expect(ok.status).toBe(202);
    await api(`/api/workflows/${id}/active`, jsonInit("POST", { active: false }));
    const inactive = await fetch(`${base}/webhook/${id}`, { method: "POST", body: "{}" });
    expect(inactive.status).toBe(404);
  });

  it("未知 Webhook 返回 404", async () => {
    const missing = await fetch(`${base}/webhook/no-such-path`, { method: "POST", body: "{}" });
    expect(missing.status).toBe(404);
  });
});
