#!/usr/bin/env node
/**
 * 自检探针：起一个真实服务，按「用户/攻击者可能怎么用」逐项探测，全部 PASS 才算通过。
 *
 * 为什么单测之外还要这层：单测按函数边界验证，探针按**网络边界**验证——
 * CORS、路径穿越、请求体上限、沙箱逃逸、并发运行、执行数据体积，都是单测很难覆盖、
 * 但一旦出问题就是安全或稳定性事故的地方。
 *
 * 用法：node scripts/audit-probe.mjs（先 pnpm build）
 */

import { mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { spawn } from "node:child_process";
import { setTimeout as delay } from "node:timers/promises";

const ROOT = resolve(import.meta.dirname, "..");
const PORT = Number(process.env.AUDIT_PORT ?? 8792);
const BASE = `http://127.0.0.1:${PORT}`;
const dataDir = mkdtempSync(join(tmpdir(), "wf-audit-"));
const results = [];

function check(name, ok, detail = "") {
  results.push({ name, ok, detail });
  console.log(`${ok ? "PASS" : "FAIL"}  ${name}${detail ? ` — ${detail}` : ""}`);
}

async function api(path, init = {}) {
  const response = await fetch(`${BASE}${path}`, init);
  const text = await response.text();
  let body = null;
  try {
    body = text ? JSON.parse(text) : null;
  } catch {
    body = text;
  }
  return { status: response.status, headers: response.headers, body, text };
}

function createWorkflowBody(name, nodes, connections) {
  return {
    name,
    nodes,
    connections,
    settings: {
      timezone: "local",
      saveDataSuccessExecution: "all",
      saveDataErrorExecution: "all",
      saveManualExecutions: true,
      callerPolicy: "any",
    },
    active: false,
  };
}

async function main() {
  const child = spawn(process.execPath, [join(ROOT, "dist/server/main.js")], {
    cwd: ROOT,
    env: { ...process.env, WF_PORT: String(PORT), WF_DATA_DIR: dataDir },
    stdio: ["ignore", "pipe", "pipe"],
  });
  let logs = "";
  child.stdout.on("data", (chunk) => (logs += chunk));
  child.stderr.on("data", (chunk) => (logs += chunk));

  try {
    // 等健康检查
    let ready = false;
    for (let i = 0; i < 100 && !ready; i += 1) {
      try {
        ready = (await fetch(`${BASE}/api/health`)).ok;
      } catch {
        await delay(100);
      }
    }
    if (!ready) {
      console.error("服务没有启动：", logs.slice(-800));
      process.exit(1);
    }

    // ---- 1. 网络边界 -----------------------------------------------------
    await checkCors();
    await checkTraversal();
    await checkBodyLimit();

    // ---- 2. MCP 协议 -----------------------------------------------------
    await checkMcp();
    await checkAgentTools();
    await checkWebhook();

    // ---- 3. 沙箱 / 表达式隔离 -------------------------------------------
    await checkSandbox();
    await checkExpressionBlocked();

    // ---- 4. 凭据与执行数据 ----------------------------------------------
    await checkCredentialAtRest();
    await checkExecutionDataCap();

    // ---- 5. 并发 ---------------------------------------------------------
    await checkConcurrentRun();

    const failed = results.filter((item) => !item.ok);
    console.log("");
    console.log(`${results.length - failed.length}/${results.length} 项通过`);
    if (failed.length > 0) {
      console.log("失败项：");
      for (const item of failed) console.log(`  - ${item.name}：${item.detail}`);
      process.exitCode = 1;
    }
  } finally {
    child.kill();
    await delay(200);
    rmSync(dataDir, { recursive: true, force: true });
  }
}

async function checkCors() {
  // 任意网页都能跨域读本机数据 = 数据泄露；必须只回允许的来源（和鸣 app://、本机编辑器）。
  const evil = await api("/api/workflows", { headers: { origin: "https://evil.example" } });
  check(
    "CORS 拒绝陌生来源（GET）",
    evil.status === 403 && !evil.headers.get("access-control-allow-origin"),
    `status=${evil.status} acao=${evil.headers.get("access-control-allow-origin") ?? "无"}`,
  );
  const preflight = await api("/api/workflows", {
    method: "OPTIONS",
    headers: {
      origin: "https://evil.example",
      "access-control-request-method": "POST",
      "access-control-request-headers": "content-type",
    },
  });
  check(
    "CORS 拒绝陌生来源（预检）",
    preflight.status === 403 && !preflight.headers.get("access-control-allow-origin"),
    `status=${preflight.status}`,
  );
  // 和鸣桌面端渲染层的来源（app://heming）与同源请求必须放行
  const appOrigin = await api("/api/workflows", { headers: { origin: "app://heming" } });
  check(
    "CORS 放行和鸣客户端来源（app://heming）",
    appOrigin.status === 200 && Boolean(appOrigin.headers.get("access-control-allow-origin")),
    `status=${appOrigin.status}`,
  );
}

async function checkTraversal() {
  const probes = [
    "/%2e%2e/%2e%2e/package.json",
    "/..%2f..%2fpackage.json",
    "/%2e%2e%5cpackage.json",
    "/static/..%2f..%2fpackage.json",
    "/static/%2e%2e/%2e%2e/package.json",
  ];
  let leaked = "";
  for (const path of probes) {
    const result = await api(path);
    if (result.status === 200 && typeof result.text === "string" && result.text.includes('"name": "heming-workflow-plugin"')) {
      leaked = path;
    }
  }
  check("静态服务不泄露 public/ 之外的文件", leaked === "", leaked || "全部被拒绝");
}

async function checkBodyLimit() {
  const big = "x".repeat(6 * 1024 * 1024);
  const result = await api("/api/workflows", {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ name: big }),
  });
  check("请求体上限 5MB（413）", result.status === 413, `status=${result.status}`);
  const bad = await api("/api/workflows", {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: "{bad json",
  });
  check("坏 JSON 返回 400 而不是崩溃", bad.status === 400, `status=${bad.status}`);
}

