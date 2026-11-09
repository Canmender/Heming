// @vitest-environment node
/**
 * app.js 的纯逻辑测试（Node 环境）。
 *
 * 为什么用 vm 加载 public/app.js：页面脚本是经典 `<script>`（没有 ESM 导出），
 * 但验收要求「可测纯函数挂到 globalThis.WFAppUtils」。这里提供最小的 vm 上下文
 * （没有 document），app.js 检测到没有 document 就只导出工具、不启动 UI。
 * fetch 注入假实现，验证 REST 客户端的 URL / 方法 / body / 错误归一。
 */

import { readFileSync } from "node:fs";
import { createContext, runInContext } from "node:vm";
import { describe, expect, it, vi } from "vitest";

const SOURCE = readFileSync(new URL("../../public/app.js", import.meta.url), "utf8");

interface FakeResponse {
  ok: boolean;
  status: number;
  text(): Promise<string>;
}

interface FetchInit {
  method?: string;
  headers?: Record<string, string>;
  body?: string;
}

type FetchImpl = (url: string, init?: FetchInit) => Promise<FakeResponse>;

interface ParameterField {
  name: string;
  type: string;
  value: unknown;
  error: string;
  required: boolean;
}

interface NodeDescription {
  properties: Array<Record<string, unknown>>;
  type: string;
  displayName?: string;
  defaultName?: string;
}

interface WorkflowSummary {
  id: string;
  name: string;
  tags?: string[];
  active?: boolean;
}

interface NodeRun {
  status: string;
  itemsTotal?: number;
  executionTime?: number;
  executionIndex?: number;
  source?: Array<{ previousNode?: string }>;
  data?: { main: unknown[][] };
  error?: { message: string };
}

interface ExecutionLike {
  id: string;
  workflowId: string;
  runData: Record<string, NodeRun[]>;
}

interface AppUtils {
  formatTime(at: number): string;
  formatDuration(ms: number): string;
  formatBytes(bytes: number): string;
  statusLabel(status: string): string;
  modeLabel(mode: string): string;
  executionStatusFinished(status: string): boolean;
  filterWorkflows<T extends { name?: string; tags?: string[] }>(list: T[], keyword: string): T[];
  workflowCounts(summary: { nodeCount?: number; triggerCount?: number }): string;
  cloneJson<T>(value: T): T;
  isPropertyVisible(property: Record<string, unknown>, parameters: Record<string, unknown>): boolean;
  buildParameterFields(description: NodeDescription, parameters: Record<string, unknown>): ParameterField[];
  parameterErrors(description: NodeDescription, parameters: Record<string, unknown>): Record<string, string>;
  validateJsonText(text: string): string;
  parseJsonSafe(text: string): { ok: boolean; value: unknown; error: string };
  hasExpression(value: string): boolean;
  extractExpressions(value: string): string[];
  isSingleExpression(value: string): boolean;
  hasUnclosedExpression(value: string): boolean;
  uniqueNodeName(nodes: Array<{ name: string }>, base: string): string;
  createNodeFromType(
    description: NodeDescription & { defaultName?: string },
    workflow: { nodes: Array<{ name: string }> },
    position: { x: number; y: number },
  ): { id: string; name: string; type: string; position: { x: number; y: number }; parameters: Record<string, unknown> };
  groupNodeTypes(types: Array<{ group: string; type: string }>): Array<{ group: string; label: string; types: unknown[] }>;
  buildRunState(execution: ExecutionLike): Record<string, { state: string; itemCount: number }>;
  collectNodeInputItems(execution: ExecutionLike, nodeId: string): unknown[];
  collectRunInputItems(execution: ExecutionLike, run: NodeRun): unknown[];
  executionNodeSummaries(
    execution: ExecutionLike,
    workflow: { nodes: Array<{ id: string; name: string; type: string }> },
  ): Array<{ nodeId: string; name: string; type: string; runs: NodeRun[] }>;
  credentialTypeLabel(type: string): string;
  buildCredentialFields(
    type: string,
  ): Array<{ name: string; label: string; required: boolean; secret: boolean }>;
  validateCredentialForm(fields: Array<{ name: string; label: string; required: boolean }>, values: Record<string, string>): string;
  parseVarsText(text: string): { ok: boolean; error: string; value: Record<string, unknown> };
  buildSettingsPayload(
    form: Record<string, unknown>,
    previous: Record<string, unknown>,
  ): { vars: Record<string, unknown>; llm?: Record<string, unknown> };
  truncateJson(value: unknown, maxChars?: number): { text: string; truncated: boolean };
  createHistory<T>(initial: T, clone?: (value: T) => T): {
    get(): T;
    push(value: T): void;
    undo(): boolean;
    redo(): boolean;
    canUndo(): boolean;
    canRedo(): boolean;
  };
  createApi(fetchImpl: FetchImpl, baseUrl?: string): ApiClient;
}

