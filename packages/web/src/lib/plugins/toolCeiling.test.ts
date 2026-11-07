import { describe, it, expect } from "vitest";
import { parsePluginManifest, type InstalledPlugin } from "./index.js";
import { makePluginToolFilter } from "./toolCeiling.js";

/**
 * 插件工具风险上限在**执行期**的过滤（d.77）。
 *
 * 这条链路此前只在能力目录里展示（把超限工具标成「未注入」），
 * 而 `buildToolBridge()` 仍会把工具交给模型——本用例钉住的正是
 * 「目录说未注入 = 模型真的拿不到」。
 */

function pluginWith(ceiling: "none" | "read" | "write"): InstalledPlugin {
  return {
    manifest: parsePluginManifest({
      schemaVersion: 3,
      id: "acme.tools",
      name: "工具能力包",
      version: "1.0.0",
      permissions: { network: [], tools: ceiling, files: [] },
      contributions: { skills: [{ name: "占位技能", instructions: "占位。" }] },
    }),
    enabled: true,
    skillIds: [],
    serverIds: [],
    fingerprint: "fnv1a64b:0000000000000000",
    publisher: null,
    signature: null,
    disabledKinds: [],
    installedAt: "2026-11-01T00:00:00.000Z",
    updatedAt: "2026-11-01T00:00:00.000Z",
  };
}

function lookup(...plugins: InstalledPlugin[]) {
  const map = new Map(plugins.map((plugin) => [plugin.manifest.id, plugin]));
  return { get: (id: string) => map.get(id) };
}

describe("makePluginToolFilter（声明即约束，执行期同口径）", () => {
  it("read 上限：只读工具放行，写 / 危险工具不注入", () => {
    const allow = makePluginToolFilter(lookup(pluginWith("read")));
    expect(allow({ serverId: "plugin:acme.tools:svc", tool: { name: "read_file" } })).toBe(true);
    expect(allow({ serverId: "plugin:acme.tools:svc", tool: { name: "list_users" } })).toBe(true);
    expect(allow({ serverId: "plugin:acme.tools:svc", tool: { name: "write_file" } })).toBe(false);
    // 危险动词按 write 处理（与能力目录的 catalogRisk 同口径）
    expect(allow({ serverId: "plugin:acme.tools:svc", tool: { name: "delete_file" } })).toBe(false);
  });

  it("none 上限：任何工具都不注入", () => {
    const allow = makePluginToolFilter(lookup(pluginWith("none")));
    expect(allow({ serverId: "plugin:acme.tools:svc", tool: { name: "read_file" } })).toBe(false);
    expect(allow({ serverId: "plugin:acme.tools:svc", tool: { name: "write_file" } })).toBe(false);
  });

  it("write 上限：只读与写工具都放行（仍走 HITL 确认，上限不放宽审批）", () => {
    const allow = makePluginToolFilter(lookup(pluginWith("write")));
    expect(allow({ serverId: "plugin:acme.tools:svc", tool: { name: "read_file" } })).toBe(true);
    expect(allow({ serverId: "plugin:acme.tools:svc", tool: { name: "write_file" } })).toBe(true);
  });

  it("非插件服务不受上限约束", () => {
    const allow = makePluginToolFilter(lookup(pluginWith("none")));
    expect(allow({ serverId: "manual-server", tool: { name: "write_file" } })).toBe(true);
    expect(allow({ serverId: "plugin:acme.tools:svc", tool: { name: "read_file" } })).toBe(false);
  });

  it("归属还在但插件记录缺失：按 none 处理，不因「找不到声明」而放行", () => {
    const allow = makePluginToolFilter({ get: () => undefined });
    expect(allow({ serverId: "plugin:acme.missing:svc", tool: { name: "read_file" } })).toBe(false);
  });
});
