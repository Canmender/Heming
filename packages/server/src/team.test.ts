import { describe, it, expect, beforeEach, afterEach } from "vitest";
import request from "supertest";
import { createMemoryStore } from "./store.js";
import { createApp } from "./app.js";
import { presence } from "./presence.js";
import { addDays, dayKeyUtc } from "./teamUsage.js";

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
    // 任务类 title 被钉死成固定占位词（隐私红线：任务标题派生自用户提问首行）
    title: "任务",
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
      .send({ items: [activity({ detail: "任务 · 已完成", status: "done" })] });
    expect(again.status).toBe(200);
    expect(again.body).toEqual({ inserted: 0, skipped: 1 });

    const list = await request(app).get("/api/team/activities").set(auth(token));
    expect(list.status).toBe(200);
    expect(list.body.activities).toHaveLength(1);
    expect(list.body.activities[0].title).toBe("任务");
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

  it("任务标题只能是固定占位词（隐私红线）：提问派生标题一律 400", async () => {
    // 早期实现把 taskTitle(prompt)（提问首行）当 title 上报 → 提示词全站可见。
    for (const title of ["整理课程表", "帮我写一封辞职邮件", "任务：正文"]) {
      const res = await request(app)
        .post("/api/team/activities")
        .set(auth(token))
        .send({ items: [activity({ title, sourceId: `task:${title}` })] });
      expect(res.status).toBe(400);
      expect(res.body.error).toBe("只接受标题与状态摘要");
    }

    // 纯空白 title 也被拒（min(1) 之前能过）
    const blank = await request(app)
      .post("/api/team/activities")
      .set(auth(token))
      .send({ items: [activity({ title: "   ", sourceId: "task:blank" })] });
    expect(blank.status).toBe(400);
  });

  it("occurredAt 必须在过去 400 天内且不能在未来（防永久置顶）", async () => {
    const future = await request(app)
      .post("/api/team/activities")
      .set(auth(token))
      .send({ items: [activity({ occurredAt: "9999-12-31T00:00:00.000Z", sourceId: "f" })] });
    expect(future.status).toBe(400);
    expect(future.body.error).toBe("发生时间不能在未来");

    const far = await request(app)
      .post("/api/team/activities")
      .set(auth(token))
      .send({ items: [activity({ occurredAt: "2000-01-01T00:00:00.000Z", sourceId: "old" })] });
    expect(far.status).toBe(400);
    expect(far.body.error).toBe("发生时间太久远");

    // 5 分钟内的时钟漂移可以接受
    const skew = new Date(Date.now() + 60_000).toISOString();
    const ok = await request(app)
      .post("/api/team/activities")
      .set(auth(token))
      .send({ items: [activity({ occurredAt: skew, sourceId: "skew" })] });
    expect(ok.status).toBe(201);
  });

  it("查询参数严格：beforeId 必须配合 before、limit 只收纯数字", async () => {
    const alone = await request(app)
      .get("/api/team/activities")
      .query({ beforeId: "abc" })
      .set(auth(token));
    expect(alone.status).toBe(400);
    expect(alone.body.error).toBe("beforeId 需要配合 before 使用");

    for (const limit of ["5x", "abc", "0", "-3"]) {
      const res = await request(app)
        .get("/api/team/activities")
        .query({ limit })
        .set(auth(token));
      expect(res.status).toBe(400);
      expect(res.body.error).toBe("limit 不合法");
    }

    // 合法值照旧（>100 截到 100）
    const big = await request(app)
      .get("/api/team/activities")
      .query({ limit: "500" })
      .set(auth(token));
    expect(big.status).toBe(200);
  });

  it("每人动向上限 500 条：超出 429，清除后可继续写", async () => {
    const batch = (from: number) =>
      Array.from({ length: 50 }, (_, i) => activity({ sourceId: `cap:${from + i}` }));
    for (let round = 0; round < 10; round += 1) {
      const res = await request(app)
        .post("/api/team/activities")
        .set(auth(token))
        .send({ items: batch(round * 50) });
      expect(res.status).toBe(201);
    }

    const over = await request(app)
      .post("/api/team/activities")
      .set(auth(token))
      .send({ items: [activity({ sourceId: "cap:overflow" })] });
    expect(over.status).toBe(429);
    expect(over.body.error).toBe("动向摘要已达上限，请先清除");

    // 清除是唯一出口：干净后能继续写（occurredAt 必须晚于清除水位，否则会被当成旧事件跳过）
    expect((await request(app).delete("/api/team/activities/mine").set(auth(token))).status).toBe(204);
    const after = await request(app)
      .post("/api/team/activities")
      .set(auth(token))
      .send({
        items: [
          activity({
            sourceId: "cap:again",
            occurredAt: new Date(Date.now() + 1000).toISOString(),
          }),
        ],
      });
    expect(after.status).toBe(201);
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

  it("旧库 task 动向带提问首行：读 API 强制投影成「任务」（T2-02）", async () => {
    // 直接用 Store 写一条「收紧前」的旧行：POST 的白名单会挡住这种 title，
    // 但真实老库里就有——这里模拟迁移之前的历史数据。
    const memStore = createMemoryStore();
    const oldApp = createApp(memStore, { allowRegister: true });
    const a = await register(oldApp, "alice", "爱丽丝");
    memStore.addTeamActivity(a.user.id, {
      kind: "task",
      title: "帮我把客户的身份证号整理成表格",
      detail: "任务 · 已完成",
      status: "done",
      sourceId: "task:legacy:1",
      occurredAt: "2026-11-01T00:00:00.000Z",
    });

    const res = await request(oldApp).get("/api/team/activities").set(auth(a.token));
    expect(res.status).toBe(200);
    expect(res.body.activities).toHaveLength(1);
    // 读侧投影：与 web `labels.ts` 的 activityTitle() 同口径
    expect(res.body.activities[0].title).toBe("任务");
    // 只换 title，状态摘要等白名单字段照旧（别把整行抹平）
    expect(res.body.activities[0]).toMatchObject({
      kind: "task",
      detail: "任务 · 已完成",
      status: "done",
    });
    expect(JSON.stringify(res.body)).not.toContain("身份证号");
  });

  it("清除动向落服务端水位：同 sourceId 重传旧事件被跳过、新事件仍可传（T2-03）", async () => {
    const occurredAt = "2026-11-01T00:00:00.000Z";
    const items = ["a", "b", "c"].map((x) => activity({ sourceId: `task:${x}`, occurredAt }));
    const first = await request(app)
      .post("/api/team/activities")
      .set(auth(token))
      .send({ items });
    expect(first.body).toEqual({ inserted: 3, skipped: 0 });

    expect((await request(app).delete("/api/team/activities/mine").set(auth(token))).status).toBe(204);
    expect((await request(app).get("/api/team/activities").set(auth(token))).body.activities).toEqual(
      [],
    );

    // 换设备 / 清了 localStorage：本地 activitiesClearedAt 是 null，
    // 同一条 sync 逻辑会用**相同的 sourceId** 把这批旧事件原样重传——水位要挡住。
    const replay = await request(app)
      .post("/api/team/activities")
      .set(auth(token))
      .send({ items });
    expect(replay.status).toBe(200);
    expect(replay.body).toEqual({ inserted: 0, skipped: 3 });
    expect((await request(app).get("/api/team/activities").set(auth(token))).body.activities).toEqual(
      [],
    );

    // 清除之后新完成的事件（occurredAt 晚于清除时刻）仍应上报成功
    const fresh = await request(app)
      .post("/api/team/activities")
      .set(auth(token))
      .send({
        items: [
          activity({ sourceId: "task:fresh", occurredAt: new Date(Date.now() + 1000).toISOString() }),
        ],
      });
    expect(fresh.status).toBe(201);
    expect(fresh.body).toEqual({ inserted: 1, skipped: 0 });
    expect(
      (await request(app).get("/api/team/activities").set(auth(token))).body.activities.map(
        (x: { sourceId: string }) => x.sourceId,
      ),
    ).toEqual(["task:fresh"]);
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
    // 响应字段就是契约里那几个（rankingTotal/rankingTruncated 是可选字段，服务端现在会返回）
    expect(Object.keys(res.body).sort()).toEqual(
      ["from", "range", "ranking", "rankingTotal", "rankingTruncated", "self", "to"].sort(),
    );
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

  it("清除后服务端记住水位：换设备把旧日数据重传回来会被丢弃（P2-7）", async () => {
    const today = dayKeyUtc(new Date());
    const yesterday = addDays(today, -1);
    const twoDaysAgo = addDays(today, -2);

    // 清除前先有两天旧数据（清除时一起删掉）
    expect((await post([usage({ date: twoDaysAgo }), usage({ date: yesterday })])).body).toEqual({
      written: 2,
      stored: 2,
    });
    expect((await request(app).delete("/api/team/usage/mine").set(auth(token))).body).toEqual({
      deleted: 2,
    });

    // 另一台设备（或清了 localStorage 的那台）按本地账本把 30 天原样重传：
    // 没有服务端水位时这些行会被重新写回去，等于「清了个寂寞」。
    expect((await post([usage({ date: twoDaysAgo })])).body).toEqual({ written: 0, stored: 0 });
    expect(
      (
        await post([
          usage({ date: addDays(today, -10), model: "old-c" }),
          usage({ date: twoDaysAgo, model: "old-d" }),
        ])
      ).body,
    ).toEqual({ written: 0, stored: 0 });

    // 水位是「严格小于清除日」：清除当天仍允许写入（客户端会按毫秒过滤，当天可能还有新用量）
    expect((await post([usage({ date: today, model: "new" })])).body).toEqual({
      written: 1,
      stored: 1,
    });

    const res = await request(app)
      .get("/api/team/usage")
      .query({ range: "7d", to: today })
      .set(auth(token));
    expect(res.body.self.total).toBe(100);
    expect(res.body.self.byModel.map((m: { model: string }) => m.model)).toEqual(["new"]);
    expect(res.body.ranking).toHaveLength(1);
  });
});

describe("动向时间口径（d.113）", () => {
  let app: App;
  let token: string;
  beforeEach(async () => {
    presence.reset();
    app = createApp(createMemoryStore(), { allowRegister: true });
    token = (await register(app, "alice", "爱丽丝")).token;
  });
  afterEach(() => presence.reset());

  const post = (items: unknown[]) =>
    request(app).post("/api/team/activities").set(auth(token)).send({ items });

  it("occurredAt 归一成 UTC 毫秒形态：+08:00 写入也按同一时刻排序", async () => {
    const res = await post([
      activity({ sourceId: "t:1", occurredAt: "2026-11-01T08:00:00+08:00" }),
    ]);
    expect(res.status).toBe(201);

    const list = await request(app).get("/api/team/activities").set(auth(token));
    // 存客户端原文的话这里是 "2026-11-01T08:00:00+08:00"，游标字符串比较会把
    // 同一时刻的 +08:00 写法当成「比 UTC 写法晚 8 小时」。
    expect(list.body.activities[0].occurredAt).toBe("2026-11-01T00:00:00.000Z");
  });

  it("游标翻页在混合时区写法下不丢条也不重条", async () => {
    const times = [
      "2026-11-01T08:00:00+08:00",
      "2026-11-01T00:01:00Z",
      "2026-11-01T08:02:00+08:00",
    ];
    for (const [i, at] of times.entries()) {
      expect((await post([activity({ sourceId: `t:${i}`, occurredAt: at })])).status).toBe(201);
    }

    const page1 = await request(app)
      .get("/api/team/activities")
      .query({ limit: 2 })
      .set(auth(token));
    expect(page1.body.activities.map((a: { sourceId: string }) => a.sourceId)).toEqual([
      "t:2",
      "t:1",
    ]);

    const last = page1.body.activities[1] as { occurredAt: string; id: string };
    const page2 = await request(app)
      .get("/api/team/activities")
      .query({ limit: 2, before: last.occurredAt, beforeId: last.id })
      .set(auth(token));
    expect(page2.body.activities.map((a: { sourceId: string }) => a.sourceId)).toEqual(["t:0"]);
  });
});

describe("错误契约（T2-12）", () => {
  let app: App;

  beforeEach(async () => {
    presence.reset();
    app = createApp(createMemoryStore(), { allowRegister: true });
    await register(app, "alice", "爱丽丝");
  });

  afterEach(() => presence.reset());

  it("坏 JSON body 返回 400 中文，而不是 500「服务器内部错误」", async () => {
    const res = await request(app)
      .post("/api/auth/login")
      .set("Content-Type", "application/json")
      .send('{"username": "alice", ');
    expect(res.status).toBe(400);
    expect(res.body).toEqual({ error: "请求体不是合法 JSON" });
  });

  it("超过 8mb 的请求体返回 413 中文", async () => {
    const res = await request(app)
      .post("/api/team/activities")
      .set("Content-Type", "application/json")
      .send({ items: [], pad: "x".repeat(9 * 1024 * 1024) });
    expect(res.status).toBe(413);
    expect(res.body).toEqual({ error: "请求体太大" });
  });

  it("未匹配的 /api 路由返回 JSON 404，而不是 Express 默认 HTML", async () => {
    const res = await request(app).get("/api/not-a-route");
    expect(res.status).toBe(404);
    expect(res.headers["content-type"]).toContain("application/json");
    expect(res.body).toEqual({ error: "接口不存在" });
  });
});
