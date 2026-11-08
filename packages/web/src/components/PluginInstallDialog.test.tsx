import { beforeEach, describe, expect, it, vi } from "vitest";
import { fireEvent, render, screen, waitFor } from "@testing-library/react";
import { PluginInstallDialog } from "./PluginInstallDialog.js";
import { resetWidgetsStore } from "../lib/widgets/store.js";
import { PET_PREFS_LEGACY_KEY } from "../lib/widgets/legacy.js";
import type { WidgetInstallResult, WidgetRecord, WidgetsBridge } from "../types/widgets.js";
import type { CatalogClientDeps } from "../lib/plugins/catalogClient.js";

/**
 * 「安装桌面小组件」弹窗（d.98 §4.2）：
 * - 云端 bundle 与本地 .tgz 都必须**二次确认**，文案写明「包含可执行界面代码」「来源」；
 * - 云端下载后校验 sha256/大小，校验不过不装；
 * - 首次安装 heming.pet 成功后把旧 localStorage 偏好交给主进程做迁移。
 */

const PACKAGE_BYTES = new Uint8Array([31, 139, 8, 0, 1, 2, 3, 4]);
const SHA = "c".repeat(64);

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
      scales: [1],
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

const ENTRY = {
  id: "heming.pet",
  name: "桌宠",
  version: "1.0.0",
  schemaVersion: 4,
  description: "桌面上的 Live2D 化身",
  author: "和鸣",
  publishedAt: "2026-11-07T12:00:00.000Z",
  sha256: "a".repeat(64),
  size: 512,
  distribution: "bundle" as const,
  package: { sha256: SHA, size: PACKAGE_BYTES.byteLength },
  permissions: { network: [], tools: "none" as const, files: [] },
  contributions: {
    skills: 0,
    mcpServers: 0,
    commands: 0,
    toolPacks: 0,
    desktopWidgets: 1,
    llmPresets: 0,
  },
};

function catalogDeps(overrides: Partial<CatalogClientDeps> = {}): CatalogClientDeps {
  return {
    apiImpl: async () => ({ plugins: [ENTRY], generatedAt: "2026-11-07T12:00:00.000Z" }),
    fetchImpl: async () =>
      new Response(PACKAGE_BYTES as unknown as BodyInit, {
        status: 200,
        headers: { "x-plugin-sha256": SHA },
      }),
    sha256Hex: async () => SHA,
    ...overrides,
  };
}

