import { describe, it, expect, beforeEach, afterEach, vi } from "vitest";
import { render, screen, fireEvent, cleanup } from "@testing-library/react";
import { CommandPalette } from "./CommandPalette.js";
import type { WidgetRecord } from "../types/widgets.js";
import { useUiStore } from "../store/ui.js";
import { useInfohubStore } from "../lib/infohub/store.js";
import { useWidgetsStore } from "../lib/widgets/store.js";

/**
 * d.109：插件（bundle）命令进入命令面板。
 *
 * 数据流：主进程 `widgets:list()` → `useWidgetsStore.records` → `widgetCommands()` →
 * 面板的「插件命令」分组。这里不走桌面桥（jsdom 里没有 `window.__heming_widgets`），
 * 因此同时验证「浏览器端无桥不崩、只是没有这组命令」。
 */

// 声明式插件命令桩：本组用例只测 bundle 命令，避免受 localStorage 里的既有插件影响。
vi.mock("../lib/plugins/index.js", async (importOriginal) => {
  const actual = await importOriginal<typeof import("../lib/plugins/index.js")>();
  return { ...actual, pluginStore: { commands: () => [] } };
});
vi.mock("../lib/api.js", async (importOriginal) => {
  const actual = await importOriginal<typeof import("../lib/api.js")>();
  return { ...actual, fetchTeam: vi.fn(async () => ({ members: [], onlineCount: 0 })) };
});

const searchBox = () => screen.getByLabelText("搜索页面、动作与成员");

function widgetRecord(overrides: Partial<WidgetRecord> = {}): WidgetRecord {
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

function resetStores(records: WidgetRecord[] = [widgetRecord()]) {
  localStorage.clear();
  useUiStore.setState({ page: "home", paletteIntent: null });
  useInfohubStore.setState({ available: false, running: false, booted: true, error: "" });
  useWidgetsStore.setState({ records, states: {}, loading: false, loaded: true, error: null });
}

beforeEach(() => {
  resetStores();
});

afterEach(() => {
  cleanup();
  useWidgetsStore.setState({ records: [], states: {}, loading: false, loaded: false, error: null });
});

describe("命令面板 · 插件命令", () => {
  it("bundle 命令出现在「插件命令」分组，副标题标明「插件」", () => {
    render(<CommandPalette onClose={vi.fn()} />);
    fireEvent.change(searchBox(), { target: { value: "插件区" } });

    expect(screen.getByText("插件命令")).toBeInTheDocument();
    const item = screen.getByRole("option", { name: "选择 打开插件区" });
    expect(item.textContent).toContain("桌宠（插件）");
    expect(item.textContent).toContain("去插件列表");
  });

  it("page target → 切页并关闭面板", () => {
    const onClose = vi.fn();
    render(<CommandPalette onClose={onClose} />);
    fireEvent.change(searchBox(), { target: { value: "插件区" } });
    fireEvent.click(screen.getByRole("option", { name: "选择 打开插件区" }));
    expect(useUiStore.getState().page).toBe("plugins");
    expect(onClose).toHaveBeenCalledTimes(1);
  });

  it("plugin target → 投 open-plugin 意图（开详情）", async () => {
    resetStores([
      widgetRecord({
        commands: [{ id: "open-self", title: "打开我的详情", description: "", keywords: [], target: { kind: "plugin" } }],
      }),
    ]);
    render(<CommandPalette onClose={vi.fn()} />);
    fireEvent.change(searchBox(), { target: { value: "我的详情" } });
    fireEvent.click(screen.getByRole("option", { name: "选择 打开我的详情" }));
    expect(useUiStore.getState().page).toBe("plugins");
    expect(useUiStore.getState().paletteIntent).toMatchObject({
      kind: "open-plugin",
      data: { id: "heming.pet" },
    });
  });

  it("settings / unit target 复用 d.108 的意图分发", async () => {
    resetStores([
      widgetRecord({
        commands: [
          { id: "s", title: "去主题设置", description: "", keywords: [], target: { kind: "settings", card: "theme-mode" } },
          { id: "u", title: "去桌宠单元", description: "", keywords: [], target: { kind: "unit", unitId: "heming.pet" } },
        ],
      }),
    ]);
    render(<CommandPalette onClose={vi.fn()} />);

    fireEvent.change(searchBox(), { target: { value: "主题设置" } });
    fireEvent.click(screen.getByRole("option", { name: "选择 去主题设置" }));
    expect(useUiStore.getState().page).toBe("settings");
    expect(useUiStore.getState().paletteIntent).toMatchObject({
      kind: "focus-settings",
      data: { card: "theme-mode" },
    });

    fireEvent.change(searchBox(), { target: { value: "桌宠单元" } });
    fireEvent.click(screen.getByRole("option", { name: "选择 去桌宠单元" }));
    expect(useUiStore.getState().page).toBe("plugins");
    expect(useUiStore.getState().paletteIntent).toMatchObject({
      kind: "open-plugin",
      data: { id: "heming.pet" },
    });
  });

  it("插件停用后命令消失（与声明式插件同口径）", () => {
    resetStores([widgetRecord({ enabled: false })]);
    render(<CommandPalette onClose={vi.fn()} />);
    fireEvent.change(searchBox(), { target: { value: "插件区" } });
    expect(screen.queryByText("插件命令")).not.toBeInTheDocument();
  });

  it("浏览器端无桌面桥：没有记录就不出现该分组，也不报错", () => {
    resetStores([]);
    expect(() => render(<CommandPalette onClose={vi.fn()} />)).not.toThrow();
    fireEvent.change(searchBox(), { target: { value: "插件区" } });
    expect(screen.queryByText("插件命令")).not.toBeInTheDocument();
  });
});
