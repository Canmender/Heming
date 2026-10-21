import { afterEach, describe, expect, it, vi } from "vitest";
import {
  blockedReason,
  installableWithRuntime,
  missingRuntimeReason,
  probeLocalRuntime,
  runtimeRequirementFor,
  type LocalRuntimeStatus,
} from "./runtime.js";
import type { InstallOption } from "./types.js";

/** 桌面端两个桥都装上（stdio 传输 + 运行时探测）。 */
function stubDesktop(probe?: () => Promise<unknown>) {
  (window as unknown as { __mcp_stdio?: unknown }).__mcp_stdio = {
    request: vi.fn(),
    stop: vi.fn(),
  };
  (window as unknown as { __heming_runtime?: unknown }).__heming_runtime = probe
    ? { probe }
    : { probe: async () => ({ platform: "win32", npm: true, pypi: false, note: "" }) };
}

function clearBridges() {
  delete (window as unknown as { __mcp_stdio?: unknown }).__mcp_stdio;
  delete (window as unknown as { __heming_runtime?: unknown }).__heming_runtime;
}

const status = (over: Partial<LocalRuntimeStatus> = {}): LocalRuntimeStatus => ({
  platform: "win32",
  npm: true,
  pypi: true,
  note: "本机运行时齐备，可安装本地包服务",
  ...over,
});

const npmOption = (over: Partial<InstallOption> = {}): InstallOption => ({
  kind: "stdio",
  label: "npm · pkg@1.2.3",
  command: "npx",
  args: ["-y", "pkg@1.2.3"],
  registryType: "npm",
  version: "1.2.3",
  ...over,
});

afterEach(clearBridges);

/* ================================================================== 依赖判定 */

describe("runtimeRequirementFor", () => {
  it("npm → npm、pypi → pypi", () => {
    expect(runtimeRequirementFor(npmOption())).toBe("npm");
    expect(runtimeRequirementFor(npmOption({ registryType: "pypi", command: "uvx" }))).toBe("pypi");
  });

  it("远程装法不需要本机运行时", () => {
    expect(runtimeRequirementFor({ kind: "http", label: "远程", url: "https://a" })).toBeNull();
  });

  it("认不出类型的 stdio 不猜需求（宁可少说一句，也不编一个「你需要装 X」）", () => {
    expect(runtimeRequirementFor(npmOption({ registryType: undefined }))).toBeNull();
    expect(runtimeRequirementFor(npmOption({ registryType: "oci" }))).toBeNull();
  });
});

/* ================================================================== 探测 */

describe("probeLocalRuntime", () => {
  it("浏览器里没有桥 → null（不抛）", async () => {
    await expect(probeLocalRuntime()).resolves.toBeNull();
  });

  it("桥回来的值被逐字段校验后收下", async () => {
    stubDesktop(async () => ({ platform: "win32", npm: false, pypi: true, note: "x", junk: 1 }));
    expect(await probeLocalRuntime()).toEqual({ platform: "win32", npm: false, pypi: true, note: "x" });
  });

  it("★ 布尔字段缺失时按「探测失败」处理，而不是当成「运行时不存在」", async () => {
    // 把坏数据当成 npm:false 会告诉用户「你没装 Node.js」——他可能装了，只是我们没读出来。
    stubDesktop(async () => ({ platform: "win32", note: "半条数据" }));
    await expect(probeLocalRuntime()).resolves.toBeNull();
    stubDesktop(async () => null);
    await expect(probeLocalRuntime()).resolves.toBeNull();
    stubDesktop(async () => [{ npm: true }]);
    await expect(probeLocalRuntime()).resolves.toBeNull();
  });

  it("桥抛错 → null（永不抛）", async () => {
    stubDesktop(async () => {
      throw new Error("IPC 通道未注册");
    });
    await expect(probeLocalRuntime()).resolves.toBeNull();
  });
});

/* ================================================================== 拦不拦 */

describe("missingRuntimeReason", () => {
  it("远程装法永不拦", () => {
    expect(missingRuntimeReason({ kind: "http", label: "远程", url: "https://a" }, status({ npm: false, pypi: false }))).toBeNull();
    expect(missingRuntimeReason({ kind: "http", label: "远程", url: "https://a" }, null)).toBeNull();
  });

  it("运行时齐备时不拦", () => {
    stubDesktop();
    expect(missingRuntimeReason(npmOption(), status())).toBeNull();
  });

  it("★ 缺运行时时给「装什么」而不只是「缺什么」", () => {
    stubDesktop();
    const reason = missingRuntimeReason(npmOption(), status({ npm: false })) ?? "";
    expect(reason).toContain("Node.js（npx）");
    expect(reason).toContain("安装 Node.js");
    // 必须给出路：只说「装不了」等于把人困在页面上
    expect(reason).toContain("远程服务");
  });

  it("pypi 缺的是 uv", () => {
    stubDesktop();
    const reason = missingRuntimeReason(npmOption({ registryType: "pypi", command: "uvx" }), status({ pypi: false })) ?? "";
    expect(reason).toContain("uv（uvx）");
    expect(reason).toContain("安装 uv");
  });

  it("浏览器里 stdio 根本跑不起来：说清需要桌面版", () => {
    clearBridges();
    expect(missingRuntimeReason(npmOption(), status())).toContain("需要桌面版");
  });

  it("★ 桌面端但探测失败时不拦（我们的故障不该变成用户的安装障碍）", () => {
    stubDesktop();
    expect(missingRuntimeReason(npmOption(), null)).toBeNull();
  });
});

describe("blockedReason / installableWithRuntime", () => {
  it("★ Registry 侧不支持优先于本机运行时", () => {
    stubDesktop();
    const o = npmOption({ unsupported: "该包没有提供固定版本" });
    // 两条都成立时先说 Registry 的：那是永久事实，本机装了 Node 也改变不了
    expect(blockedReason(o, status({ npm: false }))).toBe("该包没有提供固定版本");
    expect(installableWithRuntime(o, status())).toBe(false);
  });

  it("可装且运行时齐备 → null / true", () => {
    stubDesktop();
    expect(blockedReason(npmOption(), status())).toBeNull();
    expect(installableWithRuntime(npmOption(), status())).toBe(true);
  });

  it("可装但本机跑不了 → 运行时原因 / false", () => {
    stubDesktop();
    expect(blockedReason(npmOption(), status({ npm: false }))).toContain("Node.js");
    expect(installableWithRuntime(npmOption(), status({ npm: false }))).toBe(false);
  });

  it("远程装法永远返回 null（不受运行时与桥影响）", () => {
    clearBridges();
    const remote = { kind: "http" as const, label: "远程", url: "https://a" };
    expect(blockedReason(remote, status({ npm: false, pypi: false }))).toBeNull();
    expect(installableWithRuntime(remote, null)).toBe(true);
  });
});
