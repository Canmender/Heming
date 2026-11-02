import { describe, expect, it } from "vitest";
import {
  DEFAULT_FILE_ROOTS,
  FILE_ROOTS_KEY,
  FileRootsStore,
  MAX_FILE_ROOTS,
  defaultRootName,
  isAcceptableRootPath,
  normalizeRootsConfig,
} from "./roots.js";
import type { StorageLike } from "../memory/types.js";

/** 内存存储（与 localStorage 同接口，便于断言「写进去的是什么」）。 */
function memoryStorage(seed?: Record<string, string>): StorageLike & { dump(): Record<string, string> } {
  const map = new Map<string, string>(Object.entries(seed ?? {}));
  return {
    getItem: (k) => map.get(k) ?? null,
    setItem: (k, v) => {
      map.set(k, v);
    },
    removeItem: (k) => {
      map.delete(k);
    },
    dump: () => Object.fromEntries(map),
  };
}

const ROOT = "D:/Obsidian/学院事务";

describe("可写根存储", () => {
  it("缺省没有任何根（装好默认全关，与 MCP 同口径）", () => {
    const store = new FileRootsStore(memoryStorage());
    expect(store.get()).toEqual({ roots: [], outOfRoot: "ask" });
    expect(store.writeRoots()).toEqual([]);
  });

  it("添加一条根：自动取目录名做根名", () => {
    const store = new FileRootsStore(memoryStorage());
    const result = store.add({ path: ROOT, mode: "write" });
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.root).toEqual({ name: "学院事务", path: ROOT, mode: "write" });
    expect(store.writeRoots()).toHaveLength(1);
  });

  it("同名自动加后缀，同路径拒绝重复添加", () => {
    const store = new FileRootsStore(memoryStorage());
    store.add({ path: "D:/甲/笔记", mode: "write" });
    const second = store.add({ path: "D:/乙/笔记", mode: "write" });
    expect(second.ok).toBe(true);
    if (!second.ok) return;
    expect(second.root.name).toBe("笔记-2");
    const dup = store.add({ path: "D:\\甲\\笔记\\", mode: "read" });
    expect(dup.ok).toBe(false);
  });

  it("拒绝相对路径、盘符根、NUL、超长", () => {
    const store = new FileRootsStore(memoryStorage());
    for (const path of ["相对/路径", "D:/", "/", `D:/a\u0000b`, `D:/${"x".repeat(400)}`]) {
      expect(store.add({ path, mode: "write" }).ok).toBe(false);
    }
    expect(store.roots()).toHaveLength(0);
  });

  it("切换 mode、删除、清空", () => {
    const store = new FileRootsStore(memoryStorage());
    store.add({ path: ROOT, mode: "write" });
    store.setMode(ROOT, "read");
    expect(store.roots()[0].mode).toBe("read");
    expect(store.writeRoots()).toHaveLength(0);
    store.remove(ROOT);
    expect(store.roots()).toHaveLength(0);
    store.add({ path: ROOT, mode: "write" });
    store.clear();
    expect(store.roots()).toHaveLength(0);
  });

  it("越界处理方式可切换", () => {
    const store = new FileRootsStore(memoryStorage());
    store.setOutOfRoot("reject");
    expect(store.get().outOfRoot).toBe("reject");
    store.setOutOfRoot("ask");
    expect(store.get().outOfRoot).toBe("ask");
  });
});

describe("根配置的读回规整（坏数据不清空全部）", () => {
  it("坏条目逐条丢弃，好的照样用", () => {
    const config = normalizeRootsConfig({
      roots: [
        { name: "好", path: "D:/好", mode: "write" },
        { name: "", path: "D:/无名", mode: "read" }, // 名字空：用目录名兜底
        { name: "坏模式", path: "D:/x", mode: "full" },
        { name: "相对", path: "相对", mode: "write" },
        { name: "盘符根", path: "D:/", mode: "write" },
        null,
        "字符串",
      ],
      outOfRoot: "乱填",
    });
    expect(config.roots.map((r) => r.name)).toEqual(["好", "无名"]);
    expect(config.outOfRoot).toBe("ask");
  });

  it("同一路径重复出现只留第一条", () => {
    const config = normalizeRootsConfig({
      roots: [
        { name: "甲", path: "D:/库", mode: "write" },
        { name: "乙", path: "D:\\库\\", mode: "read" },
      ],
    });
    expect(config.roots).toHaveLength(1);
    expect(config.roots[0]).toMatchObject({ name: "甲", mode: "write" });
  });

  it(`最多 ${MAX_FILE_ROOTS} 条`, () => {
    const roots = Array.from({ length: MAX_FILE_ROOTS + 5 }, (_, i) => ({
      name: `r${i}`,
      path: `D:/库${i}`,
      mode: "write" as const,
    }));
    expect(normalizeRootsConfig({ roots }).roots).toHaveLength(MAX_FILE_ROOTS);
  });

  it("读存储损坏时回落默认（没有根）", () => {
    const store = new FileRootsStore(memoryStorage({ [FILE_ROOTS_KEY]: "{ 不是 json" }));
    expect(store.get()).toEqual(DEFAULT_FILE_ROOTS);
  });

  it("写侧同样被夹：盘符根与坏 mode 不会落库", () => {
    const storage = memoryStorage();
    const store = new FileRootsStore(storage);
    store.set({
      roots: [
        { name: "盘符根", path: "D:/", mode: "write" },
        { name: "好", path: "D:/好", mode: "write" },
      ],
      outOfRoot: "ask",
    });
    expect(store.roots()).toHaveLength(1);
    expect(storage.dump()[FILE_ROOTS_KEY]).not.toContain("D:/\"");
  });
});

describe("根路径判定与默认命名", () => {
  it("isAcceptableRootPath 只接受绝对且非盘符根", () => {
    expect(isAcceptableRootPath("D:/Obsidian")).toBe(true);
    expect(isAcceptableRootPath("D:/")).toBe(false);
    expect(isAcceptableRootPath("Obsidian")).toBe(false);
    expect(isAcceptableRootPath("")).toBe(false);
  });

  it("defaultRootName 取最后一段目录名", () => {
    expect(defaultRootName("D:/Obsidian/学院事务")).toBe("学院事务");
    expect(defaultRootName("D:/Obsidian/学院事务/")).toBe("学院事务");
  });
});
