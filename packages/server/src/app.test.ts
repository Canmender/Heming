import { describe, it, expect, beforeEach, afterEach } from "vitest";
import request from "supertest";
import type { Conversation } from "@heming/shared";
import { createMemoryStore } from "./store.js";
import { createApp } from "./app.js";

type App = ReturnType<typeof createApp>;

async function register(app: App, username: string) {
  const res = await request(app).post("/api/auth/register").send({
    username,
    password: "secret123",
    displayName: username.toUpperCase(),
  });
  expect(res.status).toBe(201);
  return res.body as { token: string; user: { id: string; username: string } };
}

describe("公开注册门控", () => {
  const ENV = "HEMING_ALLOW_REGISTER";
  let saved: string | undefined;

  beforeEach(() => {
    saved = process.env[ENV];
    delete process.env[ENV];
  });
  afterEach(() => {
    if (saved === undefined) delete process.env[ENV];
    else process.env[ENV] = saved;
  });

  const regBody = { username: "alice", password: "secret123", displayName: "Alice" };

  it("默认注册关闭：403 registration disabled", async () => {
    const app = createApp(createMemoryStore());
    const res = await request(app).post("/api/auth/register").send(regBody);
    expect(res.status).toBe(403);
    expect(res.body).toEqual({ error: "registration disabled" });
  });

  it("opts.allowRegister=true 时可注册", async () => {
    const app = createApp(createMemoryStore(), { allowRegister: true });
    const res = await request(app).post("/api/auth/register").send(regBody);
    expect(res.status).toBe(201);
  });

  it("HEMING_ALLOW_REGISTER=1 时可注册", async () => {
    process.env[ENV] = "1";
    const app = createApp(createMemoryStore());
    const res = await request(app).post("/api/auth/register").send(regBody);
    expect(res.status).toBe(201);
  });

  it("HEMING_ALLOW_REGISTER=true（大小写不敏感）时可注册", async () => {
    process.env[ENV] = "TRUE";
    const app = createApp(createMemoryStore());
    const res = await request(app).post("/api/auth/register").send(regBody);
    expect(res.status).toBe(201);
  });

  it("opts 优先于环境变量（env=1 但 opts=false → 403）", async () => {
    process.env[ENV] = "1";
    const app = createApp(createMemoryStore(), { allowRegister: false });
    const res = await request(app).post("/api/auth/register").send(regBody);
    expect(res.status).toBe(403);
  });
});

