import { describe, expect, it } from "vitest";
import {
  CONTRIBUTION_ADMISSION,
  admittedKinds,
  blockReasonText,
  contributionBlockedReason,
  hasActiveContribution,
  resolveUnit,
  resolveUnits,
  type CapabilityUnit,
} from "./unit.js";

function unit(overrides: Partial<CapabilityUnit> = {}): CapabilityUnit {
  return {
    source: "package",
    id: "acme.report-kit",
    name: "报告工具箱",
    version: "1.2.0",
    description: "",
    contributions: [
      { kind: "skills", count: 2, enabled: true },
      { kind: "mcpServers", count: 1, enabled: true },
    ],
    enabled: true,
    ...overrides,
  };
}

describe("准入表", () => {
  it("第三方声明式插件只能贡献四类数据面", () => {
    expect(admittedKinds("package")).toEqual(["skills", "mcpServers", "commands", "toolPacks"]);
    expect(CONTRIBUTION_ADMISSION.package.page).toBe(false);
    expect(contributionBlockedReason("package", "page")).toMatch(/界面\/后台能力需要可执行代码/);
  });

  it("界面插件只允许 commands + 小组件 + 生命周期钩子", () => {
    expect(admittedKinds("bundle")).toEqual(["commands", "desktopWidgets", "hook"]);
    expect(contributionBlockedReason("bundle", "skills")).toMatch(/不能声明/);
  });

  it("内置模块可以贡献界面/后台能力", () => {
    expect(admittedKinds("builtin")).toEqual([
      "skills",
      "mcpServers",
      "commands",
      "page",
      "homeCard",
      "settingsCard",
      "backgroundJob",
    ]);
  });
});

describe("resolveUnit", () => {
  it("启用的单元按贡献点生效", () => {
    const status = resolveUnit(unit(), new Map());
    expect(status.effective).toBe(true);
    expect(status.activeKinds).toEqual(["skills", "mcpServers"]);
    expect(status.reason).toBeUndefined();
  });

  it("总开关关 → disabled", () => {
    const status = resolveUnit(unit({ enabled: false }), new Map());
    expect(status.effective).toBe(false);
    expect(status.reason).toEqual({ kind: "disabled" });
    expect(blockReasonText(status.reason!)).toBe("已停用");
  });

  it("贡献级停用只下线该类别", () => {
    const target = unit();
    const status = resolveUnit(
      { ...target, contributions: [{ kind: "skills", count: 2, enabled: false }, { kind: "mcpServers", count: 1, enabled: true }] },
      new Map(),
    );
    expect(status.activeKinds).toEqual(["mcpServers"]);
    expect(status.diagnostics).toContainEqual({ kind: "kindDisabled", contribution: "skills" });
    expect(blockReasonText({ kind: "kindDisabled", contribution: "skills" })).toBe("技能已单独关闭");
  });

  it("依赖未生效 → missingRequirement，且开关保留（effective=false）", () => {
    const automation = unit({
      source: "builtin",
      id: "automations",
      name: "自动化",
      contributions: [{ kind: "backgroundJob", count: 1, enabled: true }],
      requires: ["infohub"],
    });
    const infohub = unit({
      source: "builtin",
      id: "infohub",
      name: "信息中枢",
      contributions: [{ kind: "page", count: 1, enabled: true }],
      enabled: false,
    });
    const status = resolveUnit(automation, new Map([["infohub", infohub], [automation.id, automation]]));
    expect(status.effective).toBe(false);
    expect(status.reason).toEqual({ kind: "missingRequirement", unitId: "infohub" });
    expect(blockReasonText(status.reason!)).toBe("需要「infohub」启用后才生效");

    // 依赖恢复后同一份声明即生效（开关没被改过）
    const restored = resolveUnit(
      automation,
      new Map([["infohub", { ...infohub, enabled: true }], [automation.id, automation]]),
    );
    expect(restored.effective).toBe(true);
  });

  it("不兼容/签名/孤儿等阻断优先于贡献判定", () => {
    const incompatible = unit({
      blocks: [{ kind: "incompatible", required: "d.105", actual: "d.103.2.42.0" }],
    });
    const status = resolveUnit(incompatible, new Map());
    expect(status.effective).toBe(false);
    expect(blockReasonText(status.reason!)).toBe("需要和鸣 d.105 或更高，当前 d.103.2.42.0");
    expect(hasActiveContribution([status], "skills")).toBe(false);
  });

  it("依赖成环不崩：降级为 degraded", () => {
    const a = unit({ id: "a", requires: ["b"], contributions: [{ kind: "skills", count: 1, enabled: true }] });
    const b = unit({ id: "b", requires: ["a"], contributions: [{ kind: "skills", count: 1, enabled: true }] });
    const status = resolveUnit(a, new Map([["a", a], ["b", b]]));
    expect(status.effective).toBe(false);
    expect(status.diagnostics.some((reason) => reason.kind === "degraded")).toBe(true);
  });

  it("无贡献的单元不算生效（孤儿记录不占位）", () => {
    const empty = unit({ contributions: [] });
    expect(resolveUnit(empty, new Map()).effective).toBe(false);
  });

  it("resolveUnits 批量保持顺序", () => {
    const statuses = resolveUnits([unit(), unit({ id: "b.b", enabled: false })]);
    expect(statuses.map((status) => status.unit.id)).toEqual(["acme.report-kit", "b.b"]);
    expect(hasActiveContribution(statuses, "skills")).toBe(true);
    expect(hasActiveContribution(statuses, "page")).toBe(false);
  });
});