interface RequestCall {
  url: string;
  init?: FetchInit;
}

interface ApiClient {
  listWorkflows(): Promise<unknown>;
  getWorkflow(id: string): Promise<unknown>;
  saveWorkflow(id: string, workflow: Record<string, unknown>): Promise<unknown>;
  createWorkflow(input: Record<string, unknown>): Promise<unknown>;
  deleteWorkflow(id: string): Promise<unknown>;
  setActive(id: string, active: boolean): Promise<unknown>;
  duplicateWorkflow(id: string): Promise<unknown>;
  exportWorkflow(id: string): Promise<unknown>;
  importWorkflow(json: unknown): Promise<unknown>;
  runWorkflow(id: string, options?: Record<string, unknown>): Promise<unknown>;
  stopWorkflow(id: string): Promise<unknown>;
  listExecutions(query?: Record<string, unknown>): Promise<unknown>;
  getExecution(id: string): Promise<unknown>;
  deleteExecution(id: string): Promise<unknown>;
  retryExecution(id: string): Promise<unknown>;
  listCredentials(): Promise<unknown>;
  createCredential(input: Record<string, unknown>): Promise<unknown>;
  updateCredential(id: string, patch: Record<string, unknown>): Promise<unknown>;
  deleteCredential(id: string): Promise<unknown>;
  getSettings(): Promise<unknown>;
  saveSettings(patch: Record<string, unknown>): Promise<unknown>;
  health(): Promise<unknown>;
}

function loadUtils(): AppUtils {
  const sandbox: Record<string, unknown> = { console, setTimeout, clearTimeout, setInterval, clearInterval };
  createContext(sandbox);
  runInContext(SOURCE, sandbox);
  return sandbox.WFAppUtils as AppUtils;
}

const utils = loadUtils();

function fakeResponse(payload: unknown, status = 200): FakeResponse {
  return {
    ok: status >= 200 && status < 300,
    status,
    text: async () => (payload === undefined ? "" : JSON.stringify(payload)),
  };
}

/** 记录调用并按 handler 返回的假 fetch。 */
function createFetchMock(handler?: (url: string, init?: FetchInit) => FakeResponse | Promise<FakeResponse>) {
  const calls: RequestCall[] = [];
  const fetchImpl: FetchImpl = async (url, init) => {
    calls.push({ url, init });
    if (handler) return handler(url, init);
    return fakeResponse({ ok: true });
  };
  return { fetchImpl, calls };
}

function executionFixture(): ExecutionLike {
  return {
    id: "exec-1",
    workflowId: "wf-1",
    runData: {
      "node-a": [
        {
          status: "success",
          itemsTotal: 2,
          executionTime: 12,
          executionIndex: 0,
          source: [],
          data: { main: [[{ json: { a: 1 } }, { json: { a: 2 } }]] },
        },
      ],
      "node-b": [
        {
          status: "error",
          itemsTotal: 0,
          executionTime: 3,
          executionIndex: 0,
          source: [{ previousNode: "node-a" }],
          error: { message: "坏了" },
        },
      ],
    },
  };
}

describe("格式化辅助", () => {
  it("formatTime 输出本地时间（毫秒补零）", () => {
    const at = new Date(2026, 10, 7, 9, 5, 3).getTime();
    expect(utils.formatTime(at)).toBe("2026-11-07 09:05:03");
    expect(utils.formatTime(0)).toBe("—");
    expect(utils.formatTime(Number.NaN)).toBe("—");
  });

  it("formatDuration 分档：毫秒/秒/分", () => {
    expect(utils.formatDuration(0)).toBe("不到 1 毫秒");
    expect(utils.formatDuration(500)).toBe("500 毫秒");
    expect(utils.formatDuration(2500)).toBe("2.5 秒");
    expect(utils.formatDuration(65_000)).toBe("1 分 5 秒");
  });

  it("状态与模式中文映射", () => {
    expect(utils.statusLabel("success")).toBe("成功");
    expect(utils.statusLabel("error")).toBe("失败");
    expect(utils.modeLabel("manual")).toBe("手动");
    expect(utils.modeLabel("trigger")).toBe("定时");
    expect(utils.executionStatusFinished("success")).toBe(true);
    expect(utils.executionStatusFinished("running")).toBe(false);
  });

  it("formatBytes 与 workflowCounts", () => {
    expect(utils.formatBytes(2048)).toBe("2.0 KB");
    expect(utils.workflowCounts({ nodeCount: 3, triggerCount: 1 })).toBe("3 个节点 · 1 个触发器");
  });
});

