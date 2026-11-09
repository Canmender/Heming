/**
 * MCP 协议层测试：经真实 HTTP（POST /mcp）走 JSON-RPC 全链路。
 *
 * 覆盖：initialize（protocolVersion/serverInfo/mcp-session-id）、notifications/initialized 202、
 * ping、tools/list、全部工具的 happy path（工作流生命周期/执行异步启动与轮询/节点与凭据元数据/
 * 导入导出/模板），以及 -32601 / -32602 / -32700、isError 业务错误与 session 放行。
 */

import { mkdirSync, mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { AddressInfo } from "node:net";
import { afterAll, beforeAll, beforeEach, describe, expect, it } from "vitest";
import type { Workflow, WorkflowExecution } from "../types.js";
import type { WorkflowConfig } from "./config.js";
import { createHttpServer } from "./http.js";
import { createStore, type Store } from "./storage.js";
import { registerCoreNodes } from "../nodes/core/index.js";
import { getNodeType, registerNodeType } from "../registry.js";

// ---------------------------------------------------------------------------
// 夹具
// ---------------------------------------------------------------------------

let rootDir = "";
let store: Store;
let server: ReturnType<typeof createHttpServer>;
let base = "";

const runtimeState = {
  seq: 0,
  running: new Set<string>(),
  live: new Map<string, WorkflowExecution>(),
  failNext: false,
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
    if (runtimeState.failNext) {
      runtimeState.failNext = false;
      throw new Error("工作流正在运行，等它结束再试");
    }
    const executionId = `mcp-exec-${++runtimeState.seq}`;
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
          executionTime: 2,
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
    execution.durationMs = 2;
    options.onEvent?.({ type: "executionFinish", execution });
    runtimeState.running.delete(workflow.id);
    return execution;
  },
  getLiveExecution: (id: string) => runtimeState.live.get(id),
  isRunning: (workflowId: string) => runtimeState.running.has(workflowId),
  stop: () => false,
};

