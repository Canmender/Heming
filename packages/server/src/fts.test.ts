import { describe, it, expect, beforeEach, afterEach } from "vitest";
import request from "supertest";
import { mkdtempSync, rmSync } from "node:fs";
import { createRequire } from "node:module";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { SYSTEM_AGENT_ID } from "@heming/shared";
import { createSqliteStore, type SqliteStore } from "./sqliteStore.js";
import { createApp } from "./app.js";

// 与 db.ts 同法加载 node:sqlite（静态 import 会被 vite-node 剥掉 node: 前缀）。
const { DatabaseSync } = createRequire(import.meta.url)("node:sqlite") as typeof import("node:sqlite");

type App = ReturnType<typeof createApp>;

let dir: string;
let dbPath: string;
let store: SqliteStore;
let app: App;
let token: string;
let userId: string;
let conv: string;

const auth = () => ({ Authorization: `Bearer ${token}` });

async function search(q: string, extra = "") {
  return request(app)
    .get(`/api/conversations/search?q=${encodeURIComponent(q)}${extra}`)
    .set(auth());
}

beforeEach(async () => {
  dir = mkdtempSync(join(tmpdir(), "heming-fts-"));
  dbPath = join(dir, "t.db");
  store = createSqliteStore(dbPath);
  app = createApp(store, { allowRegister: true });
  const reg = await request(app).post("/api/auth/register").send({
    username: "alice",
    password: "secret123",
    displayName: "Alice",
  });
  expect(reg.status).toBe(201);
  token = reg.body.token as string;
  userId = reg.body.user.id as string;
  conv = store.createAgentConversation(userId, SYSTEM_AGENT_ID).id;
});

afterEach(() => {
  store.close();
  rmSync(dir, { recursive: true, force: true });
});

