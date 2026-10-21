import { describe, expect, it } from "vitest";
import {
  hostOf,
  isDeprecated,
  rateInstall,
  registryDomain,
  repoLooksMismatched,
  riskOfTool,
  selfClaimNote,
} from "./risk.js";
import type { InstallOption, RegistryEntry } from "./types.js";

const entry = (over: Partial<RegistryEntry> = {}): RegistryEntry => ({
  key: "io.github.foo/mcp-bar",
  title: "foo",
  description: "d",
  status: "active",
  options: [],
  ...over,
});

const stdio: InstallOption = { kind: "stdio", label: "x", command: "npx", args: ["-y", "p"] };
const http: InstallOption = { kind: "http", label: "x", url: "https://a.example/mcp" };

/* ================================================================== 域名工具 */

describe("hostOf", () => {
  it("取主机名，剥掉协议/端口/路径", () => {
    expect(hostOf("https://a.example/mcp")).toBe("a.example");
    expect(hostOf("http://a.example:8080/x?y=1")).toBe("a.example");
    expect(hostOf("https://a.example")).toBe("a.example");
  });

  it("大小写归一", () => {
    expect(hostOf("https://A.Example/mcp")).toBe("a.example");
  });

  it("非法输入返回空串（不抛）", () => {
    for (const s of ["", "not a url", "a.example/mcp"]) expect(hostOf(s)).toBe("");
  });
});

describe("registryDomain", () => {
  it("取 / 之前的命名空间（长度不固定）", () => {
    expect(registryDomain("io.github.foo/mcp-bar")).toBe("io.github.foo");
    expect(registryDomain("com.example.tool/x")).toBe("com.example.tool");
  });

  it("空输入不抛", () => {
    expect(registryDomain("")).toBe("");
  });
});

/* ================================================================== 域名一致性 */

describe("repoLooksMismatched", () => {
  it("★ 同源判为一致（取命名空间末两段比对）", () => {
    expect(repoLooksMismatched("io.github.foo/bar", "https://github.com/foo/bar")).toBe(false);
    expect(repoLooksMismatched("com.example.tool/x", "https://example.com/tool")).toBe(false);
  });

  it("无仓库地址时不判为不一致（缺证据不等于有罪）", () => {
    expect(repoLooksMismatched("io.github.foo/bar", undefined)).toBe(false);
  });

  it("★ 完全找不到对应才判为不一致", () => {
    expect(repoLooksMismatched("com.evil.tool/x", "https://attacker.example/y")).toBe(true);
  });

  it("URL 不合法时不判为不一致", () => {
    expect(repoLooksMismatched("com.evil.tool/x", "not-a-url")).toBe(false);
  });

  it("单段命名空间没有可比性，不判", () => {
    expect(repoLooksMismatched("localhost/x", "https://github.com/a/b")).toBe(false);
  });

  it("★ 保守性：宁可少报。com.example.tool 配 github 仓库 → 可能报，但只是提示不评级", () => {
    // 这个信号本身不可靠（见 risk.ts 说明），所以 rateInstall 不拿它评级。
    // 这里只锁住「命中 github 标签就不报」这一条确定行为。
    expect(repoLooksMismatched("io.github.example/x", "https://github.com/example/x")).toBe(false);
  });
});

/* ================================================================== 安装评级 */

