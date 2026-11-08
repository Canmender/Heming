import { describe, expect, it, vi } from "vitest";
import { fireEvent, render, screen, waitFor, within } from "@testing-library/react";
import type { MarketPlugin, MarketVersion, PluginCatalogEntry } from "@heming/shared";
import { MarketDetailDialog } from "./MarketDetailDialog.js";

/**
 * 市场详情（d.108）：概述/贡献/版本历史三块、版本兼容与不可安装原因、
 * 详情加载失败重试、弃用迁移提示。清单与详情都走注入，不联网。
 */

const SHA = "a".repeat(64);
const PKG = "b".repeat(64);

function version(overrides: Partial<MarketVersion> = {}): MarketVersion {
  return {
    version: "1.0.0",
    publishedAt: "2026-11-08T00:00:00.000Z",
    schemaVersion: 3,
    engines: { heming: "d.100" },
    distribution: "manifest",
    sha256: SHA,
    size: 4096,
    ...overrides,
  };
}

const PLUGIN: MarketPlugin = {
  id: "acme.report-kit",
  title: "报告工具箱",
  description: "周报与月报",
  author: "ACME",
  homepage: "https://acme.example/report",
  repository: "https://github.com/acme/report-kit",
  metadata: { category: "efficiency", tags: ["official"], keywords: ["周报"] },
  updatedAt: "2026-11-08T00:00:00.000Z",
  versions: [
    version({ version: "1.0.0" }),
    version({ version: "2.0.0", engines: { heming: "d.200" } }),
    version({ version: "1.1.0", status: "deleted" }),
    version({ version: "0.9.0", status: "deprecated", statusMessage: "请升级到 1.0.0" }),
    version({
      version: "1.2.0",
      distribution: "bundle",
      // 与 2.0.0 一样要求新宿主：默认在 d.105 下不会被 pickInstallVersion 选中，
      // 本文件的「声明式三块」用例仍以 1.0.0 为默认版本（bundle 专项用例自己抬 hostVersion）。
      engines: { heming: "d.200" },
      package: { sha256: PKG, size: 1234 },
    }),
  ],
};

function manifestFor(entry: PluginCatalogEntry): string {
  if (entry.distribution === "bundle" && entry.package) {
    // d.109：bundle 清单走 v4 形状（桌面小部件），详情页只用来算「贡献」块
    return JSON.stringify({
      schemaVersion: 4,
      id: entry.id,
      name: "报告工具箱",
      version: entry.version,
      description: "周报与月报",
      author: "ACME",
      distribution: "bundle",
      permissions: { network: [], tools: "none", files: [], events: [], graphics: [], eval: false },
      contributions: {
        desktopWidgets: [
          { id: "report", name: "报告", entry: "files/index.html", width: 300, height: 200 },
        ],
        commands: [],
        skills: [],
        mcpServers: [],
        toolPacks: [],
      },
    });
  }
  return JSON.stringify({
    schemaVersion: 3,
    id: entry.id,
    name: "报告工具箱",
    version: entry.version,
    description: "周报与月报",
    permissions: { network: [], tools: "read", files: [] },
    contributions: {
      skills: [{ name: "周报", instructions: "写周报" }],
      commands: [
        {
          id: "weekly",
          title: "生成周报",
          keywords: ["周报"],
          target: { kind: "skill", name: "周报" },
        },
      ],
    },
  });
}

function renderDialog(overrides: Partial<Parameters<typeof MarketDetailDialog>[0]> = {}) {
  const onClose = vi.fn();
  const onInstall = vi.fn(async () => {});
  render(
    <MarketDetailDialog
      plugin={PLUGIN}
      hostVersion="d.105"
      installed={[{ id: "acme.report-kit", version: "1.0.0" }]}
      onClose={onClose}
      onInstall={onInstall}
      loadManifest={async (entry) => manifestFor(entry)}
      loadDetail={async () => "## 版本说明\n\n周报与月报的详细介绍。"}
      {...overrides}
    />,
  );
  return { onClose, onInstall };
}

