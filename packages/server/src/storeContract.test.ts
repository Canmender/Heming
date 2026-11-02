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
  });
}