function delay(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

function registerTestNodes(): void {
  registerCoreNodes();
  for (const type of [
    "notification",
    "llm",
    "mcpTool",
    "infohubAgenda",
    "infohubSearch",
    "infohubSync",
    "dateTime",
    "crypto",
    "xml",
  ]) {
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
  runtimeState.seq = 0;
  runtimeState.running.clear();
  runtimeState.live.clear();
  runtimeState.failNext = false;
}

interface RpcResponse {
  status: number;
  headers: Headers;
  text: string;
  body: any;
}

async function rpc(
  method: string,
  params?: unknown,
  options: { id?: number | null; sessionId?: string } = {},
): Promise<RpcResponse> {
  const payload: Record<string, unknown> = { jsonrpc: "2.0", method };
  if (options.id !== null) payload.id = options.id ?? 1;
  if (params !== undefined) payload.params = params;
  const response = await fetch(`${base}/mcp`, {
    method: "POST",
    headers: {
      "content-type": "application/json",
      accept: "application/json, text/event-stream",
      ...(options.sessionId ? { "mcp-session-id": options.sessionId } : {}),
    },
    body: JSON.stringify(payload),
  });
  const text = await response.text();
  let body: any = null;
  try {
    body = text ? JSON.parse(text) : null;
  } catch {
    body = text;
  }
  return { status: response.status, headers: response.headers, text, body };
}

interface ToolCallResult {
  rpcBody: any;
  result: any;
  text: string;
  parsed: any;
}

async function callTool(name: string, args: Record<string, unknown> = {}): Promise<ToolCallResult> {
  const response = await rpc("tools/call", { name, arguments: args }, { id: 7 });
  const result = response.body?.result;
  const text = typeof result?.content?.[0]?.text === "string" ? result.content[0].text : "";
  let parsed: any = text;
  try {
    parsed = JSON.parse(text) as unknown;
  } catch {
    /* 错误消息是纯文本 */
  }
  return { rpcBody: response.body, result, text, parsed };
}

async function waitForRunStatus(executionId: string): Promise<any> {
  const deadline = Date.now() + 3000;
  while (Date.now() < deadline) {
    const result = await callTool("workflow_run_status", { executionId });
    if (result.parsed?.status === "success") return result.parsed;
    if (result.parsed?.status === "error" || result.result?.isError) return result.parsed;
    await delay(15);
  }
  throw new Error(`执行 ${executionId} 未在 3 秒内结束`);
}

beforeAll(async () => {
  rootDir = mkdtempSync(join(tmpdir(), "wf-mcp-test-"));
  mkdirSync(join(rootDir, "public"), { recursive: true });
  registerTestNodes();
  store = createStore(join(rootDir, "data"));
  const config: WorkflowConfig = {
    host: "127.0.0.1",
    port: 0,
    dataDir: join(rootDir, "data"),
    rootDir,
    maxExecutionMs: 60_000,
  };
  server = createHttpServer({
    store,
    runtime: fakeRuntime as never,
    scheduler: { running: false },
    config,
    version: "test-0.1.0",
  });
  await new Promise<void>((resolve) => {
    server.listen(0, "127.0.0.1", () => resolve());
  });
  base = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
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
// 握手 / 基础方法
// ---------------------------------------------------------------------------

describe("MCP 握手与基础方法", () => {
  it("initialize 返回 serverInfo/protocolVersion 并下发 mcp-session-id", async () => {
    const response = await rpc("initialize", {
      protocolVersion: "2025-03-26",
      capabilities: {},
      clientInfo: { name: "heming-test", version: "1.0.0" },
    });
    expect(response.status).toBe(200);
    expect(response.body.jsonrpc).toBe("2.0");
    expect(response.body.result.protocolVersion).toBe("2025-03-26");
    expect(response.body.result.capabilities.tools).toBeTruthy();
    expect(typeof response.body.result.serverInfo.name).toBe("string");
    expect(response.body.result.serverInfo.version).toBe("test-0.1.0");
    const sessionId = response.headers.get("mcp-session-id");
    expect(sessionId).toBeTruthy();
  });

  it("initialize 回显客户端支持的老协议版本", async () => {
    const response = await rpc("initialize", { protocolVersion: "2024-11-05" });
    expect(response.body.result.protocolVersion).toBe("2024-11-05");
  });

  it("notifications/initialized 返回 202 空体", async () => {
    const init = await rpc("initialize", { protocolVersion: "2025-03-26" });
    const sessionId = init.headers.get("mcp-session-id") ?? "";
    const notified = await rpc("notifications/initialized", undefined, { id: null, sessionId });
    expect(notified.status).toBe(202);
    expect(notified.text).toBe("");
  });

  it("ping 返回空结果；带 session 请求可被放行", async () => {
    const ping = await rpc("ping", {}, { sessionId: "arbitrary-session" });
    expect(ping.status).toBe(200);
    expect(ping.body.result).toEqual({});
  });

  it("tools/list 返回 CONTRACT §5 的 26 个工具且带 inputSchema", async () => {
    const response = await rpc("tools/list", {});
    expect(response.status).toBe(200);
    const tools = response.body.result.tools as Array<Record<string, any>>;
    expect(tools).toHaveLength(26);
    const names = tools.map((tool) => tool.name).sort();
    expect(names).toEqual(
      [
        "credential_list",
        "credential_types",
        "mcp_list_tools",
        "node_type_detail",
        "node_types",
        "workflow_create",
        "workflow_delete",
        "workflow_export",
        "workflow_get",
        "workflow_execution_detail",
        "workflow_generate",
        "workflow_import",
        "workflow_list",
        "workflow_restore",
        "workflow_sdk_reference",
        "workflow_search",
        "workflow_run",
        "workflow_run_status",
        "workflow_runs",
        "workflow_set_active",
        "workflow_templates",
        "workflow_version_get",
        "workflow_versions",
        "workflow_test",
        "workflow_update",
        "workflow_validate",
      ].sort(),
    );
    for (const tool of tools) {
      expect(typeof tool.description).toBe("string");
      expect(tool.inputSchema.type).toBe("object");
      expect(typeof tool.inputSchema.properties).toBe("object");
    }
  });

  it("未知方法返回 -32601", async () => {
    const response = await rpc("workflow/teleport", {});
    expect(response.status).toBe(200);
    expect(response.body.error.code).toBe(-32601);
  });

  it("tools/call 缺少 name 返回 -32602；未知工具也返回 -32602", async () => {
    const missing = await rpc("tools/call", { arguments: {} });
    expect(missing.body.error.code).toBe(-32602);

    const unknownTool = await rpc("tools/call", { name: "workflow_teleport", arguments: {} });
    expect(unknownTool.body.error.code).toBe(-32602);
  });

  it("非法 JSON 返回 HTTP 400 与 JSON-RPC -32700", async () => {
    const response = await fetch(`${base}/mcp`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: "{broken",
    });
    expect(response.status).toBe(400);
    const body = (await response.json()) as any;
    expect(body.error.code).toBe(-32700);
  });
});

// ---------------------------------------------------------------------------
// 工作流工具
// ---------------------------------------------------------------------------

describe("工作流工具", () => {
  it("create → list → get → update → validate → export → import → delete 全流程", async () => {
    const created = await callTool("workflow_create", { name: "MCP 流程" });
    expect(created.result.isError).toBeUndefined();
    expect(created.parsed.ok).toBe(true);
    const workflowId = created.parsed.workflow.id as string;
    expect(workflowId).toBeTruthy();

    const list = await callTool("workflow_list");
    expect(list.parsed.total).toBe(1);
    expect(list.parsed.workflows[0].id).toBe(workflowId);

    const fetched = await callTool("workflow_get", { id: workflowId });
    expect(fetched.parsed.id).toBe(workflowId);

    const updated = await callTool("workflow_update", {
      id: workflowId,
      json: { ...created.parsed.workflow, name: "MCP 改名" },
    });
    expect(updated.parsed.ok).toBe(true);
    expect(updated.parsed.workflow.name).toBe("MCP 改名");
    expect(Array.isArray(updated.parsed.issues)).toBe(true);

    const validated = await callTool("workflow_validate", { json: updated.parsed.workflow });
    expect(Array.isArray(validated.parsed.issues)).toBe(true);

    const exported = await callTool("workflow_export", { id: workflowId });
    expect(Array.isArray(exported.parsed.nodes)).toBe(true);
    expect(typeof exported.parsed.connections).toBe("object");

    const imported = await callTool("workflow_import", { json: exported.parsed });
    expect(imported.parsed.ok).toBe(true);
    expect(imported.parsed.workflow.id).not.toBe(workflowId);

    const deleted = await callTool("workflow_delete", { id: workflowId });
    expect(deleted.parsed.ok).toBe(true);

    const gone = await callTool("workflow_get", { id: workflowId });
    expect(gone.result.isError).toBe(true);
    expect(gone.text).toContain("不存在");
  });

  it("workflow_create 支持 n8n 形状 JSON，未知节点给 warning", async () => {
    const created = await callTool("workflow_create", {
      json: {
        name: "n8n 导入",
        nodes: [
          { id: "a", name: "开始", type: "n8n-nodes-base.manualTrigger", position: { x: 0, y: 0 }, parameters: {} },
          { id: "b", name: "未知", type: "n8n-nodes-base.mystery", position: { x: 200, y: 0 }, parameters: {} },
        ],
        connections: { 开始: { main: [[{ node: "未知", type: "main", index: 0 }]] } },
      },
    });
    expect(created.parsed.ok).toBe(true);
    expect(created.parsed.warnings).toHaveLength(1);
    expect(created.parsed.workflow.nodes[0].type).toBe("manualTrigger");
    expect(created.parsed.workflow.nodes[1].type).toBe("mystery");
  });

  it("缺少必填参数返回 -32602", async () => {
    const response = await rpc("tools/call", { name: "workflow_get", arguments: {} });
    expect(response.body.error.code).toBe(-32602);
  });

  it("workflow_validate 只校验不入库", async () => {
    const result = await callTool("workflow_validate", {
      json: {
        name: "只校验",
        nodes: [
          { id: "a", name: "开始", type: "manualTrigger", position: { x: 0, y: 0 }, parameters: {} },
        ],
        connections: {},
      },
    });
    expect(Array.isArray(result.parsed.issues)).toBe(true);
    expect(result.parsed.ok).toBe(true);
    expect((await callTool("workflow_list")).parsed.total).toBe(0);
  });
});

// ---------------------------------------------------------------------------
// 执行工具
// ---------------------------------------------------------------------------

describe("执行工具", () => {
  it("workflow_run 异步返回 executionId，run_status 轮询到逐节点摘要", async () => {
    const created = await callTool("workflow_create", { name: "MCP 可执行" });
    const workflowId = created.parsed.workflow.id as string;

    const started = await callTool("workflow_run", { id: workflowId });
    expect(started.result.isError).toBeUndefined();
    expect(typeof started.parsed.executionId).toBe("string");
    expect(started.parsed.status).toBe("running");

    const status = await waitForRunStatus(started.parsed.executionId);
    expect(status.status).toBe("success");
    expect(Array.isArray(status.nodes)).toBe(true);
    expect(status.nodes.length).toBeGreaterThan(0);
    expect(status.nodes[0].status).toBe("success");
    expect(status.nodes[0].itemsTotal).toBe(1);
    // 摘要不回节点数据（大数据不进智能体上下文）
    expect(status.nodes[0].data).toBeUndefined();
    expect(status.runData).toBeUndefined();

    const runs = await callTool("workflow_runs", { workflowId, limit: 5 });
    expect(runs.parsed.total).toBe(1);
    expect(runs.parsed.executions[0].id).toBe(started.parsed.executionId);
    expect(runs.parsed.executions[0].runData).toBeUndefined();
  });

  it("workflow_run 对不存在的工作流返回 isError 文本", async () => {
    const result = await callTool("workflow_run", { id: "not-exist" });
    expect(result.result.isError).toBe(true);
    expect(result.text).toContain("不存在");
  });

  it("workflow_run_status 对不存在的执行返回 isError", async () => {
    const result = await callTool("workflow_run_status", { executionId: "not-exist" });
    expect(result.result.isError).toBe(true);
  });

  it("workflow_run 启动失败（已在运行）返回 isError", async () => {
    const created = await callTool("workflow_create", { name: "启动失败" });
    runtimeState.failNext = true;
    const result = await callTool("workflow_run", { id: created.parsed.workflow.id });
    expect(result.result.isError).toBe(true);
    expect(result.text).toContain("正在运行");
  });
});

// ---------------------------------------------------------------------------
// 元数据工具
// ---------------------------------------------------------------------------

describe("元数据工具", () => {
  it("node_types 返回类型/显示名/分组与参数摘要", async () => {
    const result = await callTool("node_types");
    const types = result.parsed.nodeTypes as Array<Record<string, any>>;
    expect(types.length).toBeGreaterThan(10);
    const manual = types.find((item) => item.type === "manualTrigger");
    expect(manual).toBeTruthy();
    if (!manual) throw new Error("缺少 manualTrigger 节点描述");
    expect(manual.displayName).toBeTruthy();
    expect(manual.group).toBeTruthy();
    expect(Array.isArray(manual.parameters)).toBe(true);
  });

  it("credential_types 返回四种凭据与字段", async () => {
    const result = await callTool("credential_types");
    const types = result.parsed.types as Array<Record<string, any>>;
    expect(types).toHaveLength(4);
    const bearer = types.find((item) => item.type === "bearerToken");
    expect(bearer).toBeTruthy();
    if (!bearer) throw new Error("缺少 bearerToken 凭据类型");
    expect(bearer.fields[0].name).toBe("token");
    expect(bearer.fields[0].secret).toBe(true);
  });

  it("workflow_templates 返回模板与可直接创建的工作流 JSON", async () => {
    const result = await callTool("workflow_templates");
    const templates = result.parsed.templates as Array<Record<string, any>>;
    expect(templates.length).toBeGreaterThanOrEqual(3);
    for (const template of templates) {
      expect(typeof template.id).toBe("string");
      expect(template.workflow).toBeTruthy();
      expect(Array.isArray(template.workflow.nodes)).toBe(true);
    }
  });
});

// ---------------------------------------------------------------------------
// 智能体辅助工具（P0）
// ---------------------------------------------------------------------------

describe("智能体辅助工具", () => {
  it("credential_list 只返回元数据（不含密钥值）", async () => {
    store.saveCredential({ name: "MCP 测试凭据", type: "bearerToken", data: { token: "SECRET-MCP" } });
    const result = await callTool("credential_list");
    expect(result.parsed.total).toBeGreaterThanOrEqual(1);
    const found = (result.parsed.credentials as Array<Record<string, any>>).find(
      (item) => item.name === "MCP 测试凭据",
    );
    expect(found?.type).toBe("bearerToken");
    expect(result.text).not.toContain("SECRET-MCP");
  });

  it("node_type_detail 返回完整参数 schema", async () => {
    const result = await callTool("node_type_detail", { type: "httpRequest" });
    expect(result.parsed.type).toBe("httpRequest");
    const url = (result.parsed.properties as Array<Record<string, any>>).find((item) => item.name === "url");
    expect(url?.required).toBe(true);
    const body = (result.parsed.properties as Array<Record<string, any>>).find((item) => item.name === "jsonBody");
    expect(body?.displayOptions).toBeTruthy();
  });

  it("workflow_test 用 pinData 试跑并返回逐节点预览", async () => {
    const created = await callTool("workflow_create", { name: "MCP 试跑" });
    const workflow = (await callTool("workflow_get", { id: created.parsed.workflow.id }))
      .parsed as Record<string, any>;
    workflow.nodes = [
      { id: "t1", name: "手动触发", type: "manualTrigger", position: { x: 0, y: 0 }, parameters: {} },
      { id: "s1", name: "设置字段", type: "set", position: { x: 200, y: 0 }, parameters: {} },
    ];
    workflow.connections = { t1: { main: [[{ node: "s1", type: "main", index: 0 }]] } };
    await callTool("workflow_update", { id: workflow.id, json: workflow });
    const result = await callTool("workflow_test", {
      id: workflow.id,
      pinData: { t1: [{ json: { seed: 1 } }] },
    });
    expect(result.result?.isError).not.toBe(true);
    expect(result.parsed.status).toBe("success");
    expect(result.parsed.pinnedNodeIds).toContain("t1");
    expect(Array.isArray(result.parsed.nodes)).toBe(true);
  });

  it("workflow_set_active 启停工作流", async () => {
    const created = await callTool("workflow_create", { name: "启停测试" });
    const workflow = (await callTool("workflow_get", { id: created.parsed.workflow.id }))
      .parsed as Record<string, any>;
    workflow.nodes = [
      {
        id: "sch1",
        name: "定时触发",
        type: "scheduleTrigger",
        position: { x: 0, y: 0 },
        parameters: {},
      },
    ];
    workflow.connections = {};
    await callTool("workflow_update", { id: workflow.id, json: workflow });
    const result = await callTool("workflow_set_active", { id: workflow.id, active: true });
    expect(result.parsed.ok).toBe(true);
    expect(result.parsed.active).toBe(true);
    expect(store.getWorkflow(workflow.id)?.active).toBe(true);
  });

  it("mcp_list_tools 能连本机 MCP 服务并列出工具", async () => {
    const result = await callTool("mcp_list_tools", { url: `${base}/mcp` });
    expect(result.parsed.total).toBe(26);
    expect((result.parsed.tools as Array<{ name: string }>).map((item) => item.name)).toContain("workflow_test");
  });
});

describe("P1 工具（搜索 / 执行详情 / 版本 / SDK）", () => {
  it("workflow_search 支持关键词与标签过滤", async () => {
    const created = await callTool("workflow_create", { name: "发票汇总" });
    const workflow = (await callTool("workflow_get", { id: created.parsed.workflow.id })).parsed as Record<string, any>;
    await callTool("workflow_update", { id: workflow.id, json: { ...workflow, tags: ["财务"] } });
    const byQuery = await callTool("workflow_search", { query: "发票" });
    expect(byQuery.parsed.total).toBeGreaterThanOrEqual(1);
    const byTag = await callTool("workflow_search", { tags: ["财务"] });
    expect((byTag.parsed.workflows as Array<{ id: string }>).some((item) => item.id === workflow.id)).toBe(true);
    expect((byQuery.parsed.availableTags as string[])).toContain("财务");
  });

  it("workflow_execution_detail 返回脱敏后的逐节点数据", async () => {
    const created = await callTool("workflow_create", { name: "详情测试" });
    const workflow = (await callTool("workflow_get", { id: created.parsed.workflow.id })).parsed as Record<string, any>;
    await callTool("workflow_update", { id: workflow.id, json: workflow });
    const run = await callTool("workflow_run", { id: workflow.id });
    const executionId = run.parsed.executionId as string;
    await waitForRunStatus(executionId);
    const detail = await callTool("workflow_execution_detail", { executionId });
    expect(detail.result?.isError).not.toBe(true);
    expect(detail.parsed.redacted).toBe(true);
    expect(Array.isArray(detail.parsed.nodes)).toBe(true);
  });

  it("版本列表与 SDK 参考", async () => {
    const created = await callTool("workflow_create", { name: "版本工具" });
    const workflow = (await callTool("workflow_get", { id: created.parsed.workflow.id })).parsed as Record<string, any>;
    await callTool("workflow_update", { id: workflow.id, json: { ...workflow, name: "版本工具二" } });
    const versions = await callTool("workflow_versions", { id: workflow.id });
    expect(versions.parsed.total).toBeGreaterThanOrEqual(1);
    const sdk = await callTool("workflow_sdk_reference", { topic: "expressions" });
    expect(sdk.parsed.topic).toBe("expressions");
    expect(sdk.parsed.content).toContain("$json");
  });
});
