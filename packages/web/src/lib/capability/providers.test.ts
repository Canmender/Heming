import { describe, it, expect } from "vitest";
import {
  capabilityRegistry,
  filesProvider,
  infohubProvider,
  selfProvider,
  teamProvider,
  vaultProvider,
} from "./index.js";
import { TEAM_TOOLS } from "./teamTools.js";
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
      ["vault", "builtin"],
      ["files", "builtin"],
      ["infohub", "builtin"],
      ["plugin-market", "plugin"],
      ["team", "builtin"],
      ["self", "self"],
    ]);
  });

  it("vault 提供者默认注入三个知识库工具（读优先 + 受限写）", () => {
    const bridge = vaultProvider.build({ agentId: "a", conversationId: "c" });
    expect(bridge).not.toBeNull();
    const names = (bridge!.tools as { function: { name: string } }[]).map(
      (tool) => tool.function.name,
    );
    expect(names).toEqual(["vault_search", "vault_read", "vault_write"]);
    expect(bridge!.meta?.("vault_search")?.risk).toBe("read");
    expect(bridge!.meta?.("vault_write")?.risk).toBe("write");
  });

  it("team 提供者始终注入团队工作台工具（不依赖桌面桥/模块开关）", () => {
    const bridge = teamProvider.build({ agentId: "a", conversationId: "c" });
    expect(bridge).not.toBeNull();
    expect(bridge!.tools).toHaveLength(TEAM_TOOLS.length);
  });

  it("注册表合并后工具名唯一：team_* 不与其它提供者撞名", () => {
    const ctx = { agentId: "a", conversationId: "c" };
    const names: string[] = [];
    for (const provider of capabilityRegistry.providers()) {
      // 各提供者按自己的运行态决定注不注入；这里只关心「声明了什么名字」。
      const built = provider.build(ctx);
      for (const tool of built?.tools ?? []) {
        names.push((tool as { function: { name: string } }).function.name);
      }
    }
    expect(names).toContain("team_list");
    expect(names).toContain("team_task_update");
    expect(new Set(names).size).toBe(names.length);
    // 团队工具只能在 team 提供者里出现一次
    expect(names.filter((n) => n.startsWith("team_")).length).toBe(TEAM_TOOLS.length);
  });

  it("files 在桌面桥缺失或没有可写根时不注入（浏览器端不可见）", () => {
    expect(filesProvider.build({ agentId: "a", conversationId: "c" })).toBeNull();
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
