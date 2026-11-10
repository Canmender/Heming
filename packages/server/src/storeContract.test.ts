import { describe, it, expect, beforeEach, afterEach } from "vitest";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createMemoryStore, type Store } from "./store.js";
import { createSqliteStore } from "./sqliteStore.js";

type Factory = { name: string; create: () => Store & { close?: () => void } };
const tmpDirs: string[] = [];
const factories: Factory[] = [
  { name: "memory", create: () => createMemoryStore() },
  {
    name: "sqlite",
    create: () => {
      const dir = mkdtempSync(join(tmpdir(), "heming-"));
      tmpDirs.push(dir);
      return createSqliteStore(join(dir, "test.db"));
    },
  },
];

afterEach(() => {
  while (tmpDirs.length) rmSync(tmpDirs.pop()!, { recursive: true, force: true });
});

for (const f of factories) {
  describe(`Store contract: ${f.name}`, () => {
    let store: Store & { close?: () => void };
    beforeEach(() => {
      store = f.create();
    });
    afterEach(() => {
      store.close?.();
    });

    it("智能体名册 CRUD 与系统 agent 保护", () => {
      const a = store.createUser("alice", "h", "爱丽丝");
      const b = store.createUser("bob", "h", "鲍勃");
      const agent = store.createAgent(a.id, { name: "助理", description: "d" });
      expect(store.listAgents().map((x) => x.id)).toContain(agent.id);
      expect(store.updateAgent(agent.id, a.id, { name: "新名" }).name).toBe("新名");
      expect(() => store.updateAgent(agent.id, b.id, { name: "x" })).toThrow("forbidden");
      expect(() => store.deleteAgent(agent.id, b.id)).toThrow("forbidden");

      store.ensureSystemAgents();
      const sys = store.listAgents().find((x) => x.id === "system-assistant")!;
      expect(sys.name).toBe("和小鸣");
      expect(() => store.updateAgent(sys.id, a.id, { name: "x" })).toThrow("forbidden");
      expect(() => store.deleteAgent(sys.id, a.id)).toThrow("forbidden");
    });

    it("createAgentConversation 幂等；自建仅属主，系统 agent 谁都能开", () => {
      const a = store.createUser("alice", "h", "爱丽丝");
      const b = store.createUser("bob", "h", "鲍勃");
      const agent = store.createAgent(a.id, { name: "私房", description: "" });
      const c1 = store.createAgentConversation(a.id, agent.id);
      expect(store.createAgentConversation(a.id, agent.id).id).toBe(c1.id);
      expect(() => store.createAgentConversation(b.id, agent.id)).toThrow("not your agent");

      store.ensureSystemAgents();
      const sys = store.listAgents().find((x) => x.id === "system-assistant")!;
      expect(() => store.createAgentConversation(b.id, sys.id)).not.toThrow();
    });

    it("d.128：fresh 新建多段会话；标题可设可清；非成员不能改", () => {
      const a = store.createUser("alice", "h", "爱丽丝");
      const b = store.createUser("bob", "h", "鲍勃");
      const agent = store.createAgent(a.id, { name: "助理", description: "" });
      const c1 = store.createAgentConversation(a.id, agent.id, { title: "第一段" });
      const c2 = store.createAgentConversation(a.id, agent.id, { fresh: true, title: "第二段" });
      expect(c2.id).not.toBe(c1.id);

      const withTitles = store.listConversations(a.id);
      expect(withTitles.find((c) => c.id === c1.id)?.title).toBe("第一段");
      expect(withTitles.find((c) => c.id === c2.id)?.title).toBe("第二段");

      expect(store.updateConversationTitle(c1.id, a.id, "改过的名字")).toBe(true);
      expect(store.listConversations(a.id).find((c) => c.id === c1.id)?.title).toBe("改过的名字");
      // 空串 = 清除标题（列表里该字段消失，不写空串）
      expect(store.updateConversationTitle(c1.id, a.id, "")).toBe(true);
      expect(store.listConversations(a.id).find((c) => c.id === c1.id)?.title).toBeUndefined();

      // 非成员 / 不存在
      expect(store.updateConversationTitle(c1.id, b.id, "bob 改的")).toBe(false);
      expect(store.updateConversationTitle("nope", a.id, "x")).toBe(false);
    });

    it("agent 不存在报错；agent 被删后该会话从列表消失", () => {
      const a = store.createUser("alice", "h", "爱丽丝");
      expect(() => store.createAgentConversation(a.id, "nope")).toThrow("agent not found");
      const agent = store.createAgent(a.id, { name: "临时", description: "" });
      store.createAgentConversation(a.id, agent.id);
      store.deleteAgent(agent.id, a.id);
      expect(store.listConversations(a.id)).toEqual([]);
    });

    it("缺失会话边界一致：isMember false；listMessages 抛 conversation not found", () => {
      expect(store.isMember("nope", "u")).toBe(false);
      expect(store.conversationAgentId("nope")).toBeNull();
      expect(() => store.listMessages("nope")).toThrow("conversation not found");
    });

    it("updateProfile 语义一致：改名 / 省略 avatar 保留 / 空串保留 / 未知用户抛错", () => {
      const a = store.createUser("alice", "h", "爱丽丝");
      expect(store.updateProfile(a.id, { displayName: "新名" }).avatar).toBeUndefined();
      store.updateProfile(a.id, { displayName: "A", avatar: "data:x" });
      expect(store.updateProfile(a.id, { displayName: "B" }).avatar).toBe("data:x");
      expect(store.updateProfile(a.id, { displayName: "C", avatar: "" }).avatar).toBe("");
      expect(() => store.updateProfile("nope", { displayName: "X" })).toThrow("user not found");
    });

    it("消息信封：e2e 落 cipher/chainKid/n 并回读；reencrypt 三态", () => {
      const a = store.createUser("alice", "h", "爱丽丝");
      const b = store.createUser("bob", "h", "鲍勃");
      const agent = store.createAgent(a.id, { name: "助手", description: "" });
      const conv = store.createAgentConversation(a.id, agent.id);
      const e2e = store.addMessage(conv.id, "user", a.id, { text: "" }, {
        enc: "e2e",
        cipher: "Q2lwaGVy",
        chainKid: "kid1",
        n: 2,
      });
      expect(e2e).toMatchObject({ enc: "e2e", cipher: "Q2lwaGVy", chainKid: "kid1", n: 2 });

      const plain = store.addMessage(conv.id, "user", a.id, { text: "旧明文" });
      expect(store.reencryptMessage(plain.id, b.id, { cipher: "x" })).toEqual({
        ok: false,
        reason: "forbidden",
      });
      expect(store.reencryptMessage("nope", a.id, { cipher: "x" })).toEqual({
        ok: false,
        reason: "not_found",
      });
      expect(store.reencryptMessage(e2e.id, a.id, { cipher: "x" })).toEqual({
        ok: false,
        reason: "conflict",
      });
      const ok = store.reencryptMessage(plain.id, a.id, { cipher: "Q2lwaGVy", chainKid: "k2", n: 9 });
      expect(ok.ok).toBe(true);
      if (ok.ok) {
        expect(ok.message).toMatchObject({ enc: "e2e", cipher: "Q2lwaGVy", chainKid: "k2", n: 9 });
        expect(ok.message.payload).toEqual({ text: "" });
      }
      expect(store.listMessages(conv.id).find((m) => m.id === plain.id)?.payload).toEqual({ text: "" });
    });

    it("e2e 设备公钥按 ikEcdh upsert，聚合多用户", () => {
      const device = {
        ikEcdh: "e1",
        ikSign: "s1",
        spk: { pub: "p1", sig: "sig1", createdAt: 1 },
      };
      store.upsertE2eDevice("u1", device);
      store.upsertE2eDevice("u1", { ...device, ikSign: "s1b" });
      store.upsertE2eDevice("u2", { ...device, ikEcdh: "e2" });
      expect(store.listE2eKeys().u1).toHaveLength(1);
      expect(store.listE2eKeys().u1[0].ikSign).toBe("s1b");
      expect(store.listE2eKeys().u2[0].ikEcdh).toBe("e2");
    });

    it("共享文件：增查列删与配额求和", () => {
      store.createUser("alice", "h", "爱丽丝");
      const meta = {
        id: "f1",
        owner: "alice",
        name: "a.txt",
        mime: "text/plain",
        size: 2,
        updatedAt: "2026-11-02T00:00:00.000Z",
      };
      expect(store.addFile(meta, "aGk=")).toEqual(meta);
      expect(store.getFile("f1")?.contentBase64).toBe("aGk=");
      expect(store.listFiles()).toHaveLength(1);
      expect(store.userFileBytes("alice")).toBe(2);
      expect(store.deleteFile("f1")).toBe(true);
      expect(store.getFile("f1")).toBeNull();
      expect(store.deleteFile("f1")).toBe(false);
    });

    it("团队名册：touchUser 刷新最近活跃，未活跃为 null", () => {
      const a = store.createUser("alice", "h", "爱丽丝");
      store.createUser("bob", "h", "鲍勃");
      expect(store.listTeamMembers().every((m) => m.lastSeenAt === null)).toBe(true);
      store.touchUser(a.id);
      expect(store.listTeamMembers().find((m) => m.user.id === a.id)?.lastSeenAt).toBeTruthy();
      store.touchUser("nope"); // 静默忽略
    });

    it("团队动向：(actorId, sourceId) 幂等、倒序、游标、actor 过滤与清空", () => {
      const a = store.createUser("alice", "h", "爱丽丝");
      const b = store.createUser("bob", "h", "鲍勃");
      const base = {
        kind: "task" as const,
        title: "整理课程表",
        occurredAt: "2026-11-01T08:00:00.000Z",
      };
      expect(store.addTeamActivity(a.id, { ...base, sourceId: "task:1" })).toBe(true);
      expect(store.addTeamActivity(a.id, { ...base, sourceId: "task:1" })).toBe(false);
      store.addTeamActivity(a.id, {
        ...base,
        title: "后一条",
        sourceId: "task:2",
        occurredAt: "2026-11-02T08:00:00.000Z",
      });
      store.addTeamActivity(b.id, { ...base, sourceId: "task:1" });

      expect(store.listTeamActivities().map((x) => x.sourceId)).toEqual(["task:2", "task:1", "task:1"]);
      expect(store.listTeamActivities({ actorId: b.id })).toHaveLength(1);
      expect(
        store.listTeamActivities({ before: "2026-11-02T00:00:00.000Z" }).map((x) => x.sourceId),
      ).toEqual(["task:1", "task:1"]);
      expect(store.listTeamActivities({ limit: 1 })).toHaveLength(1);
      expect(store.clearTeamActivities(a.id)).toBe(2);
      expect(store.listTeamActivities().map((x) => x.actorId)).toEqual([b.id]);
      expect(() => store.addTeamActivity("nope", { ...base, sourceId: "x" })).toThrow("user not found");
    });

    it("团队动向：同 occurredAt 按 id DESC 稳定排序，beforeId 组合游标不丢不重", () => {
      const a = store.createUser("alice", "h", "爱丽丝");
      const at = "2026-11-03T08:00:00.000Z";
      for (const sid of ["task:a", "task:b", "task:c"]) {
        store.addTeamActivity(a.id, { kind: "task", title: sid, sourceId: sid, occurredAt: at });
      }

      // 同刻不再靠插入序：两实现统一 occurredAt DESC, id DESC（曾一升一降）
      const all = store.listTeamActivities();
      expect(all).toHaveLength(3);
      const ids = all.map((x) => x.id);
      expect(ids).toEqual([...ids].sort().reverse());

      // limit=2 分两页：合集三条、无重复、第二页严格在游标之后
      const page1 = store.listTeamActivities({ limit: 2 });
      expect(page1).toHaveLength(2);
      const last = page1[1]!;
      const page2 = store.listTeamActivities({
        limit: 2,
        before: last.occurredAt,
        beforeId: last.id,
      });
      expect(page2).toHaveLength(1);
      const union = [...page1, ...page2].map((x) => x.id);
      expect(union).toHaveLength(3);
      expect(new Set(union).size).toBe(3);
      expect(page2[0]!.id < last.id).toBe(true);

      // 旧客户端只传 before（无 beforeId）= 旧语义：同刻条目整体被跳过
      expect(store.listTeamActivities({ before: at })).toEqual([]);
    });

    it("团队任务：创建时写入交付物（两实现同语义，d.109 A1）", () => {
      const a = store.createUser("alice", "h", "爱丽丝");
      const team = store.createWorkspaceTeam(a.id, { name: "课程组" });
      const withFile = store.createTeamTask(team.team.id, a.id, {
        title: "带交付物",
        attachmentFileId: "file-123",
      });
      expect(withFile).toMatchObject({ title: "带交付物", attachmentFileId: "file-123" });
      const id = (withFile as { id: string }).id;
      // 快照读回同一条：SQLite 与内存都不能把它丢成 null
      const snap = store.getWorkspaceTeam(team.team.id, a.id)!;
      expect(snap.tasks.find((t) => t.id === id)?.attachmentFileId).toBe("file-123");

      const plain = store.createTeamTask(team.team.id, a.id, { title: "无交付物" });
      expect(plain).toMatchObject({ attachmentFileId: null });
    });

    it("团队用量：(actor, date, model) 覆盖式幂等、区间读、未知用户抛错", () => {
      const a = store.createUser("alice", "h", "爱丽丝");
      const b = store.createUser("bob", "h", "鲍勃");
      const base = {
        date: "2026-11-02",
        model: "gpt-x",
        tokens: 100 as number | null,
        unreported: 0,
        connections: ["主连接"],
      };
      store.upsertTeamUsage(a.id, base);
      // 同一 (actor, date, model) 再报一次是**覆盖**不是翻倍：客户端报的是该日累计。
      store.upsertTeamUsage(a.id, { ...base, tokens: 250, connections: ["主连接", "备用"] });
      store.upsertTeamUsage(a.id, { ...base, date: "2026-11-01", tokens: null, unreported: 2 });
      store.upsertTeamUsage(b.id, { ...base, model: "claude-y", tokens: 900 });

      const rows = store.listTeamUsage({ from: "2026-11-01", to: "2026-11-02" });
      expect(rows).toHaveLength(3);
      const aliceToday = rows.find((r) => r.actorId === a.id && r.date === "2026-11-02")!;
      expect(aliceToday).toMatchObject({ model: "gpt-x", tokens: 250, connections: ["主连接", "备用"] });
      // null 语义原样保留（未上报 ≠ 0），读回不能变成 0
      expect(rows.find((r) => r.actorId === a.id && r.date === "2026-11-01")!.tokens).toBeNull();

      // 区间是闭区间：只取 11-02 时 11-01 不在其中
      expect(store.listTeamUsage({ from: "2026-11-02", to: "2026-11-02" })).toHaveLength(2);
      expect(store.listTeamUsage({ from: "2026-10-01", to: "2026-10-31" })).toEqual([]);
      expect(() =>
        store.upsertTeamUsage("nope", { ...base, tokens: 1 }),
      ).toThrow("user not found");

      // 清除只删本人：返回删除条数，别人的行原样保留
      expect(store.clearTeamUsage(a.id)).toBe(2);
      expect(store.clearTeamUsage(a.id)).toBe(0);
      const after = store.listTeamUsage({ from: "2026-11-01", to: "2026-11-02" });
      expect(after.map((r) => r.actorId)).toEqual([b.id]);
      expect(store.listTeamUsage({ from: "2026-11-02", to: "2026-11-02" })).toHaveLength(1);
    });

    /* ───────────────────── d.92 团队工作台（两实现同契约） ───────────────────── */

    it("团队工作台：建团队 → 加成员 → 方案/任务 CRUD，快照口径一致", () => {
      const a = store.createUser("alice", "h", "爱丽丝");
      const b = store.createUser("bob", "h", "鲍勃");
      const created = store.createWorkspaceTeam(a.id, { name: "课程组", goal: "把课表排好" });
      expect(created.team).toMatchObject({
        name: "课程组",
        goal: "把课表排好",
        ownerId: a.id,
      });
      expect(created.members).toHaveLength(1);
      expect(created.members[0]).toMatchObject({ role: "owner" });
      expect(created.members[0].user.id).toBe(a.id);
      expect(created.plans).toEqual([]);
      expect(created.tasks).toEqual([]);

      // 列表：只有成员看得到；建完即出现
      expect(store.listWorkspaceTeams(a.id).map((t) => t.id)).toEqual([created.team.id]);
      expect(store.listWorkspaceTeams(b.id)).toEqual([]);
      // 非成员读快照 = null（不泄露存在性）
      expect(store.getWorkspaceTeam(created.team.id, b.id)).toBeNull();
      expect(store.getWorkspaceTeam("nope", a.id)).toBeNull();

      // 加成员后 b 也能读；重复加是 already_member；未知用户名单独区分
      const added = store.addWorkspaceMember(created.team.id, a.id, "bob");
      expect(added).not.toBeNull();
      expect((added as { members: unknown[] }).members).toHaveLength(2);
      expect(store.addWorkspaceMember(created.team.id, a.id, "bob")).toBe("already_member");
      expect(store.addWorkspaceMember(created.team.id, a.id, "nobody")).toBe("user_not_found");
      expect(store.listWorkspaceTeams(b.id).map((t) => t.id)).toEqual([created.team.id]);

      // 方案：orderIndex 缺省按添加序；成员可改
      const plan1 = store.createTeamPlan(created.team.id, a.id, { title: "收集课程" });
      const plan2 = store.createTeamPlan(created.team.id, b.id, { title: "排查冲突" });
      expect(plan1).not.toBe("not_found");
      expect((plan1 as { orderIndex: number }).orderIndex).toBe(0);
      expect((plan2 as { orderIndex: number }).orderIndex).toBe(1);
      const planId = (plan1 as { id: string }).id;
      const updatedPlan = store.updateTeamPlan(created.team.id, planId, b.id, {
        status: "doing",
        title: "收集全部课程",
      });
      expect(updatedPlan).toMatchObject({ status: "doing", title: "收集全部课程" });

      // 任务：可挂方案、可指派成员；非成员不能指派、跨团队方案不行
      const task = store.createTeamTask(created.team.id, a.id, {
        title: "导出课表",
        planId,
        assigneeId: b.id,
      });
      expect(task).toMatchObject({ planId, assigneeId: b.id, status: "todo" });
      const taskId = (task as { id: string }).id;
      expect(
        store.createTeamTask(created.team.id, a.id, { title: "x", assigneeId: "outsider" }),
      ).toBe("assignee_not_member");
      expect(
        store.createTeamTask(created.team.id, a.id, { title: "x", planId: "no-such-plan" }),
      ).toBe("plan_not_found");

      // 外地人（非成员）读写一律 null（app 404），不泄露团队存在性
      expect(store.createTeamPlan(created.team.id, "outsider", { title: "x" })).toBeNull();
      expect(store.createTeamTask(created.team.id, "outsider", { title: "x" })).toBeNull();
      expect(store.updateTeamPlan(created.team.id, planId, "outsider", { title: "x" })).toBeNull();

      // 改任务：状态推进 + 换人 + 解绑
      const patched = store.updateTeamTask(created.team.id, taskId, b.id, {
        status: "done",
        assigneeId: null,
      });
      expect(patched).toMatchObject({ status: "done", assigneeId: null });

      // 快照顺序：owner 在前、方案按 orderIndex、任务按创建序
      const snap = store.getWorkspaceTeam(created.team.id, b.id)!;
      expect(snap.members.map((m) => m.role)).toEqual(["owner", "member"]);
      expect(snap.plans.map((p) => p.id)).toEqual([planId, (plan2 as { id: string }).id]);
      expect(snap.tasks.map((t) => t.id)).toEqual([taskId]);
      expect(snap.team.updatedAt >= snap.team.createdAt).toBe(true);
    });

    it("团队工作台：owner-only 动作与不可移除创建者", () => {
      const a = store.createUser("alice", "h", "爱丽丝");
      const b = store.createUser("bob", "h", "鲍勃");
      const teamId = store.createWorkspaceTeam(a.id, { name: "组" }).team.id;
      store.addWorkspaceMember(teamId, a.id, "bob");

      // 成员非 owner：改/删团队、加/移除成员 → forbidden
      expect(store.updateWorkspaceTeam(teamId, b.id, { name: "改名" })).toBe("forbidden");
      expect(store.deleteWorkspaceTeam(teamId, b.id)).toBe("forbidden");
      expect(store.addWorkspaceMember(teamId, b.id, "alice")).toBe("forbidden");
      expect(store.removeWorkspaceMember(teamId, b.id, a.id)).toBe("forbidden");

      // 非成员：null（app 404），不是 forbidden
      expect(store.updateWorkspaceTeam(teamId, "outsider", { name: "x" })).toBeNull();
      expect(store.deleteWorkspaceTeam(teamId, "outsider")).toBeNull();
      expect(store.addWorkspaceMember(teamId, "outsider", "alice")).toBeNull();
      expect(store.removeWorkspaceMember(teamId, "outsider", b.id)).toBeNull();

      // owner 不能被移除
      expect(store.removeWorkspaceMember(teamId, a.id, a.id)).toBe("owner");
      // 移除成员后他就不再能看到团队，且列表里消失
      const removed = store.removeWorkspaceMember(teamId, a.id, b.id);
      expect(removed).not.toBeNull();
      expect((removed as { members: unknown[] }).members).toHaveLength(1);
      expect(store.getWorkspaceTeam(teamId, b.id)).toBeNull();
      expect(store.listWorkspaceTeams(b.id)).toEqual([]);
      // 目标不是成员 → null
      expect(store.removeWorkspaceMember(teamId, a.id, b.id)).toBeNull();

      // owner 自己改团队信息成功
      const renamed = store.updateWorkspaceTeam(teamId, a.id, { name: "新组名", goal: "目标" });
      expect(renamed).toMatchObject({ team: { name: "新组名", goal: "目标" } });
    });

    it("团队工作台：级联删除与引用解绑（删方案不删任务、移成员解绑指派）", () => {
      const a = store.createUser("alice", "h", "爱丽丝");
      const b = store.createUser("bob", "h", "鲍勃");
      const teamId = store.createWorkspaceTeam(a.id, { name: "组" }).team.id;
      store.addWorkspaceMember(teamId, a.id, "bob");
      const plan = store.createTeamPlan(teamId, a.id, { title: "方案" }) as { id: string };
      const task = store.createTeamTask(teamId, a.id, {
        title: "任务",
        planId: plan.id,
        assigneeId: b.id,
      }) as { id: string };

      // 移出成员 → 指派被解绑（不留「指给非成员」的非法引用）
      store.removeWorkspaceMember(teamId, a.id, b.id);
      expect(store.getWorkspaceTeam(teamId, a.id)!.tasks[0].assigneeId).toBeNull();
      // 删方案 → 任务保留但解绑
      expect(store.deleteTeamPlan(teamId, plan.id, a.id)).toBe(true);
      const afterPlan = store.getWorkspaceTeam(teamId, a.id)!;
      expect(afterPlan.plans).toEqual([]);
      expect(afterPlan.tasks.map((t) => t.id)).toEqual([task.id]);
      expect(afterPlan.tasks[0].planId).toBeNull();

      // 删任务 / 删不存在的任务
      expect(store.deleteTeamTask(teamId, task.id, a.id)).toBe(true);
      expect(store.deleteTeamTask(teamId, task.id, a.id)).toBe("not_found");
      expect(store.deleteTeamPlan(teamId, plan.id, a.id)).toBe("not_found");
      // 非成员删 = not_found（同一口径）
      expect(store.deleteTeamTask(teamId, "x", "outsider")).toBe("not_found");
      expect(store.deleteTeamPlan(teamId, "x", "outsider")).toBe("not_found");

      // 删团队 → 级联清干净：再读为 null，成员列表也不再出现
      expect(store.deleteWorkspaceTeam(teamId, a.id)).toBe(true);
      expect(store.getWorkspaceTeam(teamId, a.id)).toBeNull();
      expect(store.listWorkspaceTeams(a.id)).toEqual([]);
    });

    it("团队工作台：列表按最近动静倒序", async () => {
      const a = store.createUser("alice", "h", "爱丽丝");
      const t1 = store.createWorkspaceTeam(a.id, { name: "一号" }).team.id;
      // updatedAt 是毫秒级 ISO：隔一毫秒，排序才有确定的先后（不依赖 id 的随机序）
      await new Promise((r) => setTimeout(r, 5));
      const t2 = store.createWorkspaceTeam(a.id, { name: "二号" }).team.id;
      expect(store.listWorkspaceTeams(a.id).map((t) => t.id)).toEqual([t2, t1]);
      await new Promise((r) => setTimeout(r, 5));
      store.createTeamPlan(t1, a.id, { title: "动一下" });
      expect(store.listWorkspaceTeams(a.id).map((t) => t.id)).toEqual([t1, t2]);
    });
  });
}
