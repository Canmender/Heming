import { describe, it, expect, beforeEach, afterEach } from "vitest";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { SYSTEM_AGENT_ID } from "@heming/shared";
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

    it("名册恒为唯一内置智能体（创建/修改/删除能力已移除）", () => {
      store.ensureSystemAgents();
      const agents = store.listAgents();
      expect(agents).toHaveLength(1);
      expect(agents[0]).toMatchObject({
        id: SYSTEM_AGENT_ID,
        owner_id: null,
        name: "和鸣",
        avatar: null,
        description: "和鸣官方预设智能体",
      });
      // 名册是只读投影：再次读取内容恒等。
      expect(store.listAgents()).toEqual(agents);
    });

    it("createAgentConversation 幂等；任意 agentId 归一为内置智能体", () => {
      const a = store.createUser("alice", "h", "爱丽丝");
      const b = store.createUser("bob", "h", "鲍勃");
      const c1 = store.createAgentConversation(a.id, SYSTEM_AGENT_ID);
      expect(store.createAgentConversation(a.id, SYSTEM_AGENT_ID).id).toBe(c1.id);
      expect(store.createAgentConversation(a.id, "legacy-agent").id).toBe(c1.id);
      expect(store.conversationAgentId(c1.id)).toBe(SYSTEM_AGENT_ID);

      // 旧版「自建 agent 仅属主可开」已不存在：任何用户任意 id 都开自己的唯一对话。
      const bobConv = store.createAgentConversation(b.id, "legacy-agent");
      expect(bobConv.id).not.toBe(c1.id);
      expect(bobConv.agent.id).toBe(SYSTEM_AGENT_ID);
      expect(() => store.createAgentConversation(b.id, "no-such-agent")).not.toThrow();
    });

    it("d.128：fresh 新建多段会话；标题可设可清；非成员不能改", () => {
      const a = store.createUser("alice", "h", "爱丽丝");
      const b = store.createUser("bob", "h", "鲍勃");
      const c1 = store.createAgentConversation(a.id, SYSTEM_AGENT_ID, { title: "第一段" });
      const c2 = store.createAgentConversation(a.id, SYSTEM_AGENT_ID, { fresh: true, title: "第二段" });
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

    it("listConversations：多条会话各自取自己的最近消息时间，互不串台、按建立序（d.412.4.181）", async () => {
      const a = store.createUser("alice", "h", "爱丽丝");
      const c1 = store.createAgentConversation(a.id, SYSTEM_AGENT_ID, { title: "第一段" });
      const c2 = store.createAgentConversation(a.id, SYSTEM_AGENT_ID, { fresh: true, title: "第二段" });
      // 消息时间戳是毫秒级 ISO：留 5ms 间隔，确保 c1Early ≠ c1Late（否则断言偶发假失败）。
      const c1Early = store.addMessage(c1.id, "user", a.id, { text: "早" });
      await new Promise((r) => setTimeout(r, 5));
      const c2Late = store.addMessage(c2.id, "user", a.id, { text: "晚" });
      await new Promise((r) => setTimeout(r, 5));
      const c1Late = store.addMessage(c1.id, "user", a.id, { text: "更早会话的新消息" });

      const list = store.listConversations(a.id);
      expect(list.map((c) => c.id)).toEqual([c1.id, c2.id]);
      expect(list.find((c) => c.id === c1.id)?.lastMessageAt).toBe(c1Late.createdAt);
      expect(list.find((c) => c.id === c2.id)?.lastMessageAt).toBe(c2Late.createdAt);
      // 早于各自最新消息的时间不应被当成结果。
      expect(c1Early.createdAt).not.toBe(list.find((c) => c.id === c1.id)?.lastMessageAt);
    });

    it("deleteConversation：成员可删（消息一起删）、非成员 forbidden、不存在 not found", () => {
      const a = store.createUser("alice", "h", "爱丽丝");
      const b = store.createUser("bob", "h", "鲍勃");
      const c1 = store.createAgentConversation(a.id, SYSTEM_AGENT_ID);
      const c2 = store.createAgentConversation(a.id, SYSTEM_AGENT_ID, { fresh: true });
      store.addMessage(c1.id, "user", a.id, { text: "这条消息应随会话删除" });

      expect(() => store.deleteConversation(c1.id, b.id)).toThrow("forbidden");
      expect(() => store.deleteConversation("nope", a.id)).toThrow("conversation not found");
      store.deleteConversation(c1.id, a.id);
      expect(() => store.listMessages(c1.id)).toThrow("conversation not found");
      const left = store.listConversations(a.id);
      expect(left.map((c) => c.id)).toEqual([c2.id]);
    });

    it("agent 不存在/旧自建 id 一律归一 system-assistant", () => {
      const a = store.createUser("alice", "h", "爱丽丝");
      const conv = store.createAgentConversation(a.id, "nope");
      expect(store.conversationAgentId(conv.id)).toBe(SYSTEM_AGENT_ID);
      expect(store.listConversations(a.id)).toHaveLength(1);
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
      const conv = store.createAgentConversation(a.id, SYSTEM_AGENT_ID);
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

    it("共享文件同 updatedAt 时按 id 确定性排序，两实现一致（d.412.4.207）", () => {
      store.createUser("alice", "h", "爱丽丝");
      const at = "2026-11-02T00:00:00.000Z";
      // 故意乱序插入，三个文件 updatedAt 全相同：必须回以确定的 id 升序，与 SQLite ORDER BY 一致。
      for (const id of ["z", "a", "m"]) {
        store.addFile(
          { id, owner: "alice", name: id, mime: "text/plain", size: 1, updatedAt: at },
          "aGk=",
        );
      }
      expect(store.listFiles().map((f) => f.id)).toEqual(["a", "m", "z"]);
    });

    it("团队名册：touchUser 刷新最近活跃，未活跃为 null", () => {
      const a = store.createUser("alice", "h", "爱丽丝");
      store.createUser("bob", "h", "鲍勃");
      expect(store.listTeamMembers().every((m) => m.lastSeenAt === null)).toBe(true);
      store.touchUser(a.id);
      expect(store.listTeamMembers().find((m) => m.user.id === a.id)?.lastSeenAt).toBeTruthy();
      store.touchUser("nope"); // 静默忽略
    });

    it("可见名册：无团队只剩自己、同队互见去重、跨队不串（两实现同语义）", () => {
      const a = store.createUser("alice", "h", "爱丽丝");
      const b = store.createUser("bob", "h", "鲍勃");
      const c = store.createUser("carol", "h", "卡罗尔");
      const d = store.createUser("dave", "h", "戴夫");
      const ids = (viewerId: string) =>
        store
          .listTeamCollaborators(viewerId)
          .map((m) => m.user.id)
          .sort();

      // 没有任何团队：只看到自己（不再回全站名册）
      expect(ids(a.id)).toEqual([a.id]);
      expect(ids(d.id)).toEqual([d.id]);

      const t1 = store.createWorkspaceTeam(a.id, { name: "一起", goal: "" }).team.id;
      store.addWorkspaceMember(t1, a.id, "bob");
      const t2 = store.createWorkspaceTeam(c.id, { name: "另一队", goal: "" }).team.id;
      expect(t2).toBeTruthy();

      expect(ids(a.id)).toEqual([a.id, b.id].sort());
      expect(ids(b.id)).toEqual([a.id, b.id].sort());
      expect(ids(c.id)).toEqual([c.id]);
      expect(ids(d.id)).toEqual([d.id]);

      // 再共享一个团队也不重复（去重）
      const t3 = store.createWorkspaceTeam(a.id, { name: "第二个共同团队", goal: "" }).team.id;
      store.addWorkspaceMember(t3, a.id, "bob");
      expect(ids(a.id)).toEqual([a.id, b.id].sort());

      // 排序：最近活跃倒序、null 最后、同值按显示名（与 roster 口径一致）
      store.touchUser(b.id);
      expect(store.listTeamCollaborators(a.id).map((m) => m.user.id)).toEqual([b.id, a.id]);
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
      // 可见范围进过滤阶段：actorIds 与 actorId/limit 组合，空数组直接空结果
      expect(store.listTeamActivities({ actorIds: [b.id] }).map((x) => x.actorId)).toEqual([b.id]);
      expect(store.listTeamActivities({ actorIds: [b.id], limit: 1 })).toHaveLength(1);
      expect(store.listTeamActivities({ actorIds: [] })).toEqual([]);
      expect(
        store.listTeamActivities({ before: "2026-11-02T00:00:00.000Z" }).map((x) => x.sourceId),
      ).toEqual(["task:1", "task:1"]);
      expect(store.listTeamActivities({ limit: 1 })).toHaveLength(1);
      expect(store.clearTeamActivities(a.id)).toBe(2);
      expect(store.listTeamActivities().map((x) => x.actorId)).toEqual([b.id]);
      expect(() => store.addTeamActivity("nope", { ...base, sourceId: "x" })).toThrow("user not found");
    });

    it("日程动向幂等命中时刷新档位（W2-01：sourceId 稳定但状态随时间变）", () => {
      const a = store.createUser("alice", "h", "爱丽丝");
      const first = {
        kind: "agenda" as const,
        title: "项目周会",
        detail: "日程 · 今天到期",
        status: "today",
        sourceId: "agenda:7",
        occurredAt: "2026-11-03T08:00:00.000Z",
      };
      expect(store.addTeamActivity(a.id, first)).toBe(true);
      // 同一条日程晚些时候变成已逾期：不新增行，但档位与时间要刷新
      expect(
        store.addTeamActivity(a.id, {
          ...first,
          detail: "日程 · 已逾期",
          status: "overdue",
          occurredAt: "2026-11-03T12:00:00.000Z",
        }),
      ).toBe(false);

      const rows = store.listTeamActivities();
      expect(rows).toHaveLength(1);
      expect(rows[0]).toMatchObject({
        sourceId: "agenda:7",
        detail: "日程 · 已逾期",
        status: "overdue",
        occurredAt: "2026-11-03T12:00:00.000Z",
      });
    });

    it("日程刷新省略 detail/status 时保留原值，不清空（两实现同口径，d.412.4.204）", () => {
      const a = store.createUser("alice", "h", "爱丽丝");
      expect(
        store.addTeamActivity(a.id, {
          kind: "agenda",
          title: "项目周会",
          detail: "日程 · 今天到期",
          status: "today",
          sourceId: "agenda:keep",
          occurredAt: "2026-11-03T08:00:00.000Z",
        }),
      ).toBe(true);
      // 老客户端/第三方重传同一 sourceId，只更新 title/occurredAt，省略 detail/status。
      // 幂等刷新必须保留原有的 detail/status，不能被写成 null 导致整键被丢弃。
      expect(
        store.addTeamActivity(a.id, {
          kind: "agenda",
          title: "项目周会（改期）",
          sourceId: "agenda:keep",
          occurredAt: "2026-11-03T12:00:00.000Z",
        }),
      ).toBe(false);
      const rows = store.listTeamActivities();
      expect(rows).toHaveLength(1);
      expect(rows[0]).toMatchObject({
        title: "项目周会（改期）",
        detail: "日程 · 今天到期",
        status: "today",
        occurredAt: "2026-11-03T12:00:00.000Z",
      });
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
      // 可见范围进查询阶段：actorIds 过滤 + 空数组直接空结果
      expect(
        store
          .listTeamUsage({ from: "2026-11-01", to: "2026-11-02", actorIds: [b.id] })
          .map((r) => r.actorId),
      ).toEqual([b.id]);
      expect(store.listTeamUsage({ from: "2026-11-01", to: "2026-11-02", actorIds: [] })).toEqual(
        [],
      );
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

    it("团队用量清除水位：两实现同语义（无记录 null → 写入 → 同 actor 覆盖）", () => {
      const a = store.createUser("alice", "h", "爱丽丝");
      expect(store.getTeamUsageClearedAt(a.id)).toBeNull();
      store.setTeamUsageClearedAt(a.id, 1000);
      expect(store.getTeamUsageClearedAt(a.id)).toBe(1000);
      // 再清一次是覆盖水位（主键是 actor_id），不是追加、也不是取最大值以外的东西
      store.setTeamUsageClearedAt(a.id, 2000);
      expect(store.getTeamUsageClearedAt(a.id)).toBe(2000);
      // 不存在的用户：与其它写入口径一致，抛 "user not found"（不是静默写入孤儿行）
      expect(() => store.setTeamUsageClearedAt("nope", 1)).toThrow("user not found");
    });

    it("动向保留期：purgeTeamActivities 只删 occurredAt 严格早于 cut-off 的（两实现同语义）", () => {
      const a = store.createUser("alice", "h", "爱丽丝");
      const mk = (sourceId: string, occurredAt: string) => ({
        kind: "task" as const,
        title: "任务",
        sourceId,
        occurredAt,
      });
      expect(store.addTeamActivity(a.id, mk("t:old", "2026-10-01T00:00:00.000Z"))).toBe(true);
      expect(store.addTeamActivity(a.id, mk("t:keep1", "2026-11-01T00:00:00.000Z"))).toBe(true);
      expect(store.addTeamActivity(a.id, mk("t:keep2", "2026-11-02T00:00:00.000Z"))).toBe(true);

      // 严格小于：正好等于 cut-off 的那条要保留（与动向游标 before 同口径）
      expect(store.purgeTeamActivities("2026-11-01T00:00:00.000Z")).toBe(1);
      expect(store.countTeamActivities(a.id)).toBe(2);
      expect(
        store
          .listTeamActivities()
          .map((x) => x.sourceId)
          .sort(),
      ).toEqual(["t:keep1", "t:keep2"]);
      // 没有更老的条目时返回 0（定时清理幂等，不会每轮报错）
      expect(store.purgeTeamActivities("2026-11-01T00:00:00.000Z")).toBe(0);

      // 被清掉的幂等键必须一起释放，否则同一个 sourceId 以后永远写不进来
      expect(store.addTeamActivity(a.id, mk("t:old", "2026-11-02T00:00:00.000Z"))).toBe(true);
    });

    it("动向清除水位：两实现同语义（无记录 null → 写入 → 同 actor 覆盖）", () => {
      const a = store.createUser("alice", "h", "爱丽丝");
      expect(store.getTeamActivityClearedAt(a.id)).toBeNull();
      store.setTeamActivityClearedAt(a.id, 1000);
      expect(store.getTeamActivityClearedAt(a.id)).toBe(1000);
      // 再清一次是覆盖水位（主键 actor_id），不是追加
      store.setTeamActivityClearedAt(a.id, 2000);
      expect(store.getTeamActivityClearedAt(a.id)).toBe(2000);
      // 与其它写入口径一致：不存在的用户抛 "user not found"，不静默写孤儿行
      expect(() => store.setTeamActivityClearedAt("nope", 1)).toThrow("user not found");
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

    it("任务优先级（d.268）：新建/更新/读回都持久化，缺省 normal（两种 store 同口径）", () => {
      const a = store.createUser("alice", "h", "爱丽丝");
      const teamId = store.createWorkspaceTeam(a.id, { name: "组" }).team.id;

      const high = store.createTeamTask(teamId, a.id, { title: "急件", priority: "high" });
      expect(high).toMatchObject({ title: "急件", priority: "high" });
      const normal = store.createTeamTask(teamId, a.id, { title: "常规" });
      expect(normal).toMatchObject({ title: "常规", priority: "normal" });
      const low = store.updateTeamTask(teamId, (normal as { id: string }).id, a.id, {
        priority: "low",
      });
      expect(low).toMatchObject({ priority: "low" });

      // 读回快照，确认真的落库而不是只在返回值上带了一眼。
      const snap = store.getWorkspaceTeam(teamId, a.id)!;
      expect(snap.tasks.find((t) => t.id === (high as { id: string }).id)?.priority).toBe("high");
      expect(snap.tasks.find((t) => t.id === (normal as { id: string }).id)?.priority).toBe("low");
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

    it("listTeamBriefs：成员名单组长在前、同类按中文名排序（两实现同口径，d.412.4.189）", () => {
      // 组长被 slice(0,10) 截断就看不到「组长」标识（web/teamBrief.ts），
      // 所以名单必须组长优先——两实现要一致，不能内存版组长在前、SQLite 版按 BINARY 排到后面。
      const owner = store.createUser("owner", "h", "组长");
      const bob = store.createUser("bob", "h", "鲍勃");
      const alice = store.createUser("alice", "h", "爱丽丝");
      const team = store.createWorkspaceTeam(owner.id, { name: "排序组" });
      // 注意按 username 加：两个成员的 displayName 故意一个拼音靠前、一个靠后，
      // 确保「组长在前」不是靠名字巧合，而是靠角色优先。
      store.addWorkspaceMember(team.team.id, owner.id, "bob");
      store.addWorkspaceMember(team.team.id, owner.id, "alice");
      const briefs = store.listTeamBriefs(owner.id);
      const brief = briefs.find((b) => b.id === team.team.id);
      expect(brief).toBeDefined();
      expect(brief!.members.map((m) => m.role)).toEqual(["owner", "member", "member"]);
      // 组长恒为第一个（即便「组长」两字的排序并不最小）；同类成员按中文名 localeCompare 排序。
      expect(brief!.members[0].id).toBe(owner.id);
      const memberNames = brief!.members.slice(1).map((m) => m.displayName);
      expect(memberNames).toEqual([...memberNames].sort((x, y) => x.localeCompare(y, "zh-Hans-CN")));
    });
  });
}

for (const f of factories) {
  describe(`Store 工作区（d.147.4.91.11）: ${f.name}`, () => {
    let store: Store & { close?: () => void };
    beforeEach(() => {
      store = f.create();
      store.ensureSystemAgents();
    });
    afterEach(() => {
      store.close?.();
    });

    it("加工作区幂等；清单按 updated_at 倒序", () => {
      const a = store.createUser("alice", "h", "爱丽丝");
      const first = store.addWorkspace(a.id, "D:/项目/和鸣");
      expect(first.path).toBe("D:/项目/和鸣");
      store.addWorkspace(a.id, "D:/项目/和鸣");
      store.addWorkspace(a.id, "D:/另一个");
      const list = store.listWorkspaces(a.id);
      expect(list.map((w) => w.path)).toEqual(["D:/另一个", "D:/项目/和鸣"]);
      // 工作区是每用户自己的视图：别人看不到
      const b = store.createUser("bob", "h", "鲍勃");
      expect(store.listWorkspaces(b.id)).toEqual([]);
    });

    it("建会话带 workspace；listConversations 带回该字段（未分组不带）", () => {
      const a = store.createUser("alice", "h", "爱丽丝");
      const withWs = store.createAgentConversation(a.id, SYSTEM_AGENT_ID, {
        fresh: true,
        workspace: "D:/项目/和鸣",
      });
      const plain = store.createAgentConversation(a.id, SYSTEM_AGENT_ID, { fresh: true });
      const byId = new Map(store.listConversations(a.id).map((c) => [c.id, c]));
      expect(byId.get(withWs.id)?.workspace).toBe("D:/项目/和鸣");
      expect(byId.get(plain.id)?.workspace).toBeUndefined();
    });

    it("updateConversationWorkspace 可挪可清；非成员 false、不存在抛错", () => {
      const a = store.createUser("alice", "h", "爱丽丝");
      const b = store.createUser("bob", "h", "鲍勃");
      const conv = store.createAgentConversation(a.id, SYSTEM_AGENT_ID, { fresh: true });
      expect(store.updateConversationWorkspace(conv.id, a.id, "D:/x")).toBe(true);
      expect(store.listConversations(a.id)[0].workspace).toBe("D:/x");
      // 非成员不能改（也不该泄露会话存在与否之外的任何信息）
      expect(store.updateConversationWorkspace(conv.id, b.id, "D:/y")).toBe(false);
      expect(store.listConversations(a.id)[0].workspace).toBe("D:/x");
      expect(() => store.updateConversationWorkspace("no-such-id", a.id, "D:/y")).toThrow(
        "conversation not found",
      );
      // 空串等价于未分组
      expect(store.updateConversationWorkspace(conv.id, a.id, "")).toBe(true);
      expect(store.listConversations(a.id)[0].workspace).toBeUndefined();
    });

    it("删工作区：有会话挂着时抛 workspace in use；挪走后可删", () => {
      const a = store.createUser("alice", "h", "爱丽丝");
      store.addWorkspace(a.id, "D:/项目/和鸣");
      const conv = store.createAgentConversation(a.id, SYSTEM_AGENT_ID, {
        fresh: true,
        workspace: "D:/项目/和鸣",
      });
      expect(() => store.removeWorkspace(a.id, "D:/项目/和鸣")).toThrow("workspace in use");
      store.updateConversationWorkspace(conv.id, a.id, null);
      store.removeWorkspace(a.id, "D:/项目/和鸣");
      expect(store.listWorkspaces(a.id)).toEqual([]);
    });
  });
}

for (const f of factories) {
  describe(`Store 登录会话生命周期（d.236）: ${f.name}`, () => {
    let store: Store & { close?: () => void };
    beforeEach(() => {
      store = f.create();
      store.ensureSystemAgents();
    });
    afterEach(() => {
      store.close?.();
    });

    it("未过期会话可取 userId；过期会话返回 null", () => {
      const a = store.createUser("alice", "h", "爱丽丝");
      const now = Date.now();
      store.addSession("future-digest", a.id, now + 60_000);
      store.addSession("past-digest", a.id, now - 1);
      expect(store.sessionUserId("future-digest")).toBe(a.id);
      // 过期两次都为 null：第一次已顺手删除，第二次是「不存在」而非「又过期」。
      expect(store.sessionUserId("past-digest")).toBeNull();
      expect(store.sessionUserId("past-digest")).toBeNull();
      expect(store.sessionUserId("no-such-digest")).toBeNull();
    });

    it("expiresAt 缺省（null）的老会话不过期：升级不踢已登录设备", () => {
      const a = store.createUser("alice", "h", "爱丽丝");
      // 旧版本 addSession 只有两个参数；升级前落库的行 expires_at 为 NULL。
      store.addSession("legacy-digest", a.id);
      expect(store.sessionUserId("legacy-digest")).toBe(a.id);
      store.addSession("legacy-explicit-null", a.id, null);
      expect(store.sessionUserId("legacy-explicit-null")).toBe(a.id);
    });

    it("deleteSession 吊销单个；deleteUserSessions 吊销本人全部且不动别人", () => {
      const a = store.createUser("alice", "h", "爱丽丝");
      const b = store.createUser("bob", "h", "鲍勃");
      store.addSession("a1", a.id, Date.now() + 60_000);
      store.addSession("a2", a.id, Date.now() + 60_000);
      store.addSession("b1", b.id, Date.now() + 60_000);

      expect(store.deleteSession("a1")).toBe(true);
      expect(store.deleteSession("a1")).toBe(false);
      expect(store.sessionUserId("a1")).toBeNull();
      expect(store.sessionUserId("a2")).toBe(a.id);

      expect(store.deleteUserSessions(a.id)).toBe(1);
      expect(store.sessionUserId("a2")).toBeNull();
      expect(store.sessionUserId("b1")).toBe(b.id);
      expect(store.deleteUserSessions(a.id)).toBe(0);
    });
  });
}

for (const f of factories) {
  describe(`Store 任务讨论（d.271）: ${f.name}`, () => {
    let store: Store & { close?: () => void };
    beforeEach(() => {
      store = f.create();
      store.ensureSystemAgents();
    });
    afterEach(() => {
      store.close?.();
    });

    it("只有成员能留言；留言按时间升序返回，作者与正文原样保留", async () => {
      const a = store.createUser("alice", "h", "爱丽丝");
      const b = store.createUser("bob", "h", "鲍勃");
      const team = store.createWorkspaceTeam(a.id, { name: "增长小组" });
      expect(store.addWorkspaceMember(team.team.id, a.id, "bob")).not.toBeNull();
      const task = store.createTeamTask(team.team.id, a.id, { title: "改落地页" });
      if (task === null || typeof task === "string") throw new Error("任务没建成");

      const first = store.addTeamTaskComment(team.team.id, task.id, a.id, "口径按老版本走");
      expect(typeof first).toBe("object");
      await new Promise((r) => setTimeout(r, 5));
      const second = store.addTeamTaskComment(team.team.id, task.id, b.id, "收到，今天给");
      expect(typeof second).toBe("object");

      const list = store.listTeamTaskComments(team.team.id, task.id);
      expect(list.map((c) => c.text)).toEqual(["口径按老版本走", "收到，今天给"]);
      expect(list[1]!.authorId).toBe(b.id);
      expect(list[0]!.teamId).toBe(team.team.id);
      expect(list[0]!.taskId).toBe(task.id);
    });

    it("读取讨论必须按 teamId 收口：错队的 id 查不到别队任务的留言（两实现同口径，d.412.4.206）", () => {
      const a = store.createUser("alice", "h", "爱丽丝");
      const teamA = store.createWorkspaceTeam(a.id, { name: "A 队" });
      const teamB = store.createWorkspaceTeam(a.id, { name: "B 队" });
      const task = store.createTeamTask(teamA.team.id, a.id, { title: "A 队的活" });
      if (task === null || typeof task === "string") throw new Error("任务没建成");
      store.addTeamTaskComment(teamA.team.id, task.id, a.id, "A 队内部讨论");

      expect(store.listTeamTaskComments(teamA.team.id, task.id).map((c) => c.text)).toEqual([
        "A 队内部讨论",
      ]);
      // 内存版此前只按 taskId 从 Map 取、忽略 teamId，错队 id 也能读到别队讨论（跨队泄漏面）。
      expect(store.listTeamTaskComments(teamB.team.id, task.id)).toEqual([]);
      expect(store.listTeamTaskComments("no-such-team", task.id)).toEqual([]);
    });

    it("删任务/删团队不留孤儿：讨论与动态一并清掉（痛点 16）", () => {
      const a = store.createUser("alice", "h", "爱丽丝");
      const team = store.createWorkspaceTeam(a.id, { name: "清理测试" });
      const t1 = store.createTeamTask(team.team.id, a.id, { title: "会被删的活" });
      if (typeof t1 === "string" || t1 === null) throw new Error("任务没建成");
      const t2 = store.createTeamTask(team.team.id, a.id, { title: "留着的活" });
      if (typeof t2 === "string" || t2 === null) throw new Error("任务没建成");
      store.addTeamTaskComment(team.team.id, t1.id, a.id, "第一条讨论");
      store.addTeamEvent({
        id: "ev1",
        teamId: team.team.id,
        taskId: t1.id,
        taskTitle: "会被删的活",
        actorId: a.id,
        kind: "task",
        summary: "动了一下",
        createdAt: new Date().toISOString(),
      });

      // 删单个任务：它的讨论没了，另一条任务的讨论不受影响
      expect(store.deleteTeamTask(team.team.id, t1.id, a.id)).toBe(true);
      expect(store.listTeamTaskComments(team.team.id, t1.id)).toEqual([]);
      store.addTeamTaskComment(team.team.id, t2.id, a.id, "第二条讨论");
      expect(store.listTeamTaskComments(team.team.id, t2.id)).toHaveLength(1);

      // 删团队：剩下的讨论、动态都清干净
      expect(store.deleteWorkspaceTeam(team.team.id, a.id)).toBe(true);
      expect(store.listTeamTaskComments(team.team.id, t2.id)).toEqual([]);
      expect(store.listTeamEvents(team.team.id)).toEqual([]);
    });

    it("不是团队成员不能留言；任务不属于这个团队也拒绝", () => {
      const a = store.createUser("alice", "h", "爱丽丝");
      const outsider = store.createUser("eve", "h", "伊芙");
      const team = store.createWorkspaceTeam(a.id, { name: "增长小组" });
      const other = store.createWorkspaceTeam(a.id, { name: "另一个团队" });
      const task = store.createTeamTask(team.team.id, a.id, { title: "改落地页" });
      if (task === null || typeof task === "string") throw new Error("任务没建成");

      expect(store.addTeamTaskComment(team.team.id, task.id, outsider.id, "插一句")).toBe("forbidden");
      expect(store.addTeamTaskComment(other.team.id, task.id, a.id, "走错团队")).toBe("not_found");
      expect(store.addTeamTaskComment(team.team.id, "no-such-task", a.id, "幽灵任务")).toBe("not_found");
      expect(store.listTeamTaskComments(team.team.id, task.id)).toEqual([]);
    });
  });

  describe(`Store 任务验收（d.272）: ${f.name}`, () => {
    let store: Store & { close?: () => void };
    beforeEach(() => {
      store = f.create();
      store.ensureSystemAgents();
    });
    afterEach(() => {
      store.close?.();
    });

    it("组长验收通过：只打标，状态与结论都不动", () => {
      const a = store.createUser("alice", "h", "爱丽丝");
      const b = store.createUser("bob", "h", "鲍勃");
      const team = store.createWorkspaceTeam(a.id, { name: "验收组" });
      expect(store.addWorkspaceMember(team.team.id, a.id, "bob")).not.toBeNull();
      const task = store.createTeamTask(team.team.id, a.id,{ title: "写文档", assigneeId: b.id });
      if (task === null || typeof task === "string") throw new Error("任务没建成");

      const done = store.updateTeamTask(team.team.id, task.id, b.id, {
        status: "done",
        result: "写完了，测试全绿。",
      });
      if (done === null || typeof done === "string") throw new Error("标的完成失败");
      expect(done.reviewState ?? "pending").toBe("pending");

      const approved = store.updateTeamTask(team.team.id, task.id, a.id, {
        review: "approve",
        reviewNote: "看过，可以。",
      });
      if (approved === null || typeof approved === "string") throw new Error("验收失败");
      expect(approved.reviewState).toBe("approved");
      expect(approved.reviewNote).toBe("看过，可以。");
      expect(approved.reviewedBy).toBe(a.id);
      expect(approved.status).toBe("done");
      expect(approved.result).toBe("写完了，测试全绿。");
    });

    it("打回重做：状态回进行中、保留上一版结论，记下谁打回的", () => {
      const a = store.createUser("alice", "h", "爱丽丝");
      const b = store.createUser("bob", "h", "鲍勃");
      const team = store.createWorkspaceTeam(a.id, { name: "验收组" });
      expect(store.addWorkspaceMember(team.team.id, a.id, "bob")).not.toBeNull();
      const task = store.createTeamTask(team.team.id, a.id, { title: "写脚本", assigneeId: b.id });
      if (task === null || typeof task === "string") throw new Error("任务没建成");
      store.updateTeamTask(team.team.id, task.id, b.id, {
        status: "done",
        result: "先交一版",
      });

      const sentBack = store.updateTeamTask(team.team.id, task.id, a.id, {
        review: "changes",
        reviewNote: "少了回滚步骤",
      });
      if (sentBack === null || typeof sentBack === "string") throw new Error("打回失败");
      expect(sentBack.reviewState).toBe("changes");
      expect(sentBack.status).toBe("doing");
      expect(sentBack.completedAt ?? null).toBeNull();
      expect(sentBack.result).toBe("先交一版");
      expect(sentBack.reviewNote).toBe("少了回滚步骤");
      expect(sentBack.reviewedBy).toBe(a.id);
    });

    it("成员不能验收；没完成的任务也不能验收", () => {
      const a = store.createUser("alice", "h", "爱丽丝");
      const b = store.createUser("bob", "h", "鲍勃");
      const team = store.createWorkspaceTeam(a.id, { name: "验收组" });
      expect(store.addWorkspaceMember(team.team.id, a.id, "bob")).not.toBeNull();
      const task = store.createTeamTask(team.team.id, a.id, { title: "写脚本", assigneeId: b.id });
      if (task === null || typeof task === "string") throw new Error("任务没建成");

      expect(store.updateTeamTask(team.team.id, task.id, b.id, { review: "approve" })).toBe("forbidden");
      expect(store.updateTeamTask(team.team.id, task.id, a.id, { review: "approve" })).toBe("not_reviewable");
    });

    it("已完成的任务不能靠裸改 status 退回 todo 绕过验收（1.3 状态机收紧）", () => {
      const a = store.createUser("alice", "h", "爱丽丝");
      const b = store.createUser("bob", "h", "鲍勃");
      const team = store.createWorkspaceTeam(a.id, { name: "验收组" });
      expect(store.addWorkspaceMember(team.team.id, a.id, "bob")).not.toBeNull();
      const task = store.createTeamTask(team.team.id, a.id, { title: "写脚本", assigneeId: b.id });
      if (task === null || typeof task === "string") throw new Error("任务没建成");
      const done = store.updateTeamTask(team.team.id, task.id, b.id, {
        status: "done",
        result: "写完了",
      });
      if (done === null || typeof done === "string") throw new Error("标完成失败");

      // 胶囊循环的 done→todo 被堵住：负责人本人和组长都不能裸改回待认领（含已验收的）。
      expect(store.updateTeamTask(team.team.id, task.id, b.id, { status: "todo" })).toBe("done_locked");
      expect(store.updateTeamTask(team.team.id, task.id, a.id, { status: "todo" })).toBe("done_locked");

      const approved = store.updateTeamTask(team.team.id, task.id, a.id, {
        review: "approve",
      });
      if (approved === null || typeof approved === "string") throw new Error("验收失败");
      expect(store.updateTeamTask(team.team.id, task.id, a.id, { status: "todo" })).toBe("done_locked");

      // 状态没被偷改：仍是已完成、已验收。
      const after = store.getWorkspaceTeam(team.team.id, a.id)?.tasks.find((t) => t.id === task.id);
      expect(after?.status).toBe("done");
      expect(after?.reviewState).toBe("approved");

      // done→doing（本人重开继续做，保留结论）是正当路径，仍允许。
      const reopened = store.updateTeamTask(team.team.id, task.id, b.id, { status: "doing" });
      if (reopened === null || typeof reopened === "string") throw new Error("重开继续做失败");
      expect(reopened.status).toBe("doing");
      expect(reopened.result).toBe("写完了");

      // 再标完成，组长打回重做，回到进行中并留原因。
      store.updateTeamTask(team.team.id, task.id, b.id, { status: "done" });
      const sentBack = store.updateTeamTask(team.team.id, task.id, a.id, {
        review: "changes",
        reviewNote: "补一下回滚步骤",
      });
      if (sentBack === null || typeof sentBack === "string") throw new Error("打回失败");
      expect(sentBack.status).toBe("doing");
      expect(sentBack.reviewNote).toBe("补一下回滚步骤");
    });
  });
}

for (const f of factories) {
  describe(`Store 团队动态（d.273）: ${f.name}`, () => {
    let store: Store & { close?: () => void };
    beforeEach(() => {
      store = f.create();
      store.ensureSystemAgents();
    });
    afterEach(() => {
      store.close?.();
    });

    it("只追加、按时间倒序返回，limit 生效", () => {
      const a = store.createUser("alice", "h", "爱丽丝");
      const team = store.createWorkspaceTeam(a.id, { name: "增长小组" });
      const base = {
        teamId: team.team.id,
        taskId: null,
        taskTitle: "",
        actorId: a.id,
        kind: "plan_added" as const,
      };
      store.addTeamEvent({
        id: "e1",
        ...base,
        summary: "第一件",
        createdAt: new Date(Date.now() - 2000).toISOString(),
      });
      store.addTeamEvent({
        id: "e2",
        ...base,
        summary: "第二件",
        createdAt: new Date().toISOString(),
      });

      const list = store.listTeamEvents(team.team.id);
      expect(list.map((e) => e.summary)).toEqual(["第二件", "第一件"]);
      expect(list[0]!.kind).toBe("plan_added");
      expect(list[0]!.actorId).toBe(a.id);
      // 别人的 list 不会因为查询次数少就少一条；limit 只裁返回条数。
      expect(store.listTeamEvents(team.team.id, 1).map((e) => e.id)).toEqual(["e2"]);
    });

    it("按团队隔离：别的团队的动态不会串过来", () => {
      const a = store.createUser("alice", "h", "爱丽丝");
      const one = store.createWorkspaceTeam(a.id, { name: "一队" });
      const two = store.createWorkspaceTeam(a.id, { name: "二队" });
      store.addTeamEvent({
        id: "x1",
        teamId: one.team.id,
        taskId: null,
        taskTitle: "",
        actorId: a.id,
        kind: "task_added",
        summary: "一队的活",
        createdAt: new Date().toISOString(),
      });

      expect(store.listTeamEvents(one.team.id)).toHaveLength(1);
      expect(store.listTeamEvents(two.team.id)).toEqual([]);
    });

    it("可按 taskId 过滤：只回某一件活的流水（d.276）", () => {
      const a = store.createUser("alice", "h", "爱丽丝");
      const team = store.createWorkspaceTeam(a.id, { name: "增长小组" });
      const base = {
        teamId: team.team.id,
        taskTitle: "改落地页",
        actorId: a.id,
        kind: "task_updated" as const,
      };
      store.addTeamEvent({
        id: "t1-a",
        ...base,
        taskId: "task-a",
        summary: "改了 A",
        createdAt: new Date(Date.now() - 2000).toISOString(),
      });
      store.addTeamEvent({
        id: "t1-b",
        ...base,
        taskId: "task-b",
        summary: "改了 B",
        createdAt: new Date(Date.now() - 1000).toISOString(),
      });
      store.addTeamEvent({
        id: "t1-a2",
        ...base,
        taskId: "task-a",
        summary: "又改了 A",
        createdAt: new Date().toISOString(),
      });

      expect(store.listTeamEvents(team.team.id, 10, "task-a").map((e) => e.summary)).toEqual([
        "又改了 A",
        "改了 A",
      ]);
      // 空串/null/不传都按「全队」处理。
      expect(store.listTeamEvents(team.team.id, 10, "")).toHaveLength(3);
      expect(store.listTeamEvents(team.team.id, 10, null)).toHaveLength(3);
    });
  });

  describe(`Store 成员离开后任务归位（d.278）: ${f.name}`, () => {
    let store: Store & { close?: () => void };

    beforeEach(() => {
      store = f.create();
      store.ensureSystemAgents();
    });
    afterEach(() => {
      store.close?.();
    });

    it("移除成员：他名下没做完的活解绑成待认领", () => {
      const boss = store.createUser("alice", "h", "爱丽丝");
      const mate = store.createUser("bob", "h", "鲍勃");
      const team = store.createWorkspaceTeam(boss.id, { name: "归位组" });
      expect(store.addWorkspaceMember(team.team.id, boss.id, mate.username)).not.toBeNull();

      const task = store.createTeamTask(team.team.id, boss.id, {
        title: "改落地页",
        assigneeId: mate.id,
      });
      if (typeof task === "string" || task === null) throw new Error("建任务失败");

      const removed = store.removeWorkspaceMember(team.team.id, boss.id, mate.id);
      if (removed === null || typeof removed === "string") throw new Error("移除成员失败");

      const snapshot = store.getWorkspaceTeam(team.team.id, boss.id);
      const after = snapshot?.tasks.find((item) => item.id === task.id);
      expect(after?.assigneeId).toBeNull();
    });

    it("自己退出：名下的活同样解绑成待认领", () => {
      const boss = store.createUser("carol", "h", "卡萝");
      const mate = store.createUser("dave", "h", "戴夫");
      const team = store.createWorkspaceTeam(boss.id, { name: "归位二组" });
      expect(store.addWorkspaceMember(team.team.id, boss.id, mate.username)).not.toBeNull();

      const task = store.createTeamTask(team.team.id, boss.id, {
        title: "写接口文档",
        assigneeId: mate.id,
      });
      if (typeof task === "string" || task === null) throw new Error("建任务失败");

      const left = store.leaveWorkspaceTeam(team.team.id, mate.id);
      if (left === null || typeof left === "string") throw new Error("退出团队失败");

      const snapshot = store.getWorkspaceTeam(team.team.id, boss.id);
      expect(snapshot?.tasks.find((item) => item.id === task.id)?.assigneeId).toBeNull();
    });
  });

  describe(`Store 按 id 删消息（d.291 /rewind 的对话那一半）: ${f.name}`, () => {
    let store: Store & { close?: () => void };

    beforeEach(() => {
      store = f.create();
      store.ensureSystemAgents();
    });
    afterEach(() => {
      store.close?.();
    });

    function seedConversation(userId: string) {
      const conv = store.createAgentConversation(userId, SYSTEM_AGENT_ID);
      const m1 = store.addMessage(conv.id, "user", userId, { text: "第一句" });
      const m2 = store.addMessage(conv.id, "agent", SYSTEM_AGENT_ID, { text: "答一句" });
      const m3 = store.addMessage(conv.id, "user", userId, { text: "第二句" });
      return { convId: conv.id, m1, m2, m3 };
    }

    it("删掉指定 id：只删这些，剩下的顺序不变，返回真实删掉的条数", () => {
      const user = store.createUser("alice", "h", "爱丽丝");
      const { convId, m1, m2, m3 } = seedConversation(user.id);

      expect(store.deleteMessages(convId, [m2.id])).toBe(1);
      expect(store.listMessages(convId).map((m) => m.id)).toEqual([m1.id, m3.id]);
      // 同一个 id 再删一次：已经没了，不该再算一条（幂等）
      expect(store.deleteMessages(convId, [m2.id])).toBe(0);
    });

    it("别的会话的 id / 重复 id / 空数组都安全：不误删，计数如实", () => {
      const user = store.createUser("bob", "h", "鲍勃");
      const other = store.createUser("erin", "h", "艾琳");
      const one = seedConversation(user.id);
      // 智能体会话按「用户 + 智能体」唯一，所以「另一个会话」必须换个人开
      const two = seedConversation(other.id);

      expect(store.deleteMessages(one.convId, [two.m1.id, two.m2.id])).toBe(0);
      expect(store.listMessages(two.convId)).toHaveLength(3);
      expect(store.deleteMessages(one.convId, [])).toBe(0);
      // 重复 id 只算一条（内存实现按集合、SQLite 走去重后的 IN）
      expect(store.deleteMessages(one.convId, [one.m1.id, one.m1.id])).toBe(1);
      expect(store.listMessages(one.convId)).toHaveLength(2);
    });

    it("会话不存在 → conversation not found（与 listMessages 同口径）", () => {
      const user = store.createUser("carol", "h", "卡萝");
      seedConversation(user.id);
      expect(() => store.deleteMessages("nope", ["x"])).toThrow("conversation not found");
    });

    it("删掉的消息不再出现在搜索里（SQLite 侧 FTS 索引同事务清理）", () => {
      const user = store.createUser("dave", "h", "戴夫");
      const conv = store.createAgentConversation(user.id, SYSTEM_AGENT_ID);
      const kept = store.addMessage(conv.id, "user", user.id, { text: "保留的锚点词" });
      const dropped = store.addMessage(conv.id, "user", user.id, { text: "要删掉的锚点词" });
      store.deleteMessages(conv.id, [dropped.id]);
      const hits = store.searchMessages("锚点词", { conversationIds: [conv.id], limit: 10, maxScanned: 100 });
      // 内存实现没有 FTS（searchMessages 返回 null 或命中列表都可能），只在有结果时断言
      if (hits) {
        const ids = hits.hits.map((h) => h.messageId);
        expect(ids).not.toContain(dropped.id);
        expect(ids).toContain(kept.id);
      }
      expect(store.listMessages(conv.id).map((m) => m.id)).toEqual([kept.id]);
    });
  });

  describe(`Store 团队知识库: ${f.name}`, () => {
    let store: Store & { close?: () => void };

    beforeEach(() => {
      store = f.create();
      store.ensureSystemAgents();
    });
    afterEach(() => {
      store.close?.();
    });

    function seedTeam() {
      const owner = store.createUser("owner", "h", "组长");
      const mate = store.createUser("mate", "h", "队员");
      const outsider = store.createUser("outsider", "h", "外人");
      const team = store.createWorkspaceTeam(owner.id, { name: "知识组" });
      store.addWorkspaceMember(team.team.id, owner.id, mate.username);
      return { owner, mate, outsider, teamId: team.team.id };
    }

    it("建/读/改/删：作者与组长可改，队员不可改别人的；非成员全 404", () => {
      const { owner, mate, outsider, teamId } = seedTeam();
      expect(store.listTeamKnowledge(teamId, outsider.id)).toBeNull();
      expect(store.createTeamKnowledge(teamId, outsider.id, { title: "偷", content: "x" })).toBeNull();

      const doc = store.createTeamKnowledge(teamId, mate.id, {
        title: "接口约定",
        content: "POST /v1/foo",
        tags: ["api", "后端"],
        sourceVault: "my-vault",
      });
      if (!doc) throw new Error("建文档失败");
      expect(doc.authorId).toBe(mate.id);
      expect(doc.tags).toEqual(["api", "后端"]);
      expect(doc.sourceVault).toBe("my-vault");
      expect(doc.pinned).toBe(false);

      // 读：成员可读，外人 null
      expect(store.getTeamKnowledge(teamId, owner.id, doc.id)?.title).toBe("接口约定");
      expect(store.getTeamKnowledge(teamId, outsider.id, doc.id)).toBeNull();
      expect(store.listTeamKnowledge(teamId, owner.id)).toHaveLength(1);

      // 改：作者本人可改；组长可改；普通队员改别人的 → forbidden
      expect(store.updateTeamKnowledge(teamId, mate.id, doc.id, { title: "接口约定 v2" })).toMatchObject({
        title: "接口约定 v2",
      });
      expect(store.updateTeamKnowledge(teamId, owner.id, doc.id, { content: "改过的正文" })).toMatchObject({
        content: "改过的正文",
      });
      const third = store.createUser("third", "h", "第三人");
      store.addWorkspaceMember(teamId, owner.id, third.username);
      expect(store.updateTeamKnowledge(teamId, third.id, doc.id, { title: "抢" })).toBe("forbidden");
      expect(store.deleteTeamKnowledge(teamId, third.id, doc.id)).toBe("forbidden");

      // 删：本人删掉后，列表空
      expect(store.deleteTeamKnowledge(teamId, mate.id, doc.id)).toBe(true);
      expect(store.listTeamKnowledge(teamId, owner.id)).toHaveLength(0);
      expect(store.getTeamKnowledge(teamId, owner.id, doc.id)).toBeNull();
    });

    it("按团队硬隔离：别的团队看不到、也取不到跨队文档", () => {
      const { owner, teamId } = seedTeam();
      const otherTeam = store.createWorkspaceTeam(owner.id, { name: "另一队" });
      const doc = store.createTeamKnowledge(teamId, owner.id, { title: "秘密", content: "只在 A 队" });
      if (!doc) throw new Error("建文档失败");

      expect(store.listTeamKnowledge(otherTeam.team.id, owner.id)).toEqual([]);
      expect(store.getTeamKnowledge(otherTeam.team.id, owner.id, doc.id)).toBeNull();
      expect(store.searchTeamKnowledge(otherTeam.team.id, owner.id, "秘密")).toEqual([]);
    });

    it("搜索：中文子串命中标题/正文/标签，短查询回退线性扫描", () => {
      const { owner, teamId } = seedTeam();
      store.createTeamKnowledge(teamId, owner.id, {
        title: "排班表",
        content: "每周一更新排班，注意节假日",
        tags: ["运营"],
      });
      store.createTeamKnowledge(teamId, owner.id, { title: " unrelated ", content: "nothing here" });

      // 长查询（>=3 字符）：中文子串
      expect(store.searchTeamKnowledge(teamId, owner.id, "排班")?.map((d) => d.title)).toEqual(["排班表"]);
      // 正文里的词
      expect(store.searchTeamKnowledge(teamId, owner.id, "节假日")?.map((d) => d.title)).toEqual(["排班表"]);
      // 短查询（<3 字符）回退线性扫描，仍能命中
      expect(store.searchTeamKnowledge(teamId, owner.id, "排")?.map((d) => d.title)).toEqual(["排班表"]);
      // 无命中
      expect(store.searchTeamKnowledge(teamId, owner.id, "不存在")).toEqual([]);
    });

    it("搜索标签：标题/正文不含但标签含时，长短查询都命中（两实现同口径，d.412.4.190）", () => {
      // 漂移史：内存版长查询（>=3）搜 tags、短查询不搜；SQLite 版反过来——
      // 长查询走 FTS（索引无 tags）漏命中、短查询 LIKE 含 tags 多命中。
      // 统一为「标签在任意长度都参与搜索」：用户输标签词无论长短都应找到文档。
      const { owner, teamId } = seedTeam();
      // 标题/正文刻意不含 "api" 与 "运"，只有标签含，确保命中只能来自标签。
      store.createTeamKnowledge(teamId, owner.id, {
        title: "接口文档", content: "描述协议的正文", tags: ["api", "运营"],
      });

      // 长查询（>=3）命中标签
      expect(store.searchTeamKnowledge(teamId, owner.id, "api")?.map((d) => d.title)).toEqual(["接口文档"]);
      // 短查询（<3）命中标签（中文两字词）
      expect(store.searchTeamKnowledge(teamId, owner.id, "运营")?.map((d) => d.title)).toEqual(["接口文档"]);
      // 单个中文字标签也命中
      expect(store.searchTeamKnowledge(teamId, owner.id, "运")?.map((d) => d.title)).toEqual(["接口文档"]);

      // LIKE 通配符必须按字面量匹配（对齐内存 includes）："%"、"_" 不当通配符。
      store.createTeamKnowledge(teamId, owner.id, {
        title: "100% 覆盖", content: "含下划线 _ 的说明", tags: ["v1_api"],
      });
      expect(store.searchTeamKnowledge(teamId, owner.id, "100%")?.map((d) => d.title)).toEqual(["100% 覆盖"]);
      expect(store.searchTeamKnowledge(teamId, owner.id, "v1_api")?.map((d) => d.title)).toEqual(["100% 覆盖"]);
    });

    it("删团队级联清文档", () => {
      const { owner, teamId } = seedTeam();
      const doc = store.createTeamKnowledge(teamId, owner.id, { title: "会删掉", content: "x" });
      if (!doc) throw new Error("建文档失败");
      // owner 建的第二队留着，确认级联只清目标队
      const keepTeam = store.createWorkspaceTeam(owner.id, { name: "保留队" });
      const keepDoc = store.createTeamKnowledge(keepTeam.team.id, owner.id, { title: "保留", content: "y" });
      if (!keepDoc) throw new Error("建保留文档失败");

      expect(store.deleteWorkspaceTeam(teamId, owner.id)).toBe(true);
      // 团队没了，任何人查都是 null（团队不存在）
      expect(store.listTeamKnowledge(teamId, owner.id)).toBeNull();
      // 另一队的文档还在
      expect(store.listTeamKnowledge(keepTeam.team.id, owner.id)?.map((d) => d.id)).toContain(keepDoc.id);
    });
  });

  describe(`Store 团队发现 + 加入申请: ${f.name}`, () => {
    let store: Store & { close?: () => void };
    beforeEach(() => {
      store = f.create();
      store.ensureSystemAgents();
    });
    afterEach(() => {
      store.close?.();
    });

    function seedTeam() {
      const owner = store.createUser("owner", "h", "组长");
      const mate = store.createUser("mate", "h", "队员");
      const applicant = store.createUser("applicant", "h", "申请人");
      const outsider = store.createUser("outsider", "h", "外人");
      const team = store.createWorkspaceTeam(owner.id, { name: "增长小组", goal: "拉新" });
      store.addWorkspaceMember(team.team.id, owner.id, mate.username);
      return { owner, mate, applicant, outsider, teamId: team.team.id };
    }

    it("目录只暴露元数据、按名字/目标搜索，不含成员名单", () => {
      const { teamId } = seedTeam();
      const all = store.listTeamDirectory("");
      expect(all.some((t) => t.id === teamId && t.name === "增长小组")).toBe(true);
      expect(all.find((t) => t.id === teamId)?.memberCount).toBe(2);
      // 只返回约定字段，不泄露方案/任务/成员等敏感数据
      expect(Object.keys(all.find((t) => t.id === teamId)!).sort()).toEqual(
        ["createdAt", "goal", "id", "memberCount", "name"].sort(),
      );
      expect(store.listTeamDirectory("拉新").map((t) => t.id)).toContain(teamId);
      expect(store.listTeamDirectory("不存在")).toEqual([]);
    });

    it("目录搜索把 %/_ 当字面量、不当 LIKE 通配符（两实现同口径，d.412.4.203）", () => {
      const { owner } = seedTeam();
      // 建三个目标含特殊字符的团队：下划线、百分号、反斜杠。
      const a = store.createWorkspaceTeam(owner.id, { name: "含下划线", goal: "API_v2 接入" });
      const b = store.createWorkspaceTeam(owner.id, { name: "含百分号", goal: "达成 100% 转化" });
      const c = store.createWorkspaceTeam(owner.id, { name: "普通目标", goal: "常规增长" });
      const ids = [a.team.id, b.team.id, c.team.id];
      // 字面量 "_" 只能命中 goal 真含下划线的 a；若当通配符，会命中全部三个。
      expect(store.listTeamDirectory("_").map((t) => t.id)).toEqual([a.team.id]);
      // 字面量 "100%" 只能命中 b；若当通配符（尾部 % 放开），会多命中。
      expect(store.listTeamDirectory("100%").map((t) => t.id)).toEqual([b.team.id]);
      // 反斜杠同样按字面量处理，不应报错或误配。
      expect(store.listTeamDirectory("\\").map((t) => t.id)).toEqual([]);
      expect(ids.every((id) => store.listTeamDirectory("").some((t) => t.id === id))).toBe(true);
    });

    it("申请→队长审批通过：写入成员行、可复看状态；重复申请/重复审拦截", () => {
      const { owner, mate, applicant, teamId } = seedTeam();
      const req = store.createJoinRequest(teamId, applicant.id, "想加入");
      if (!req || typeof req === "string") throw new Error("申请失败");
      expect(req.status).toBe("pending");
      expect(req.message).toBe("想加入");

      // 重复提交被拦
      expect(store.createJoinRequest(teamId, applicant.id, "再申")).toBe("already_pending");
      // 我的申请能查到；队长能查到待审列表
      expect(store.listMyJoinRequests(applicant.id).map((r) => r.id)).toContain(req.id);
      expect(store.listJoinRequests(teamId, owner.id)?.map((r) => r.id)).toContain(req.id);

      // 队员/外人不能看申请列表
      expect(store.listJoinRequests(teamId, mate.id)).toBe("forbidden");
      expect(store.listJoinRequests(teamId, "no-such-user")).toBeNull();

      // 通过：申请人成为成员，申请状态 approved
      const reviewed = store.reviewJoinRequest(teamId, req.id, owner.id, "approve");
      expect(reviewed).toMatchObject({ status: "approved" });
      expect(reviewed?.reviewedAt).toBeTruthy();
      expect(store.getWorkspaceTeam(teamId, applicant.id)?.members.some((m) => m.user.id === applicant.id)).toBe(
        true,
      );
      // 已是成员再申请 → already_member
      expect(store.createJoinRequest(teamId, applicant.id, "")).toBe("already_member");
      // 重复审 → already_reviewed
      expect(store.reviewJoinRequest(teamId, req.id, owner.id, "reject")).toBe("already_reviewed");
    });

    it("拒绝：不写成员行；非队长/非成员审批被拦；删团队级联清申请", () => {
      const { owner, applicant, mate, teamId } = seedTeam();
      const req = store.createJoinRequest(teamId, applicant.id, "");
      if (!req || typeof req === "string") throw new Error("申请失败");

      // 队员不能审，外人不能审
      expect(store.reviewJoinRequest(teamId, req.id, mate.id, "approve")).toBe("forbidden");
      expect(store.reviewJoinRequest(teamId, req.id, "no-such-user", "approve")).toBeNull();

      // 拒绝：不成为成员
      expect(store.reviewJoinRequest(teamId, req.id, owner.id, "reject")).toMatchObject({ status: "rejected" });
      expect(store.getWorkspaceTeam(teamId, applicant.id)).toBeNull();
      // 被拒后可重新申请（状态已审，不是 pending）
      expect(store.createJoinRequest(teamId, applicant.id, "再试")).not.toBe("already_pending");

      // 删团队级联清申请
      expect(store.deleteWorkspaceTeam(teamId, owner.id)).toBe(true);
      expect(store.listMyJoinRequests(applicant.id)).toEqual([]);
    });

    it("审批通过加入申请应刷新团队 updatedAt（两实现同口径，d.412.4.208）", async () => {
      const { owner, applicant, teamId } = seedTeam();
      const before = store.getWorkspaceTeam(teamId, owner.id)!.team.updatedAt;
      const req = store.createJoinRequest(teamId, applicant.id, "想加入");
      if (!req || typeof req === "string") throw new Error("申请失败");
      // 毫秒级 ISO 时间戳，须让时钟前进才能观察刷新
      await new Promise((r) => setTimeout(r, 5));

      expect(store.reviewJoinRequest(teamId, req.id, owner.id, "approve")).toMatchObject({ status: "approved" });
      const after = store.getWorkspaceTeam(teamId, owner.id)!.team.updatedAt;
      // 成员变更属于「团队有动静」，两实现都应把团队 updatedAt 往前刷
      expect(after > before).toBe(true);

      // 反例：已是成员时申请人（owner 手动拉进来的）再被审批，不应重复刷新
      const mate2 = store.createUser("mate2", "h", "成员2");
      const req2 = store.createJoinRequest(teamId, mate2.id, "想加入");
      if (!req2 || typeof req2 === "string") throw new Error("申请失败");
      store.addWorkspaceMember(teamId, owner.id, mate2.username);
      const afterManual = store.getWorkspaceTeam(teamId, owner.id)!.team.updatedAt;
      await new Promise((r) => setTimeout(r, 5));
      store.reviewJoinRequest(teamId, req2.id, owner.id, "approve");
      // 已在团队里，审批不再写成员行 → 不应刷新（与内存版 !has(key) 条件一致）
      expect(store.getWorkspaceTeam(teamId, owner.id)!.team.updatedAt).toBe(afterManual);
    });
  });
}
