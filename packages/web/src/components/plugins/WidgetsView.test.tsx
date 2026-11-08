import { beforeEach, describe, expect, it, vi } from "vitest";
import { fireEvent, render, screen, waitFor } from "@testing-library/react";
import { WidgetsView } from "./WidgetsView.js";
import { resetWidgetsStore } from "../../lib/widgets/store.js";
import { PET_MIGRATION_HINT_KEY } from "../../lib/widgets/legacy.js";
import type { WidgetRecord, WidgetsBridge } from "../../types/widgets.js";

/**
 * 插件区「桌面小组件」Tab（d.94）：
 * - 数据来自主进程 IPC（测试注入 `window.__heming_widgets`）；
 * - 宿主动作（显示/缩放/穿透/重置位置）与启停/卸载都要真的打到桥上；
 * - 停用/损坏记录照常显示；未安装时给一次性「桌宠已改为插件」提示。
 */

function record(overrides: Partial<WidgetRecord> = {}): WidgetRecord {
  return {
    id: "heming.pet",
    name: "桌宠",
    version: "1.0.0",
    enabled: true,
    widget: {
      id: "pet",
      name: "桌宠",
      entry: "files/index.html",
      width: 300,
      height: 420,
      scales: [0.8, 1, 1.25],
      defaultScale: 1,
      transparent: true,
      alwaysOnTop: true,
      skipTaskbar: true,
      resizable: false,
      clickThrough: "auto",
      position: { anchor: "bottom-right", margin: 24, remember: true },
    },
    settings: {},
    installedAt: "2026-11-07T12:00:00.000Z",
    ...overrides,
  };
}

function makeBridge(overrides: Partial<WidgetsBridge> = {}): WidgetsBridge {
  return {
    list: async () => [record()],
    pickPackage: async () => ({ canceled: true }),
    install: async () => ({ ok: true, record: record() }),
    installFromFile: async () => ({ ok: true, record: record() }),
    uninstall: async () => ({ ok: true }),
    setEnabled: async () => ({ ok: true, record: record() }),
    settingsGet: async () => ({}),
    settingsSet: async () => ({}),
    action: async () => ({ ok: true, state: { visible: true, scale: 1.25, clickThrough: false } }),
    state: async () => ({ visible: false, scale: 1, clickThrough: false }),
    publish: () => {},
    migrateLegacy: async () => ({ ok: true }),
    ...overrides,
  } as WidgetsBridge;
}

beforeEach(() => {
  resetWidgetsStore();
  delete window.__heming_widgets;
  localStorage.clear();
});

describe("WidgetsView · 浏览器降级", () => {
  it("没有界面插件桥时只说明「仅桌面端可用」", () => {
    render(<WidgetsView />);
    expect(screen.getByText(/界面插件需要桌面窗口能力/)).toBeTruthy();
    expect(screen.queryByRole("button", { name: /安装桌面小组件/ })).toBeNull();
  });
});

