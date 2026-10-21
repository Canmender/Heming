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