describe("MarketDetailDialog · 三块", () => {
  it("概述/贡献/版本历史都渲染，贡献来自真实清单而不是索引", async () => {
    renderDialog();
    const dialog = screen.getByRole("dialog", { name: "市场详情 报告工具箱" });
    const overview = within(dialog).getByRole("region", { name: "概述" });
    expect(overview).toHaveTextContent("周报与月报");
    expect(overview).toHaveTextContent("ACME");
    expect(overview).toHaveTextContent("分类 · efficiency");
    expect(overview).toHaveTextContent("标签 · official");
    expect(within(overview).getByText("主页")).toHaveAttribute(
      "href",
      "https://acme.example/report",
    );
    expect(within(overview).getByText("仓库")).toHaveAttribute(
      "href",
      "https://github.com/acme/report-kit",
    );

    const contributions = within(dialog).getByRole("region", { name: "贡献" });
    expect(await within(contributions).findByText("技能 1")).toBeInTheDocument();
    expect(within(contributions).getByText("命令 1")).toBeInTheDocument();
    expect(within(contributions).getByText("网络主机 0")).toBeInTheDocument();
    expect(within(contributions).getByText("周报")).toBeInTheDocument();

    const history = within(dialog).getByRole("region", { name: "版本历史" });
    expect(history).toHaveTextContent("v2.0.0");
    expect(history).toHaveTextContent("已删除");
    expect(within(dialog).getByRole("region", { name: "详细介绍" })).toBeInTheDocument();
    expect(await within(dialog).findByText("版本说明")).toBeInTheDocument();
  });

  it("不兼容/已删除版本不可安装并写明原因；弃用版本给迁移说明", async () => {
    renderDialog();
    const history = screen.getByRole("region", { name: "版本历史" });
    expect(history).toHaveTextContent("需要和鸣 d.200 或更高（当前 d.105）");
    expect(history).toHaveTextContent("该版本已删除，不可安装");
    expect(screen.getAllByRole("button", { name: "不可安装" })).toHaveLength(3);
    fireEvent.click(within(history).getByRole("button", { name: "v0.9.0" }));
    expect(history).toHaveTextContent("请升级到 1.0.0");
  });

  it("无桌面桥时 bundle 版本禁用并写明「仅桌面版可安装界面插件」", () => {
    const bridgePlugin: MarketPlugin = {
      ...PLUGIN,
      versions: [
        version({ version: "1.0.0" }),
        version({ version: "1.2.0", distribution: "bundle", package: { sha256: PKG, size: 1234 } }),
      ],
    };
    renderDialog({ plugin: bridgePlugin, widgetInstallAvailable: false });
    const history = screen.getByRole("region", { name: "版本历史" });
    expect(history).toHaveTextContent("仅桌面版可安装界面插件");
    expect(screen.getAllByRole("button", { name: "不可安装" })).toHaveLength(1);
  });

  it("桌面桥可用时 bundle 版本可安装，点击把 bundle 条目交给页面（d.109）", async () => {
    const { onInstall } = renderDialog({ hostVersion: "d.300", widgetInstallAvailable: true });
    const history = screen.getByRole("region", { name: "版本历史" });
    expect(history).not.toHaveTextContent("仅桌面版可安装界面插件");
    // v1.2.0 是 bundle 版本：没有「不可安装」原因，按钮可点
    const row = within(history).getByText("v1.2.0").closest("li") as HTMLElement;
    const button = within(row).getByRole("button", { name: "更新到此版本" });
    expect(button).toBeEnabled();
    fireEvent.click(button);
    await waitFor(() => expect(onInstall).toHaveBeenCalledTimes(1));
    const call = onInstall.mock.calls[0] as unknown as [PluginCatalogEntry, MarketVersion];
    expect(call[0]).toMatchObject({
      id: "acme.report-kit",
      version: "1.2.0",
      distribution: "bundle",
      package: { sha256: PKG, size: 1234 },
    });
    expect(call[1].distribution).toBe("bundle");
  });

  it("安装按钮把所选版本的 PluginCatalogEntry 交给页面（复用既有安装预览）", async () => {
    const loadManifest = vi.fn(async (entry: PluginCatalogEntry) => manifestFor(entry));
    const { onInstall } = renderDialog({ loadManifest });
    await screen.findByText("技能 1");
    await waitFor(() => expect(loadManifest).toHaveBeenCalled());
    fireEvent.click(screen.getByRole("button", { name: "重新安装" }));
    await waitFor(() => expect(onInstall).toHaveBeenCalledTimes(1));
    const call = onInstall.mock.calls[0] as unknown as [PluginCatalogEntry, MarketVersion];
    expect(call[0]).toMatchObject({
      id: "acme.report-kit",
      version: "1.0.0",
      sha256: SHA,
      distribution: "manifest",
    });
    expect(call[1].version).toBe("1.0.0");
  });

  it("详细介绍加载失败给重试；重试成功后渲染 markdown", async () => {
    const loadDetail = vi
      .fn<() => Promise<string | null>>()
      .mockRejectedValueOnce(new Error("详情加载失败：HTTP 500"))
      .mockResolvedValueOnce("# 恢复成功");
    renderDialog({ loadDetail });
    expect(await screen.findByText(/详细介绍加载失败/)).toBeInTheDocument();
    fireEvent.click(screen.getByRole("button", { name: "重试" }));
    expect(await screen.findByText("恢复成功")).toBeInTheDocument();
  });
});

describe("MarketDetailDialog · 生命周期", () => {
  it("整插件弃用：展示原因并提示迁移到替代插件", () => {
    renderDialog({
      plugin: {
        ...PLUGIN,
        status: "deprecated",
        deprecatedReason: "已由新版取代",
        alternativeId: "acme.report-kit-v2",
      },
    });
    const dialog = screen.getByRole("dialog", { name: "市场详情 报告工具箱" });
    expect(dialog).toHaveTextContent("该插件已弃用");
    expect(dialog).toHaveTextContent("已由新版取代");
    expect(dialog).toHaveTextContent("建议迁移到「acme.report-kit-v2」");
  });
});
