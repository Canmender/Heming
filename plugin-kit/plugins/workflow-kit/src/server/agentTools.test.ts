import { afterAll, beforeAll, describe, expect, it, vi } from "vitest";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { AddressInfo } from "node:net";
import { AGENT_TOOLS, discoverMcpTools } from "./agentTools.js";
import { createHttpServer } from "./http.js";
import { createStore, type Store } from "./storage.js";
import { createRuntime, type Runtime } from "./runtime.js";
import { registerCoreNodes } from "../nodes/core/index.js";
import { addConnection, createNode, createWorkflow } from "../model.js";
import type { Workflow, WorkflowNode } from "../types.js";
import type { WorkflowConfig as Config } from "./config.js";

/**
 * 智能体辅助工具（P0）单测：直连真实 Store + 真实 Runtime，不经过 HTTP/MCP 协议层
 * （协议层由 mcp.test / http.test 覆盖）。重点验证「试跑不写回工作流」「超时可返回」
 * 「启用前校验」「凭据只回元数据」「外部 MCP 工具发现」。
 */

let dir = "";
let store: Store;
let runtime: Runtime;
let server: ReturnType<typeof createHttpServer> | null = null;
let base = "";

const config: Config = {
  host: "127.0.0.1",
  port: 0,
  dataDir: "",
  maxExecutionMs: 60_000,
  rootDir: process.cwd(),
};

beforeAll(async () => {
  registerCoreNodes();
  dir = mkdtempSync(join(tmpdir(), "wf-agent-tools-"));
  config.dataDir = dir;
  store = createStore(dir);
  runtime = createRuntime(store, config);
});

afterAll(() => {
  if (server) server.close();
  rmSync(dir, { recursive: true, force: true });
});

function tool(name: string) {
  const found = AGENT_TOOLS.find((entry) => entry.name === name);
  if (!found) throw new Error(`找不到工具 ${name}`);
  return found;
}

function buildWorkflow(name: string, nodes: WorkflowNode[], links: Array<[number, number, number, number]>): Workflow {
  const workflow = createWorkflow({ name });
  workflow.nodes = nodes;
  for (const [from, output, to, input] of links) {
    addConnection(workflow, nodes[from].id, output, nodes[to].id, input);
  }
  return store.saveWorkflow(workflow);
}

function manualAndSet(): { workflow: Workflow; trigger: WorkflowNode; set: WorkflowNode } {
  const workflow = createWorkflow({ name: "试跑测试" });
  const trigger = createNode("manualTrigger", { workflow, position: { x: 0, y: 0 } });
  const set = createNode("set", {
    workflow,
    position: { x: 200, y: 0 },
  });
  set.parameters = { mode: "manual", fields: [{ name: "added", value: "yes" }], includeOtherFields: true };
  const saved = buildWorkflow("试跑测试", [trigger, set], [[0, 0, 1, 0]]);
  return { workflow: saved, trigger: saved.nodes[0], set: saved.nodes[1] };
}

describe("credential_list", () => {
  it("只返回凭据元数据，不泄露密钥值", async () => {
    store.saveCredential({ name: "审计用凭据", type: "bearerToken", data: { token: "SECRET-P0" } });
    const result = (await tool("credential_list").run({ store, runtime }, {})) as {
      total: number;
      credentials: Array<Record<string, unknown>>;
    };
    expect(result.total).toBeGreaterThanOrEqual(1);
    const found = result.credentials.find((item) => item.name === "审计用凭据");
    expect(found?.type).toBe("bearerToken");
    expect(JSON.stringify(result)).not.toContain("SECRET-P0");
  });
});

describe("node_type_detail", () => {
  it("返回完整参数 schema（含 required/options/displayOptions）", async () => {
    const detail = (await tool("node_type_detail").run({ store, runtime }, { type: "httpRequest" })) as {
      type: string;
      properties: Array<Record<string, unknown>>;
    };
    expect(detail.type).toBe("httpRequest");
    const url = detail.properties.find((item) => item.name === "url");
    expect(url?.required).toBe(true);
    const bodyType = detail.properties.find((item) => item.name === "bodyType");
    expect(bodyType?.options).toBeTruthy();
    const jsonBody = detail.properties.find((item) => item.name === "jsonBody");
    expect(jsonBody?.displayOptions).toBeTruthy();
  });

  it("未知类型报可读错误", async () => {
    await expect(tool("node_type_detail").run({ store, runtime }, { type: "nope" })).rejects.toThrow(/未知节点类型/);
  });
});