describe("auth + team API", () => {
  let app: ReturnType<typeof createApp>;
  beforeEach(() => {
    app = createApp(createMemoryStore(), { allowRegister: true });
  });

  it("health 免鉴权", async () => {
    const res = await request(app).get("/api/health");
    expect(res.status).toBe(200);
    expect(res.body).toEqual({ ok: true });
  });

  it("注册 → 登录 → /api/me", async () => {
    const a = await register(app, "alice");
    const login = await request(app)
      .post("/api/auth/login")
      .send({ username: "alice", password: "secret123" });
    expect(login.status).toBe(200);
    const me = await request(app)
      .get("/api/me")
      .set("Authorization", `Bearer ${login.body.token}`);
    expect(me.status).toBe(200);
    expect(me.body.username).toBe("alice");
    expect(login.body.user.id).toBe(a.user.id);
  });

  it("无 token 访问受保护接口返回 401", async () => {
    expect((await request(app).get("/api/me")).status).toBe(401);
    expect((await request(app).get("/api/team")).status).toBe(401);
  });

  it("重复用户名注册返回 400", async () => {
    await register(app, "alice");
    const again = await request(app).post("/api/auth/register").send({
      username: "alice",
      password: "secret123",
      displayName: "X",
    });
    expect(again.status).toBe(400);
  });

  it("建智能体一对一会话并幂等复用", async () => {
    const a = await register(app, "alice");
    const agent = await request(app)
      .post("/api/agents")
      .set("Authorization", `Bearer ${a.token}`)
      .send({ name: "助手", description: "" });
    expect(agent.status).toBe(201);

    const conv = await request(app)
      .post("/api/conversations")
      .set("Authorization", `Bearer ${a.token}`)
      .send({ agentId: agent.body.id });
    expect(conv.status).toBe(201);
    expect(conv.body.type).toBe("agent");

    const again = await request(app)
      .post("/api/conversations")
      .set("Authorization", `Bearer ${a.token}`)
      .send({ agentId: agent.body.id });
    expect(again.body.id).toBe(conv.body.id);

    const mine = await request(app)
      .get("/api/conversations")
      .set("Authorization", `Bearer ${a.token}`);
    expect(mine.body).toHaveLength(1);
    expect(mine.body[0].agent.name).toBe("助手");

    const msgs = await request(app)
      .get(`/api/conversations/${conv.body.id}/messages`)
      .set("Authorization", `Bearer ${a.token}`);
    expect(msgs.status).toBe(200);
    expect(msgs.body).toEqual([]);
  });

  it("d.128：fresh 新建多段会话、PATCH 标题、非成员 403", async () => {
    const a = await register(app, "alicetwo");
    const auth = { Authorization: `Bearer ${a.token}` };
    const agent = await request(app).post("/api/agents").set(auth).send({ name: "助手2", description: "" });
    expect(agent.status).toBe(201);

    const first = await request(app)
      .post("/api/conversations")
      .set(auth)
      .send({ agentId: agent.body.id, fresh: true });
    const second = await request(app)
      .post("/api/conversations")
      .set(auth)
      .send({ agentId: agent.body.id, fresh: true, title: "第二段" });
    expect(second.status).toBe(201);
    expect(second.body.id).not.toBe(first.body.id);
    expect(second.body.title).toBe("第二段");

    const patched = await request(app)
      .patch(`/api/conversations/${first.body.id}`)
      .set(auth)
      .send({ title: "改过的名字" });
    expect(patched.status).toBe(200);
    expect(patched.body.title).toBe("改过的名字");

    const list = await request(app).get("/api/conversations").set(auth);
    expect(list.body.some((c: { id: string; title?: string }) => c.id === first.body.id && c.title === "改过的名字")).toBe(true);

    // 非法 body → 400；非成员 → 403
    expect(
      (
        await request(app)
          .patch(`/api/conversations/${first.body.id}`)
          .set(auth)
          .send({ title: "x".repeat(81) })
      ).status,
    ).toBe(400);
    const bob = await register(app, "bobtwo");
    const forbidden = await request(app)
      .patch(`/api/conversations/${first.body.id}`)
      .set("Authorization", `Bearer ${bob.token}`)
      .send({ title: "bob 改的" });
    expect(forbidden.status).toBe(403);
  });

  it("d.130：会话列表按 limit/offset 分页，不传 limit 返回全部", async () => {
    const a = await register(app, "alicepaging");
    const auth = { Authorization: `Bearer ${a.token}` };
    const agent = await request(app).post("/api/agents").set(auth).send({ name: "分页助手", description: "" });
    const ids: string[] = [];
    for (let i = 0; i < 5; i += 1) {
      const conv = await request(app)
        .post("/api/conversations")
        .set(auth)
        .send({ agentId: agent.body.id, fresh: true, title: `会话 ${i}` });
      ids.push(conv.body.id);
    }

    const all = await request(app).get("/api/conversations").set(auth);
    expect(all.body).toHaveLength(5);

    const page1 = await request(app).get("/api/conversations?limit=2&offset=0").set(auth);
    const page2 = await request(app).get("/api/conversations?limit=2&offset=2").set(auth);
    const page3 = await request(app).get("/api/conversations?limit=2&offset=4").set(auth);
    expect(page1.body).toHaveLength(2);
    expect(page2.body).toHaveLength(2);
    expect(page3.body).toHaveLength(1);
    const got = [...page1.body, ...page2.body, ...page3.body].map((c: { id: string }) => c.id);
    expect(new Set(got).size).toBe(5);
    expect(new Set(got)).toEqual(new Set(ids));
  });

  it("d.128：DELETE 会话——成员 204、非成员 403、不存在 404", async () => {
    const a = await register(app, "alicethree");
    const auth = { Authorization: `Bearer ${a.token}` };
    const agent = await request(app).post("/api/agents").set(auth).send({ name: "助手3", description: "" });
    const conv = await request(app)
      .post("/api/conversations")
      .set(auth)
      .send({ agentId: agent.body.id, fresh: true });
    expect(conv.status).toBe(201);

    const bob = await register(app, "bobthree");
    expect(
      (
        await request(app)
          .delete(`/api/conversations/${conv.body.id}`)
          .set("Authorization", `Bearer ${bob.token}`)
      ).status,
    ).toBe(403);

    expect(
      (await request(app).delete(`/api/conversations/${conv.body.id}`).set(auth)).status,
    ).toBe(204);
    expect((await request(app).get("/api/conversations").set(auth)).body).toEqual([]);
    expect(
      (await request(app).delete(`/api/conversations/${conv.body.id}`).set(auth)).status,
    ).toBe(404);
  });
});