async function checkMcp() {
  const init = await api("/mcp", {
    method: "POST",
    headers: { "content-type": "application/json", accept: "application/json, text/event-stream" },
    body: JSON.stringify({
      jsonrpc: "2.0",
      id: 1,
      method: "initialize",
      params: { protocolVersion: "2024-11-05", capabilities: {}, clientInfo: { name: "audit", version: "1" } },
    }),
  });
  const session = init.headers.get("mcp-session-id") ?? "";
  check("MCP initialize + 会话头", init.status === 200 && Boolean(session), `status=${init.status}`);
  const headers = {
    "content-type": "application/json",
    accept: "application/json, text/event-stream",
    origin: "app://heming",
    ...(session ? { "mcp-session-id": session } : {}),
  };
  const tools = await api("/mcp", {
    method: "POST",
    headers,
    body: JSON.stringify({ jsonrpc: "2.0", id: 2, method: "tools/list" }),
  });
  const names = (tools.body?.result?.tools ?? []).map((tool) => tool.name);
  check("MCP tools/list 26 个工具", names.length === 26, `${names.length} 个`);
  const unknown = await api("/mcp", {
    method: "POST",
    headers,
    body: JSON.stringify({ jsonrpc: "2.0", id: 3, method: "no/such" }),
  });
  check("MCP 未知方法 -32601", unknown.body?.error?.code === -32601, JSON.stringify(unknown.body?.error ?? {}));
  const badTool = await api("/mcp", {
    method: "POST",
    headers,
    body: JSON.stringify({ jsonrpc: "2.0", id: 4, method: "tools/call", params: { name: "nope", arguments: {} } }),
  });
  check("MCP 未知工具 -32602", badTool.body?.error?.code === -32602, JSON.stringify(badTool.body?.error ?? {}));
}


