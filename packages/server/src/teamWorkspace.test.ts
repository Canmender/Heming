import { describe, it, expect, beforeEach } from "vitest";
import request from "supertest";
import { createMemoryStore } from "./store.js";
import { createApp } from "./app.js";

type App = ReturnType<typeof createApp>;

/**
 * d.92 团队工作台 REST 用例（app 层）。
 *
 * 覆盖：建团队 → 加成员 → 方案/任务 CRUD → 权限 → 级联删除。
 * 重点守三条口径：
 * 1. **非成员一律 404**，且响应体与「团队不存在」逐字一致（不泄露存在性）；
 * 2. owner-only 动作对成员返回 403、对非成员仍是 404；
 * 3. 任务的两类引用必须先校验：指派非成员 / 挂到别的团队的方案 → 400。
 */

async function register(app: App, username: string) {
  const res = await request(app).post("/api/auth/register").send({
    username,
    password: "secret123",
    displayName: username.toUpperCase(),
  });
  expect(res.status).toBe(201);
  return res.body as { token: string; user: { id: string; username: string } };
}

const auth = (token: string) => ({ Authorization: `Bearer ${token}` });

describe("团队工作台 REST", () => {
  let app: App;
  let alice: Awaited<ReturnType<typeof register>>;
  let bob: Awaited<ReturnType<typeof register>>;
  let carol: Awaited<ReturnType<typeof register>>;

  beforeEach(async () => {
    app = createApp(createMemoryStore(), { allowRegister: true });
    alice = await register(app, "alice");
    bob = await register(app, "bob");
    carol = await register(app, "carol");
  });

  async function createTeam(token: string, body: Record<string, unknown> = {}) {
    const res = await request(app)
      .post("/api/teams")
      .set(auth(token))
      .send({ name: "课程组", goal: "把课表排好", ...body });
    expect(res.status).toBe(201);
    return res.body as {
      team: { id: string; name: string; goal: string; ownerId: string };
      members: Array<{ role: string; user: { id: string } }>;
      plans: unknown[];
      tasks: unknown[];
    };
  }

  it("未登录一律 401（含全部读写入口）", async () => {
    for (const req of [
      request(app).get("/api/teams"),
      request(app).post("/api/teams").send({ name: "x" }),
      request(app).get("/api/teams/any"),
      request(app).patch("/api/teams/any").send({ name: "x" }),
      request(app).delete("/api/teams/any"),
      request(app).post("/api/teams/any/members").send({ username: "bob" }),
      request(app).delete("/api/teams/any/members/u"),
      request(app).post("/api/teams/any/plans").send({ title: "x" }),
      request(app).patch("/api/teams/any/plans/p").send({ title: "x" }),
      request(app).delete("/api/teams/any/plans/p"),
      request(app).post("/api/teams/any/tasks").send({ title: "x" }),
      request(app).patch("/api/teams/any/tasks/t").send({ status: "done" }),
      request(app).delete("/api/teams/any/tasks/t"),
    ]) {
      expect((await req).status).toBe(401);
    }
  });

  it("建团队：201 快照（owner 成员一条）、列表可见、GET 一致", async () => {
    const created = await createTeam(alice.token);
    expect(created.team).toMatchObject({ name: "课程组", goal: "把课表排好", ownerId: alice.user.id });
    expect(created.members).toHaveLength(1);
    expect(created.members[0]).toMatchObject({ role: "owner", user: { id: alice.user.id } });

    const list = await request(app).get("/api/teams").set(auth(alice.token));
    expect(list.status).toBe(200);
    expect(list.body.teams.map((t: { id: string }) => t.id)).toEqual([created.team.id]);

    const one = await request(app).get(`/api/teams/${created.team.id}`).set(auth(alice.token));
    expect(one.status).toBe(200);
    expect(one.body.team.id).toBe(created.team.id);

    // 别人的列表里没有它
    const other = await request(app).get("/api/teams").set(auth(bob.token));
    expect(other.body.teams).toEqual([]);
  });

  it("建团队校验：空名字 400 中文原因；没有要改的字段 400", async () => {
    const bad = await request(app)
      .post("/api/teams")
      .set(auth(alice.token))
      .send({ name: "   " });
    expect(bad.status).toBe(400);
    expect(bad.body.error).toBe("请填写团队名称");

    const team = await createTeam(alice.token);
    const empty = await request(app)
      .patch(`/api/teams/${team.team.id}`)
      .set(auth(alice.token))
      .send({});
    expect(empty.status).toBe(400);
    expect(empty.body.error).toBe("没有要修改的字段");
  });

  it("非成员访问团队：404 且与「团队不存在」响应体一致（不泄露存在性）", async () => {
    const team = await createTeam(alice.token);
    const outsider = await request(app).get(`/api/teams/${team.team.id}`).set(auth(bob.token));
    const ghost = await request(app).get("/api/teams/does-not-exist").set(auth(bob.token));
    expect(outsider.status).toBe(404);
    expect(ghost.status).toBe(404);
    expect(outsider.body).toEqual(ghost.body);
    expect(outsider.body).toEqual({ error: "团队不存在" });

    // 写口同样：非成员建方案/任务 → 404 而不是 403
    const plan = await request(app)
      .post(`/api/teams/${team.team.id}/plans`)
      .set(auth(bob.token))
      .send({ title: "偷排" });
    expect(plan.status).toBe(404);
    const task = await request(app)
      .post(`/api/teams/${team.team.id}/tasks`)
      .set(auth(bob.token))
      .send({ title: "偷派" });
    expect(task.status).toBe(404);
  });

  it("member 管理：owner 可加人；未知用户 404、重复 409、非 owner 403、非成员 404", async () => {
    const team = await createTeam(alice.token);
    // 非 owner（还不是成员）→ 404 不泄露
    const ghostAdd = await request(app)
      .post(`/api/teams/${team.team.id}/members`)
      .set(auth(bob.token))
      .send({ username: "carol" });
    expect(ghostAdd.status).toBe(404);

    // owner 加 bob
    const added = await request(app)
      .post(`/api/teams/${team.team.id}/members`)
      .set(auth(alice.token))
      .send({ username: "bob" });
    expect(added.status).toBe(200);
    expect(added.body.members.map((m: { user: { username: string } }) => m.user.username)).toEqual([
      "alice",
      "bob",
    ]);

    // 现在是成员但还不是 owner：加人 403
    const forbidden = await request(app)
      .post(`/api/teams/${team.team.id}/members`)
      .set(auth(bob.token))
      .send({ username: "carol" });
    expect(forbidden.status).toBe(403);
    expect(forbidden.body.error).toBe("只有团队创建者可以添加成员");

    const unknown = await request(app)
      .post(`/api/teams/${team.team.id}/members`)
      .set(auth(alice.token))
      .send({ username: "nobody" });
    expect(unknown.status).toBe(404);
    expect(unknown.body.error).toBe("该用户不存在");

    const dup = await request(app)
      .post(`/api/teams/${team.team.id}/members`)
      .set(auth(alice.token))
      .send({ username: "bob" });
    expect(dup.status).toBe(409);
    expect(dup.body.error).toBe("该用户已在团队里");

    // 成员查得到团队了
    const bobView = await request(app).get(`/api/teams/${team.team.id}`).set(auth(bob.token));
    expect(bobView.status).toBe(200);
  });

  it("权限：非 owner 改/删团队 403；不能移除 owner 409；移除成员后他 404", async () => {
    const team = await createTeam(alice.token);
    await request(app)
      .post(`/api/teams/${team.team.id}/members`)
      .set(auth(alice.token))
      .send({ username: "bob" });

    const patch = await request(app)
      .patch(`/api/teams/${team.team.id}`)
      .set(auth(bob.token))
      .send({ name: "改个名" });
    expect(patch.status).toBe(403);
    expect(patch.body.error).toBe("只有团队创建者可以修改团队信息");

    const del = await request(app).delete(`/api/teams/${team.team.id}`).set(auth(bob.token));
    expect(del.status).toBe(403);

    // 非 owner 移除成员也是 403
    const kick = await request(app)
      .delete(`/api/teams/${team.team.id}/members/${alice.user.id}`)
      .set(auth(bob.token));
    expect(kick.status).toBe(403);
    expect(kick.body.error).toBe("只有团队创建者可以移除成员");

    // owner 不能被移除
    const selfKick = await request(app)
      .delete(`/api/teams/${team.team.id}/members/${alice.user.id}`)
      .set(auth(alice.token));
    expect(selfKick.status).toBe(409);
    expect(selfKick.body.error).toBe("不能移除团队创建者");

    // owner 移除 bob → bob 立刻 404
    const removed = await request(app)
      .delete(`/api/teams/${team.team.id}/members/${bob.user.id}`)
      .set(auth(alice.token));
    expect(removed.status).toBe(200);
    expect(removed.body.members).toHaveLength(1);
    const afterKick = await request(app).get(`/api/teams/${team.team.id}`).set(auth(bob.token));
    expect(afterKick.status).toBe(404);

    // owner 改团队成功
    const ok = await request(app)
      .patch(`/api/teams/${team.team.id}`)
      .set(auth(alice.token))
      .send({ name: "新组名", goal: "新目标" });
    expect(ok.status).toBe(200);
    expect(ok.body.team).toMatchObject({ name: "新组名", goal: "新目标" });
  });

  it("方案 CRUD：201/成员可改/404 不存在/204 删除", async () => {
    const team = await createTeam(alice.token);
    const created = await request(app)
      .post(`/api/teams/${team.team.id}/plans`)
      .set(auth(alice.token))
      .send({ title: "收集课程", detail: "把三周课表拉齐" });
    expect(created.status).toBe(201);
    expect(created.body).toMatchObject({ title: "收集课程", status: "todo", orderIndex: 0 });
    const planId = created.body.id as string;

    const patched = await request(app)
      .patch(`/api/teams/${team.team.id}/plans/${planId}`)
      .set(auth(alice.token))
      .send({ status: "doing" });
    expect(patched.status).toBe(200);
    expect(patched.body.status).toBe("doing");

    // 不存在的方案 404（成员身份下）
    const ghost = await request(app)
      .patch(`/api/teams/${team.team.id}/plans/nope`)
      .set(auth(alice.token))
      .send({ title: "x" });
    expect(ghost.status).toBe(404);
    expect(ghost.body.error).toBe("方案不存在");

    const del = await request(app)
      .delete(`/api/teams/${team.team.id}/plans/${planId}`)
      .set(auth(alice.token));
    expect(del.status).toBe(204);
    const delAgain = await request(app)
      .delete(`/api/teams/${team.team.id}/plans/${planId}`)
      .set(auth(alice.token));
    expect(delAgain.status).toBe(404);

    // 列表里已经没有了
    const snap = await request(app).get(`/api/teams/${team.team.id}`).set(auth(alice.token));
    expect(snap.body.plans).toEqual([]);
  });

  it("任务 CRUD：可指派成员/挂方案；指派非成员与跨团队方案 400", async () => {
    const team = await createTeam(alice.token);
    await request(app)
      .post(`/api/teams/${team.team.id}/members`)
      .set(auth(alice.token))
      .send({ username: "bob" });
    const plan = await request(app)
      .post(`/api/teams/${team.team.id}/plans`)
      .set(auth(alice.token))
      .send({ title: "方案" });

    // 另一个团队的方案，不能挂到本团队任务上
    const otherTeam = await createTeam(carol.token, { name: "别人的组" });
    const foreignPlan = await request(app)
      .post(`/api/teams/${otherTeam.team.id}/plans`)
      .set(auth(carol.token))
      .send({ title: "外部方案" });

    const created = await request(app)
      .post(`/api/teams/${team.team.id}/tasks`)
      .set(auth(alice.token))
      .send({
        title: "导出课表",
        planId: plan.body.id,
        assigneeId: bob.user.id,
        dueAt: "2026-12-01T00:00:00.000Z",
      });
    expect(created.status).toBe(201);
    expect(created.body).toMatchObject({
      title: "导出课表",
      planId: plan.body.id,
      assigneeId: bob.user.id,
      status: "todo",
      attachmentFileId: null,
    });
    const taskId = created.body.id as string;

    // 指派非成员 → 400
    const badAssignee = await request(app)
      .post(`/api/teams/${team.team.id}/tasks`)
      .set(auth(alice.token))
      .send({ title: "x", assigneeId: carol.user.id });
    expect(badAssignee.status).toBe(400);
    expect(badAssignee.body.error).toBe("只能把任务指派给团队成员");

    // 跨团队方案 → 400
    const badPlan = await request(app)
      .post(`/api/teams/${team.team.id}/tasks`)
      .set(auth(alice.token))
      .send({ title: "x", planId: foreignPlan.body.id });
    expect(badPlan.status).toBe(400);
    expect(badPlan.body.error).toBe("方案不属于该团队");

    // 成员改任务状态；再改回待认领
    const patched = await request(app)
      .patch(`/api/teams/${team.team.id}/tasks/${taskId}`)
      .set(auth(bob.token))
      .send({ status: "done", assigneeId: null });
    expect(patched.status).toBe(200);
    expect(patched.body).toMatchObject({ status: "done", assigneeId: null });

    // 不存在的任务 404
    const ghost = await request(app)
      .patch(`/api/teams/${team.team.id}/tasks/nope`)
      .set(auth(alice.token))
      .send({ status: "done" });
    expect(ghost.status).toBe(404);
    expect(ghost.body.error).toBe("任务不存在");

    const del = await request(app)
      .delete(`/api/teams/${team.team.id}/tasks/${taskId}`)
      .set(auth(alice.token));
    expect(del.status).toBe(204);
  });

  it("级联删除：删团队后 GET 404、列表为空、成员身份一并清掉", async () => {
    const team = await createTeam(alice.token);
    await request(app)
      .post(`/api/teams/${team.team.id}/members`)
      .set(auth(alice.token))
      .send({ username: "bob" });
    await request(app)
      .post(`/api/teams/${team.team.id}/plans`)
      .set(auth(alice.token))
      .send({ title: "方案" });
    await request(app)
      .post(`/api/teams/${team.team.id}/tasks`)
      .set(auth(alice.token))
      .send({ title: "任务" });

    const del = await request(app).delete(`/api/teams/${team.team.id}`).set(auth(alice.token));
    expect(del.status).toBe(204);

    expect((await request(app).get(`/api/teams/${team.team.id}`).set(auth(alice.token))).status).toBe(
      404,
    );
    expect((await request(app).get(`/api/teams/${team.team.id}`).set(auth(bob.token))).status).toBe(
      404,
    );
    expect((await request(app).get("/api/teams").set(auth(alice.token))).body.teams).toEqual([]);
    expect((await request(app).get("/api/teams").set(auth(bob.token))).body.teams).toEqual([]);
  });
});
