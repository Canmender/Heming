import { describe, expect, it, vi } from "vitest";
import type { MarketIndex, MarketPlugin, MarketVersion } from "@heming/shared";
import {
  MarketUnavailableError,
  declarativeEntries,
  fetchMarketDetail,
  fetchMarketIndex,
  findMarketPlugin,
  indexToCatalogEntry,
  marketUpdateVersion,
  pickDeclarativeVersion,
} from "./marketClient.js";

/**
 * 市场客户端（d.108）：v2 索引解析/不可用分类/条目映射/详情。
 * 全部走注入的 fetch，不联网。
 */

const SHA = "a".repeat(64);
const PKG_SHA = "b".repeat(64);

export function marketVersion(overrides: Partial<MarketVersion> = {}): MarketVersion {
  return {
    version: "1.0.0",
    publishedAt: "2026-11-08T00:00:00.000Z",
    schemaVersion: 3,
    engines: { heming: "d.100" },
    distribution: "manifest",
    sha256: SHA,
    size: 1024,
    ...overrides,
  };
}

export function marketPlugin(overrides: Partial<MarketPlugin> = {}): MarketPlugin {
  return {
    id: "acme.report-kit",
    title: "报告工具箱",
    description: "周报与月报",
    author: "ACME",
    metadata: { category: "efficiency", tags: ["official"], keywords: ["周报"], sortKeys: { downloads: 12 } },
    versions: [marketVersion()],
    ...overrides,
  };
}

export function marketIndex(plugins: MarketPlugin[] = [marketPlugin()]): MarketIndex {
  return {
    format: 1,
    title: "和鸣插件目录",
    generatedAt: "2026-11-08T00:00:00.000Z",
    categories: { efficiency: { title: "效率" } },
    tags: { official: { title: "官方" } },
    sortKeys: { downloads: { title: "下载量", order: "desc" } },
    plugins,
  };
}

function jsonResponse(body: unknown, status = 200): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: { "content-type": "application/json" },
  });
}

describe("fetchMarketIndex", () => {
  it("正常解析：返回 v2 索引与 warnings，并带上 hostVersion 查询参数", async () => {
    const fetchImpl = vi.fn(async () => jsonResponse(marketIndex()));
    const result = await fetchMarketIndex({
      baseUrl: "https://example.test/",
      hostVersion: "d.105",
      fetchImpl: fetchImpl as unknown as typeof fetch,
    });
    expect(result.source).toBe("v2");
    expect(result.index.plugins[0]!.id).toBe("acme.report-kit");
    expect(result.warnings).toEqual([]);
    expect(String((fetchImpl.mock.calls[0] as unknown as [unknown])[0])).toBe(
      "https://example.test/api/plugin-market?hostVersion=d.105",
    );
  });

  it("404：归类为 MarketUnavailableError（调用方回落 v1 仓库）", async () => {
    const fetchImpl = async () => jsonResponse({ error: "市场索引不存在" }, 404);
    await expect(fetchMarketIndex({ fetchImpl })).rejects.toBeInstanceOf(MarketUnavailableError);
    await expect(fetchMarketIndex({ fetchImpl })).rejects.toThrow(/市场目录暂未发布/);
  });

  it("网络错误 / 非法 JSON / 顶层格式错误都归类为不可用", async () => {
    const network = async () => {
      throw new Error("connection refused");
    };
    await expect(fetchMarketIndex({ fetchImpl: network })).rejects.toThrow(
      /市场目录不可用：connection refused/,
    );

    const badJson = async () => new Response("not json", { status: 200 });
    await expect(fetchMarketIndex({ fetchImpl: badJson })).rejects.toThrow(
      /不是合法 JSON/,
    );

    const badShape = async () => jsonResponse({ format: 2, plugins: [] });
    await expect(fetchMarketIndex({ fetchImpl: badShape })).rejects.toBeInstanceOf(
      MarketUnavailableError,
    );
  });

  it("单条坏数据只丢该条，其余条目保留并记 warning", async () => {
    const bad = { ...marketPlugin({ id: "acme.bad" }), id: "Bad ID!" };
    const fetchImpl = async () => jsonResponse(marketIndex([marketPlugin(), bad as never]));
    const result = await fetchMarketIndex({ fetchImpl });
    expect(result.index.plugins).toHaveLength(1);
    expect(result.warnings[0]).toMatch(/第 2 个插件条目非法/);
  });

  it("hostVersion 兜底过滤：不兼容版本被过滤，整条无兼容版本的插件被移除", async () => {
    const old = marketPlugin({
      id: "acme.old",
      versions: [marketVersion({ version: "1.0.0", engines: { heming: "d.200" } })],
    });
    const mixed = marketPlugin({
      id: "acme.mixed",
      versions: [
        marketVersion({ version: "1.0.0", engines: { heming: "d.100" } }),
        marketVersion({ version: "2.0.0", engines: { heming: "d.200" } }),
      ],
    });
    const fetchImpl = async () => jsonResponse(marketIndex([old, mixed]));
    const result = await fetchMarketIndex({ hostVersion: "d.105", fetchImpl });
    expect(result.index.plugins.map((plugin) => plugin.id)).toEqual(["acme.mixed"]);
    expect(result.index.plugins[0]!.versions.map((version) => version.version)).toEqual(["1.0.0"]);
  });
});

