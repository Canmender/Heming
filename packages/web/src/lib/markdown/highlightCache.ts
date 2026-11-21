/**
 * 代码高亮的缓存（d.413，d.412.4.181 加固）。
 *
 * shiki 的 `codeToHtml` 要把整段代码按 TextMate 语法重新分词，是渲染页里最贵的
 * 一步之一。以下内容会重复触发同一对 (code, lang)：
 *
 * - 同一段代码出现在多条历史消息里（复制粘贴 / 重复示例）；
 * - 流式收口时每个代码块从「纯文本」切到「高亮」，组件重挂；
 * - 切会话、Tab、刷新后历史消息重新挂载；
 * - 同一帧里两条消息恰好是同一段代码。
 *
 * 缓存的是 Promise 而不是结果值：相同 key 的并发调用共享同一次分词，
 * 先到的那次没算完时后到的直接等它。`null`（未知语言 / 加载失败）也缓存，
 * 否则每次重挂都要重新走一遍「高亮器没加载成功」的失败路径。
 *
 * ## d.412.4.181 加固
 *
 * 原来 key 直接拼整段代码：**每次调用（含命中）都要复制一遍完整代码字符串**，
 * 而且少数超大代码块能把缓存撑到很大。现在改成两条约束：
 *
 * 1. key 只存「语言 + 长度 + djb2 哈希」的短串（`makeHighlightKey`）；
 *    命中时把调用方传入的代码原文作为 `validate` 比对，哈希撞了就重算覆盖，
 *    所以短 key 不会把别人的高亮结果错配过来。
 * 2. 除条数上限外再加**字节软上限**（按 key + 校验原文估算），超限继续淘汰
 *    最久未用的条目，避免几个大代码块长期钉住内存。
 */

/** 默认最多缓存多少个 (code, lang) 结果。 */
export const HIGHLIGHT_CACHE_MAX = 128;

/**
 * 缓存总字节软上限（按 key + 校验原文长度、UTF-16 双字节估算）。
 * 2MB ≈ 一百万字符的源码；正常聊天远达不到，只拦极端大代码块。
 */
export const HIGHLIGHT_CACHE_BYTES = 2 * 1024 * 1024;

export interface PromiseCache<T> {
  /**
   * 命中直接返回缓存的 Promise；未命中时调用 factory 并记住它（含并发去重）。
   * `validate` 给定后，命中时还会比对该值——不同则说明 key 哈希碰撞，按未命中重算。
   */
  getOrCreate(key: string, factory: () => Promise<T>, validate?: string): Promise<T>;
  /** 清空缓存（高亮器配置变化、测试隔离时用）。 */
  clear(): void;
  /** 当前条目数，便于测试容量边界。 */
  readonly size: number;
  /** 当前估算占用字节数，便于测试字节上限。 */
  readonly bytes: number;
}

interface CacheEntry<T> {
  promise: Promise<T>;
  bytes: number;
  validate?: string;
}

/**
 * 建一个容量 + 字节双有界的 Promise 缓存，命中时把条目移到「最近使用」。
 *
 * 用 Map 的插入顺序当 LRU 顺序：命中先 delete 再 set，淘汰时取 `keys().next()`。
 * 不引入第三方依赖，也不依赖浏览器 API。
 */
export function createPromiseCache<T>(maxEntries: number, maxBytes = Infinity): PromiseCache<T> {
  const limit = Number.isFinite(maxEntries) ? Math.max(1, Math.floor(maxEntries)) : 1;
  const byteLimit = Number.isFinite(maxBytes) && maxBytes > 0 ? Math.floor(maxBytes) : Infinity;
  const cache = new Map<string, CacheEntry<T>>();
  let bytes = 0;

  function evictOldest(): void {
    const oldest = cache.keys().next().value;
    if (oldest === undefined) return;
    const entry = cache.get(oldest)!;
    bytes -= entry.bytes;
    cache.delete(oldest);
  }

  return {
    getOrCreate(key, factory, validate) {
      const hit = cache.get(key);
      if (hit && (validate === undefined || hit.validate === validate)) {
        // LRU touch：Map 的迭代顺序是插入顺序，删掉再插就变成最新的
        cache.delete(key);
        cache.set(key, hit);
        return hit.promise;
      }
      const promise = factory();
      if (hit) {
        // 命中但校验不符（短 key 哈希碰撞）：撤销旧条目的字节记账，下面用新值覆盖
        bytes -= hit.bytes;
        cache.delete(key);
      }
      const entry: CacheEntry<T> = {
        promise,
        bytes: key.length * 2 + (validate?.length ?? 0) * 2,
        validate,
      };
      bytes += entry.bytes;
      cache.set(key, entry);
      while (cache.size > limit) evictOldest();
      // 至少保留一条：超大单条不该因为字节上限被立刻踢掉（它仍会被正常返回）
      while (bytes > byteLimit && cache.size > 1) evictOldest();
      return promise;
    },
    clear() {
      cache.clear();
      bytes = 0;
    },
    get size() {
      return cache.size;
    },
    get bytes() {
      return bytes;
    },
  };
}

/**
 * 高亮缓存 key：语言 + 代码长度 + djb2 短哈希，不再把整段代码复制进 key。
 * 真正的代码原文由 `getOrCreate` 的 `validate` 参数比对（见文件头说明）。
 */
export function makeHighlightKey(lang: string, code: string): string {
  let hash = 5381;
  for (let i = 0; i < code.length; i++) {
    hash = (hash * 33 + code.charCodeAt(i)) | 0;
  }
  return `${lang}\u0000${code.length}\u0000${(hash >>> 0).toString(36)}`;
}
