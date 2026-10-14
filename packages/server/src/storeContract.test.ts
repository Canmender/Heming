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

    it("createGroup 幂等成员并列入群", () => {
      store.createUser("alice", "h", "爱丽丝");
      store.createUser("bob", "h", "鲍勃");
      const a = store.findUserByUsername("alice")!.user;
      const b = store.findUserByUsername("bob")!.user;
      const g = store.createGroup(a.id, "评审组", [b.id, a.id]);
      expect(g.type).toBe("group");
      const convs = store.listConversations(a.id);
      const gconv = convs.find((c) => c.id === g.id);
      expect(gconv?.type).toBe("group");
      if (gconv?.type === "group") expect(gconv.memberCount).toBe(2);
      const members = store.listMembers(g.id);
      expect(members.map((m) => m.id).sort()).toEqual([a.id, b.id].sort());
      expect(members.every((m) => m.kind === "user")).toBe(true);
    });

    it("createGroup 成员不存在抛错", () => {
      store.createUser("alice", "h", "爱丽丝");
      const a = store.findUserByUsername("alice")!.user;
      expect(() => store.createGroup(a.id, "群", ["nope"])).toThrow();
    });

    it("群消息计入未读并可 markRead 清零", () => {
      store.createUser("alice", "h", "A");
      store.createUser("bob", "h", "B");
      const a = store.findUserByUsername("alice")!.user;
      const b = store.findUserByUsername("bob")!.user;
      const g = store.createGroup(a.id, "群", [b.id]);
      store.addMessage(g.id, "user", b.id, { text: "hi" }, null);
      const before = store.listConversations(a.id).find((c) => c.id === g.id);
      if (before?.type !== "group") throw new Error("expected group");
      expect(before.unreadCount).toBe(1);
      store.markRead(g.id, a.id);
      const after = store.listConversations(a.id).find((c) => c.id === g.id);
      if (after?.type !== "group") throw new Error("expected group");
      expect(after.unreadCount).toBe(0);
    });

    it("自己发的消息不计自己的未读", () => {
      store.createUser("alice", "h", "A");
      store.createUser("bob", "h", "B");
      const a = store.findUserByUsername("alice")!.user;
      const b = store.findUserByUsername("bob")!.user;
      const g = store.createGroup(a.id, "群", [b.id]);
      store.addMessage(g.id, "user", a.id, { text: "self" }, null);
      const conv = store.listConversations(a.id).find((c) => c.id === g.id);
      if (conv?.type !== "group") throw new Error("expected group");
      expect(conv.unreadCount).toBe(0);
    });

    it("direct 会话也带 unreadCount", () => {
      store.createUser("alice", "h", "A");
      store.createUser("bob", "h", "B");
      const a = store.findUserByUsername("alice")!.user;
      const b = store.findUserByUsername("bob")!.user;
      store.acceptFriendRequest(store.createFriendRequest(a.id, "bob").id, b.id);
      const d = store.createDirectConversation(a.id, b.id);
      store.addMessage(d.id, "user", b.id, { text: "喂" }, null);
      const conv = store.listConversations(a.id).find((c) => c.id === d.id);
      if (conv?.type !== "direct") throw new Error("expected direct");
      expect(conv.unreadCount).toBe(1);
      store.markRead(d.id, a.id);
      const conv2 = store.listConversations(a.id).find((c) => c.id === d.id);
      if (conv2?.type !== "direct") throw new Error("expected direct");
      expect(conv2.unreadCount).toBe(0);
    });

    it("listReads 返回已读状态；非成员 markRead 抛错", () => {
      store.createUser("alice", "h", "A");
      store.createUser("bob", "h", "B");
      const a = store.findUserByUsername("alice")!.user;
      const b = store.findUserByUsername("bob")!.user;
      const g = store.createGroup(a.id, "群", [b.id]);
      store.markRead(g.id, a.id);
      const reads = store.listReads(g.id);
      expect(reads.find((r) => r.userId === a.id)).toBeTruthy();
      expect(() => store.markRead(g.id, "stranger")).toThrow();
    });

    it("原 direct 好友链路回归（幂等会话）", () => {
      store.createUser("alice", "h", "A");
      store.createUser("bob", "h", "B");
      const a = store.findUserByUsername("alice")!.user;
      const b = store.findUserByUsername("bob")!.user;
      store.acceptFriendRequest(store.createFriendRequest(a.id, "bob").id, b.id);
      const c1 = store.createDirectConversation(a.id, b.id);
      const c2 = store.createDirectConversation(b.id, a.id);
      expect(c1.id).toBe(c2.id);
    });

    // —— 以下为任务实现时追加的双实现语义一致边界（brief 未覆盖，锁 memory/sqlite 不分叉）——

    it("缺失会话边界一致：isMember false；listMessages/listMembers/markRead 抛 conversation not found", () => {
      store.createUser("alice", "h", "A");
      const a = store.findUserByUsername("alice")!.user;
      expect(store.isMember("ghost", a.id)).toBe(false);
      expect(() => store.listMessages("ghost")).toThrow("conversation not found");
      expect(() => store.listMembers("ghost")).toThrow("conversation not found");
      expect(() => store.markRead("ghost", a.id)).toThrow("conversation not found");
    });

    it("updateProfile 语义一致：改名 / 省略 avatar 保留 / 空串保留 / 未知用户抛错", () => {
      const a = store.createUser("alice", "h", "爱丽丝");
      const withAvatar = store.updateProfile(a.id, { displayName: "A", avatar: "data:image/png;base64,QQ==" });
      expect(withAvatar.avatar).toBe("data:image/png;base64,QQ==");
      const kept = store.updateProfile(a.id, { displayName: "B" });
      expect(kept.avatar).toBe("data:image/png;base64,QQ==");
      const cleared = store.updateProfile(a.id, { displayName: "C", avatar: "" });
      expect(cleared.avatar).toBe("");
      expect(store.findUserById(a.id)!.avatar).toBe("");
      expect(() => store.updateProfile("nope", { displayName: "X" })).toThrow("user not found");
    });
  });
}
