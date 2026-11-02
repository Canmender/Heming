import { describe, it, expect, beforeEach, afterEach } from "vitest";
import request from "supertest";
import { createMemoryStore } from "./store.js";
import { createApp } from "./app.js";
import { presence } from "./presence.js";

type App = ReturnType<typeof createApp>;

async function register(app: App, username: string, displayName = username) {
  const res = await request(app).post("/api/auth/register").send({
    username,
    password: "secret123",
    displayName,
  });
  expect(res.status).toBe(201);
  return res.body as { token: string; user: { id: string; username: string } };
}

function auth(token: string) {
  return { Authorization: `Bearer ${token}` };
}

function activity(overrides: Record<string, unknown> = {}) {
  return {
    kind: "task",
    title: "整理课程表",
    sourceId: "task:1",
    occurredAt: new Date().toISOString(),
    ...overrides,
  };
}

describe("团队名册与在线状态", () => {
  let app: App;
  beforeEach(() => {
    presence.reset();
    app = createApp(createMemoryStore(), { allowRegister: true });
  });
  afterEach(() => presence.reset());

  it("全站一个团队：所有用户都在名册里", async () => {
    const a = await register(app, "alice", "爱丽丝");
    const b = await register(app, "bob", "鲍勃");
    const res = await request(app).get("/api/team").set(auth(a.token));
    expect(res.status).toBe(200);
    expect(res.body.members.map((m: { user: { id: string } }) => m.user.id).sort()).toEqual(
      [a.user.id, b.user.id].sort(),
    );
    expect(res.body.onlineCount).toBe(0);
    expect(res.body.members.every((m: { online: boolean }) => m.online === false)).toBe(true);
  });

  it("登录会推进最近活跃时间", async () => {
    const a = await register(app, "alice", "爱丽丝");
    const before = await request(app).get("/api/team").set(auth(a.token));
    const seenAt = before.body.members.find(
      (m: { user: { id: string } }) => m.user.id === a.user.id,
    ).lastSeenAt;
    expect(typeof seenAt).toBe("string");
    expect(Number.isFinite(Date.parse(seenAt))).toBe(true);
  });

  it("presence 登记后 /api/team 标记在线并按在线优先排序", async () => {
    const a = await register(app, "alice", "爱丽丝");
    const b = await register(app, "bob", "鲍勃");
    presence.online(b.user.id);
    const res = await request(app).get("/api/team").set(auth(a.token));
    expect(res.body.onlineCount).toBe(1);
    expect(res.body.members[0].user.id).toBe(b.user.id);
    expect(res.body.members[0].online).toBe(true);
  });

  it("未鉴权 401", async () => {
    const res = await request(app).get("/api/team");
    expect(res.status).toBe(401);
  });
});

describe("团队动向", () => {
  let app: App;
  let token: string;
  let self: { id: string; username: string };
  beforeEach(async () => {
    presence.reset();
    app = createApp(createMemoryStore(), { allowRegister: true });
    const a = await register(app, "alice", "爱丽丝");
    token = a.token;
    self = a.user;
  });

  it("写入返回 inserted，重复 sourceId 幂等跳过", async () => {
    const first = await request(app)
      .post("/api/team/activities")
      .set(auth(token))
      .send({ items: [activity()] });
    expect(first.status).toBe(201);
    expect(first.body).toEqual({ inserted: 1, skipped: 0 });

    const again = await request(app)
      .post("/api/team/activities")
      .set(auth(token))
      .send({ items: [activity({ title: "改过的标题" })] });
    expect(again.status).toBe(200);
    expect(again.body).toEqual({ inserted: 0, skipped: 1 });

    const list = await request(app).get("/api/team/activities").set(auth(token));
    expect(list.status).toBe(200);
    expect(list.body.activities).toHaveLength(1);
    expect(list.body.activities[0].title).toBe("整理课程表");
  });

  it("支持 before 游标与 actorId 过滤", async () => {
    const t1 = "2026-11-01T08:00:00.000Z";
    const t2 = "2026-11-02T08:00:00.000Z";
    await request(app)
      .post("/api/team/activities")
      .set(auth(token))
      .send({ items: [activity({ sourceId: "task:1", occurredAt: t1 }), activity({ sourceId: "task:2", occurredAt: t2 })] });

    const page = await request(app)
      .get("/api/team/activities")
      .query({ before: "2026-11-02T00:00:00.000Z", actorId: self.id })
      .set(auth(token));
    expect(page.body.activities.map((a: { sourceId: string }) => a.sourceId)).toEqual(["task:1"]);

    const other = await request(app)
      .get("/api/team/activities")
      .query({ actorId: "someone-else" })
      .set(auth(token));
    expect(other.body.activities).toEqual([]);
  });

  it("非法 before 返回 400", async () => {
    const res = await request(app)
      .get("/api/team/activities")
      .query({ before: "not-a-date" })
      .set(auth(token));
    expect(res.status).toBe(400);
  });

  it("items 为空或字段越界返回 400", async () => {
    const empty = await request(app)
      .post("/api/team/activities")
      .set(auth(token))
      .send({ items: [] });
    expect(empty.status).toBe(400);

    const longTitle = await request(app)
      .post("/api/team/activities")
      .set(auth(token))
      .send({ items: [activity({ title: "x".repeat(201) })] });
    expect(longTitle.status).toBe(400);

    const badKind = await request(app)
      .post("/api/team/activities")
      .set(auth(token))
      .send({ items: [activity({ kind: "chat" })] });
    expect(badKind.status).toBe(400);
  });

  it("清空只删自己的动向", async () => {
    const b = await register(app, "bob", "鲍勃");
    await request(app)
      .post("/api/team/activities")
      .set(auth(token))
      .send({ items: [activity({ sourceId: "task:1" })] });
    await request(app)
      .post("/api/team/activities")
      .set(auth(b.token))
      .send({ items: [activity({ sourceId: "staff:1", kind: "staff" })] });

    const del = await request(app).delete("/api/team/activities/mine").set(auth(token));
    expect(del.status).toBe(204);

    const mine = await request(app)
      .get("/api/team/activities")
      .query({ actorId: self.id })
      .set(auth(token));
    expect(mine.body.activities).toEqual([]);
    const all = await request(app).get("/api/team/activities").set(auth(token));
    expect(all.body.activities).toHaveLength(1);
    expect(all.body.activities[0].actorId).toBe(b.user.id);
  });
});
