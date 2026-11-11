import { beforeEach, describe, expect, it, vi } from "vitest";
import type {
  WidgetInstallResult,
  WidgetRecord,
  WidgetsBridge,
} from "../../types/widgets.js";
import {
  installWidgetFromBytes,
  installWidgetFromFile,
  refreshWidgets,
  resetWidgetsStore,
  runWidgetAction,
  saveWidgetSettings,
  setWidgetEnabled,
  uninstallWidget,
  useWidgetsStore,
  widgetRecord,
  widgetsAvailable,
} from "./store.js";

/**
 * 插件主窗 store（d.98）：
 * - 所有数据经 `window.__heming_widgets` 从主进程读，本模块不碰 localStorage；
 * - 业务失败统一成中文 `{ ok:false, error }`，界面只展示；
 * - 单条记录的状态读失败不拖垮整个列表（坏记录要能显示出来而不是消失）。
 */

const WIDGET = {
  id: "pet",
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
    clickThrough: "auto" as const,
    position: { anchor: "bottom-right", margin: 24, remember: true },
  },
};

function record(overrides: Partial<WidgetRecord> = {}): WidgetRecord {
  return {
    id: "heming.pet",
    name: "桌宠",
    version: "1.0.0",
    enabled: true,
    widget: structuredClone(WIDGET.widget),
    settings: { presence: "normal" },
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
    settingsGet: async () => ({ presence: "normal" }),
    settingsSet: async (_input) => ({ presence: "normal" }),
    action: async () => ({ ok: true, state: { visible: true, scale: 1, clickThrough: false } }),
    state: async () => ({ visible: false, scale: 1, clickThrough: false }),
    publish: () => {},
    migrateLegacy: async () => ({ ok: true }),
    ...overrides,
  } as WidgetsBridge;
}

beforeEach(() => {
  resetWidgetsStore();
  delete window.__heming_widgets;
});

describe("refreshWidgets", () => {
  it("浏览器（无桥）→ loaded 且空列表，不报错", async () => {
    expect(widgetsAvailable()).toBe(false);
    await refreshWidgets();
    const state = useWidgetsStore.getState();
    expect(state.loaded).toBe(true);
    expect(state.records).toEqual([]);
    expect(state.states).toEqual({});
    expect(state.error).toBeNull();
  });

  it("有桥：读列表 + 逐条读窗口状态", async () => {
    window.__heming_widgets = makeBridge();
    await refreshWidgets();
    const state = useWidgetsStore.getState();
    expect(state.records).toHaveLength(1);
    expect(state.records[0].name).toBe("桌宠");
    expect(state.states["heming.pet"]).toEqual({ visible: false, scale: 1, clickThrough: false });
    expect(state.loaded).toBe(true);
  });

  it("单条 state 读失败只丢该条运行态，列表照常", async () => {
    window.__heming_widgets = makeBridge({
      state: async () => {
        throw new Error("窗口没起来");
      },
    });
    await refreshWidgets();
    const state = useWidgetsStore.getState();
    expect(state.records).toHaveLength(1);
    expect(state.states).toEqual({});
    expect(state.error).toBeNull();
  });

  it("列表读取失败 → 中文 error，保留 loaded", async () => {
    window.__heming_widgets = makeBridge({
      list: async () => {
        throw new Error("IPC 挂了");
      },
    });
    await refreshWidgets();
    const state = useWidgetsStore.getState();
    expect(state.loaded).toBe(true);
    expect(state.records).toEqual([]);
    expect(state.error).toContain("读取桌面小组件失败");
    expect(state.error).toContain("IPC 挂了");
  });
});