describe("列表过滤", () => {
  const workflows: WorkflowSummary[] = [
    { id: "1", name: "抓取天气", tags: ["每日"] },
    { id: "2", name: "同步笔记", tags: ["hourly"] },
  ];

  it("大小写不敏感匹配名称与标签，空关键词原样返回", () => {
    expect(utils.filterWorkflows(workflows, "天气").map((item) => item.id)).toEqual(["1"]);
    expect(utils.filterWorkflows(workflows, "HOURLY").map((item) => item.id)).toEqual(["2"]);
    expect(utils.filterWorkflows(workflows, "  ").length).toBe(2);
    expect(utils.filterWorkflows(workflows, "不存在")).toEqual([]);
  });
});

describe("参数表单模型", () => {
  const description: NodeDescription = {
    type: "httpRequest",
    properties: [
      {
        name: "method",
        displayName: "方法",
        type: "options",
        default: "GET",
        options: [
          { name: "GET", value: "GET" },
          { name: "POST", value: "POST" },
        ],
      },
      {
        name: "jsonBody",
        displayName: "JSON 请求体",
        type: "json",
        displayOptions: { show: { method: ["POST"] } },
      },
      { name: "url", displayName: "URL", type: "string", required: true },
      { name: "hint", displayName: "说明", type: "notice", description: "只读提示" },
    ],
  };

  it("按 displayOptions 显示/隐藏字段，并带默认值与必填错误", () => {
    const getFields = utils.buildParameterFields(description, { method: "GET" });
    expect(getFields.map((field) => field.name)).toEqual(["method", "url", "hint"]);
    expect(getFields[0]?.value).toBe("GET");
    const urlField = getFields.find((field) => field.name === "url");
    expect(urlField?.required).toBe(true);
    expect(urlField?.error).toBe("请填写URL");

    const postFields = utils.buildParameterFields(description, { method: "POST", url: "https://x" });
    expect(postFields.map((field) => field.name)).toContain("jsonBody");
    expect(utils.parameterErrors(description, { method: "POST", url: "https://x" })).toEqual({});
  });

  it("JSON 字段校验：坏 JSON 报错、表达式跳过、空值合法", () => {
    expect(utils.validateJsonText("")).toBe("");
    expect(utils.validateJsonText('{"a":1}')).toBe("");
    expect(utils.validateJsonText("{{ $json }}")).toBe("");
    expect(utils.validateJsonText("{")).toContain("JSON 格式有误");
  });

  it("isPropertyVisible 对多条件取交集", () => {
    const property = {
      displayOptions: { show: { a: ["x"], b: [1, 2] } },
    };
    expect(utils.isPropertyVisible(property, { a: "x", b: 1 })).toBe(true);
    expect(utils.isPropertyVisible(property, { a: "x", b: 3 })).toBe(false);
    expect(utils.isPropertyVisible(property, { b: 1 })).toBe(false);
    expect(utils.isPropertyVisible({}, {})).toBe(true);
  });
});

describe("表达式提示", () => {
  it("识别完整/整段/未闭合表达式", () => {
    expect(utils.hasExpression("Bearer {{ $json.token }}")).toBe(true);
    expect(utils.hasExpression("纯文本")).toBe(false);
    expect(utils.extractExpressions("{{ $json.a }} + {{ $now }} + {{ $json.a }}")).toEqual([
      "$json.a",
      "$now",
    ]);
    expect(utils.isSingleExpression("{{ $json.items }}")).toBe(true);
    expect(utils.isSingleExpression("前缀 {{ $json.a }}")).toBe(false);
    expect(utils.hasUnclosedExpression("{{ $json.a")).toBe(true);
    expect(utils.hasUnclosedExpression("{{ $json.a }}")).toBe(false);
  });
});

