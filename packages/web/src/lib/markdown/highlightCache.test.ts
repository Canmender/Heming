import { describe, expect, it, vi } from "vitest";
import {
  createPromiseCache,
  HIGHLIGHT_CACHE_BYTES,
  HIGHLIGHT_CACHE_MAX,
  makeHighlightKey,
} from "./highlightCache.js";

describe("createPromiseCache（d.413 高亮缓存，d.412.4.181 加固）", () => {
  it("相同 key 只调用一次 factory，并返回同一个 Promise", async () => {
    const cache = createPromiseCache<string>(8);
    const factory = vi.fn(async () => "RESULT");
    const a = cache.getOrCreate("k", factory);
    const b = cache.getOrCreate("k", factory);
    expect(factory).toHaveBeenCalledTimes(1);
    expect(b).toBe(a);
    expect(await a).toBe("RESULT");
  });

  it("并发调用共享同一次计算（在 Promise 落定前命中）", async () => {
    const cache = createPromiseCache<number>(8);
    let resolve!: (v: number) => void;
    const factory = vi.fn(() => new Promise<number>((r) => { resolve = r; }));
    const p1 = cache.getOrCreate("k", factory);
    const p2 = cache.getOrCreate("k", factory);
    expect(factory).toHaveBeenCalledTimes(1);
    resolve(42);
    expect(await p1).toBe(42);
    expect(await p2).toBe(42);
  });

  it("null 结果也缓存，不重复调用 factory", async () => {
    const cache = createPromiseCache<string | null>(8);
    const factory = vi.fn(async () => null);
    expect(await cache.getOrCreate("未知语言", factory)).toBeNull();
    expect(await cache.getOrCreate("未知语言", factory)).toBeNull();
    expect(factory).toHaveBeenCalledTimes(1);
  });

  it("不同 key 互不干扰", async () => {
    const cache = createPromiseCache<string>(8);
    const a = vi.fn(async () => "A");
    const b = vi.fn(async () => "B");
    expect(await cache.getOrCreate("a", a)).toBe("A");
    expect(await cache.getOrCreate("b", b)).toBe("B");
    expect(a).toHaveBeenCalledTimes(1);
    expect(b).toHaveBeenCalledTimes(1);
  });

  it("超过容量后按最近使用淘汰最早的条目", async () => {
    const cache = createPromiseCache<number>(2);
    await cache.getOrCreate("a", async () => 1);
    await cache.getOrCreate("b", async () => 2);
    // 命中 a，把它变成最近使用；此时 b 是最久未用
    await cache.getOrCreate("a", async () => 999);
    const cFactory = vi.fn(async () => 3);
    await cache.getOrCreate("c", cFactory);
    expect(cache.size).toBe(2);
    // a 被保留（命中过），b 被淘汰
    expect(await cache.getOrCreate("a", async () => 999)).toBe(1);
    expect(cFactory).toHaveBeenCalledTimes(1);
    // b 需要重新计算
    const bFactory = vi.fn(async () => 22);
    expect(await cache.getOrCreate("b", bFactory)).toBe(22);
    expect(bFactory).toHaveBeenCalledTimes(1);
  });

  it("clear 清空所有条目（含字节记账）", async () => {
    const cache = createPromiseCache<number>(8);
    await cache.getOrCreate("a", async () => 1, "原文本A");
    expect(cache.size).toBe(1);
    expect(cache.bytes).toBeGreaterThan(0);
    cache.clear();
    expect(cache.size).toBe(0);
    expect(cache.bytes).toBe(0);
    const factory = vi.fn(async () => 2);
    expect(await cache.getOrCreate("a", factory)).toBe(2);
    expect(factory).toHaveBeenCalledTimes(1);
  });

  it("默认容量常量是正数且有界", () => {
    expect(HIGHLIGHT_CACHE_MAX).toBeGreaterThan(0);
    expect(Number.isFinite(HIGHLIGHT_CACHE_MAX)).toBe(true);
    expect(HIGHLIGHT_CACHE_BYTES).toBeGreaterThan(0);
    expect(Number.isFinite(HIGHLIGHT_CACHE_BYTES)).toBe(true);
  });

  it("makeHighlightKey：短 key 不含代码原文，含语言/长度/哈希三段", () => {
    const code = "const answer = 42; // " + "x".repeat(500);
    const key = makeHighlightKey("ts", code);
    expect(key).not.toContain(code); // 关键：不再把整段代码复制进 key
    expect(key.length).toBeLessThan(40);
    const parts = key.split("\u0000");
    expect(parts).toHaveLength(3);
    expect(parts[0]).toBe("ts");
    expect(parts[1]).toBe(String(code.length));
    // 同语言同代码 → 同 key；不同代码 → 不同 key（哈希）
    expect(makeHighlightKey("ts", code)).toBe(key);
    expect(makeHighlightKey("ts", code + " ")).not.toBe(key);
    expect(makeHighlightKey("py", code)).not.toBe(key);
  });

  it("validate 校验原文：命中时不同原文会重算并覆盖旧结果", async () => {
    const cache = createPromiseCache<string>(8);
    const key = "短key";
    const first = vi.fn(async () => "结果A");
    const second = vi.fn(async () => "结果B");
    expect(await cache.getOrCreate(key, first, "原文A")).toBe("结果A");
    // 同一 key 但原文校验不符 → 当作未命中，重算并覆盖
    expect(await cache.getOrCreate(key, second, "原文B")).toBe("结果B");
    expect(first).toHaveBeenCalledTimes(1);
    expect(second).toHaveBeenCalledTimes(1);
    // 再以原文A 访问，也应重算（旧结果已被覆盖）
    const third = vi.fn(async () => "结果A2");
    expect(await cache.getOrCreate(key, third, "原文A")).toBe("结果A2");
    expect(third).toHaveBeenCalledTimes(1);
    // 校验相符的命中直接复用，不重算
    const noCall = vi.fn(async () => "不应调用");
    expect(await cache.getOrCreate(key, noCall, "原文A")).toBe("结果A2");
    expect(noCall).not.toHaveBeenCalled();
  });

  it("字节上限：超限淘汰最久未用条目，始终至少保留一条", async () => {
    // 每条 key 长度 ~1*2=2 字节。上限 5 → 放 3 条(6 字节)就需淘汰
    const cache = createPromiseCache<number>(10, 5);
    await cache.getOrCreate("a", async () => 1);
    await cache.getOrCreate("b", async () => 2);
    await cache.getOrCreate("c", async () => 3);
    expect(cache.size).toBe(2);
    expect(cache.bytes).toBeLessThanOrEqual(5);
    // 超大单条在空缓存下仍可保存（至少保留一条，不被立刻踢掉）
    const bigCache = createPromiseCache<number>(10, 5);
    await bigCache.getOrCreate("x".repeat(100), async () => 9);
    expect(bigCache.size).toBe(1);
  });
});
