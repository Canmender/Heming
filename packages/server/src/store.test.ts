import { describe, it, expect, beforeEach } from "vitest";
import { createMemoryStore, type Store } from "./store.js";

describe("memory store", () => {
  let store: Store;
  let aliceId: string;
  let bobId: string;
  beforeEach(() => {
    store = createMemoryStore();
    aliceId = store.createUser("alice", "hash-a", "爱丽丝").id;
    bobId = store.createUser("bob", "hash-b", "鲍勃").id;
  });

  it("创建用户并按用户名查找", () => {
    const found = store.findUserByUsername("alice");
    expect(found?.user.displayName).toBe("爱丽丝");
    expect(found?.passwordHash).toBe("hash-a");
    expect(store.findUserByUsername("nobody")).toBeNull();
  });

  it("updateProfile 更新昵称与 avatar，返回新对象（旧引用不被原地篡改）", () => {
    const before = store.findUserByUsername("alice")!.user;
    const updated = store.updateProfile(before.id, {
      displayName: "新名",
      avatar: "data:image/png;base64,AAAA",
    });
    expect(updated.displayName).toBe("新名");
    expect(updated.avatar).toBe("data:image/png;base64,AAAA");
    expect(updated).not.toBe(before);
    expect(before.displayName).toBe("爱丽丝");
    expect(store.findUserById(before.id)!.displayName).toBe("新名");
  });

  it("updateProfile 省略 avatar 时保留原值；未知用户抛错", () => {
    store.updateProfile(aliceId, { displayName: "A", avatar: "data:image/png;base64,QQ==" });
    const r = store.updateProfile(aliceId, { displayName: "B" });
    expect(r.displayName).toBe("B");
    expect(r.avatar).toBe("data:image/png;base64,QQ==");
    expect(() => store.updateProfile("nope", { displayName: "X" })).toThrow("user not found");
  });

  it("智能体一对一：幂等、成员关系、消息升序", () => {
    const agent = store.createAgent(aliceId, { name: "助手", description: "" });
    const c1 = store.createAgentConversation(aliceId, agent.id);
    const c2 = store.createAgentConversation(aliceId, agent.id);
    expect(c1.id).toBe(c2.id);
    expect(store.isMember(c1.id, aliceId)).toBe(true);
    expect(store.isMember(c1.id, bobId)).toBe(false);
    expect(store.conversationAgentId(c1.id)).toBe(agent.id);

    store.addMessage(c1.id, "user", aliceId, { text: "第一" });
    store.addMessage(c1.id, "agent", agent.id, { text: "第二" });
    expect(store.listMessages(c1.id).map((m) => m.payload.text)).toEqual(["第一", "第二"]);
    expect(store.listConversations(aliceId)[0]).toMatchObject({ type: "agent", unreadCount: 0 });
  });

  it("智能体权限：自建仅属主可开；系统 agent 谁都能开", () => {
    const agent = store.createAgent(aliceId, { name: "私房助手", description: "" });
    expect(() => store.createAgentConversation(bobId, agent.id)).toThrow("not your agent");
    store.ensureSystemAgents();
    const sys = store.listAgents().find((a) => a.id === "system-assistant")!;
    expect(() => store.createAgentConversation(bobId, sys.id)).not.toThrow();
    expect(() => store.createAgentConversation(aliceId, "no-such-agent")).toThrow("agent not found");
  });

  it("删除 agent 后其一键会话从列表消失", () => {
    const agent = store.createAgent(aliceId, { name: "临时", description: "" });
    const conv = store.createAgentConversation(aliceId, agent.id);
    store.deleteAgent(agent.id, aliceId);
    expect(store.listConversations(aliceId)).toEqual([]);
    expect(store.isMember(conv.id, aliceId)).toBe(false);
  });

  it("addMessage e2e 信封：直接入库并回读 cipher/chainKid/n", () => {
    const agent = store.createAgent(aliceId, { name: "助手", description: "" });
    const conv = store.createAgentConversation(aliceId, agent.id);
    const msg = store.addMessage(conv.id, "user", aliceId, { text: "" }, {
      enc: "e2e",
      cipher: "Q2lwaGVy",
      chainKid: "kid1",
      n: 3,
    });
    expect(msg).toMatchObject({ enc: "e2e", cipher: "Q2lwaGVy", chainKid: "kid1", n: 3 });
    expect(store.listMessages(conv.id)[0].payload).toEqual({ text: "" });
  });

  it("团队名册：touchUser 推进最近活跃，未活跃为 null", () => {
    expect(store.listTeamMembers().every((m) => m.lastSeenAt === null)).toBe(true);
    store.touchUser(aliceId);
    const row = store.listTeamMembers().find((m) => m.user.id === aliceId)!;
    expect(typeof row.lastSeenAt).toBe("string");
    expect(store.listTeamMembers().find((m) => m.user.id === bobId)!.lastSeenAt).toBeNull();
  });

  it("团队动向：按 (actorId, sourceId) 幂等、倒序、游标、actor 过滤与清空", () => {
    const base = {
      kind: "task" as const,
      title: "整理课程表",
      occurredAt: "2026-11-01T08:00:00.000Z",
    };
    expect(store.addTeamActivity(aliceId, { ...base, sourceId: "task:1" })).toBe(true);
    expect(store.addTeamActivity(aliceId, { ...base, sourceId: "task:1" })).toBe(false);
    store.addTeamActivity(aliceId, { ...base, title: "后一条", sourceId: "task:2", occurredAt: "2026-11-02T08:00:00.000Z" });
    store.addTeamActivity(bobId, { ...base, sourceId: "task:1" });

    expect(store.listTeamActivities().map((a) => a.sourceId)).toEqual(["task:2", "task:1", "task:1"]);
    expect(store.listTeamActivities({ actorId: aliceId })).toHaveLength(2);
    expect(store.listTeamActivities({ before: "2026-11-02T00:00:00.000Z" }).map((a) => a.sourceId)).toEqual([
      "task:1",
      "task:1",
    ]);
    expect(store.listTeamActivities({ limit: 1 })).toHaveLength(1);
    expect(store.clearTeamActivities(aliceId)).toBe(2);
    expect(store.listTeamActivities().map((a) => a.actorId)).toEqual([bobId]);
    expect(() => store.addTeamActivity("nope", { ...base, sourceId: "x" })).toThrow("user not found");
  });
});
