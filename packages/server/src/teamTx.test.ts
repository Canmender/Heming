import { describe, it, expect, afterEach } from "vitest";
import { createRequire } from "node:module";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import request from "supertest";
import { createSqliteStore } from "./sqliteStore.js";
import { createApp } from "./app.js";

// node:sqlite 与 db.ts 同法经 createRequire 原生加载（静态 import 会被 vite-node 剥前缀）
const { DatabaseSync } = createRequire(import.meta.url)("node:sqlite") as typeof import("node:sqlite");

type App = ReturnType<typeof createApp>;

/**
 * 团队多语句写的**事务性**专项（P1-1）。
 *
 * 这几条路径坏过的后果都是「不可恢复态」：建团队只写入 teams 行、删团队只删掉成员行……
 * 孤儿团队既不在列表里（listWorkspaceTeams 靠成员关系），DELETE 也 404，只能手工改库。
 * 修法是 sqliteStore 的 runTx()；这里用 SQLite 触发器在第 N 条语句上注入失败，
 * 断言「要么全成、要么全不动」——不做失败注入的话，事务写没写其实测不出来。
 */

const tmpDirs: string[] = [];
afterEach(() => {
  // Windows 上 sqlite 句柄在进程内不会显式关闭，删临时目录可能 EPERM——测试结果不受影响。
  while (tmpDirs.length) {
    try {
      rmSync(tmpDirs.pop()!, { recursive: true, force: true, maxRetries: 3, retryDelay: 50 });
    } catch {
      /* 留给系统清理 */
    }
  }
});

function setup() {
  const dir = mkdtempSync(join(tmpdir(), "heming-teamtx-"));
  tmpDirs.push(dir);
  const dbPath = join(dir, "t.db");
  const store = createSqliteStore(dbPath);
  const app = createApp(store, { allowRegister: true });
  return { store, app, dbPath };
}

async function register(app: App, username: string) {
  const res = await request(app).post("/api/auth/register").send({
    username,
    password: "secret123",
    displayName: username.toUpperCase(),
  });
  expect(res.status).toBe(201);
  return res.body as { token: string; user: { id: string; username: string } };
}

/** 开第二条连接装触发器：让事务中的某条语句失败（模拟进程崩溃/约束冲突）。 */
function injectFailure(dbPath: string, sql: string): void {
  const db = new DatabaseSync(dbPath);
  db.exec(sql);
  db.close();
}

function countRows(dbPath: string, sql: string): number {
  const db = new DatabaseSync(dbPath);
  const row = db.prepare(sql).get() as { n: number } | undefined;
  db.close();
  return Number(row?.n ?? 0);
}

