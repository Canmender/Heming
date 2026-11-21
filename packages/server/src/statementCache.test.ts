import { describe, it, expect } from "vitest";
import { openDb } from "./db.js";
import {
  withStatementCache,
  DEFAULT_STATEMENT_CACHE_MAX,
  type StatementCacheStats,
} from "./statementCache.js";

type WithStats = { statementCacheStats(): StatementCacheStats };

function statsOf(db: ReturnType<typeof withStatementCache>): StatementCacheStats {
  return (db as unknown as WithStats).statementCacheStats();
}

describe("SQLite 语句缓存（d.412.4.182）", () => {
  it("同一 SQL 复用编译语句，命中计数随调用增长", () => {
    const db = withStatementCache(openDb(":memory:"));
    try {
      db.exec("CREATE TABLE t (a INTEGER)");
      const s1 = db.prepare("INSERT INTO t VALUES (?)");
      s1.run(1);
      const s2 = db.prepare("INSERT INTO t VALUES (?)");
      s2.run(2);
      // 命中缓存时返回的是同一个 StatementSync 对象（node:sqlite 原生 prepare 每次新建）
      expect(s2).toBe(s1);
      const before = statsOf(db);
      expect(before.hits).toBeGreaterThanOrEqual(1);
      expect(before.misses).toBeGreaterThanOrEqual(1);
      // 复用语句用不同参数反复执行仍正确
      const q = db.prepare("SELECT a FROM t WHERE a > ? ORDER BY a");
      expect(q.get(0)).toEqual({ a: 1 });
      expect(q.all(1)).toEqual([{ a: 2 }]);
    } finally {
      db.close();
    }
  });

  it("不同 SQL 文本是不同条目；按原文区分", () => {
    const db = withStatementCache(openDb(":memory:"));
    try {
      const a = db.prepare("SELECT 1 AS x");
      const b = db.prepare("SELECT 2 AS x");
      expect(a).not.toBe(b);
      expect(db.prepare("SELECT 1 AS x")).toBe(a);
      expect(statsOf(db).size).toBe(2);
    } finally {
      db.close();
    }
  });

  it("超出上限时按 LRU 淘汰，size 有界、命中仍正确", () => {
    const db = withStatementCache(openDb(":memory:"), 2);
    try {
      const a = db.prepare("SELECT 1 AS x");
      const b = db.prepare("SELECT 2 AS x");
      // 触碰 a 让它成为最近使用，随后插入 c 应淘汰 b
      expect(db.prepare("SELECT 1 AS x")).toBe(a);
      // a 刚被触碰过，仍在缓存中
      expect(db.prepare("SELECT 1 AS x")).toBe(a);
      const c = db.prepare("SELECT 3 AS x");
      expect(statsOf(db).size).toBe(2);
      expect(statsOf(db).evictions).toBeGreaterThanOrEqual(1);
      // b 是最久未用的一条，已被淘汰：再取会重新编译，与旧对象不同
      expect(db.prepare("SELECT 2 AS x")).not.toBe(b);
      expect(c.get()).toEqual({ x: 3 });
    } finally {
      db.close();
    }
  });

  it("exec/close 等成员透传原始句柄，行为不变", () => {
    const db = withStatementCache(openDb(":memory:"));
    db.exec("CREATE TABLE t (a INTEGER)");
    db.prepare("INSERT INTO t VALUES (9)").run();
    expect(db.prepare("SELECT a FROM t").get()).toEqual({ a: 9 });
    expect(DEFAULT_STATEMENT_CACHE_MAX).toBeGreaterThan(0);
    expect(() => db.close()).not.toThrow();
  });
});
