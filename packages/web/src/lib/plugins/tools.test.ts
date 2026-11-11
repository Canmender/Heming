import { describe, expect, it } from "vitest";
import {
  PLUGIN_SEARCH_DEFAULT,
  PLUGIN_SEARCH_MAX,
  buildPluginToolBridge,
  matchesMarketQuery,
  matchesTags,
  normalizeSearchLimit,
  pickPreviewVersion,
  type MarketSearchItem,
  type PluginInstallPreviewResult,
  type PluginToolsDeps,
} from "./tools.js";
import { PluginStore, pluginServerId, type PluginMcpPort } from "./store.js";
import { SkillPool, type StorageLike } from "../skills/index.js";
import type { McpServerConfig } from "../mcp/types.js";

/**
 * 插件市场只读工具（d.108）。
 *
 * 这个文件盯四件事：
 * 1. 搜索的映射与筛选（含「索引不可用要降级、不抛错」）；
 * 2. 预览与 UI 用同一份 `planInstall` 口径（兼容性拦截、冲突透出）；
 * 3. **只读**：预览前后存储一个字节都不变；
 * 4. 选版本/参数归一化这类纯函数。
 *
 * 网络一律用假 `fetch`：`/api/plugin-market` 回索引，`/manifest` 回清单原文。
 */

const SHA = "a".repeat(64);
const HOST = "d.107";

function version(overrides: Record<string, unknown> = {}): Record<string, unknown> {
  return {
    version: "1.0.0",
    publishedAt: "2026-11-01T00:00:00.000Z",
    schemaVersion: 5,
    engines: { heming: "d.104" },
    distribution: "manifest",
    sha256: SHA,
    size: 100,
    ...overrides,
  };
}

function plugin(overrides: Record<string, unknown> = {}): Record<string, unknown> {
  return {
    id: "acme.weather",
    title: "天气助手",
    description: "查询天气并给出出行建议",
    author: "Acme",
    metadata: { category: "tools", tags: ["效率", "天气"] },
    versions: [version()],
    ...overrides,
  };
}

function market(plugins: Record<string, unknown>[]): Record<string, unknown> {
  return {
    format: 1,
    title: "和鸣官方市场",
    generatedAt: "2026-11-01T00:00:00.000Z",
    plugins,
  };
}

/** v5 清单（与市场条目同 id/version；用于让下载与 planInstall 走真实解析）。 */
function manifest(overrides: Record<string, unknown> = {}): Record<string, unknown> {
  return {
    schemaVersion: 5,
    id: "acme.weather",
    name: "天气助手",
    version: "1.0.0",
    engines: { heming: "d.104" },
    permissions: { network: ["api.example.com"], tools: "read", files: [] },
    contributions: {
      skills: [{ name: "出行建议", instructions: "按天气给建议。" }],
      mcpServers: [{ key: "weather", name: "天气服务", url: "https://api.example.com/mcp" }],
    },
    ...overrides,
  };
}

function makeStorage(map = new Map<string, string>()): { storage: StorageLike; map: Map<string, string> } {
  return {
    map,
    storage: {
      getItem: (key) => (map.has(key) ? (map.get(key) as string) : null),
      setItem: (key, value) => {
        map.set(key, value);
      },
      removeItem: (key) => {
        map.delete(key);
      },
    },
  };
}

function clock(): () => number {
  let t = Date.UTC(2026, 10, 1);
  return () => (t += 1000);
}

/** 可注入已存在 MCP 服务的假端口（冲突场景用）。 */
function fakeMcp(existing: McpServerConfig[] = []): PluginMcpPort {
  const byId = new Map(existing.map((server) => [server.id, server]));
  return {
    get: (id) => byId.get(id),
    add: (input) => {
      const created = { ...input, id: input.id ?? "x", createdAt: "2026-11-01" } as McpServerConfig;
      byId.set(created.id, created);
      return created;
    },
    update: (id, patch) => {
      const next = { ...(byId.get(id) as McpServerConfig), ...patch } as McpServerConfig;
      byId.set(id, next);
      return next;
    },
    remove: (id) => {
      byId.delete(id);
    },
  };
}

function makeStore(existing: McpServerConfig[] = []): {
  store: PluginStore;
  map: Map<string, string>;
  storage: StorageLike;
} {
  const { storage, map } = makeStorage();
  const pool = new SkillPool(storage, clock());
  return {
    store: new PluginStore(storage, pool, clock(), fakeMcp(existing)),
    map,
    storage,
  };
}

