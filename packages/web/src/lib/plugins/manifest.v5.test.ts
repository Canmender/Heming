import { describe, it, expect } from "vitest";
import {
  PLUGIN_SCHEMA_VERSIONS,
  PluginManifestError,
  currentAppVersion,
  parsePluginManifest,
  parsePluginManifestDetailed,
  pluginEnginesStatus,
  toPluginV5View,
  type PluginManifest,
} from "./index.js";

/**
 * 清单 v5（d.105）：委托 `@heming/shared` 的 `parsePluginManifestV5` + web 独有校验。
 *
 * v1–v4 的行为由既有 `manifest.test.ts`（106 例）牢牢钉住；本文件只覆盖
 * 「v5 接入 web」这件事：归一化投射、engines 兼容判定、未知字段分层、
 * 命令 `page` 白名单、以及 `toPluginV5View` 的旧包投射。
 */

function v5(overrides: Record<string, unknown> = {}): Record<string, unknown> {
  return {
    schemaVersion: 5,
    id: "acme.report-kit",
    name: "报告工具箱",
    version: "1.2.0",
    description: "周报、月报与数据源",
    author: "ACME",
    engines: { heming: "d.104" },
    meta: {
      icon: "https://cdn.acme.com/report-kit/icon.png",
      homepage: "https://acme.com/report-kit",
      repository: "https://github.com/acme/report-kit",
      license: "MIT",
      category: "efficiency",
      tags: ["official", "report"],
      keywords: ["周报", "月报"],
      screenshots: ["https://cdn.acme.com/report-kit/s1.png"],
    },
    permissions: { network: ["api.acme.com"], tools: "read", files: [] },
    contributions: {
      skills: [
        {
          name: "周报",
          description: "按周汇总",
          instructions: "按模板生成周报。",
          triggers: ["周报"],
          tags: ["汇报"],
        },
      ],
      mcpServers: [{ key: "report", name: "报告服务", url: "https://api.acme.com/mcp" }],
      commands: [
        {
          id: "weekly",
          title: "生成周报",
          keywords: ["周报"],
          target: { kind: "skill", name: "周报" },
        },
      ],
      toolPacks: [],
    },
    ...overrides,
  };
}

function failure(input: unknown): string {
  try {
    parsePluginManifest(input);
  } catch (err) {
    expect(err).toBeInstanceOf(PluginManifestError);
    return (err as Error).message;
  }
  throw new Error("应当解析失败");
}

describe("parsePluginManifest · v5 合法清单", () => {
  it("归一化后带上 engines/meta，贡献与权限用 shared 的归一化结果", () => {
    const parsed = parsePluginManifest(v5());

    expect(parsed.schemaVersion).toBe(5);
    expect(parsed.id).toBe("acme.report-kit");
    expect(parsed.engines).toEqual({ heming: "d.104" });
    expect(parsed.meta).toMatchObject({
      license: "MIT",
      category: "efficiency",
      tags: ["official", "report"],
      keywords: ["周报", "月报"],
    });
    expect(parsed.contributions.skills).toHaveLength(1);
    expect(parsed.contributions.mcpServers[0]).toMatchObject({
      key: "report",
      name: "报告服务",
    });
    expect(parsed.contributions.commands[0].target).toEqual({ kind: "skill", name: "周报" });
    // shared 解析器会补缺省值：distribution 缺省 manifest、tools 缺省 read。
    expect(parsed.distribution).toBe("manifest");
    expect(parsed.permissions).toEqual({
      network: ["api.acme.com"],
      tools: "read",
      files: [],
      events: [],
      graphics: [],
      eval: false,
      chat: false,
      // d.125：沙箱桥新增权限域，未声明时为 false。
      infohub: false,
      notify: false,
    });
    // web 内部形状恒定带 llmPresets（旧消费方兼容字段）。
    expect(parsed.contributions.llmPresets).toEqual([]);
  });

  it("v5 也接受 JSON 文本，错误文案保持中文", () => {
    const parsed = parsePluginManifest(JSON.stringify(v5()));
    expect(parsed.schemaVersion).toBe(5);
    expect(() => parsePluginManifest("")).toThrow("插件清单为空");
    expect(() => parsePluginManifest("{")).toThrow("不是有效的 JSON");
  });

  it("bundle 清单仍能解析（是否可装由 web 安装管线判，不在解析器里拒绝）", () => {
    const bundle = v5({
      distribution: "bundle",
      packageSha256: "a".repeat(64),
      permissions: { network: [], tools: "read", files: [], events: ["notify"], graphics: ["wasm"] },
      contributions: {
        commands: [{ id: "toggle", title: "开关桌宠", target: { kind: "plugin" } }],
        desktopWidgets: [{ id: "pet", name: "桌宠", entry: "index.html", width: 320, height: 480 }],
      },
    });
    const parsed = parsePluginManifest(bundle);
    expect(parsed.distribution).toBe("bundle");
    expect(parsed.contributions.desktopWidgets).toHaveLength(1);
    expect(parsed.permissions.events).toEqual(["notify"]);
    expect(parsed.permissions.graphics).toEqual(["wasm"]);
  });
});