describe("indexToCatalogEntry / declarativeEntries", () => {
  it("映射成安装弹窗契认的 PluginCatalogEntry，权限给保守默认", () => {
    const version = marketVersion({ version: "1.2.0" });
    const entry = indexToCatalogEntry(marketPlugin(), version);
    expect(entry).toMatchObject({
      id: "acme.report-kit",
      name: "报告工具箱",
      version: "1.2.0",
      schemaVersion: 3,
      sha256: SHA,
      size: 1024,
      distribution: "manifest",
      permissions: { network: [], tools: "none", files: [] },
    });
    expect(entry.package).toBeUndefined();
  });

  it("bundle 版本带上 package 指纹；声明式列表排除 bundle / removed / deleted", () => {
    const bundle = marketPlugin({
      id: "heming.pet",
      status: "active",
      versions: [
        marketVersion({
          distribution: "bundle",
          package: { sha256: PKG_SHA, size: 1234 },
        }),
      ],
    });
    expect(
      indexToCatalogEntry(bundle, bundle.versions[0]!).package,
    ).toEqual({ sha256: PKG_SHA, size: 1234 });

    const removed = marketPlugin({ id: "acme.removed", status: "removed" });
    const deletedOnly = marketPlugin({
      id: "acme.deleted",
      versions: [marketVersion({ status: "deleted" })],
    });
    const entries = declarativeEntries(marketIndex([marketPlugin(), bundle, removed, deletedOnly]));
    expect(entries.map((entry) => entry.id)).toEqual(["acme.report-kit"]);
  });

  it("声明式版本选最高兼容稳定版（不兼容/预发布靠后）", () => {
    const plugin = marketPlugin({
      versions: [
        marketVersion({ version: "1.0.0" }),
        marketVersion({ version: "2.0.0", engines: { heming: "d.200" } }),
        marketVersion({ version: "1.5.0", channel: "prerelease" }),
      ],
    });
    expect(pickDeclarativeVersion(plugin, "d.105")?.version).toBe("1.0.0");
    // 没有宿主过滤时取最高稳定版（2.0.0）；稳定版存在时预发布让位
    expect(pickDeclarativeVersion(plugin)?.version).toBe("2.0.0");
    const prereleaseOnly = marketPlugin({
      versions: [marketVersion({ version: "1.5.0", channel: "prerelease" })],
    });
    expect(pickDeclarativeVersion(prereleaseOnly)?.version).toBe("1.5.0");
    expect(pickDeclarativeVersion(plugin, "d.90")).toBeNull();
  });

  it("findMarketPlugin 按 id 查（包含 removed，由调用方决定隐藏）", () => {
    const index = marketIndex([marketPlugin({ id: "acme.gone", status: "removed" })]);
    expect(findMarketPlugin(index, "acme.gone")?.status).toBe("removed");
    expect(findMarketPlugin(index, "none")).toBeUndefined();
  });

  it("marketUpdateVersion：有更高兼容版本才算更新", () => {
    const plugin = marketPlugin({
      versions: [marketVersion({ version: "1.0.0" }), marketVersion({ version: "1.1.0" })],
    });
    expect(marketUpdateVersion(plugin, "1.0.0", "d.105")?.version).toBe("1.1.0");
    expect(marketUpdateVersion(plugin, "1.1.0", "d.105")).toBeNull();
  });
});

describe("fetchMarketDetail", () => {
  it("200 返回 markdown 原文", async () => {
    const fetchImpl = vi.fn(async () => new Response("# 报告工具箱", { status: 200 }));
    await expect(
      fetchMarketDetail("acme.report-kit", "1.0.0", {
        baseUrl: "https://example.test",
        fetchImpl: fetchImpl as unknown as typeof fetch,
      }),
    ).resolves.toBe("# 报告工具箱");
    expect(String((fetchImpl.mock.calls[0] as unknown as [unknown])[0])).toBe(
      "https://example.test/api/plugin-market/acme.report-kit/1.0.0/detail",
    );
  });

  it("404 返回 null（该版本没有详情文档是正常态）", async () => {
    const fetchImpl = async () => jsonResponse({ error: "详情文档不存在" }, 404);
    await expect(fetchMarketDetail("acme.report-kit", "1.0.0", { fetchImpl })).resolves.toBeNull();
  });

  it("网络/5xx 抛错（详情弹窗展示重试，不阻断版本列表）", async () => {
    const fetchImpl = async () => jsonResponse({ error: "boom" }, 500);
    await expect(fetchMarketDetail("acme.report-kit", "1.0.0", { fetchImpl })).rejects.toThrow(
      /详情加载失败：HTTP 500/,
    );
  });
});
