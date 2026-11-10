import { describe, expect, it } from "vitest";
import {
  PluginManifestInvalidError,
  pluginManifestV5JsonSchema,
  parsePluginManifestV5,
  toV5View,
} from "./manifest.js";

function baseManifest(overrides: Record<string, unknown> = {}): Record<string, unknown> {
  return {
    schemaVersion: 5,
    id: "acme.report-kit",
    name: "报告工具箱",
    version: "1.2.0",
    description: "周报与数据源",
    author: "ACME",
    engines: { heming: "d.103" },
    permissions: { network: ["api.acme.com"], tools: "read" },
    contributions: {
      skills: [{ name: "周报", instructions: "汇总本周任务", triggers: ["周报"] }],
    },
    ...overrides,
  };
}

describe("parsePluginManifestV5", () => {
  it("最小合法清单：补全默认值并归一化", () => {
    const { manifest, warnings } = parsePluginManifestV5(baseManifest());
    expect(warnings).toEqual([]);
    expect(manifest.schemaVersion).toBe(5);
    expect(manifest.engines).toEqual({ heming: "d.103" });
    expect(manifest.meta).toEqual({});
    expect(manifest.distribution).toBe("manifest");
    expect(manifest.permissions).toMatchObject({ tools: "read", files: [], eval: false });
    expect(manifest.contributions.commands).toEqual([]);
    expect(manifest.contributions.desktopWidgets).toEqual([]);
  });

  it("显式空串的 description / author 合法（归一化记录会写空串）", () => {
    const parsed = parsePluginManifestV5(baseManifest({ description: "", author: "" }));
    expect(parsed.manifest.description).toBe("");
    expect(parsed.manifest.author).toBe("");
    const skillEmptyDesc = parsePluginManifestV5(
      baseManifest({
        contributions: { skills: [{ name: "周报", instructions: "x", description: "" }] },
      }),
    );
    expect(skillEmptyDesc.manifest.contributions.skills[0].description).toBe("");
  });

  it("engines 必填且必须合法", () => {
    const missing = baseManifest();
    delete missing.engines;
    expect(() => parsePluginManifestV5(missing)).toThrow(PluginManifestInvalidError);
    expect(() => parsePluginManifestV5(baseManifest({ engines: { heming: "v1" } }))).toThrow(/engines\.heming/);
  });

  it("MCP 服务主机必须被 permissions.network 覆盖（默认端口两侧统一）", () => {
    const withServer = baseManifest({
      permissions: { network: ["api.acme.com:443"], tools: "read" },
      contributions: {
        skills: [{ name: "周报", instructions: "汇总本周任务" }],
        mcpServers: [{ key: "report", name: "报告服务", url: "https://api.acme.com/mcp" }],
      },
    });
    expect(parsePluginManifestV5(withServer).manifest.contributions.mcpServers).toHaveLength(1);

    const uncovered = baseManifest({
      contributions: {
        skills: [{ name: "周报", instructions: "汇总本周任务" }],
        mcpServers: [{ key: "report", name: "报告服务", url: "https://other.example/mcp" }],
      },
    });
    expect(() => parsePluginManifestV5(uncovered)).toThrow(/未覆盖 MCP 服务主机/);
  });

  it("MCP 只允许 https（本机 http 例外），且禁内嵌账号密码", () => {
    const build = (url: string) =>
      baseManifest({
        permissions: { network: ["localhost:3999", "api.acme.com"], tools: "read" },
        contributions: {
          skills: [{ name: "周报", instructions: "汇总本周任务" }],
          mcpServers: [{ key: "local", name: "本地服务", url }],
        },
      });
    expect(() => parsePluginManifestV5(build("http://localhost:3999/mcp"))).not.toThrow();
    expect(() => parsePluginManifestV5(build("http://api.acme.com/mcp"))).toThrow(/只支持 https/);
    expect(() => parsePluginManifestV5(build("https://user:pass@api.acme.com/mcp"))).toThrow(/账号密码/);
  });

  it("bundle 只允许 commands + desktopWidgets，且必须真的带小组件", () => {
    const bundleBase = {
      distribution: "bundle",
      packageSha256: "a".repeat(64),
      permissions: { network: [], tools: "none", events: ["notify"], graphics: ["webgl"], eval: false },
      contributions: {
        desktopWidgets: [
          { id: "pet", name: "桌宠", entry: "files/index.html", width: 300, height: 420 },
        ],
      },
    };
    expect(parsePluginManifestV5(baseManifest(bundleBase)).manifest.distribution).toBe("bundle");

    const withSkills = baseManifest({
      ...bundleBase,
      contributions: {
        ...(bundleBase.contributions as Record<string, unknown>),
        skills: [{ name: "周报", instructions: "汇总本周任务" }],
      },
    });
    expect(() => parsePluginManifestV5(withSkills)).toThrow(/只允许 commands \+ desktopWidgets/);

    const emptyWidgets = baseManifest({
      distribution: "bundle",
      packageSha256: "a".repeat(64),
      contributions: { desktopWidgets: [] },
    });
    expect(() => parsePluginManifestV5(emptyWidgets)).toThrow(/必须声明至少 1 个/);

    const widgetWithoutBundle = baseManifest({
      contributions: {
        skills: [{ name: "周报", instructions: "汇总本周任务" }],
        desktopWidgets: [{ id: "pet", name: "桌宠", entry: "files/index.html", width: 300, height: 420 }],
      },
    });
    expect(() => parsePluginManifestV5(widgetWithoutBundle)).toThrow(/distribution: "bundle"/);
  });

  it("界面插件必须绑定 packageSha256（签名覆盖代码字节，审计 P0-1）", () => {
    const widget = [{ id: "pet", name: "桌宠", entry: "files/index.html", width: 300, height: 420 }];
    const withHash = baseManifest({
      distribution: "bundle",
      packageSha256: "b".repeat(64),
      contributions: { desktopWidgets: widget },
    });
    expect(parsePluginManifestV5(withHash).manifest.packageSha256).toBe("b".repeat(64));

    const missingHash = baseManifest({ distribution: "bundle", contributions: { desktopWidgets: widget } });
    expect(() => parsePluginManifestV5(missingHash)).toThrow(/必须提供 packageSha256/);

    // 非 bundle 声明 packageSha256 没意义
    expect(() =>
      parsePluginManifestV5(baseManifest({ packageSha256: "b".repeat(64) })),
    ).toThrow(/只对界面插件/);

    // 格式必须 64 位小写 hex
    expect(() =>
      parsePluginManifestV5(
        baseManifest({ distribution: "bundle", packageSha256: "ABC", contributions: { desktopWidgets: widget } }),
      ),
    ).toThrow(/packageSha256/);
  });

  it("未知顶层字段：剥掉 + warning；敏感子对象未知键：报错", () => {
    const { manifest, warnings } = parsePluginManifestV5(baseManifest({ futureField: 1 }));
    expect(warnings).toContain("已忽略未知字段 futureField");
    expect("futureField" in (manifest as unknown as Record<string, unknown>)).toBe(false);

    expect(() =>
      parsePluginManifestV5(baseManifest({ permissions: { network: [], tools: "read", future: true } })),
    ).toThrow(/permissions.*未知字段/);
  });

  it("顶层 $schema 是已知字段：解析通过且不产生「未知字段」warning", () => {
    const { manifest, warnings } = parsePluginManifestV5(
      baseManifest({ $schema: "../../plugin-kit/plugin.schema.json" }),
    );
    expect(warnings).toEqual([]);
    expect(warnings.join("\n")).not.toContain("未知");
    // 只作编辑器补全提示，不进归一化后的清单
    expect("$schema" in (manifest as unknown as Record<string, unknown>)).toBe(false);
  });

  it("重名与重复工具会被点名；命令指向不存在的技能被拒", () => {
    const dupSkills = baseManifest({
      contributions: {
        skills: [
          { name: "周报", instructions: "a" },
          { name: "周报", instructions: "b" },
        ],
      },
    });
    expect(() => parsePluginManifestV5(dupSkills)).toThrow(/技能名重复/);

    const dupTools = baseManifest({
      contributions: {
        toolPacks: [
          { id: "a", name: "A", tools: ["report_query"] },
          { id: "b", name: "B", tools: ["report_query"] },
        ],
      },
    });
    expect(() => parsePluginManifestV5(dupTools)).toThrow(/同时出现在工具束/);

    const badCommand = baseManifest({
      contributions: {
        commands: [{ id: "weekly", title: "生成周报", target: { kind: "skill", name: "不存在" } }],
      },
    });
    expect(() => parsePluginManifestV5(badCommand)).toThrow(/不在本插件 contributions\.skills/);
  });

  it("bundle 权限枚举与桌面运行时对齐（lifecycle/theme/tray、webgl2）", () => {
    const parsed = parsePluginManifestV5(
      baseManifest({
        distribution: "bundle",
        packageSha256: "a".repeat(64),
        permissions: {
          network: [],
          tools: "none",
          events: ["notify", "lifecycle", "theme", "tray"],
          graphics: ["webgl", "webgl2", "wasm"],
          eval: false,
        },
        contributions: {
          desktopWidgets: [{ id: "pet", name: "桌宠", entry: "files/index.html", width: 300, height: 420 }],
        },
      }),
    );
    expect(parsed.manifest.permissions.events).toEqual(["notify", "lifecycle", "theme", "tray"]);
    expect(parsed.manifest.permissions.graphics).toEqual(["webgl", "webgl2", "wasm"]);
  });

  it("permissions.chat 只对界面插件有意义", () => {
    const widget = [{ id: "pet", name: "桌宠", entry: "files/index.html", width: 300, height: 420 }];
    const bundle = baseManifest({
      distribution: "bundle",
      packageSha256: "a".repeat(64),
      permissions: { network: [], tools: "none", chat: true, events: ["theme"] },
      contributions: { desktopWidgets: widget },
    });
    expect(parsePluginManifestV5(bundle).manifest.permissions.chat).toBe(true);

    const declarative = baseManifest({ permissions: { network: [], tools: "read", chat: true } });
    expect(() => parsePluginManifestV5(declarative)).toThrow(/只对界面插件/);
  });

  it("命令 target 支持 settings / unit（v5 扩展）", () => {
    const parsed = parsePluginManifestV5(
      baseManifest({
        contributions: {
          skills: [{ name: "周报", instructions: "x" }],
          commands: [
            { id: "open-settings", title: "打开设置", target: { kind: "settings", card: "profile" } },
            { id: "open-unit", title: "打开单元", target: { kind: "unit", unitId: "heming.pet" } },
          ],
        },
      }),
    );
    expect(parsed.manifest.contributions.commands.map((item) => item.target.kind)).toEqual([
      "settings",
      "unit",
    ]);
  });

  it("贡献全空被拒；meta 与图标形状被校验", () => {
    expect(() => parsePluginManifestV5(baseManifest({ contributions: {} }))).toThrow(/至少要让 contributions/);
    expect(() =>
      parsePluginManifestV5(baseManifest({ meta: { icon: "http://insecure.example/i.png" } })),
    ).toThrow(/图标必须是 https/);
    expect(() =>
      parsePluginManifestV5(baseManifest({ meta: { homepage: "https://acme.com", screenshots: ["a"] } })),
    ).toThrow(/https/);
  });

  it("有签名必须有发布者", () => {
    const signed = baseManifest({
      signature: { alg: "ed25519", value: "a".repeat(86) },
    });
    expect(() => parsePluginManifestV5(signed)).toThrow(/必须同时提供 publisher/);
  });

  it("v1–v4 归一化视图：engines 为 d.0，meta 为空", () => {
    const view = toV5View({
      schemaVersion: 3,
      id: "legacy.kit",
      name: "旧包",
      version: "1.0.0",
      description: "",
      author: "",
      permissions: { network: [], tools: "read", files: [] },
      contributions: { skills: [{ name: "旧技能", instructions: "x" }], mcpServers: [], commands: [], toolPacks: [] },
    });
    expect(view.engines.heming).toBe("d.0");
    expect(view.meta).toEqual({});
    expect(view.distribution).toBe("manifest");
  });

  it("JSON Schema 可生成（只作编辑器提示）", () => {
    const schema = pluginManifestV5JsonSchema() as Record<string, unknown>;
    expect(schema.type).toBe("object");
    const properties = schema.properties as Record<string, unknown>;
    expect(properties).toHaveProperty("engines");
    expect(properties).toHaveProperty("contributions");
  });
});

