#!/usr/bin/env node
/**
 * 端到端冒烟：起一个真实服务子进程 → 建工作流 → 运行 → 轮询结果 → 走一遍 MCP。
 *
 * 为什么要有它：单测证明「零件对」，这个脚本证明「装起来能跑」——配置、存储、
 * HTTP、引擎、节点、MCP 全链路，且不需要打开浏览器。
 *
 * 用法（先 pnpm build）：node scripts/smoke.mjs
 */

import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { spawn } from "node:child_process";
import { setTimeout as delay } from "node:timers/promises";

const ROOT = resolve(import.meta.dirname, "..");
const PORT = Number(process.env.SMOKE_PORT ?? 8799);
const BASE = `http://127.0.0.1:${PORT}`;
const dataDir = mkdtempSync(join(tmpdir(), "wf-smoke-"));

const results = [];
function check(name, ok, detail = "") {
  results.push({ name, ok, detail });
  console.log(`${ok ? "PASS" : "FAIL"}  ${name}${detail ? ` — ${detail}` : ""}`);
  if (!ok) throw new Error(`冒烟失败：${name} ${detail}`);
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
    // 1) 等健康检查
    let health = null;
    for (let i = 0; i < 100; i += 1) {
      try {
        const response = await fetch(`${BASE}/api/health`);
        if (response.ok) {
          health = await response.json();
          break;
        }
      } catch {
        /* 还没起来 */
      }
      await delay(100);
    }
    check("服务启动 + /api/health", Boolean(health?.ok), health ? `version=${health.version}` : logs.slice(-500));

    // 2) 节点类型与模板可用
    const nodeTypes = await (await fetch(`${BASE}/api/node-types`)).json();
    check("GET /api/node-types 返回节点清单", Array.isArray(nodeTypes) && nodeTypes.length >= 20, `${nodeTypes.length} 个节点`);
    const templates = await (await fetch(`${BASE}/api/templates`)).json();
    check("GET /api/templates 返回模板", Array.isArray(templates) && templates.length >= 3, `${templates.length} 个模板`);

    // 3) 建一条最小工作流：手动触发 → 设置字段
    const created = await (
      await fetch(`${BASE}/api/workflows`, {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ name: "冒烟工作流" }),
      })
    ).json();
    const workflowId = created.id;
    check("POST /api/workflows 建工作流", Boolean(workflowId), workflowId);

    const triggerId = "smoke-trigger";
    const setId = "smoke-set";
    const workflow = {
      ...created,
      nodes: [
        { id: triggerId, name: "手动触发", type: "manualTrigger", position: { x: 80, y: 80 }, parameters: {} },
        {
          id: setId,
          name: "写一个字段",
          type: "set",
          position: { x: 340, y: 80 },
          parameters: {
            mode: "manual",
            fields: [{ name: "hello", value: "world" }],
            includeOtherFields: true,
          },
        },
      ],
      connections: { [triggerId]: { main: [[{ node: setId, type: "main", index: 0 }]] } },
    };
    const saved = await (
      await fetch(`${BASE}/api/workflows/${workflowId}`, {
        method: "PUT",
        headers: { "content-type": "application/json" },
        body: JSON.stringify(workflow),
      })
    ).json();
    check("PUT /api/workflows/:id 保存并校验", saved.ok === true, JSON.stringify(saved.issues ?? saved.error ?? ""));
    check("导出为类 n8n JSON", await exportLooksLikeN8n(workflowId));

    // 4) 运行 + 轮询
    const run = await (
      await fetch(`${BASE}/api/workflows/${workflowId}/run`, {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({}),
      })
    ).json();
    check("POST /api/workflows/:id/run 异步启动", Boolean(run.executionId), run.executionId);
    let execution = null;
    for (let i = 0; i < 100; i += 1) {
      execution = await (await fetch(`${BASE}/api/executions/${run.executionId}`)).json();
      if (execution.status !== "running" && execution.status !== "new") break;
      await delay(100);
    }
    check("执行结束且成功", execution?.status === "success", execution?.status ?? "无记录");
    const setRun = execution.runData?.[setId]?.[0];
    check(
      "执行数据里能看到设置后的字段",
      setRun?.data?.main?.[0]?.[0]?.json?.hello === "world",
      JSON.stringify(setRun?.data?.main?.[0]?.[0]?.json ?? null),
    );

    // 5) MCP 握手 + 工具清单 + 调一个只读工具
    const initResponse = await fetch(`${BASE}/mcp`, {
      method: "POST",
      headers: { "content-type": "application/json", accept: "application/json, text/event-stream" },
      body: JSON.stringify({
        jsonrpc: "2.0",
        id: 1,
        method: "initialize",
        params: { protocolVersion: "2024-11-05", capabilities: {}, clientInfo: { name: "smoke", version: "1" } },
      }),
    });
    const sessionId = initResponse.headers.get("mcp-session-id");
    const initBody = await initResponse.json();
    check("MCP initialize", Boolean(initBody.result?.serverInfo), initBody.result?.serverInfo?.name ?? "");
    check("MCP 返回会话头", Boolean(sessionId), sessionId ?? "");

    const headers = {
      "content-type": "application/json",
      accept: "application/json, text/event-stream",
      ...(sessionId ? { "mcp-session-id": sessionId } : {}),
    };
    await fetch(`${BASE}/mcp`, {
      method: "POST",
      headers,
      body: JSON.stringify({ jsonrpc: "2.0", method: "notifications/initialized" }),
    });
    const tools = await (
      await fetch(`${BASE}/mcp`, {
        method: "POST",
        headers,
        body: JSON.stringify({ jsonrpc: "2.0", id: 2, method: "tools/list" }),
      })
    ).json();
    const toolNames = (tools.result?.tools ?? []).map((tool) => tool.name);
    check("MCP tools/list 覆盖工作流工具", toolNames.includes("workflow_list") && toolNames.includes("workflow_run"), `${toolNames.length} 个工具`);

    const called = await (
      await fetch(`${BASE}/mcp`, {
        method: "POST",
        headers,
        body: JSON.stringify({
          jsonrpc: "2.0",
          id: 3,
          method: "tools/call",
          params: { name: "workflow_list", arguments: {} },
        }),
      })
    ).json();
    const text = called.result?.content?.[0]?.text ?? "";
    check("MCP tools/call workflow_list", called.result?.isError !== true && text.includes("冒烟工作流"), text.slice(0, 120));

    // 6) 删除工作流（级联删执行记录）
    const removed = await (await fetch(`${BASE}/api/workflows/${workflowId}`, { method: "DELETE" })).json();
    check("DELETE /api/workflows/:id", removed.ok === true);

    console.log(`\n全部通过：${results.length} 项检查。`);
  } finally {
    child.kill();
    await delay(200);
    try {
      rmSync(dataDir, { recursive: true, force: true });
    } catch {
      /* Windows 上文件可能还被占用，忽略 */
    }
  }
}

async function exportLooksLikeN8n(workflowId) {
  const exported = await (await fetch(`${BASE}/api/workflows/${workflowId}/export`)).json();
  const nodes = exported.nodes ?? [];
  return (
    Array.isArray(nodes) &&
    nodes.every((node) => typeof node.name === "string" && typeof node.type === "string") &&
    typeof exported.connections === "object"
  );
}

main().catch((error) => {
  console.error(String(error?.stack ?? error));
  process.exit(1);
});
