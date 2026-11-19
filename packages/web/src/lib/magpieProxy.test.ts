import { describe, expect, it } from "vitest";
import { describeProxy, parseProxy, proxyArgs, proxyProblem } from "./magpieProxy.js";

describe("网络代理：设的是哪条线", () => {
  it("空值是「跟着环境走」，不是「不走代理」", () => {
    expect(parseProxy("")).toEqual({ mode: "system", address: "" });
    expect(parseProxy(undefined)).toEqual({ mode: "system", address: "" });
    expect(parseProxy("   ")).toEqual({ mode: "system", address: "" });
  });

  it("direct 与几个同义词都认作直连", () => {
    for (const raw of ["direct", "DIRECT", "none", "off"]) {
      expect(parseProxy(raw)).toEqual({ mode: "direct", address: "" });
    }
  });

  it("其余原样当地址，带不带协议都留着", () => {
    expect(parseProxy("http://127.0.0.1:7890")).toEqual({
      mode: "custom",
      address: "http://127.0.0.1:7890",
    });
    expect(parseProxy(" socks5://127.0.0.1:1080 ")).toEqual({
      mode: "custom",
      address: "socks5://127.0.0.1:1080",
    });
    expect(parseProxy("127.0.0.1:7890")).toEqual({ mode: "custom", address: "127.0.0.1:7890" });
  });
});

describe("网络代理：地址挡一道", () => {
  it("空、带空格、说不清形态的都点出来", () => {
    expect(proxyProblem("")).toBe("还没填地址");
    expect(proxyProblem("http://127.0.0.1:7890 x")).toBe("地址里不能有空格");
    expect(proxyProblem("myproxy")).toBe("写成 host:port，或者带 http:// / socks5://");
  });

  it("三种写法都放行", () => {
    expect(proxyProblem("http://127.0.0.1:7890")).toBe("");
    expect(proxyProblem("socks5://127.0.0.1:1080")).toBe("");
    expect(proxyProblem("127.0.0.1:7890")).toBe("");
  });
});

describe("网络代理：发出去的命令", () => {
  it("跟随环境用 reset，不是发空串", () => {
    expect(proxyArgs("system", "http://127.0.0.1:7890")).toEqual(["settings", "reset", "proxy"]);
  });

  it("直连发 direct", () => {
    expect(proxyArgs("direct", "")).toEqual(["settings", "set", "proxy", "direct"]);
  });

  it("自定义原样发，地址不合法就一条都不发", () => {
    expect(proxyArgs("custom", "http://127.0.0.1:7890")).toEqual([
      "settings",
      "set",
      "proxy",
      "http://127.0.0.1:7890",
    ]);
    expect(proxyArgs("custom", "")).toBeNull();
    expect(proxyArgs("custom", "myproxy")).toBeNull();
  });

  it("现在怎么走的，一句话说清", () => {
    expect(describeProxy("system", "")).toBe("跟着系统的环境变量走");
    expect(describeProxy("direct", "")).toBe("直连，不走代理");
    expect(describeProxy("custom", "http://127.0.0.1:7890")).toBe("走 http://127.0.0.1:7890");
    expect(describeProxy("custom", "")).toBe("还没填地址");
  });
});