/** P0 智能体辅助工具：发现 → 试跑 → 启用 → 外部 MCP 发现。 */
async function checkAgentTools() {
  const init = await api("/mcp", {
    method: "POST",
    headers: { "content-type": "application/json", accept: "application/json, text/event-stream" },
    body: JSON.stringify({
      jsonrpc: "2.0",
      id: 11,
      method: "initialize",
      params: { protocolVersion: "2024-11-05", capabilities: {}, clientInfo: { name: "audit", version: "1" } },
    }),
  });
  const session = init.headers.get("mcp-session-id") ?? "";
  const headers = {
    "content-type": "application/json",
    accept: "application/json, text/event-stream",
    origin: "app://heming",
    ...(session ? { "mcp-session-id": session } : {}),
  };
  let nextId = 20;
  async function call(name, args) {
    const response = await api("/mcp", {
      method: "POST",
      headers,
      body: JSON.stringify({
        jsonrpc: "2.0",
        id: (nextId += 1),
        method: "tools/call",
        params: { name, arguments: args },
      }),
    });
    const text = response.body?.result?.content?.[0]?.text ?? "";
    let parsed = text;
    try {
      parsed = JSON.parse(text);
    } catch {
      /* 纯文本错误 */
    }
    return { isError: response.body?.result?.isError === true, parsed, text };
  }

  // 凭据发现：不返回密钥
  await api("/api/credentials", {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ name: "探针凭据", type: "bearerToken", data: { token: "AUDIT-SECRET" } }),
  });
  const creds = await call("credential_list", {});
  check(
    "credential_list 只回元数据（不含密钥）",
    creds.isError === false && creds.parsed.total >= 1 && !creds.text.includes("AUDIT-SECRET"),
    `total=${creds.parsed.total}`,
  );

  // 节点完整 schema
  const detail = await call("node_type_detail", { type: "httpRequest" });
  const urlProp = (detail.parsed.properties ?? []).find((item) => item.name === "url");
  check("node_type_detail 返回完整参数 schema", detail.isError === false && urlProp?.required === true, `type=${detail.parsed.type}`);

  // 试跑：pinData 不写回
  const created = await api("/api/workflows", {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ name: "探针试跑" }),
  });
  const workflowId = created.body.id;
  const triggerId = "t1";
  const setId = "s1";
  const workflowBody = createWorkflowBody(
    "探针试跑",
    [
      { id: triggerId, name: "手动触发", type: "manualTrigger", position: { x: 80, y: 80 }, parameters: {} },
      {
        id: setId,
        name: "设置字段",
        type: "set",
        position: { x: 340, y: 80 },
        parameters: { mode: "manual", fields: [{ name: "ok", value: true }], includeOtherFields: true },
      },
    ],
    { [triggerId]: { main: [[{ node: setId, type: "main", index: 0 }]] } },
  );
  await api(`/api/workflows/${workflowId}`, {
    method: "PUT",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ ...workflowBody, id: workflowId }),
  });
  const tested = await call("workflow_test", { id: workflowId, pinData: { [triggerId]: [{ json: { seed: 1 } }] } });
  const stored = await api(`/api/workflows/${workflowId}`);
  const storedTrigger = (stored.body.nodes ?? []).find((node) => node.id === triggerId);
  check(
    "workflow_test 用 pinData 试跑且不写回工作流",
    tested.isError === false && tested.parsed.status === "success" && storedTrigger?.pinData === undefined,
    `status=${tested.parsed.status}`,
  );

  // 启停
  const scheduleWorkflow = createWorkflowBody(
    "探针定时",
    [
      {
        id: "sch1",
        name: "定时触发",
        type: "scheduleTrigger",
        position: { x: 80, y: 80 },
        parameters: { triggerInterval: "days", intervalCount: 1, triggerAtHour: 9, triggerAtMinute: 0 },
      },
    ],
    {},
  );
  const createdSchedule = await api("/api/workflows", {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify(scheduleWorkflow),
  });
  const activated = await call("workflow_set_active", { id: createdSchedule.body.id, active: true });
  check(
    "workflow_set_active 启用定时工作流",
    activated.isError === false && activated.parsed.active === true,
    `active=${activated.parsed.active}`,
  );
  await call("workflow_set_active", { id: createdSchedule.body.id, active: false });

  // 外部 MCP 发现（用本服务自测）
  const discovered = await call("mcp_list_tools", { url: `${BASE}/mcp` });
  check(
    "mcp_list_tools 发现本服务 26 个工具",
    discovered.isError === false && discovered.parsed.total === 26,
    `total=${discovered.parsed.total}`,
  );

  // 搜索：按标签定位
  const tagged = await api(`/api/workflows/${workflowId}`, {
    method: "PUT",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ ...workflowBody, id: workflowId, name: "探针试跑", tags: ["探针"] }),
  });
  void tagged;
  const searched = await call("workflow_search", { tags: ["探针"] });
  check(
    "workflow_search 按标签定位工作流",
    searched.isError === false && (searched.parsed.workflows ?? []).some((item) => item.id === workflowId),
    `total=${searched.parsed.total}`,
  );

  // 执行详情：脱敏 + 逐节点数据
  const executionDetail = await call("workflow_execution_detail", { executionId: tested.parsed.executionId });
  const detailNodes = executionDetail.parsed.nodes ?? [];
  check(
    "workflow_execution_detail 返回脱敏逐节点数据",
    executionDetail.isError === false && executionDetail.parsed.redacted === true && detailNodes.length > 0,
    `nodes=${detailNodes.length}`,
  );

  // 版本历史 + 恢复
  await api(`/api/workflows/${workflowId}`, {
    method: "PUT",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ ...workflowBody, id: workflowId, name: "探针版本乙" }),
  });
  const versions = await call("workflow_versions", { id: workflowId });
  const latestVersion = (versions.parsed.versions ?? [])[0];
  const restored = latestVersion
    ? await call("workflow_restore", { id: workflowId, versionId: latestVersion.versionId })
    : { isError: true, parsed: {} };
  check(
    "版本历史与恢复可用",
    versions.isError === false && (versions.parsed.total ?? 0) > 0 && restored.isError === false && restored.parsed.ok === true,
    `versions=${versions.parsed.total}`,
  );

  // SDK 参考
  const sdk = await call("workflow_sdk_reference", { topic: "expressions" });
  check(
    "workflow_sdk_reference 返回规范参考",
    sdk.isError === false && sdk.parsed.topic === "expressions" && String(sdk.parsed.content).includes("$json"),
    `topic=${sdk.parsed.topic}`,
  );
}