describe("PUT /api/me 个人资料", () => {
  let app: ReturnType<typeof createApp>;
  let token: string;

  beforeEach(async () => {
    app = createApp(createMemoryStore(), { allowRegister: true });
    token = (await register(app, "alice")).token;
  });

  it("改昵称成功，GET /api/me 返回最新", async () => {
    const res = await request(app)
      .put("/api/me")
      .set("Authorization", `Bearer ${token}`)
      .send({ displayName: "新昵称" });
    expect(res.status).toBe(200);
    expect(res.body.displayName).toBe("新昵称");
    expect(res.body.username).toBe("alice");

    const me = await request(app).get("/api/me").set("Authorization", `Bearer ${token}`);
    expect(me.body.displayName).toBe("新昵称");
  });

  it("写入 avatar 后 GET /api/me 返回", async () => {
    const avatar = `data:image/png;base64,${"A".repeat(64)}`;
    const res = await request(app)
      .put("/api/me")
      .set("Authorization", `Bearer ${token}`)
      .send({ displayName: "Alice", avatar });
    expect(res.status).toBe(200);
    expect(res.body.avatar).toBe(avatar);

    const me = await request(app).get("/api/me").set("Authorization", `Bearer ${token}`);
    expect(me.body.avatar).toBe(avatar);
  });

  it("空 displayName 返回 400", async () => {
    const res = await request(app)
      .put("/api/me")
      .set("Authorization", `Bearer ${token}`)
      .send({ displayName: "" });
    expect(res.status).toBe(400);
  });

  it("avatar 超 600_000 返回 400", async () => {
    const res = await request(app)
      .put("/api/me")
      .set("Authorization", `Bearer ${token}`)
      .send({ displayName: "Alice", avatar: "x".repeat(600_001) });
    expect(res.status).toBe(400);
  });

  it("无 token 返回 401", async () => {
    const res = await request(app).put("/api/me").send({ displayName: "X" });
    expect(res.status).toBe(401);
  });
});

