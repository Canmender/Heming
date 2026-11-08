import { describe, expect, it } from "vitest";
import type { CapabilityUnit } from "@heming/shared";
import { BUILTIN_MODULES } from "../modules/registry.js";
import { contentFingerprint } from "../plugins/integrity.js";
import { parsePluginManifest } from "../plugins/manifest.js";
import type { InstalledPlugin } from "../plugins/store.js";
import type { SystemPlugin } from "../plugins/system.js";
import type { WidgetRecord, WidgetSpec } from "../../types/widgets.js";
import {
  currentAppVersion,
  detectUnitOrphans,
  pluginBlocks,
  pluginEngines,
  projectBuiltinUnits,
  projectBundleUnits,
  projectPackageUnits,
  projectSystemUnit,
  projectUnitStatuses,
  projectUnits,
} from "./projection.js";

/**
 * 能力单元投影（d.105）：四类来源都可列、阻断原因可算、顺序稳定。
 * 这里全部用夹具，不碰真实 localStorage / React。
 */

const APP_VERSION = "d.105.1.0.0";

function v3Manifest(overrides: Record<string, unknown> = {}): Record<string, unknown> {
  return {
    schemaVersion: 3,
    id: "acme.report-kit",
    name: "报告工具箱",
    version: "1.2.0",
    description: "周报与月报",
    author: "ACME",
    permissions: { network: ["localhost:3999"], tools: "read", files: [] },
    contributions: {
      skills: [
        { name: "周报", description: "周报大纲", instructions: "汇总本周任务。", triggers: ["周报"] },
        { name: "月报", description: "月报大纲", instructions: "汇总本月任务。", triggers: ["月报"] },
      ],
      mcpServers: [
        { key: "report", name: "报告服务", url: "http://localhost:3999/mcp", description: "" },
      ],
      commands: [
        {
          id: "weekly",
          title: "生成周报",
          description: "",
          keywords: ["周报"],
          target: { kind: "skill", name: "周报" },
        },
      ],
      toolPacks: [
        { id: "report-tools", name: "报告工具", description: "", tools: ["report_query"] },
      ],
    },
    ...overrides,
  };
}

function installedPlugin(overrides: Partial<InstalledPlugin> = {}): InstalledPlugin {
  const manifest = parsePluginManifest(v3Manifest());
  return {
    manifest,
    enabled: true,
    skillIds: ["s1", "s2"],
    serverIds: ["plugin:acme.report-kit:report"],
    fingerprint: contentFingerprint(manifest),
    publisher: null,
    signature: null,
    disabledKinds: [],
    installedAt: "2026-11-08T00:00:00.000Z",
    updatedAt: "2026-11-08T00:00:00.000Z",
    ...overrides,
  };
}

function systemFixture(): SystemPlugin {
  return {
    id: "heming.core",
    name: "系统能力",
    version: "1.0.0",
    description: "随应用内置",
    pinned: true,
    uninstallable: false,
    enabled: true,
    contributions: {
      skills: [
        { id: "b1", name: "通用问答", description: "", enabled: true },
        { id: "b2", name: "总结", description: "", enabled: true },
      ],
      servers: [
        {
          id: "mcp-windows-desktop",
          name: "Windows 桌面",
          url: "http://127.0.0.1:9999/mcp",
          enabled: true,
          preset: true,
        },
      ],
      tools: [{ name: "chart_render", description: "画图", risk: "read" }],
      commands: [],
    },
    counts: { skills: 2, servers: 1, tools: 1, commands: 0 },
  };
}

function widgetSpec(): WidgetSpec {
  return {
    id: "pet",
    name: "桌宠",
    entry: "files/index.html",
    width: 300,
    height: 420,
    scales: [1],
    defaultScale: 1,
    transparent: true,
    alwaysOnTop: true,
    skipTaskbar: true,
    resizable: false,
    clickThrough: "auto",
    position: { anchor: "bottom-right", margin: 24, remember: true },
  };
}