describe("workflow_test", () => {
  it("用 pinData 试跑：拿到逐节点预览，且不把 pinData 写回工作流", async () => {
    const { workflow, trigger, set } = manualAndSet();
    const result = (await tool("workflow_test").run(
      { store, runtime },
      { id: workflow.id, pinData: { [trigger.name]: [{ json: { seed: 1 } }] } },
    )) as {
      status: string;
      pinnedNodeIds: string[];
      nodes: Array<{ nodeId: string; status: string; preview: unknown[] }>;
    };
    expect(result.status).toBe("success");
    expect(result.pinnedNodeIds).toContain(trigger.id);
    const setRun = result.nodes.find((item) => item.nodeId === set.id);
    expect(setRun?.status).toBe("success");
    expect((setRun?.preview?.[0] as Record<string, unknown>)?.seed).toBe(1);
    // 关键：pinData 只活在这次测试里
    const stored = store.getWorkflow(workflow.id);
    expect(stored?.nodes.find((node) => node.id === trigger.id)?.pinData).toBeUndefined();
  });

  it("引脚名写错时明确报错（不静默忽略）", async () => {
    const { workflow } = manualAndSet();
    await expect(
      tool("workflow_test").run({ store, runtime }, { id: workflow.id, pinData: { "不存在的节点": [] } }),
    ).rejects.toThrow(/节点不存在/);
  });

  it("超时会中止并返回 canceled + timedOut，不会挂死", async () => {
    const workflow = createWorkflow({ name: "超时测试" });
    const trigger = createNode("manualTrigger", { workflow, position: { x: 0, y: 0 } });
    const wait = createNode("wait", { workflow, position: { x: 200, y: 0 } });
    wait.parameters = { amount: 3, unit: "seconds" };
    const saved = buildWorkflow("超时测试", [trigger, wait], [[0, 0, 1, 0]]);
    const startedAt = Date.now();
    const result = (await tool("workflow_test").run(
      { store, runtime },
      { id: saved.id, timeoutMs: 1000 },
    )) as { status: string; timedOut?: boolean; durationMs: number };
    const elapsed = Date.now() - startedAt;
    expect(result.timedOut).toBe(true);
    expect(result.status).toBe("canceled");
    expect(elapsed).toBeLessThan(5_000);
    expect(result.durationMs).toBeLessThan(5_000);
  });

  it("工作流有结构错误时拒绝试跑", async () => {
    const workflow = createWorkflow({ name: "坏工作流" });
    workflow.nodes = [
      {
        id: "bad-1",
        name: "坏节点",
        type: "noSuchType",
        position: { x: 0, y: 0 },
        parameters: {},
      },
    ];
    const saved = store.saveWorkflow(workflow);
    await expect(tool("workflow_test").run({ store, runtime }, { id: saved.id })).rejects.toThrow(/错误/);
  });
});

describe("workflow_set_active", () => {
  it("启用定时工作流并给出下次运行说明", async () => {
    const workflow = createWorkflow({ name: "定时启用" });
    const trigger = createNode("scheduleTrigger", { workflow, position: { x: 0, y: 0 } });
    trigger.parameters = {
      triggerInterval: "days",
      intervalCount: 1,
      triggerAtHour: 9,
      triggerAtMinute: 0,
    };
    const saved = buildWorkflow("定时启用", [trigger], []);
    const result = (await tool("workflow_set_active").run(
      { store, runtime },
      { id: saved.id, active: true },
    )) as { ok: boolean; active: boolean; scheduleTriggers: number; note: string };
    expect(result.active).toBe(true);
    expect(result.scheduleTriggers).toBe(1);
    expect(result.note).toContain("定时触发器");
    expect(store.getWorkflow(saved.id)?.active).toBe(true);
  });

  it("有错误的工作流拒绝启用", async () => {
    const workflow = createWorkflow({ name: "缺参数" });
    const http = createNode("httpRequest", { workflow, position: { x: 0, y: 0 } });
    http.parameters = { method: "GET", url: "" };
    const saved = buildWorkflow("缺参数", [http], []);
    await expect(
      tool("workflow_set_active").run({ store, runtime }, { id: saved.id, active: true }),
    ).rejects.toThrow(/不能启用|错误/);
  });
});