describe("files API", () => {
  let app: ReturnType<typeof createApp>;
  beforeEach(() => {
    app = createApp(createMemoryStore(), { allowRegister: true });
  });

  it("上传 → 列表 → 删除", async () => {
    const a = await register(app, "alice");
    const up = await request(app)
      .post("/api/files")
      .set("Authorization", `Bearer ${a.token}`)
      .send({ name: "需求草案.md", mime: "text/markdown", contentBase64: Buffer.from("# 你好").toString("base64") });
    expect(up.status).toBe(201);
    expect(up.body.name).toBe("需求草案.md");
    expect(up.body.owner).toBe("alice");

    const list = await request(app).get("/api/files").set("Authorization", `Bearer ${a.token}`);
    expect(list.body).toHaveLength(1);

    const del = await request(app)
      .delete(`/api/files/${up.body.id}`)
      .set("Authorization", `Bearer ${a.token}`);
    expect(del.status).toBe(204);

    const after = await request(app).get("/api/files").set("Authorization", `Bearer ${a.token}`);
    expect(after.body).toHaveLength(0);
  });

  it("非 owner 删除返回 403", async () => {
    const a = await register(app, "alice");
    const b = await register(app, "bob");
    const up = await request(app)
      .post("/api/files")
      .set("Authorization", `Bearer ${a.token}`)
      .send({ name: "x.txt", mime: "text/plain", contentBase64: "eA==" });
    const del = await request(app)
      .delete(`/api/files/${up.body.id}`)
      .set("Authorization", `Bearer ${b.token}`);
    expect(del.status).toBe(403);
  });

  it("上传 1.5MB base64（超 1MB 旧限制）成功 201", async () => {
    const a = await register(app, "alice");
    const big = "A".repeat(1_500_000);
    const up = await request(app)
      .post("/api/files")
      .set("Authorization", `Bearer ${a.token}`)
      .send({ name: "big.bin", mime: "application/octet-stream", contentBase64: big });
    expect(up.status).toBe(201);
    expect(up.body.size).toBe(Math.floor((1_500_000 * 3) / 4));
    const list = await request(app).get("/api/files").set("Authorization", `Bearer ${a.token}`);
    expect(list.body).toHaveLength(1);
  });

  it("无效上传体返回 400", async () => {
    const a = await register(app, "alice");
    const bad = await request(app)
      .post("/api/files")
      .set("Authorization", `Bearer ${a.token}`)
      .send({ name: "", mime: "text/plain", contentBase64: "eA==" });
    expect(bad.status).toBe(400);
    const noMime = await request(app)
      .post("/api/files")
      .set("Authorization", `Bearer ${a.token}`)
      .send({ name: "x.txt", contentBase64: "eA==" });
    expect(noMime.status).toBe(400);
  });

  it("删除不存在的文件返回 404", async () => {
    const a = await register(app, "alice");
    const del = await request(app)
      .delete("/api/files/no-such-id")
      .set("Authorization", `Bearer ${a.token}`);
    expect(del.status).toBe(404);
  });

  it("size 扣除 base64 padding（aGk= → 2 字节）", async () => {
    const a = await register(app, "alice");
    const up = await request(app)
      .post("/api/files")
      .set("Authorization", `Bearer ${a.token}`)
      .send({ name: "hi.txt", mime: "text/plain", contentBase64: "aGk=" });
    expect(up.status).toBe(201);
    expect(up.body.size).toBe(2);
  });

  it("GET /api/files/:id/content 返回原始字节与 mime", async () => {
    const a = await register(app, "filec");
    const up = await request(app)
      .post("/api/files")
      .set("Authorization", `Bearer ${a.token}`)
      .send({ name: "t.txt", mime: "text/plain", contentBase64: Buffer.from("hello").toString("base64") });
    const got = await request(app)
      .get(`/api/files/${up.body.id}/content`)
      .set("Authorization", `Bearer ${a.token}`);
    expect(got.status).toBe(200);
    expect(got.headers["content-type"]).toContain("text/plain");
    expect(got.text).toBe("hello");
  });

  it("GET /api/files/:id/content 不存在 404", async () => {
    const a = await register(app, "filec2");
    const got = await request(app)
      .get("/api/files/none-id/content")
      .set("Authorization", `Bearer ${a.token}`);
    expect(got.status).toBe(404);
  });

  it("GET /api/files/usage 返回 used/quota", async () => {
    const a = await register(app, "quota1");
    const up = await request(app)
      .post("/api/files")
      .set("Authorization", `Bearer ${a.token}`)
      .send({ name: "u.txt", mime: "text/plain", contentBase64: Buffer.from("12345").toString("base64") });
    expect(up.status).toBe(201);
    const usage = await request(app)
      .get("/api/files/usage")
      .set("Authorization", `Bearer ${a.token}`);
    expect(usage.status).toBe(200);
    expect(usage.body.used).toBe(5);
    expect(usage.body.quota).toBe(200 * 1024 * 1024);
  });

  it("超过配额上传拒绝 413 quota_exceeded（按 username 计量，他人文件不占自己的额）", async () => {
    const store = createMemoryStore();
    const quotaApp = createApp(store, { allowRegister: true });
    const a = await register(quotaApp, "quota2");
    const b = await register(quotaApp, "quota3");
    // quota3 已有文件（不占满）：证明按 username 独立计量，不影响 quota2 的配额判断
    store.addFile(
      {
        id: "other-file",
        owner: "quota3",
        name: "o.bin",
        mime: "application/octet-stream",
        size: 10 * 1024 * 1024,
        updatedAt: new Date().toISOString(),
      },
      "",
    );
    // quota2 预置占额至差 1 字节满：再传 "hi"（2 字节）即超限
    store.addFile(
      {
        id: "filler",
        owner: "quota2",
        name: "f.bin",
        mime: "application/octet-stream",
        size: 200 * 1024 * 1024 - 1,
        updatedAt: new Date().toISOString(),
      },
      "",
    );
    const up = await request(quotaApp)
      .post("/api/files")
      .set("Authorization", `Bearer ${a.token}`)
      .send({ name: "x.txt", mime: "text/plain", contentBase64: Buffer.from("hi").toString("base64") });
    expect(up.status).toBe(413);
    expect(up.body.error).toBe("quota_exceeded");
    // quota2 的 usage 只反映自己占额（不含 quota3 的 10MB）；quota3 配额独立不受影响
    const usage = await request(quotaApp)
      .get("/api/files/usage")
      .set("Authorization", `Bearer ${a.token}`);
    expect(usage.body.used).toBe(200 * 1024 * 1024 - 1);
    const okForB = await request(quotaApp)
      .post("/api/files")
      .set("Authorization", `Bearer ${b.token}`)
      .send({ name: "b.txt", mime: "text/plain", contentBase64: Buffer.from("hi").toString("base64") });
    expect(okForB.status).toBe(201);
  });

  it("HEMING_FILE_QUOTA_MB 生效；解析失败/≤0 回退 200MB", async () => {
    const saved = process.env.HEMING_FILE_QUOTA_MB;
    try {
      const a = await register(app, "quotaenv");
      const readQuota = async () => {
        const usage = await request(app)
          .get("/api/files/usage")
          .set("Authorization", `Bearer ${a.token}`);
        expect(usage.status).toBe(200);
        return (usage.body as { quota: number }).quota;
      };
      process.env.HEMING_FILE_QUOTA_MB = "1";
      expect(await readQuota()).toBe(1024 * 1024);
      process.env.HEMING_FILE_QUOTA_MB = "not-a-number";
      expect(await readQuota()).toBe(200 * 1024 * 1024);
      process.env.HEMING_FILE_QUOTA_MB = "0";
      expect(await readQuota()).toBe(200 * 1024 * 1024);
      process.env.HEMING_FILE_QUOTA_MB = "-5";
      expect(await readQuota()).toBe(200 * 1024 * 1024);
    } finally {
      if (saved === undefined) delete process.env.HEMING_FILE_QUOTA_MB;
      else process.env.HEMING_FILE_QUOTA_MB = saved;
    }
  });
});