/** Webhook 触发器：真实执行一次，验证请求体进入数据流。 */
async function checkWebhook() {
  const workflowBody = createWorkflowBody(
    "探针 Webhook",
    [
      {
        id: "wh1",
        name: "Webhook 触发",
        type: "webhookTrigger",
        position: { x: 80, y: 80 },
        parameters: { path: "", method: "POST" },
      },
      {
        id: "s1",
        name: "设置字段",
        type: "set",
        position: { x: 340, y: 80 },
        parameters: { mode: "manual", fields: [{ name: "ok", value: true }], includeOtherFields: true },
      },
    ],
    { wh1: { main: [[{ node: "s1", type: "main", index: 0 }]] } },
  );
  const created = await api("/api/workflows", {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ name: "探针 Webhook" }),
  });
  const workflowId = created.body.id;
  const saved = await api(`/api/workflows/${workflowId}`, {
    method: "PUT",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ ...workflowBody, id: workflowId }),
  });
  check("探针 Webhook 工作流保存成功", saved.status === 200, `status=${saved.status}`);
  await api(`/api/workflows/${workflowId}/active`, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ active: true }),
  });

  const triggered = await fetch(`${BASE}/webhook/${workflowId}`, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ hello: "webhook" }),
  });
  const triggerBody = await triggered.json();
  const executionId = triggerBody.executionId;

  let execution = null;
  for (let i = 0; i < 80 && executionId; i += 1) {
    const detail = await api(`/api/executions/${executionId}`);
    if (detail.body?.status && detail.body.status !== "running") {
      execution = detail.body;
      break;
    }
    await new Promise((resolve) => setTimeout(resolve, 50));
  }
  const setRun = execution?.runData?.s1?.[0];
  check(
    "Webhook 触发执行且请求体进入数据流",
    triggered.status === 202 && execution?.status === "success" && setRun?.data?.main?.[0]?.[0]?.json?.hello === "webhook",
    `http=${triggered.status} status=${execution?.status}`,
  );

  await api(`/api/workflows/${workflowId}/active`, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ active: false }),
  });
  const inactive = await fetch(`${BASE}/webhook/${workflowId}`, { method: "POST", body: "{}" });
  check("停用后 Webhook 返回 404", inactive.status === 404, `http=${inactive.status}`);
}

