import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import {
  DEFAULT_NET_POLICY,
  MAX_NET_ALLOW,
  NET_POLICY_KEY,
  addNetAllow,
  describeNetPolicy,
  domainAllowed,
  getNetPolicy,
  hasNetAllowlist,
  normalizeDomainList,
  normalizeDomainRule,
  parseDomainInput,
  removeNetAllow,
  resetNetPolicy,
  setNetPolicy,
  subscribeNetPolicy,
} from "./netPolicy.js";

describe("normalizeDomainRule", () => {
  it("常见写法都归一成裸域名", () => {
    expect(normalizeDomainRule("example.com")).toBe("example.com");
    expect(normalizeDomainRule("  Example.COM  ")).toBe("example.com");
    expect(normalizeDomainRule("https://example.com/docs/a?b=1#c")).toBe("example.com");
    expect(normalizeDomainRule("example.com:8443")).toBe("example.com");
    expect(normalizeDomainRule("user:pass@example.com")).toBe("example.com");
    expect(normalizeDomainRule("example.com.")).toBe("example.com");
    expect(normalizeDomainRule("*.example.com")).toBe("*.example.com");
    expect(normalizeDomainRule("*.sub.example.com")).toBe("*.sub.example.com");
  });

  it("不能当域名规则用的输入一律返回 null（不猜）", () => {
    for (const raw of [
      "",
      "   ",
      "*",
      "*.com",
      "localhost",
      "192.168.1.1",
      "10.0.0.1",
      "http://",
      "a b.com",
      "foo*bar.example.com",
      "*foo.example.com",
      "[::1]",
      "例子.中国",
      null,
      42,
    ]) {
      expect(normalizeDomainRule(raw), String(raw)).toBeNull();
    }
  });

  it("超长（>253）也拒绝", () => {
    const long = Array.from({ length: 5 }, () => "a".repeat(60)).join(".") + ".com";
    expect(long.length).toBeGreaterThan(253);
    expect(normalizeDomainRule(long)).toBeNull();
  });
});

describe("normalizeDomainList / parseDomainInput", () => {
  it("去重保序，且最多留 MAX_NET_ALLOW 条", () => {
    expect(normalizeDomainList(["b.com", "a.com", "b.com", "*.c.com"])).toEqual([
      "b.com",
      "a.com",
      "*.c.com",
    ]);
    const many = Array.from({ length: MAX_NET_ALLOW + 20 }, (_, i) => `d${i}.com`);
    expect(normalizeDomainList(many)).toHaveLength(MAX_NET_ALLOW);
  });

  it("一次贴一串：换行/逗号/空白都能切，非法写法被丢掉", () => {
    expect(parseDomainInput("a.com\nb.com, c.com；d.com  192.168.1.1  *")).toEqual([
      "a.com",
      "b.com",
      "c.com",
      "d.com",
    ]);
  });
});

describe("domainAllowed", () => {
  it("开放模式一律放行", () => {
    const policy = { mode: "open" as const, allow: [] };
    expect(domainAllowed(policy, "whatever.example")).toBe(true);
    expect(domainAllowed(null, "whatever.example")).toBe(true);
  });

  it("白名单模式：列出的域名连带子域，`*.x` 只放子域", () => {
    const policy = { mode: "allowlist" as const, allow: ["example.com", "*.docs.dev"] };
    expect(domainAllowed(policy, "example.com")).toBe(true);
    expect(domainAllowed(policy, "a.example.com")).toBe(true);
    expect(domainAllowed(policy, "A.Example.COM:443")).toBe(true);
    expect(domainAllowed(policy, "docs.dev")).toBe(false);
    expect(domainAllowed(policy, "api.docs.dev")).toBe(true);
    expect(domainAllowed(policy, "notexample.com")).toBe(false);
    expect(domainAllowed(policy, "example.com.evil.dev")).toBe(false);
    expect(domainAllowed(policy, "")).toBe(false);
  });

  it("列表为空的白名单模式下什么都不放行", () => {
    expect(domainAllowed({ mode: "allowlist", allow: [] }, "example.com")).toBe(false);
  });
});