describe("CORS 兜底（浏览器直连场景，手写中间件无依赖）", () => {
  let app: App;
  beforeEach(() => {
    app = createApp(createMemoryStore());
  });

  it("OPTIONS 预检直接 204，带完整 CORS 头且不进业务路由", async () => {
    const res = await request(app)
      .options("/api/auth/login")
      .set("Origin", "http://47.92.39.184")
      .set("Access-Control-Request-Method", "POST")
      .set("Access-Control-Request-Headers", "Content-Type");
    expect(res.status).toBe(204);
    expect(res.headers["access-control-allow-origin"]).toBe("*");
    expect(res.headers["access-control-allow-methods"]).toBe("GET,POST,PUT,DELETE,OPTIONS");
    expect(res.headers["access-control-allow-headers"]).toBe("Authorization,Content-Type,x-heming-client");
    expect(res.body).toEqual({});
  });

  it("简单请求（GET /api/health）响应带 Allow-Origin: *", async () => {
    const res = await request(app)
      .get("/api/health")
      .set("Origin", "http://47.92.39.184");
    expect(res.status).toBe(200);
    expect(res.headers["access-control-allow-origin"]).toBe("*");
  });

  it("带鉴权的请求（401）同样带 CORS 头（错误响应不漏头）", async () => {
    const res = await request(app)
      .get("/api/me")
      .set("Origin", "http://elsewhere.example");
    expect(res.status).toBe(401);
    expect(res.headers["access-control-allow-origin"]).toBe("*");
    expect(res.headers["access-control-allow-headers"]).toBe("Authorization,Content-Type,x-heming-client");
  });
});

