import { describe, it, expect, afterEach } from "vitest";
import { createRequire } from "node:module";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createSqliteStore } from "./sqliteStore.js";
import { openDb, initSchema, resolveDbPath } from "./db.js";

// node:sqlite 与 db.ts 同法经 createRequire 原生加载（静态 import 会被 vite-node 剥前缀）
const { DatabaseSync } = createRequire(import.meta.url)("node:sqlite") as typeof import("node:sqlite");

const tmpDirs: string[] = [];
afterEach(() => {
  while (tmpDirs.length) rmSync(tmpDirs.pop()!, { recursive: true, force: true });
});
const newDbPath = (): string => {
  const dir = mkdtempSync(join(tmpdir(), "heming-persist-"));
  tmpDirs.push(dir);
  return join(dir, "p.db");
};

describe("sqlite 持久化专项", () => {
  it("旧库（无信封列）幂等迁移后 reencrypt 同口径：明文 payload/reply_to 清空", () => {
    // fix round 1 Critical「旧库行重加密后同口径」：以 E2E Task 2 之前的 messages 表
    // 形状建库并预置一行带正文+回复指向的明文，再经 createSqliteStore（openDb→initSchema
    // 的 PRAGMA/ALTER 迁移）打开、重封，断言出站口径与新装库一致。
    const dbPath = newDbPath();
    const legacy = new DatabaseSync(dbPath);
    legacy.exec(`
      CREATE TABLE conversations (id TEXT PRIMARY KEY, kind TEXT NOT NULL, name TEXT, created_by TEXT);
      CREATE TABLE messages (
        id TEXT PRIMARY KEY, conv_id TEXT NOT NULL, sender_type TEXT NOT NULL, sender_id TEXT NOT NULL,
        payload TEXT NOT NULL, reply_to TEXT, created_at TEXT NOT NULL, recalled_at TEXT
      );
      INSERT INTO conversations (id, kind) VALUES ('c-legacy', 'direct');
      INSERT INTO messages (id, conv_id, sender_type, sender_id, payload, reply_to, created_at, recalled_at)
        VALUES ('m-legacy', 'c-legacy', 'user', 'u1', '{"text":"旧库明文"}', 'r-old', '2026-10-01T00:00:00.000Z', NULL);
    `);
    legacy.close();

    const s = createSqliteStore(dbPath);
    // 迁移后存量行：enc 按 DEFAULT 回填 plain，明文尚在（重封前口径）
    const before = s.listMessages("c-legacy")[0];
    expect(before).toMatchObject({ enc: "plain", replyTo: "r-old" });
    expect(before.payload.text).toBe("旧库明文");

    const res = s.reencryptMessage("m-legacy", "u1", { cipher: "Q2lwaGVy", chainKid: "kid1", n: 0 });
    expect(res.ok).toBe(true);

    const after = s.listMessages("c-legacy")[0];
    expect(after).toMatchObject({ enc: "e2e", cipher: "Q2lwaGVy", chainKid: "kid1", n: 0 });
    expect(after.payload).toEqual({ text: "" }); // 明文占位清空（出站无原文）
    expect(after.replyTo).toBeNull(); // 回复指向清空
    s.close();
  });

  it("close 后重开同路径：用户/好友/会话/消息/未读/已读全量保留", () => {
    const dbPath = newDbPath();
    const s1 = createSqliteStore(dbPath);
    const a = s1.createUser("alice", "hash-a", "爱丽丝");
    const b = s1.createUser("bob", "hash-b", "鲍勃");
    s1.acceptFriendRequest(s1.createFriendRequest(a.id, "bob").id, b.id);
    const direct = s1.createDirectConversation(a.id, b.id);
    s1.addMessage(direct.id, "user", b.id, { text: "在吗" }, null);
    const group = s1.createGroup(a.id, "评审组", [b.id]);
    s1.addMessage(group.id, "user", a.id, { text: "群消息" }, null);
    s1.markRead(group.id, a.id);
    s1.close();

    const s2 = createSqliteStore(dbPath);
    expect(s2.findUserByUsername("alice")?.user.displayName).toBe("爱丽丝");
    expect(s2.listFriends(a.id).map((f) => f.user.id)).toContain(b.id);
    const convs = s2.listConversations(a.id);
    const d = convs.find((c) => c.id === direct.id);
    if (d?.type !== "direct") throw new Error("expected direct after reopen");
    expect(d.unreadCount).toBe(1);
    expect(s2.listMessages(direct.id).map((m) => m.payload.text)).toEqual(["在吗"]);
    const g = convs.find((c) => c.id === group.id);
    if (g?.type !== "group") throw new Error("expected group after reopen");
    expect(g.name).toBe("评审组");
    expect(g.memberCount).toBe(2);
    expect(g.unreadCount).toBe(0); // 自己发的消息 + 已读
    expect(s2.listMembers(group.id).map((m) => m.id).sort()).toEqual([a.id, b.id].sort());
    expect(s2.listReads(group.id).find((r) => r.userId === a.id)).toBeTruthy();
    s2.close();
  });

  it("幂等建表：同路径重复 openDb/initSchema 不报错且数据保留", () => {
    const dbPath = newDbPath();
    const s1 = createSqliteStore(dbPath);
    s1.createUser("x", "hash", "埃克斯");
    s1.close();
    const db = openDb(dbPath);
    initSchema(db);
    initSchema(db);
    db.close();
    const s2 = createSqliteStore(dbPath);
    expect(s2.findUserByUsername("x")?.user.displayName).toBe("埃克斯");
    s2.close();
  });

  it("resolveDbPath：默认 ./data/heming.db；HEMING_DB_PATH 覆盖且 trim", () => {
    const prev = process.env.HEMING_DB_PATH;
    try {
      delete process.env.HEMING_DB_PATH;
      expect(resolveDbPath()).toBe("./data/heming.db");
      process.env.HEMING_DB_PATH = "  /data/x.db  ";
      expect(resolveDbPath()).toBe("/data/x.db");
      process.env.HEMING_DB_PATH = "   ";
      expect(resolveDbPath()).toBe("./data/heming.db");
    } finally {
      if (prev === undefined) delete process.env.HEMING_DB_PATH;
      else process.env.HEMING_DB_PATH = prev;
    }
  });

  it("既有方法语义：username 冲突 / 好友申请去重 / 请求与好友列表", () => {
    const s = createSqliteStore(newDbPath());
    const a = s.createUser("alice", "h", "A");
    expect(() => s.createUser("alice", "h", "A2")).toThrow("username taken");
    s.createUser("bob", "h", "B");
    const req = s.createFriendRequest(a.id, "bob");
    expect(s.listIncomingRequests(s.findUserByUsername("bob")!.user.id)).toHaveLength(1);
    expect(() => s.createFriendRequest(a.id, "bob")).toThrow("request already exists");
    const b = s.findUserByUsername("bob")!.user;
    s.acceptFriendRequest(req.id, b.id);
    expect(s.listFriends(a.id).map((f) => f.user.username)).toEqual(["bob"]);
    expect(s.listIncomingRequests(b.id)).toHaveLength(0);
    s.close();
  });

  it("既有方法语义：updateProfile 语义 + listMessages limit 升序截断 + markRead 幂等", () => {
    const s = createSqliteStore(newDbPath());
    const a = s.createUser("alice", "h", "爱丽丝");
    const renamed = s.updateProfile(a.id, { displayName: "新名" });
    expect(renamed.displayName).toBe("新名");
    expect(renamed.avatar).toBeUndefined();
    expect(s.findUserById(a.id)!.displayName).toBe("新名");
    expect(() => s.updateProfile("nope", { displayName: "X" })).toThrow("user not found");

    s.createUser("bob", "h", "B");
    const b = s.findUserByUsername("bob")!.user;
    s.acceptFriendRequest(s.createFriendRequest(a.id, "bob").id, b.id);
    const conv = s.createDirectConversation(a.id, b.id);
    s.addMessage(conv.id, "user", a.id, { text: "一" }, null);
    s.addMessage(conv.id, "user", b.id, { text: "二" }, null);
    s.addMessage(conv.id, "user", a.id, { text: "三" }, null);
    expect(s.listMessages(conv.id, 2).map((m) => m.payload.text)).toEqual(["二", "三"]);

    s.markRead(conv.id, a.id);
    s.markRead(conv.id, a.id);
    expect(s.listReads(conv.id).filter((r) => r.userId === a.id)).toHaveLength(1);
    s.close();
  });
});