function makeBridge(overrides: Partial<WidgetsBridge> = {}): WidgetsBridge {
  return {
    list: async () => [],
    pickPackage: async () => ({ canceled: true }),
    install: async () => ({ ok: true, record: record() }),
    installFromFile: async () => ({ ok: true, record: record() }),
    uninstall: async () => ({ ok: true }),
    setEnabled: async () => ({ ok: true }),
    settingsGet: async () => ({}),
    settingsSet: async () => ({}),
    action: async () => ({ ok: true }),
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

describe("PluginInstallDialog · 风险声明与来源", () => {
  it("常驻声明「包含可执行界面代码」并列出云端 bundle（官方目录 / 可执行 / 指纹）", async () => {
    window.__heming_widgets = makeBridge();
    render(<PluginInstallDialog onClose={() => {}} catalog={catalogDeps()} />);
    expect(screen.getByText("本插件包含可执行界面代码")).toBeTruthy();
    expect(await screen.findByText("桌宠")).toBeTruthy();
    expect(screen.getByText("官方目录")).toBeTruthy();
    expect(screen.getByText(/指纹 cccccccc/)).toBeTruthy();
  });

  it("浏览器（无桥）给出「仅安装版可用」，不列安装按钮", () => {
    render(<PluginInstallDialog onClose={() => {}} catalog={catalogDeps()} />);
    expect(screen.getByText(/桌面小组件只在安装版里可用/)).toBeTruthy();
    expect(screen.queryByRole("button", { name: "下载并安装" })).toBeNull();
  });
});

describe("PluginInstallDialog · 云端安装", () => {
  it("二次确认后下载 → 校验 → 交给主进程安装；首次装 heming.pet 迁移老偏好", async () => {
    localStorage.setItem(PET_PREFS_LEGACY_KEY, JSON.stringify({ enabled: true, agentId: "a1" }));
    const install = vi.fn(
      async (_input: {
        bytes: ArrayBuffer;
        expectedSha256?: string;
      }): Promise<WidgetInstallResult> => ({ ok: true, record: record() }),
    );
    const migrateLegacy = vi.fn(async () => ({ ok: true }));
    const onInstalled = vi.fn();
    window.__heming_widgets = makeBridge({ install, migrateLegacy });
    render(
      <PluginInstallDialog onClose={() => {}} onInstalled={onInstalled} catalog={catalogDeps()} />,
    );

    fireEvent.click(await screen.findByRole("button", { name: "下载并安装" }));
    // 确认面板：来源与风险都要再写一遍
    expect(screen.getByText(/来源：官方云端目录/)).toBeTruthy();
    expect(screen.getByText(/包含可执行界面代码，安装后会在独立窗口里运行/)).toBeTruthy();
    fireEvent.click(screen.getByRole("button", { name: "确认安装" }));

    await waitFor(() => expect(install).toHaveBeenCalledTimes(1));
    const arg = install.mock.calls[0][0];
    expect(new Uint8Array(arg.bytes)).toEqual(PACKAGE_BYTES);
    expect(arg.expectedSha256).toBe(SHA);
    await waitFor(() =>
      expect(migrateLegacy).toHaveBeenCalledWith({
        prefs: { enabled: true, agentId: "a1" },
      }),
    );
    expect(onInstalled).toHaveBeenCalledWith(expect.stringContaining("桌宠"));
    expect(await screen.findByText(/已安装桌面小组件「桌宠」/)).toBeTruthy();
  });

  it("指纹不一致 → 不安装并给中文错误", async () => {
    const install = vi.fn(
      async (): Promise<WidgetInstallResult> => ({ ok: true, record: record() }),
    );
    window.__heming_widgets = makeBridge({ install });
    render(
      <PluginInstallDialog
        onClose={() => {}}
        catalog={catalogDeps({ sha256Hex: async () => "d".repeat(64) })}
      />,
    );
    fireEvent.click(await screen.findByRole("button", { name: "下载并安装" }));
    fireEvent.click(screen.getByRole("button", { name: "确认安装" }));
    expect(await screen.findByRole("alert")).toHaveTextContent(/指纹不一致/);
    expect(install).not.toHaveBeenCalled();
  });

  it("主进程拒绝安装（如非官方签名）→ 展示它的中文原因", async () => {
    window.__heming_widgets = makeBridge({
      install: async () => ({ ok: false, error: "非官方签名，已拒绝安装" }),
    });
    render(<PluginInstallDialog onClose={() => {}} catalog={catalogDeps()} />);
    fireEvent.click(await screen.findByRole("button", { name: "下载并安装" }));
    fireEvent.click(screen.getByRole("button", { name: "确认安装" }));
    expect(await screen.findByRole("alert")).toHaveTextContent(/非官方签名/);
  });

  it("目录不可用只影响云端面板，本地安装路径仍在", async () => {
    window.__heming_widgets = makeBridge();
    render(
      <PluginInstallDialog
        onClose={() => {}}
        catalog={catalogDeps({
          apiImpl: async () => {
            throw new Error("http 502");
          },
        })}
      />,
    );
    expect(await screen.findByRole("alert")).toHaveTextContent(/云端插件目录不可用/);
    expect(screen.getByRole("button", { name: "选择本地 .tgz" })).toBeTruthy();
  });
});

describe("PluginInstallDialog · 本地 .tgz", () => {
  it("二次确认后由主进程开文件框安装（渲染层不碰 fs）", async () => {
    const installFromFile = vi.fn(
      async (): Promise<WidgetInstallResult> => ({ ok: true, record: record() }),
    );
    window.__heming_widgets = makeBridge({ installFromFile });
    render(<PluginInstallDialog onClose={() => {}} catalog={catalogDeps()} />);

    fireEvent.click(await screen.findByRole("button", { name: "选择本地 .tgz" }));
    expect(screen.getByText("确认安装本地插件包？")).toBeTruthy();
    expect(screen.getByText(/本地包来源由你自己确认/)).toBeTruthy();
    fireEvent.click(screen.getByRole("button", { name: "选择并安装" }));
    await waitFor(() => expect(installFromFile).toHaveBeenCalledTimes(1));
    expect(await screen.findByText(/已安装桌面小组件/)).toBeTruthy();
  });

  it("取消本地安装不调用主进程", async () => {
    const installFromFile = vi.fn(
      async (): Promise<WidgetInstallResult> => ({ ok: true, record: record() }),
    );
    window.__heming_widgets = makeBridge({ installFromFile });
    render(<PluginInstallDialog onClose={() => {}} catalog={catalogDeps()} />);
    fireEvent.click(await screen.findByRole("button", { name: "选择本地 .tgz" }));
    fireEvent.click(screen.getByRole("button", { name: "取消" }));
    expect(screen.getByRole("button", { name: "选择本地 .tgz" })).toBeTruthy();
    expect(installFromFile).not.toHaveBeenCalled();
  });
});
