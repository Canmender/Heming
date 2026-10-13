import { describe, it, expect, beforeEach } from "vitest";
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

describe("auth + friends + conversations API", () => {
  let app: ReturnType<typeof createApp>;
  beforeEach(() => {
    app = createApp(createMemoryStore());
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
