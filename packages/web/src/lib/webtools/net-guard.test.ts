import { describe, expect, it } from "vitest";
import { checkPublicHttpUrl, isPrivateHostname } from "./net-guard.js";

describe("isPrivateHostname", () => {
  it("回环与内网 IP 段一律视为私有", () => {
    for (const host of [
      "127.0.0.1",
      "127.1.2.3",
      "10.0.0.8",
      "172.16.0.1",
      "172.31.255.255",
      "192.168.1.1",
      "169.254.169.254",
      "100.64.0.1",
      "0.0.0.0",
      "192.0.2.5",
      "198.18.0.1",
      "203.0.113.9",
      "224.0.0.1",
      "255.255.255.255",
    ]) {
      expect(isPrivateHostname(host), host).toBe(true);
    }
  });

  it("IPv6 回环/链路本地/唯一本地/组播视为私有", () => {
    for (const host of ["::1", "::", "fe80::1", "fc00::1", "fd12::1", "ff02::1", "::ffff:127.0.0.1"]) {
      expect(isPrivateHostname(host), host).toBe(true);
    }
  });

  it("本机域名与内网后缀视为私有", () => {
    for (const host of ["localhost", "localhost.", "app.localhost", "printer.local", "nas.internal", "x.lan"]) {
      expect(isPrivateHostname(host), host).toBe(true);
    }
  });

  it("内网后缀带结尾点（绝对 FQDN）也不能绕过拦截", () => {
    // foo.local. 与 foo.local 解析到同一主机，后缀判必须按去点的裸主机名算。
    for (const host of ["foo.local.", "foo.localhost.", "foo.internal.", "x.lan.", "printer.local."]) {
      expect(isPrivateHostname(host), host).toBe(true);
    }
    for (const raw of ["http://foo.local./", "http://foo.internal./"]) {
      expect(checkPublicHttpUrl(raw).ok, raw).toBe(false);
    }
  });

  it("十进制/十六进制单段 IP 视为私有（浏览器会把它解析成 IPv4）", () => {
    expect(isPrivateHostname("2130706433")).toBe(true);
    expect(isPrivateHostname("0x7f000001")).toBe(true);
  });

  it("公网域名与公网 IP 放行", () => {
    for (const host of ["example.com", "www.bing.com", "8.8.8.8", "1.1.1.1", "2001:4860:4860::8888"]) {
      expect(isPrivateHostname(host), host).toBe(false);
    }
  });
});

describe("checkPublicHttpUrl", () => {
  it("合法的 https 地址返回解析后的 URL", () => {
    const verdict = checkPublicHttpUrl("https://example.com/a?b=1");
    expect(verdict.ok).toBe(true);
    if (verdict.ok) expect(verdict.url.hostname).toBe("example.com");
  });

  it("非 http/https、带账号密码、内网地址都被拒绝，且错误是中文", () => {
    for (const raw of ["file:///C:/x.txt", "javascript:alert(1)", "ftp://example.com/", "https://u:p@example.com/"]) {
      const verdict = checkPublicHttpUrl(raw);
      expect(verdict.ok, raw).toBe(false);
      if (!verdict.ok) expect(verdict.error.length).toBeGreaterThan(0);
    }
    const privateUrl = checkPublicHttpUrl("http://127.0.0.1:8080/admin");
    expect(privateUrl.ok).toBe(false);
    if (!privateUrl.ok) expect(privateUrl.error).toContain("本机或内网");
  });

  it("空串与非法 URL 都返回可读错误，不抛", () => {
    for (const raw of ["", "   ", "not a url", "//example.com"]) {
      const verdict = checkPublicHttpUrl(raw);
      expect(verdict.ok, raw).toBe(false);
    }
  });

  it("域名策略：白名单外拒绝、名单内放行、子域按规则走（d.238）", () => {
    const policy = { mode: "allowlist" as const, allow: ["example.com", "*.docs.dev"] };
    const blocked = checkPublicHttpUrl("https://evil.test/a", { policy });
    expect(blocked.ok).toBe(false);
    if (!blocked.ok) {
      expect(blocked.error).toContain("不在允许列表");
      expect(blocked.error).toContain("设置 → 网络访问");
    }
    expect(checkPublicHttpUrl("https://example.com/a", { policy }).ok).toBe(true);
    expect(checkPublicHttpUrl("https://a.example.com/a", { policy }).ok).toBe(true);
    expect(checkPublicHttpUrl("https://api.docs.dev/a", { policy }).ok).toBe(true);
    expect(checkPublicHttpUrl("https://docs.dev/a", { policy }).ok).toBe(false);
  });

  it("域名策略：开放模式与不传策略都不受影响", () => {
    expect(checkPublicHttpUrl("https://anything.test/", { policy: { mode: "open", allow: [] } }).ok).toBe(true);
    expect(checkPublicHttpUrl("https://anything.test/").ok).toBe(true);
  });

  it("内网错误优先于白名单提示（改设置也读不到内网，不能说成「加进列表就行」）", () => {
    const verdict = checkPublicHttpUrl("http://192.168.1.5/", {
      policy: { mode: "allowlist", allow: [] },
    });
    expect(verdict.ok).toBe(false);
    if (!verdict.ok) {
      expect(verdict.error).toContain("本机或内网");
      expect(verdict.error).not.toContain("不在允许列表");
    }
  });
});