describe("mcp_list_tools", () => {
  it("能连本机 MCP 服务并列出工具（用本服务自测）", async () => {
    server = createHttpServer({
      store,
      runtime,
      config,
      version: "test",
    });
    await new Promise<void>((resolve) => server!.listen(0, "127.0.0.1", () => resolve()));
    const address = server.address() as AddressInfo;
    base = `http://127.0.0.1:${address.port}`;
    const result = (await tool("mcp_list_tools").run(
      { store, runtime },
      { url: `${base}/mcp` },
    )) as { total: number; tools: Array<{ name: string; inputSchema: unknown }> };
    expect(result.total).toBe(26);
    expect(result.tools.map((entry) => entry.name)).toContain("workflow_test");
    expect(result.tools.find((entry) => entry.name === "workflow_test")?.inputSchema).toBeTruthy();
  });

  it("拒绝非 http(s) 地址", async () => {
    await expect(
      tool("mcp_list_tools").run({ store, runtime }, { url: "file:///etc/passwd" }),
    ).rejects.toThrow(/http\/https|URL/);
  });
});

// 供类型检查引用（避免未使用导出告警）
void discoverMcpTools;

describe("运行时取消（自检修复回归）", () => {
  it("runtime.stop() 能中止顶层执行（此前 abort 的信号没人监听）", async () => {
    const workflow = createWorkflow({ name: "停止测试" });
    const trigger = createNode("manualTrigger", { workflow, position: { x: 0, y: 0 } });
    const wait = createNode("wait", { workflow, position: { x: 200, y: 0 } });
    wait.parameters = { amount: 3, unit: "seconds" };
    const saved = buildWorkflow("停止测试", [trigger, wait], [[0, 0, 1, 0]]);
    const running = runtime.runWorkflow(saved, {});
    await new Promise((resolve) => setTimeout(resolve, 200));
    expect(runtime.stop()).toBe(true);
    const execution = await running;
    expect(["canceled", "error"]).toContain(execution.status);
  });
});

describe("workflow_search（P1）", () => {
  it("按名称/标签/启用状态过滤，并返回可用标签", async () => {
    const a = createWorkflow({ name: "发票汇总" });
    a.tags = ["财务", "报表"];
    a.active = true;
    const savedA = store.saveWorkflow(a);
    const b = createWorkflow({ name: "每日提醒" });
    b.tags = ["通知"];
    const savedB = store.saveWorkflow(b);

    const byQuery = (await tool("workflow_search").run({ store, runtime }, { query: "发票" })) as {
      total: number;
      workflows: Array<{ id: string }>;
      availableTags: string[];
    };
    expect(byQuery.total).toBe(1);
    expect(byQuery.workflows[0]?.id).toBe(savedA.id);
    expect(byQuery.availableTags).toContain("财务");

    const byTag = (await tool("workflow_search").run({ store, runtime }, { tags: ["通知"] })) as {
      workflows: Array<{ id: string }>;
    };
    expect(byTag.workflows.map((item) => item.id)).toEqual([savedB.id]);

    const byActive = (await tool("workflow_search").run({ store, runtime }, { active: true })) as {
      workflows: Array<{ id: string }>;
    };
    expect(byActive.workflows.some((item) => item.id === savedA.id)).toBe(true);
    expect(byActive.workflows.some((item) => item.id === savedB.id)).toBe(false);
  });
});

describe("workflow_execution_detail（P1）", () => {
  it("返回逐节点数据并默认脱敏", async () => {
    const workflow = createWorkflow({ name: "脱敏详情" });
    const trigger = createNode("manualTrigger", { workflow, position: { x: 0, y: 0 } });
    const set = createNode("set", { workflow, position: { x: 200, y: 0 } });
    set.parameters = {
      mode: "manual",
      fields: [
        { name: "token", value: "super-secret-token-value" },
        { name: "ok", value: true },
      ],
      includeOtherFields: true,
    };
    const saved = buildWorkflow("脱敏详情", [trigger, set], [[0, 0, 1, 0]]);
    const tested = (await tool("workflow_test").run(
      { store, runtime },
      { id: saved.id, pinData: { [trigger.name]: [{ json: { seed: 1 } }] } },
    )) as { executionId: string };
    const detail = (await tool("workflow_execution_detail").run(
      { store, runtime },
      { executionId: tested.executionId },
    )) as { redacted: boolean; nodes: Array<{ nodeId: string; runs: Array<{ data?: { main: unknown[][] } }> }> };
    expect(detail.redacted).toBe(true);
    const setRun = detail.nodes.find((node) => node.nodeId === set.id);
    const item = setRun?.runs[0]?.data?.main[0]?.[0] as Record<string, unknown>;
    expect(item.token).toBe("***");
    expect(item.ok).toBe(true);
  });

  it("不存在的执行报可读错误", async () => {
    await expect(
      tool("workflow_execution_detail").run({ store, runtime }, { executionId: "nope" }),
    ).rejects.toThrow(/执行记录不存在/);
  });
});

