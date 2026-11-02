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
  it("旧库（无信封列）幂等迁移后 reencrypt 同口径：明文 payload 清空", () => {
    const dbPath = newDbPath();
    const legacy = new DatabaseSync(dbPath);
    legacy.exec(`
      CREATE TABLE conversations (id TEXT PRIMARY KEY, kind TEXT NOT NULL, name TEXT, created_by TEXT);
      CREATE TABLE messages (
        id TEXT PRIMARY KEY, conv_id TEXT NOT NULL, sender_type TEXT NOT NULL, sender_id TEXT NOT NULL,
        payload TEXT NOT NULL, reply_to TEXT, created_at TEXT NOT NULL, recalled_at TEXT
      );
      INSERT INTO conversations (id, kind) VALUES ('c-legacy', 'agent');
      INSERT INTO messages (id, conv_id, sender_type, sender_id, payload, reply_to, created_at, recalled_at)
        VALUES ('m-legacy', 'c-legacy', 'user', 'u1', '{"text":"旧库明文"}', 'r-old', '2026-10-01T00:00:00.000Z', NULL);
    `);
    legacy.close();

    const s = createSqliteStore(dbPath);
    // 迁移后存量行：enc 按 DEFAULT 回填 plain，明文尚在（重封前口径）
    const before = s.listMessages("c-legacy")[0];
    expect(before).toMatchObject({ enc: "plain" });
    expect(before.payload.text).toBe("旧库明文");
    // d.54 契约不再有 replyTo 字段（DB 列保留但不再出站）
    expect("replyTo" in before).toBe(false);

    const res = s.reencryptMessage("m-legacy", "u1", { cipher: "Q2lwaGVy", chainKid: "kid1", n: 0 });
    expect(res.ok).toBe(true);

    const after = s.listMessages("c-legacy")[0];
    expect(after).toMatchObject({ enc: "e2e", cipher: "Q2lwaGVy", chainKid: "kid1", n: 0 });
    expect(after.payload).toEqual({ text: "" }); // 明文占位清空（出站无原文）
    s.close();
  });

  it("close 后重开同路径：用户/智能体会话/消息全量保留", () => {
    const dbPath = newDbPath();
    const s1 = createSqliteStore(dbPath);
    const a = s1.createUser("alice", "hash-a", "爱丽丝");
    const agent = s1.createAgent(a.id, { name: "助手", description: "" });
    const conv = s1.createAgentConversation(a.id, agent.id);
    s1.addMessage(conv.id, "user", a.id, { text: "重启后还在" });
    s1.close();

    const s2 = createSqliteStore(dbPath);
    expect(s2.findUserByUsername("alice")?.user.displayName).toBe("爱丽丝");
    const convs = s2.listConversations(a.id);
    expect(convs).toHaveLength(1);
    expect(convs[0]).toMatchObject({ type: "agent", unreadCount: 0 });
    expect(s2.listMessages(conv.id).map((m) => m.payload.text)).toEqual(["重启后还在"]);
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

  it("用户名冲突 / updateProfile / listMessages limit 升序截断", () => {
    const s = createSqliteStore(newDbPath());
    const a = s.createUser("alice", "h", "爱丽丝");
    expect(() => s.createUser("alice", "h", "A2")).toThrow("username taken");
    const renamed = s.updateProfile(a.id, { displayName: "新名" });
    expect(renamed.displayName).toBe("新名");
    expect(renamed.avatar).toBeUndefined();
    expect(s.findUserById(a.id)!.displayName).toBe("新名");
    expect(() => s.updateProfile("nope", { displayName: "X" })).toThrow("user not found");

    const agent = s.createAgent(a.id, { name: "助手", description: "" });
    const conv = s.createAgentConversation(a.id, agent.id);
    s.addMessage(conv.id, "user", a.id, { text: "一" });
    s.addMessage(conv.id, "user", a.id, { text: "二" });
    s.addMessage(conv.id, "user", a.id, { text: "三" });
    expect(s.listMessages(conv.id, 2).map((m) => m.payload.text)).toEqual(["二", "三"]);
    s.close();
  });

  it("团队：最近活跃与动向持久化（重开后仍在，幂等键仍生效）", () => {
    const dbPath = newDbPath();
    const s1 = createSqliteStore(dbPath);
    const a = s1.createUser("alice", "h", "爱丽丝");
    s1.touchUser(a.id);
    const item = {
      kind: "task" as const,
      title: "写周报",
      occurredAt: "2026-11-02T08:00:00.000Z",
      sourceId: "task:1",
    };
    expect(s1.addTeamActivity(a.id, item)).toBe(true);
    expect(s1.addTeamActivity(a.id, item)).toBe(false);
    s1.close();

    const s2 = createSqliteStore(dbPath);
    expect(s2.listTeamMembers().find((m) => m.user.id === a.id)?.lastSeenAt).toBeTruthy();
    expect(s2.listTeamActivities()).toHaveLength(1);
    expect(s2.addTeamActivity(a.id, item)).toBe(false);
    expect(s2.clearTeamActivities(a.id)).toBe(1);
    expect(s2.listTeamActivities()).toEqual([]);
    s2.close();
  });
});
