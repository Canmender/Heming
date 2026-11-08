import { describe, expect, it } from "vitest";
import {
  MarketIndexInvalidError,
  comparePluginVersions,
  filterMarketByHostVersion,
  hasCompatibleUpdate,
  parseMarketIndex,
  pickInstallVersion,
  isVersionCompatible,
  type MarketIndex,
} from "./market.js";

const sha = "a".repeat(64);

function version(overrides: Record<string, unknown> = {}) {
  return {
    version: "1.0.0",
    publishedAt: "2026-11-08T00:00:00.000Z",
    schemaVersion: 5,
    engines: { heming: "d.103" },
    distribution: "manifest",
    sha256: sha,
    size: 1024,
    ...overrides,
  };
}

function index(overrides: Record<string, unknown> = {}): Record<string, unknown> {
  return {
    format: 1,
    title: "和鸣插件目录",
    generatedAt: "2026-11-08T00:00:00.000Z",
    plugins: [
      {
        id: "heming.pet",
        title: "桌宠",
        status: "active",
        versions: [version()],
      },
    ],
    ...overrides,
  };
}

describe("parseMarketIndex", () => {
  it("合法索引原样解析", () => {
    const { index: parsed, warnings } = parseMarketIndex(index());
    expect(parsed.plugins).toHaveLength(1);
    expect(parsed.plugins[0].id).toBe("heming.pet");
    expect(warnings).toEqual([]);
  });

  it("顶层非法直接抛（客户端回落 v1）", () => {
    expect(() => parseMarketIndex({ format: 2, title: "x" })).toThrow(MarketIndexInvalidError);
    expect(() => parseMarketIndex(null)).toThrow(MarketIndexInvalidError);
  });

  it("单条坏数据只丢该条，并记 warning", () => {
    const raw = index({
      plugins: [
        { id: "ok.plugin", versions: [version()] },
        { id: "bad.id!", versions: [version()] },
        { id: "dup.plugin", versions: [version()] },
        { id: "dup.plugin", versions: [version()] },
      ],
    });
    const { index: parsed, warnings } = parseMarketIndex(raw);
    expect(parsed.plugins.map((plugin) => plugin.id)).toEqual(["ok.plugin", "dup.plugin"]);
    expect(warnings.some((line) => line.includes("重复出现"))).toBe(true);
  });

  it("版本级坏数据被丢：重复版本 / 非法 engines / bundle 缺包指纹", () => {
    const raw = index({
      plugins: [
        {
          id: "mixed.plugin",
          versions: [
            version(),
            version(),
            version({ version: "1.1.0", engines: { heming: "v1" } }),
            version({ version: "2.0.0", distribution: "bundle" }),
            version({ version: "2.1.0", distribution: "bundle", package: { sha256: sha, size: 10 } }),
          ],
        },
      ],
    });
    const { index: parsed, warnings } = parseMarketIndex(raw);
    expect(parsed.plugins[0].versions.map((item) => item.version)).toEqual(["1.0.0", "2.1.0"]);
    expect(warnings.length).toBeGreaterThanOrEqual(3);
  });

  it("插件没有可用版本 → 整条丢弃", () => {
    const raw = index({ plugins: [{ id: "empty.plugin", versions: [version({ engines: { heming: "x" } })] }] });
    const { index: parsed } = parseMarketIndex(raw);
    expect(parsed.plugins).toHaveLength(0);
  });
});

describe("版本排序与兼容过滤", () => {
  it("数字点分版本比较", () => {
    expect(comparePluginVersions("1.10.0", "1.9.0")).toBeGreaterThan(0);
    expect(comparePluginVersions("1.0.0", "1.0.0")).toBe(0);
    expect(comparePluginVersions("1.0.0", "1.0.1")).toBeLessThan(0);
  });

  it("按宿主版本过滤版本，全不兼容的插件整条移除", () => {
    const raw = index({
      plugins: [
        { id: "new.only", versions: [version({ engines: { heming: "d.110" } })] },
        {
          id: "mixed",
          versions: [
            version({ version: "1.0.0", engines: { heming: "d.100" } }),
            version({ version: "2.0.0", engines: { heming: "d.110" } }),
          ],
        },
      ],
    });
    const { index: parsed } = parseMarketIndex(raw);
    const filtered = filterMarketByHostVersion(parsed as MarketIndex, "d.104.2.42.0");
    expect(filtered.plugins.map((plugin) => plugin.id)).toEqual(["mixed"]);
    expect(filtered.plugins[0].versions.map((item) => item.version)).toEqual(["1.0.0"]);
  });

  it("非法 engines.heming 视为不兼容（失败关闭，审计 P1-6）", () => {
    expect(isVersionCompatible({ ...version(), engines: { heming: "v1" } }, "d.104.2.42.0")).toBe(false);
    expect(isVersionCompatible({ ...version(), engines: { heming: "d.100" } }, "d.104.2.42.0")).toBe(true);
    // 宿主版本读不到时仍不误杀（客户端兜底）
    expect(isVersionCompatible({ ...version(), engines: { heming: "v1" } }, "bad")).toBe(true);
  });

  it("宿主版本非法时不过滤（交给客户端兜底）", () => {
    const { index: parsed } = parseMarketIndex(index());
    expect(filterMarketByHostVersion(parsed as MarketIndex, "bad").plugins).toHaveLength(1);
  });
});

describe("pickInstallVersion / hasCompatibleUpdate", () => {
  const plugin = {
    id: "p",
    versions: [
      { ...version({ version: "1.0.0" }) },
      { ...version({ version: "1.5.0" }) },
      { ...version({ version: "2.0.0", engines: { heming: "d.120" } }) },
    ],
  };

  it("选最高兼容版本（不选 latest 字段、不选不兼容）", () => {
    const picked = pickInstallVersion(plugin as never, { hostVersion: "d.104.2.42.0" });
    expect(picked?.version).toBe("1.5.0");
  });

  it("默认排除预发布，只有全是预发布才回落", () => {
    const prerelease = {
      id: "p",
      versions: [version({ version: "1.1.0", channel: "prerelease" }), version({ version: "1.0.0" })],
    };
    expect(pickInstallVersion(prerelease as never)?.version).toBe("1.0.0");
    const onlyPre = { id: "p", versions: [version({ version: "1.1.0", channel: "prerelease" })] };
    expect(pickInstallVersion(onlyPre as never)?.version).toBe("1.1.0");
  });

  it("deleted 版本不选，deleted + deprecated 语义分开", () => {
    const deleted = {
      id: "p",
      versions: [version({ version: "2.0.0", status: "deleted" }), version({ version: "1.0.0" })],
    };
    expect(pickInstallVersion(deleted as never)?.version).toBe("1.0.0");
  });

  it("有更高兼容版本才算可更新", () => {
    expect(hasCompatibleUpdate(plugin as never, "1.0.0", "d.104.2.42.0")).toBe(true);
    expect(hasCompatibleUpdate(plugin as never, "1.5.0", "d.104.2.42.0")).toBe(false);
    expect(hasCompatibleUpdate(plugin as never, "1.5.0", "d.100")).toBe(false);
  });
});
