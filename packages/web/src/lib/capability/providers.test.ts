import { describe, it, expect } from "vitest";
import { capabilityRegistry, infohubProvider, selfProvider } from "./index.js";
import { SelfEditBudget, type SelfEditStore } from "../selfEdit/index.js";

/** 只关心注册表的策略接口；自我修改的执行细节由 selfEdit 自己的用例覆盖。 */
function fakePolicy(configured: boolean, allowed = true): SelfEditStore {
  return { configured: () => configured, allowed: () => allowed } as unknown as SelfEditStore;
}

describe("内置能力提供者", () => {
  it("注册顺序与来源分类固定（顺序即重名优先级）", () => {
    expect(capabilityRegistry.providers().map((p) => [p.id, p.origin])).toEqual([
      ["mcp", "mcp"],
      ["charts", "builtin"],
      ["tone", "builtin"],
      ["wiki", "builtin"],
      ["infohub", "builtin"],
      ["self", "self"],
    ]);
  });

  it("infohub 未连接（无桌面桥）时不注入归档工具", () => {
    expect(infohubProvider.build({ agentId: "a", conversationId: "c" })).toBeNull();
  });

  it("self 没有接线层运行态时不注入", () => {
    expect(selfProvider.build({ agentId: "a", conversationId: "c" })).toBeNull();
  });

  it("self 只在用户显式配置过该智能体时注入", () => {
    const ctx = (policy: SelfEditStore) => ({
      agentId: "a",
      conversationId: "c",
      selfEdit: { policy, budget: new SelfEditBudget() },
    });

    expect(selfProvider.build(ctx(fakePolicy(false)))).toBeNull();

    const bridge = selfProvider.build(ctx(fakePolicy(true)));
    expect(bridge).not.toBeNull();
    expect(bridge!.tools.length).toBeGreaterThan(0);
    expect(
      (bridge!.tools[0] as { function: { name: string } }).function.name.startsWith("self_"),
    ).toBe(true);
  });
});
