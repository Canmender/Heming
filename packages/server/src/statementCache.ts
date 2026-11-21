import type { DatabaseSync } from "node:sqlite";

/**
 * node:sqlite 的 `db.prepare()` 每次调用都会**重新编译** SQL（已实测：同一句 prepare
 * 两次拿到的不是同一个 StatementSync 对象）。sqliteStore 里有上百处 prepare，其中
 * `listMessages` / `searchMessages` / 团队列表等是高频路径，每条请求都要重编译一遍。
 *
 * 这里给 DatabaseSync 套一层 `prepare` 记忆化：按 SQL 原文缓存编译好的语句，命中即复用。
 * 用 Proxy 而非改调用点——sqliteStore 只碰 exec/prepare/close，Proxy 把其余成员原样透传，
 * 既避免散布全文件的 120 处改动，也保留 node:sqlite 原生方法所需的 `this` 绑定。
 *
 * 三条边界：
 * 1. **有界**：动态 SQL（如 `IN (?, ?, …)` 占位符数量变化）会产生大量不同 key，
 *    用 LRU 上限兜住内存，不会无限增长；超出即淘汰最久未用的语句。
 * 2. **按原文缓存**：key 就是 SQL 字符串（含空白），语义完全由调用方负责——
 *    与直接 prepare 的行为一致（不同的 SQL 文本就是不同的语句）。
 * 3. **与库同生命周期**：schema 在 openDb 时定型，store 存续期间不变；缓存随 store
 *    一起丢弃，close 后不再使用。
 */

type Statement = ReturnType<DatabaseSync["prepare"]>;

/** 默认缓存上限：够覆盖所有固定 SQL + 常见占位符宽度，又不至于无限增长。 */
export const DEFAULT_STATEMENT_CACHE_MAX = 200;

export interface StatementCacheStats {
  /** 当前缓存的语句数。 */
  size: number;
  /** 命中次数（返回已编译语句）。 */
  hits: number;
  /** 未命中次数（现场编译）。 */
  misses: number;
  /** 因超出上限被淘汰的次数。 */
  evictions: number;
}

/**
 * 给数据库句柄加一层 `prepare` 记忆化。
 *
 * 返回的仍是 `DatabaseSync` 类型（运行时是 Proxy），因此调用方零改动：
 * `exec` / `close` 及其它成员委托给原始句柄，只有 `prepare` 被拦截。
 * 额外挂一个 `statementCacheStats()` 供测试/自检读取缓存口径（不在 DatabaseSync 类型里，
 * 需要时用 `as unknown as { statementCacheStats(): StatementCacheStats }` 取用）。
 */
export function withStatementCache(
  db: DatabaseSync,
  maxEntries = DEFAULT_STATEMENT_CACHE_MAX,
): DatabaseSync {
  const limit = Number.isFinite(maxEntries) && maxEntries > 0 ? Math.floor(maxEntries) : DEFAULT_STATEMENT_CACHE_MAX;
  // Map 迭代顺序即 LRU 顺序：命中时 delete+set 把条目挪到末尾，淘汰时取最前的 key。
  const cache = new Map<string, Statement>();
  let hits = 0;
  let misses = 0;
  let evictions = 0;

  const stats = (): StatementCacheStats => ({ size: cache.size, hits, misses, evictions });

  const cachedPrepare = (sql: string): Statement => {
    const hit = cache.get(sql);
    if (hit) {
      cache.delete(sql);
      cache.set(sql, hit);
      hits += 1;
      return hit;
    }
    const stmt = db.prepare(sql); // 闭包绑定原始句柄，避免 Proxy 的 this 问题
    misses += 1;
    cache.set(sql, stmt);
    if (cache.size > limit) {
      const oldest = cache.keys().next().value;
      if (oldest !== undefined) {
        cache.delete(oldest);
        evictions += 1;
      }
    }
    return stmt;
  };

  return new Proxy(db, {
    get(target, prop, receiver) {
      if (prop === "prepare") return cachedPrepare;
      if (prop === "statementCacheStats") return stats;
      const value = Reflect.get(target, prop, target);
      // node:sqlite 的原生方法需要正确的 this；一律绑到原始句柄再交出去。
      return typeof value === "function" ? value.bind(target) : value;
    },
  });
}
