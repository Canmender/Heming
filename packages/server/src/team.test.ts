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

  it("beforeId 组合游标：同一 occurredAt 的条目翻页不丢不重", async () => {
    const at = "2026-11-03T08:00:00.000Z";
    await request(app)
      .post("/api/team/activities")
      .set(auth(token))
      .send({
        items: [
          activity({ sourceId: "task:a", occurredAt: at }),
          activity({ sourceId: "task:b", occurredAt: at }),
          activity({ sourceId: "task:c", occurredAt: at }),
        ],
      });

    const page1 = await request(app)
      .get("/api/team/activities")
      .query({ limit: 2 })
      .set(auth(token));
    expect(page1.status).toBe(200);
    expect(page1.body.activities).toHaveLength(2);
    const firstIds = (page1.body.activities as Array<{ id: string }>).map((a) => a.id);
    // 同刻按 id DESC，顺序确定（与 SQLite 一致）
    expect(firstIds).toEqual([...firstIds].sort().reverse());
    const last = page1.body.activities[1] as { id: string; occurredAt: string };

    const page2 = await request(app)
      .get("/api/team/activities")
      .query({ limit: 2, before: last.occurredAt, beforeId: last.id })
      .set(auth(token));
    expect(page2.status).toBe(200);
    expect(page2.body.activities).toHaveLength(1);
    const secondIds = (page2.body.activities as Array<{ id: string }>).map((a) => a.id);

    // 两页合集 = 三条，且无重复
    expect([...firstIds, ...secondIds]).toHaveLength(3);
    expect(new Set([...firstIds, ...secondIds]).size).toBe(3);
    expect(secondIds[0]! < last.id).toBe(true);

    // 旧客户端只传 before（不传 beforeId）→ 保持旧语义：同刻条目整体被跳过
    const legacy = await request(app)
      .get("/api/team/activities")
      .query({ before: at })
      .set(auth(token));
    expect(legacy.status).toBe(200);
    expect(legacy.body.activities).toEqual([]);
  });

  it("非法 beforeId 返回 400", async () => {
    const empty = await request(app)
      .get("/api/team/activities")
      .query({ beforeId: "" })
      .set(auth(token));
    expect(empty.status).toBe(400);
    expect(empty.body.error).toBe("beforeId 不合法");

    const blank = await request(app)
      .get("/api/team/activities")
      .query({ beforeId: "   " })
      .set(auth(token));
    expect(blank.status).toBe(400);
    expect(blank.body.error).toBe("beforeId 不合法");

    // 重复参数会解析成数组（非字符串）→ 同样 400
    const repeated = await request(app).get("/api/team/activities?beforeId=a&beforeId=b").set(auth(token));
    expect(repeated.status).toBe(400);
    expect(repeated.body.error).toBe("beforeId 不合法");
  });

  it("日程/任务摘要白名单（d.109 C1）：合法摘要可写，自由文本与非法状态 400", async () => {
    const validAgenda = await request(app)
      .post("/api/team/activities")
      .set(auth(token))
      .send({
        items: [
          activity({
            kind: "agenda",
            title: "周会",
            detail: "日程 · 今天到期",
            status: "today",
            sourceId: "agenda:1",
          }),
        ],
      });
    expect(validAgenda.status).toBe(201);
    expect(validAgenda.body).toEqual({ inserted: 1, skipped: 0 });

    const validTask = await request(app)
      .post("/api/team/activities")
      .set(auth(token))
      .send({
        items: [
          activity({
            kind: "task",
            detail: "任务 · 进行中",
            status: "running",
            sourceId: "task:valid",
          }),
        ],
      });
    expect(validTask.status).toBe(201);

    // 日程正文 → 400（服务端不再原样回传客户端自由文本）
    const agendaBody = await request(app)
      .post("/api/team/activities")
      .set(auth(token))
      .send({
        items: [
          activity({ kind: "agenda", title: "周会", detail: "这是正文……", sourceId: "agenda:2" }),
        ],
      });
    expect(agendaBody.status).toBe(400);
    expect(agendaBody.body.error).toBe("只接受标题与状态摘要");

    // 任务 detail 夹带正文 → 400
    const taskDetail = await request(app)
      .post("/api/team/activities")
      .set(auth(token))
      .send({
        items: [activity({ detail: "任务 · 进行中（正文）", sourceId: "task:2" })],
      });
    expect(taskDetail.status).toBe(400);
    expect(taskDetail.body.error).toBe("只接受标题与状态摘要");

    // status 不在白名单 → 400（任务用 todo、日程用 later）
    const badStatus = await request(app)
      .post("/api/team/activities")
      .set(auth(token))
      .send({
        items: [activity({ status: "todo", sourceId: "task:3" })],
      });
    expect(badStatus.status).toBe(400);
    expect(badStatus.body.error).toBe("只接受标题与状态摘要");

    // 被拒的条目一条都没落库
    const list = await request(app)
      .get("/api/team/activities")
      .query({ actorId: self.id })
      .set(auth(token));
    expect(list.body.activities.map((a: { sourceId: string }) => a.sourceId).sort()).toEqual([
      "agenda:1",
      "task:valid",
    ]);
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

describe("团队用量（②-3）", () => {
  let app: App;
  let token: string;
  let self: { id: string; username: string };
  const TO = "2026-11-02";

  function usage(over: Record<string, unknown> = {}) {
    return {
      date: TO,
      model: "gpt-x",
      tokens: 100,
      unreported: 0,
      connections: ["主连接"],
      ...over,
    };
  }

  async function post(items: unknown[], as = token) {
    return request(app).post("/api/team/usage").set(auth(as)).send({ items });
  }

  beforeEach(async () => {
    presence.reset();
    app = createApp(createMemoryStore(), { allowRegister: true });
    const a = await register(app, "alice", "爱丽丝");
    token = a.token;
    self = a.user;
  });

  it("未鉴权 401；上报与读取都要登录", async () => {
    expect((await request(app).post("/api/team/usage").send({ items: [usage()] })).status).toBe(401);
    expect((await request(app).get("/api/team/usage")).status).toBe(401);
    expect((await request(app).delete("/api/team/usage/mine")).status).toBe(401);
  });

  it("上报返回 written/stored；同一份数据重复上报是幂等覆盖（不翻倍）", async () => {
    const first = await post([usage(), usage({ model: "claude-y", tokens: 50 })]);
    expect(first.status).toBe(200);
    expect(first.body).toEqual({ written: 2, stored: 2 });

    const again = await post([usage({ tokens: 100 })]);
    expect(again.body).toEqual({ written: 1, stored: 1 });

    const res = await request(app)
      .get("/api/team/usage")
      .query({ range: "7d", to: TO })
      .set(auth(token));
    expect(res.status).toBe(200);
    expect(res.body.self.total).toBe(150); // 100 覆盖成 100（不是 200）+ 50
    expect(res.body.self.byModel.map((m: { model: string }) => m.model).sort()).toEqual([
      "claude-y",
      "gpt-x",
    ]);
  });

  it("排行按 token 降序、只给聚合数与显示名；本人明细只含自己", async () => {
    const b = await register(app, "bob", "鲍勃");
    await post([usage({ tokens: 100 })]);
    await post([usage({ tokens: 900, model: "claude-y" })], b.token);
    await post([usage({ tokens: null, unreported: 2 })], b.token);

    const res = await request(app)
      .get("/api/team/usage")
      .query({ range: "7d", to: TO })
      .set(auth(token));
    expect(res.body.ranking.map((r: { displayName: string }) => r.displayName)).toEqual([
      "鲍勃",
      "爱丽丝",
    ]);
    const bobRow = res.body.ranking[0];
    // 排行只给聚合数与显示名：没有任何明细字段
    expect(Object.keys(bobRow).sort()).toEqual(
      ["days", "displayName", "tokens", "unreported", "userId"].sort(),
    );
    expect(bobRow).toMatchObject({ tokens: 900, unreported: 2, days: 1 });
    expect(JSON.stringify(bobRow)).not.toContain("claude-y");

    // self 只含本人：模型名是 gpt-x，别人的模型与连接名都不出现
    expect(res.body.self.byModel.map((m: { model: string }) => m.model)).toEqual(["gpt-x"]);
    expect(JSON.stringify(res.body.self)).not.toContain("claude-y");
  });

  it("隐私断言：请求体与响应都不含正文类字段", async () => {
    // 客户端模拟夹带：这些字段在 schema 里不存在，服务端剥掉后不会入库/回显
    const smuggled = usage({
      prompt: "不该上传的提示词",
      text: "不该上传的正文",
      args: "不该上传的参数",
      result: "不该上传的结果",
      content: "不该上传的内容",
    });
    const write = await post([smuggled]);
    expect(write.status).toBe(200);

    const res = await request(app)
      .get("/api/team/usage")
      .query({ range: "7d", to: TO })
      .set(auth(token));
    const body = JSON.stringify(res.body);
    for (const forbidden of ["不该上传", "prompt", '"text"', "args", "result", '"content"']) {
      expect(body).not.toContain(forbidden);
    }
    // 响应字段就是契约里那几个
    expect(Object.keys(res.body).sort()).toEqual(["from", "range", "ranking", "self", "to"].sort());
  });

  it("日期边界：range 决定 from/to；to 可指定本地今天；区间外不计", async () => {
    await post([usage({ date: "2026-11-02", tokens: 100 })]);
    await post([usage({ date: "2026-10-26", tokens: 700 })]);
    await post([usage({ date: "2026-10-05", tokens: 5000 })]);

    const d7 = await request(app)
      .get("/api/team/usage")
      .query({ range: "7d", to: TO })
      .set(auth(token));
    expect(d7.body).toMatchObject({ range: "7d", from: "2026-10-27", to: TO });
    expect(d7.body.self.total).toBe(100); // 10-26 在 7 天窗口外；10-05 也外

    const d30 = await request(app)
      .get("/api/team/usage")
      .query({ range: "30d", to: TO })
      .set(auth(token));
    expect(d30.body).toMatchObject({ range: "30d", from: "2026-10-04" });
    expect(d30.body.self.total).toBe(5800); // 100 + 700 + 5000
  });

  it("校验：range / to / 日期键 / 条数上限 / token 越界都返回 400", async () => {
    expect(
      (await request(app).get("/api/team/usage").query({ range: "90d" }).set(auth(token))).status,
    ).toBe(400);
    expect(
      (await request(app).get("/api/team/usage").query({ to: "2026-13-01" }).set(auth(token))).status,
    ).toBe(400);
    expect((await post([usage({ date: "2026-1-1" })])).status).toBe(400);
    expect((await post([usage({ model: "" })])).status).toBe(400);
    expect((await post([usage({ tokens: -1 })])).status).toBe(400);
    expect(
      (await post(Array.from({ length: 51 }, (_, i) => usage({ model: `m${i}` })))).status,
    ).toBe(400);
    expect((await post([])).status).toBe(400);
  });

  it("清除我的用量：只删自己的行，返回 deleted，排行不再包含本人", async () => {
    const b = await register(app, "bob", "鲍勃");
    await post([usage({ tokens: 100 }), usage({ date: "2026-11-01", tokens: 50 })]);
    await post([usage({ tokens: 900 })], b.token);

    const res = await request(app).delete("/api/team/usage/mine").set(auth(token));
    expect(res.status).toBe(200);
    expect(res.body).toEqual({ deleted: 2 });
    // 幂等：再清一次返回 0（不报错）
    expect((await request(app).delete("/api/team/usage/mine").set(auth(token))).body).toEqual({
      deleted: 0,
    });

    const after = await request(app)
      .get("/api/team/usage")
      .query({ range: "7d", to: TO })
      .set(auth(token));
    expect(after.body.self.total).toBe(0);
    expect(after.body.self.byModel).toEqual([]);
    expect(after.body.ranking.map((r: { displayName: string }) => r.displayName)).toEqual(["鲍勃"]);

    // 别人的行没被动
    const bobView = await request(app)
      .get("/api/team/usage")
      .query({ range: "7d", to: TO })
      .set(auth(b.token));
    expect(bobView.body.self.total).toBe(900);
  });
});