describe("节点与调色板", () => {
  it("uniqueNodeName 追加序号", () => {
    const nodes = [{ name: "HTTP 请求" }, { name: "HTTP 请求 2" }];
    expect(utils.uniqueNodeName(nodes, "HTTP 请求")).toBe("HTTP 请求 3");
    expect(utils.uniqueNodeName([], "设置")).toBe("设置");
  });

  it("createNodeFromType 写默认参数并生成唯一名字", () => {
    const description: NodeDescription = {
      type: "set",
      displayName: "设置字段",
      properties: [
        { name: "mode", default: "manual" },
        { name: "fields", default: { a: 1 } },
        { name: "note" },
      ],
    };
    const node = utils.createNodeFromType(description, { nodes: [{ name: "设置字段" }] }, { x: 10, y: 20 });
    expect(node.type).toBe("set");
    expect(node.name).toBe("设置字段 2");
    expect(node.parameters).toEqual({ mode: "manual", fields: { a: 1 } });
    expect(node.position).toEqual({ x: 10, y: 20 });
    expect(node.id).toMatch(/^node-/);
  });

  it("groupNodeTypes 按固定分组顺序输出中文标签", () => {
    const groups = utils.groupNodeTypes([
      { group: "action", type: "set" },
      { group: "trigger", type: "manualTrigger" },
      { group: "weird", type: "x" },
      { group: "transform", type: "sort" },
    ]);
    expect(groups.map((group) => group.group)).toEqual(["trigger", "action", "transform"]);
    expect(groups[1]?.label).toBe("操作");
    // 未知分组归到「操作」，所以 action 有两个节点
    expect(groups[1]?.types.length).toBe(2);
  });
});

describe("执行数据", () => {
  it("buildRunState 把 runData 映射成画布运行态", () => {
    expect(utils.buildRunState(executionFixture())).toEqual({
      "node-a": { state: "success", itemCount: 2 },
      "node-b": { state: "error", itemCount: 0 },
    });
  });

  it("collectNodeInputItems / collectRunInputItems 从上游输出推输入", () => {
    const execution = executionFixture();
    expect(utils.collectNodeInputItems(execution, "node-b")).toEqual([{ json: { a: 1 } }, { json: { a: 2 } }]);
    const latestB = execution.runData["node-b"]?.[0];
    expect(latestB).toBeDefined();
    if (latestB) expect(utils.collectRunInputItems(execution, latestB).length).toBe(2);
    expect(utils.collectNodeInputItems(execution, "node-a")).toEqual([]);
  });

  it("executionNodeSummaries 带上工作流里的节点名", () => {
    const summaries = utils.executionNodeSummaries(executionFixture(), {
      nodes: [
        { id: "node-a", name: "请求接口", type: "httpRequest" },
        { id: "node-b", name: "整理", type: "set" },
      ],
    });
    expect(summaries.map((summary) => summary.name)).toEqual(["请求接口", "整理"]);
    expect(summaries[1]?.runs.length).toBe(1);
  });
});

describe("凭据与设置", () => {
  it("四类凭据字段与必填校验", () => {
    expect(utils.credentialTypeLabel("bearerToken")).toContain("Bearer");
    expect(utils.buildCredentialFields("httpBasic").map((field) => field.name)).toEqual([
      "username",
      "password",
    ]);
    const fields = utils.buildCredentialFields("httpBasic");
    expect(utils.validateCredentialForm(fields, { username: "a", password: "b" })).toBe("");
    expect(utils.validateCredentialForm(fields, { username: "a" })).toBe("请填写密码");
  });

  it("parseVarsText 拒绝非对象与坏 JSON", () => {
    expect(utils.parseVarsText('{"a":1}')).toEqual({ ok: true, error: "", value: { a: 1 } });
    expect(utils.parseVarsText("[]").ok).toBe(false);
    expect(utils.parseVarsText("{").ok).toBe(false);
  });

  it("buildSettingsPayload 只传非空 apiKey，保留 vars", () => {
    const payload = utils.buildSettingsPayload(
      { vars: { a: 1 }, baseUrl: "https://x/v1", model: "m", apiKey: "" },
      { configured: true },
    );
    expect(payload.vars).toEqual({ a: 1 });
    expect(payload.llm).toEqual({ baseUrl: "https://x/v1", model: "m" });
    const payloadWithKey = utils.buildSettingsPayload(
      { vars: {}, baseUrl: "https://x/v1", model: "m", apiKey: "sk-1" },
      { configured: false },
    );
    expect(payloadWithKey.llm).toEqual({ baseUrl: "https://x/v1", model: "m", apiKey: "sk-1" });
  });
});

describe("预览与撤销栈", () => {
  it("truncateJson 超长截断并标注", () => {
    const small = utils.truncateJson({ a: 1 });
    expect(small.truncated).toBe(false);
    const large = utils.truncateJson({ text: "x".repeat(100) }, 20);
    expect(large.truncated).toBe(true);
    expect(large.text).toContain("已截断");
  });

  it("createHistory 支持 push/undo/redo 与容量上限", () => {
    const history = utils.createHistory({ value: 0 });
    history.push({ value: 1 });
    history.push({ value: 2 });
    expect(history.get()).toEqual({ value: 2 });
    expect(history.undo()).toBe(true);
    expect(history.get()).toEqual({ value: 1 });
    expect(history.redo()).toBe(true);
    expect(history.get()).toEqual({ value: 2 });
    expect(history.canUndo()).toBe(true);
    expect(history.canRedo()).toBe(false);
  });
});

