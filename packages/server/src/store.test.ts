import { describe, it, expect, beforeEach } from "vitest";
import { SYSTEM_AGENT_ID } from "@heming/shared";
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

  it("智能体一对一：幂等、成员关系、消息升序（唯一内置智能体）", () => {
    const c1 = store.createAgentConversation(aliceId, SYSTEM_AGENT_ID);
    const c2 = store.createAgentConversation(aliceId, SYSTEM_AGENT_ID);
    expect(c1.id).toBe(c2.id);
    expect(c1.agent.id).toBe(SYSTEM_AGENT_ID);
    expect(store.isMember(c1.id, aliceId)).toBe(true);
    expect(store.isMember(c1.id, bobId)).toBe(false);
    expect(store.conversationAgentId(c1.id)).toBe(SYSTEM_AGENT_ID);

    store.addMessage(c1.id, "user", aliceId, { text: "第一" });
    store.addMessage(c1.id, "agent", SYSTEM_AGENT_ID, { text: "第二" });
    expect(store.listMessages(c1.id).map((m) => m.payload.text)).toEqual(["第一", "第二"]);
    expect(store.listConversations(aliceId)[0]).toMatchObject({ type: "agent", unreadCount: 0 });
  });

  it("名册恒为唯一内置智能体：创建/修改/删除能力已不存在", () => {
    const agents = store.listAgents();
    expect(agents).toHaveLength(1);
    expect(agents[0]).toMatchObject({ id: SYSTEM_AGENT_ID, name: "和小鸣", owner_id: null, avatar: null });
    // CRUD 已从 Store 接口移除（编译期保证）；运行期名册不因任何会话操作增长。
    store.createAgentConversation(aliceId, "anything");
    expect(store.listAgents()).toEqual(agents);
  });

  it("任意 agentId 都归一为内置智能体：未知/遗留自建 id 不报错", () => {
    const c1 = store.createAgentConversation(aliceId, "legacy-custom-agent");
    const c2 = store.createAgentConversation(aliceId, "no-such-agent");
    const c3 = store.createAgentConversation(aliceId, SYSTEM_AGENT_ID);
    expect(new Set([c1.id, c2.id, c3.id])).toEqual(new Set([c1.id]));
    expect(store.conversationAgentId(c1.id)).toBe(SYSTEM_AGENT_ID);
    // 不同用户各自一个会话，互不复用
    const bobConv = store.createAgentConversation(bobId, "legacy-custom-agent");
    expect(bobConv.id).not.toBe(c1.id);
    expect(bobConv.agent.id).toBe(SYSTEM_AGENT_ID);
  });

  it("addMessage e2e 信封：直接入库并回读 cipher/chainKid/n", () => {
    const conv = store.createAgentConversation(aliceId, SYSTEM_AGENT_ID);
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
