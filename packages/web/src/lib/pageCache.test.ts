import { afterEach, describe, expect, it, vi } from "vitest";

import {
  CACHE_MAX_AGE_MS,
  CACHE_VERSION,
  cacheEnabled,
  clearCache,
  readCache,
  writeCache,
} from "./pageCache.js";

describe("pageCache", () => {
  afterEach(() => {
    vi.unstubAllEnvs();
    localStorage.clear();
  });

  it("测试环境下一律不读写：用例之间不串数据", () => {
    expect(cacheEnabled()).toBe(false);
    writeCache("providers", "mock custom");
    expect(readCache("providers")).toBeNull();
  });

  it("打开缓存后能存能取，键上带版本号", () => {
    vi.stubEnv("MODE", "production");
    writeCache("providers", "mock custom", 1000);
    expect(readCache("providers", 2000)).toBe("mock custom");
    // 版本换了要读不到上一版的缓存，否则解析规则和数据的形状会对不上。
    const stored = localStorage.getItem(`heming.modelpage.v${CACHE_VERSION}.providers`);
    expect(JSON.parse(stored ?? "null")).toEqual({ at: 1000, text: "mock custom" });
    expect(localStorage.getItem(`heming.modelpage.v${CACHE_VERSION + 1}.providers`)).toBeNull();
  });

  it("没有这份缓存时返回 null，空串也算没有", () => {
    vi.stubEnv("MODE", "production");
    expect(readCache("accounts")).toBeNull();
    writeCache("accounts", "");
    expect(readCache("accounts")).toBeNull();
  });

  it("放太久的缓存不用：隔天的状态不该先闪一下", () => {
    vi.stubEnv("MODE", "production");
    writeCache("providers", "昨天的来源", 0);
    expect(readCache("providers", CACHE_MAX_AGE_MS - 1)).toBe("昨天的来源");
    expect(readCache("providers", CACHE_MAX_AGE_MS + 1)).toBeNull();
  });

  it("形状不对的缓存当没有（旧版没时间戳的、时间戳坏掉的）", () => {
    vi.stubEnv("MODE", "production");
    localStorage.setItem(`heming.modelpage.v${CACHE_VERSION}.providers`, "直接写的字符串");
    expect(readCache("providers")).toBeNull();
    localStorage.setItem(`heming.modelpage.v${CACHE_VERSION}.accounts`, JSON.stringify({ text: "x" }));
    expect(readCache("accounts")).toBeNull();
    localStorage.setItem(
      `heming.modelpage.v${CACHE_VERSION}.quotas`,
      JSON.stringify({ at: null, text: "x" }),
    );
    expect(readCache("quotas")).toBeNull();
  });

  it("clearCache 只清自己这几份", () => {
    vi.stubEnv("MODE", "production");
    writeCache("providers", "a");
    writeCache("accounts", "b");
    localStorage.setItem("heming.magpie.v1", "别人的");
    clearCache();
    expect(readCache("providers")).toBeNull();
    expect(readCache("accounts")).toBeNull();
    expect(localStorage.getItem("heming.magpie.v1")).toBe("别人的");
  });

  it("存不下时不当回事：写失败不影响读别的", () => {
    vi.stubEnv("MODE", "production");
    const spy = vi.spyOn(Storage.prototype, "setItem").mockImplementation(() => {
      throw new Error("QuotaExceededError");
    });
    expect(() => writeCache("providers", "x")).not.toThrow();
    spy.mockRestore();
  });
});
