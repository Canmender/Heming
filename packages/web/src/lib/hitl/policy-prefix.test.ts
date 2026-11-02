/**
 * HITL 规则的路径前缀语义（规格 §7）。
 *
 * 与既有 `policy.test.ts` 的分工：那边钉的是「精确匹配 + 通配 + 危险恒问」的老口径，
 * 这里只钉新增的前缀语义与文件补丁的特殊处理，避免把老用例改得看不清原意。
 */

import { describe, expect, it } from "vitest";
import { classifyCall } from "./classify.js";
import { HitlPolicyStore, MAX_HITL_RULES, type HitlPolicy } from "./policy.js";
import type { HitlCall } from "./types.js";
import type { StorageLike } from "../memory/types.js";
import type { FileRoot } from "../fileEdit/paths.js";

const ROOT: FileRoot = { name: "库", path: "D:/Obsidian/学院事务", mode: "write" };
const READ_ROOT: FileRoot = { name: "参考", path: "D:/参考", mode: "read" };

const GUARDED: HitlPolicy = { mode: "guarded", floor: "read", scope: "global" };
const STRICT: HitlPolicy = { mode: "strict", floor: "read", scope: "global" };

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
const callOf = (name: string, args: unknown): HitlCall => classifyCall(name, JSON.stringify(args));

/** 造一个改指定文件的 file_patch 调用。 */
function patchCall(path: string): HitlCall {
  return callOf("file_patch", {
    patch: ["*** Begin Patch", `*** Update File: ${path}`, "@@", "-旧", "+新", "*** End Patch"].join("\n"),
  });
}

/** 带删除语义的补丁。 */
function deletePatchCall(path: string): HitlCall {
  return callOf("file_patch", { patch: ["*** Begin Patch", `*** Delete File: ${path}`, "*** End Patch"].join("\n") });
}

describe("规则前缀匹配", () => {
  it("前缀规则覆盖目录下任意文件（老口径无法表达）", () => {
    const store = storeWith([ROOT]);
    store.rememberRule("file_patch", "D:/Obsidian/学院事务/", "allow");
    expect(store.ruleFor(patchCall("a.md"))).toBe("allow");
    expect(store.ruleFor(patchCall("notes/深层/b.md"))).toBe("allow");
  });

  it("精确规则仍只覆盖那一个文件（前缀是精确的特例，不是替代）", () => {
    const store = storeWith([ROOT]);
    store.rememberRule("file_patch", "D:/Obsidian/学院事务/a.md", "allow");
    expect(store.ruleFor(patchCall("a.md"))).toBe("allow");
    expect(store.ruleFor(patchCall("b.md"))).toBeNull();
  });

  it("同前缀不同目录不算命中", () => {
    const store = storeWith([ROOT]);
    store.rememberRule("file_patch", "D:/Obsidian/学院事务/笔记/", "allow");
    expect(store.ruleFor(patchCall("笔记/a.md"))).toBe("allow");
    expect(store.ruleFor(patchCall("笔记二/a.md"))).toBeNull();
  });

  it("归一化后能命中：用户写反斜杠、大小写、尾斜杠都能匹配", () => {
    const store = storeWith([ROOT]);
    store.rememberRule("file_patch", "d:\\obsidian\\学院事务\\", "allow");
    expect(store.ruleFor(patchCall("notes/a.md"))).toBe("allow");
  });

  it("多目标补丁：任一目标命中 deny 即整份拒绝，全被 allow 覆盖才放行", () => {
    const store = storeWith([ROOT]);
    store.rememberRule("file_patch", "D:/Obsidian/学院事务/", "allow");
    store.rememberRule("file_patch", "D:/Obsidian/学院事务/私人/", "deny");
    const mixed: HitlCall = callOf("file_patch", {
      patch: [
        "*** Begin Patch",
        "*** Add File: 公开.md",
        "+甲",
        "*** Add File: 私人/秘密.md",
        "+乙",
        "*** End Patch",
      ].join("\n"),
    });
    expect(store.ruleFor(mixed)).toBe("deny");
    // 只有公开那一个文件时，allow 前缀覆盖 → 放行
    const publicOnly: HitlCall = callOf("file_patch", {
      patch: ["*** Begin Patch", "*** Add File: 公开.md", "+甲", "*** End Patch"].join("\n"),
    });
    expect(store.ruleFor(publicOnly)).toBe("allow");
  });

  it("通配 allow 不覆盖 file_patch（不能整个工具放行）", () => {
    const store = storeWith([ROOT]);
    store.rememberRule("file_patch", "*", "allow"); // 这条会被策略层拒收
    expect(store.rules()).toEqual([]);
    expect(store.ruleFor(patchCall("a.md"))).toBeNull();
  });

  it("deny 优先：任一目标命中拒绝规则即整份拒绝", () => {
    const store = storeWith([ROOT]);
    store.rememberRule("file_patch", "D:/Obsidian/学院事务/", "allow");
    store.rememberRule("file_patch", "D:/Obsidian/学院事务/私人/", "deny");
    expect(store.ruleFor(patchCall("a.md"))).toBe("allow");
    const mixed: HitlCall = callOf("file_patch", {
      patch: [
        "*** Begin Patch",
        "*** Add File: 公开.md",
        "+甲",
        "*** Add File: 私人/秘密.md",
        "+乙",
        "*** End Patch",
      ].join("\n"),
    });
    expect(store.ruleFor(mixed)).toBe("deny");
  });

  it("含删除/改名的补丁不吃目录允许规则（删除不可逆，仍要问）", () => {
    const store = storeWith([ROOT]);
    store.rememberRule("file_patch", "D:/Obsidian/学院事务/", "allow");
    expect(store.ruleFor(patchCall("notes/a.md"))).toBe("allow");
    expect(store.ruleFor(deletePatchCall("notes/a.md"))).toBeNull();
    const movePatch: HitlCall = callOf("file_patch", {
      patch: [
        "*** Begin Patch",
        "*** Update File: notes/a.md",
        "*** Move to: notes/b.md",
        "@@",
        "-旧",
        "+新",
        "*** End Patch",
      ].join("\n"),
    });
    expect(store.ruleFor(movePatch)).toBeNull();
  });

  it("规则仍按工具区分：别的工具的同路径规则不生效", () => {
    const store = storeWith([ROOT]);
    store.rememberRule("fs__other", "D:/Obsidian/学院事务/", "allow");
    expect(store.ruleFor(patchCall("a.md"))).toBeNull();
  });

  it("危险工具的通配 allow 依旧无效（红线不变）", () => {
    const store = storeWith([]);
    const danger = callOf("mcp__delete_file", { path: "a.md" });
    expect(danger.risk).toBe("danger");
    store.rememberRule("mcp__delete_file", "*", "allow");
    expect(store.ruleFor(danger)).toBeNull();
    store.rememberRule("mcp__delete_file", "a", "deny");
    expect(store.ruleFor({ ...danger, argsJson: JSON.stringify({ path: "a" }) })).toBe("deny");
  });
});

