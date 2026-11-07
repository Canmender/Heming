import { describe, it, expect } from "vitest";
import { parsePluginManifest, type InstalledPlugin } from "../../lib/plugins/index.js";
import { filterPlugins, pluginMatchesQuery, type PluginStatusFilter } from "./viewModel.js";

/**
 * 插件列表筛选的纯函数用例（d.77）。
 *
 * 这里只钉「怎么算命中 / 怎么筛」，不渲染页面——页面接线在
 * `PluginsPage.test.tsx` 的「插件列表筛选与安装定位」组里验证。
 */

function plugin(manifest: Record<string, unknown>, enabled = true): InstalledPlugin {
  return {
    manifest: parsePluginManifest({
      schemaVersion: 1,
      id: "acme.base",
      name: "基础能力包",
      version: "1.0.0",
      ...manifest,
    }),
    enabled,
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

const finance = plugin({
  id: "acme.finance",
  name: "财务助手包",
  description: "周报与现金流",
  author: "ACME",
  skills: [{ name: "现金流检查", instructions: "看经营现金流。" }],
});

const weather = plugin(
  {
    schemaVersion: 2,
    id: "acme.weather",
    name: "天气能力包",
    skills: [{ name: "出行建议", instructions: "结合天气出行。" }],
    mcpServers: [{ key: "weather", name: "天气服务", url: "https://mcp.example.com/weather" }],
  },
  false,
);

describe("pluginMatchesQuery（搜索判定）", () => {
  it("空串 / 纯空白恒为命中", () => {
    expect(pluginMatchesQuery(finance, "")).toBe(true);
    expect(pluginMatchesQuery(finance, "   ")).toBe(true);
  });

  it("按名称、id、作者、描述命中，且不区分大小写", () => {
    expect(pluginMatchesQuery(finance, "财务")).toBe(true);
    expect(pluginMatchesQuery(finance, "acme.finance")).toBe(true);
    expect(pluginMatchesQuery(finance, "acme")).toBe(true); // 作者
    expect(pluginMatchesQuery(finance, "现金流")).toBe(true); // 描述 + 技能名
  });

  it("搜技能名与服务名，而不只是插件名", () => {
    expect(pluginMatchesQuery(finance, "现金流检查")).toBe(true);
    expect(pluginMatchesQuery(weather, "出行建议")).toBe(true);
    expect(pluginMatchesQuery(weather, "天气服务")).toBe(true);
  });

  it("多个词按 AND 匹配（跨字段组合也算）", () => {
    expect(pluginMatchesQuery(finance, "财务 现金流")).toBe(true);
    expect(pluginMatchesQuery(finance, "财务 天气")).toBe(false);
  });

  it("不命中时返回 false", () => {
    expect(pluginMatchesQuery(weather, "财报")).toBe(false);
  });
});

describe("filterPlugins（搜索 + 状态）", () => {
  const list = [finance, weather];

  it("保持输入顺序，只做过滤不重排", () => {
    expect(filterPlugins(list, { query: "", status: "all" })).toEqual(list);
  });

  it("状态筛选：已启用 / 已停用", () => {
    const enabled = filterPlugins(list, { query: "", status: "enabled" as PluginStatusFilter });
    expect(enabled.map((p) => p.manifest.id)).toEqual(["acme.finance"]);
    const disabled = filterPlugins(list, { query: "", status: "disabled" });
    expect(disabled.map((p) => p.manifest.id)).toEqual(["acme.weather"]);
  });

  it("搜索与状态同时生效", () => {
    expect(filterPlugins(list, { query: "现金流", status: "enabled" })).toHaveLength(1);
    expect(filterPlugins(list, { query: "现金流", status: "disabled" })).toHaveLength(0);
  });
});