function widgetRecord(overrides: Partial<WidgetRecord> = {}): WidgetRecord {
  return {
    id: "heming.pet",
    name: "桌宠",
    version: "1.0.0",
    enabled: true,
    widget: widgetSpec(),
    settings: {},
    installedAt: "2026-11-08T00:00:00.000Z",
    ...overrides,
  };
}

function byId(units: CapabilityUnit[]): Map<string, CapabilityUnit> {
  return new Map(units.map((unit) => [unit.id, unit] as const));
}

describe("projectUnits · 四类来源", () => {
  it("按 系统 → 内置 → 声明式 → 界面插件 的稳定顺序产出，id 不混淆", () => {
    const units = projectUnits({
      system: systemFixture(),
      moduleEnabled: { staff: true, infohub: true, automations: true, modelroute: true },
      plugins: [installedPlugin()],
      widgets: [widgetRecord()],
      appVersion: APP_VERSION,
    });
    expect(units.map((unit) => unit.source)).toEqual([
      "system",
      ...BUILTIN_MODULES.map(() => "builtin"),
      "package",
      "bundle",
    ]);
    expect(units.map((unit) => unit.id)).toEqual([
      "heming.core",
      ...BUILTIN_MODULES.map((mod) => mod.id),
      "acme.report-kit",
      "heming.pet",
    ]);
  });

  it("没有提供来源时只保留始终存在的内置模块", () => {
    const builtinOnly = projectUnits({});
    expect(builtinOnly.map((unit) => unit.source)).toEqual(
      BUILTIN_MODULES.map(() => "builtin"),
    );
    expect(projectUnits({ modules: [] })).toEqual([]);
    expect(
      projectUnits({ modules: [], plugins: [], widgets: [] }),
    ).toEqual([]);
  });

  it("系统能力单元只读、置顶、贡献计数来自系统视图", () => {
    const unit = projectSystemUnit(systemFixture());
    expect(unit.source).toBe("system");
    expect(unit.readonly).toBe(true);
    expect(unit.enabled).toBe(true);
    expect(unit.contributions).toContainEqual({ kind: "skills", count: 2, enabled: true });
    expect(unit.contributions).toContainEqual({ kind: "mcpServers", count: 1, enabled: true });

    const [status] = projectUnitStatuses({ system: systemFixture(), modules: [] });
    expect(status!.effective).toBe(true);
    expect(status!.activeKinds).toEqual(["skills", "mcpServers"]);
  });
});

describe("projectBuiltinUnits · 模块依赖与开关", () => {
  it("四个模块都有 page 贡献，automations 声明依赖 infohub", () => {
    const units = projectBuiltinUnits({});
    expect(units).toHaveLength(4);
    for (const unit of units) {
      expect(unit.source).toBe("builtin");
      expect(unit.contributions.some((item) => item.kind === "page")).toBe(true);
    }
    expect(byId(units).get("automations")!.requires).toEqual(["infohub"]);
  });

  it("依赖未启用：automations 不生效但开关保留，infohub 本身仍生效", () => {
    const statuses = projectUnitStatuses({
      moduleEnabled: { staff: true, infohub: false, automations: true, modelroute: true },
    });
    const map = new Map(statuses.map((status) => [status.unit.id, status] as const));
    expect(map.get("infohub")!.effective).toBe(false);
    expect(map.get("infohub")!.reason).toEqual({ kind: "disabled" });
    expect(map.get("automations")!.effective).toBe(false);
    expect(map.get("automations")!.reason).toEqual({
      kind: "missingRequirement",
      unitId: "infohub",
    });
    expect(map.get("automations")!.unit.enabled).toBe(true);
  });

  it("总开关关闭：只报 disabled，不报依赖缺失", () => {
    const statuses = projectUnitStatuses({
      moduleEnabled: { staff: false, infohub: true, automations: true, modelroute: true },
    });
    const staff = statuses.find((status) => status.unit.id === "staff")!;
    expect(staff.effective).toBe(false);
    expect(staff.reason).toEqual({ kind: "disabled" });
  });
});