/** 建一条「手动触发 → 代码」的工作流并跑一次，返回执行结果。 */
async function runCodeWorkflow(name, code) {
  const created = await api("/api/workflows", {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ name }),
  });
  const workflowId = created.body.id;
  const triggerId = "t1";
  const codeId = "c1";
  const body = createWorkflowBody(
    name,
    [
      { id: triggerId, name: "手动触发", type: "manualTrigger", position: { x: 80, y: 80 }, parameters: {} },
      {
        id: codeId,
        name: "代码",
        type: "code",
        position: { x: 340, y: 80 },
        parameters: { mode: "runOnceForAllItems", code },
      },
    ],
    { [triggerId]: { main: [[{ node: codeId, type: "main", index: 0 }]] } },
  );
  await api(`/api/workflows/${workflowId}`, {
    method: "PUT",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ ...body, id: workflowId }),
  });
  const run = await api(`/api/workflows/${workflowId}/run`, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({}),
  });
  const executionId = run.body?.executionId;
  let execution = null;
  for (let i = 0; i < 100; i += 1) {
    const result = await api(`/api/executions/${executionId}`);
    execution = result.body;
    if (execution && execution.status !== "running" && execution.status !== "new") break;
    await delay(100);
  }
  return { workflowId, codeId, execution };
}

async function checkSandbox() {
  const result = await runCodeWorkflow(
    "沙箱探测",
    "return [{ json: { processType: typeof process, requireType: typeof require, fetchType: typeof fetch, fsType: typeof require === 'function' ? 'has-require' : 'undefined' } }];",
  );
  const json = result.execution?.runData?.[result.codeId]?.[0]?.data?.main?.[0]?.[0]?.json ?? {};
  check(
    "代码沙箱里 process/require/fetch 都不可达",
    json.processType === "undefined" && json.requireType === "undefined" && json.fetchType === "undefined",
    JSON.stringify(json),
  );
  const escape = await runCodeWorkflow(
    "沙箱逃逸尝试",
    "const make = globalThis.constructor.constructor; const p = make('return typeof process')(); const r = make('return typeof require')(); return [{ json: { p, r } }];",
  );
  const escapedJson = escape.execution?.runData?.[escape.codeId]?.[0]?.data?.main?.[0]?.[0]?.json ?? {};
  check(
    "vm 构造器逃逸拿不到宿主 process/require",
    escape.execution?.status === "success" && escapedJson.p === "undefined" && escapedJson.r === "undefined",
    JSON.stringify(escapedJson),
  );
  const health = await api("/api/health");
  check("沙箱探测后服务仍然健康", health.status === 200, `status=${health.status}`);
}

