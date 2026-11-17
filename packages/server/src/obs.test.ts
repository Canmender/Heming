import { describe, it, expect, beforeEach, afterEach } from "vitest";
import request from "supertest";
import { randomUUID } from "node:crypto";
import { createMemoryStore } from "./store.js";
import { createApp } from "./app.js";
import { isLoopbackAddress, normalizeRoute } from "./obs.js";

type App = ReturnType<typeof createApp>;

/** finish 事件在响应写完后才触发：测试里等一小会儿再断言日志/指标。 */
async function tick(): Promise<void> {
  await new Promise((resolve) => setTimeout(resolve, 10));
}

async function register(app: App, username: string) {
  const res = await request(app).post("/api/auth/register").send({
    username,
    password: "secret123",
    displayName: username.toUpperCase(),
  });
  expect(res.status).toBe(201);
  return res.body as { token: string; user: { id: string; username: string } };
}

describe("可观测性纯函数", () => {
  it("normalizeRoute：数字段与 uuid 段归一成 :id", () => {
    expect(normalizeRoute("/api/teams/42/tasks/7")).toBe("/api/teams/:id/tasks/:id");
    expect(normalizeRoute(`/api/conversations/${randomUUID()}/messages`)).toBe(
      "/api/conversations/:id/messages",
    );
    expect(normalizeRoute("/api/health")).toBe("/api/health");
    // 非纯数字/非 uuid 的段保持原样（比如版本号、用户名路径）
    expect(normalizeRoute("/api/plugins/foo/1.2.3/manifest")).toBe(
      "/api/plugins/foo/1.2.3/manifest",
    );
  });

  it("isLoopbackAddress：127/8、::1、::ffff:127.x 为真，公网地址为假", () => {
    expect(isLoopbackAddress("127.0.0.1")).toBe(true);
    expect(isLoopbackAddress("127.9.8.7")).toBe(true);
    expect(isLoopbackAddress("::1")).toBe(true);
    expect(isLoopbackAddress("::ffff:127.0.0.1")).toBe(true);
    expect(isLoopbackAddress("8.8.8.8")).toBe(false);
    expect(isLoopbackAddress("::ffff:8.8.8.8")).toBe(false);
    expect(isLoopbackAddress(undefined)).toBe(false);
  });
});

describe("request id 与结构化日志（d.236）", () => {
  let app: App;
  let store: ReturnType<typeof createMemoryStore>;
  const lines: Array<Record<string, unknown>> = [];

  beforeEach(() => {
    lines.length = 0;
    store = createMemoryStore();
    app = createApp(store, {
      allowRegister: true,
      logger: (line) => lines.push(JSON.parse(line) as Record<string, unknown>),
    });
  });

  it("请求头带 x-request-id 时透传并回写；不带时生成", async () => {
    const passed = await request(app).get("/api/health").set("x-request-id", "trace-abc");
    expect(passed.status).toBe(200);
    expect(passed.headers["x-request-id"]).toBe("trace-abc");

    const generated = await request(app).get("/api/health");
    expect(generated.headers["x-request-id"]).toMatch(
      /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i,
    );
  });

  it("每个请求一行 JSON：固定字段、不打印 token/body，登录后带 userId", async () => {
    const a = await register(app, "alice");
    lines.length = 0;

    await request(app)
      .get("/api/me")
      .set("Authorization", `Bearer ${a.token}`)
      .set("x-request-id", "rid-1");
    await tick();

    const entry = lines.find((x) => x.path === "/api/me");
    expect(entry).toBeDefined();
    expect(entry).toMatchObject({
      level: "info",
      requestId: "rid-1",
      method: "GET",
      path: "/api/me",
      status: 200,
      userId: a.user.id,
    });
    expect(typeof entry!.ts).toBe("string");
    expect(typeof entry!.ms).toBe("number");
    // 字段白名单：token 不可能出现在日志里（没有 body/header 的通道）。
    expect(Object.keys(entry!).sort()).toEqual(
      ["level", "method", "ms", "path", "requestId", "status", "ts", "userId"].sort(),
    );
    expect(JSON.stringify(entry)).not.toContain(a.token);
  });

  it("失败请求同样记录状态码段对应的 level", async () => {
    await request(app).get("/api/me");
    await request(app).get("/api/no-such-route");
    await tick();
    expect(lines.find((x) => x.path === "/api/me")?.level).toBe("warn");
    expect(lines.find((x) => x.path === "/api/no-such-route")?.level).toBe("warn");
  });
});

describe("GET /api/metrics（d.236）", () => {
  const ENV = "HEMING_METRICS_TOKEN";
  let saved: string | undefined;

  beforeEach(() => {
    saved = process.env[ENV];
    delete process.env[ENV];
  });
  afterEach(() => {
    if (saved === undefined) delete process.env[ENV];
    else process.env[ENV] = saved;
  });

  it("内存指标：总数、状态码段、归一化路由、p50/p95、错误数", async () => {
    const app = createApp(createMemoryStore(), { allowRegister: true });
    const a = await register(app, "alice");
    await request(app).get("/api/health");
    await request(app).get("/api/no-such-route");
    // 带 uuid 的路由要归一，否则每个会话 id 都会单独占一条
    await request(app)
      .get(`/api/conversations/${randomUUID()}/messages`)
      .set("Authorization", `Bearer ${a.token}`);
    await tick();

    const res = await request(app).get("/api/metrics");
    expect(res.status).toBe(200);
    expect(res.body.requests.total).toBeGreaterThanOrEqual(4);
    expect(res.body.requests.byStatus["2xx"]).toBeGreaterThanOrEqual(2); // 注册 201 + health 200
    expect(res.body.requests.byStatus["4xx"]).toBeGreaterThanOrEqual(2); // 404 + 403
    expect(res.body.requests.errors).toBe(0);
    expect(res.body.requests.byRoute["GET /api/health"]).toBe(1);
    expect(res.body.requests.byRoute["POST /api/auth/register"]).toBe(1);
    expect(res.body.requests.byRoute["GET /api/conversations/:id/messages"]).toBe(1);
    expect(typeof res.body.latencyMs.p50).toBe("number");
    expect(typeof res.body.latencyMs.p95).toBe("number");
    expect(res.body.latencyMs.p95).toBeGreaterThanOrEqual(res.body.latencyMs.p50);
  });

  it("未配置令牌：回环地址可读（supertest 即回环）", async () => {
    const app = createApp(createMemoryStore());
    const res = await request(app).get("/api/metrics");
    expect(res.status).toBe(200);
  });

  it("配置 HEMING_METRICS_TOKEN：缺失/错误一律 404（不暴露存在性），正确才 200", async () => {
    process.env[ENV] = "metrics-secret";
    const app = createApp(createMemoryStore());
    try {
      const missing = await request(app).get("/api/metrics");
      expect(missing.status).toBe(404);
      expect(missing.body).toEqual({ error: "接口不存在" });

      const wrong = await request(app)
        .get("/api/metrics")
        .set("Authorization", "Bearer not-the-token");
      expect(wrong.status).toBe(404);

      const ok = await request(app)
        .get("/api/metrics")
        .set("Authorization", "Bearer metrics-secret");
      expect(ok.status).toBe(200);
      expect(ok.body.requests.total).toBeGreaterThanOrEqual(1);
    } finally {
      delete process.env[ENV];
    }
  });
});
