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

  it("交付物必须指向共享文件库里真实存在的文件（d.109 A1 + 悬空引用修复）", async () => {
    const team = await createTeam(alice.token);

    // 文件库上传：交付物只接受真实文件 id
    const upload = await request(app)
      .post("/api/files")
      .set(auth(alice.token))
      .send({
        name: "交付物.txt",
        mime: "text/plain",
        contentBase64: Buffer.from("hi").toString("base64"),
      });
    expect(upload.status).toBe(201);
    const fileId = upload.body.id as string;

    const created = await request(app)
      .post(`/api/teams/${team.team.id}/tasks`)
      .set(auth(alice.token))
      .send({ title: "带交付物", attachmentFileId: fileId });
    expect(created.status).toBe(201);
    expect(created.body.attachmentFileId).toBe(fileId);

    // 快照（GET /api/teams/:id）能看到同一条任务带了交付物
    const snap = await request(app).get(`/api/teams/${team.team.id}`).set(auth(alice.token));
    expect(snap.status).toBe(200);
    const inSnap = (snap.body.tasks as Array<{ id: string; attachmentFileId: string | null }>).find(
      (t) => t.id === created.body.id,
    );
    expect(inSnap?.attachmentFileId).toBe(fileId);

    // 悬空 id → 400（历史行为是照单全收，任务卡点开永远 404）
    const ghost = await request(app)
      .post(`/api/teams/${team.team.id}/tasks`)
      .set(auth(alice.token))
      .send({ title: "悬空交付物", attachmentFileId: "file-123" });
    expect(ghost.status).toBe(400);
    expect(ghost.body.error).toBe("交付物文件不存在，请先在共享文件库上传");

    const ghostPatch = await request(app)
      .patch(`/api/teams/${team.team.id}/tasks/${created.body.id}`)
      .set(auth(alice.token))
      .send({ attachmentFileId: "file-404" });
    expect(ghostPatch.status).toBe(400);

    // 删文件时必须把任务上的引用摘掉：否则任务卡「交付物」永久 404
    const removed = await request(app).delete(`/api/files/${fileId}`).set(auth(alice.token));
    expect(removed.status).toBe(204);
    const snap2 = await request(app).get(`/api/teams/${team.team.id}`).set(auth(alice.token));
    const after = (snap2.body.tasks as Array<{ id: string; attachmentFileId: string | null }>).find(
      (t) => t.id === created.body.id,
    );
    expect(after?.attachmentFileId).toBeNull();

    // 不传 → null（无交付物的任务行为不变）
    const plain = await request(app)
      .post(`/api/teams/${team.team.id}/tasks`)
      .set(auth(alice.token))
      .send({ title: "无交付物" });
    expect(plain.status).toBe(201);
    expect(plain.body.attachmentFileId).toBeNull();

    // 显式 null 也合法（表单清空时客户端会这么传）
    const explicitNull = await request(app)
      .post(`/api/teams/${team.team.id}/tasks`)
      .set(auth(alice.token))
      .send({ title: "显式 null", attachmentFileId: null });
    expect(explicitNull.status).toBe(201);
    expect(explicitNull.body.attachmentFileId).toBeNull();
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

  it("成员可以自己退出：退出后看不到团队、任务解绑成待认领、其它成员不受影响", async () => {
    const team = await createTeam(alice.token);
    await request(app)
      .post(`/api/teams/${team.team.id}/members`)
      .set(auth(alice.token))
      .send({ username: "bob" });
    const task = await request(app)
      .post(`/api/teams/${team.team.id}/tasks`)
      .set(auth(alice.token))
      .send({ title: "bob 的活", assigneeId: bob.user.id });
    expect(task.status).toBe(201);

    const leave = await request(app).post(`/api/teams/${team.team.id}/leave`).set(auth(bob.token));
    expect(leave.status).toBe(204);

    // 退出后与「非成员」完全同口径：GET 404、列表里也没有
    const gone = await request(app).get(`/api/teams/${team.team.id}`).set(auth(bob.token));
    expect(gone.status).toBe(404);
    expect(gone.body).toEqual({ error: "团队不存在" });
    expect((await request(app).get("/api/teams").set(auth(bob.token))).body.teams).toEqual([]);

    // 团队还在，任务被解绑成「待认领」，不留指给非成员的非法引用
    const snap = await request(app).get(`/api/teams/${team.team.id}`).set(auth(alice.token));
    expect(snap.status).toBe(200);
    expect(snap.body.members.map((m: { user: { username: string } }) => m.user.username)).toEqual([
      "alice",
    ]);
    expect((snap.body.tasks as Array<{ assigneeId: string | null }>)[0]?.assigneeId).toBeNull();

    // 再退一次：已经不是成员 → 404（幂等，不报 500）
    expect(
      (await request(app).post(`/api/teams/${team.team.id}/leave`).set(auth(bob.token))).status,
    ).toBe(404);
    // 非成员对不存在的团队也是 404
    expect(
      (await request(app).post(`/api/teams/ghost-team/leave`).set(auth(bob.token))).status,
    ).toBe(404);
  });

  it("owner 不能直接退出：409 且仍是 owner（团队不能无主）", async () => {
    const team = await createTeam(alice.token);
    await request(app)
      .post(`/api/teams/${team.team.id}/members`)
      .set(auth(alice.token))
      .send({ username: "bob" });

    const leave = await request(app).post(`/api/teams/${team.team.id}/leave`).set(auth(alice.token));
    expect(leave.status).toBe(409);
    expect(leave.body.error).toBe("队长请先转让团队再退出");

    const snap = await request(app).get(`/api/teams/${team.team.id}`).set(auth(alice.token));
    expect(snap.status).toBe(200);
    expect(snap.body.team.ownerId).toBe(alice.user.id);
    expect(snap.body.members.map((m: { user: { username: string } }) => m.user.username)).toEqual([
      "alice",
      "bob",
    ]);
  });

  it("转让队长：owner 变更 + 角色互换，原 owner 立刻失去 owner-only 权限", async () => {
    const team = await createTeam(alice.token);
    await request(app)
      .post(`/api/teams/${team.team.id}/members`)
      .set(auth(alice.token))
      .send({ username: "bob" });

    const transfer = await request(app)
      .post(`/api/teams/${team.team.id}/owner`)
      .set(auth(alice.token))
      .send({ userId: bob.user.id });
    expect(transfer.status).toBe(200);
    expect(transfer.body.team.ownerId).toBe(bob.user.id);
    const roles = new Map(
      (transfer.body.members as Array<{ role: string; user: { username: string } }>).map((m) => [
        m.user.username,
        m.role,
      ]),
    );
    expect(roles.get("bob")).toBe("owner");
    expect(roles.get("alice")).toBe("member");

    // 原 owner 降级：改名/加人 → 403；新 owner 可以改名
    expect(
      (
        await request(app)
          .patch(`/api/teams/${team.team.id}`)
          .set(auth(alice.token))
          .send({ name: "改不了" })
      ).status,
    ).toBe(403);
    expect(
      (
        await request(app)
          .post(`/api/teams/${team.team.id}/members`)
          .set(auth(alice.token))
          .send({ username: "carol" })
      ).status,
    ).toBe(403);
    expect(
      (
        await request(app)
          .patch(`/api/teams/${team.team.id}`)
          .set(auth(bob.token))
          .send({ name: "bob 的课组" })
      ).status,
    ).toBe(200);

    // 新 owner 不能退出（同样 409），但可以移出原 owner
    expect(
      (await request(app).post(`/api/teams/${team.team.id}/leave`).set(auth(bob.token))).status,
    ).toBe(409);
    expect(
      (
        await request(app)
          .delete(`/api/teams/${team.team.id}/members/${alice.user.id}`)
          .set(auth(bob.token))
      ).status,
    ).toBe(200);
    expect(
      (await request(app).get(`/api/teams/${team.team.id}`).set(auth(alice.token))).status,
    ).toBe(404);
  });

  it("转让队长：非成员 404 / 成员非 owner 403 / 目标非成员 400 / 转给自己 400", async () => {
    const team = await createTeam(alice.token);
    await request(app)
      .post(`/api/teams/${team.team.id}/members`)
      .set(auth(alice.token))
      .send({ username: "bob" });

    const ghost = await request(app)
      .post("/api/teams/ghost-team/owner")
      .set(auth(alice.token))
      .send({ userId: bob.user.id });
    expect(ghost.status).toBe(404);
    expect(ghost.body).toEqual({ error: "团队不存在" });

    // 非成员转让（目标选真成员 bob）：仍是「团队不存在」，不泄露团队存在性
    const outsider = await request(app)
      .post(`/api/teams/${team.team.id}/owner`)
      .set(auth(carol.token))
      .send({ userId: bob.user.id });
    expect(outsider.status).toBe(404);
    expect(outsider.body).toEqual({ error: "团队不存在" });

    // 成员但不是 owner：403（owner-only 动作）；目标选 owner 自己，避免撞上「不能转给自己」
    const notOwner = await request(app)
      .post(`/api/teams/${team.team.id}/owner`)
      .set(auth(bob.token))
      .send({ userId: alice.user.id });
    expect(notOwner.status).toBe(403);
    expect(notOwner.body.error).toBe("只有团队创建者可以转让团队");

    const notMember = await request(app)
      .post(`/api/teams/${team.team.id}/owner`)
      .set(auth(alice.token))
      .send({ userId: carol.user.id });
    expect(notMember.status).toBe(400);
    expect(notMember.body.error).toBe("只能转让给团队成员");

    const self = await request(app)
      .post(`/api/teams/${team.team.id}/owner`)
      .set(auth(alice.token))
      .send({ userId: alice.user.id });
    expect(self.status).toBe(400);
    expect(self.body.error).toBe("不能转让给自己");

    // 空 body / 空 userId 走 zod → 400 中文
    const empty = await request(app)
      .post(`/api/teams/${team.team.id}/owner`)
      .set(auth(alice.token))
      .send({ userId: "  " });
    expect(empty.status).toBe(400);
    expect(empty.body.error).toBe("请选择要转让给的成员");
  });

  it("团队知识库 REST：CRUD + 搜索 + 权限（非成员 404、作者/组长可改、队员禁改）", async () => {
    const team = await createTeam(alice.token);
    const teamId = team.team.id;
    // owner 加 bob（队员）成为成员；carol 保持非成员
    const added = await request(app)
      .post(`/api/teams/${teamId}/members`)
      .set(auth(alice.token))
      .send({ username: "bob" });
    expect(added.status).toBe(200);

    // 未登录 401
    expect((await request(app).get(`/api/teams/${teamId}/knowledge`)).status).toBe(401);

    // 非成员 404（响应体与「团队不存在」一致）
    const ghost = await request(app).get(`/api/teams/${teamId}/knowledge`).set(auth(carol.token));
    expect(ghost.status).toBe(404);
    expect(ghost.body.error).toBe("团队不存在");

    // 建文档（bob 建）
    const bad = await request(app)
      .post(`/api/teams/${teamId}/knowledge`)
      .set(auth(bob.token))
      .send({ title: "   ", content: "x" });
    expect(bad.status).toBe(400);

    const created = await request(app)
      .post(`/api/teams/${teamId}/knowledge`)
      .set(auth(bob.token))
      .send({ title: "接口约定", content: "每周一更新排班，注意节假日", tags: ["api"] });
    expect(created.status).toBe(201);
    const docId = created.body.id as string;
    expect(created.body.authorId).toBe(bob.user.id);

    // 列表 / 单读
    const list = await request(app).get(`/api/teams/${teamId}/knowledge`).set(auth(alice.token));
    expect(list.status).toBe(200);
    expect(list.body.docs.map((d: { id: string }) => d.id)).toEqual([docId]);
    const one = await request(app).get(`/api/teams/${teamId}/knowledge/${docId}`).set(auth(alice.token));
    expect(one.body.title).toBe("接口约定");

    // 搜索（中文子串，>=3 字符走 FTS/线性一致）
    const found = await request(app)
      .get(`/api/teams/${teamId}/knowledge/search`)
      .query({ q: "节假日" })
      .set(auth(alice.token));
    expect(found.status).toBe(200);
    expect(found.body.docs.map((d: { id: string }) => d.id)).toEqual([docId]);

    // 队员改别人的 → 403；作者改 / 组长改 → 200
    const carolGuest = await request(app)
      .post(`/api/teams/${teamId}/knowledge`)
      .set(auth(alice.token))
      .send({ title: "组长文档", content: "y" });
    expect(carolGuest.status).toBe(201);
    const foreignPatch = await request(app)
      .patch(`/api/teams/${teamId}/knowledge/${carolGuest.body.id}`)
      .set(auth(bob.token))
      .send({ title: "抢" });
    expect(foreignPatch.status).toBe(403);
    const ownerPatch = await request(app)
      .patch(`/api/teams/${teamId}/knowledge/${docId}`)
      .set(auth(alice.token))
      .send({ title: "接口约定 v2" });
    expect(ownerPatch.status).toBe(200);
    expect(ownerPatch.body.title).toBe("接口约定 v2");

    // 删除 + 非成员删 404
    const ghostDel = await request(app)
      .delete(`/api/teams/${teamId}/knowledge/${docId}`)
      .set(auth(carol.token));
    expect(ghostDel.status).toBe(404);
    const del = await request(app)
      .delete(`/api/teams/${teamId}/knowledge/${docId}`)
      .set(auth(bob.token));
    expect(del.status).toBe(204);
    const after = await request(app).get(`/api/teams/${teamId}/knowledge`).set(auth(alice.token));
    expect(after.body.docs.map((d: { id: string }) => d.id)).toEqual([carolGuest.body.id]);

    // 删除动作写进团队动态（team_events）
    const events = await request(app).get(`/api/teams/${teamId}/events`).set(auth(alice.token));
    expect(events.body.events.some((e: { kind: string }) => e.kind === "knowledge_removed")).toBe(true);
  });

  it("团队发现 + 加入申请 REST：目录/申请/审批/权限/动态", async () => {
    const team = await createTeam(alice.token);
    const teamId = team.team.id;

    // 未登录 401
    expect((await request(app).get("/api/teams/discover")).status).toBe(401);
    expect((await request(app).post(`/api/teams/${teamId}/join-requests`).send({})).status).toBe(401);

    // 目录：carol 能搜到团队（只暴露元数据）
    const dir = await request(app).get("/api/teams/discover").query({ q: "课程" }).set(auth(carol.token));
    expect(dir.status).toBe(200);
    const found = dir.body.teams.find((t: { id: string }) => t.id === teamId);
    expect(found).toMatchObject({ name: "课程组", memberCount: 1 });
    expect(Object.keys(found).sort()).toEqual(["createdAt", "goal", "id", "memberCount", "name"].sort());

    // carol 申请加入（附言）
    const applied = await request(app)
      .post(`/api/teams/${teamId}/join-requests`)
      .set(auth(carol.token))
      .send({ message: "我也想加入" });
    expect(applied.status).toBe(201);
    expect(applied.body).toMatchObject({ status: "pending", userId: carol.user.id, message: "我也想加入" });
    const reqId = applied.body.id as string;

    // 重复申请 409；我的申请能查到
    expect(
      (await request(app).post(`/api/teams/${teamId}/join-requests`).set(auth(carol.token)).send({})).status,
    ).toBe(409);
    const mine = await request(app).get("/api/teams/join-requests/mine").set(auth(carol.token));
    expect(mine.body.requests.map((r: { id: string }) => r.id)).toContain(reqId);

    // 审批列表：队长 200，非成员 404，队员 403（先加 bob）
    await request(app).post(`/api/teams/${teamId}/members`).set(auth(alice.token)).send({ username: "bob" });
    const listOwner = await request(app).get(`/api/teams/${teamId}/join-requests`).set(auth(alice.token));
    expect(listOwner.body.requests.map((r: { id: string }) => r.id)).toEqual([reqId]);
    expect((await request(app).get(`/api/teams/${teamId}/join-requests`).set(auth(bob.token))).status).toBe(403);
    expect((await request(app).get(`/api/teams/${teamId}/join-requests`)).status).toBe(401);

    // 队员不能审；队长通过 → carol 成为成员；重复审 409
    expect(
      (await request(app)
        .post(`/api/teams/${teamId}/join-requests/${reqId}/review`)
        .set(auth(bob.token))
        .send({ action: "approve" })).status,
    ).toBe(403);
    const approved = await request(app)
      .post(`/api/teams/${teamId}/join-requests/${reqId}/review`)
      .set(auth(alice.token))
      .send({ action: "approve" });
    expect(approved.status).toBe(200);
    expect(approved.body.status).toBe("approved");
    const carolTeam = await request(app).get(`/api/teams/${teamId}`).set(auth(carol.token));
    expect(carolTeam.status).toBe(200);
    expect(
      (await request(app)
        .post(`/api/teams/${teamId}/join-requests/${reqId}/review`)
        .set(auth(alice.token))
        .send({ action: "reject" })).status,
    ).toBe(409);

    // 动态：join_requested / join_approved 都进时间线
    const events = await request(app).get(`/api/teams/${teamId}/events`).set(auth(alice.token));
    const kinds = events.body.events.map((e: { kind: string }) => e.kind);
    expect(kinds).toContain("join_requested");
    expect(kinds).toContain("join_approved");
  });

  it("状态机收紧：已完成任务不能裸改 status 绕过验收（1.3）", async () => {
    const team = await createTeam(alice.token);
    await request(app)
      .post(`/api/teams/${team.team.id}/members`)
      .set(auth(alice.token))
      .send({ username: "bob" });
    const created = await request(app)
      .post(`/api/teams/${team.team.id}/tasks`)
      .set(auth(alice.token))
      .send({ title: "写脚本", assigneeId: bob.user.id });
    const taskId = created.body.id as string;

    // 标完成 + 写结论
    const done = await request(app)
      .patch(`/api/teams/${team.team.id}/tasks/${taskId}`)
      .set(auth(bob.token))
      .send({ status: "done", result: "写完了" });
    expect(done.status).toBe(200);

    // 裸改 status 退回 todo（胶囊循环）→ 409 done_locked（负责人与组长都不行）
    const revert = await request(app)
      .patch(`/api/teams/${team.team.id}/tasks/${taskId}`)
      .set(auth(bob.token))
      .send({ status: "todo" });
    expect(revert.status).toBe(409);
    expect(revert.body.error).toContain("不能点状态胶囊退回");
    const revertByOwner = await request(app)
      .patch(`/api/teams/${team.team.id}/tasks/${taskId}`)
      .set(auth(alice.token))
      .send({ status: "todo" });
    expect(revertByOwner.status).toBe(409);

    // done→doing（本人重开继续做）仍是正当路径，保留结论。
    const reopened = await request(app)
      .patch(`/api/teams/${team.team.id}/tasks/${taskId}`)
      .set(auth(bob.token))
      .send({ status: "doing" });
    expect(reopened.status).toBe(200);
    expect(reopened.body).toMatchObject({ status: "doing", result: "写完了" });
    // 再标完成，供下面打回
    await request(app)
      .patch(`/api/teams/${team.team.id}/tasks/${taskId}`)
      .set(auth(bob.token))
      .send({ status: "done" });

    // 状态仍是 done
    const snap = await request(app).get(`/api/teams/${team.team.id}`).set(auth(alice.token));
    expect(snap.body.tasks.find((t: { id: string }) => t.id === taskId).status).toBe("done");

    // 正道：组长打回重做 → doing + 原因
    const sentBack = await request(app)
      .patch(`/api/teams/${team.team.id}/tasks/${taskId}`)
      .set(auth(alice.token))
      .send({ review: "changes", reviewNote: "补一下回滚步骤" });
    expect(sentBack.status).toBe(200);
    expect(sentBack.body).toMatchObject({ status: "doing", reviewState: "changes" });
  });
});
