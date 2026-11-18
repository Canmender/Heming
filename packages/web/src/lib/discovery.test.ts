import { describe, expect, it } from "vitest";

import { discoveryArgs, discoveryText, parseDiscovery } from "./discovery.js";

describe("parseDiscovery", () => {
  it("认出内核那句 on", () => {
    expect(
      parseDiscovery(
        "account discovery is on: magpie reads your agents' sign-ins and serves them as subscriptions",
      ),
    ).toBe("on");
  });

  it("认出 off", () => {
    expect(
      parseDiscovery(
        "account discovery is off: magpie reads none of your agents' sign-ins and serves no subscription; API-key providers work as before",
      ),
    ).toBe("off");
  });

  it("大写与前后空白都不影响", () => {
    expect(parseDiscovery("  Account Discovery Is OFF  ")).toBe("off");
  });

  it("不是这句话就不猜", () => {
    expect(parseDiscovery("")).toBeNull();
    expect(parseDiscovery("no Codex account uses a reset by itself")).toBeNull();
  });
});

describe("discoveryArgs", () => {
  it("切档只发 accounts discovery <on|off>", () => {
    expect(discoveryArgs("off")).toEqual(["accounts", "discovery", "off"]);
    expect(discoveryArgs("on")).toEqual(["accounts", "discovery", "on"]);
  });
});

describe("discoveryText", () => {
  it("开着说清楚账号是自己来的", () => {
    expect(discoveryText("on")).toContain("自动收进来");
  });

  it("关着时解释订阅账号为什么是空的", () => {
    expect(discoveryText("off")).toContain("不会自己出现");
  });

  it("读不到就说读不到", () => {
    expect(discoveryText(null)).toContain("没读到");
  });
});
