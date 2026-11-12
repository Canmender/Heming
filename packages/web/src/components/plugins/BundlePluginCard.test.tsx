import { beforeEach, describe, expect, it, vi } from "vitest";
import { fireEvent, render, screen, waitFor } from "@testing-library/react";
import type { CapabilityUnit, UnitStatus } from "@heming/shared";
import type { WidgetRecord, WidgetsBridge } from "../../types/widgets.js";
import { resetWidgetsStore } from "../../lib/widgets/store.js";
import { BundlePluginCard } from "./BundlePluginCard.js";

/**
 * 界面插件（bundle）卡片（d.141）：启停/卸载入口必须真的打到
 * `window.__heming_widgets`，卸载要二次确认且删设置、文案写明删什么。
 *
 * 背景：d.135 删掉 `WidgetsView` 后 bundle 插件没有管理动作，用户「装得上、卸不掉」，
 * 这组断言就是回归护栏。
 */

const RECORD: WidgetRecord = {
  id: "heming.video-editor",
  name: "剪辑室",
  version: "0.1.0",
  enabled: true,
  widget: null,
  settings: {},
  installedAt: "2026-11-12T13:31:25.000Z",
  page: { title: "剪辑室", entry: "files/index.html" } as unknown as WidgetRecord["page"],
};

function status(overrides: Partial<CapabilityUnit> = {}): UnitStatus {
  return {
    unit: {
      source: "bundle",
      id: RECORD.id,
      name: RECORD.name,
      version: RECORD.version,
      description: "剪辑时间线",
      enabled: true,
      contributions: [],
      ...overrides,
    },
    effective: true,
    activeKinds: [],
    diagnostics: [],
  };
}

function makeBridge(overrides: Partial<WidgetsBridge> = {}): WidgetsBridge {
  return {
    list: async () => [RECORD],
    uninstall: async () => ({ ok: true }),
    setEnabled: async () => ({ ok: true, record: RECORD }),
    state: async () => null,
    ...overrides,
  } as unknown as WidgetsBridge;
}

const desktop = window as unknown as { __heming_widgets?: WidgetsBridge };

beforeEach(() => {
  resetWidgetsStore();
  delete desktop.__heming_widgets;
  vi.restoreAllMocks();
});

describe("BundlePluginCard", () => {
  it("卸载：二次确认后才调桥，并按删数据口径传参", async () => {
    const uninstall = vi.fn(async () => ({ ok: true }));
    desktop.__heming_widgets = makeBridge({ uninstall });
    const onNotify = vi.fn();
    render(
      <BundlePluginCard
        status={status()}
        record={RECORD}
        onNotify={onNotify}
        onChanged={vi.fn()}
      />,
    );

    fireEvent.click(screen.getByRole("button", { name: `卸载插件 ${RECORD.name}` }));
    expect(uninstall).not.toHaveBeenCalled();
    // 文案必须把「删什么」说全
    expect(screen.getByText(/插件文件、模型与插件设置都会一并删除/)).toBeTruthy();

    fireEvent.click(screen.getByRole("button", { name: "确认卸载" }));
    await waitFor(() =>
      expect(uninstall).toHaveBeenCalledWith({ id: RECORD.id, removeData: true }),
    );
    await waitFor(() =>
      expect(onNotify).toHaveBeenCalledWith("ok", expect.stringContaining("已卸载插件")),
    );
  });

  it("取消确认：不调桥", async () => {
    const uninstall = vi.fn(async () => ({ ok: true }));
    desktop.__heming_widgets = makeBridge({ uninstall });
    render(<BundlePluginCard status={status()} record={RECORD} onNotify={vi.fn()} />);

    fireEvent.click(screen.getByRole("button", { name: `卸载插件 ${RECORD.name}` }));
    fireEvent.click(screen.getByRole("button", { name: "取消" }));
    expect(uninstall).not.toHaveBeenCalled();
    expect(screen.queryByRole("button", { name: "确认卸载" })).toBeNull();
  });

  it("停用：开关打到桥，提示保留文件与设置", async () => {
    const setEnabled = vi.fn(async () => ({ ok: true, record: RECORD }));
    desktop.__heming_widgets = makeBridge({ setEnabled });
    const onNotify = vi.fn();
    render(<BundlePluginCard status={status()} record={RECORD} onNotify={onNotify} />);

    fireEvent.click(screen.getByRole("switch", { name: `启用插件 ${RECORD.name}` }));
    await waitFor(() => expect(setEnabled).toHaveBeenCalledWith({ id: RECORD.id, enabled: false }));
    await waitFor(() =>
      expect(onNotify).toHaveBeenCalledWith("ok", expect.stringContaining("文件与设置保留")),
    );
  });

  it("卸载失败：报错误原因，卡片仍在（可重试）", async () => {
    const uninstall = vi.fn(async () => ({ ok: false, error: "卸载未完成：目录被占用（可重试卸载）" }));
    desktop.__heming_widgets = makeBridge({ uninstall });
    const onNotify = vi.fn();
    render(<BundlePluginCard status={status()} record={RECORD} onNotify={onNotify} />);

    fireEvent.click(screen.getByRole("button", { name: `卸载插件 ${RECORD.name}` }));
    fireEvent.click(screen.getByRole("button", { name: "确认卸载" }));
    await waitFor(() =>
      expect(onNotify).toHaveBeenCalledWith("error", expect.stringContaining("卸载未完成")),
    );
    expect(screen.getByRole("region", { name: `插件 ${RECORD.name}` })).toBeTruthy();
  });

  it("有可用页面时给「打开页面」，没页面时不给", () => {
    const onOpenPage = vi.fn();
    const { unmount } = render(
      <BundlePluginCard
        status={status()}
        record={RECORD}
        onOpenPage={onOpenPage}
        onNotify={vi.fn()}
      />,
    );
    fireEvent.click(screen.getByRole("button", { name: `打开插件页面 ${RECORD.name}` }));
    expect(onOpenPage).toHaveBeenCalledTimes(1);
    unmount();

    render(<BundlePluginCard status={status()} record={{ ...RECORD, widget: null }} onNotify={vi.fn()} />);
    expect(screen.queryByRole("button", { name: `打开插件页面 ${RECORD.name}` })).toBeNull();
  });
});