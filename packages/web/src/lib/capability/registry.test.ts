/**
 * 能力注册表的测试。
 *
 * 钉住两条不变量：
 *   1. 注册顺序即优先级——重名工具的执行与 meta 必须落在**同一个**提供者；
 *   2. 合并后的 meta 一定带 origin/providerId，但风险缺省口径不变（不替 MCP 自述背书）。
 */

import { describe, it, expect } from "vitest";
import type { ToolBridge } from "../agentStream.js";
import { CapabilityRegistry } from "./registry.js";
import type { CapabilityContext, CapabilityProvider } from "./types.js";

const CTX: CapabilityContext = { agentId: "agent-a", conversationId: "conv-a" };

function makeBridge(names: string[], label: string): ToolBridge {
  return {
    tools: names.map((name) => ({
      type: "function",
      function: { name, description: name, parameters: { type: "object" } },
    })),
    execute: async (call) => ({ text: `${label}:${call.name}`, ok: true }),
  };
}

function makeProvider(
  id: string,
  origin: CapabilityProvider["origin"],
  bridge: ToolBridge | null,
): CapabilityProvider {
  return { id, origin, build: () => bridge };
}

describe("CapabilityRegistry", () => {
  it("按注册顺序合并工具；全空返回 null", () => {
    const reg = new CapabilityRegistry()
      .register(makeProvider("a", "mcp", makeBridge(["a_tool"], "A")))
      .register(makeProvider("b", "builtin", makeBridge(["b_tool"], "B")));
    const names = (reg.build(CTX)?.tools ?? []).map(
      (t) => (t as { function: { name: string } }).function.name,
    );
    expect(names).toEqual(["a_tool", "b_tool"]);

    expect(new CapabilityRegistry().build(CTX)).toBeNull();
  });

  it("null 桥与空 tools 的提供者都被跳过", () => {
    const reg = new CapabilityRegistry()
      .register(makeProvider("none", "builtin", null))
      .register(makeProvider("empty", "builtin", makeBridge([], "E")))
      .register(makeProvider("real", "builtin", makeBridge(["x"], "X")));
    expect(reg.build(CTX)?.tools).toHaveLength(1);
  });

  it("执行按「谁声明了这个名字」路由；未知工具给清楚的话而不是抛错", async () => {
    const reg = new CapabilityRegistry()
      .register(makeProvider("a", "mcp", makeBridge(["a_tool"], "A")))
      .register(makeProvider("b", "builtin", makeBridge(["b_tool"], "B")));
    const bridge = reg.build(CTX)!;
    expect(await bridge.execute({ name: "b_tool", arguments: "{}" })).toEqual({
      text: "B:b_tool",
      ok: true,
    });
    expect(await bridge.execute({ name: "nope", arguments: "{}" })).toEqual({
      text: "未知工具 nope",
      ok: false,
    });
  });

  it("meta 保留提供者自述，并统一补 origin/providerId", () => {
    const withMeta = makeBridge(["chart_render"], "C");
    withMeta.meta = (name) =>
      name === "chart_render" ? { risk: "read", displayName: "渲染图表" } : undefined;
    const reg = new CapabilityRegistry()
      .register({ id: "charts", origin: "builtin", build: () => withMeta })
      .register(makeProvider("mcp", "mcp", makeBridge(["srv__x"], "M")));
    const bridge = reg.build(CTX)!;

    expect(bridge.meta?.("chart_render")).toEqual({
      risk: "read",
      displayName: "渲染图表",
      origin: "builtin",
      providerId: "charts",
    });
    // MCP 不自述风险（annotations 是 untrusted hint）——只补来源，风险保持缺省
    expect(bridge.meta?.("srv__x")).toEqual({ origin: "mcp", providerId: "mcp" });
    expect(bridge.meta?.("unknown")).toBeUndefined();
  });

  it("重名工具前者胜出：执行与 meta 指向同一个提供者", async () => {
    const first = makeBridge(["dup"], "first");
    first.meta = () => ({ risk: "write" });
    const second = makeBridge(["dup"], "second");
    second.meta = () => ({ risk: "read" });
    const reg = new CapabilityRegistry()
      .register({ id: "first", origin: "mcp", build: () => first })
      .register({ id: "second", origin: "plugin", build: () => second });
    const bridge = reg.build(CTX)!;

    expect((await bridge.execute({ name: "dup", arguments: "{}" })).text).toBe("first:dup");
    expect(bridge.meta?.("dup")).toMatchObject({ risk: "write", providerId: "first" });
  });

  it("重复 id 直接抛错，不静默覆盖", () => {
    const reg = new CapabilityRegistry().register(makeProvider("x", "builtin", null));
    expect(() => reg.register(makeProvider("x", "plugin", null))).toThrow(/id 重复/);
  });

  it("providers() 返回快照，外部改动不影响注册表", () => {
    const reg = new CapabilityRegistry().register(makeProvider("x", "builtin", null));
    const list = reg.providers() as CapabilityProvider[];
    list.pop();
    expect(reg.providers()).toHaveLength(1);
  });
});