function jsonResponse(body: unknown): Response {
  const text = JSON.stringify(body);
  const bytes = new TextEncoder().encode(text);
  return {
    ok: true,
    status: 200,
    json: async () => JSON.parse(text) as unknown,
    arrayBuffer: async () => bytes.buffer,
    headers: { get: () => null },
  } as unknown as Response;
}

function manifestResponse(text: string): Response {
  const bytes = new TextEncoder().encode(text);
  return {
    ok: true,
    status: 200,
    json: async () => JSON.parse(text) as unknown,
    arrayBuffer: async () => bytes.buffer,
    headers: { get: () => null },
  } as unknown as Response;
}

/** 假 fetch：市场索引与清单下载共用同一条通道（按 URL 分流）。 */
function routingFetch(
  index: Record<string, unknown> | (() => never),
  manifestText: string,
): typeof fetch {
  return (async (input: RequestInfo | URL) => {
    const url = String(input);
    if (url.includes("/api/plugin-market")) {
      if (typeof index === "function") index();
      return jsonResponse(index);
    }
    return manifestResponse(manifestText);
  }) as typeof fetch;
}

interface BridgeOptions {
  deps?: PluginToolsDeps;
  manifestText?: string;
}

function bridgeWith(
  index: Record<string, unknown> | (() => never),
  options: BridgeOptions = {},
): ReturnType<typeof buildPluginToolBridge> {
  return buildPluginToolBridge({
    hostVersion: HOST,
    fetchImpl: routingFetch(index, options.manifestText ?? JSON.stringify(manifest())),
    sha256Hex: async () => SHA,
    ...options.deps,
  });
}

async function call(
  bridge: ReturnType<typeof buildPluginToolBridge>,
  name: string,
  args: Record<string, unknown> = {},
): Promise<{ payload: unknown; ok: boolean }> {
  const result = await bridge.execute({ name, arguments: JSON.stringify(args) });
  return { payload: JSON.parse(result.text), ok: result.ok };
}

describe("plugin_market_search", () => {
  it("映射成紧凑条目：九个字段、按版本选 latest、bundle 不可装", async () => {
    const bridge = bridgeWith(
      market([
        plugin(),
        plugin({
          id: "acme.widget",
          title: "界面小组件",
          versions: [version({ version: "2.0.0", distribution: "bundle", package: { sha256: SHA, size: 10 } })],
        }),
      ]),
    );

    const { payload, ok } = await call(bridge, "plugin_market_search");
    expect(ok).toBe(true);
    const items = payload as MarketSearchItem[];
    expect(items).toHaveLength(2);
    expect(Object.keys(items[0]).sort()).toEqual([
      "author",
      "compatible",
      "description",
      "id",
      "installable",
      "latest",
      "status",
      "tags",
      "title",
    ]);
    expect(items[0]).toMatchObject({
      id: "acme.weather",
      title: "天气助手",
      author: "Acme",
      latest: "1.0.0",
      installable: true,
      compatible: true,
      status: "active",
      tags: ["效率", "天气"],
    });
    // 插件包不能走「下载清单 → 预览」这条路：installable=false，但仍兼容。
    expect(items[1]).toMatchObject({ id: "acme.widget", compatible: true, installable: false });
  });

  it("按 query / category / tags 过滤，limit 生效", async () => {
    const bridge = bridgeWith(
      market([
        plugin(),
        plugin({ id: "acme.writer", title: "写作助手", metadata: { category: "writing", tags: ["写作"] } }),
        plugin({ id: "acme.runner", title: "运行器", metadata: { category: "tools", tags: ["效率"] } }),
      ]),
    );

    expect(
      ((await call(bridge, "plugin_market_search", { query: "写作" })).payload as MarketSearchItem[]).map(
        (item) => item.id,
      ),
    ).toEqual(["acme.writer"]);
    expect(
      ((await call(bridge, "plugin_market_search", { category: "writing" })).payload as MarketSearchItem[]).map(
        (item) => item.id,
      ),
    ).toEqual(["acme.writer"]);
    expect(
      ((await call(bridge, "plugin_market_search", { tags: ["效率"] })).payload as MarketSearchItem[]).map(
        (item) => item.id,
      ),
    ).toEqual(["acme.weather", "acme.runner"]);
    expect((await call(bridge, "plugin_market_search", { limit: 1 })).payload as MarketSearchItem[]).toHaveLength(1);
  });

  it("不兼容当前宿主的版本被过滤掉，插件整条消失（服务端/客户端同一口径）", async () => {
    const bridge = bridgeWith(market([plugin({ versions: [version({ engines: { heming: "d.999" } })] })]));
    expect((await call(bridge, "plugin_market_search")).payload).toEqual([]);
  });

  it("索引不可用时降级为 { unavailable, reason }，不抛错也不 ok=false", async () => {
    const bridge = bridgeWith(() => {
      throw new Error("http 502");
    });
    const { payload, ok } = await call(bridge, "plugin_market_search");
    expect(ok).toBe(true);
    expect(payload).toMatchObject({ unavailable: true });
    expect((payload as { reason: string }).reason).toContain("市场目录不可用");
  });
});