describe("版本历史（P1）", () => {
  it("列表/读取/恢复历史版本", async () => {
    const workflow = createWorkflow({ name: "版本 A" });
    const trigger = createNode("manualTrigger", { workflow, position: { x: 0, y: 0 } });
    const saved = buildWorkflow("版本 A", [trigger], []);
    const edited = store.saveWorkflow({ ...saved, name: "版本 B" });

    const versions = (await tool("workflow_versions").run({ store, runtime }, { id: edited.id })) as {
      total: number;
      versions: Array<{ versionId: string }>;
    };
    expect(versions.total).toBeGreaterThanOrEqual(1);
    const versionId = versions.versions[0].versionId;

    const detail = (await tool("workflow_version_get").run(
      { store, runtime },
      { id: edited.id, versionId },
    )) as { workflow: { name: string } };
    expect(detail.workflow.name).toBe("版本 A");

    const restored = (await tool("workflow_restore").run(
      { store, runtime },
      { id: edited.id, versionId },
    )) as { ok: boolean; restoredVersionId: string };
    expect(restored.ok).toBe(true);
    expect(store.getWorkflow(edited.id)?.name).toBe("版本 A");
    // 恢复前那一版也留了快照
    expect(store.listVersions(edited.id).length).toBeGreaterThanOrEqual(2);
  });
});

describe("workflow_sdk_reference（P1）", () => {
  it("按 topic 返回参考，未知 topic 回落 overview", async () => {
    const json = (await tool("workflow_sdk_reference").run({ store, runtime }, { topic: "workflow-json" })) as {
      topic: string;
      content: string;
      availableTopics: string[];
    };
    expect(json.topic).toBe("workflow-json");
    expect(json.content).toContain("connections");
    expect(json.availableTopics).toContain("expressions");
    const fallback = (await tool("workflow_sdk_reference").run({ store, runtime }, { topic: "nope" })) as {
      topic: string;
    };
    expect(fallback.topic).toBe("overview");
  });
});

describe("workflow_generate（AI Builder）", () => {
  it("用 mock 模型生成工作流（解析围栏 JSON，默认不保存）", async () => {
    process.env.WF_LLM_BASE_URL = "https://llm.example/v1";
    process.env.WF_LLM_MODEL = "test-model";
    process.env.WF_LLM_API_KEY = "k";
    const generated = {
      plan: ["手动触发", "设置字段"],
      notes: [],
      workflow: {
        name: "AI 生成示例",
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
      },
    };
    vi.stubGlobal("fetch", async () =>
      new Response(JSON.stringify({ choices: [{ message: { content: "```json\n" + JSON.stringify(generated) + "\n```" } }] }), {
        status: 200,
        headers: { "content-type": "application/json" },
      }),
    );
    try {
      const result = (await tool("workflow_generate").run(
        { store, runtime },
        { request: "手动触发后设置一个字段" },
      )) as { saved: boolean; plan: string[]; workflow: { nodes: unknown[]; name: string }; issues: unknown[] };
      expect(result.saved).toBe(false);
      expect(result.plan).toContain("手动触发");
      expect(result.workflow.nodes).toHaveLength(2);
      expect(result.workflow.name).toBe("AI 生成示例");
      expect(store.listWorkflows().some((item) => item.name === "AI 生成示例")).toBe(false);
    } finally {
      vi.unstubAllGlobals();
      delete process.env.WF_LLM_BASE_URL;
      delete process.env.WF_LLM_MODEL;
      delete process.env.WF_LLM_API_KEY;
    }
  });

  it("未配置模型时给可读错误", async () => {
    delete process.env.WF_LLM_BASE_URL;
    delete process.env.WF_LLM_MODEL;
    await expect(
      tool("workflow_generate").run({ store, runtime }, { request: "随便" }),
    ).rejects.toThrow(/还没有配置模型连接/);
  });

  it("模型返回非 JSON 时报错而不是落半成品", async () => {
    process.env.WF_LLM_BASE_URL = "https://llm.example/v1";
    process.env.WF_LLM_MODEL = "test-model";
    vi.stubGlobal("fetch", async () =>
      new Response(JSON.stringify({ choices: [{ message: { content: "这不是 JSON" } }] }), {
        status: 200,
        headers: { "content-type": "application/json" },
      }),
    );
    try {
      await expect(tool("workflow_generate").run({ store, runtime }, { request: "随便" })).rejects.toThrow(/合法 JSON/);
    } finally {
      vi.unstubAllGlobals();
      delete process.env.WF_LLM_BASE_URL;
      delete process.env.WF_LLM_MODEL;
    }
  });
});
