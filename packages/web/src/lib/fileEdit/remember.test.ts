import { describe, expect, it } from "vitest";
import { classifyCall } from "../hitl/classify.js";
import { HitlPolicyStore } from "../hitl/policy.js";
import type { StorageLike } from "../memory/types.js";
import type { FileRoot } from "./paths.js";
import { canRememberCall, prefixesOfCall, rememberDecision } from "./remember.js";

const ROOT: FileRoot = { name: "库", path: "D:/库", mode: "write" };

/** 内存存储。 */
function memoryStorage(): StorageLike {
  const map = new Map<string, string>();
  return {
    getItem: (k) => map.get(k) ?? null,
    setItem: (k, v) => {
      map.set(k, v);
    },
    removeItem: (k) => {
      map.delete(k);
    },
  };
}

const storeWith = (roots: FileRoot[]) => new HitlPolicyStore(memoryStorage(), { roots: () => roots });
const callOf = (name: string, args: unknown) => classifyCall(name, JSON.stringify(args));

const patchCall = (path = "notes/a.md") =>
  callOf("file_patch", {
    patch: ["*** Begin Patch", `*** Update File: ${path}`, "@@", "-旧", "+新", "*** End Patch"].join("\n"),
  });

describe("记住本次选择", () => {
  it("普通工具沿用「工具 + 资源」老口径", () => {
    const store = storeWith([]);
    const call = callOf("fs__write", { path: "notes/a.md" });
    const outcome = rememberDecision(store, call, "allow", { id: "a1" }, { roots: [ROOT] });
    expect(outcome.remembered).toBe(true);
    expect(store.rules()).toEqual([
      expect.objectContaining({ tool: "fs__write", resource: "notes/a.md", effect: "allow", agentId: "a1" }),
    ]);
  });

  it("file_patch 按目录前缀写规则（不写整个工具放行）", () => {
    const store = storeWith([ROOT]);
    const outcome = rememberDecision(store, patchCall(), "allow", { id: "a1" }, { roots: [ROOT] });
    expect(outcome).toMatchObject({ remembered: true, prefixes: ["D:/库/notes/"] });
    const rules = store.rules();
    expect(rules).toHaveLength(1);
    expect(rules[0]).toMatchObject({ tool: "file_patch", resource: "D:/库/notes/", effect: "allow" });
    // 红线：绝不出现通配允许
    expect(rules.some((r) => r.resource === "*")).toBe(false);
  });

  it("跨目录补丁写多条前缀，同一目录只留一条", () => {
    const store = storeWith([ROOT]);
    const patch = [
      "*** Begin Patch",
      "*** Add File: notes/a.md",
      "+甲",
      "*** Add File: notes/b.md",
      "+乙",
      "*** Add File: 草稿/c.md",
      "+丙",
      "*** End Patch",
    ].join("\n");
    const outcome = rememberDecision(store, callOf("file_patch", { patch }), "allow", { id: "a1" }, { roots: [ROOT] });
    expect(outcome.remembered).toBe(true);
    expect(store.rules().map((r) => r.resource).sort()).toEqual(["D:/库/notes/", "D:/库/草稿/"]);
  });

  it("目标在可写根之外时不记忆（返回 remembered:false，不落任何规则）", () => {
    const store = storeWith([ROOT]);
    // 根不存在于清单里 → 解析不出目标
    const call = callOf("file_patch", {
      patch: "*** Begin Patch\n*** Add File: a.md\n+x\n*** End Patch",
      root: "不存在",
    });
    const outcome = rememberDecision(store, call, "allow", { id: "a1" }, { roots: [ROOT] });
    expect(outcome.remembered).toBe(false);
    expect(store.rules()).toEqual([]);
  });

  it("deny 同样按前缀记（拒绝一个目录的编辑）", () => {
    const store = storeWith([ROOT]);
    rememberDecision(store, patchCall(), "deny", { id: "a1" }, { roots: [ROOT] });
    expect(store.rules()[0]).toMatchObject({ tool: "file_patch", resource: "D:/库/notes/", effect: "deny" });
  });

  it("canRememberCall：能归纳出前缀才允许显示「记住」", () => {
    expect(canRememberCall(patchCall(), { roots: [ROOT] })).toBe(true);
    expect(canRememberCall({ name: "wiki_read", argsJson: "{}" }, { roots: [] })).toBe(true);
    expect(
      canRememberCall(
        { name: "file_patch", argsJson: JSON.stringify({ patch: "坏的" }) },
        { roots: [ROOT] },
      ),
    ).toBe(false);
  });

  it("prefixesOfCall 回显将记录的目录", () => {
    expect(prefixesOfCall(patchCall(), { roots: [ROOT] })).toEqual(["D:/库/notes/"]);
  });
});