describe("agents api", () => {
  let store: ReturnType<typeof createMemoryStore>;
  let app: App;
  beforeEach(() => {
    store = createMemoryStore();
    app = createApp(store, { allowRegister: true });
  });

  it("注册用户可建/改/删自己的智能体，系统与他人 403", async () => {
    const a = await register(app, "alice");
    const b = await register(app, "bob");
    // 播种系统 agent（同 sqlite ensureSystemAgents 口径），供「系统 403」断言
    store.ensureSystemAgents();

    const created = await request(app).post("/api/agents")
      .set("Authorization", `Bearer ${a.token}`)
      .send({ name: "架构师", description: "画图" });
    expect(created.status).toBe(201);
    expect(created.body.owner_id).toBe(a.user.id);
    expect(created.body).not.toHaveProperty("system_prompt");

    const list = await request(app).get("/api/agents").set("Authorization", `Bearer ${a.token}`);
    expect(list.status).toBe(200);
    expect(Array.isArray(list.body)).toBe(true);
    // I6 红线：名册 API 永不暴露 system_prompt（GET 列表每一条都不得带该键）
    expect(list.body.length).toBeGreaterThan(0);
    expect(list.body.some((x: Record<string, unknown>) => "system_prompt" in x)).toBe(false);

    const upd = await request(app).put(`/api/agents/${created.body.id}`)
      .set("Authorization", `Bearer ${a.token}`)
      .send({ description: "改" });
    expect(upd.status).toBe(200);
    expect(upd.body.description).toBe("改");
    // I6 红线：PUT 响应同样不含 system_prompt
    expect(upd.body).not.toHaveProperty("system_prompt");

    const notFound = await request(app).put("/api/agents/nope")
      .set("Authorization", `Bearer ${a.token}`)
      .send({ description: "x" });
    expect(notFound.status).toBe(404);

    // 标题承诺的 403 分支：他人 PUT/DELETE + 系统 PUT（forbidden → 403 映射）
    const otherUpd = await request(app).put(`/api/agents/${created.body.id}`)
      .set("Authorization", `Bearer ${b.token}`)
      .send({ description: "劫持" });
    expect(otherUpd.status).toBe(403);
    const sysUpd = await request(app).put("/api/agents/system-assistant")
      .set("Authorization", `Bearer ${a.token}`)
      .send({ name: "改名" });
    expect(sysUpd.status).toBe(403);

    const del = await request(app).delete(`/api/agents/${created.body.id}`)
      .set("Authorization", `Bearer ${a.token}`);
    expect(del.status).toBe(204);

    const delNotFound = await request(app).delete("/api/agents/nope")
      .set("Authorization", `Bearer ${a.token}`);
    expect(delNotFound.status).toBe(404);
  });

  it("未鉴权 401；非法 body 400", async () => {
    expect((await request(app).get("/api/agents")).status).toBe(401);
    const a = await register(app, "alice");
    const bad = await request(app).post("/api/agents")
      .set("Authorization", `Bearer ${a.token}`)
      .send({ name: "" });
    expect(bad.status).toBe(400);
  });
});

