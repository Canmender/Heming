import { describe, expect, it } from "vitest";
import {
  DEFAULT_FILE_ROOTS,
  DEFAULT_WORKSPACE_ROOT_NAME,
  FILE_ROOTS_KEY,
  FileRootsStore,
  MAX_FILE_ROOTS,
  WORKSPACE_ROOT_NAME,
  activeWorkspace,
  currentFileRoots,
  defaultRootName,
  fileRootsFor,
  fileRootsStore,
  isAcceptableRootPath,
  mergeWorkspaceRoot,
  normalizeRootsConfig,
  setActiveWorkspace,
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

describe("会话工作区 → 隐式写根（d.153 开箱可写）", () => {
  const MANUAL = { name: "手动", path: "D:/手动", mode: "write" as const };

  it("没有工作区：根清单原样返回（未分组会话不自动开放目录）", () => {
    expect(mergeWorkspaceRoot([MANUAL], undefined)).toEqual([MANUAL]);
    expect(mergeWorkspaceRoot([MANUAL], "")).toEqual([MANUAL]);
    expect(mergeWorkspaceRoot([MANUAL], "   ")).toEqual([MANUAL]);
  });

  it("有工作区：派生根排第一位、mode=write、名字叫「工作区」", () => {
    const merged = mergeWorkspaceRoot([MANUAL], "D:\\项目\\和鸣");
    expect(merged).toHaveLength(2);
    expect(merged[0]).toEqual({ name: WORKSPACE_ROOT_NAME, path: "D:/项目/和鸣", mode: "write" });
    expect(merged[1]).toEqual(MANUAL);
  });

  it("同路径已有手动配置根：原样保留（不悄悄把只读升级成可写）", () => {
    const readonly = { name: "只读的同一目录", path: "D:/项目/和鸣", mode: "read" as const };
    const merged = mergeWorkspaceRoot([readonly], "D:/项目/和鸣/");
    expect(merged).toEqual([readonly]);
  });

  it("非法路径（盘符根 / 相对路径）：不派生，也不吞掉已有根", () => {
    expect(mergeWorkspaceRoot([MANUAL], "D:/")).toEqual([MANUAL]);
    expect(mergeWorkspaceRoot([MANUAL], "项目/和鸣")).toEqual([MANUAL]);
  });

  it("手动根里已有同名「工作区」：自动根改名避让（工具参数 root 才能唯一）", () => {
    const sameName = { name: "工作区", path: "D:/别的", mode: "write" as const };
    const merged = mergeWorkspaceRoot([sameName], "D:/项目/和鸣");
    expect(merged[0]?.name).toBe("工作区-2");
    expect(merged[0]?.path).toBe("D:/项目/和鸣");
  });
});

describe("activeWorkspace / currentFileRoots（四个调用方共用一份根口径）", () => {
  it("setActiveWorkspace 空值/纯空白 = 未分组会话，状态被清空", () => {
    setActiveWorkspace("D:/项目/和鸣");
    expect(activeWorkspace()).toBe("D:/项目/和鸣");
    setActiveWorkspace(null);
    expect(activeWorkspace()).toBeUndefined();
    setActiveWorkspace("   ");
    expect(activeWorkspace()).toBeUndefined();
  });

  it("currentFileRoots = 手动根 + 当前工作区（工作区第一位，且不落 localStorage）", () => {
    fileRootsStore.clear();
    fileRootsStore.add({ path: "D:/手动", mode: "write" });
    setActiveWorkspace("D:/项目/和鸣");
    const roots = currentFileRoots();
    expect(roots[0]).toEqual({ name: WORKSPACE_ROOT_NAME, path: "D:/项目/和鸣", mode: "write" });
    expect(roots.map((r) => r.path)).toEqual(["D:/项目/和鸣", "D:/手动"]);
    // 派生根不落盘：设置区仍只有用户手填的那一条
    expect(fileRootsStore.roots().map((r) => r.path)).toEqual(["D:/手动"]);
    setActiveWorkspace(undefined);
    fileRootsStore.clear();
  });
});

describe("未分组会话的默认工作区兜底（文档\\和鸣）", () => {
  /** 装上桌面桥（只带 defaultRootPath，够 currentFileRoots 用）。 */
  function withBridge(defaultRootPath: string | null) {
    (window as unknown as { __heming_files?: unknown }).__heming_files = {
      read: async () => ({ ok: true, content: "", bytes: 0 }),
      write: async () => ({ ok: true }),
      defaultRootPath,
    };
  }

  function cleanBridge() {
    delete (window as unknown as { __heming_files?: unknown }).__heming_files;
  }

  it("没有工作区也没有手动根时，默认工作区成为唯一写根", () => {
    setActiveWorkspace(undefined);
    fileRootsStore.clear();
    withBridge("C:\\Users\\x\\Documents\\和鸣");
    expect(fileRootsFor(undefined)).toEqual([
      { name: DEFAULT_WORKSPACE_ROOT_NAME, path: "C:/Users/x/Documents/和鸣", mode: "write" },
    ]);
    cleanBridge();
  });

  it("用户配过根（哪怕只有只读根）就不塞默认写根——尊重「只让它读」", () => {
    setActiveWorkspace(undefined);
    fileRootsStore.clear();
    fileRootsStore.add({ path: "D:/资料", mode: "read" });
    withBridge("C:/Users/x/Documents/和鸣");
    expect(fileRootsFor(undefined).map((r) => r.path)).toEqual(["D:/资料"]);
    cleanBridge();
    fileRootsStore.clear();
  });

  it("有会话工作区时用工作区，不叠加默认根", () => {
    fileRootsStore.clear();
    withBridge("C:/Users/x/Documents/和鸣");
    const roots = fileRootsFor("D:/项目/和鸣");
    expect(roots.map((r) => r.path)).toEqual(["D:/项目/和鸣"]);
    cleanBridge();
  });

  it("老安装包没有 defaultRootPath：未分组会话就是没有根（不编造路径）", () => {
    setActiveWorkspace(undefined);
    fileRootsStore.clear();
    cleanBridge();
    expect(fileRootsFor(undefined)).toEqual([]);
    withBridge(null);
    expect(fileRootsFor(undefined)).toEqual([]);
    cleanBridge();
  });
});
