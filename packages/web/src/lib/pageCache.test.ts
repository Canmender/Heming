import { afterEach, describe, expect, it, vi } from "vitest";

import { CACHE_VERSION, cacheEnabled, clearCache, readCache, writeCache } from "./pageCache.js";

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
    writeCache("providers", "mock custom");
    expect(readCache("providers")).toBe("mock custom");
    // 版本换了要读不到上一版的缓存，否则解析规则和数据的形状会对不上。
    expect(localStorage.getItem(`heming.modelpage.v${CACHE_VERSION}.providers`)).toBe("mock custom");
    expect(localStorage.getItem(`heming.modelpage.v${CACHE_VERSION + 1}.providers`)).toBeNull();
  });

  it("没有这份缓存时返回 null，空串也算没有", () => {
    vi.stubEnv("MODE", "production");
    expect(readCache("accounts")).toBeNull();
    writeCache("accounts", "");
    expect(readCache("accounts")).toBeNull();
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
