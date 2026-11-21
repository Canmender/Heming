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

/**
 * 建一个工作台团队并把给定用户名拉进去。
 *
 * 团队名册/动向/用量的可见范围现在是「同队成员」，所以凡是「a 要看见 b」的用例，
 * 都必须先让两人真的同队——否则测的就是旧的全站口径。
 */
async function makeTeam(app: App, ownerToken: string, name: string, usernames: string[] = []) {
  const created = await request(app).post("/api/teams").set(auth(ownerToken)).send({ name });
  expect(created.status).toBe(201);
  const teamId = created.body.team.id as string;
  for (const username of usernames) {
    const added = await request(app)
      .post(`/api/teams/${teamId}/members`)
      .set(auth(ownerToken))
      .send({ username });
    expect(added.status).toBe(200);
  }
  return teamId;
}

describe("团队名册与在线状态", () => {
  let app: App;
  beforeEach(() => {
    presence.reset();
    app = createApp(createMemoryStore(), { allowRegister: true });
  });
  afterEach(() => presence.reset());

  it("没有团队时名册只剩自己：不再把其他注册用户当成队员", async () => {
    const a = await register(app, "alice", "爱丽丝");
    await register(app, "bob", "鲍勃");
    await register(app, "carol", "卡罗尔");

    const res = await request(app).get("/api/team").set(auth(a.token));
    expect(res.status).toBe(200);
    expect(res.body.members.map((m: { user: { id: string } }) => m.user.id)).toEqual([a.user.id]);
    expect(res.body.onlineCount).toBe(0);
    expect(res.body.members.every((m: { online: boolean }) => m.online === false)).toBe(true);
  });

  it("同队成员互相可见；跨队不串；无队只看到自己", async () => {
    const a = await register(app, "alice", "爱丽丝");
    const b = await register(app, "bob", "鲍勃");
    const c = await register(app, "carol", "卡罗尔");
    const d = await register(app, "dave", "戴夫");

    await makeTeam(app, a.token, "一起", ["bob"]); // A、B 同队
    await makeTeam(app, c.token, "另一队", []); // C 自己一队

    const ids = async (token: string) =>
      (await request(app).get("/api/team").set(auth(token))).body.members
        .map((m: { user: { id: string } }) => m.user.id)
        .sort();
    expect(await ids(a.token)).toEqual([a.user.id, b.user.id].sort());
    expect(await ids(b.token)).toEqual([a.user.id, b.user.id].sort());
    expect(await ids(c.token)).toEqual([c.user.id]);
    expect(await ids(d.token)).toEqual([d.user.id]);
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

  it("presence 登记后 /api/team 标记在线并按在线优先排序（只看同队）", async () => {
    const a = await register(app, "alice", "爱丽丝");
    const b = await register(app, "bob", "鲍勃");
    const outsider = await register(app, "carol", "卡罗尔");
    await makeTeam(app, a.token, "一起", ["bob"]);
    presence.online(b.user.id);
    presence.online(outsider.user.id); // 不同队的人上线也不该出现在 A 的名册里

    const res = await request(app).get("/api/team").set(auth(a.token));
    expect(res.body.members.map((m: { user: { id: string } }) => m.user.id)).toEqual([
      b.user.id,
      a.user.id,
    ]);
    expect(res.body.members[0].online).toBe(true);
    expect(res.body.onlineCount).toBe(1);
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

  it("批量上报不突破每人 500 条上限：最后一批只补满空位、其余计入 skipped（d.412.4.196）", async () => {
    const batch = (from: number, count: number) =>
      Array.from({ length: count }, (_, i) => activity({ sourceId: `bulk:${from + i}` }));
    // 先填到 490 条（10 批 × 49），留 10 个空位。
    for (let round = 0; round < 10; round += 1) {
      const res = await request(app)
        .post("/api/team/activities")
        .set(auth(token))
        .send({ items: batch(round * 49, 49) });
      expect(res.status).toBe(201);
    }
    // 一次提交 20 条全新 sourceId：旧实现入口只查一次 count（490<500 放行），
    // 循环里不管剩余额度全插 → 530 条突破上限；正确行为是只补 10 条到 500。
    const over = await request(app)
      .post("/api/team/activities")
      .set(auth(token))
      .send({ items: batch(490, 20) });
    expect(over.status).toBe(201);
    expect(over.body.inserted).toBe(10);
    expect(over.body.skipped).toBe(10);

    // 现在确实满了，再写一条应 429。
    const full = await request(app)
      .post("/api/team/activities")
      .set(auth(token))
      .send({ items: [activity({ sourceId: "bulk:overflow" })] });
    expect(full.status).toBe(429);
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
    await makeTeam(app, token, "同队", ["bob"]); // 同队才互相可见（跨队动向不出现）
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
    await makeTeam(app, token, "同队", ["bob"]); // 排行只聚合同队成员
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
    await makeTeam(app, token, "同队", ["bob"]);
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

  it("非规范格式的 before 游标先归一化再比较，不重条也不漏条（d.412.4.195）", async () => {
    // 库内 occurredAt 是写侧归一化的 "2026-11-02T08:00:00.000Z"。
    expect((await post([activity({ sourceId: "t:cut", occurredAt: "2026-11-02T08:00:00.000Z" })])).status).toBe(201);
    expect((await post([activity({ sourceId: "t:old", occurredAt: "2026-11-01T08:00:00.000Z" })])).status).toBe(201);

    // 无毫秒写法：字典序下 ".000Z" < "Z"，旧实现会把 t:cut 误判为「早于 before」而重复返回。
    const noMs = await request(app)
      .get("/api/team/activities")
      .query({ before: "2026-11-02T08:00:00Z" })
      .set(auth(token));
    expect(noMs.status).toBe(200);
    expect(noMs.body.activities.map((a: { sourceId: string }) => a.sourceId)).toEqual(["t:old"]);

    // 带时区偏移写法：+08:00 归一化后是 00:00Z，旧实现按字符串比较会错位 8 小时。
    const offset = await request(app)
      .get("/api/team/activities")
      .query({ before: "2026-11-02T16:00:00+08:00" })
      .set(auth(token));
    expect(offset.status).toBe(200);
    expect(offset.body.activities.map((a: { sourceId: string }) => a.sourceId)).toEqual(["t:old"]);
  });
});

describe("可见范围收口：只在同队成员之间（d.54 口径变更）", () => {
  let app: App;
  let a: { token: string; user: { id: string; username: string } };
  let b: { token: string; user: { id: string; username: string } };
  let c: { token: string; user: { id: string; username: string } };
  let d: { token: string; user: { id: string; username: string } };

  beforeEach(async () => {
    presence.reset();
    app = createApp(createMemoryStore(), { allowRegister: true });
    a = await register(app, "alice", "爱丽丝");
    b = await register(app, "bob", "鲍勃");
    c = await register(app, "carol", "卡罗尔");
    d = await register(app, "dave", "戴夫");
    await makeTeam(app, a.token, "一起", ["bob"]); // A、B 同队
    await makeTeam(app, c.token, "另一队", []); // C 自己一队，与 A/B 无关
  });
  afterEach(() => presence.reset());

  const postActivity = (token: string, item: Record<string, unknown>) =>
    request(app).post("/api/team/activities").set(auth(token)).send({ items: [item] });

  it("动向：跨队成员的动向不出现在我的流里，无队的人只能看到自己", async () => {
    expect(
      (await postActivity(a.token, activity({ sourceId: "task:a", title: "任务" }))).status,
    ).toBe(201);
    expect((await postActivity(b.token, activity({ sourceId: "task:b" }))).status).toBe(201);
    expect((await postActivity(c.token, activity({ sourceId: "task:c" }))).status).toBe(201);
    expect((await postActivity(d.token, activity({ sourceId: "task:d" }))).status).toBe(201);

    const aView = await request(app).get("/api/team/activities").set(auth(a.token));
    expect(aView.body.activities.map((x: { sourceId: string }) => x.sourceId).sort()).toEqual([
      "task:a",
      "task:b",
    ]);
    expect(await (async () => (await request(app).get("/api/team/activities").set(auth(d.token))).body.activities.map((x: { sourceId: string }) => x.sourceId))()).toEqual([
      "task:d",
    ]);    // C 的流里只有自己
    const cView = await request(app).get("/api/team/activities").set(auth(c.token));
    expect(cView.body.activities.map((x: { sourceId: string }) => x.sourceId)).toEqual(["task:c"]);
  });

  it("动向：查不可见 actorId 返回 200 空列表（不 404 泄漏存在性）", async () => {
    await postActivity(c.token, activity({ sourceId: "task:c" }));
    const probe = await request(app)
      .get("/api/team/activities")
      .query({ actorId: c.user.id })
      .set(auth(a.token));
    expect(probe.status).toBe(200);
    expect(probe.body.activities).toEqual([]);
    // 可见成员的 actorId 查询照常返回
    await postActivity(a.token, activity({ sourceId: "task:a" }));
    const mine = await request(app)
      .get("/api/team/activities")
      .query({ actorId: a.user.id })
      .set(auth(a.token));
    expect(mine.body.activities.map((x: { sourceId: string }) => x.sourceId)).toEqual(["task:a"]);
  });

  it("用量：排行只含同队成员，跨队/无队的人不进排行也不泄漏显示名", async () => {
    const to = dayKeyUtc(new Date());
    const usage = (tokens: number) => ({
      date: to,
      model: "gpt-x",
      tokens,
      unreported: 0,
      connections: [] as string[],
    });
    for (const [token, tokens] of [
      [a.token, 10],
      [b.token, 900],
      [c.token, 5000],
      [d.token, 7000],
    ] as const) {
      const res = await request(app)
        .post("/api/team/usage")
        .set(auth(token))
        .send({ items: [usage(tokens)] });
      expect(res.status).toBe(200);
    }

    const view = await request(app)
      .get("/api/team/usage")
      .query({ range: "7d", to })
      .set(auth(a.token));
    expect(view.status).toBe(200);
    expect(view.body.ranking.map((r: { displayName: string }) => r.displayName)).toEqual([
      "鲍勃",
      "爱丽丝",
    ]);
    expect(view.body.rankingTotal).toBe(2); // 去重人数按可见集合算
    // 跨队成员（卡罗尔/戴夫）的 token 与显示名都不应出现
    expect(JSON.stringify(view.body)).not.toContain("卡罗尔");
    expect(JSON.stringify(view.body)).not.toContain("戴夫");
    expect(JSON.stringify(view.body)).not.toContain("5000");
    expect(JSON.stringify(view.body)).not.toContain("7000");
  });
});

describe("多团队：按 ?teamId= 只看当前团队（d.152 团队页）", () => {
  let app: App;
  let a: { token: string; user: { id: string; username: string } };
  let b: { token: string; user: { id: string; username: string } };
  let c: { token: string; user: { id: string; username: string } };
  let d: { token: string; user: { id: string; username: string } };
  let teamAB: string;
  let teamAC: string;

  // A 同时在「甲队」(B) 与「乙队」(C) 里；D 不在任何团队。
  // 这是本次改造的核心场景：同一个人属于多个团队时，页面必须能只看其中一个。
  beforeEach(async () => {
    presence.reset();
    app = createApp(createMemoryStore(), { allowRegister: true });
    a = await register(app, "alice", "爱丽丝");
    b = await register(app, "bob", "鲍勃");
    c = await register(app, "carol", "卡罗尔");
    d = await register(app, "dave", "戴夫");
    teamAB = await makeTeam(app, a.token, "甲队", ["bob"]);
    teamAC = await makeTeam(app, a.token, "乙队", ["carol"]);
  });
  afterEach(() => presence.reset());

  const rosterIds = async (token: string, teamId?: string) => {
    const req = request(app).get("/api/team");
    if (teamId !== undefined) req.query({ teamId });
    const res = await req.set(auth(token));
    expect(res.status).toBe(200);
    return (res.body.members as { user: { id: string } }[])
      .map((m) => m.user.id)
      .sort();
  };

  it("名册：带 teamId 只列该团队成员；不带则仍为所有同队成员并集", async () => {
    expect(await rosterIds(a.token, teamAB)).toEqual([a.user.id, b.user.id].sort());
    expect(await rosterIds(a.token, teamAC)).toEqual([a.user.id, c.user.id].sort());
    // 不带 teamId 保持旧口径（页面切换前的默认请求、旧客户端都不破）
    expect(await rosterIds(a.token)).toEqual([a.user.id, b.user.id, c.user.id].sort());
    // B 只看得到甲队
    expect(await rosterIds(b.token, teamAB)).toEqual([a.user.id, b.user.id].sort());
  });

  it("动向：只回当前团队成员发的摘要", async () => {
    const post = (token: string, sourceId: string) =>
      request(app)
        .post("/api/team/activities")
        .set(auth(token))
        .send({ items: [activity({ sourceId })] });
    expect((await post(a.token, "task:a")).status).toBe(201);
    expect((await post(b.token, "task:b")).status).toBe(201);
    expect((await post(c.token, "task:c")).status).toBe(201);
    expect((await post(d.token, "task:d")).status).toBe(201);

    const feed = async (teamId: string) => {
      const res = await request(app)
        .get("/api/team/activities")
        .query({ teamId })
        .set(auth(a.token));
      expect(res.status).toBe(200);
      return (res.body.activities as { sourceId: string }[]).map((x) => x.sourceId).sort();
    };
    expect(await feed(teamAB)).toEqual(["task:a", "task:b"]);
    expect(await feed(teamAC)).toEqual(["task:a", "task:c"]);
  });

  it("用量：排行只含当前团队成员（且不泄漏其它团队的显示名）", async () => {
    const to = dayKeyUtc(new Date());
    const usage = (tokens: number) => ({
      date: to,
      model: "gpt-x",
      tokens,
      unreported: 0,
      connections: [] as string[],
    });
    for (const [token, tokens] of [
      [a.token, 10],
      [b.token, 900],
      [c.token, 5000],
    ] as const) {
      const res = await request(app)
        .post("/api/team/usage")
        .set(auth(token))
        .send({ items: [usage(tokens)] });
      expect(res.status).toBe(200);
    }

    const view = async (teamId: string) => {
      const res = await request(app)
        .get("/api/team/usage")
        .query({ range: "7d", to, teamId })
        .set(auth(a.token));
      expect(res.status).toBe(200);
      return res.body as { ranking: { displayName: string }[]; rankingTotal: number };
    };
    const ab = await view(teamAB);
    expect(ab.ranking.map((r) => r.displayName)).toEqual(["鲍勃", "爱丽丝"]);
    expect(ab.rankingTotal).toBe(2);
    expect(JSON.stringify(ab)).not.toContain("卡罗尔");
    expect(JSON.stringify(ab)).not.toContain("5000");

    const ac = await view(teamAC);
    expect(ac.ranking.map((r) => r.displayName)).toEqual(["卡罗尔", "爱丽丝"]);
    expect(JSON.stringify(ac)).not.toContain("鲍勃");
    expect(JSON.stringify(ac)).not.toContain("900");
  });

  it("不是该团队成员 / 团队不存在 → 404（不区分两种情况，不泄漏存在性）", async () => {
    // C 不在甲队
    const outsider = await request(app)
      .get("/api/team")
      .query({ teamId: teamAB })
      .set(auth(c.token));
    expect(outsider.status).toBe(404);
    expect(outsider.body).toEqual({ error: "团队不存在" });

    // 不存在的 id 与「别人的团队」返回完全一样的响应
    const missing = await request(app)
      .get("/api/team")
      .query({ teamId: "team-does-not-exist" })
      .set(auth(a.token));
    expect(missing.status).toBe(404);
    expect(missing.body).toEqual(outsider.body);

    // 动向与用量同名册口径
    for (const path of ["/api/team/activities", "/api/team/usage"]) {
      const res = await request(app).get(path).query({ teamId: teamAB }).set(auth(c.token));
      expect(res.status).toBe(404);
      expect(res.body).toEqual({ error: "团队不存在" });
    }
  });

  it("空 teamId 或非字符串参数按「未指定」处理（不 404）", async () => {
    const empty = await request(app).get("/api/team").query({ teamId: "" }).set(auth(a.token));
    expect(empty.status).toBe(200);
    expect(
      (empty.body.members as { user: { id: string } }[]).map((m) => m.user.id).sort(),
    ).toEqual([a.user.id, b.user.id, c.user.id].sort());

    // 数组形式（?teamId=a&teamId=b）是 Express 的 string[]，按未指定处理，不 500
    const repeated = await request(app)
      .get("/api/team")
      .query({ teamId: [teamAB, teamAC] })
      .set(auth(a.token));
    expect(repeated.status).toBe(200);
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

describe("组长语义：创建者即组长，只有组长能把任务派给别人（d.248）", () => {
  let app: App;
  beforeEach(() => {
    presence.reset();
    app = createApp(createMemoryStore(), { allowRegister: true });
  });
  afterEach(() => {
    presence.reset();
  });

  async function seat() {
    const owner = await register(app, "lead", "组长");
    const mate = await register(app, "mate", "队员");
    const teamId = await makeTeam(app, owner.token, "研发组", ["mate"]);
    return { owner, mate, teamId };
  }

  it("组长能派给队员；队员的 my-tasks 里能看到，组长自己名下没有", async () => {
    const { owner, mate, teamId } = await seat();
    const created = await request(app)
      .post(`/api/teams/${teamId}/tasks`)
      .set(auth(owner.token))
      .send({ title: "整理接口文档", assigneeId: mate.user.id });
    expect(created.status).toBe(201);
    expect(created.body.assigneeId).toBe(mate.user.id);

    const mine = await request(app).get("/api/team/my-tasks").set(auth(mate.token));
    expect(mine.status).toBe(200);
    expect(mine.body.tasks).toHaveLength(1);
    expect(mine.body.tasks[0].teamName).toBe("研发组");
    expect(mine.body.tasks[0].task.title).toBe("整理接口文档");
    expect(mine.body.tasks[0].task.status).toBe("todo");

    const ownerMine = await request(app).get("/api/team/my-tasks").set(auth(owner.token));
    expect(ownerMine.body.tasks).toHaveLength(0);

    // 完成后不再出现在「派给我的」里：队员的智能体不该重复看到做完的活儿。
    const done = await request(app)
      .patch(`/api/teams/${teamId}/tasks/${created.body.id}`)
      .set(auth(mate.token))
      .send({ status: "done" });
    expect(done.status).toBe(200);
    const after = await request(app).get("/api/team/my-tasks").set(auth(mate.token));
    expect(after.body.tasks).toHaveLength(0);
  });

  it("队员不能把任务派给别人（403），但可以自派", async () => {
    const { owner, mate, teamId } = await seat();
    const denied = await request(app)
      .post(`/api/teams/${teamId}/tasks`)
      .set(auth(mate.token))
      .send({ title: "派给组长", assigneeId: owner.user.id });
    expect(denied.status).toBe(403);
    expect(String(denied.body.error)).toContain("只有组长");

    const mine = await request(app)
      .post(`/api/teams/${teamId}/tasks`)
      .set(auth(mate.token))
      .send({ title: "我自己的活儿", assigneeId: mate.user.id });
    expect(mine.status).toBe(201);
    expect(mine.body.assigneeId).toBe(mate.user.id);

    const unclaimed = await request(app)
      .post(`/api/teams/${teamId}/tasks`)
      .set(auth(mate.token))
      .send({ title: "谁来认领" });
    expect(unclaimed.status).toBe(201);
    expect(unclaimed.body.assigneeId).toBeNull();
  });

  it("队员不能把已有任务改派给别人；组长可以", async () => {
    const { owner, mate, teamId } = await seat();
    const task = await request(app)
      .post(`/api/teams/${teamId}/tasks`)
      .set(auth(owner.token))
      .send({ title: "先给别人" });
    const taskId = task.body.id as string;

    const denied = await request(app)
      .patch(`/api/teams/${teamId}/tasks/${taskId}`)
      .set(auth(mate.token))
      .send({ assigneeId: owner.user.id });
    expect(denied.status).toBe(403);
    expect(String(denied.body.error)).toContain("只有组长");

    const reassigned = await request(app)
      .patch(`/api/teams/${teamId}/tasks/${taskId}`)
      .set(auth(owner.token))
      .send({ assigneeId: mate.user.id });
    expect(reassigned.status).toBe(200);
    expect(reassigned.body.assigneeId).toBe(mate.user.id);
  });
});

describe("完成留痕：谁交的、什么时候、结论是什么（d.252）", () => {
  let app: App;
  beforeEach(() => {
    presence.reset();
    app = createApp(createMemoryStore(), { allowRegister: true });
  });
  afterEach(() => {
    presence.reset();
  });

  async function seat() {
    const owner = await register(app, "lead", "组长");
    const mate = await register(app, "mate", "队员");
    const teamId = await makeTeam(app, owner.token, "研发组", ["mate"]);
    const created = await request(app)
      .post(`/api/teams/${teamId}/tasks`)
      .set(auth(owner.token))
      .send({ title: "整理接口文档", assigneeId: mate.user.id });
    expect(created.status).toBe(201);
    return { owner, mate, teamId, taskId: created.body.id as string };
  }

  it("标完成时记下结论、时刻与操作者，组长在团队快照里能看到", async () => {
    const { mate, teamId, taskId } = await seat();
    const done = await request(app)
      .patch(`/api/teams/${teamId}/tasks/${taskId}`)
      .set(auth(mate.token))
      .send({ status: "done", result: "按新接口重写了文档，pnpm test 全绿。" });
    expect(done.status).toBe(200);
    expect(done.body.result).toBe("按新接口重写了文档，pnpm test 全绿。");
    expect(typeof done.body.completedAt).toBe("string");
    expect(done.body.completedBy).toBe(mate.user.id);

    const snapshot = await request(app).get(`/api/teams/${teamId}`).set(auth(mate.token));
    expect(snapshot.status).toBe(200);
    const task = snapshot.body.tasks.find((item: { id: string }) => item.id === taskId);
    expect(task.result).toBe("按新接口重写了文档，pnpm test 全绿。");
    expect(task.completedAt).toBe(done.body.completedAt);
    expect(task.completedBy).toBe(mate.user.id);
  });

  it("退回未完成时清掉完成痕迹，但结论留着（不假装没做过）", async () => {
    const { mate, teamId, taskId } = await seat();
    await request(app)
      .patch(`/api/teams/${teamId}/tasks/${taskId}`)
      .set(auth(mate.token))
      .send({ status: "done", result: "先交一版" })
      .expect(200);
    const back = await request(app)
      .patch(`/api/teams/${teamId}/tasks/${taskId}`)
      .set(auth(mate.token))
      .send({ status: "doing" });
    expect(back.status).toBe(200);
    expect(back.body.completedAt).toBeNull();
    expect(back.body.completedBy).toBeNull();
    expect(back.body.result).toBe("先交一版");
  });

  it("结论太长会被拒绝（≤2000 字），不静默截断", async () => {
    const { mate, teamId, taskId } = await seat();
    const tooLong = "字".repeat(2001);
    const res = await request(app)
      .patch(`/api/teams/${teamId}/tasks/${taskId}`)
      .set(auth(mate.token))
      .send({ status: "done", result: tooLong });
    expect(res.status).toBe(400);
  });
});

describe("团队简报：组长派活前得知道队里都有谁（d.253）", () => {
  let app: App;
  beforeEach(() => {
    presence.reset();
    app = createApp(createMemoryStore(), { allowRegister: true });
  });

  it("组长能看到成员名单、各自身份与 id", async () => {
    const boss = await register(app, "d253boss", "阿鸣");
    const mate = await register(app, "d253mate", "小李");
    const teamId = await makeTeam(app, boss.token, "产品组", [mate.user.username]);

    const res = await request(app).get("/api/team/my-teams").set(auth(boss.token));
    expect(res.status).toBe(200);
    const team = res.body.teams.find((item: { id: string }) => item.id === teamId);
    expect(team.role).toBe("owner");
    expect(team.members).toHaveLength(2);
    const owner = team.members.find((m: { role: string }) => m.role === "owner");
    const member = team.members.find((m: { role: string }) => m.role === "member");
    expect(owner).toEqual({ id: boss.user.id, displayName: "阿鸣", role: "owner", open: 0 });
    expect(member).toEqual({ id: mate.user.id, displayName: "小李", role: "member", open: 0 });
  });

  it("成员看到的是自己的身份，且看不到不属于自己的团队", async () => {
    const boss = await register(app, "d253boss2", "阿鸣");
    const mate = await register(app, "d253mate2", "小李");
    const teamId = await makeTeam(app, boss.token, "产品组", [mate.user.username]);
    await makeTeam(app, boss.token, "封闭组");

    const res = await request(app).get("/api/team/my-teams").set(auth(mate.token));
    expect(res.status).toBe(200);
    expect(res.body.teams.map((item: { id: string }) => item.id)).toEqual([teamId]);
    expect(res.body.teams[0].role).toBe("member");
  });
});

describe("任务级权限：成员只能动自己的活（d.254）", () => {
  let app: App;
  beforeEach(() => {
    presence.reset();
    app = createApp(createMemoryStore(), { allowRegister: true });
  });

  async function seed() {
    const boss = await register(app, "d254boss", "阿鸣");
    const mate = await register(app, "d254mate", "小李");
    const other = await register(app, "d254other", "小王");
    const teamId = await makeTeam(app, boss.token, "产品组", [mate.user.username, other.user.username]);
    const task = await request(app)
      .post(`/api/teams/${teamId}/tasks`)
      .set(auth(boss.token))
      .send({ title: "整理接口文档", assigneeId: mate.user.id });
    expect(task.status).toBe(201);
    return { boss, mate, other, teamId, taskId: task.body.id as string };
  }

  it("成员不能把别人名下的任务标完成，任务状态不变", async () => {
    const { boss, mate, teamId, taskId } = await seed();
    const res = await request(app)
      .patch(`/api/teams/${teamId}/tasks/${taskId}`)
      .set(auth(mate.token))
      .send({ status: "done", result: "我做完了" });
    expect(res.status).toBe(200);
    const denied = await request(app)
      .patch(`/api/teams/${teamId}/tasks/${taskId}`)
      .set(auth(mate.token))
      .send({ title: "改个标题" });
    expect(denied.status).toBe(200);

    const other = await register(app, "d254third", "小张");
    await request(app)
      .post(`/api/teams/${teamId}/members`)
      .set(auth(boss.token))
      .send({ username: other.user.username });
    const forbidden = await request(app)
      .patch(`/api/teams/${teamId}/tasks/${taskId}`)
      .set(auth(other.token))
      .send({ status: "done", result: "我替他做的" });
    expect(forbidden.status).toBe(403);
    expect(forbidden.body.error).toContain("只能改自己名下的任务");

    const snap = await request(app).get(`/api/teams/${teamId}`).set(auth(mate.token));
    expect(snap.body.tasks[0].status).toBe("done");
  });

  it("成员能认领还没人认领的任务，但不能删别人的任务", async () => {
    const { boss, mate, teamId } = await seed();
    const created = await request(app)
      .post(`/api/teams/${teamId}/tasks`)
      .set(auth(boss.token))
      .send({ title: "待认领的活" });
    expect(created.status).toBe(201);
    const claim = await request(app)
      .patch(`/api/teams/${teamId}/tasks/${created.body.id}`)
      .set(auth(mate.token))
      .send({ assigneeId: mate.user.id, status: "doing" });
    expect(claim.status).toBe(200);
    expect(claim.body.assigneeId).toBe(mate.user.id);

    // 别人名下的任务删不动
    const del = await request(app)
      .delete(`/api/teams/${teamId}/tasks/${created.body.id}`)
      .set(auth(boss.token));
    expect(del.status).toBe(204);
  });

  it("组长能改任何人的任务，也能删任何人的任务", async () => {
    const { boss, mate, teamId, taskId } = await seed();
    const done = await request(app)
      .patch(`/api/teams/${teamId}/tasks/${taskId}`)
      .set(auth(boss.token))
      .send({ status: "done", result: "我替小李收尾" });
    expect(done.status).toBe(200);
    expect(done.body.completedBy).toBe(boss.user.id);

    const otherTask = await request(app)
      .post(`/api/teams/${teamId}/tasks`)
      .set(auth(boss.token))
      .send({ title: "小李的任务", assigneeId: mate.user.id });
    const del = await request(app)
      .delete(`/api/teams/${teamId}/tasks/${otherTask.body.id}`)
      .set(auth(boss.token));
    expect(del.status).toBe(204);
  });

  it("成员不能删别人名下的任务", async () => {
    const { boss, mate, teamId, taskId } = await seed();
    const boss2 = await register(app, "d254boss2", "老王");
    const boss2Team = await makeTeam(app, boss2.token, "另一组", [mate.user.username]);
    const foreign = await request(app)
      .post(`/api/teams/${boss2Team}/tasks`)
      .set(auth(boss2.token))
      .send({ title: "组长自己的活" });
    const del = await request(app)
      .delete(`/api/teams/${boss2Team}/tasks/${foreign.body.id}`)
      .set(auth(mate.token));
    expect(del.status).toBe(403);
    expect(del.body.error).toContain("只能删自己名下的任务");
  });
});

describe("任务依赖：后置要等前置（d.255）", () => {
  let app: App;
  beforeEach(() => {
    presence.reset();
    app = createApp(createMemoryStore(), { allowRegister: true });
  });

  async function seed() {
    const boss = await register(app, "d255boss", "阿鸣");
    const mate = await register(app, "d255mate", "小李");
    const teamId = await makeTeam(app, boss.token, "产品组", [mate.user.username]);
    const pre = await request(app)
      .post(`/api/teams/${teamId}/tasks`)
      .set(auth(boss.token))
      .send({ title: "先定接口契约", assigneeId: mate.user.id });
    expect(pre.status).toBe(201);
    return { boss, mate, teamId, preId: pre.body.id as string };
  }

  it("派活时可以写前置：前置没做完时，后置在 my-tasks 里点名它", async () => {
    const { boss, mate, teamId, preId } = await seed();
    const post = await request(app)
      .post(`/api/teams/${teamId}/tasks`)
      .set(auth(boss.token))
      .send({ title: "按契约写实现", assigneeId: mate.user.id, blockedBy: [preId] });
    expect(post.status).toBe(201);
    expect(post.body.blockedBy).toEqual([preId]);

    const first = await request(app).get("/api/team/my-tasks").set(auth(mate.token));
    expect(first.status).toBe(200);
    const postItem = first.body.tasks.find((item: { task: { id: string } }) => item.task.id === post.body.id);
    expect(postItem.openBlockers).toEqual([{ id: preId, title: "先定接口契约" }]);

    await request(app)
      .patch(`/api/teams/${teamId}/tasks/${preId}`)
      .set(auth(mate.token))
      .send({ status: "done", result: "契约定了" });
    const second = await request(app).get("/api/team/my-tasks").set(auth(mate.token));
    const after = second.body.tasks.find((item: { task: { id: string } }) => item.task.id === post.body.id);
    expect(after.openBlockers).toEqual([]);
  });

  it("依赖不存在、依赖自己、成环都被拒绝，且不落库", async () => {
    const { boss, teamId, preId } = await seed();
    const missing = await request(app)
      .post(`/api/teams/${teamId}/tasks`)
      .set(auth(boss.token))
      .send({ title: "谁都不等", blockedBy: ["task-not-exist"] });
    expect(missing.status).toBe(400);
    expect(missing.body.error).toContain("前置任务不存在");

    const self = await request(app)
      .patch(`/api/teams/${teamId}/tasks/${preId}`)
      .set(auth(boss.token))
      .send({ blockedBy: [preId] });
    expect(self.status).toBe(400);
    expect(self.body.error).toContain("不能成环");

    const second = await request(app)
      .post(`/api/teams/${teamId}/tasks`)
      .set(auth(boss.token))
      .send({ title: "第二件", blockedBy: [preId] });
    const cycle = await request(app)
      .patch(`/api/teams/${teamId}/tasks/${preId}`)
      .set(auth(boss.token))
      .send({ blockedBy: [second.body.id] });
    expect(cycle.status).toBe(400);
    expect(cycle.body.error).toContain("不能成环");

    const snap = await request(app).get(`/api/teams/${teamId}`).set(auth(boss.token));
    const kept = snap.body.tasks.find((task: { id: string }) => task.id === preId);
    expect(kept.blockedBy).toEqual([]);
  });

  it("删掉前置任务后，后置的依赖会自动清掉（不留悬空 id）", async () => {
    const { boss, teamId, preId } = await seed();
    const post = await request(app)
      .post(`/api/teams/${teamId}/tasks`)
      .set(auth(boss.token))
      .send({ title: "后置的活", blockedBy: [preId] });
    const del = await request(app)
      .delete(`/api/teams/${teamId}/tasks/${preId}`)
      .set(auth(boss.token));
    expect(del.status).toBe(204);
    const snap = await request(app).get(`/api/teams/${teamId}`).set(auth(boss.token));
    const kept = snap.body.tasks.find((task: { id: string }) => task.id === post.body.id);
    expect(kept.blockedBy).toEqual([]);
  });
});

describe("团队概览：组长一眼看到全队进度（d.256）", () => {
  let app: App;
  beforeEach(() => {
    presence.reset();
    app = createApp(createMemoryStore(), { allowRegister: true });
  });

  it("概览数出未完成、逾期、待认领、被前置卡住，成员各自几项未完成", async () => {
    const boss = await register(app, "d256boss", "阿鸣");
    const mate = await register(app, "d256mate", "小李");
    const teamId = await makeTeam(app, boss.token, "产品组", [mate.user.username]);

    const add = (body: Record<string, unknown>) =>
      request(app).post(`/api/teams/${teamId}/tasks`).set(auth(boss.token)).send(body);

    const blocker = await add({ title: "先定接口", assigneeId: mate.user.id });
    expect(blocker.status).toBe(201);
    const overdue = await add({
      title: "过期的那件",
      assigneeId: mate.user.id,
      dueAt: new Date(Date.now() - 86_400_000).toISOString(),
    });
    expect(overdue.status).toBe(201);
    await add({ title: "待认领" });
    await add({ title: "后置", assigneeId: mate.user.id, blockedBy: [blocker.body.id] });
    const done = await add({ title: "已经做完", assigneeId: mate.user.id });
    expect(done.status).toBe(201);
    await request(app)
      .patch(`/api/teams/${teamId}/tasks/${done.body.id}`)
      .set(auth(mate.token))
      .send({ status: "done", result: "做完了。" });

    const res = await request(app).get("/api/team/my-teams").set(auth(boss.token));
    expect(res.status).toBe(200);
    const team = res.body.teams.find((item: { id: string }) => item.id === teamId);
    expect(team.counts).toEqual({ open: 4, done: 1, overdue: 1, unassigned: 1, blocked: 1 });
    const byId = new Map(
      (team.members as { id: string; open: number }[]).map((member) => [member.id, member.open]),
    );
    expect(byId.get(mate.user.id)).toBe(3);
    expect(byId.get(boss.user.id)).toBe(0);
  });

  it("全清时 open 为 0（界面据此写「没有未完成」）", async () => {
    const boss = await register(app, "d256boss2", "阿鸣");
    const teamId = await makeTeam(app, boss.token, "空组");
    const res = await request(app).get("/api/team/my-teams").set(auth(boss.token));
    const team = res.body.teams.find((item: { id: string }) => item.id === teamId);
    expect(team.counts).toEqual({ open: 0, done: 0, overdue: 0, unassigned: 0, blocked: 0 });
  });
});

describe("待认领的活：队里没人认领的任务，队员也看得到（d.260）", () => {
  let app: App;
  beforeEach(() => {
    presence.reset();
    app = createApp(createMemoryStore(), { allowRegister: true });
  });
  afterEach(() => {
    presence.reset();
  });

  it("列出我所在团队的待认领任务；派给别人的、已做完的都不出现", async () => {
    const boss = await register(app, "d260boss", "阿鸣");
    const mate = await register(app, "d260mate", "小李");
    const other = await register(app, "d260other", "路人");
    const teamId = await makeTeam(app, boss.token, "研发组", [mate.user.username]);

    const add = (body: Record<string, unknown>) =>
      request(app).post(`/api/teams/${teamId}/tasks`).set(auth(boss.token)).send(body);

    const unclaimed = await add({ title: "谁来认领" });
    expect(unclaimed.status).toBe(201);
    await add({ title: "已经派给小李", assigneeId: mate.user.id });
    const doneUnclaimed = await add({ title: "待认领但已经做完" });
    expect(doneUnclaimed.status).toBe(201);
    await request(app)
      .patch(`/api/teams/${teamId}/tasks/${doneUnclaimed.body.id}`)
      .set(auth(boss.token))
      .send({ status: "done", result: "组长收尾。" });

    const mine = await request(app).get("/api/team/my-tasks").set(auth(mate.token));
    expect(mine.status).toBe(200);
    expect(mine.body.tasks).toHaveLength(1);
    expect(mine.body.claimable).toHaveLength(1);
    expect(mine.body.claimable[0].task.title).toBe("谁来认领");
    expect(mine.body.claimable[0].task.assigneeId).toBeNull();
    expect(mine.body.claimable[0].teamName).toBe("研发组");

    // 不在这个团队的人，看不到这队里没人认领的活。
    const outsider = await request(app).get("/api/team/my-tasks").set(auth(other.token));
    expect(outsider.status).toBe(200);
    expect(outsider.body.claimable).toHaveLength(0);
  });

  it("认领之后从待认领里消失，进到「派到我名下的」里", async () => {
    const boss = await register(app, "d260boss2", "阿鸣");
    const mate = await register(app, "d260mate2", "小李");
    const teamId = await makeTeam(app, boss.token, "研发二组", [mate.user.username]);
    const created = await request(app)
      .post(`/api/teams/${teamId}/tasks`)
      .set(auth(boss.token))
      .send({ title: "抢来的活" });
    expect(created.status).toBe(201);

    const claimed = await request(app)
      .patch(`/api/teams/${teamId}/tasks/${created.body.id}`)
      .set(auth(mate.token))
      .send({ assigneeId: mate.user.id });
    expect(claimed.status).toBe(200);
    expect(claimed.body.assigneeId).toBe(mate.user.id);

    const after = await request(app).get("/api/team/my-tasks").set(auth(mate.token));
    expect(after.body.claimable).toHaveLength(0);
    expect(after.body.tasks).toHaveLength(1);
    expect(after.body.tasks[0].task.id).toBe(created.body.id);
  });
});

describe("退回任务：做不了就退回去，并说清为什么（d.261）", () => {
  let app: App;

  beforeEach(() => {
    presence.reset();
    app = createApp(createMemoryStore(), { allowRegister: true });
  });

  async function seed() {
    const boss = await register(app, "d261boss", "阿鸣");
    const mate = await register(app, "d261mate", "小李");
    const teamId = await makeTeam(app, boss.token, "产品组", [mate.user.username]);
    const task = await request(app)
      .post(`/api/teams/${teamId}/tasks`)
      .set(auth(boss.token))
      .send({ title: "发版", assigneeId: mate.user.id });
    expect(task.status).toBe(201);
    return { boss, mate, teamId, taskId: task.body.id as string };
  }

  it("成员退回自己的任务：留痕并回到待认领，别人能看到为什么被退回", async () => {
    const { mate, teamId, taskId } = await seed();
    const res = await request(app)
      .patch(`/api/teams/${teamId}/tasks/${taskId}`)
      .set(auth(mate.token))
      .send({ assigneeId: null, returnNote: "没有发布权限，需要管理员来做" });
    expect(res.status).toBe(200);
    expect(res.body.assigneeId).toBeNull();
    expect(res.body.returnNote).toBe("没有发布权限，需要管理员来做");
    expect(res.body.returnedBy).toBe(mate.user.id);
    expect(Number.isFinite(Date.parse(res.body.returnedAt))).toBe(true);

    const mine = await request(app).get("/api/team/my-tasks").set(auth(mate.token));
    expect(mine.status).toBe(200);
    expect(mine.body.tasks).toHaveLength(0);
    const claimable = mine.body.claimable as Array<{ task: { id: string; returnNote: string; returnedBy: string | null } }>;
    const item = claimable.find((entry) => entry.task.id === taskId);
    expect(item).toBeDefined();
    expect(item!.task.returnNote).toContain("没有发布权限");
    expect(item!.task.returnedBy).toBe(mate.user.id);
  });

  it("重新认领会清掉退回痕迹：不能把旧原因一直挂在任务上", async () => {
    const { mate, teamId, taskId } = await seed();
    await request(app)
      .patch(`/api/teams/${teamId}/tasks/${taskId}`)
      .set(auth(mate.token))
      .send({ assigneeId: null, returnNote: "资料不全" });
    const reclaim = await request(app)
      .patch(`/api/teams/${teamId}/tasks/${taskId}`)
      .set(auth(mate.token))
      .send({ assigneeId: mate.user.id });
    expect(reclaim.status).toBe(200);
    expect(reclaim.body.assigneeId).toBe(mate.user.id);
    expect(reclaim.body.returnedAt).toBeNull();
    expect(reclaim.body.returnedBy).toBeNull();
    expect(reclaim.body.returnNote).toBe("");
  });

  it("组长把别人的任务退回也留痕：退的是谁的活、谁退的", async () => {
    const { boss, mate, teamId, taskId } = await seed();
    const res = await request(app)
      .patch(`/api/teams/${teamId}/tasks/${taskId}`)
      .set(auth(boss.token))
      .send({ assigneeId: null, returnNote: "先换个更急的版本，这条放回池子" });
    expect(res.status).toBe(200);
    expect(res.body.returnedBy).toBe(boss.user.id);
    expect(res.body.returnNote).toContain("先换个更急的版本");

    const mine = await request(app).get("/api/team/my-tasks").set(auth(mate.token));
    expect(mine.body.claimable.some((entry: { task: { id: string } }) => entry.task.id === taskId)).toBe(true);
  });

  it("退回原因超过 500 字直接 400，不静默截断", async () => {
    const { mate, teamId, taskId } = await seed();
    const res = await request(app)
      .patch(`/api/teams/${teamId}/tasks/${taskId}`)
      .set(auth(mate.token))
      .send({ assigneeId: null, returnNote: "字".repeat(501) });
    expect(res.status).toBe(400);
  });
});

describe("任务进展：做到一半留一句话，下一轮接着做（d.262）", () => {
  let app: App;

  beforeEach(() => {
    presence.reset();
    app = createApp(createMemoryStore(), { allowRegister: true });
  });

  async function seed() {
    const boss = await register(app, "d262boss", "阿鸣");
    const mate = await register(app, "d262mate", "小李");
    const teamId = await makeTeam(app, boss.token, "产品组", [mate.user.username]);
    const task = await request(app)
      .post(`/api/teams/${teamId}/tasks`)
      .set(auth(boss.token))
      .send({ title: "按契约写实现", assigneeId: mate.user.id });
    expect(task.status).toBe(201);
    return { boss, mate, teamId, taskId: task.body.id as string };
  }

  it("成员留进展：记下内容、谁留的、什么时候，组长在快照里看得到", async () => {
    const { boss, mate, teamId, taskId } = await seed();
    const res = await request(app)
      .patch(`/api/teams/${teamId}/tasks/${taskId}`)
      .set(auth(mate.token))
      .send({ status: "doing", progress: "接口契约已经对齐，正在写 handler" });
    expect(res.status).toBe(200);
    expect(res.body.progress).toBe("接口契约已经对齐，正在写 handler");
    expect(res.body.progressBy).toBe(mate.user.id);
    expect(Number.isFinite(Date.parse(res.body.progressAt))).toBe(true);

    const snap = await request(app).get(`/api/teams/${teamId}`).set(auth(boss.token));
    expect(snap.status).toBe(200);
    const task = (snap.body.tasks as Array<{ id: string; progress: string }>).find((entry) => entry.id === taskId);
    expect(task!.progress).toContain("正在写 handler");
  });

  it("进展传空串 = 清掉（不把旧进展一直挂在任务上）", async () => {
    const { mate, teamId, taskId } = await seed();
    await request(app)
      .patch(`/api/teams/${teamId}/tasks/${taskId}`)
      .set(auth(mate.token))
      .send({ progress: "写了一半" });
    const cleared = await request(app)
      .patch(`/api/teams/${teamId}/tasks/${taskId}`)
      .set(auth(mate.token))
      .send({ progress: "" });
    expect(cleared.status).toBe(200);
    expect(cleared.body.progress).toBe("");
    expect(cleared.body.progressAt).toBeNull();
    expect(cleared.body.progressBy).toBeNull();
  });

  it("进展超过 500 字直接 400，不静默截断", async () => {
    const { mate, teamId, taskId } = await seed();
    const res = await request(app)
      .patch(`/api/teams/${teamId}/tasks/${taskId}`)
      .set(auth(mate.token))
      .send({ progress: "字".repeat(501) });
    expect(res.status).toBe(400);
  });
});

describe("催办：组长能催别人名下的活（d.265）", () => {
  let app: App;
  beforeEach(() => {
    app = createApp(createMemoryStore(), { allowRegister: true });
  });

  /** 造「组长 + 一个成员 + 一条派给成员的任务」。 */
  async function seat() {
    const seatRes = await register(app, "nudgeboss", "组长");
    const mate = await register(app, "nudgemate", "小李");
    const teamId = await makeTeam(app, seatRes.token, "催办小组", [mate.user.username]);
    const created = await request(app)
      .post(`/api/teams/${teamId}/tasks`)
      .set(auth(seatRes.token))
      .send({ title: "交周报", assigneeId: mate.user.id });
    return { owner: seatRes, mate, teamId, taskId: created.body.id as string };
  }

  it("组长催办：记下谁催的、什么时候，次数累加", async () => {
    const { owner, mate, teamId, taskId } = await seat();
    const first = await request(app)
      .patch(`/api/teams/${teamId}/tasks/${taskId}`)
      .set(auth(owner.token))
      .send({ nudge: true });
    expect(first.status).toBe(200);
    expect(first.body.nudgedBy).toBe(owner.user.id);
    expect(first.body.nudgedAt).toBeTruthy();
    expect(first.body.nudgeCount).toBe(1);
    expect(first.body.status).toBe("todo");

    const second = await request(app)
      .patch(`/api/teams/${teamId}/tasks/${taskId}`)
      .set(auth(owner.token))
      .send({ nudge: true });
    expect(second.body.nudgeCount).toBe(2);
  });

  it("成员不能催别人的活；自己的、没人认领的、已完成的不必催", async () => {
    const { owner, mate, teamId, taskId } = await seat();
    const byMate = await request(app)
      .patch(`/api/teams/${teamId}/tasks/${taskId}`)
      .set(auth(mate.token))
      .send({ nudge: true });
    expect(byMate.status).toBe(403);

    const selfTask = await request(app)
      .post(`/api/teams/${teamId}/tasks`)
      .set(auth(owner.token))
      .send({ title: "自己写", assigneeId: owner.user.id });
    const bySelf = await request(app)
      .patch(`/api/teams/${teamId}/tasks/${selfTask.body.id}`)
      .set(auth(owner.token))
      .send({ nudge: true });
    expect(bySelf.status).toBe(400);

    const unassigned = await request(app)
      .post(`/api/teams/${teamId}/tasks`)
      .set(auth(owner.token))
      .send({ title: "待认领" });
    const byUnassigned = await request(app)
      .patch(`/api/teams/${teamId}/tasks/${unassigned.body.id}`)
      .set(auth(owner.token))
      .send({ nudge: true });
    expect(byUnassigned.status).toBe(400);

    await request(app)
      .patch(`/api/teams/${teamId}/tasks/${taskId}`)
      .set(auth(mate.token))
      .send({ status: "done", result: "交完了。" });
    const byDone = await request(app)
      .patch(`/api/teams/${teamId}/tasks/${taskId}`)
      .set(auth(owner.token))
      .send({ nudge: true });
    expect(byDone.status).toBe(400);
  });
});

describe("优先级：先做哪件，任务自己说（d.268）", () => {
  let app: App;
  beforeEach(() => {
    app = createApp(createMemoryStore(), { allowRegister: true });
  });

  async function seat() {
    const owner = await register(app, "priboss", "组长");
    const teamId = await makeTeam(app, owner.token, "优先级小组");
    return { owner, teamId };
  }

  it("创建时可以标高优先级，读回来还是 high；不填默认 normal", async () => {
    const { owner, teamId } = await seat();
    const urgent = await request(app)
      .post(`/api/teams/${teamId}/tasks`)
      .set(auth(owner.token))
      .send({ title: "线上故障排查", priority: "high" });
    expect(urgent.status).toBe(201);
    expect(urgent.body.priority).toBe("high");

    const normal = await request(app)
      .post(`/api/teams/${teamId}/tasks`)
      .set(auth(owner.token))
      .send({ title: "写周报" });
    expect(normal.status).toBe(201);
    expect(normal.body.priority).toBe("normal");
  });

  it("可以改优先级；非法档位被拒（400）", async () => {
    const { owner, teamId } = await seat();
    const task = await request(app)
      .post(`/api/teams/${teamId}/tasks`)
      .set(auth(owner.token))
      .send({ title: "补测试" });
    const raised = await request(app)
      .patch(`/api/teams/${teamId}/tasks/${task.body.id}`)
      .set(auth(owner.token))
      .send({ priority: "high" });
    expect(raised.status).toBe(200);
    expect(raised.body.priority).toBe("high");

    const bad = await request(app)
      .patch(`/api/teams/${teamId}/tasks/${task.body.id}`)
      .set(auth(owner.token))
      .send({ priority: "urgent" });
    expect(bad.status).toBe(400);
  });
});

describe("任务讨论：留言谁都能看、谁都不能改（d.271）", () => {
  let app: App;
  beforeEach(() => {
    presence.reset();
    app = createApp(createMemoryStore(), { allowRegister: true });
  });

  it("成员留言 201，列表按时间升序；非成员 403", async () => {
    const owner = await register(app, "admin");
    await register(app, "linxiao");
    const teamId = await makeTeam(app, owner.token, "增长小组", ["linxiao"]);
    const created = await request(app)
      .post(`/api/teams/${teamId}/tasks`)
      .set(auth(owner.token))
      .send({ title: "改落地页" });
    expect(created.status).toBe(201);
    const taskId = created.body.id as string;

    const outsider = await register(app, "outsider");
    const denied = await request(app)
      .post(`/api/teams/${teamId}/tasks/${taskId}/comments`)
      .set(auth(outsider.token))
      .send({ text: "我不是成员" });
    expect(denied.status).toBe(403);

    const first = await request(app)
      .post(`/api/teams/${teamId}/tasks/${taskId}/comments`)
      .set(auth(owner.token))
      .send({ text: "口径按老版本走" });
    expect(first.status).toBe(201);
    expect(first.body.text).toBe("口径按老版本走");

    const list = await request(app)
      .get(`/api/teams/${teamId}/tasks/${taskId}/comments`)
      .set(auth(owner.token));
    expect(list.status).toBe(200);
    expect(list.body.comments).toHaveLength(1);
    expect(list.body.comments[0].text).toBe("口径按老版本走");
  });

  it("空留言 400、任务不存在 404", async () => {
    const owner = await register(app, "admin");
    const teamId = await makeTeam(app, owner.token, "增长小组");
    const empty = await request(app)
      .post(`/api/teams/${teamId}/tasks/no-such-task/comments`)
      .set(auth(owner.token))
      .send({ text: "   " });
    expect(empty.status).toBe(400);
    const missing = await request(app)
      .get(`/api/teams/${teamId}/tasks/no-such-task/comments`)
      .set(auth(owner.token));
    expect(missing.status).toBe(404);
  });
});

describe("验收：交上来的要有人看过（d.272）", () => {
  let app: App;

  beforeEach(() => {
    presence.reset();
    app = createApp(createMemoryStore(), { allowRegister: true });
  });

  it("组长验收通过：打上「已验收」，状态不动", async () => {
    const boss = await register(app, "d272boss", "阿鸣");
    const mate = await register(app, "d272mate", "小李");
    const teamId = await makeTeam(app, boss.token, "验收组", [mate.user.username]);
    const created = await request(app)
      .post(`/api/teams/${teamId}/tasks`)
      .set(auth(boss.token))
      .send({ title: "写接口文档", assigneeId: mate.user.id });
    expect(created.status).toBe(201);

    const done = await request(app)
      .patch(`/api/teams/${teamId}/tasks/${created.body.id}`)
      .set(auth(mate.token))
      .send({ status: "done", result: "文档写完了，pnpm test 全绿。" });
    expect(done.status).toBe(200);
    // 刚交上来是「待验收」，不是默认通过。
    expect(done.body.reviewState).toBe("pending");

    const reviewed = await request(app)
      .patch(`/api/teams/${teamId}/tasks/${created.body.id}`)
      .set(auth(boss.token))
      .send({ review: "approve", reviewNote: "看过，可以发。" });
    expect(reviewed.status).toBe(200);
    expect(reviewed.body.reviewState).toBe("approved");
    expect(reviewed.body.reviewNote).toBe("看过，可以发。");
    expect(reviewed.body.reviewedBy).toBe(boss.user.id);
    expect(reviewed.body.status).toBe("done");
  });

  it("打回重做：状态回进行中、保留上一版结论，且必须写原因", async () => {
    const boss = await register(app, "d272boss2", "阿鸣");
    const mate = await register(app, "d272mate2", "小李");
    const teamId = await makeTeam(app, boss.token, "验收二组", [mate.user.username]);
    const created = await request(app)
      .post(`/api/teams/${teamId}/tasks`)
      .set(auth(boss.token))
      .send({ title: "写部署脚本", assigneeId: mate.user.id });
    await request(app)
      .patch(`/api/teams/${teamId}/tasks/${created.body.id}`)
      .set(auth(mate.token))
      .send({ status: "done", result: "先交一版" });

    const noNote = await request(app)
      .patch(`/api/teams/${teamId}/tasks/${created.body.id}`)
      .set(auth(boss.token))
      .send({ review: "changes" });
    expect(noNote.status).toBe(400);

    const sentBack = await request(app)
      .patch(`/api/teams/${teamId}/tasks/${created.body.id}`)
      .set(auth(boss.token))
      .send({ review: "changes", reviewNote: "少了回滚步骤，补上再交。" });
    expect(sentBack.status).toBe(200);
    expect(sentBack.body.reviewState).toBe("changes");
    expect(sentBack.body.status).toBe("doing");
    expect(sentBack.body.reviewNote).toBe("少了回滚步骤，补上再交。");
    // 上一版结论留着，改的人才知道上一版交的是什么。
    expect(sentBack.body.result).toBe("先交一版");
  });

  it("只有组长能验收，而且只验收已完成的任务", async () => {
    const boss = await register(app, "d272boss3", "阿鸣");
    const mate = await register(app, "d272mate3", "小李");
    const teamId = await makeTeam(app, boss.token, "验收三组", [mate.user.username]);
    const created = await request(app)
      .post(`/api/teams/${teamId}/tasks`)
      .set(auth(boss.token))
      .send({ title: "还没做", assigneeId: mate.user.id });

    const notDone = await request(app)
      .patch(`/api/teams/${teamId}/tasks/${created.body.id}`)
      .set(auth(boss.token))
      .send({ review: "approve" });
    expect(notDone.status).toBe(400);
    expect(notDone.body.error).toContain("只有已完成的任务可以验收");

    await request(app)
      .patch(`/api/teams/${teamId}/tasks/${created.body.id}`)
      .set(auth(mate.token))
      .send({ status: "done", result: "做完了" });
    const byMember = await request(app)
      .patch(`/api/teams/${teamId}/tasks/${created.body.id}`)
      .set(auth(mate.token))
      .send({ review: "approve" });
    expect(byMember.status).toBe(403);
  });
});

describe("团队动态（d.273）", () => {
  let app: App;

  beforeEach(() => {
    presence.reset();
    app = createApp(createMemoryStore(), { allowRegister: true });
  });

  it("派活会留下一条动态：谁派的、派给谁、什么时候截止", async () => {
    const boss = await register(app, "d273boss", "阿鸣");
    const mate = await register(app, "d273mate", "小李");
    const teamId = await makeTeam(app, boss.token, "动态组", [mate.user.username]);

    const first = await request(app)
      .post(`/api/teams/${teamId}/tasks`)
      .set(auth(boss.token))
      .send({ title: "整理发布清单", assigneeId: mate.user.id, dueAt: "2026-11-20T00:00:00.000Z" });
    expect(first.status).toBe(201);
    const second = await request(app)
      .post(`/api/teams/${teamId}/tasks`)
      .set(auth(boss.token))
      .send({ title: "补接口文档" });
    expect(second.status).toBe(201);

    const res = await request(app).get(`/api/teams/${teamId}/events`).set(auth(boss.token));
    expect(res.status).toBe(200);
    const events = res.body.events as {
      kind: string;
      summary: string;
      taskTitle: string;
      actorId: string;
    }[];
    // 建队时加成员也会留动态（d.274），所以只看派活那几条。
    const taskEvents = events.filter((e) => e.kind === "task_added");
    expect(taskEvents).toHaveLength(2);
    // 最新的在前。
    expect(taskEvents[0]!.taskTitle).toBe("补接口文档");
    expect(taskEvents[1]!.taskTitle).toBe("整理发布清单");
    expect(taskEvents.every((e) => e.actorId === boss.user.id)).toBe(true);
    expect(taskEvents[1]!.summary).toContain("派给 小李");
    // 截止只写到日，别把 ISO 串整个倒进动态里。
    expect(taskEvents[1]!.summary).toContain("2026-11-20");
    expect(taskEvents[1]!.summary).not.toContain("T00:00:00");
  });

  it("改状态、改优先级、催办：合成一条动态，人话能读懂", async () => {
    const boss = await register(app, "d273boss2", "阿鸣");
    const mate = await register(app, "d273mate2", "小李");
    const teamId = await makeTeam(app, boss.token, "动态二组", [mate.user.username]);
    const created = await request(app)
      .post(`/api/teams/${teamId}/tasks`)
      .set(auth(boss.token))
      .send({ title: "修登录闪退", assigneeId: mate.user.id });
    const taskId = created.body.id as string;

    const updated = await request(app)
      .patch(`/api/teams/${teamId}/tasks/${taskId}`)
      .set(auth(mate.token))
      .send({ status: "doing", priority: "high" });
    expect(updated.status).toBe(200);
    const nudged = await request(app)
      .patch(`/api/teams/${teamId}/tasks/${taskId}`)
      .set(auth(boss.token))
      .send({ nudge: true });
    expect(nudged.status).toBe(200);

    const res = await request(app).get(`/api/teams/${teamId}/events?limit=10`).set(auth(boss.token));
    const events = res.body.events as { kind: string; summary: string }[];
    expect(events[0]!.kind).toBe("task_updated");
    expect(events[0]!.summary).toContain("催了「修登录闪退」");
    const combined = events.find((e) => e.summary.includes("从无开始"));
    expect(combined).toBeUndefined();
    const statusEvent = events.find((e) => e.summary.includes("改成进行中"));
    expect(statusEvent).toBeDefined();
    expect(statusEvent!.summary).toContain("优先级改成高");
    expect(statusEvent!.summary).toContain("从未开始改成进行中");
  });

  it("留言进动态；非成员看不到，也不能读", async () => {
    const boss = await register(app, "d273boss3", "阿鸣");
    const mate = await register(app, "d273mate3", "小李");
    const outsider = await register(app, "d273out", "外人");
    const teamId = await makeTeam(app, boss.token, "动态三组", [mate.user.username]);
    const created = await request(app)
      .post(`/api/teams/${teamId}/tasks`)
      .set(auth(boss.token))
      .send({ title: "核对埋点", assigneeId: mate.user.id });
    const taskId = created.body.id as string;

    const comment = await request(app)
      .post(`/api/teams/${teamId}/tasks/${taskId}/comments`)
      .set(auth(mate.token))
      .send({ text: "这个埋点用老版本还是新版本的字段？" });
    expect(comment.status).toBe(201);

    const res = await request(app).get(`/api/teams/${teamId}/events`).set(auth(boss.token));
    const events = res.body.events as { kind: string; summary: string }[];
    const commentEvent = events.find((e) => e.kind === "task_comment");
    expect(commentEvent).toBeDefined();
    expect(commentEvent!.summary).toContain("核对埋点");
    expect(commentEvent!.summary).toContain("老版本还是新版本");

    const denied = await request(app).get(`/api/teams/${teamId}/events`).set(auth(outsider.token));
    expect(denied.status).toBe(404);
  });
});

describe("团队动态补全：方案与成员也留痕（d.274）", () => {
  let app: App;

  beforeEach(() => {
    presence.reset();
    app = createApp(createMemoryStore(), { allowRegister: true });
  });

  it("加成员、建/改/删方案都进时间线", async () => {
    const boss = await register(app, "d274boss", "阿鸣");
    const extra = await register(app, "d274extra", "小王");
    const teamId = await makeTeam(app, boss.token, "留痕组", []);

    const added = await request(app)
      .post(`/api/teams/${teamId}/members`)
      .set(auth(boss.token))
      .send({ username: extra.user.username });
    expect(added.status).toBe(200);

    const plan = await request(app)
      .post(`/api/teams/${teamId}/plans`)
      .set(auth(boss.token))
      .send({ title: "发布计划", detail: "先灰度再全量" });
    expect(plan.status).toBe(201);
    const planId = plan.body.id as string;

    const patched = await request(app)
      .patch(`/api/teams/${teamId}/plans/${planId}`)
      .set(auth(boss.token))
      .send({ title: "发布计划 v2", status: "doing" });
    expect(patched.status).toBe(200);

    const removed = await request(app)
      .delete(`/api/teams/${teamId}/plans/${planId}`)
      .set(auth(boss.token));
    expect(removed.status).toBe(204);

    const res = await request(app).get(`/api/teams/${teamId}/events?limit=20`).set(auth(boss.token));
    expect(res.status).toBe(200);
    const events = res.body.events as { kind: string; summary: string }[];
    expect(events.find((e) => e.kind === "member_added")!.summary).toContain("把 小王 加进了团队");
    expect(events.find((e) => e.kind === "plan_added")!.summary).toContain("新建方案「发布计划」");
    const updatedEvent = events.find((e) => e.kind === "plan_updated");
    expect(updatedEvent).toBeDefined();
    expect(updatedEvent!.summary).toContain("发布计划 v2");
    // 只写改了哪几个字段，不把整段说明倒进动态。
    expect(updatedEvent!.summary).toContain("标题、状态");
    expect(events.find((e) => e.kind === "plan_removed")!.summary).toContain("删除了方案「发布计划 v2」");
  });

  it("移除成员与自己退出各自留一条", async () => {
    const boss = await register(app, "d274boss2", "阿鸣");
    const mate = await register(app, "d274mate2", "小李");
    const other = await register(app, "d274other2", "小赵");
    const teamId = await makeTeam(app, boss.token, "留痕二组", [mate.user.username, other.user.username]);

    const kicked = await request(app)
      .delete(`/api/teams/${teamId}/members/${mate.user.id}`)
      .set(auth(boss.token));
    expect(kicked.status).toBe(200);

    const left = await request(app).post(`/api/teams/${teamId}/leave`).set(auth(other.token));
    expect(left.status).toBe(204);

    const res = await request(app).get(`/api/teams/${teamId}/events?limit=20`).set(auth(boss.token));
    const events = res.body.events as { kind: string; summary: string }[];
    expect(events.find((e) => e.summary.includes("移出了团队"))!.summary).toContain("把 小李 移出了团队");
    expect(events.find((e) => e.summary.includes("退出了团队"))!.summary).toContain("小赵 退出了团队");
  });

  it("转让队长留一条，且新队长能看到", async () => {
    const boss = await register(app, "d274boss3", "阿鸣");
    const mate = await register(app, "d274mate3", "小李");
    const teamId = await makeTeam(app, boss.token, "留痕三组", [mate.user.username]);

    const transfer = await request(app)
      .post(`/api/teams/${teamId}/owner`)
      .set(auth(boss.token))
      .send({ userId: mate.user.id });
    expect(transfer.status).toBe(200);

    const res = await request(app).get(`/api/teams/${teamId}/events`).set(auth(mate.token));
    const events = res.body.events as { kind: string; summary: string; actorId: string }[];
    const event = events.find((e) => e.kind === "owner_transferred");
    expect(event).toBeDefined();
    expect(event!.summary).toContain("把队长转给了 小李");
    expect(event!.actorId).toBe(boss.user.id);
  });
});

describe("单件任务的历史（d.276）", () => {
  let app: App;

  beforeEach(() => {
    presence.reset();
    app = createApp(createMemoryStore(), { allowRegister: true });
  });

  it("events?taskId= 只回这一条活的流水，别的任务不混进来", async () => {
    const boss = await register(app, "d276boss", "阿鸣");
    const mate = await register(app, "d276mate", "小李");
    const teamId = await makeTeam(app, boss.token, "历史组", [mate.user.username]);

    const first = await request(app)
      .post(`/api/teams/${teamId}/tasks`)
      .set(auth(boss.token))
      .send({ title: "改落地页", assigneeId: mate.user.id });
    expect(first.status).toBe(201);
    const second = await request(app)
      .post(`/api/teams/${teamId}/tasks`)
      .set(auth(boss.token))
      .send({ title: "写周报" });
    expect(second.status).toBe(201);

    const patched = await request(app)
      .patch(`/api/teams/${teamId}/tasks/${first.body.id}`)
      .set(auth(mate.token))
      .send({ status: "doing" });
    expect(patched.status).toBe(200);

    const all = await request(app).get(`/api/teams/${teamId}/events`).set(auth(boss.token));
    expect(all.status).toBe(200);
    expect(all.body.events.length).toBeGreaterThan(2);

    const one = await request(app)
      .get(`/api/teams/${teamId}/events?taskId=${first.body.id}`)
      .set(auth(boss.token));
    expect(one.status).toBe(200);
    const events = one.body.events as { taskId: string | null; kind: string }[];
    expect(events).toHaveLength(2);
    expect(events.every((e) => e.taskId === first.body.id)).toBe(true);
    expect(events.map((e) => e.kind).sort()).toEqual(["task_added", "task_updated"]);

    // 非成员仍然看不到。
    const outsider = await register(app, "d276out", "路人");
    const denied = await request(app)
      .get(`/api/teams/${teamId}/events?taskId=${first.body.id}`)
      .set(auth(outsider.token));
    expect(denied.status).toBe(404);
  });
});

describe("人走了，活要归位（d.278）", () => {
  let app: App;

  beforeEach(() => {
    presence.reset();
    app = createApp(createMemoryStore(), { allowRegister: true });
  });

  it("把成员移出：他名下没做完的活回到待认领，单件历史里能查到为什么", async () => {
    const boss = await register(app, "d278boss", "阿鸣");
    const mate = await register(app, "d278mate", "小李");
    const teamId = await makeTeam(app, boss.token, "归位组", [mate.user.username]);

    const created = await request(app)
      .post(`/api/teams/${teamId}/tasks`)
      .set(auth(boss.token))
      .send({ title: "改落地页", assigneeId: mate.user.id });
    expect(created.status).toBe(201);

    const removed = await request(app)
      .delete(`/api/teams/${teamId}/members/${mate.user.id}`)
      .set(auth(boss.token));
    expect(removed.status).toBe(200);
    const snapshot = removed.body as { tasks: { id: string; assigneeId: string | null }[] };
    expect(snapshot.tasks.find((task) => task.id === created.body.id)?.assigneeId).toBeNull();

    const history = await request(app)
      .get(`/api/teams/${teamId}/events?taskId=${created.body.id}`)
      .set(auth(boss.token));
    expect(history.status).toBe(200);
    const summaries = (history.body.events as { summary: string }[]).map((event) => event.summary);
    expect(summaries.some((text) => text.includes("回到「待认领」"))).toBe(true);
    expect(summaries.some((text) => text.includes("小李"))).toBe(true);
  });

  it("自己退出：名下的活同样回到待认领，团队动态里说清是谁走的", async () => {
    const boss = await register(app, "d278boss2", "阿鸣");
    const mate = await register(app, "d278mate2", "小李");
    const teamId = await makeTeam(app, boss.token, "归位二组", [mate.user.username]);

    const created = await request(app)
      .post(`/api/teams/${teamId}/tasks`)
      .set(auth(boss.token))
      .send({ title: "写接口文档", assigneeId: mate.user.id });
    expect(created.status).toBe(201);

    const left = await request(app).post(`/api/teams/${teamId}/leave`).set(auth(mate.token));
    expect(left.status).toBe(204);

    const snapshot = await request(app).get(`/api/teams/${teamId}`).set(auth(boss.token));
    expect(snapshot.status).toBe(200);
    const tasks = snapshot.body.tasks as { id: string; assigneeId: string | null }[];
    expect(tasks.find((task) => task.id === created.body.id)?.assigneeId).toBeNull();

    const events = await request(app).get(`/api/teams/${teamId}/events`).set(auth(boss.token));
    const summaries = (events.body.events as { summary: string }[]).map((event) => event.summary);
    expect(summaries.some((text) => text.includes("退出了团队"))).toBe(true);
    expect(summaries.some((text) => text.includes("回到「待认领」"))).toBe(true);
  });
});