describe("启停 / 卸载", () => {
  it("setWidgetEnabled 透传 id/enabled 并刷新", async () => {
    const setEnabled = vi.fn(async () => ({ ok: true, record: record({ enabled: false }) }));
    window.__heming_widgets = makeBridge({ setEnabled });
    await setWidgetEnabled("heming.pet", false);
    expect(setEnabled).toHaveBeenCalledWith({ id: "heming.pet", enabled: false });
    expect(useWidgetsStore.getState().records[0].enabled).toBe(true); // refresh 用 list 的返回值
  });

  it("主进程拒绝时返回它的中文错误", async () => {
    window.__heming_widgets = makeBridge({
      setEnabled: async () => ({ ok: false, error: "无签名来源，拒绝启用" }),
    });
    const result = await setWidgetEnabled("heming.pet", true);
    expect(result).toEqual({ ok: false, error: "无签名来源，拒绝启用" });
  });

  it("uninstall 默认 removeData:true（删文件与设置）", async () => {
    const uninstall = vi.fn(async () => ({ ok: true }));
    window.__heming_widgets = makeBridge({ uninstall, list: async () => [] });
    const result = await uninstallWidget("heming.pet");
    expect(result.ok).toBe(true);
    expect(uninstall).toHaveBeenCalledWith({ id: "heming.pet", removeData: true });
    expect(widgetRecord("heming.pet")).toBeUndefined();
  });
});

describe("窗口动作与设置", () => {
  it("runWidgetAction 成功后缓存新状态", async () => {
    window.__heming_widgets = makeBridge();
    const result = await runWidgetAction("heming.pet", "toggle");
    expect(result.ok).toBe(true);
    expect(useWidgetsStore.getState().states["heming.pet"].visible).toBe(true);
  });

  it("动作返回 state 缺失时回读一次", async () => {
    const state = vi.fn(async () => ({ visible: true, scale: 1.25, clickThrough: true }));
    window.__heming_widgets = makeBridge({
      action: async () => ({ ok: true }),
      state,
    });
    const result = await runWidgetAction("heming.pet", "scaleUp");
    expect(state).toHaveBeenCalledWith({ id: "heming.pet" });
    expect(result.state).toEqual({ visible: true, scale: 1.25, clickThrough: true });
  });

  it("saveWidgetSettings 合并后的全量值写回记录", async () => {
    window.__heming_widgets = makeBridge({
      settingsSet: async () => ({ presence: "quiet", modelPath: "pet/Hiyori/Hiyori.model3.json" }),
    });
    await refreshWidgets();
    const result = await saveWidgetSettings("heming.pet", { presence: "quiet" });
    expect(result.ok).toBe(true);
    expect(widgetRecord("heming.pet")?.settings.presence).toBe("quiet");
  });
});

describe("安装", () => {
  it("installWidgetFromBytes 透传字节与期望指纹，并标记为覆盖更新", async () => {
    const install = vi.fn(async (_input: { bytes: ArrayBuffer; expectedSha256?: string }) => ({
      ok: true as const,
      record: record(),
    }));
    window.__heming_widgets = makeBridge({ install });
    const bytes = new ArrayBuffer(8);
    // 先让 store 里已有同 id 记录 → updated
    await refreshWidgets();
    const outcome = await installWidgetFromBytes(bytes, { expectedSha256: "a".repeat(64) });
    expect(install).toHaveBeenCalledWith({ bytes, expectedSha256: "a".repeat(64) });
    expect(outcome.ok).toBe(true);
    expect(outcome.updated).toBe(true);
  });

  it("首次安装（列表里没有）→ updated:false", async () => {
    window.__heming_widgets = makeBridge({
      install: async () => ({ ok: true as const, record: record() }),
    });
    const outcome = await installWidgetFromBytes(new ArrayBuffer(4));
    expect(outcome.ok).toBe(true);
    expect(outcome.updated).toBe(false);
  });

  it("installFromFile 由主进程开文件框，渲染层不碰 fs", async () => {
    const installFromFile = vi.fn(
      async (): Promise<WidgetInstallResult> => ({ ok: true, record: record() }),
    );
    window.__heming_widgets = makeBridge({ installFromFile });
    const outcome = await installWidgetFromFile();
    expect(installFromFile).toHaveBeenCalledTimes(1);
    expect(outcome.ok).toBe(true);
  });

  it("安装失败返回主进程的中文原因", async () => {
    window.__heming_widgets = makeBridge({
      install: async () => ({ ok: false, error: "非官方签名，已拒绝安装" }),
    });
    const outcome = await installWidgetFromBytes(new ArrayBuffer(4));
    expect(outcome).toEqual({ ok: false, error: "非官方签名，已拒绝安装" });
  });
});