async function checkExpressionBlocked() {
  const created = await api("/api/workflows", {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ name: "表达式逃逸" }),
  });
  const workflowId = created.body.id;
  const triggerId = "t1";
  const setId = "s1";
  const body = createWorkflowBody(
    "表达式逃逸",
    [
      { id: triggerId, name: "手动触发", type: "manualTrigger", position: { x: 80, y: 80 }, parameters: {} },
      {
        id: setId,
        name: "设置字段",
        type: "set",
        position: { x: 340, y: 80 },
        parameters: {
          mode: "manual",
          fields: [{ name: "x", value: "{{ ({}).constructor.constructor('return process')().version }}" }],
          includeOtherFields: true,
        },
      },
    ],
    { [triggerId]: { main: [[{ node: setId, type: "main", index: 0 }]] } },
  );
  await api(`/api/workflows/${workflowId}`, {
    method: "PUT",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ ...body, id: workflowId }),
  });
  const run = await api(`/api/workflows/${workflowId}/run`, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({}),
  });
  let execution = null;
  for (let i = 0; i < 100; i += 1) {
    const result = await api(`/api/executions/${run.body?.executionId}`);
    execution = result.body;
    if (execution && execution.status !== "running" && execution.status !== "new") break;
    await delay(100);
  }
  check(
    "表达式里的 constructor 逃逸被拒绝（执行报错）",
    execution?.status === "error" && /constructor|不安全|不允许|不存在/.test(JSON.stringify(execution.error ?? {})),
    execution?.status ?? "无结果",
  );
}

async function checkCredentialAtRest() {
  const created = await api("/api/credentials", {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ name: "审计凭据", type: "bearerToken", data: { token: "SECRET-AUDIT-TOKEN" } }),
  });
  let onDisk = "";
  try {
    onDisk = readFileSync(join(dataDir, "credentials.json"), "utf8");
  } catch {
    onDisk = "";
  }
  check(
    "凭据落盘为密文（明文 token 不出现）",
    created.status === 200 && onDisk.length > 0 && !onDisk.includes("SECRET-AUDIT-TOKEN"),
    `status=${created.status}`,
  );
}

async function checkExecutionDataCap() {
  const big = "A".repeat(300 * 1024);
  const result = await runCodeWorkflow("超大执行数据", `return [{ json: { big: "${big}" } }];`);
  const recorded = result.execution?.runData?.[result.codeId]?.[0]?.data?.main?.[0]?.[0]?.json ?? {};
  const bytes = Buffer.byteLength(JSON.stringify(recorded), "utf8");
  check(
    "单条执行数据的 json 有体积上限（≤64KB 并标注截断）",
    recorded.__hemingTruncated === true && bytes <= 64 * 1024 + 1024,
    `标记=${String(recorded.__hemingTruncated)} 记录字节=${bytes}`,
  );
}

async function checkConcurrentRun() {
  const created = await api("/api/workflows", {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ name: "并发探测" }),
  });
  const workflowId = created.body.id;
  const triggerId = "t1";
  const waitId = "w1";
  const body = createWorkflowBody(
    "并发探测",
    [
      { id: triggerId, name: "手动触发", type: "manualTrigger", position: { x: 80, y: 80 }, parameters: {} },
      {
        id: waitId,
        name: "等待",
        type: "wait",
        position: { x: 340, y: 80 },
        parameters: { amount: 2, unit: "seconds" },
      },
    ],
    { [triggerId]: { main: [[{ node: waitId, type: "main", index: 0 }]] } },
  );
  await api(`/api/workflows/${workflowId}`, {
    method: "PUT",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ ...body, id: workflowId }),
  });
  const first = await api(`/api/workflows/${workflowId}/run`, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({}),
  });
  const second = await api(`/api/workflows/${workflowId}/run`, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({}),
  });
  check(
    "同一工作流并发运行被拒绝",
    first.status === 200 && second.status >= 400 && second.status < 500,
    `first=${first.status} second=${second.status}`,
  );
  await api(`/api/workflows/${workflowId}/stop`, { method: "POST" });
}

main().catch((error) => {
  console.error(String(error?.stack ?? error));
  process.exit(1);
});
