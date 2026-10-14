import { describe, it, expect, beforeEach, afterEach } from "vitest";
import request from "supertest";
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
