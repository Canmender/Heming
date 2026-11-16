import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

/**
 * 溢出内容的「重启后还能读」（d.190）。
 *
 * 这里不用 `resetSpills()` 模拟重启——它会连本机那份一起删掉。真正的重启是
 * 「内存没了、localStorage 还在」，所以用 `vi.resetModules()` + 重新 `import()`
 * 拿一份全新的模块实例，这才是要测的东西。
 */
async function freshStore() {
  vi.resetModules();
  return await import("./store.js");
}

describe("溢出内容跨重启（d.190）", () => {
  beforeEach(() => {
    localStorage.clear();
  });

  afterEach(() => {
    localStorage.clear();
  });

  it("重启后仍能读回之前那条溢出（历史里的 spill-N 引用对得上）", async () => {
    const store = await freshStore();
    store.resetSpills();
    const { id } = store.spillText("HEAD" + "x".repeat(20000) + "TAIL", "run_command");
    expect(id).toBe("spill-1");

    const afterRestart = await freshStore();
    const got = afterRestart.readSpill(id, 0, 4);
    expect(got.ok).toBe(true);
    if (!got.ok) return;
    expect(got.text).toBe("HEAD");
    expect(got.total).toBe(20008);

    const tail = afterRestart.readSpill(id, 20004, 100);
    expect(tail.ok).toBe(true);
    if (!tail.ok) return;
    expect(tail.text).toBe("TAIL");
  });

  it("重启后新产生的 handle 不会撞号（序号从已有最大值继续）", async () => {
    const store = await freshStore();
    store.resetSpills();
    store.spillText("a".repeat(9000));
    store.spillText("b".repeat(9000));

    const afterRestart = await freshStore();
    expect(afterRestart.listSpills().map((s) => s.id)).toEqual(["spill-1", "spill-2"]);
    expect(afterRestart.spillText("c".repeat(9000)).id).toBe("spill-3");
  });

  it("只保最近 600K 字符：更早的那条重启后如实报「不在了」", async () => {
    const store = await freshStore();
    store.resetSpills();
    const old = store.spillText("O".repeat(400_000)).id;
    const recent = store.spillText("R".repeat(400_000)).id;

    const afterRestart = await freshStore();
    expect(afterRestart.listSpills().map((s) => s.id)).toEqual([recent]);
    const missing = afterRestart.readSpill(old, 0, 10);
    expect(missing.ok).toBe(false);
    if (missing.ok) return;
    expect(missing.error_code).toBe("spill-not-found");
    expect(missing.hint).toContain("别在这里重试"); // 不是返回空串假装成功
  });

  it("本机那份坏了就丢掉，不影响功能", async () => {
    localStorage.setItem("heming.spill.v1", "{不是 json");
    const store = await freshStore();
    store.resetSpills();
    localStorage.setItem("heming.spill.v1", "{不是 json");

    const afterRestart = await freshStore();
    expect(afterRestart.listSpills()).toEqual([]);
    expect(localStorage.getItem("heming.spill.v1")).toBeNull();
    // 坏数据之后照常能存能读
    const { id } = afterRestart.spillText("z".repeat(9000));
    expect(afterRestart.readSpill(id, 0, 1).ok).toBe(true);
  });

  it("重启后继续写入：淘汰的仍是最旧那条（hydrate 的顺序不能反）", async () => {
    const store = await freshStore();
    store.resetSpills();
    // 每个都小于读回上限、合起来不超 600K，能整批落本机
    for (let i = 0; i < 40; i += 1) store.spillText(`第${i}条`.padEnd(2000, "·"));

    const afterRestart = await freshStore();
    expect(afterRestart.listSpills()).toHaveLength(40);
    afterRestart.spillText("最新一条".padEnd(2000, "·"));
    const ids = afterRestart.listSpills().map((s) => s.id);
    expect(ids).toHaveLength(40);
    expect(ids).not.toContain("spill-1"); // 最旧的被淘汰
    expect(ids).toContain("spill-41"); // 最新的还在
  });

  it("写不进本机（配额满）时只退化成内存，不抛异常", async () => {
    const store = await freshStore();
    store.resetSpills();
    const setItem = vi.spyOn(Storage.prototype, "setItem").mockImplementation(() => {
      throw new DOMException("QuotaExceededError", "QuotaExceededError");
    });
    try {
      const { id } = store.spillText("q".repeat(9000));
      // 本进程内照常可读
      expect(store.readSpill(id, 0, 1).ok).toBe(true);
    } finally {
      setItem.mockRestore();
    }
  });
});
