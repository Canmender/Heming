/**
 * 工具桥合并的测试。
 *
 * ★ 为什么这个文件必须存在：`mergeToolBridges` 里 `execute` 与 `meta` 是
 * **两套独立的路由**，但它们必须指向**同一个桥**——
 *
 *   闸门问 A 桥「这个工具多危险」，执行时却走了 B 桥
 *   → 问错了人 = 风险判定对不上实际执行者
 *   → B 桥里那个真正危险的操作被当成 A 桥的只读工具放行
 *
 * 这是一条**安全不变量**，靠人眼 review 很难持续保证，所以必须有测试钉住。
 */

import { describe, it, expect } from "vitest";
import { mergeToolBridges } from "./merge.js";
import type { ToolBridge } from "../agentStream.js";

/** 造一个假桥：声明给定工具名，meta 按名字返回风险标注。 */
function makeBridge(
  names: string[],
  risks: Record<string, "read" | "write" | "danger"> = {},
): ToolBridge {
  return {
    tools: names.map((name) => ({
      type: "function",
      function: { name, description: name, parameters: { type: "object" } },
    })),
    execute: async (call) => ({ text: `执行了 ${call.name}`, ok: true }),
    meta: (name) => (risks[name] ? { risk: risks[name] } : undefined),
  };
}

describe("mergeToolBridges", () => {
  it("全空返回 null（编排层据此走无工具路径）", () => {
    expect(mergeToolBridges()).toBeNull();
    expect(mergeToolBridges(null, null)).toBeNull();
  });

  it("只有一个非空桥时原样返回（不包装）", () => {
    const only = makeBridge(["a"], { a: "read" });
    const merged = mergeToolBridges(null, only, null);
    expect(merged).toBe(only);
  });

  it("工具名不撞前缀时先 self 后 MCP 的顺序天然正确", () => {
    const self = makeBridge(["self_memory_write"], { self_memory_write: "write" });
    const mcp = makeBridge(["srv__read_file"], { srv__read_file: "read" });
    const merged = mergeToolBridges(self, mcp);
    expect(merged?.tools.map((t) => (t as { function: { name: string } }).function.name)).toEqual([
      "self_memory_write",
      "srv__read_file",
    ]);
  });

  it("执行按「谁声明了这个名字」路由", async () => {
    const self = makeBridge(["self_memory_write"]);
    const mcp = makeBridge(["srv__read_file"]);
    const merged = mergeToolBridges(self, mcp);
    const r = await merged!.execute({ name: "srv__read_file", arguments: "{}" });
    expect(r.text).toBe("执行了 srv__read_file");
  });

  it("谁都没声明的名字给出清楚的话，不抛异常", async () => {
    const merged = mergeToolBridges(makeBridge(["a"]), makeBridge(["b"]));
    const r = await merged!.execute({ name: "不存在", arguments: "{}" });
    expect(r.ok).toBe(false);
    expect(r.text).toContain("未知工具");
  });


  it("★ 执行时把 opts（AbortSignal）透传给真正执行的桥", async () => {
    // 多提供者合并是常态（MCP + 内置同时在线）。漏传 opts 的话，
    // 用户点了中断，合并后的桥仍让底层工具继续跑。
    const seen: (AbortSignal | undefined)[] = [];
    const a: ToolBridge = {
      tools: [{ type: "function", function: { name: "a" } }],
      execute: async (_call, opts) => {
        seen.push(opts?.signal);
        return { text: "ok", ok: true };
      },
    };
    const b: ToolBridge = {
      tools: [{ type: "function", function: { name: "b" } }],
      execute: async () => ({ text: "ok", ok: true }),
    };
    const controller = new AbortController();
    const merged = mergeToolBridges(a, b);
    await merged!.execute({ name: "a", arguments: "{}" }, { signal: controller.signal });
    expect(seen[0]).toBe(controller.signal);
  });

  // ★ 下面这条是本文件存在的核心理由
  it("★ meta 与 execute 路由到同一个桥（问的桥必须就是执行的桥）", () => {
    const self = makeBridge(["self_memory_write"], { self_memory_write: "write" });
    const mcp = makeBridge(["srv__read_file"], { srv__read_file: "read" });
    const merged = mergeToolBridges(self, mcp);

    // 同一套查找：meta 说是 write 的那个，execute 也必须走它。
    expect(merged?.meta?.("self_memory_write")).toEqual({ risk: "write" });
    expect(merged?.meta?.("srv__read_file")).toEqual({ risk: "read" });
  });

  it("桥没声明 meta 时返回 undefined（落到调用方的安全默认：按 write 处理）", () => {
    const withMeta = makeBridge(["a"], { a: "read" });
    const withoutMeta: ToolBridge = {
      tools: [{ type: "function", function: { name: "b", description: "b", parameters: {} } }],
      execute: async () => ({ text: "", ok: true }),
    };
    const merged = mergeToolBridges(withMeta, withoutMeta);
    expect(merged?.meta?.("b")).toBeUndefined();
  });

  it("meta 找不到对应桥时返回 undefined（不猜）", () => {
    const merged = mergeToolBridges(makeBridge(["a"], { a: "read" }), makeBridge(["b"]));
    expect(merged?.meta?.("不存在的工具")).toBeUndefined();
  });

  it("★ 合并后的 tools 数组不含 meta 键（发给 LLM 的协议数据必须干净）", () => {
    // 方案 A：meta 是 ToolBridge 的独立字段，压根不在 tools 对象上。
    // 这条是**结构性保证**的回归防线——将来有人为了方便往工具对象上挂字段，
    // 这条会拦住（严格端点会报错，宽松端点会静默收下内部实现细节）。
    const self = makeBridge(["self_memory_write"], { self_memory_write: "write" });
    const merged = mergeToolBridges(self);
    expect(JSON.stringify(merged?.tools)).not.toContain("meta");
  });
});