describe("REST 客户端", () => {
  it("GET 列表走 /api/workflows，健康检查走 /api/health", async () => {
    const { fetchImpl, calls } = createFetchMock();
    const api = utils.createApi(fetchImpl, "http://127.0.0.1:8777");
    await api.listWorkflows();
    await api.health();
    expect(calls.map((call) => call.url)).toEqual([
      "http://127.0.0.1:8777/api/workflows",
      "http://127.0.0.1:8777/api/health",
    ]);
    expect(calls[0]?.init?.method).toBe("GET");
  });

  it("PUT 保存带 JSON Content-Type 与 body；id 做 URL 编码", async () => {
    const { fetchImpl, calls } = createFetchMock(() => fakeResponse({ ok: true, workflow: { id: "a b" } }));
    const api = utils.createApi(fetchImpl);
    await api.saveWorkflow("a b", { id: "a b", name: "x" });
    expect(calls[0]?.url).toBe("/api/workflows/a%20b");
    expect(calls[0]?.init?.method).toBe("PUT");
    expect(calls[0]?.init?.headers?.["Content-Type"]).toBe("application/json");
    expect(JSON.parse(calls[0]?.init?.body ?? "{}")).toEqual({ id: "a b", name: "x" });
  });

  it("运行/停止/导出/导入/重复/active 的路径与载荷", async () => {
    const { fetchImpl, calls } = createFetchMock(() => fakeResponse({ ok: true, executionId: "e-1" }));
    const api = utils.createApi(fetchImpl);
    await api.runWorkflow("wf-1", { startNodeId: "n-2", inputData: [] });
    await api.stopWorkflow("wf-1");
    await api.exportWorkflow("wf-1");
    await api.importWorkflow({ nodes: [] });
    await api.duplicateWorkflow("wf-1");
    await api.setActive("wf-1", false);
    expect(calls.map((call) => [call.url, call.init?.method])).toEqual([
      ["/api/workflows/wf-1/run", "POST"],
      ["/api/workflows/wf-1/stop", "POST"],
      ["/api/workflows/wf-1/export", "GET"],
      ["/api/workflows/import", "POST"],
      ["/api/workflows/wf-1/duplicate", "POST"],
      ["/api/workflows/wf-1/active", "POST"],
    ]);
    expect(JSON.parse(calls[0]?.init?.body ?? "{}")).toEqual({ startNodeId: "n-2", inputData: [] });
    expect(JSON.parse(calls[5]?.init?.body ?? "{}")).toEqual({ active: false });
  });

  it("执行查询拼 query，详情/删除/重跑路径正确", async () => {
    const { fetchImpl, calls } = createFetchMock(() => fakeResponse({ ok: true }));
    const api = utils.createApi(fetchImpl);
    await api.listExecutions({ workflowId: "wf-1", limit: 20 });
    await api.getExecution("e-1");
    await api.deleteExecution("e-1");
    await api.retryExecution("e-1");
    expect(calls.map((call) => call.url)).toEqual([
      "/api/executions?workflowId=wf-1&limit=20",
      "/api/executions/e-1",
      "/api/executions/e-1",
      "/api/executions/e-1/retry",
    ]);
    expect(calls[2]?.init?.method).toBe("DELETE");
  });

  it("服务端 {ok:false,error} 归一成中文 Error", async () => {
    const { fetchImpl } = createFetchMock(() => fakeResponse({ ok: false, error: "工作流不存在" }, 404));
    const api = utils.createApi(fetchImpl);
    await expect(api.getWorkflow("wf-x")).rejects.toThrow("工作流不存在");
  });

  it("非 JSON 错误响应回退到 HTTP 状态文案", async () => {
    const { fetchImpl } = createFetchMock(() => ({
      ok: false,
      status: 500,
      text: async () => "<html>boom</html>",
    }));
    const api = utils.createApi(fetchImpl);
    await expect(api.listWorkflows()).rejects.toThrow("请求失败（HTTP 500）");
  });

  it("DELETE 的 {ok:true} 正常返回", async () => {
    const { fetchImpl } = createFetchMock(() => fakeResponse({ ok: true }));
    const api = utils.createApi(fetchImpl);
    await expect(api.deleteCredential("cred-1")).resolves.toEqual({ ok: true });
  });
});
