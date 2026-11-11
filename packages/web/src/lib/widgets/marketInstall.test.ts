import { describe, expect, it, vi } from "vitest";
import type { PluginCatalogEntry } from "@heming/shared";
import { installBundleFromMarket } from "./marketInstall.js";
import type { DownloadedPluginPackage } from "../plugins/catalogClient.js";
import type { WidgetInstallOutcome } from "./store.js";

/**
 * 市场里直接安装插件（d.109）。
 *
 * 两层都注入：下载（deps 里再验 sha256）与桌面桥安装（主进程验签/落盘）。
 * 这里只钉住「顺序 + 传参 + 结果三态」，真实 IPC 由 desktop 侧用例覆盖。
 */

const ENTRY: PluginCatalogEntry = {
  id: "heming.pet",
  name: "桌宠",
  version: "1.0.1",
  schemaVersion: 4,
  description: "桌面上的 Live2D 化身",
  author: "和鸣",
  publishedAt: "2026-11-08T00:00:00.000Z",
  sha256: "a".repeat(64),
  size: 1234,
  permissions: { network: [], tools: "none", files: [] },
  contributions: { skills: 0, mcpServers: 0, commands: 0, toolPacks: 0, desktopWidgets: 1 },
  distribution: "bundle",
  package: { sha256: "b".repeat(64), size: 1234 },
};

const PKG: DownloadedPluginPackage = {
  bytes: new Uint8Array([1, 2, 3]).buffer,
  sha256: "b".repeat(64),
  size: 3,
};

function outcome(overrides: Partial<WidgetInstallOutcome> = {}): WidgetInstallOutcome {
  return {
    ok: true,
    record: {
      id: "heming.pet",
      name: "桌宠",
      version: "1.0.1",
      enabled: true,
      widget: { id: "pet" } as never,
      settings: {},
      installedAt: "2026-11-08T00:00:00.000Z",
    },
    updated: false,
    ...overrides,
  };
}

describe("installBundleFromMarket", () => {
  it("非插件条目直接拒绝（不尝试下载）", async () => {
    const download = vi.fn();
    const result = await installBundleFromMarket(
      { ...ENTRY, distribution: "manifest", package: undefined } as PluginCatalogEntry,
      { download: download as never },
    );
    expect(result.ok).toBe(false);
    expect(result.error).toContain("不是插件包");
    expect(download).not.toHaveBeenCalled();
  });

  it("下载失败 → 中文错误，不进入安装", async () => {
    const install = vi.fn();
    const result = await installBundleFromMarket(ENTRY, {
      download: async () => {
        throw new Error("HTTP 500");
      },
      install,
    });
    expect(result.ok).toBe(false);
    expect(result.error).toBe("下载失败：HTTP 500");
    expect(install).not.toHaveBeenCalled();
  });

  it("成功：把包字节 + 下载层实测 sha256 一起交给桌面桥；返回 record/updated", async () => {
    const download = vi.fn(async () => PKG);
    const install = vi.fn(async (_bytes: ArrayBuffer, options?: { expectedSha256?: string }) =>
      outcome({ updated: true }),
    );
    const result = await installBundleFromMarket(ENTRY, {
      download: download as never,
      install: install as never,
    });
    expect(download).toHaveBeenCalledWith(ENTRY);
    expect(install).toHaveBeenCalledWith(PKG.bytes, { expectedSha256: PKG.sha256 });
    expect(result).toMatchObject({ ok: true, updated: true, record: { id: "heming.pet", version: "1.0.1" } });
  });

  it("桌面桥返回业务失败（如首方验签失败）→ 原样透出中文错误", async () => {
    const result = await installBundleFromMarket(ENTRY, {
      download: async () => PKG,
      install: async () => ({ ok: false, error: "未通过首方签名（publisher: heming），已拒绝安装" }),
    });
    expect(result).toEqual({ ok: false, error: "未通过首方签名（publisher: heming），已拒绝安装" });
  });

  it("安装抛错 → 包成中文「安装失败」", async () => {
    const result = await installBundleFromMarket(ENTRY, {
      download: async () => PKG,
      install: async () => {
        throw new Error("IPC 断开");
      },
    });
    expect(result).toEqual({ ok: false, error: "安装失败：IPC 断开" });
  });

  it("无桌面桥（默认 installWidgetFromBytes）→ 明确提示仅桌面端可用", async () => {
    const result = await installBundleFromMarket(ENTRY, { download: async () => PKG });
    expect(result.ok).toBe(false);
    expect(result.error).toContain("仅桌面端可用");
  });
});