describe("projectPackageUnits · 贡献计数 / 停用 / meta", () => {
  it("贡献计数来自清单，搜索关键词带上技能/服务/命令名", () => {
    const [unit] = projectPackageUnits([installedPlugin()], APP_VERSION);
    expect(unit!.contributions).toEqual([
      { kind: "skills", count: 2, enabled: true },
      { kind: "mcpServers", count: 1, enabled: true },
      { kind: "commands", count: 1, enabled: true },
      { kind: "toolPacks", count: 1, enabled: true },
    ]);
    expect(unit!.meta?.keywords).toEqual(
      expect.arrayContaining(["周报", "月报", "报告服务", "生成周报"]),
    );
    expect(unit!.engines).toBe("d.0");
  });

  it("贡献级停用：只挡那一类贡献，整个单元仍生效", () => {
    const plugin = installedPlugin({ disabledKinds: ["skills"] });
    const [status] = projectUnitStatuses({ plugins: [plugin], modules: [], appVersion: APP_VERSION });
    expect(status!.effective).toBe(true);
    expect(status!.activeKinds).not.toContain("skills");
    expect(status!.diagnostics).toContainEqual({ kind: "kindDisabled", contribution: "skills" });
  });

  it("主开关关闭：disabled 且不再逐类报 kindDisabled", () => {
    const [status] = projectUnitStatuses({
      plugins: [installedPlugin({ enabled: false })],
      modules: [],
      appVersion: APP_VERSION,
    });
    expect(status!.effective).toBe(false);
    expect(status!.reason).toEqual({ kind: "disabled" });
    expect(status!.diagnostics).toEqual([{ kind: "disabled" }]);
  });
});

describe("projectPackageUnits · 损坏记录（P1-7）", () => {
  it("invalidRecord 的插件判降级并给出原因，不复用「旧包=不限制」语义", () => {
    const [unit] = projectPackageUnits(
      [installedPlugin({ invalidRecord: true, invalidReason: "engines 缺失" })],
      APP_VERSION,
    );
    const blocks = unit.blocks ?? [];
    expect(blocks.some((block) => block.kind === "degraded")).toBe(true);
    expect(blocks.find((block) => block.kind === "degraded")?.detail).toContain("安装记录损坏");
    expect(blocks.find((block) => block.kind === "degraded")?.detail).toContain("engines 缺失");
  });
});

describe("projectPackageUnits · engines / 签名 / 指纹阻断", () => {
  it("engines 要求更高版本：incompatible 并带两侧版本", () => {
    const plugin = installedPlugin();
    (plugin.manifest as unknown as { engines: { heming: string } }).engines = { heming: "d.106" };
    const [status] = projectUnitStatuses({ plugins: [plugin], modules: [], appVersion: APP_VERSION });
    expect(status!.effective).toBe(false);
    expect(status!.reason).toEqual({
      kind: "incompatible",
      required: "d.106",
      actual: APP_VERSION,
    });
  });

  it("engines 非法：invalidEngines（失败关闭，不当作兼容）", () => {
    const plugin = installedPlugin();
    (plugin.manifest as unknown as { engines: { heming: string } }).engines = { heming: "v1" };
    const [status] = projectUnitStatuses({ plugins: [plugin], modules: [], appVersion: APP_VERSION });
    expect(status!.reason).toEqual({ kind: "invalidEngines", required: "v1" });
  });

  it("签名无效：signature 阻断；未签名/环境不支持不阻断", () => {
    const invalid = installedPlugin({ signature: { status: "invalid", alg: "ed25519" } });
    const [invalidStatus] = projectUnitStatuses({ plugins: [invalid], modules: [], appVersion: APP_VERSION });
    expect(invalidStatus!.effective).toBe(false);
    expect(invalidStatus!.reason!.kind).toBe("signature");

    for (const signature of [null, { status: "unsupported" as const }]) {
      const [status] = projectUnitStatuses({
        plugins: [installedPlugin({ signature })],
        modules: [],
        appVersion: APP_VERSION,
      });
      expect(status!.effective).toBe(true);
    }
  });

  it("指纹与安装记录不一致：降级并说明可能被手工修改", () => {
    const plugin = installedPlugin({ fingerprint: "fnv1a64b:0000000000000000" });
    const blocks = pluginBlocks(plugin, APP_VERSION);
    expect(blocks).toEqual([
      { kind: "degraded", detail: expect.stringContaining("指纹不一致") },
    ]);
  });

  it("pluginEngines 兼容 v5 形状，缺省返回 undefined", () => {
    expect(pluginEngines(installedPlugin())).toBeUndefined();
    const v5ish = installedPlugin();
    (v5ish.manifest as unknown as { engines: { heming: string } }).engines = { heming: "d.104" };
    expect(pluginEngines(v5ish)).toBe("d.104");
  });
});

