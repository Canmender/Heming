import { describe, it, expect, beforeEach } from "vitest";
import { DEFAULT_HITL_POLICY, HITL_KEY, HitlPolicyStore, type HitlPolicy } from "./policy.js";
import type { HitlCall, HitlMode } from "./types.js";

/** 内存存储：每个测试一份，互不干扰。 */
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

const writeCall: HitlCall = {
  id: "c1",
  name: "fs__write_file",
  argsJson: "{}",
  displayName: "写文件",
  risk: "write",
  summary: "",
  source: "mcp",
};

const readCall: HitlCall = { ...writeCall, name: "srv__get_file", risk: "read", displayName: "读文件" };
const dangerCall: HitlCall = {
  ...writeCall,
  name: "fs__delete_file",
  risk: "danger",
  displayName: "删文件",
};

describe("策略存储", () => {
  let storage: FakeStorage;
  let store: HitlPolicyStore;
  beforeEach(() => {
    storage = new FakeStorage();
    store = new HitlPolicyStore(storage);
  });

  it("没配置过时回落默认（guarded：只读放行、写入必问）", () => {
    expect(store.get()).toEqual(DEFAULT_HITL_POLICY);
    expect(store.mode()).toBe("guarded");
  });

  it("存储损坏（非法 JSON）→ 回落默认，不抛错", () => {
    storage.setItem(HITL_KEY, "{ 不是 json");
    expect(store.get()).toEqual(DEFAULT_HITL_POLICY);
  });

  it("字段类型不对时逐字段回落默认（好字段照样用）", () => {
    storage.setItem(
      HITL_KEY,
      JSON.stringify({ mode: "不存在的档位", floor: "danger", scope: "global" }),
    );
    expect(store.get()).toEqual({ mode: "guarded", floor: "danger", scope: "global" });
  });

  it("写入策略后可读回", () => {
    const policy: HitlPolicy = { mode: "strict", floor: "write", scope: "per-agent" };
    store.set(policy);
    expect(store.get()).toEqual(policy);
    expect(store.mode()).toBe("strict");
  });
});

describe("档位判定", () => {
  let store: HitlPolicyStore;
  beforeEach(() => {
    store = new HitlPolicyStore(new FakeStorage());
  });

  it("guarded：只读放行、写入与危险操作要问", () => {
    const policy = store.get();
    expect(store.allowed(readCall, policy, "a1")).toBe("pass");
    expect(store.allowed(writeCall, policy, "a1")).toBe("ask");
    expect(store.allowed(dangerCall, policy, "a1")).toBe("ask");
  });

  it("strict：全部询问，连只读也要问", () => {
    const policy: HitlPolicy = { mode: "strict", floor: "read", scope: "global" };
    expect(store.allowed(readCall, policy, "a1")).toBe("ask");
    expect(store.allowed(writeCall, policy, "a1")).toBe("ask");
  });

  it("没有「全部放行」档：auto 已从 HitlMode 删除", () => {
    // ★ 这条断言是**安全护栏**，不是功能测试：
    // 曾经有过 `auto` 档（全部放行），它与自我修改工具组合后是致命的——
    //   self_mcp_add_server（加一个 MCP）→ self_mcp_enable（启用它）
    //   → 那个 MCP 的所有工具在 auto 档下全部静默执行
    // 加上 MCP Registry（装第三方包），这条链的后果是
    //「用户随手装了个包 → 任意代码静默执行」。
    // 而用户开启 HITL 的动机恰恰是"我要安全边界"。
    //
    // 任何想把这个档位加回来的人，都必须先删掉这条断言——
    // 那时至少会有人停下来想一想。
    const modes: HitlMode[] = ["strict", "guarded", "trusted"];
    expect(modes).not.toContain("auto");
  });

  it("免问下限 floor：风险不高于下限的一律免问", () => {
    const policy: HitlPolicy = { mode: "guarded", floor: "write", scope: "global" };
    expect(store.allowed(readCall, policy, "a1")).toBe("pass");
    expect(store.allowed(writeCall, policy, "a1")).toBe("pass");
    expect(store.allowed(dangerCall, policy, "a1")).toBe("ask");
  });

  it("trusted：write 首次问，本会话授权后放行，revokeAll 后再问", () => {
    const policy: HitlPolicy = { mode: "trusted", floor: "read", scope: "global" };
    expect(store.allowed(writeCall, policy, "a1")).toBe("ask");

    store.grant("a1", writeCall.name, policy.scope);
    expect(store.granted("a1", writeCall.name, policy.scope)).toBe(true);
    expect(store.allowed(writeCall, policy, "a1")).toBe("pass");

    store.revokeAll();
    expect(store.granted("a1", writeCall.name, policy.scope)).toBe(false);
    expect(store.allowed(writeCall, policy, "a1")).toBe("ask");
  });

  it("会话授权换 agentId 不串味（另一个智能体仍要问）", () => {
    const policy: HitlPolicy = { mode: "trusted", floor: "read", scope: "global" };
    store.grant("a1", writeCall.name, policy.scope);
    expect(store.allowed(writeCall, policy, "a2")).toBe("ask");
    expect(store.allowed(writeCall, policy, "a1")).toBe("pass");
  });

  it("会话授权只在内存里：不落盘（进程退出即失效）", () => {
    const storage = new FakeStorage();
    const s = new HitlPolicyStore(storage);
    s.grant("a1", writeCall.name, "global");
    expect(storage.getItem(HITL_KEY)).toBeNull();
  });
});

