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

describe("auth + friends + conversations API", () => {
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
    expect((await request(app).get("/api/friends")).status).toBe(401);
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

  it("完整链路：加好友 → 接受 → 建会话 → 拉消息", async () => {
    const a = await register(app, "alice");
    const b = await register(app, "bob");
    const req = await request(app)
      .post("/api/friends/request")
      .set("Authorization", `Bearer ${a.token}`)
      .send({ username: "bob" });
    expect(req.status).toBe(201);

    const incoming = await request(app)
      .get("/api/friends/requests")
      .set("Authorization", `Bearer ${b.token}`);
    expect(incoming.body).toHaveLength(1);

    await request(app)
      .post(`/api/friends/${incoming.body[0].id}/accept`)
      .set("Authorization", `Bearer ${b.token}`)
      .send({});

    const conv = await request(app)
      .post("/api/conversations")
      .set("Authorization", `Bearer ${a.token}`)
      .send({ peerId: b.user.id });
    expect(conv.status).toBe(201);
    expect(conv.body.peer.username).toBe("bob");

    const convAgain = await request(app)
      .post("/api/conversations")
      .set("Authorization", `Bearer ${b.token}`)
      .send({ peerId: a.user.id });
    expect(convAgain.body.id).toBe(conv.body.id);

    const mine = await request(app)
      .get("/api/conversations")
      .set("Authorization", `Bearer ${a.token}`);
    expect(mine.body).toHaveLength(1);

    const msgs = await request(app)
      .get(`/api/conversations/${conv.body.id}/messages`)
      .set("Authorization", `Bearer ${a.token}`);
    expect(msgs.status).toBe(200);
    expect(msgs.body).toEqual([]);
  });

  it("非好友建会话返回 400", async () => {
    const a = await register(app, "alice");
    const b = await register(app, "bob");
    const res = await request(app)
      .post("/api/conversations")
      .set("Authorization", `Bearer ${a.token}`)
      .send({ peerId: b.user.id });
    expect(res.status).toBe(400);
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
});

describe("group api", () => {
  let app: App;
  beforeEach(() => {
    app = createApp(createMemoryStore(), { allowRegister: true });
  });

  it("创建群并列出（含 unreadCount/memberCount）", async () => {
    const a = await register(app, "alice");
    const b = await register(app, "bob");
    const req = await request(app)
      .post("/api/friends/request")
      .set("Authorization", `Bearer ${a.token}`)
      .send({ username: "bob" });
    expect(req.status).toBe(201);
    const incoming = await request(app)
      .get("/api/friends/requests")
      .set("Authorization", `Bearer ${b.token}`);
    await request(app)
      .post(`/api/friends/${incoming.body[0].id}/accept`)
      .set("Authorization", `Bearer ${b.token}`)
      .send({});

    const g = await request(app)
      .post("/api/conversations")
      .set("Authorization", `Bearer ${a.token}`)
      .send({ name: "评审组", memberIds: [b.user.id] });
    expect(g.status).toBe(201);
    expect(g.body.type).toBe("group");
    expect(g.body.name).toBe("评审组");
    expect(g.body.memberCount).toBe(2);
    expect(g.body.unreadCount).toBe(0);

    const list = await request(app)
      .get("/api/conversations")
      .set("Authorization", `Bearer ${b.token}`);
    const row = (list.body as Conversation[]).find((c) => c.id === g.body.id);
    expect(row?.type).toBe("group");

    const members = await request(app)
      .get(`/api/conversations/${g.body.id}/members`)
      .set("Authorization", `Bearer ${b.token}`);
    expect(members.status).toBe(200);
    expect(members.body).toHaveLength(2);
    expect(members.body.map((m: { name: string }) => m.name)).toContain("BOB");
  });

  it("POST group 含非好友成员 → 400 not friends", async () => {
    const a = await register(app, "alice");
    const b = await register(app, "bob"); // 未加好友
    const res = await request(app)
      .post("/api/conversations")
      .set("Authorization", `Bearer ${a.token}`)
      .send({ name: "拉人", memberIds: [b.user.id] });
    expect(res.status).toBe(400);
    expect(res.body.error).toBe("not friends");
    // 会话未创建：列表无该群
    const list = await request(app)
      .get("/api/conversations")
      .set("Authorization", `Bearer ${a.token}`);
    expect((list.body as Conversation[]).filter((c) => c.type === "group")).toHaveLength(0);
  });

  it("非成员读成员列表 403", async () => {
    const a = await register(app, "alice");
    const c = await register(app, "carol");
    const g = await request(app)
      .post("/api/conversations")
      .set("Authorization", `Bearer ${a.token}`)
      .send({ name: "小群", memberIds: [] });
    expect(g.status).toBe(201);
    // F4（L1 口径锁）：memberIds:[] → creator 自动入群 → memberCount 1（min(1)）
    expect(g.body.memberCount).toBe(1);
    const res = await request(app)
      .get(`/api/conversations/${g.body.id}/members`)
      .set("Authorization", `Bearer ${c.token}`);
    expect(res.status).toBe(403);
  });

  it("reads 端点返回已读列表", async () => {
    const a = await register(app, "alice");
    const g = await request(app)
      .post("/api/conversations")
      .set("Authorization", `Bearer ${a.token}`)
      .send({ name: "单人群", memberIds: [] });
    // memberIds:[] + creator 自动入群 → memberCount 1（口径：min(1)）
    expect(g.body.memberCount).toBe(1);
    const reads = await request(app)
      .get(`/api/conversations/${g.body.id}/reads`)
      .set("Authorization", `Bearer ${a.token}`);
    expect(reads.status).toBe(200);
    expect(Array.isArray(reads.body)).toBe(true);
  });

  it("非成员读 reads 端点 403", async () => {
    const a = await register(app, "alice");
    const c = await register(app, "carol");
    const g = await request(app)
      .post("/api/conversations")
      .set("Authorization", `Bearer ${a.token}`)
      .send({ name: "又一群", memberIds: [] });
    const res = await request(app)
      .get(`/api/conversations/${g.body.id}/reads`)
      .set("Authorization", `Bearer ${c.token}`);
    expect(res.status).toBe(403);
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
    expect(res.headers["access-control-allow-headers"]).toBe("Authorization,Content-Type");
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
    expect(res.headers["access-control-allow-headers"]).toBe("Authorization,Content-Type");
  });
});
