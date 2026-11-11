import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { fireEvent, render, screen, waitFor, within } from "@testing-library/react";
import { PluginBundlePage } from "./PluginBundlePage.js";
import {
  refreshWidgets,
  resetWidgetsStore,
  widgetRecord,
} from "../../lib/widgets/store.js";
import { useUiStore } from "../../store/ui.js";
import type {
  WidgetPageRect,
  WidgetRecord,
  WidgetsBridge,
} from "../../types/widgets.js";

/**
 * 插件页面 host（d.124 B 路径，规格 §5.2）：
 * - 视图在主进程（沙箱 WebContentsView），web 侧只负责「量矩形 + 上报 + 清理」；
 * - 无桥 / 旧桌面端 → 降级说明；主进程回 `{ ok:false, error }` → 错误态两个可执行动作；
 * - 停用 / 无 page / 无记录 → 空态，不发任何 IPC。
 *
 * 测试直接注入 `window.__heming_widgets`（与 WidgetsView.test.tsx 同一套写法），
 * 不经过 Lead 的路由/注册表接线。
 */

const PAGE = {
  title: "我的面板",
  icon: "layout",
  summary: "本机状态一览",
  entry: "page/index.html",
};

function record(overrides: Partial<WidgetRecord> = {}): WidgetRecord {
  return {
    id: "heming.panel",
    name: "面板插件",
    version: "1.2.0",
    enabled: true,
    widget: {
      id: "panel",
      name: "面板插件",
      entry: "widget/index.html",
      width: 300,
      height: 420,
      scales: [1],
      defaultScale: 1,
      transparent: false,
      alwaysOnTop: false,
      skipTaskbar: true,
      resizable: false,
      clickThrough: "none",
      position: { anchor: "bottom-right", margin: 24, remember: false },
    },
    settings: {},
    installedAt: "2026-11-10T02:00:00.000Z",
    page: PAGE,
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
    action: async () => ({ ok: true, state: { visible: true, scale: 1, clickThrough: false } }),
    state: async () => ({ visible: false, scale: 1, clickThrough: false }),
    publish: () => {},
    migrateLegacy: async () => ({ ok: true }),
    ...overrides,
  } as WidgetsBridge;
}

/** 三个可选方法齐全的「新桌面端」桥；用例可再覆盖单个方法。 */
function makePageBridge(overrides: Partial<WidgetsBridge> = {}): WidgetsBridge {
  return makeBridge({
    pageMount: async () => ({ ok: true }),
    pageBounds: () => {},
    pageUnmount: () => {},
    ...overrides,
  });
}

function domRect(left: number, top: number, width: number, height: number): DOMRect {
  return {
    x: left,
    y: top,
    left,
    top,
    width,
    height,
    right: left + width,
    bottom: top + height,
    toJSON: () => ({}),
  } as DOMRect;
}

/** jsdom 没有 ResizeObserver；用可手动 `trigger()` 的桩替代，模拟窗口/布局变化。 */
class FakeResizeObserver {
  static instances: FakeResizeObserver[] = [];
  readonly targets: Element[] = [];
  disconnected = false;
  constructor(private readonly callback: () => void) {
    FakeResizeObserver.instances.push(this);
  }
  observe(target: Element): void {
    this.targets.push(target);
  }
  unobserve(): void {}
  disconnect(): void {
    this.disconnected = true;
  }
  /** 测试手动触发一次「尺寸变了」。 */
  trigger(): void {
    this.callback();
  }
}

let currentRect = domRect(240, 64, 960, 600);

beforeEach(() => {
  resetWidgetsStore();
  delete window.__heming_widgets;
  useUiStore.setState({ page: "home" });
  FakeResizeObserver.instances = [];
  vi.stubGlobal("ResizeObserver", FakeResizeObserver);
  currentRect = domRect(240, 64, 960, 600);
  vi.spyOn(HTMLElement.prototype, "getBoundingClientRect").mockImplementation(() => currentRect);
});

afterEach(() => {
  vi.restoreAllMocks();
  vi.unstubAllGlobals();
});

