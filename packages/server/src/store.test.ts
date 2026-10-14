import { describe, it, expect, beforeEach } from "vitest";
import { createMemoryStore, Store } from "./store.js";

describe("memory store", () => {
  let store: Store;
  beforeEach(() => {
    store = createMemoryStore();
    store.createUser("alice", "hash-a", "爱丽丝");
    store.createUser("bob", "hash-b", "鲍勃");
  });

  it("创建用户并按用户名查找", () => {
    const found = store.findUserByUsername("alice");
    expect(found?.user.displayName).toBe("爱丽丝");
    expect(found?.passwordHash).toBe("hash-a");
  });

  it("拒绝自加好友与不存在用户", () => {
    const alice = store.findUserByUsername("alice")!.user;
    expect(() => store.createFriendRequest(alice.id, "alice")).toThrow();
    expect(() => store.createFriendRequest(alice.id, "nobody")).toThrow();
  });

  it("好友申请 → 接受 → 双向可见", () => {
    const alice = store.findUserByUsername("alice")!.user;
    const bob = store.findUserByUsername("bob")!.user;
    const req = store.createFriendRequest(alice.id, "bob");
    expect(store.listIncomingRequests(bob.id)).toHaveLength(1);
    store.acceptFriendRequest(req.id, bob.id);
    expect(store.listFriends(alice.id).map((f) => f.user.id)).toContain(bob.id);
    expect(store.listFriends(bob.id).map((f) => f.user.id)).toContain(alice.id);
  });

  it("未接受好友时不能建会话", () => {
    const alice = store.findUserByUsername("alice")!.user;
    const bob = store.findUserByUsername("bob")!.user;
    expect(() => store.createDirectConversation(alice.id, bob.id)).toThrow();
  });

  it("接受好友后建会话幂等，且消息按时间升序", () => {
    const alice = store.findUserByUsername("alice")!.user;
    const bob = store.findUserByUsername("bob")!.user;
    store.acceptFriendRequest(store.createFriendRequest(alice.id, "bob").id, bob.id);
    const c1 = store.createDirectConversation(alice.id, bob.id);
    const c2 = store.createDirectConversation(bob.id, alice.id);
    expect(c1.id).toBe(c2.id);
    store.addMessage(c1.id, "user", alice.id, { text: "第一" }, null);
    store.addMessage(c1.id, "user", bob.id, { text: "第二" }, null);
    const msgs = store.listMessages(c1.id);
    expect(msgs.map((m) => m.payload.text)).toEqual(["第一", "第二"]);
    expect(store.isMember(c1.id, alice.id)).toBe(true);
    expect(store.isMember(c1.id, "stranger")).toBe(false);
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
    expect(store.findUserById(before.id)!.avatar).toBe("data:image/png;base64,AAAA");
  });

  it("updateProfile 省略 avatar 时保留原值", () => {
    const alice = store.findUserByUsername("alice")!.user;
    store.updateProfile(alice.id, { displayName: "A", avatar: "data:image/png;base64,QQ==" });
    const r = store.updateProfile(alice.id, { displayName: "B" });
    expect(r.displayName).toBe("B");
    expect(r.avatar).toBe("data:image/png;base64,QQ==");
  });

  it("updateProfile 未知用户抛错", () => {
    expect(() => store.updateProfile("nope", { displayName: "X" })).toThrow("user not found");
  });
});