describe("团队多语句写的事务性（sqlite）", () => {
  it("建团队：owner 成员写失败 → 整体回滚，不留孤儿团队", async () => {
    const { store, app, dbPath } = setup();
    const alice = await register(app, "alice");
    injectFailure(
      dbPath,
      "CREATE TRIGGER boom_member BEFORE INSERT ON team_members BEGIN SELECT RAISE(ABORT, 'boom-member'); END;",
    );

    expect(() =>
      store.createWorkspaceTeam(alice.user.id, { name: "孤儿团队", goal: "" }),
    ).toThrow(/boom-member/);

    // 关键断言：teams 表也必须干净（只回滚 team_members 会留下看不见也删不掉的团队）
    expect(countRows(dbPath, "SELECT COUNT(*) AS n FROM teams")).toBe(0);
    expect(countRows(dbPath, "SELECT COUNT(*) AS n FROM team_members")).toBe(0);
    expect(store.listWorkspaceTeams(alice.user.id)).toEqual([]);
  });

  it("删团队：级联中途失败 → 团队、成员、方案、任务全部原样保留", async () => {
    const { store, app, dbPath } = setup();
    const alice = await register(app, "alice");
    const bob = await register(app, "bob");

    const snap = store.createWorkspaceTeam(alice.user.id, { name: "课程组", goal: "" });
    const teamId = snap.team.id;
    store.addWorkspaceMember(teamId, alice.user.id, "bob");
    const plan = store.createTeamPlan(teamId, alice.user.id, { title: "先做审计" });
    expect(typeof plan).toBe("object");
    const planId = (plan as { id: string }).id;
    store.createTeamTask(teamId, alice.user.id, {
      title: "审计接口",
      assigneeId: bob.user.id,
      planId,
    });

    // 让「删成员」这一步失败（第 3 条语句）
    injectFailure(
      dbPath,
      "CREATE TRIGGER boom_del_member BEFORE DELETE ON team_members BEGIN SELECT RAISE(ABORT, 'boom-del'); END;",
    );

    expect(() => store.deleteWorkspaceTeam(teamId, alice.user.id)).toThrow(/boom-del/);

    const after = store.getWorkspaceTeam(teamId, alice.user.id);
    expect(after).not.toBeNull();
    expect(after!.members).toHaveLength(2);
    expect(after!.plans).toHaveLength(1);
    expect(after!.tasks).toHaveLength(1);
    expect(after!.tasks[0]!.assigneeId).toBe(bob.user.id);
  });

  it("移除成员：解绑任务失败 → 成员关系回滚（不会出现「人走了任务还指着他」）", async () => {
    const { store, app, dbPath } = setup();
    const alice = await register(app, "alice");
    const bob = await register(app, "bob");

    const snap = store.createWorkspaceTeam(alice.user.id, { name: "课程组", goal: "" });
    const teamId = snap.team.id;
    store.addWorkspaceMember(teamId, alice.user.id, "bob");
    store.createTeamTask(teamId, alice.user.id, { title: "审计接口", assigneeId: bob.user.id });

    injectFailure(
      dbPath,
      "CREATE TRIGGER boom_unbind BEFORE UPDATE ON team_tasks BEGIN SELECT RAISE(ABORT, 'boom-unbind'); END;",
    );

    expect(() => store.removeWorkspaceMember(teamId, alice.user.id, bob.user.id)).toThrow(
      /boom-unbind/,
    );

    const after = store.getWorkspaceTeam(teamId, alice.user.id)!;
    expect(after.members.map((m) => m.user.id)).toContain(bob.user.id);
    expect(after.tasks[0]!.assigneeId).toBe(bob.user.id);
  });

  it("删方案：解绑任务失败 → 方案还在（不留指向不存在方案的悬空任务）", async () => {
    const { store, app, dbPath } = setup();
    const alice = await register(app, "alice");

    const snap = store.createWorkspaceTeam(alice.user.id, { name: "课程组", goal: "" });
    const teamId = snap.team.id;
    const plan = store.createTeamPlan(teamId, alice.user.id, { title: "先做审计" });
    const planId = (plan as { id: string }).id;
    store.createTeamTask(teamId, alice.user.id, { title: "审计接口", planId });

    injectFailure(
      dbPath,
      "CREATE TRIGGER boom_unbind2 BEFORE UPDATE ON team_tasks BEGIN SELECT RAISE(ABORT, 'boom-unbind2'); END;",
    );

    expect(() => store.deleteTeamPlan(teamId, planId, alice.user.id)).toThrow(/boom-unbind2/);

    const after = store.getWorkspaceTeam(teamId, alice.user.id)!;
    expect(after.plans.map((p) => p.id)).toContain(planId);
    expect(after.tasks[0]!.planId).toBe(planId);
  });

  it("成员自退：解绑任务失败 → 成员关系回滚（不会出现「人退了任务还指着他」）", async () => {
    const { store, app, dbPath } = setup();
    const alice = await register(app, "alice");
    const bob = await register(app, "bob");

    const snap = store.createWorkspaceTeam(alice.user.id, { name: "课程组", goal: "" });
    const teamId = snap.team.id;
    store.addWorkspaceMember(teamId, alice.user.id, "bob");
    store.createTeamTask(teamId, alice.user.id, { title: "审计接口", assigneeId: bob.user.id });

    injectFailure(
      dbPath,
      "CREATE TRIGGER boom_leave BEFORE UPDATE ON team_tasks BEGIN SELECT RAISE(ABORT, 'boom-leave'); END;",
    );

    expect(() => store.leaveWorkspaceTeam(teamId, bob.user.id)).toThrow(/boom-leave/);

    // 两条写必须同生共死：bob 还在团队里，任务也还指着他
    const after = store.getWorkspaceTeam(teamId, alice.user.id)!;
    expect(after.members.map((m) => m.user.id)).toContain(bob.user.id);
    expect(after.tasks[0]!.assigneeId).toBe(bob.user.id);
    expect(store.getWorkspaceTeam(teamId, bob.user.id)).not.toBeNull();
  });

  it("转让队长：角色互换中途失败 → owner_id 与角色一起回滚（不会出现「两个 owner」）", async () => {
    const { store, app, dbPath } = setup();
    const alice = await register(app, "alice");
    const bob = await register(app, "bob");

    const snap = store.createWorkspaceTeam(alice.user.id, { name: "课程组", goal: "" });
    const teamId = snap.team.id;
    store.addWorkspaceMember(teamId, alice.user.id, "bob");

    // 第 2 条语句给 bob 写 owner 角色时失败（此时 owner_id 已经改成 bob、alice 已被降级）
    injectFailure(
      dbPath,
      "CREATE TRIGGER boom_role BEFORE UPDATE OF role ON team_members WHEN NEW.role = 'owner' BEGIN SELECT RAISE(ABORT, 'boom-role'); END;",
    );

    expect(() => store.transferTeamOwnership(teamId, alice.user.id, bob.user.id)).toThrow(
      /boom-role/,
    );

    const after = store.getWorkspaceTeam(teamId, alice.user.id)!;
    expect(after.team.ownerId).toBe(alice.user.id);
    const roles = new Map(after.members.map((m) => [m.user.id, m.role]));
    expect(roles.get(alice.user.id)).toBe("owner");
    expect(roles.get(bob.user.id)).toBe("member");
  });

  it("重复加成员：唯一约束冲突被翻译成 already_member（不是 500）", async () => {
    const { store, app } = setup();
    const alice = await register(app, "alice");
    await register(app, "bob");

    const snap = store.createWorkspaceTeam(alice.user.id, { name: "课程组", goal: "" });
    const teamId = snap.team.id;
    expect(typeof store.addWorkspaceMember(teamId, alice.user.id, "bob")).toBe("object");
    expect(store.addWorkspaceMember(teamId, alice.user.id, "bob")).toBe("already_member");

    // API 层同一口径（历史行为：并发下 PK 冲突冒成 500 HTML）
    const res = await request(app)
      .post(`/api/teams/${teamId}/members`)
      .set({ Authorization: `Bearer ${alice.token}` })
      .send({ username: "bob" });
    expect(res.status).toBe(409); // 已是成员：409（不是 500，也不是静默成功）
    expect(typeof res.body.error).toBe("string");
  });
});

