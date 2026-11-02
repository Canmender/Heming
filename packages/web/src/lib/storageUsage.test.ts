import { describe, it, expect, vi } from "vitest";
import {
  DEFAULT_QUOTA_BYTES,
  OTHER_MODULE,
  STORAGE_MODULE_RULES,
  browserProbe,
  measureStorageUsage,
  moduleOf,
  probeFrom,
  probeFromKeys,
  probeOfStorage,
  probeQuotaBytes,
} from "./storageUsage.js";
import { utf8Length } from "./memory/storage.js";

/**
 * 本机存储水位条（d.31 · P1-1 ①）的读侧。
 *
 * 这套用例钉三件事：
 * 1. **分组怎么算**——模块归属与最长前缀优先，错了用户会「按着提示去清理却找不到东西」；
 * 2. **字节怎么算**——UTF-8 字节数，不是字符串长度（中文一字三字节）；
 * 3. **失败怎么退**——隐私模式 / 读不出来 / 配额探测失败，一律不抛。
 */
describe("moduleOf（键名 → 模块）", () => {
  it("按前缀归组", () => {
    expect(moduleOf("heming.memory.semantic.v1")).toBe("记忆");
    expect(moduleOf("heming.tasks.v1")).toBe("任务");
    expect(moduleOf("heming.taskTemplates.v1")).toBe("任务");
    expect(moduleOf("heming.staff.v1")).toBe("幕僚");
    expect(moduleOf("heming.msgCache.c1")).toBe("消息缓存");
    expect(moduleOf("heming.e2e.identity")).toBe("加密会话");
    expect(moduleOf("heming.hitl.v1")).toBe("HITL");
    expect(moduleOf("heming.notifications.v1")).toBe("通知");
  });

  it("消息缓存的迁移/不可解密备份键仍归「消息缓存」，不会被算成「其它」", () => {
    // P0-5b：备份键与主键同前缀，统计上确实占字节，必须归到同一组；
    // 只是清理入口会排除它们（见 StorageUsageCard）。
    expect(moduleOf("heming.msgCache.c1.__heming_plaintext_backup")).toBe("消息缓存");
    expect(moduleOf("heming.msgCache.c1.__heming_undecryptable")).toBe("消息缓存");
    expect(moduleOf("heming.msgCache.lru.v1")).toBe("消息缓存");
  });

  it("未知键归「其它」", () => {
    expect(moduleOf("heming.token")).toBe(OTHER_MODULE);
    expect(moduleOf("heming.llmConfigs")).toBe(OTHER_MODULE);
    expect(moduleOf("完全不相干的键")).toBe(OTHER_MODULE);
  });

  it("最长前缀优先：辅助账本不会被「记忆」抢走", () => {
    // `heming.memory.` 与 `heming.memory.usage` 都是合法前缀。
    // 先命中短的会把用量账本算进「记忆」——用户去清理记忆时账本纹丝不动，
    // 而水位条又告诉他「记忆占了很多」，两个界面互相矛盾。
    expect(moduleOf("heming.memory.usage.v1")).toBe("辅助账本");
    expect(moduleOf("heming.memory.recallLog.v1")).toBe("辅助账本");
    // 而普通的记忆键仍归「记忆」
    expect(moduleOf("heming.memory.working.v1")).toBe("记忆");
  });

  it("映射表的每个前缀都能命中自己的模块（表自身没有互相矛盾项）", () => {
    for (const rule of STORAGE_MODULE_RULES) {
      expect(moduleOf(`${rule.prefix}probe`), rule.prefix).toBe(rule.module);
    }
  });
});