describe("parsePluginManifest · v5 engines / 未知字段 / 命令 page", () => {
  it("engines 缺失或格式非法时拒绝，报错带字段路径", () => {
    expect(failure(v5({ engines: undefined }))).toContain("engines");
    expect(failure(v5({ engines: { heming: "not-a-version" } }))).toContain("engines.heming");
    expect(failure(v5({ engines: { heming: 104 } }))).toContain("engines");
    // 敏感子对象 strict：engines 里多写一个键 = 报错（不静默忽略）。
    expect(failure(v5({ engines: { heming: "d.104", dsh: "d.1" } }))).toContain("engines");
  });

  it("顶层未知字段只警告（剥掉），敏感子对象未知字段报错", () => {
    const detailed = parsePluginManifestDetailed(v5({ futureField: "x", another: 1 }));
    expect(detailed.manifest.id).toBe("acme.report-kit");
    expect(detailed.warnings).toContain("已忽略未知字段 futureField");
    expect(detailed.warnings).toContain("已忽略未知字段 another");
    expect(detailed.manifest).not.toHaveProperty("futureField");

    // permissions / meta / contributions 用 strict：写错位置的权限声明必须拒绝。
    expect(failure(v5({ permissions: { network: [], tools: "read", files: [], shell: true } }))).toContain(
      "permissions",
    );
    expect(failure(v5({ meta: { license: "MIT", colors: ["#fff"] } }))).toContain("meta");
    expect(
      failure(
        v5({
          contributions: {
            skills: [{ name: "周报", instructions: "x", triggers: [], tags: [] }],
            hooks: [],
          },
        }),
      ),
    ).toContain("contributions");
  });

  it("命令 target.page 必须在命令面板页面白名单里", () => {
    const ok = parsePluginManifest(
      v5({
        contributions: {
          skills: [{ name: "周报", instructions: "x" }],
          commands: [{ id: "open", title: "打开插件区", target: { kind: "page", page: "plugins" } }],
        },
      }),
    );
    expect(ok.contributions.commands[0].target).toEqual({ kind: "page", page: "plugins" });

    const message = failure(
      v5({
        contributions: {
          skills: [{ name: "周报", instructions: "x" }],
          commands: [{ id: "bad", title: "坏页面", target: { kind: "page", page: "nope" } }],
        },
      }),
    );
    expect(message).toContain("contributions.commands[0].target.page");
    expect(message).toContain("未知页面：nope");
  });
});

describe("engines 兼容判定（pluginEnginesStatus）", () => {
  it("v5：按最小宿主版本语义判定，文案带两侧版本", () => {
    const manifest = parsePluginManifest(v5({ engines: { heming: "d.104" } }));

    expect(pluginEnginesStatus(manifest, "d.104.2.42.0").status).toBe("compatible");
    expect(pluginEnginesStatus(manifest, "d.106.2.42.0").status).toBe("compatible");

    const newer = pluginEnginesStatus(manifest, "d.103.9.9.9");
    expect(newer).toEqual({ status: "needsNewerApp", required: "d.104", actual: "d.103.9.9.9" });

    const invalid = pluginEnginesStatus(
      { schemaVersion: 5 } as Pick<PluginManifest, "schemaVersion">,
      "d.106.2.42.0",
    );
    expect(invalid.status).toBe("invalidEngines");
  });

  it("v1–v4 没有 engines：按「不限制」处理（旧包不被误杀）", () => {
    const legacy = parsePluginManifest({
      schemaVersion: 2,
      id: "acme.legacy",
      name: "旧包",
      version: "1.0.0",
      skills: [{ name: "技能", instructions: "x" }],
    });
    expect(legacy.engines).toBeUndefined();
    expect(legacy.meta).toBeUndefined();
    expect(pluginEnginesStatus(legacy, "d.0").status).toBe("compatible");
  });

  it("默认 appVersion 取构建期注入的 __APP_VERSION__", () => {
    expect(currentAppVersion()).toMatch(/^d\.\d+/);
  });
});

describe("toPluginV5View · 读模型投射", () => {
  it("v1–v4 投射成 engines = d.0、meta = {}", () => {
    const legacy = parsePluginManifest({
      schemaVersion: 1,
      id: "acme.legacy",
      name: "旧包",
      version: "1.0.0",
      skills: [{ name: "技能", instructions: "x" }],
    });
    const view = toPluginV5View(legacy);
    expect(view.schemaVersion).toBe(5);
    expect(view.engines.heming).toBe("d.0");
    expect(view.meta).toEqual({});
    expect(view.contributions.skills).toHaveLength(1);
  });

  it("v5 保留自身 engines/meta（否则兼容判定会当成「不限制」）", () => {
    const v5Manifest = parsePluginManifest(v5());
    const view = toPluginV5View(v5Manifest);
    expect(view.engines.heming).toBe("d.104");
    expect(view.meta.category).toBe("efficiency");
    expect(view.contributions.commands[0].id).toBe("weekly");
  });

  it("PLUGIN_SCHEMA_VERSIONS 扩到 5，同时保留 1–4", () => {
    expect([...PLUGIN_SCHEMA_VERSIONS]).toEqual([1, 2, 3, 4, 5]);
  });
});