describe("projectBundleUnits · 界面插件", () => {
  it("每包一个桌面小组件；启用的记录生效", () => {
    const [unit] = projectBundleUnits([widgetRecord()], APP_VERSION);
    expect(unit!.source).toBe("bundle");
    expect(unit!.contributions).toEqual([
      { kind: "desktopWidgets", count: 1, enabled: true },
    ]);
    const [status] = projectUnitStatuses({ widgets: [widgetRecord()], modules: [], appVersion: APP_VERSION });
    expect(status!.effective).toBe(true);
  });

  it("记录损坏（error）：degraded 阻断，诊断带上原始原因", () => {
    const [status] = projectUnitStatuses({
      widgets: [widgetRecord({ error: "插件文件缺失，请重新安装" })],
      modules: [],
      appVersion: APP_VERSION,
    });
    expect(status!.effective).toBe(false);
    expect(status!.reason).toEqual({ kind: "degraded", detail: "插件文件缺失，请重新安装" });
  });

  it("停用的界面插件：disabled，不伪造已完成状态", () => {
    const [status] = projectUnitStatuses({
      widgets: [widgetRecord({ enabled: false })],
      modules: [],
      appVersion: APP_VERSION,
    });
    expect(status!.reason).toEqual({ kind: "disabled" });
  });
});


describe("detectUnitOrphans（d.110 孤儿记录）", () => {
  it("插件记录缺失时，技能与 plugin: 服务都算孤儿；有归属的不算", () => {
    const orphans = detectUnitOrphans({
      plugins: [installedPlugin()],
      skills: [
        { id: "s-keep", name: "有主技能", pluginId: "acme.report-kit" },
        { id: "s-gone", name: "无主技能", pluginId: "acme.gone" },
        { id: "s-manual", name: "手工技能" },
      ],
      servers: [
        { id: "plugin:acme.report-kit:report", name: "有主服务" },
        { id: "plugin:acme.gone:old", name: "无主服务" },
        { id: "mcp-manual", name: "手工服务" },
      ],
    });
    expect(orphans.skills).toEqual([
      { id: "s-gone", name: "无主技能", pluginId: "acme.gone" },
    ]);
    expect(orphans.servers).toEqual([{ id: "plugin:acme.gone:old", name: "无主服务" }]);
  });

  it("没有孤儿时返回空数组；空输入也不抛", () => {
    expect(detectUnitOrphans({})).toEqual({ skills: [], servers: [] });
    expect(
      detectUnitOrphans({
        plugins: [installedPlugin()],
        skills: [{ id: "s", name: "技能", pluginId: "acme.report-kit" }],
        servers: [{ id: "plugin:acme.report-kit:report", name: "服务" }],
      }),
    ).toEqual({ skills: [], servers: [] });
  });
});

describe("currentAppVersion", () => {
  it("能读到 vite 注入的版本（测试环境有 define），且形如 d.x", () => {
    expect(currentAppVersion()).toMatch(/^d\.\d+/);
  });
});
