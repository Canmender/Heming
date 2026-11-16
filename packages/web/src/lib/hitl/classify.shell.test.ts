import { describe, it, expect } from "vitest";
import { displayNameOf, resolveRisk, riskOfName, summarizeArgs } from "./classify.js";
import { HitlPolicyStore, type HitlPolicy } from "./policy.js";
import type { HitlCall } from "./types.js";

/**
 * 本机命令（d.164）的 HITL 口径。
 *
 * 这是全仓唯一一条「能在这台机器上做任何事」的工具，所以它不能只靠工具层的文案兜底：
 * 风险等级必须在分类层就固定为 danger，策略层必须做到「每条都问、记住的规则也不能放行」。
 */

class FakeStorage {
  private readonly map = new Map<string, string>();
  getItem(k: string): string | null {
    return this.map.get(k) ?? null;
  }
  setItem(k: string, v: string): void {
    this.map.set(k, v);
  }
  removeItem(k: string): void {
    this.map.delete(k);
  }
}

const runCall: HitlCall = {
  id: "run-1",
  name: "run_command",
  argsJson: '{"command":"npm test"}',
  displayName: displayNameOf("run_command"),
  risk: resolveRisk("run_command"),
  summary: "",
  source: "self",
};

describe("run_command 的风险与确认（d.164）", () => {
  it("分类固定为 danger：名字里的 run 不该是唯一判据", () => {
    expect(riskOfName("run_command")).toBe("danger");
    expect(resolveRisk("run_command")).toBe("danger");
    expect(displayNameOf("run_command")).toBe("运行命令");
  });

  it("摘要只放命令本身，压成一行并截断", () => {
    expect(summarizeArgs('{"command":"npm   test"}')).toBe("命令：npm test");
    const long = summarizeArgs(JSON.stringify({ command: "x".repeat(120) }));
    expect(long.startsWith("命令：")).toBe(true);
    expect(long.length).toBeLessThan(80);
    expect(long.endsWith("…")).toBe(true);
  });

  it("任何策略档都要问：strict / guarded / trusted 都不会自动放行", () => {
    const store = new HitlPolicyStore(new FakeStorage());
    const policies: HitlPolicy[] = [
      { mode: "strict", floor: "read", scope: "global" },
      { mode: "guarded", floor: "read", scope: "global" },
      { mode: "guarded", floor: "write", scope: "global" },
      { mode: "trusted", floor: "write", scope: "global" },
    ];
    for (const policy of policies) {
      expect(store.allowed(runCall, policy, "a1")).toBe("ask");
    }
  });

  it("记住的 allow 规则也不能把它放行（danger 恒定要问）", () => {
    const store = new HitlPolicyStore(new FakeStorage());
    const policy: HitlPolicy = { mode: "guarded", floor: "write", scope: "global" };
    store.rememberRule("run_command", "*", "allow", { id: "a1" });
    expect(store.ruleFor(runCall, "a1")).not.toBe("allow");
    expect(store.allowed(runCall, policy, "a1")).toBe("ask");
  });
});