describe("measureStorageUsage（用量统计）", () => {
  it("总字节 = 各模块之和，模块字节 = 该模块各键之和", () => {
    const entries = {
      "heming.memory.semantic.v1": "abc", // 3
      "heming.memory.working.v1": "de", // 2
      "heming.tasks.v1": "xyz", // 3
      "heming.token": "t", // 1 → 其它
    };
    const usage = measureStorageUsage(probeFrom(entries));

    expect(usage.totalBytes).toBe(9);
    expect(usage.totalKeys).toBe(4);
    expect(usage.entries.reduce((sum, e) => sum + e.bytes, 0)).toBe(usage.totalBytes);
    expect(usage.entries.reduce((sum, e) => sum + e.keys, 0)).toBe(usage.totalKeys);

    const memory = usage.entries.find((e) => e.module === "记忆");
    expect(memory).toEqual({ module: "记忆", bytes: 5, keys: 2 });
  });

  it("按字节数降序（界面直接照这个顺序渲染）", () => {
    const usage = measureStorageUsage(
      probeFrom({
        "heming.memory.semantic.v1": "x".repeat(100),
        "heming.tasks.v1": "x".repeat(300),
        "heming.token": "x".repeat(1),
      }),
    );
    const bytes = usage.entries.map((e) => e.bytes);
    expect(bytes).toEqual([...bytes].sort((a, b) => b - a));
    expect(usage.entries[0].module).toBe("任务");
  });

  it("字节数按 UTF-8 算，不是字符串长度（中文一字三字节）", () => {
    const text = "和鸣"; // 2 个字符、6 字节
    expect(text.length).toBe(2);
    expect(utf8Length(text)).toBe(6);

    const usage = measureStorageUsage(probeFrom({ "heming.memory.semantic.v1": text }));
    expect(usage.totalBytes).toBe(6);
  });

  it("每个键只读一次（消息缓存是解密后的正文，不该反复拉进内存）", () => {
    const getItem = vi.fn((k: string) => (k === "heming.msgCache.c1" ? "hello" : null));
    const probe = { keys: () => ["heming.msgCache.c1"], getItem };

    measureStorageUsage(probe);

    expect(getItem).toHaveBeenCalledTimes(1);
    expect(getItem).toHaveBeenCalledWith("heming.msgCache.c1");
  });

  it("onKey 旁路：同一次读取里把原始值交给调用方判断落盘形态，回调抛错不影响统计", () => {
    const seen: Array<[string, string | null]> = [];
    const usage = measureStorageUsage(probeFrom({ "heming.msgCache.c1": "hello" }), null, (key, raw) => {
      seen.push([key, raw]);
      if (key === "heming.msgCache.c1") throw new Error("回调坏了也不该影响统计");
    });

    expect(seen).toEqual([["heming.msgCache.c1", "hello"]]);
    expect(usage.totalBytes).toBe(5); // 回调抛错没有把统计带崩
  });

  it("某个键读不出来（抛错）不影响其它键", () => {
    const probe = {
      keys: () => ["heming.memory.semantic.v1", "heming.tasks.v1"],
      getItem: (k: string) => {
        if (k === "heming.tasks.v1") throw new Error("boom");
        return "abc";
      },
    };
    const usage = measureStorageUsage(probe);

    expect(usage.totalBytes).toBe(3);
    expect(usage.totalKeys).toBe(2); // 读不出来也算一个键（它在列表里）
  });

  it("list 本身抛错（隐私模式）→ 空用量，不抛", () => {
    const probe = {
      keys: () => {
        throw new Error("SecurityError");
      },
      getItem: () => null,
    };
    const usage = measureStorageUsage(probe);
    expect(usage.totalBytes).toBe(0);
    expect(usage.totalKeys).toBe(0);
    expect(usage.entries).toEqual([]);
  });

  it("默认用估算配额（5MB）并标记 quotaEstimated", () => {
    const usage = measureStorageUsage(probeFrom({}));
    expect(usage.quotaBytes).toBe(DEFAULT_QUOTA_BYTES);
    expect(usage.quotaEstimated).toBe(true);
  });

  it("传入实测配额 → quotaEstimated 为 false", () => {
    const usage = measureStorageUsage(probeFrom({}), 2 * 1024 * 1024);
    expect(usage.quotaBytes).toBe(2 * 1024 * 1024);
    expect(usage.quotaEstimated).toBe(false);
  });

  it("传入非法配额（0 / NaN / 负数）→ 回落到估算值", () => {
    for (const bad of [0, Number.NaN, -1]) {
      const usage = measureStorageUsage(probeFrom({}), bad);
      expect(usage.quotaBytes).toBe(DEFAULT_QUOTA_BYTES);
      expect(usage.quotaEstimated).toBe(true);
    }
  });
});

