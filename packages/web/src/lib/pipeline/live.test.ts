/**
 * 跨语言契约：桌面端客户端 ↔ 真正的流式服务进程。
 *
 * 两边各有单测：Python 侧用 TestClient，TS 侧用假 fetch。但「真进程 + 真 HTTP + 真 JSON 字段」
 * 这一层没测过——字段名改一处（`stop_reason` vs `stopReason`、`pending_approvals` 拼错）两边单测
 * 各自都能过，直到接起来才发现。这里起一个真的 `agent_pipeline.runner serve` 子进程，
 * 上游换成本文件的假 OpenAI 兼容服务（按 system 提示词回 JSON），再用
 * `createPipelineClient` 跑完一次完整任务。
 *
 * 需要 services/agent-pipeline/.venv（本机开发机有）；没有就跳过，不让 CI 变红。
 */
import { spawn, type ChildProcess } from "node:child_process";
import { createServer, type Server } from "node:http";
import { mkdtempSync, existsSync, rmSync } from "node:fs";
import { join, resolve } from "node:path";
import { afterAll, beforeAll, describe, expect, it } from "vitest";

const REPO = resolve(__dirname, "../../../../../");
const SERVICE_DIR = join(REPO, "services", "agent-pipeline");
const PYTHON = join(SERVICE_DIR, ".venv", "Scripts", "python.exe");
const HAS_PYTHON = existsSync(PYTHON);

function promptOf(messages: { role: string; content: string }[]): string {
  return messages
    .filter((m) => m.role === "system")
    .map((m) => m.content)
    .join("\n");
}

/** 假的上游模型：按 system 提示词判断当前节点，回合法的 JSON。 */
function startUpstream(): Promise<{ server: Server; port: number }> {
  const server = createServer((req, res) => {
    let body = "";
    req.on("data", (chunk) => (body += chunk));
    req.on("end", () => {
      let payload: { messages?: { role: string; content: string }[] } = {};
      try {
        payload = JSON.parse(body);
      } catch {
        /* 保持空 */
      }
      const system = promptOf(payload.messages ?? []);
      let content = "";
      if (system.includes("规划者")) {
        content = JSON.stringify({ steps: [{ goal: "确认版本号", done_when: "看到版本号" }] });
      } else if (system.includes("执行者")) {
        content = "版本号是 d.140.3.54.10，不需要工具";
      } else if (system.includes("反思者")) {
        content = JSON.stringify({ verdict: "done", reasons: ["任务已确认"], lessons: ["先确认版本再改"] });
      } else if (system.includes("评审者")) {
        content = JSON.stringify({ score: 0.95, blocking_issues: [], suggestions: [] });
      } else if (system.includes("实现者") || system.includes("测试者")) {
        content = JSON.stringify({ summary: "无改动", patch: "" });
      } else {
        content = JSON.stringify({ answer: "版本号是 d.140.3.54.10", citations: [] });
      }
      res.writeHead(200, { "content-type": "application/json" });
      res.end(
        JSON.stringify({
          id: "chatcmpl-test",
          object: "chat.completion",
          model: "test-model",
          choices: [{ index: 0, message: { role: "assistant", content }, finish_reason: "stop" }],
          usage: { prompt_tokens: 12, completion_tokens: 8, total_tokens: 20 },
        }),
      );
    });
  });
  return new Promise((resolvePromise) => {
    server.listen(0, "127.0.0.1", () => {
      const address = server.address();
      const port = typeof address === "object" && address ? address.port : 0;
      resolvePromise({ server, port });
    });
  });
}

async function waitHealthy(baseUrl: string, timeoutMs = 30_000): Promise<void> {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    try {
      const response = await fetch(`${baseUrl}/health`);
      if (response.ok) return;
    } catch {
      /* 还没起来 */
    }
    await new Promise((r) => setTimeout(r, 150));
  }
  throw new Error(`服务在 ${timeoutMs}ms 内没有健康`);
}