describe("plugin_install_preview", () => {
  it("返回权限/贡献/差异/体积（纯函数结果，未安装）", async () => {
    const { store } = makeStore();
    const bridge = bridgeWith(market([plugin()]), { deps: { store } });

    const { payload, ok } = await call(bridge, "plugin_install_preview", { id: "acme.weather" });
    expect(ok).toBe(true);
    const preview = payload as PluginInstallPreviewResult;
    expect(preview).toMatchObject({
      id: "acme.weather",
      version: "1.0.0",
      name: "天气助手",
      mode: "install",
      installedVersion: null,
      updatable: false,
    });
    expect(preview.engines.status).toBe("compatible");
    expect(preview.permissions).toMatchObject({ network: ["api.example.com"], tools: "read" });
    expect(preview.contributions).toEqual({
      skills: ["出行建议"],
      mcpServers: ["weather"],
      commands: [],
      toolPacks: [],
      desktopWidgets: [],
    });
    expect(preview.diff.skills.added).toEqual(["出行建议"]);
    expect(preview.diff.servers.added).toEqual([{ key: "weather", name: "天气服务" }]);
    expect(preview.sizeEstimate).toMatchObject({ exceeded: false });
    expect(preview.blocked).toEqual([]);
  });

  it("兼容性不满足：自动选版本时拒绝并说明原因；显式版本则进 blocked（engines）", async () => {
    const { store } = makeStore();
    const bridge = bridgeWith(market([plugin({ versions: [version({ engines: { heming: "d.999" } })] })]), {
      deps: { store },
      manifestText: JSON.stringify(manifest({ engines: { heming: "d.999" } })),
    });

    // 不指定版本：没有兼容版本可自动选，直接如实告诉模型（不是抛错）。
    const auto = (await call(bridge, "plugin_install_preview", { id: "acme.weather" })).payload as {
      error: string;
    };
    expect(auto.error).toContain("没有与当前和鸣版本");

    // 指定版本：走同一个 planInstall，兼容性由 blocked=engines 表达。
    const preview = (
      await call(bridge, "plugin_install_preview", { id: "acme.weather", version: "1.0.0" })
    ).payload as PluginInstallPreviewResult;
    expect(preview.engines.status).toBe("needsNewerApp");
    expect(preview.blocked.map((block) => block.code)).toContain("engines");
  });

  it("显式指定不兼容版本也能预览（用于解释「为什么装不上」）", async () => {
    const { store } = makeStore();
    const bridge = bridgeWith(
      market([
        plugin({
          versions: [version(), version({ version: "2.0.0", engines: { heming: "d.999" } })],
        }),
      ]),
      {
        deps: { store },
        manifestText: JSON.stringify(manifest({ version: "2.0.0", engines: { heming: "d.999" } })),
      },
    );

    const preview = (
      await call(bridge, "plugin_install_preview", { id: "acme.weather", version: "2.0.0" })
    ).payload as PluginInstallPreviewResult;
    expect(preview.version).toBe("2.0.0");
    expect(preview.blocked.map((block) => block.code)).toContain("engines");
  });

  it("MCP 服务 id 冲突透出到 conflicts（与 UI 预览同一口径）", async () => {
    const conflictId = pluginServerId("acme.weather", "weather");
    const { store } = makeStore([
      {
        id: conflictId,
        name: "用户手填天气",
        transport: "http",
        url: "https://manual.example.com/mcp",
        origin: "manual",
      } as McpServerConfig,
    ]);
    const bridge = bridgeWith(market([plugin()]), { deps: { store } });

    const preview = (await call(bridge, "plugin_install_preview", { id: "acme.weather" }))
      .payload as PluginInstallPreviewResult;
    expect(preview.conflicts).toEqual([{ id: conflictId, name: "用户手填天气" }]);
    expect(preview.blocked.map((block) => block.code)).toContain("conflicts");
  });

  it("只读：预览前后存储一个字节都不变", async () => {
    const { store, map } = makeStore();
    const before = new Map(map);
    const bridge = bridgeWith(market([plugin()]), { deps: { store } });

    await call(bridge, "plugin_install_preview", { id: "acme.weather" });

    expect(map).toEqual(before);
    expect(store.list()).toEqual([]);
  });

  it("插件包（bundle）拒绝预览，提示去插件页安装", async () => {
    const { store } = makeStore();
    const bridge = bridgeWith(
      market([
        plugin({
          versions: [version({ distribution: "bundle", package: { sha256: SHA, size: 10 } })],
        }),
      ]),
      { deps: { store } },
    );

    const { payload, ok } = await call(bridge, "plugin_install_preview", { id: "acme.weather" });
    expect(ok).toBe(true);
    expect((payload as { error: string }).error).toContain("插件包");
  });

  it("清单指纹不一致：拒绝预览（不把没校验的内容交给 planInstall）", async () => {
    const { store } = makeStore();
    const bridge = bridgeWith(market([plugin()]), {
      deps: { store, sha256Hex: async () => "b".repeat(64) },
    });

    const { payload } = await call(bridge, "plugin_install_preview", { id: "acme.weather" });
    expect((payload as { error: string }).error).toContain("指纹");
  });

  it("已安装：给出 installedVersion 与 updatable", async () => {
    const { store } = makeStore();
    store.install(manifest());
    const bridge = bridgeWith(
      market([plugin({ versions: [version(), version({ version: "1.1.0" })] })]),
      { deps: { store }, manifestText: JSON.stringify(manifest({ version: "1.1.0" })) },
    );

    const preview = (await call(bridge, "plugin_install_preview", { id: "acme.weather" }))
      .payload as PluginInstallPreviewResult;
    expect(preview.mode).toBe("update");
    expect(preview.version).toBe("1.1.0");
    expect(preview.installedVersion).toBe("1.0.0");
    expect(preview.updatable).toBe(true);
  });
});