// —— E2E Task 2：公钥分发（设计 §3.1）——

describe("e2e keys API", () => {
  let app: App;
  beforeEach(() => {
    app = createApp(createMemoryStore(), { allowRegister: true });
  });

  const deviceA = {
    ikEcdh: "QUlLRUNESAAAA",
    ikSign: "QVNJR05LSVlJTkAAAAAAAAAAAAAAAAAA",
    spk: { pub: "U1BLUFVC", sig: "U1BTSVc", createdAt: 1760659200000 },
  };

  it("PUT 登记本人设备 → GET 全量往返（双公钥 + spk；无 opks 字段）", async () => {
    const a = await register(app, "alice");
    const put = await request(app)
      .put("/api/e2e/keys")
      .set("Authorization", `Bearer ${a.token}`)
      .send(deviceA);
    expect(put.status).toBe(204);

    const got = await request(app).get("/api/e2e/keys").set("Authorization", `Bearer ${a.token}`);
    expect(got.status).toBe(200);
    expect(got.body[a.user.id]).toEqual([deviceA]);
    expect(got.body[a.user.id][0]).not.toHaveProperty("opks");
  });

  it("仅登记本人：body 夹 userId 被剥除不冒写；同设备再 PUT 覆盖（SPK 轮换）", async () => {
    const a = await register(app, "alice");
    const b = await register(app, "bob");
    const devA = { ...deviceA };
    const devB = {
      ikEcdh: "Qk9CIExLTAAAA",
      ikSign: "Qk9CU0lHTgAAAAAAAAAAAAAAAAAA",
      spk: { pub: "Qk9CU1BL", sig: "Qk9CU1BJ", createdAt: 1760660000000 },
    };
    await request(app).put("/api/e2e/keys").set("Authorization", `Bearer ${a.token}`).send(devA).expect(204);

    // b 冒写：body 夹 userId=a.id → Zod 剥掉未知键，仍只登记到 b 名下
    const putB = await request(app)
      .put("/api/e2e/keys")
      .set("Authorization", `Bearer ${b.token}`)
      .send({ ...devB, userId: a.user.id });
    expect(putB.status).toBe(204);

    // a 的同设备换 SPK 再登记 → 覆盖（条目数不变）
    const rotated = { ...devA, spk: { pub: "U1BLUFVCMg==", sig: "U1BTSVcy", createdAt: 1760661000000 } };
    await request(app).put("/api/e2e/keys").set("Authorization", `Bearer ${a.token}`).send(rotated).expect(204);

    const got = await request(app).get("/api/e2e/keys").set("Authorization", `Bearer ${b.token}`);
    expect(got.body[a.user.id]).toEqual([rotated]); // 未被 b 冒写；覆盖生效
    expect(got.body[b.user.id]).toEqual([devB]); // userId 剥除后恒等
  });

  it("未登录 GET/PUT 401；非法 body 400；空库 GET → {}", async () => {
    const a = await register(app, "alice");
    expect((await request(app).get("/api/e2e/keys")).status).toBe(401);
    expect((await request(app).put("/api/e2e/keys").send(deviceA)).status).toBe(401);

    const empty = await request(app).get("/api/e2e/keys").set("Authorization", `Bearer ${a.token}`);
    expect(empty.body).toEqual({});

    const badCases: unknown[] = [
      {},
      { ikEcdh: "", ikSign: "x", spk: { pub: "p", sig: "s", createdAt: 1 } }, // 空公钥
      { ikEcdh: "A".repeat(513), ikSign: "x", spk: { pub: "p", sig: "s", createdAt: 1 } }, // 超长 base64
      { ikEcdh: "a", ikSign: "b" }, // 缺 spk
      { ikEcdh: "a", ikSign: "b", spk: { pub: "p", sig: "s", createdAt: -1 } }, // createdAt 负数
    ];
    for (const body of badCases) {
      const res = await request(app)
        .put("/api/e2e/keys")
        .set("Authorization", `Bearer ${a.token}`)
        .send(body as object);
      expect(res.status).toBe(400);
    }
  });
});