describe("记住的规则", () => {
  let storage: FakeStorage;
  let store: HitlPolicyStore;
  const withPath = (call: HitlCall, path: string): HitlCall => ({
    ...call,
    argsJson: JSON.stringify({ path }),
  });

  beforeEach(() => {
    storage = new FakeStorage();
    store = new HitlPolicyStore(storage);
  });

  it("允许规则按工具 + 资源命中：别的路径仍要问", () => {
    const call = withPath(writeCall, "notes/a.md");
    store.rememberRule(call.name, "notes/a.md", "allow");

    expect(store.ruleFor(call)).toBe("allow");
    expect(store.ruleFor(withPath(writeCall, "notes/b.md"))).toBeNull();
    expect(store.ruleFor({ ...call, name: "fs__other" })).toBeNull();
  });

  it("资源为 * 时匹配该工具的所有调用", () => {
    store.rememberRule(writeCall.name, "*", "allow");
    expect(store.ruleFor(withPath(writeCall, "任意/路径.md"))).toBe("allow");
  });

  it("deny 优先于 allow", () => {
    const call = withPath(writeCall, "notes/a.md");
    store.rememberRule(call.name, "notes/a.md", "allow");
    store.rememberRule(call.name, "notes/a.md", "deny");

    // 同一 {tool, resource} 只留最新一条，但即便两条并存（手工写库）也按拒绝
    expect(store.ruleFor(call)).toBe("deny");
    storage.setItem(
      "heming.hitl.rules.v1",
      JSON.stringify([
        { tool: call.name, resource: "*", effect: "deny", at: "" },
        { tool: call.name, resource: "notes/a.md", effect: "allow", at: "" },
      ]),
    );
    expect(store.ruleFor(call)).toBe("deny");
  });

  it("允许规则不覆盖危险操作（危险始终会问）", () => {
    const call = withPath(dangerCall, "C:/data/a.txt");
    store.rememberRule(call.name, "C:/data/a.txt", "allow");
    expect(store.ruleFor(call)).toBeNull();

    store.rememberRule(call.name, "C:/data/a.txt", "deny");
    expect(store.ruleFor(call)).toBe("deny");
  });

  it("规则落盘：换一个实例仍读得到；clearRules 后清空", () => {
    const call = withPath(writeCall, "notes/a.md");
    store.rememberRule(call.name, "notes/a.md", "allow");

    const other = new HitlPolicyStore(storage);
    expect(other.rules()).toHaveLength(1);
    expect(other.ruleFor(call)).toBe("allow");

    other.clearRules();
    expect(other.rules()).toEqual([]);
    expect(storage.getItem("heming.hitl.rules.v1")).toBeNull();
  });

  it("规则按智能体隔离：A 的允许/拒绝不影响 B", () => {
    const call = withPath(writeCall, "notes/a.md");
    store.rememberRule(call.name, "notes/a.md", "deny", { id: "a1", name: "甲" });

    expect(store.ruleFor(call, "a1")).toBe("deny");
    expect(store.ruleFor(call, "a2")).toBeNull();
    // 不传 agentId 只认全局规则，不会误放行/误拒绝
    expect(store.ruleFor(call)).toBeNull();

    store.rememberRule(call.name, "notes/a.md", "allow", { id: "a2", name: "乙" });
    expect(store.ruleFor(call, "a2")).toBe("allow");
    expect(store.ruleFor(call, "a1")).toBe("deny");
  });

  it("旧的无 agentId 规则保持全局生效（兼容既有存储）", () => {
    const call = withPath(writeCall, "notes/a.md");
    store.rememberRule(call.name, "notes/a.md", "allow");
    expect(store.ruleFor(call, "a1")).toBe("allow");
    expect(store.ruleFor(call, "a2")).toBe("allow");
  });

  it("坏条目丢弃，好条目照常读回", () => {
    storage.setItem(
      "heming.hitl.rules.v1",
      JSON.stringify([
        { tool: "ok", resource: "*", effect: "allow", at: "" },
        { tool: "", resource: "*", effect: "allow" },
        { tool: "bad", resource: "*", effect: "maybe" },
        "不是对象",
      ]),
    );
    expect(store.rules()).toEqual([{ tool: "ok", resource: "*", effect: "allow", at: "" }]);
  });

  it("规则数量有上限（丢最旧的）", () => {
    for (let i = 0; i < 205; i += 1) store.rememberRule("t", `r${i}`, "allow");
    const rules = store.rules();
    expect(rules).toHaveLength(200);
    expect(rules[0].resource).toBe("r204");
  });
});