describe("PluginBundlePage · 降级（浏览器 / 旧桌面端）", () => {
  it("没有插件桥时说明「插件页面只在安装版里可用」", () => {
    render(<PluginBundlePage pluginId="heming.panel" />);
    expect(screen.getByText("插件页面只在安装版里可用")).toBeTruthy();
    // 降级时不该出现占位区，也不该有可点击的挂载入口
    expect(screen.queryByTestId("plugin-page-host")).toBeNull();
  });

  it("旧桌面端桥缺少 pageMount 时同样降级，不假定方法存在", () => {
    window.__heming_widgets = makeBridge(); // 没有 pageMount / pageBounds / pageUnmount
    render(<PluginBundlePage pluginId="heming.panel" />);
    expect(screen.getByText("插件页面只在安装版里可用")).toBeTruthy();
  });
});

describe("PluginBundlePage · 挂载与页头", () => {
  it("按占位区矩形挂载视图，页头显示插件名/版本/徽标", async () => {
    const pageMount = vi.fn(
      async (_input: { id: string; rect: WidgetPageRect }) => ({ ok: true as const }),
    );
    const pageBounds = vi.fn();
    window.__heming_widgets = makePageBridge({ pageMount, pageBounds });

    render(<PluginBundlePage pluginId="heming.panel" />);

    await waitFor(() => expect(pageMount).toHaveBeenCalledTimes(1));
    expect(pageMount).toHaveBeenCalledWith({
      id: "heming.panel",
      rect: { x: 240, y: 64, width: 960, height: 600 },
    });
    expect(screen.getByText("我的面板")).toBeTruthy();
    expect(screen.getByText("v1.2.0")).toBeTruthy();
    expect(screen.getByText("插件")).toBeTruthy();
    expect(screen.getByText("本机状态一览")).toBeTruthy();

    const host = screen.getByTestId("plugin-page-host");
    expect(host.style.position).toBe("relative");
    // 挂载成功前有加载提示，成功后收掉（视图盖上来后不该再看见文字）
    await waitFor(() => expect(screen.queryByText("正在加载插件页面…")).toBeNull());
    // 没有尺寸变化就不该发 pageBounds
    expect(pageBounds).not.toHaveBeenCalled();
  });

  it("尺寸变化时上报新矩形（DIP，含位置），同尺寸重复通知只报一次", async () => {
    const pageMount = vi.fn(
      async (_input: { id: string; rect: WidgetPageRect }) => ({ ok: true as const }),
    );
    const pageBounds = vi.fn();
    window.__heming_widgets = makePageBridge({ pageMount, pageBounds });

    render(<PluginBundlePage pluginId="heming.panel" />);
    await waitFor(() => expect(pageMount).toHaveBeenCalledTimes(1));

    const observer = FakeResizeObserver.instances.at(-1);
    expect(observer).toBeTruthy();
    expect(observer?.targets.length).toBeGreaterThan(0);

    currentRect = domRect(200, 72, 1000, 618);
    observer?.trigger();
    expect(pageBounds).toHaveBeenCalledTimes(1);
    expect(pageBounds).toHaveBeenCalledWith({
      rect: { x: 200, y: 72, width: 1000, height: 618 },
    });

    // ResizeObserver 常对「同尺寸」重复通知：指纹去重后不再打扰主进程
    observer?.trigger();
    expect(pageBounds).toHaveBeenCalledTimes(1);
  });

  it("卸载时销毁视图，不留孤儿", async () => {
    const pageMount = vi.fn(
      async (_input: { id: string; rect: WidgetPageRect }) => ({ ok: true as const }),
    );
    const pageUnmount = vi.fn();
    window.__heming_widgets = makePageBridge({ pageMount, pageUnmount });

    const view = render(<PluginBundlePage pluginId="heming.panel" />);
    await waitFor(() => expect(pageMount).toHaveBeenCalledTimes(1));
    expect(pageUnmount).not.toHaveBeenCalled();

    view.unmount();
    expect(pageUnmount).toHaveBeenCalledTimes(1);
  });

  it("切到另一个插件页面时先销毁旧视图再挂新视图", async () => {
    const pageMount = vi.fn(
      async (_input: { id: string; rect: WidgetPageRect }) => ({ ok: true as const }),
    );
    const pageUnmount = vi.fn();
    window.__heming_widgets = makePageBridge({
      pageMount,
      pageUnmount,
      list: async () => [
        record(),
        record({ id: "acme.second", name: "第二面板", page: { ...PAGE, title: "第二面板" } }),
      ],
    });

    const view = render(<PluginBundlePage pluginId="heming.panel" />);
    await waitFor(() => expect(pageMount).toHaveBeenCalledTimes(1));

    view.rerender(<PluginBundlePage pluginId="acme.second" />);
    await waitFor(() => expect(pageMount).toHaveBeenCalledTimes(2));
    expect(pageMount.mock.calls[1]?.[0]?.id).toBe("acme.second");
    expect(pageUnmount).toHaveBeenCalled();
    expect(screen.getByText("第二面板")).toBeTruthy();
  });
});