/* ───────────────────────── d.124 插件页面 ───────────────────────── */

function bundleManifest(overrides: Record<string, unknown> = {}): Record<string, unknown> {
  return {
    schemaVersion: 5,
    id: "acme.panel",
    name: "面板",
    version: "1.0.0",
    engines: { heming: "d.124" },
    distribution: "bundle",
    packageSha256: "b".repeat(64),
    permissions: { network: [], tools: "none" },
    contributions: {
      page: { title: "面板", entry: "page/index.html" },
      ...overrides,
    },
  };
}

describe("parsePluginManifestV5 · 插件页面", () => {
  it("声明式页面：blocks 归一化为 kind=blocks，缺省 icon/summary 补空串", () => {
    const parsed = parsePluginManifestV5(
      baseManifest({
        contributions: {
          page: {
            title: "采集桥",
            blocks: [
              { type: "markdown", text: "## 用法\n先填来源。" },
              {
                type: "stats",
                items: [{ label: "已采集", value: "128 条" }],
              },
              { type: "table", columns: ["来源", "状态"], rows: [["QQ", "就绪"]] },
              { type: "list", items: [{ title: "开始同步", badge: "命令" }] },
              { type: "actions", items: [{ label: "打开信息中枢", target: { kind: "page", page: "infohub" } }] },
              { type: "contributions", kind: "skills" },
            ],
          },
          skills: [{ name: "周报", instructions: "x" }],
        },
      }),
    );
    const page = parsed.manifest.contributions.page;
    expect(page).toMatchObject({ kind: "blocks", title: "采集桥", icon: "", summary: "" });
    if (page?.kind !== "blocks") throw new Error("应为 blocks 形态");
    expect(page.blocks.map((block) => block.type)).toEqual([
      "markdown",
      "stats",
      "table",
      "list",
      "actions",
      "contributions",
    ]);
  });

  it("未声明 page 时 contributions.page 缺省（向后兼容）", () => {
    const parsed = parsePluginManifestV5(baseManifest());
    expect(parsed.manifest.contributions.page).toBeUndefined();
  });

  it("界面插件可以只声明 page（不强制 desktopWidgets），归一化为 kind=entry", () => {
    const parsed = parsePluginManifestV5(bundleManifest());
    expect(parsed.manifest.contributions.desktopWidgets).toEqual([]);
    expect(parsed.manifest.contributions.page).toMatchObject({
      kind: "entry",
      title: "面板",
      entry: "page/index.html",
    });
  });

  it("界面插件可以同时声明 desktopWidgets + page", () => {
    const parsed = parsePluginManifestV5(
      bundleManifest({
        desktopWidgets: [{ id: "panel", name: "面板", entry: "widget/index.html", width: 300, height: 420 }],
      }),
    );
    expect(parsed.manifest.contributions.desktopWidgets).toHaveLength(1);
    expect(parsed.manifest.contributions.page?.kind).toBe("entry");
  });

  it("bundle 的页面必须写 entry；写了 blocks 直接拒绝", () => {
    expect(() =>
      parsePluginManifestV5(
        bundleManifest({ page: { title: "面板", blocks: [{ type: "markdown", text: "x" }] } }),
      ),
    ).toThrow(/必须写 contributions\.page\.entry/);
    expect(() =>
      parsePluginManifestV5(
        bundleManifest({
          page: { title: "面板", entry: "page/index.html", blocks: [{ type: "markdown", text: "x" }] },
        }),
      ),
    ).toThrow(/不能再写 contributions\.page\.blocks/);
  });

  it("声明式页面必须写 blocks；写了 entry 会提示改用 bundle", () => {
    expect(() =>
      parsePluginManifestV5(
        baseManifest({ contributions: { page: { title: "页", blocks: [] }, skills: [{ name: "s", instructions: "x" }] } }),
      ),
    ).toThrow(/必须提供至少 1 个 contributions\.page\.blocks/);
    expect(() =>
      parsePluginManifestV5(
        baseManifest({ contributions: { page: { title: "页", entry: "page/index.html" } } }),
      ),
    ).toThrow(/不能写 contributions\.page\.entry/);
  });

  it("页面块严格校验：未知 type、超限、表格行列不一致都点名", () => {
    const withBlock = (block: unknown) =>
      baseManifest({
        contributions: { page: { title: "页", blocks: [block] }, skills: [{ name: "s", instructions: "x" }] },
      });
    expect(() => parsePluginManifestV5(withBlock({ type: "chart", data: [] }))).toThrow(/type/);
    expect(() =>
      parsePluginManifestV5(
        withBlock({
          type: "stats",
          items: Array.from({ length: 9 }, (_, i) => ({ label: `L${i}`, value: "v" })),
        }),
      ),
    ).toThrow(/8 项/);
    expect(() =>
      parsePluginManifestV5(withBlock({ type: "table", columns: ["a", "b"], rows: [["只有一格"]] })),
    ).toThrow(/第 1 行/);
    expect(() =>
      parsePluginManifestV5(
        withBlock({ type: "markdown", text: Array.from({ length: 10 }, () => "x").join("") }),
      ),
    ).not.toThrow();
  });

  it("页面 icon 只接受宿主图标 id", () => {
    const withIcon = (icon: string) =>
      baseManifest({
        contributions: { page: { title: "页", icon, blocks: [{ type: "markdown", text: "x" }] } },
      });
    expect(parsePluginManifestV5(withIcon("activity")).manifest.contributions.page?.icon).toBe("activity");
    for (const icon of ["Activity", "有中文", "a b", "-bad", ""]) {
      expect(() => parsePluginManifestV5(withIcon(icon))).toThrow(/图标/);
    }
  });

  it("页面数量每插件最多一个（page 是对象，写成数组直接拒绝）", () => {
    expect(() =>
      parsePluginManifestV5(
        baseManifest({
          contributions: { page: [{ title: "页", blocks: [{ type: "markdown", text: "x" }] }] },
        }),
      ),
    ).toThrow();
  });
});