describe("规则条数上限不变", () => {
  it(`rememberRules 也受 ${MAX_HITL_RULES} 条上限约束`, () => {
    const store = storeWith([{ name: "库", path: "D:/库", mode: "write" }]);
    const resources = Array.from({ length: MAX_HITL_RULES + 10 }, (_, i) => `D:/库/子${i}/`);
    store.rememberRules("file_patch", resources, "allow");
    expect(store.rules()).toHaveLength(MAX_HITL_RULES);
  });

  it("rememberRules 去重、拒绝通配", () => {
    const store = storeWith([ROOT]);
    store.rememberRules("file_patch", ["D:/库/甲/", "D:/库/甲/", "d:/库/甲/", "*"], "allow");
    const rules = store.rules();
    expect(rules).toHaveLength(1);
    expect(rules[0].resource).toBe("D:/库/甲/");
  });
});

describe("文件补丁的免问判定（AutoApprove）", () => {
  it("全在可写根内且无删除 → 免问", () => {
    const store = storeWith([ROOT]);
    expect(store.allowed(patchCall("notes/a.md"), GUARDED)).toBe("pass");
  });

  it("含删除 → 必须问（删除不可逆）", () => {
    const store = storeWith([ROOT]);
    expect(store.allowed(deletePatchCall("notes/a.md"), GUARDED)).toBe("ask");
  });

  it("越界/解析不出来时不打扰用户（pass），工具层按原因拒绝", () => {
    // 注意：file_patch 的路径必须相对根，所以「越界」在解析阶段就失败；
    // 此时 `patchVerdict` 返回 auto（一定写不进磁盘），由工具层给出精确文案。
    const store = storeWith([ROOT]);
    const escape = callOf("file_patch", {
      patch: ["*** Begin Patch", "*** Add File: ../逃逸.md", "+x", "*** End Patch"].join("\n"),
    });
    expect(store.allowed(escape, GUARDED)).toBe("pass");
    // 没有任何可写根时同理：工具根本不可见，这里不弹窗
    const readOnlyStore = storeWith([READ_ROOT]);
    expect(readOnlyStore.allowed(escape, GUARDED)).toBe("pass");
  });

  it("strict 档全部询问（连免问判定也不生效）", () => {
    const store = storeWith([ROOT]);
    expect(store.allowed(patchCall("notes/a.md"), STRICT)).toBe("ask");
  });

  it("补丁格式错时不打扰用户（pass），反正写不进去", () => {
    const store = storeWith([ROOT]);
    const broken = callOf("file_patch", { patch: "不是补丁" });
    expect(store.allowed(broken, GUARDED)).toBe("pass");
  });
});
