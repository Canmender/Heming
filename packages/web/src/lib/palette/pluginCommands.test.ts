import { describe, it, expect } from "vitest";
import type { PluginCommandInfo } from "../plugins/index.js";
import {
  pluginCommandDetail,
  pluginCommandScore,
  searchPluginCommands,
} from "./pluginCommands.js";
import { searchPalette, flattenGroups, GROUP_LIMITS } from "./search.js";

/**
 * d.64 T3b：插件命令的元数据、检索与分组集成（纯函数）。
 *
 * 覆盖：副标题口径、检索命中面（标题/描述/关键词/插件名）、上限与 total、
 * 分组顺序（插件命令排在动作之后、本机三组之前）、无命令时不出现该组。
 */

function command(over: Partial<PluginCommandInfo> = {}): PluginCommandInfo {
  return {
    id: "plugin:acme.weather:export-week",
    pluginId: "acme.weather",
    pluginName: "天气能力包",
    title: "导出本周天气",
    description: "把本周天气导出为 Markdown",
    keywords: ["导出", "周报"],
    target: { kind: "page", page: "home" },
    ...over,
  };
}

describe("插件命令 · 副标题与检索", () => {
  it("副标题是「插件名 · 描述」，无描述时只留插件名", () => {
    expect(pluginCommandDetail(command())).toBe("天气能力包 · 把本周天气导出为 Markdown");
    expect(pluginCommandDetail(command({ description: "" }))).toBe("天气能力包");
  });

  it("标题命中权重高于描述/关键词命中", () => {
    const byTitle = pluginCommandScore("导出本周", command());
    const byDesc = pluginCommandScore("Markdown", command());
    const byKeyword = pluginCommandScore("周报", command());
    expect(byTitle).toBeGreaterThan(byDesc);
    expect(byDesc).toBeGreaterThan(0);
    expect(byKeyword).toBeGreaterThan(0);
  });

  it("搜插件名能带出该插件的命令", () => {
    expect(pluginCommandScore("天气能力包", command())).toBeGreaterThan(0);
  });

  it("大小写不敏感，空查询不命中", () => {
    expect(pluginCommandScore("MARKDOWN", command())).toBeGreaterThan(0);
    expect(pluginCommandScore("", command())).toBe(0);
  });

  it("检索结果截断到上限，total 保留真实命中数", () => {
    const many = Array.from({ length: 8 }, (_, i) =>
      command({ id: `plugin:acme.weather:c${i}`, title: `导出天气 ${i}` }),
    );
    const out = searchPluginCommands("导出", many, 5);
    expect(out.hits).toHaveLength(5);
    expect(out.total).toBe(8);
  });
});

describe("插件命令 · 分组集成", () => {
  const commands = [command()];

  it("分组顺序：动作之后、本机三组之前", () => {
    const groups = searchPalette("导出", {
      members: [],
      archiveHits: [],
      commands,
      local: { tasks: [], memories: [], plugins: [] },
    });
    const ids = groups.map((g) => g.id);
    // 该查询只命中插件命令：说明它确实在动作之后的分组位（页面/设置/动作/本机三组都没命中时只留它）
    expect(ids).toEqual(["plugin-command"]);
  });

  it("没有命令（插件都停用/没装）时不出现该组", () => {
    const groups = searchPalette("导出", { members: [], archiveHits: [], commands: [] });
    expect(groups.some((g) => g.id === "plugin-command")).toBe(false);
  });

  it("组内只有 plugin-command 类型，且超过上限时 total 可算「还有 N 条」", () => {
    const many = Array.from({ length: 7 }, (_, i) =>
      command({ id: `plugin:acme.weather:c${i}`, title: `导出天气 ${i}` }),
    );
    const groups = searchPalette("导出", { members: [], archiveHits: [], commands: many });
    const group = groups.find((g) => g.id === "plugin-command")!;
    expect(new Set(group.items.map((i) => i.kind))).toEqual(new Set(["plugin-command"]));
    expect(group.items).toHaveLength(GROUP_LIMITS["plugin-command"]);
    expect((group.total ?? 0) - group.items.length).toBe(2);
  });

  it("面板项带原始命令，执行时可据 target 分发", () => {
    const groups = searchPalette("导出", { members: [], archiveHits: [], commands });
    const item = flattenGroups(groups).find((i) => i.kind === "plugin-command")!;
    expect(item.command?.id).toBe("plugin:acme.weather:export-week");
    expect(item.command?.target).toEqual({ kind: "page", page: "home" });
    expect(item.detail).toContain("天气能力包");
  });
});