describe("PluginBundlePage · 错误态", () => {
  it("主进程返回 error：显示原因 + 「重建视图」「打开插件详情」", async () => {
    const pageMount = vi.fn(
      async (_input: { id: string; rect: WidgetPageRect }) => ({
        ok: false as const,
        error: "页面入口不在包内：page/index.html",
      }),
    );
    window.__heming_widgets = makePageBridge({ pageMount });

    render(<PluginBundlePage pluginId="heming.panel" />);

    const alert = await screen.findByRole("alert");
    expect(within(alert).getByText("插件页面没能显示出来")).toBeTruthy();
    expect(within(alert).getByText(/页面入口不在包内/)).toBeTruthy();

    // 重建视图 = 再挂一次（旧视图由主进程 pageMount 自己替换）
    fireEvent.click(within(alert).getByRole("button", { name: "重建视图" }));
    await waitFor(() => expect(pageMount).toHaveBeenCalledTimes(2));
    expect(await screen.findByRole("alert")).toBeTruthy();

    // 打开插件详情 → 插件区（可在那里启停/更新/卸载）
    fireEvent.click(
      within(screen.getByRole("alert")).getByRole("button", { name: "打开插件详情" }),
    );
    expect(useUiStore.getState().page).toBe("plugins");
  });

  it("IPC 本身失败（reject）也走错误态，而不是白屏", async () => {
    const pageMount = vi.fn(async (_input: { id: string; rect: WidgetPageRect }) => {
      throw new Error("桥未就绪");
    });
    window.__heming_widgets = makePageBridge({ pageMount });

    render(<PluginBundlePage pluginId="heming.panel" />);

    const alert = await screen.findByRole("alert");
    expect(within(alert).getByText(/挂载插件页面失败：桥未就绪/)).toBeTruthy();
  });
});

describe("PluginBundlePage · 空态", () => {
  it("没有安装记录时给空态，不发 pageMount", async () => {
    const pageMount = vi.fn(
      async (_input: { id: string; rect: WidgetPageRect }) => ({ ok: true as const }),
    );
    window.__heming_widgets = makePageBridge({ pageMount, list: async () => [] });

    render(<PluginBundlePage pluginId="heming.gone" />);

    expect(await screen.findByText("这个插件没有页面或已被停用")).toBeTruthy();
    expect(screen.getByText(/没有找到这个插件的安装记录/)).toBeTruthy();
    expect(pageMount).not.toHaveBeenCalled();
  });

  it("停用的插件不给入口，也不挂视图", async () => {
    const pageMount = vi.fn(
      async (_input: { id: string; rect: WidgetPageRect }) => ({ ok: true as const }),
    );
    window.__heming_widgets = makePageBridge({
      pageMount,
      list: async () => [record({ enabled: false })],
    });

    render(<PluginBundlePage pluginId="heming.panel" />);

    expect(await screen.findByText("这个插件没有页面或已被停用")).toBeTruthy();
    expect(screen.getByText(/已被停用，启用后才会显示/)).toBeTruthy();
    expect(pageMount).not.toHaveBeenCalled();
  });

  it("清单没有 page 的插件给空态", async () => {
    const pageMount = vi.fn(
      async (_input: { id: string; rect: WidgetPageRect }) => ({ ok: true as const }),
    );
    window.__heming_widgets = makePageBridge({
      pageMount,
      list: async () => [record({ page: undefined })],
    });

    render(<PluginBundlePage pluginId="heming.panel" />);

    expect(await screen.findByText("这个插件没有页面或已被停用")).toBeTruthy();
    expect(screen.getByText(/没有声明页面/)).toBeTruthy();
    expect(pageMount).not.toHaveBeenCalled();
  });
});

describe("widgets store · page 透传", () => {
  it("widgets:list 的 page 字段原样进 store，不被裁剪", async () => {
    const page = { title: "我的面板", icon: "layout", summary: "", entry: "page/index.html" };
    window.__heming_widgets = makePageBridge({ list: async () => [record({ page })] });

    await refreshWidgets();

    expect(widgetRecord("heming.panel")?.page).toEqual(page);
  });
});