describe("存量动向标题迁移（T2-02，sqlite）", () => {
  it("打开库时幂等迁移把旧 task 行 title 改成「任务」，非 task 行不动", () => {
    const { dbPath } = setup();

    // 模拟「收紧前」的历史库：直接插两条旧行（task 带提问首行；staff 是自由文本、应保留）
    const raw = new DatabaseSync(dbPath);
    const insert = raw.prepare(
      `INSERT INTO team_activities
         (id, actor_id, kind, title, detail, status, source_id, occurred_at, created_at)
       VALUES (?, 'u-legacy', ?, ?, ?, ?, ?, '2026-11-01T00:00:00.000Z', '2026-11-01T00:00:00.000Z')`,
    );
    insert.run("legacy-task", "task", "帮我把客户的身份证号整理成表格", "任务 · 已完成", "done", "task:legacy:1");
    insert.run("legacy-staff", "staff", "幕僚摘要", null, null, "staff:legacy:1");
    raw.close();

    // 再开一次库 = 走生产路径 openDb → initSchema（迁移在这里执行）
    createSqliteStore(dbPath);

    const check = new DatabaseSync(dbPath);
    const task = check.prepare("SELECT title FROM team_activities WHERE id = 'legacy-task'").get() as {
      title: string;
    };
    const staff = check.prepare("SELECT title FROM team_activities WHERE id = 'legacy-staff'").get() as {
      title: string;
    };
    check.close();

    expect(task.title).toBe("任务");
    expect(staff.title).toBe("幕僚摘要");
  });

  it("迁移可重复执行（幂等）：第二次打开库不报错、不留半截状态", () => {
    const { dbPath } = setup();
    expect(() => createSqliteStore(dbPath)).not.toThrow();
    expect(() => createSqliteStore(dbPath)).not.toThrow();
  });
});