describe("探针实现", () => {
  it("probeFromKeys：用给定的键清单 + StorageLike 取值", () => {
    const map = new Map([["heming.tasks.v1", "abc"]]);
    const storage = {
      getItem: (k: string) => map.get(k) ?? null,
      setItem: () => {},
      removeItem: () => {},
    };
    const usage = measureStorageUsage(probeFromKeys(storage, ["heming.tasks.v1"]));
    expect(usage.totalBytes).toBe(3);
  });

  it("probeFromKeys：getItem 抛错时按缺失处理", () => {
    const storage = {
      getItem: () => {
        throw new Error("boom");
      },
      setItem: () => {},
      removeItem: () => {},
    };
    expect(() => measureStorageUsage(probeFromKeys(storage, ["heming.tasks.v1"]))).not.toThrow();
  });

  it("probeOfStorage：用 length + key(i) 列键名，不碰值", () => {
    const values: Record<string, string> = { a: "1", b: "22" };
    const store = {
      get length() {
        return Object.keys(values).length;
      },
      key: (i: number) => Object.keys(values)[i] ?? null,
      getItem: (k: string) => values[k] ?? null,
    } as unknown as Storage;
    const usage = measureStorageUsage(probeOfStorage(store));
    expect(usage.totalBytes).toBe(3);
  });

  it("browserProbe：在没有 localStorage 的环境里退化为空探针，不抛", () => {
    // jsdom 一般有 localStorage；这里只钉「绝不抛」这条契约。
    expect(() => measureStorageUsage(browserProbe())).not.toThrow();
  });
});

describe("probeQuotaBytes（实测配额）", () => {
  /** 列出假 storage 里的全部键名（断言探针清理干净用）。 */
  function storeKeys(store: Storage): string[] {
    const out: string[] = [];
    for (let i = 0; i < store.length; i += 1) {
      const key = store.key(i);
      if (key != null) out.push(key);
    }
    return out;
  }

  /** 造一个假的 DOM Storage：容量上限由 quota 决定，写超就抛 QuotaExceededError。 */
  function fakeStorage(quotaBytes: number, initial: Record<string, string> = {}) {
    const map = new Map(Object.entries(initial));
    let used = () => [...map.values()].reduce((n, v) => n + utf8Length(v), 0);
    return {
      get length() {
        return map.size;
      },
      key: (i: number) => [...map.keys()][i] ?? null,
      getItem: (k: string) => map.get(k) ?? null,
      setItem: (k: string, v: string) => {
        const withoutOld = map.has(k) ? utf8Length(map.get(k) as string) : 0;
        if (used() - withoutOld + utf8Length(v) > quotaBytes) {
          const err = new Error("quota") as Error & { name: string; code: number };
          err.name = "QuotaExceededError";
          err.code = 22;
          throw err;
        }
        map.set(k, v);
      },
      removeItem: (k: string) => {
        map.delete(k);
      },
    } as unknown as Storage;
  }

  it("探测成功：返回「已用 + 写进去的」总量，且探针键被删掉", () => {
    const store = fakeStorage(3 * 1024 * 1024, { "heming.token": "abc" });
    const quota = probeQuotaBytes(store);

    // 已用 3 字节 + 写满 12 个 256KB 块（第 13 块超限）
    expect(quota).not.toBeNull();
    expect(quota!).toBeGreaterThanOrEqual(3 * 1024 * 1024 - 256 * 1024);
    expect(quota!).toBeLessThanOrEqual(3 * 1024 * 1024 + 3);
    // 探针键不能留下（分块写入 ⇒ 每个块一个键，全部要清）
    const leftovers = storeKeys(store).filter((k) => k.startsWith("heming.storage.probe"));
    expect(leftovers).toEqual([]);
  });

  it("setItem 抛非配额错误（隐私模式）→ 返回 null 不抛", () => {
    const store = {
      get length() {
        return 0;
      },
      key: () => null,
      getItem: () => null,
      setItem: () => {
        throw new Error("SecurityError");
      },
      removeItem: () => {},
    } as unknown as Storage;
    expect(probeQuotaBytes(store)).toBeNull();
  });

  it("配额已被现有数据占满 → 直接回落 null（不白写几 MB）", () => {
    // 已用 >= 5MB 时，探测前就放弃。
    const store = fakeStorage(6 * 1024 * 1024, { "heming.msgCache.c1": "x".repeat(5 * 1024 * 1024) });
    expect(probeQuotaBytes(store)).toBeNull();
  });
});
