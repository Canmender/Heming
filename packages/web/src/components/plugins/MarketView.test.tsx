import { describe, expect, it, vi } from "vitest";
import { fireEvent, render, screen, waitFor, within } from "@testing-library/react";
import type { MarketIndex, MarketPlugin, MarketVersion } from "@heming/shared";
import { MarketView } from "./MarketView.js";
import type { MarketIndexResult } from "../../lib/plugins/marketClient.js";

/**
 * 市场列表（d.108）：分类/标签/搜索/排序/徽标/空态/失败重试/不可用回落回调。
 * 索引由 `loadIndex` 注入，不联网。
 */

const SHA = "a".repeat(64);

function version(overrides: Partial<MarketVersion> = {}): MarketVersion {
  return {
    version: "1.0.0",
    publishedAt: "2026-11-08T00:00:00.000Z",
    schemaVersion: 3,
    engines: { heming: "d.100" },
    distribution: "manifest",
    sha256: SHA,
    size: 2048,
    ...overrides,
  };
}

function plugin(overrides: Partial<MarketPlugin> = {}): MarketPlugin {
  return {
    id: "acme.report-kit",
    title: "报告工具箱",
    description: "周报与月报",
    author: "ACME",
    metadata: {
      category: "efficiency",
      tags: ["official"],
      keywords: ["周报"],
      sortKeys: { downloads: 10 },
    },
    updatedAt: "2026-11-08T00:00:00.000Z",
    versions: [version()],
    ...overrides,
  };
}

function index(plugins: MarketPlugin[]): MarketIndex {
  return {
    format: 1,
    title: "和鸣插件目录",
    generatedAt: "2026-11-08T00:00:00.000Z",
    categories: {
      efficiency: { title: "效率" },
      integration: { title: "集成" },
    },
    tags: { official: { title: "官方" }, "read-only": { title: "只读" } },
    sortKeys: { downloads: { title: "下载量", order: "desc" } },
    plugins,
  };
}

function result(plugins: MarketPlugin[]): MarketIndexResult {
  return { index: index(plugins), warnings: [], source: "v2" };
}

const PLUGINS: MarketPlugin[] = [
  plugin(),
  plugin({
    id: "acme.weather",
    title: "天气能力包",
    description: "出行天气建议",
    author: "Acme",
    updatedAt: "2026-11-07T00:00:00.000Z",
    metadata: {
      category: "integration",
      tags: ["official"],
      keywords: ["天气"],
      sortKeys: { downloads: 99 },
    },
    versions: [version({ version: "1.2.0" })],
  }),
  plugin({
    id: "acme.deprecated",
    title: "旧插件",
    description: "旧版能力",
    metadata: { category: "efficiency", tags: [], keywords: [], sortKeys: { downloads: 1 } },
    status: "deprecated",
    deprecatedReason: "已被报告工具箱取代",
    alternativeId: "acme.report-kit",
    versions: [version()],
  }),
  plugin({
    id: "acme.future",
    title: "未来插件",
    description: "未来版本要求",
    author: "Future",
    metadata: { category: "efficiency", tags: [], keywords: [], sortKeys: { downloads: 2 } },
    versions: [version({ engines: { heming: "d.200" } })],
  }),
  plugin({
    id: "acme.removed",
    title: "已下架插件",
    description: "已下架",
    metadata: { category: "efficiency", tags: [], keywords: [], sortKeys: { downloads: 0 } },
    status: "removed",
    versions: [version()],
  }),
];