describe.skipIf(!HAS_PYTHON)("流水线客户端 ↔ 真服务（跨语言）", () => {
  let upstream: Server;
  let service: ChildProcess;
  let serviceUrl: string;
  let workDir: string;

  beforeAll(async () => {
    upstream = (await startUpstream()).server;
    const upstreamPort = (upstream.address() as { port: number }).port;
    // 不要用 os.tmpdir()：本机沙箱下 %TEMP% 对子进程不可写（sqlite 会 unable to open database file）。
    workDir = mkdtempSync(join(REPO, ".tmp-pipeline-live-"));

    // 选一个空闲端口给服务
    const probe = createServer();
    const servicePort = await new Promise<number>((resolvePromise) => {
      probe.listen(0, "127.0.0.1", () => {
        const port = (probe.address() as { port: number }).port;
        probe.close(() => resolvePromise(port));
      });
    });
    serviceUrl = `http://127.0.0.1:${servicePort}`;

    service = spawn(PYTHON, ["-m", "agent_pipeline.runner", "serve", "--port", String(servicePort)], {
      cwd: SERVICE_DIR,
      env: {
        ...process.env,
        AGENT_PIPELINE_BASE_URL: `http://127.0.0.1:${upstreamPort}/v1`,
        AGENT_PIPELINE_API_KEY: "test-key",
        AGENT_PIPELINE_MODEL: "test-model",
        AGENT_SERVICE_TOKEN: "live-token",
        AGENT_LOG_PATH: join(workDir, "runs.jsonl"),
        AGENT_PIPELINE_DB: join(workDir, "pipeline.db"),
        AGENT_COVERAGE_TARGET: "0.9",
      },
      stdio: "ignore",
    });
    await waitHealthy(serviceUrl);
  }, 40_000);

  afterAll(async () => {
    // Windows 上 python 退出后 SQLite 句柄还会占用一小会儿：先等进程真的退，
    // 再重试删除。否则测试跑一次就在仓库根留一个 .tmp-pipeline-live-* 目录。
    if (service && service.exitCode === null) {
      const exited = new Promise<void>((resolvePromise) => {
        service.once("exit", () => resolvePromise());
        service.kill();
      });
      await Promise.race([exited, new Promise((r) => setTimeout(r, 3000))]);
    }
    upstream?.close();
    for (let attempt = 0; attempt < 10; attempt += 1) {
      try {
        rmSync(workDir, { recursive: true, force: true });
        return;
      } catch {
        await new Promise((r) => setTimeout(r, 150));
      }
    }
    /* 还被占用就留着：`.gitignore` 已忽略这个前缀，不影响仓库状态 */
  });

  it("提交任务 → 轮询到 ok → 读到 answer/stop_reason/llm_calls", async () => {
    const { createPipelineClient } = await import("./client.js");
    const client = createPipelineClient({ baseUrl: serviceUrl, apiKey: "live-token", pollIntervalMs: 50 });

    const run = await client.run({
      goal: "确认当前版本号",
      runId: `live-${Date.now()}`,
      mode: "react",
    });

    expect(run.status).toBe("ok");
    expect(run.answer).toContain("d.140.3.54.10");
    // 服务端字段必须被客户端正确读成 camelCase（stop_reason → stopReason）
    expect(run.stopReason).toBeNull();
    expect(run.llmCalls).toBeGreaterThanOrEqual(4);
    expect(run.tokens).toBeGreaterThan(0);
  }, 40_000);

  it("health 说得出自己的工具与限额", async () => {
    const { createPipelineClient } = await import("./client.js");
    const client = createPipelineClient({ baseUrl: serviceUrl, apiKey: "live-token" });
    const health = await client.health();
    expect(health.running).toBe(0);
    expect(health.tools).toContain("knowledge_search");
  }, 15_000);

  it("服务端开了入站鉴权：不带令牌的客户端被 401，且说得出该配哪个环境变量", async () => {
    const { createPipelineClient, PipelineError } = await import("./client.js");
    const client = createPipelineClient({ baseUrl: serviceUrl, pollIntervalMs: 20 });

    const error = await client
      .run({ goal: "确认当前版本号", runId: `live-auth-${Date.now()}`, mode: "react" })
      .then(() => null)
      .catch((err: unknown) => err);

    expect(error).toBeInstanceOf(PipelineError);
    const failure = error as InstanceType<typeof PipelineError>;
    expect(failure.kind).toBe("http");
    expect(failure.status).toBe(401);
    expect(failure.detail).toContain("AGENT_SERVICE_TOKEN");
  }, 20_000);
});