describe("describeNetPolicy / hasNetAllowlist", () => {
  it("三种状态各有一句人话", () => {
    expect(describeNetPolicy(DEFAULT_NET_POLICY)).toContain("网络访问：开放");
    expect(describeNetPolicy({ mode: "allowlist", allow: [] })).toContain("当前列表为空");
    const line = describeNetPolicy({ mode: "allowlist", allow: ["a.com", "b.com"] });
    expect(line).toContain("仅允许 2 个域名");
    expect(line).toContain("a.com");
    expect(line).toContain("b.com");
  });

  it("有列表但模式是 open 不算启用白名单", () => {
    expect(hasNetAllowlist({ mode: "open", allow: ["a.com"] })).toBe(false);
    expect(hasNetAllowlist({ mode: "allowlist", allow: ["a.com"] })).toBe(true);
    expect(hasNetAllowlist({ mode: "allowlist", allow: [] })).toBe(false);
  });
});

describe("策略存储（内存 + localStorage）", () => {
  beforeEach(() => {
    resetNetPolicy();
    try {
      globalThis.localStorage?.clear();
    } catch {
      // 没有 localStorage 的环境（node）跳过清理。
    }
  });
  afterEach(() => {
    resetNetPolicy();
  });

  it("默认是开放、无规则", () => {
    expect(getNetPolicy()).toEqual({ mode: "open", allow: [] });
  });

  it("写进 localStorage，重建后仍读得到", () => {
    setNetPolicy({ mode: "allowlist", allow: ["https://Example.com/x", "*.docs.dev", "Example.com"] });
    const raw = globalThis.localStorage?.getItem(NET_POLICY_KEY);
    expect(raw).toBeTruthy();
    expect(JSON.parse(raw as string)).toEqual({ mode: "allowlist", allow: ["example.com", "*.docs.dev"] });
    expect(getNetPolicy()).toEqual({ mode: "allowlist", allow: ["example.com", "*.docs.dev"] });
  });

  it("默认态不写键（不留无意义的存储）", () => {
    setNetPolicy({ mode: "open", allow: [] });
    expect(globalThis.localStorage?.getItem(NET_POLICY_KEY) ?? null).toBeNull();
  });

  it("订阅只在真的变了时通知，退订后不再通知", () => {
    const listener = vi.fn();
    const off = subscribeNetPolicy(listener);
    setNetPolicy({ mode: "allowlist" });
    expect(listener).toHaveBeenCalledTimes(1);
    addNetAllow("example.com");
    expect(listener).toHaveBeenCalledTimes(2);
    // 重复添加同一条：没有新规则，不发通知。
    addNetAllow("example.com");
    expect(listener).toHaveBeenCalledTimes(2);
    off();
    removeNetAllow("example.com");
    expect(listener).toHaveBeenCalledTimes(2);
  });

  it("addNetAllow 报出被拒的写法，并去重", () => {
    const first = addNetAllow("example.com\n192.168.1.1\n*");
    expect(first.added).toEqual(["example.com"]);
    expect(first.rejected).toEqual(["192.168.1.1", "*"]);
    const second = addNetAllow("example.com");
    expect(second.added).toEqual([]);
    expect(getNetPolicy().allow).toEqual(["example.com"]);
  });

  it("removeNetAllow 归一化后再比，删不到返回 false", () => {
    addNetAllow("example.com");
    expect(removeNetAllow("https://example.com/x")).toBe(true);
    expect(removeNetAllow("example.com")).toBe(false);
    expect(getNetPolicy().allow).toEqual([]);
  });

  it("存储里是坏数据时按默认开放处理（不能把用户锁在门外）", async () => {
    globalThis.localStorage?.setItem(NET_POLICY_KEY, "{ not json");
    vi.resetModules();
    const broken = await import("./netPolicy.js");
    expect(broken.getNetPolicy()).toEqual({ mode: "open", allow: [] });

    globalThis.localStorage?.setItem(NET_POLICY_KEY, JSON.stringify({ mode: "weird", allow: "nope" }));
    vi.resetModules();
    const weird = await import("./netPolicy.js");
    // 坏 mode 回落成 open；allow 不是数组就当没有规则。
    expect(weird.getNetPolicy()).toEqual({ mode: "open", allow: [] });
  });
});