// —— E2E Task 2：明文消息重加密（设计 §7；403/409/404/400 语义）——

describe("PUT /api/messages/:id/reencrypt", () => {
  let store: ReturnType<typeof createMemoryStore>;
  let app: App;
  let a: { token: string; user: { id: string; username: string } };
  let b: { token: string; user: { id: string; username: string } };
  let convId: string;
  let msgId: string;

  beforeEach(async () => {
    store = createMemoryStore();
    app = createApp(store, { allowRegister: true });
    a = await register(app, "alice");
    b = await register(app, "bob");
    const agent = store.createAgent(a.user.id, { name: "助手", description: "" });
    convId = store.createAgentConversation(a.user.id, agent.id).id;
    // 带正文的明文行：重封后 GET 不得再见原文（fix round 1 Critical）
    msgId = store.addMessage(convId, "user", a.user.id, { text: "旧明文" }).id;
  });

  const env = { enc: "e2e", cipher: "Q2lwaGVy", chainKid: "kid1", n: 5 };
  const put = (token: string, id: string, body: object) =>
    request(app).put(`/api/messages/${id}/reencrypt`).set("Authorization", `Bearer ${token}`).send(body);

  it("本人 plain → 200 换信封并可回读；明文 payload 同一更新清空；再 PUT → 409", async () => {
    const ok = await put(a.token, msgId, env);
    expect(ok.status).toBe(200);
    expect(ok.body).toMatchObject({
      id: msgId,
      enc: "e2e",
      cipher: "Q2lwaGVy",
      chainKid: "kid1",
      n: 5,
    });
    // 响应体（即出站消息形态）不得再含明文
    expect(ok.body.payload).toEqual({ text: "" });

    // GET 回读的正是该出站形态（原文已不可读）
    const msgs = await request(app)
      .get(`/api/conversations/${convId}/messages`)
      .set("Authorization", `Bearer ${a.token}`);
    expect(msgs.body[0]).toMatchObject({ enc: "e2e", cipher: "Q2lwaGVy", chainKid: "kid1", n: 5 });
    expect(msgs.body[0].payload).toEqual({ text: "" });

    const again = await put(a.token, msgId, env);
    expect(again.status).toBe(409);
  });

  it("非 sender → 403；消息不存在 → 404；未登录 → 401", async () => {
    // b 不是 sender → 403（权限只看本人）
    expect((await put(b.token, msgId, env)).status).toBe(403);
    expect((await put(a.token, "no-such-id", env)).status).toBe(404);
    const anon = await request(app)
      .put(`/api/messages/${msgId}/reencrypt`)
      .send(env);
    expect(anon.status).toBe(401);
    // 403 后消息仍是 plain（未被部分修改）
    expect(store.listMessages(convId)[0].enc).toBe("plain");
  });

  it("body 非法 → 400（enc=plain / 空 cipher / 缺字段）", async () => {
    expect((await put(a.token, msgId, { enc: "plain", cipher: "Q2lwaGVy" })).status).toBe(400);
    expect((await put(a.token, msgId, { enc: "e2e", cipher: "" })).status).toBe(400);
    expect((await put(a.token, msgId, {})).status).toBe(400);
    expect(store.listMessages(convId)[0].enc).toBe("plain"); // 校验失败不改库
  });
});