describe("MarketView · 列表", () => {
  it("渲染卡片与徽标：已装/可更新/需要更新和鸣/已弃用；removed 隐藏", async () => {
    render(
      <MarketView
        hostVersion="d.105"
        installed={[
          { id: "acme.report-kit", version: "0.9.0" },
          { id: "acme.deprecated", version: "1.0.0" },
        ]}
        loadIndex={async () => result(PLUGINS)}
      />,
    );
    expect(await screen.findByText("报告工具箱")).toBeInTheDocument();
    expect(screen.getByText("天气能力包")).toBeInTheDocument();
    expect(screen.getByText("可更新")).toBeInTheDocument();
    expect(screen.getByText("已安装 v1.0.0")).toBeInTheDocument();
    expect(screen.getByText("需要更新和鸣（≥d.200）")).toBeInTheDocument();
    expect(screen.getByText("已弃用")).toBeInTheDocument();
    expect(screen.queryByText("已下架插件")).toBeNull();
    expect(screen.queryByText("acme.removed")).toBeNull();
    expect(screen.getByText("共 5 个插件")).toBeInTheDocument();
  });

  it("分类 chips、标签多选与搜索（250ms 防抖）都生效", async () => {
    render(<MarketView hostVersion="d.105" loadIndex={async () => result(PLUGINS)} />);
    expect(await screen.findByText("报告工具箱")).toBeInTheDocument();

    // 分类：集成 → 只剩天气
    fireEvent.click(screen.getByRole("button", { name: "集成" }));
    expect(screen.queryByText("报告工具箱")).toBeNull();
    expect(screen.getByText("天气能力包")).toBeInTheDocument();
    fireEvent.click(screen.getByRole("button", { name: "全部分类" }));

    // 标签：只读 → 没有插件带该标签
    fireEvent.click(screen.getByRole("button", { name: "标签 只读" }));
    expect(screen.getByRole("region", { name: "市场无结果" })).toBeInTheDocument();
    fireEvent.click(screen.getByRole("button", { name: "标签 只读" }));

    // 搜索（命中关键词「周报」），防抖 250ms
    fireEvent.change(screen.getByLabelText("搜索市场插件"), { target: { value: "周报" } });
    await waitFor(() => expect(screen.queryByText("天气能力包")).toBeNull());
    expect(screen.getByText("报告工具箱")).toBeInTheDocument();
    expect(screen.getByText(/匹配 1 \/ 共 5 个插件/)).toBeInTheDocument();
  });

  it("排序：下载量降序、最近更新降序", async () => {
    render(<MarketView hostVersion="d.105" loadIndex={async () => result(PLUGINS)} />);
    expect(await screen.findByText("报告工具箱")).toBeInTheDocument();
    const list = () => screen.getAllByRole("listitem").map((item) => item.textContent ?? "");

    fireEvent.change(screen.getByLabelText("排序"), { target: { value: "downloads" } });
    expect(list()[0]).toContain("天气能力包");

    fireEvent.change(screen.getByLabelText("排序"), { target: { value: "updated" } });
    expect(list()[0]).toContain("报告工具箱");
  });

  it("索引不可用：展示失败与重试，并回调 onUnavailable（页面据此回落仓库）", async () => {
    const loadIndex = vi
      .fn<() => Promise<MarketIndexResult>>()
      .mockRejectedValueOnce(new Error("市场目录暂未发布（HTTP 404）"))
      .mockResolvedValueOnce(result(PLUGINS));
    const onUnavailable = vi.fn();
    render(
      <MarketView hostVersion="d.105" loadIndex={loadIndex} onUnavailable={onUnavailable} />,
    );

    expect(await screen.findByRole("alert")).toHaveTextContent("市场目录不可用");
    expect(onUnavailable).toHaveBeenCalledWith(expect.stringContaining("HTTP 404"));

    fireEvent.click(screen.getByRole("button", { name: "重试" }));
    expect(await screen.findByText("报告工具箱")).toBeInTheDocument();
  });

  it("搜索无结果给出空态与清除筛选", async () => {
    render(<MarketView hostVersion="d.105" loadIndex={async () => result(PLUGINS)} />);
    await screen.findByText("报告工具箱");
    fireEvent.change(screen.getByLabelText("搜索市场插件"), {
      target: { value: "不存在的插件" },
    });
    const empty = await screen.findByRole("region", { name: "市场无结果" });
    fireEvent.click(within(empty).getByRole("button", { name: "清除筛选" }));
    expect(await screen.findByText("报告工具箱")).toBeInTheDocument();
  });

  it("点卡片「详情」打开详情弹窗（概述/贡献/版本历史三块）", async () => {
    render(
      <MarketView
        hostVersion="d.105"
        loadIndex={async () => result(PLUGINS)}
        loadDetail={async () => "# 报告工具箱\n\n周报与月报。"}
        loadManifest={async () =>
          JSON.stringify({
            schemaVersion: 3,
            id: "acme.report-kit",
            name: "报告工具箱",
            version: "1.0.0",
            permissions: { network: [], tools: "read", files: [] },
            contributions: {
              skills: [{ name: "周报", instructions: "写周报" }],
            },
          })
        }
      />,
    );
    await screen.findByText("报告工具箱");
    fireEvent.click(screen.getByRole("button", { name: "查看 报告工具箱 详情" }));
    const dialog = await screen.findByRole("dialog", { name: "市场详情 报告工具箱" });
    expect(within(dialog).getByRole("region", { name: "概述" })).toBeInTheDocument();
    expect(within(dialog).getByRole("region", { name: "贡献" })).toBeInTheDocument();
    expect(within(dialog).getByRole("region", { name: "版本历史" })).toBeInTheDocument();
  });
});