describe("纯函数", () => {
  it("normalizeSearchLimit 收敛到 1..20", () => {
    expect(normalizeSearchLimit(undefined)).toBe(PLUGIN_SEARCH_DEFAULT);
    expect(normalizeSearchLimit(0)).toBe(1);
    expect(normalizeSearchLimit(999)).toBe(PLUGIN_SEARCH_MAX);
    expect(normalizeSearchLimit("7")).toBe(7);
    expect(normalizeSearchLimit("abc")).toBe(PLUGIN_SEARCH_DEFAULT);
  });

  it("matchesMarketQuery 是 AND 语义，命中 id/标题/标签/旧 id", () => {
    const p = plugin() as never;
    expect(matchesMarketQuery(p, "")).toBe(true);
    expect(matchesMarketQuery(p, "天气 效率")).toBe(true);
    expect(matchesMarketQuery(p, "天气 不存在")).toBe(false);
  });

  it("matchesTags 大小写不敏感、AND 语义", () => {
    const p = plugin() as never;
    expect(matchesTags(p, [])).toBe(true);
    expect(matchesTags(p, ["效率"])).toBe(true);
    expect(matchesTags(p, ["效率", "没有"])).toBe(false);
  });

  it("pickPreviewVersion：显式版本优先，缺省只选声明式版本；deleted 不可选", () => {
    const p = plugin({
      versions: [version(), version({ version: "2.0.0", status: "deleted" })],
    }) as never;
    expect(pickPreviewVersion(p, undefined, HOST)?.version).toBe("1.0.0");
    expect(pickPreviewVersion(p, "1.0.0", HOST)?.version).toBe("1.0.0");
    expect(pickPreviewVersion(p, "2.0.0", HOST)).toBeNull();
    expect(pickPreviewVersion(p, "9.9.9", HOST)).toBeNull();
  });
});