describe("SQLite FTS5 会话搜索（d.236）", () => {
  it("中文子串与英文单词命中；写入后立即可搜", async () => {
    store.addMessage(conv, "user", userId, { text: "把 evals 的用例都跑一遍" });
    store.addMessage(conv, "agent", SYSTEM_AGENT_ID, { text: "跑完了，32 条全部通过。" });

    const zh = await search("全部通过");
    expect(zh.status).toBe(200);
    expect(zh.body.hits).toHaveLength(1);
    expect(zh.body.hits[0].snippet).toContain("全部通过");
    expect(zh.body.hits[0].senderType).toBe("agent");

    const en = await search("evals");
    expect(en.body.hits).toHaveLength(1);
    expect(en.body.hits[0].snippet).toContain("evals");
  });

  it("短词（<3 字符）回退线性扫描仍能命中", async () => {
    store.addMessage(conv, "user", userId, { text: "ab 是短词" });
    // 证明 SQLite 实现确实放弃 FTS 快路径（trigram 最少 3 字符）
    expect(
      store.searchMessages("ab", { conversationIds: [conv], limit: 10, maxScanned: 100 }),
    ).toBeNull();
    const res = await search("ab");
    expect(res.status).toBe(200);
    expect(res.body.hits).toHaveLength(1);
    expect(res.body.hits[0].snippet).toContain("ab 是短词");
  });

  it("特殊字符不会变成 FTS 操作符：c++ / foo-bar / 100% / AND OR / 引号", async () => {
    store.addMessage(conv, "user", userId, {
      text: 'c++ 与 foo-bar 和 100% 以及 AND OR 还有他说 "你好" 世界',
    });
    for (const q of ["c++", "foo-bar", "100%", "AND OR", '他说 "你好"']) {
      const res = await search(q);
      expect(res.status, `query=${q}`).toBe(200);
      expect(res.body.hits, `query=${q}`).toHaveLength(1);
    }
    // 不存在的词不会误命中
    expect((await search("NEAR(不存在)")).body.hits).toEqual([]);
  });

  it("同一会话多条命中只回最新一条（与旧扫描口径一致）", async () => {
    store.addMessage(conv, "user", userId, { text: "第一次提到全部通过" });
    store.addMessage(conv, "user", userId, { text: "第二次又说全部通过" });
    const res = await search("全部通过");
    expect(res.body.hits).toHaveLength(1);
    expect(res.body.hits[0].snippet).toContain("第二次");
    expect(res.body.truncated).toBe(false);
    expect(typeof res.body.scanned).toBe("number");
  });

  it("limit 只截前 N 个有命中的会话；顺序按会话最近活跃", async () => {
    store.addMessage(conv, "user", userId, { text: "旧会话也提到全部通过" });
    const conv2 = store.createAgentConversation(userId, SYSTEM_AGENT_ID, { fresh: true }).id;
    store.addMessage(conv2, "user", userId, { text: "新会话提到全部通过" });

    const limited = await search("全部通过", "&limit=1");
    expect(limited.status).toBe(200);
    expect(limited.body.hits).toHaveLength(1);
    expect(limited.body.hits[0].conversationId).toBe(conv2);

    const all = await search("全部通过");
    expect(all.body.hits.map((h: { conversationId: string }) => h.conversationId)).toEqual([
      conv2,
      conv,
    ]);
  });

  it("只搜自己所在的会话（FTS 结果按成员关系收口）", async () => {
    store.addMessage(conv, "user", userId, { text: "只有 alice 能看到全部通过" });
    const bob = store.createUser("bob", "h", "鲍勃");
    const bobConv = store.createAgentConversation(bob.id, SYSTEM_AGENT_ID).id;
    store.addMessage(bobConv, "user", bob.id, { text: "bob 的全部通过" });

    const res = await search("全部通过");
    expect(res.body.hits).toHaveLength(1);
    expect(res.body.hits[0].conversationId).toBe(conv);
  });

  it("E2E 加密后索引删除：重封的消息不再被搜到", async () => {
    const msg = store.addMessage(conv, "user", userId, { text: "机密关键词在这里" });
    const put = await request(app)
      .put(`/api/messages/${msg.id}/reencrypt`)
      .set(auth())
      .send({ enc: "e2e", cipher: "Q2lwaGVy", chainKid: "kid1", n: 1 });
    expect(put.status).toBe(200);

    const res = await search("机密关键词");
    expect(res.status).toBe(200);
    expect(res.body.hits).toEqual([]);
    // 索引里也不能残留明文
    expect(
      store.searchMessages("机密关键词", {
        conversationIds: [conv],
        limit: 10,
        maxScanned: 100,
      })?.hits ?? [],
    ).toEqual([]);
  });

  it("FTS 表不可用时自动回退：搜索仍命中，写消息不报错", async () => {
    store.addMessage(conv, "user", userId, { text: "索引消失之前的消息" });
    // 外部删表模拟「环境没有 FTS5 / 索引损坏」；store 运行中应降级而不是抛错。
    const raw = new DatabaseSync(dbPath);
    raw.exec("DROP TABLE messages_fts");
    raw.close();

    const before = await search("索引消失");
    expect(before.status).toBe(200);
    expect(before.body.hits).toHaveLength(1);

    // 写路径也不能因为索引没了而失败
    expect(() =>
      store.addMessage(conv, "user", userId, { text: "索引消失之后的消息" }),
    ).not.toThrow();
    const after = await search("索引消失之后");
    expect(after.body.hits).toHaveLength(1);
  });

  it("响应形状不变：{ hits, truncated, scanned }", async () => {
    store.addMessage(conv, "user", userId, { text: "形状检查全部通过" });
    const res = await search("全部通过");
    expect(Object.keys(res.body).sort()).toEqual(["hits", "scanned", "truncated"]);
    expect(Object.keys(res.body.hits[0]).sort()).toEqual(
      [
        "conversationId",
        "conversationTitle",
        "createdAt",
        "lastMessageAt",
        "messageId",
        "senderType",
        "snippet",
      ].sort(),
    );
  });
});