describe("rateInstall", () => {
  it("远程 http → low，且说清「不装任何代码」", () => {
    const v = rateInstall(entry(), http);
    expect(v.level).toBe("low");
    expect(v.message).toContain("不安装任何代码");
  });

  it("★ stdio → medium，且说清「以本机进程运行」", () => {
    const v = rateInstall(entry(), stdio);
    expect(v.level).toBe("medium");
    expect(v.message).toContain("本机进程运行");
    expect(v.message).toContain("权限");
  });

  it("★ 明确下架态 → high（这是唯一的 high 来源之一）", () => {
    const v = rateInstall(entry({ status: "deprecated" }), http);
    expect(v.level).toBe("high");
  });

  it("status=unknown（无 meta）不判 high", () => {
    expect(rateInstall(entry({ status: "unknown" }), http).level).toBe("low");
  });

  it("★ 明确下架态 → high", () => {
    // 这三个是我们确认过的通用「已废弃/已删除」语义
    for (const s of ["deprecated", "deleted", "archived"]) {
      expect(isDeprecated(s), `${s} 应在下架态清单里`).toBe(true);
      expect(rateInstall(entry({ status: s }), http).level).toBe("high");
    }
  });

  it("★ 未知状态**静默按正常处理**，不判 high（白名单法，不是排除法）", () => {
    // Registry 随时可能新增状态值。若用「非 active 即下架」，
    // 新增的 pending/beta 之类会把正常条目全判成高危 —— 那是误伤。
    for (const s of ["pending", "beta", "inactive", "review", "", "ACTIVE", "Active"]) {
      expect(isDeprecated(s), `${s} 不应在下架态清单里`).toBe(false);
      expect(rateInstall(entry({ status: s }), http).level, `${s} 不应判 high`).toBe("low");
    }
  });

  it("★ 大小写敏感：ACTIVE 不等于 active，但仍按正常处理（不判坏）", () => {
    expect(rateInstall(entry({ status: "ACTIVE" }), http).level).toBe("low");
  });

  it("下架态的文案要带上具体状态值（用户要知道是哪种下架）", () => {
    const v = rateInstall(entry({ status: "deprecated" }), http);
    expect(v.message).toContain("deprecated");
    expect(v.message).toContain("下架");
  });

  it("★ 域名不一致只提示、不升级（误报率高的信号不能评级）", () => {
    const v = rateInstall(
      entry({ key: "com.evil.tool/x", repoUrl: "https://attacker.example/y" }),
      http,
    );
    // 远程 + status=active → 仍是 low
    expect(v.level).toBe("low");
    // 但消息里要提一句，且措辞只能是「看起来不一致」
    expect(v.message).toContain("看起来不一致");
    expect(v.message).not.toContain("不可信");
    expect(v.message).not.toContain("恶意");
  });

  it("同源仓库 → 无不一致提示", () => {
    const v = rateInstall(entry({ key: "io.github.foo/bar", repoUrl: "https://github.com/foo/bar" }), http);
    expect(v.level).toBe("low");
    expect(v.message).not.toContain("不一致");
  });

  it("★ status 非 active + 域名不一致 → high（状态才是评级依据）", () => {
    const v = rateInstall(
      entry({ key: "com.evil.tool/x", repoUrl: "https://attacker.example/y", status: "deprecated" }),
      http,
    );
    expect(v.level).toBe("high");
    expect(v.detail).toContain("看起来不一致");
  });

  it("★ 每一档都必须有 message（不能只给等级）", () => {
    for (const [e, o] of [
      [entry(), http],
      [entry(), stdio],
      [entry({ status: "x" }), stdio],
    ] as const) {
      expect(rateInstall(e, o).message.length).toBeGreaterThan(8);
    }
  });
});

/* ================================================================== 工具级判定（复用 HITL） */

describe("riskOfTool · 必须复用 classify.ts 的判定", () => {
  it("我们的内置工具表同样生效（共用一份代码的证据）", () => {
    expect(riskOfTool("self_mcp_enable").level).toBe("danger");
    expect(riskOfTool("self_memory_list").level).toBe("read");
    expect(riskOfTool("chart_render").level).toBe("read");
  });

  it("★ 未知工具按 write（白名单制：认不出来就多问一次）", () => {
    expect(riskOfTool("some_unknown_tool").level).toBe("write");
  });

  it("危险词命中 → danger", () => {
    expect(riskOfTool("delete_file").level).toBe("danger");
    expect(riskOfTool("run_command").level).toBe("danger");
  });

  it("★ selfTitle 只影响展示名，不影响等级", () => {
    const a = riskOfTool("unknown_thing", "友好名");
    const b = riskOfTool("unknown_thing");
    expect(a.level).toBe(b.level);              // 等级不变
    expect(a.displayName).toBe("友好名");        // 展示名变了
  });

  it("无 selfTitle 时回落到内置展示名", () => {
    expect(riskOfTool("self_memory_list").displayName).not.toBe("unknown_thing");
  });
});

/* ================================================================== 自述标注 */

describe("selfClaimNote", () => {
  it("★ 措辞必须是「自述」而非断言（规范明言 title/annotations 都不可信）", () => {
    const note = selfClaimNote({ readOnlyHint: true });
    expect(note).toContain("自述");
    expect(note).toContain("未经核实");
    // 不能出现「是只读工具」这种断言式表述
    expect(note).not.toMatch(/^该工具是只读/);
  });

  it("destructiveHint → 提示可能破坏", () => {
    expect(selfClaimNote({ destructiveHint: true })).toContain("破坏");
  });

  it("无 annotations → null", () => {
    expect(selfClaimNote(undefined)).toBeNull();
    expect(selfClaimNote({})).toBeNull();
  });

  it("readOnlyHint=true 时不因 destructive 也重复提示", () => {
    // 只给一条，优先级：只读 > 破坏（更具体的那个）
    const note = selfClaimNote({ readOnlyHint: true, destructiveHint: true });
    expect(note).toContain("只读");
  });
});
