import { describe, expect, it } from "vitest";
import type { WidgetRecord } from "../../types/widgets.js";
import { WIDGET_COMMAND_SOURCE, widgetCommands } from "./commands.js";

/**
 * 插件命令 → 命令面板条目（d.109）。
 *
 * 纯函数：输入是主进程注册表记录（`widgets:list()`），输出是命令面板的
 * `PluginCommandInfo[]`。用例钉住四件事：过滤（停用/损坏/坏 target）、
 * 来源标注、id 前缀、四种 target 的可解析性。
 */

function record(overrides: Partial<WidgetRecord> = {}): WidgetRecord {
  return {
    id: "heming.pet",
    name: "桌宠",
    version: "1.0.0",
    enabled: true,
    widget: { id: "pet", name: "桌宠", entry: "files/index.html" } as unknown as WidgetRecord["widget"],
    settings: {},
    installedAt: "2026-11-08T00:00:00.000Z",
    commands: [
      {
        id: "open-plugins",
        title: "打开插件区",
        description: "去插件列表",
        keywords: ["插件"],
        target: { kind: "page", page: "plugins" },
      },
    ],
    ...overrides,
  };
}

describe("widgetCommands · 映射与来源", () => {
  it("把 bundle 命令转成面板条目：id 带 widget 前缀、副标题标「插件」", () => {
    const [command] = widgetCommands([record()]);
    expect(command).toMatchObject({
      id: "widget:heming.pet:open-plugins",
      pluginId: "heming.pet",
      title: "打开插件区",
      description: "去插件列表",
      keywords: ["插件"],
      target: { kind: "page", page: "plugins" },
    });
    expect(command.pluginName).toBe(`桌宠（${WIDGET_COMMAND_SOURCE}）`);
  });

  it("四种 target 都保留：page / plugin / settings / unit", () => {
    const commands = widgetCommands([
      record({
        commands: [
          { id: "p", title: "页面", description: "", keywords: [], target: { kind: "page", page: "home" } },
          { id: "self", title: "本插件", description: "", keywords: [], target: { kind: "plugin" } },
          { id: "s", title: "设置卡", description: "", keywords: [], target: { kind: "settings", card: "theme-mode" } },
          { id: "u", title: "单元", description: "", keywords: [], target: { kind: "unit", unitId: "heming.pet" } },
        ],
      }),
    ]);
    expect(commands.map((item) => item.target)).toEqual([
      { kind: "page", page: "home" },
      { kind: "plugin" },
      { kind: "settings", card: "theme-mode" },
      { kind: "unit", unitId: "heming.pet" },
    ]);
  });

  it("停用/损坏的记录不产生命令（与声明式「停用即消失」同口径）", () => {
    expect(widgetCommands([record({ enabled: false })])).toEqual([]);
    expect(widgetCommands([record({ error: "插件文件缺失，请重新安装" })])).toEqual([]);
  });

  it("web 侧再兜一层：未知页面 / 未知设置卡 / 非法单元 id / 坏形状都丢弃", () => {
    const commands = widgetCommands([
      record({
        commands: [
          { id: "a", title: "坏页", description: "", keywords: [], target: { kind: "page", page: "not-a-page" } },
          { id: "b", title: "坏卡", description: "", keywords: [], target: { kind: "settings", card: "no-such-card" } },
          { id: "c", title: "坏单元", description: "", keywords: [], target: { kind: "unit", unitId: "Heming.Pet" } },
          { id: "d", title: "", description: "", keywords: [], target: { kind: "plugin" } },
          { id: "e", title: "合法", description: "", keywords: [], target: { kind: "plugin" } },
        ],
      }),
    ]);
    expect(commands.map((item) => item.id)).toEqual(["widget:heming.pet:e"]);
  });

  it("keywords 去空去重并截断；多插件顺序稳定", () => {
    const commands = widgetCommands([
      record({ id: "a.plugin", name: "A", commands: [
        { id: "x", title: "X", description: "", keywords: [" 甲 ", "甲", "", "乙"], target: { kind: "plugin" } },
      ] }),
      record({ id: "b.plugin", name: "B" }),
    ]);
    expect(commands.map((item) => item.pluginId)).toEqual(["a.plugin", "b.plugin"]);
    expect(commands[0].keywords).toEqual(["甲", "乙"]);
  });
});
