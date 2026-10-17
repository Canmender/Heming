import { describe, it, expect, beforeEach, afterEach } from "vitest";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createMemoryStore, type Store } from "./store.js";
import { createSqliteStore } from "./sqliteStore.js";
import type { SharedFileMeta } from "@heming/shared";

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

    /** 与 F3 口径配套：既有用例的成员须先是已接受好友。 */
    function befriend(fromId: string, toUsername: string, toId: string): void {
      store.acceptFriendRequest(store.createFriendRequest(fromId, toUsername).id, toId);
    }

    it("createGroup 幂等成员并列入群", () => {
      store.createUser("alice", "h", "爱丽丝");
      store.createUser("bob", "h", "鲍勃");
      const a = store.findUserByUsername("alice")!.user;
      const b = store.findUserByUsername("bob")!.user;
      befriend(a.id, "bob", b.id);
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

    it("createGroup 非好友成员拒绝（not friends），接受后可建", () => {
      const a = store.createUser("alice", "h", "爱丽丝");
      const b = store.createUser("bob", "h", "鲍勃");
      expect(() => store.createGroup(a.id, "群", [b.id])).toThrow("not friends");
      befriend(a.id, "bob", b.id);
      const g = store.createGroup(a.id, "群", [b.id]);
      expect(store.listMembers(g.id).filter((m) => m.kind === "user")).toHaveLength(2);
    });

    it("createGroup 成员不存在抛错", () => {
      store.createUser("alice", "h", "爱丽丝");
      const a = store.findUserByUsername("alice")!.user;
      expect(() => store.createGroup(a.id, "群", ["nope"])).toThrow();
    });

    it("createGroup creator 自带自身 + 去重：creator 不做好友校验", () => {
      const a = store.createUser("alice", "h", "爱丽丝");
      const g = store.createGroup(a.id, "单人群", [a.id, a.id]);
      expect(store.listMembers(g.id).filter((m) => m.kind === "user")).toHaveLength(1);
    });

    it("群消息计入未读并可 markRead 清零", () => {
      store.createUser("alice", "h", "A");
      store.createUser("bob", "h", "B");
      const a = store.findUserByUsername("alice")!.user;
      const b = store.findUserByUsername("bob")!.user;
      befriend(a.id, "bob", b.id);
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
      befriend(a.id, "bob", b.id);
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
      befriend(a.id, "bob", b.id);
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

    it("ensurePresetGroup 幂等；无用户时 seedPreset 语义经 listUserIds 为空可判", () => {
      expect(store.listUserIds()).toEqual([]);
      store.createUser("alice", "h", "爱丽丝");
      store.createUser("bob", "h", "鲍勃");
      expect(store.listUserIds().sort()).toEqual(
        [store.findUserByUsername("alice")!.user.id, store.findUserByUsername("bob")!.user.id].sort(),
      );
      const ids = store.listUserIds();
      const g1 = store.ensurePresetGroup("和鸣交流群", ids, "system-assistant");
      const g2 = store.ensurePresetGroup("和鸣交流群", ids, "system-assistant");
      expect(g2).toBe(g1);
      expect(store.listAgentIds(g1)).toEqual(["system-assistant"]);
    });

    it("listMembers 对挂 agent 的群尾部追加 agent 行；user 行不受影响", () => {
      const a = store.createUser("alice", "h", "爱丽丝");
      const g = store.createGroup(a.id, "普通群", []);
      expect(store.listMembers(g.id).every((m) => m.kind === "user")).toBe(true);
      const presetId = store.ensurePresetGroup("和鸣交流群", store.listUserIds(), "system-assistant");
      const members = store.listMembers(presetId);
      expect(members.filter((m) => m.kind === "user").map((m) => m.id)).toEqual([a.id]);
      expect(members[members.length - 1]).toEqual({
        kind: "agent",
        id: "system-assistant",
        name: "和小鸣",
        avatar: null,
        user: null,
      });
    });

    // —— F1/F2（user ruling B）：预设群启动补成员 + 用户自建同名群不遮蔽 ——

    it("F1 ensurePresetGroup B 语义：新用户启动补入预设群，groupId 不变且幂等", () => {
      const a = store.createUser("alice", "h", "爱丽丝");
      const g1 = store.ensurePresetGroup("和鸣交流群", [a.id], "system-assistant");
      const newbie = store.createUser("newbie", "h", "新同学");
      // 同 name/userIds 列表更新（播种每次传当前全部账号）
      const g2 = store.ensurePresetGroup("和鸣交流群", store.listUserIds(), "system-assistant");
      expect(g2).toBe(g1);
      const users = store.listMembers(g1).filter((m) => m.kind === "user");
      expect(users.map((m) => m.id).sort()).toEqual([a.id, newbie.id].sort());
      // 幂等：再来一次不重复、不改 id
      expect(store.ensurePresetGroup("和鸣交流群", store.listUserIds(), "system-assistant")).toBe(g1);
      expect(store.listMembers(g1).filter((m) => m.kind === "user")).toHaveLength(2);
    });

    it("F2 用户自建同名群不遮蔽预设群：仍新建预设群，agent 挂预设群", () => {
      const a = store.createUser("alice", "h", "爱丽丝");
      const userG = store.createGroup(a.id, "和鸣交流群", []);
      const presetId = store.ensurePresetGroup("和鸣交流群", [a.id], "system-assistant");
      expect(presetId).not.toBe(userG.id);
      expect(store.listAgentIds(presetId)).toEqual(["system-assistant"]);
      expect(store.listAgentIds(userG.id)).toEqual([]);
      // 用户群成员不受预设群补成员影响
      expect(store.listMembers(userG.id).filter((m) => m.kind === "user")).toHaveLength(1);
      // 再播种仍回到预设群（不会误匹配用户群）
      expect(store.ensurePresetGroup("和鸣交流群", store.listUserIds(), "system-assistant")).toBe(presetId);
    });

    // —— M3 Task 2：智能体名册 CRUD（brief 裁决形态：工厂无预设前提，系统 agent 断言容忍缺省）——

    it("agents CRUD 与系统 agent 保护", () => {
      const a = store.createUser("alice", "h", "爱丽丝");
      const mine = store.createAgent(a.id, { name: "架构师", description: "画图的" });
      expect(mine.owner_id).toBe(a.id);
      const all = store.listAgents();
      expect(all.some((x) => x.id === mine.id)).toBe(true);
      expect(all.some((x) => x.name === "架构师")).toBe(true);
      const upd = store.updateAgent(mine.id, a.id, { description: "改了" });
      expect(upd.description).toBe("改了");
      // 系统 agent 未播种时 not found、已播种时 owner_id NULL → forbidden，均属拒绝口径
      expect(() => store.updateAgent("system-assistant", a.id, { name: "改名" })).toThrow(/forbidden|not found/);
      expect(() => store.updateAgent(mine.id, "someone-else", { name: "劫持" })).toThrow("forbidden");
      store.deleteAgent(mine.id, a.id);
      expect(store.listAgents().some((x) => x.id === mine.id)).toBe(false);
      expect(() => store.deleteAgent("system-assistant", a.id)).toThrow(/forbidden|not found/);
    });

    it("ensurePresetGroup 播种后 listAgents 含系统 agent，且仍拒改/拒删", () => {
      const a = store.createUser("alice", "h", "爱丽丝");
      store.ensurePresetGroup("和鸣交流群", [a.id], "system-assistant");
      const sys = store.listAgents().find((x) => x.id === "system-assistant");
      expect(sys).toBeTruthy();
      expect(sys!.owner_id).toBeNull();
      expect(sys!.name).toBe("和小鸣");
      expect(() => store.updateAgent("system-assistant", a.id, { name: "改名" })).toThrow("forbidden");
      expect(() => store.deleteAgent("system-assistant", a.id)).toThrow("forbidden");
    });

    // —— M3 I2：attach/detach 双实现同语义（幂等、缺失会话同拒、名册 join 生效）——

    it("attach/detach 幂等：listAgentIds 与 listMembers 一致联动", () => {
      const a = store.createUser("alice", "h", "爱丽丝");
      const g = store.createGroup(a.id, "入群群", []);
      const mine = store.createAgent(a.id, { name: "架构师", description: "画图的" });

      store.attachAgentToGroup(g.id, mine.id);
      store.attachAgentToGroup(g.id, mine.id); // 幂等：重复挂载 no-op
      expect(store.listAgentIds(g.id)).toEqual([mine.id]);
      // 名册 join：挂载后 listMembers 尾部出现 agent 行（@ 候选 / finish 校验的数据源）
      const agents = store.listMembers(g.id).filter((m) => m.kind === "agent");
      expect(agents).toEqual([{ kind: "agent", id: mine.id, name: "架构师", avatar: null, user: null }]);

      store.detachAgentFromGroup(g.id, mine.id);
      store.detachAgentFromGroup(g.id, mine.id); // 幂等：未挂载再卸 no-op
      expect(store.listAgentIds(g.id)).toEqual([]);
      expect(store.listMembers(g.id).some((m) => m.kind === "agent")).toBe(false);
    });

    it("attach/detach 对不存在会话抛 conversation not found", () => {
      const a = store.createUser("alice", "h", "爱丽丝");
      const mine = store.createAgent(a.id, { name: "架构师", description: "" });
      expect(() => store.attachAgentToGroup("ghost", mine.id)).toThrow("conversation not found");
      expect(() => store.detachAgentFromGroup("ghost", mine.id)).toThrow("conversation not found");
    });

    it("attach 后 deleteAgent：会话关联同步清理，listMembers 不再含该 agent", () => {
      const a = store.createUser("alice", "h", "爱丽丝");
      const g = store.createGroup(a.id, "清理群", []);
      const mine = store.createAgent(a.id, { name: "临时工", description: "" });
      store.attachAgentToGroup(g.id, mine.id);
      expect(store.listMembers(g.id).some((m) => m.id === mine.id)).toBe(true);

      store.deleteAgent(mine.id, a.id);
      expect(store.listAgentIds(g.id)).toEqual([]);
      expect(store.listMembers(g.id).some((m) => m.id === mine.id)).toBe(false);
    });

    // —— 二期 IM Task 2：消息撤回（recallMessage 双实现同语义：权限 + 持久化）——

    it("recallMessage 权限与持久化", () => {
      const a = store.createUser("r1", "h", "甲");
      const b = store.createUser("r2", "h", "乙");
      // 直聊前置须为已接受好友（brief 片段省略，按既有口径补齐）
      befriend(a.id, "r2", b.id);
      const conv = store.createDirectConversation(a.id, b.id);
      const m = store.addMessage(conv.id, "user", a.id, { text: "撤我" }, null);
      expect(m.recalledAt).toBeNull(); // 新消息初值 null
      expect(store.recallMessage(conv.id, m.id, b.id)).toBeNull();      // 非本人
      expect(store.recallMessage(conv.id, "nope", a.id)).toBeNull();    // 不存在
      const outsider = store.createUser("r3", "h", "丙");
      expect(store.recallMessage(conv.id, m.id, outsider.id)).toBeNull(); // 非成员
      const recalled = store.recallMessage(conv.id, m.id, a.id);
      expect(recalled?.recalledAt).not.toBeNull();
      expect(recalled?.payload.text).toBe("撤我"); // 返回更新后消息（内容不被清空）
      expect(store.listMessages(conv.id)[0].recalledAt).not.toBeNull();
    });

    // —— 二期 IM Task 6：表情回应（reactMessage 双实现同语义：成员/存在校验 + toggle + 持久化）——

    it("reactMessage toggle 与权限", () => {
      const a = store.createUser("ra", "h", "甲");
      const b = store.createUser("rb", "h", "乙");
      // 直聊前置须为已接受好友（brief 片段省略，按既有口径补齐）
      befriend(a.id, "rb", b.id);
      const conv = store.createDirectConversation(a.id, b.id);
      const m = store.addMessage(conv.id, "user", a.id, { text: "被回应" }, null);
      const out = store.reactMessage(conv.id, m.id, b.id, "👍")!;
      expect(out.payload.reactions).toEqual([{ emoji: "👍", userIds: [b.id] }]);
      const off = store.reactMessage(conv.id, m.id, b.id, "👍")!;
      expect(off.payload.reactions).toEqual([]);
      const outsider = store.createUser("rc", "h", "丙");
      expect(store.reactMessage(conv.id, m.id, outsider.id, "👍")).toBeNull(); // 非成员
    });

    it("reactMessage 多用户同 emoji 与多 emoji 顺序双实现一致（持久化后 listMessages 可读）", () => {
      const a = store.createUser("rd", "h", "甲");
      const b = store.createUser("re", "h", "乙");
      befriend(a.id, "re", b.id);
      const conv = store.createDirectConversation(a.id, b.id);
      const m = store.addMessage(conv.id, "user", a.id, { text: "回应我" }, null);
      store.reactMessage(conv.id, m.id, a.id, "👍");
      store.reactMessage(conv.id, m.id, b.id, "👍");
      store.reactMessage(conv.id, m.id, b.id, "🎉");
      // 同 emoji 追加在各自 userIds 尾；新 emoji 追加在数组尾（顺序逐字一致）
      expect(store.listMessages(conv.id)[0].payload.reactions).toEqual([
        { emoji: "👍", userIds: [a.id, b.id] },
        { emoji: "🎉", userIds: [b.id] },
      ]);
      // 消息不存在 / 会话不存在 → null
      expect(store.reactMessage(conv.id, "nope", a.id, "👍")).toBeNull();
      expect(store.reactMessage("ghost", m.id, a.id, "👍")).toBeNull();
    });

    // —— M4 Task 1：共享文件落 Store（memory/sqlite 双实现持久化）——

    describe("files", () => {
      it("addFile/getFile/listFiles/deleteFile/userFileBytes", () => {
        const u = store.createUser("fileu", "hash", "文件王");
        const meta: SharedFileMeta = {
          id: "f-1",
          owner: "fileu",
          name: "a.txt",
          mime: "text/plain",
          size: 5,
          updatedAt: "2026-10-17T00:00:00.000Z",
        };
        store.addFile(meta, Buffer.from("hello").toString("base64"));
        const got = store.getFile("f-1");
        expect(got?.meta.name).toBe("a.txt");
        expect(Buffer.from(got!.contentBase64, "base64").toString()).toBe("hello");
        expect(store.listFiles().map((f) => f.id)).toContain("f-1");
        expect(store.userFileBytes("fileu")).toBe(5);
        expect(store.deleteFile("f-1")).toBe(true);
        expect(store.getFile("f-1")).toBeNull();
        expect(store.userFileBytes("fileu")).toBe(0);
        void u;
      });
      it("getFile 不存在返回 null；deleteFile 不存在返回 false", () => {
        expect(store.getFile("nope")).toBeNull();
        expect(store.deleteFile("nope")).toBe(false);
      });
    });
  });
}