describe("WidgetsView · 列表与宿主动作", () => {
  it("渲染记录、窗口状态与可执行代码提示", async () => {
    window.__heming_widgets = makeBridge();
    render(<WidgetsView />);
    expect(await screen.findByText("桌宠")).toBeTruthy();
    expect(screen.getByText("v1.0.0")).toBeTruthy();
    expect(screen.getByText("已启用")).toBeTruthy();
    expect(screen.getByText("已隐藏")).toBeTruthy();
    expect(screen.getAllByText(/界面插件含可执行代码/).length).toBeGreaterThan(0);
  });

  it("显示/隐藏、缩放、穿透、重置位置都走 widgets:action", async () => {
    const action = vi.fn(async (_input: { id: string; action: string }) => ({
      ok: true,
      state: { visible: true, scale: 1, clickThrough: true },
    }));
    window.__heming_widgets = makeBridge({ action });
    render(<WidgetsView />);
    await screen.findByText("桌宠");
    fireEvent.click(screen.getByRole("button", { name: "在桌面显示" }));
    fireEvent.click(screen.getByRole("button", { name: "放大一档" }));
    fireEvent.click(screen.getByRole("button", { name: "缩小一档" }));
    fireEvent.click(screen.getByRole("button", { name: "开启鼠标穿透" }));
    fireEvent.click(screen.getByRole("button", { name: "重置位置" }));
    await waitFor(() => expect(action).toHaveBeenCalledTimes(5));
    expect(action.mock.calls.map((call) => call[0].action)).toEqual([
      "toggle",
      "scaleUp",
      "scaleDown",
      "toggleClickThrough",
      "resetPosition",
    ]);
  });

  it("停用记录：动作按钮禁用，仍可卸载", async () => {
    window.__heming_widgets = makeBridge({
      list: async () => [record({ enabled: false })],
    });
    render(<WidgetsView />);
    await screen.findByText("已停用");
    expect((screen.getByRole("button", { name: "在桌面显示" }) as HTMLButtonElement).disabled).toBe(true);
    expect((screen.getByRole("button", { name: "重置位置" }) as HTMLButtonElement).disabled).toBe(true);
    expect((screen.getByRole("button", { name: "卸载" }) as HTMLButtonElement).disabled).toBe(false);
  });

  it("损坏记录显示 error，不静默消失", async () => {
    window.__heming_widgets = makeBridge({
      list: async () => [record({ error: "包文件缺失（entry 不存于包内）" })],
    });
    render(<WidgetsView />);
    expect(await screen.findByText(/当前无法运行：包文件缺失/)).toBeTruthy();
  });

  it("启用开关打到 setEnabled", async () => {
    const setEnabled = vi.fn(async () => ({ ok: true, record: record({ enabled: false }) }));
    window.__heming_widgets = makeBridge({ setEnabled, list: async () => [record({ enabled: false })] });
    render(<WidgetsView />);
    await screen.findByText("已停用");
    fireEvent.click(screen.getByRole("switch", { name: "启用「桌宠」" }));
    await waitFor(() => expect(setEnabled).toHaveBeenCalledWith({ id: "heming.pet", enabled: true }));
  });

  it("卸载必须二次确认，文案写明会删文件/模型/设置", async () => {
    const uninstall = vi.fn(async () => ({ ok: true }));
    window.__heming_widgets = makeBridge({ uninstall, list: async () => [record()] });
    render(<WidgetsView />);
    await screen.findByText("桌宠");
    fireEvent.click(screen.getByRole("button", { name: "卸载" }));
    expect(screen.getByRole("dialog", { name: "卸载桌面小组件" })).toBeTruthy();
    expect(screen.getByText(/文件与模型/)).toBeTruthy();
    expect(screen.getByText(/插件设置/)).toBeTruthy();
    fireEvent.click(screen.getByRole("button", { name: "确认卸载" }));
    await waitFor(() => expect(uninstall).toHaveBeenCalledWith({ id: "heming.pet", removeData: true }));
  });
});

describe("WidgetsView · 一次性桌宠迁移提示", () => {
  it("桌面端未安装 heming.pet → 提示一次，写标记后不再提示", async () => {
    window.__heming_widgets = makeBridge({ list: async () => [] });
    const first = render(<WidgetsView />);
    expect(await screen.findByText("桌宠已改为插件")).toBeTruthy();
    expect(localStorage.getItem(PET_MIGRATION_HINT_KEY)).toBe("1");
    first.unmount();
    render(<WidgetsView />);
    // 第二次挂载：标记已写，不再提示
    await waitFor(() => expect(screen.queryByText("桌宠已改为插件")).toBeNull());
  });

  it("已安装 heming.pet 时不提示迁移", async () => {
    window.__heming_widgets = makeBridge();
    render(<WidgetsView />);
    await screen.findByText("桌宠");
    expect(screen.queryByText("桌宠已改为插件")).toBeNull();
  });
});
