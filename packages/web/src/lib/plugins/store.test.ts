import { describe, it, expect } from "vitest";
import {
  MAX_PLUGINS,
  PLUGINS_KEY,
  PluginManifestError,
  pluginServerId,
  PluginStore,
  type PluginMcpPort,
} from "./index.js";
import { SkillPool, type StorageLike } from "../skills/index.js";
import type { McpServerConfig } from "../mcp/index.js";

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

function clock(start = Date.UTC(2026, 10, 1)): () => number {
  let t = start;
  return () => (t += 1000);
}

function manifest(overrides: Record<string, unknown> = {}): Record<string, unknown> {
  return {
    schemaVersion: 1,
    id: "acme.finance",
    name: "财务助手包",
    version: "1.0.0",
    description: "财报速读",
    author: "Acme",
    skills: [
      { name: "财报速读", instructions: "先看收入。" },
      { name: "现金流检查", instructions: "看经营现金流。" },
    ],
    ...overrides,
  };
}

function v2Manifest(overrides: Record<string, unknown> = {}): Record<string, unknown> {
  return {
    schemaVersion: 2,
    id: "acme.weather",
    name: "天气能力包",
    version: "1.0.0",
    skills: [
      { name: "出行建议", instructions: "结合天气出行。" },
      { name: "穿衣建议", instructions: "结合温度穿衣。" },
    ],
    mcpServers: [
      { key: "weather", name: "天气服务", url: "https://mcp.example.com/weather" },
      { key: "alerts", name: "预警服务", url: "https://mcp.example.com/alerts" },
      { key: "tide", name: "潮汐服务", url: "https://mcp.example.com/tide" },
    ],
    ...overrides,
  };
}

function fakeMcp(): { port: PluginMcpPort; servers: Map<string, McpServerConfig> } {
  const servers = new Map<string, McpServerConfig>();
  let seq = 0;
  const at = "2026-11-01T00:00:00.000Z";
  return {
    servers,
    port: {
      get(id) {
        const server = servers.get(id);
        return server
          ? { ...server, headers: server.headers ? { ...server.headers } : undefined }
          : undefined;
      },
      add(input) {
        const server: McpServerConfig = {
          id: input.id ?? `fake-${++seq}`,
          name: input.name,
          transport: input.transport,
          url: input.url,
          enabled: input.enabled !== false,
          origin: input.origin ?? "manual",
          createdAt: at,
          updatedAt: at,
        };
        servers.set(server.id, server);
        return { ...server };
      },
      update(id, patch) {
        const current = servers.get(id);
        if (!current) throw new Error("MCP 服务不存在");
        const next: McpServerConfig = { ...current, ...patch, id, updatedAt: at };
        servers.set(id, next);
        return { ...next };
      },
      remove(id) {
        servers.delete(id);
      },
    },
  };
}

function fresh(): {
  store: PluginStore;
  pool: SkillPool;
  map: Map<string, string>;
  mcp: ReturnType<typeof fakeMcp>;
} {
  const { storage, map } = makeStorage();
  const pool = new SkillPool(storage, clock());
  const mcp = fakeMcp();
  return { store: new PluginStore(storage, pool, clock(), mcp.port), pool, map, mcp };
}

describe("PluginStore · 安装", () => {
  it("安装物化技能：来源已装、带插件归属、默认启用", () => {
    const { store, pool } = fresh();
    const result = store.install(manifest());

    expect(result.created).toBe(true);
    expect(result.added).toBe(2);
    expect(result.updated).toBe(0);
    expect(result.removed).toBe(0);
    expect(result.plugin.manifest.id).toBe("acme.finance");
    expect(result.plugin.skillIds).toHaveLength(2);

    const skills = pool.list().filter((s) => s.pluginId === "acme.finance");
    expect(skills.map((s) => s.name).sort()).toEqual(["现金流检查", "财报速读"]);
    for (const skill of skills) {
      expect(skill.source).toBe("imported");
      expect(skill.enabled).toBe(true);
      expect(skill.version).toBe("1.0.0");
    }
    expect(store.list()).toHaveLength(1);
  });

  it("同 id 更新：同名刷新、新增创建、消失删除，版本与时间同步", () => {
    const { store, pool } = fresh();
    const first = store.install(manifest());
    const readId = pool.list().find((s) => s.name === "财报速读")?.id as string;
    const cashId = pool.list().find((s) => s.name === "现金流检查")?.id as string;

    const result = store.install(
      manifest({
        version: "1.1.0",
        skills: [
          { name: "财报速读", instructions: "先看收入与毛利率。" },
          { name: "现金流核对", instructions: "核对三项现金流。" },
        ],
      }),
    );

    expect(result.created).toBe(false);
    expect(result.updated).toBe(1);
    expect(result.added).toBe(1);
    expect(result.removed).toBe(1);

    const updated = pool.get(readId);
    expect(updated?.instructions).toBe("先看收入与毛利率。");
    expect(updated?.version).toBe("1.1.0");
    expect(pool.get(cashId)).toBeUndefined();
    expect(result.plugin.installedAt).toBe(first.plugin.installedAt);
    expect(store.list()).toHaveLength(1);
    expect(pool.list().filter((s) => s.pluginId === "acme.finance")).toHaveLength(2);
  });

  it("不改动手工创建的同名技能", () => {
    const { store, pool } = fresh();
    const manual = pool.create({
      name: "财报速读",
      description: "",
      instructions: "我自己的版本",
      triggers: [],
      tags: [],
      enabled: true,
      version: "0.0.1",
    });

    store.install(manifest());
    const sameName = pool.list().filter((s) => s.name === "财报速读");
    expect(sameName).toHaveLength(2);
    expect(pool.get(manual.id)?.instructions).toBe("我自己的版本");
    expect(pool.get(manual.id)?.pluginId).toBeUndefined();

    store.remove("acme.finance");
    expect(pool.get(manual.id)).toBeDefined();
    expect(pool.list().filter((s) => s.name === "财报速读")).toHaveLength(1);
  });

  it("非法清单抛中文错误且不落盘", () => {
    const { store, pool } = fresh();
    expect(() => store.install(manifest({ id: "Bad ID" }))).toThrow(PluginManifestError);
    expect(store.list()).toEqual([]);
    expect(pool.list().filter((s) => s.pluginId)).toEqual([]);
  });

  it("新技能追加到已有显式分配的智能体；无记录者走默认分配", () => {
    const { store, pool } = fresh();
    const custom = pool.create({
      name: "自定义技能",
      description: "",
      instructions: "x",
      triggers: [],
      tags: [],
      enabled: true,
      version: "1.0.0",
    });
    pool.assign("a1", custom.id);

    const result = store.install(manifest());
    for (const id of result.plugin.skillIds) {
      expect(pool.assigned("a1")).toContain(id);
      expect(pool.assigned("a2")).toContain(id);
    }
    expect(pool.assigned("a1")).toContain(custom.id);
    expect(pool.assigned("a2")).not.toContain(custom.id);
  });

  it("插件数量达到上限后拒绝新插件", () => {
    const { store } = fresh();
    for (let i = 0; i < MAX_PLUGINS; i += 1) {
      store.install(
        manifest({
          id: `acme.p${i}`,
          name: `插件 ${i}`,
          skills: [{ name: `技能 ${i}`, instructions: "x" }],
        }),
      );
    }
    expect(() =>
      store.install(manifest({ id: "acme.overflow", skills: [{ name: "溢出", instructions: "x" }] })),
    ).toThrow(`插件数量已达上限（${MAX_PLUGINS} 个）`);
  });
});

describe("PluginStore · 启停与卸载", () => {
  it("停用同步技能启用位，重新启用恢复；更新保留启用状态", () => {
    const { store, pool } = fresh();
    const result = store.install(manifest());
    const ids = result.plugin.skillIds;

    store.setEnabled("acme.finance", false);
    expect(store.get("acme.finance")?.enabled).toBe(false);
    for (const id of ids) expect(pool.get(id)?.enabled).toBe(false);

    const next = store.install(
      manifest({
        version: "2.0.0",
        skills: [{ name: "财报速读", instructions: "v2" }],
      }),
    );
    expect(next.plugin.enabled).toBe(false);
    expect(pool.get(next.plugin.skillIds[0])?.enabled).toBe(false);

    store.setEnabled("acme.finance", true);
    expect(pool.get(next.plugin.skillIds[0])?.enabled).toBe(true);
  });

  it("卸载删除插件技能与绑定，不影响其它技能", () => {
    const { store, pool } = fresh();
    const custom = pool.create({
      name: "自定义技能",
      description: "",
      instructions: "x",
      triggers: [],
      tags: [],
      enabled: true,
      version: "1.0.0",
    });
    const result = store.install(manifest());
    const [first] = result.plugin.skillIds;
    pool.setBinding("a1", { pinned: [first] });

    store.remove("acme.finance");

    expect(store.list()).toEqual([]);
    expect(pool.get(first)).toBeUndefined();
    expect(pool.bindings("a1").pinned).toEqual([]);
    expect(pool.get(custom.id)).toBeDefined();
    expect(pool.list().filter((s) => s.pluginId)).toEqual([]);
  });

  it("存储损坏时回退空表，单条坏记录只丢这一条", () => {
    const bad = makeStorage(new Map([[PLUGINS_KEY, "坏 JSON"]]));
    expect(new PluginStore(bad.storage, new SkillPool(bad.storage, clock()), clock()).list()).toEqual(
      [],
    );

    const { storage, map } = makeStorage();
    const pool = new SkillPool(storage, clock());
    const store = new PluginStore(storage, pool, clock());
    store.install(manifest());
    const data = JSON.parse(map.get(PLUGINS_KEY) as string) as { plugins: unknown[] };
    data.plugins.push({ manifest: { schemaVersion: 1 }, enabled: true, skillIds: [] });
    map.set(PLUGINS_KEY, JSON.stringify(data));

    const reloaded = new PluginStore(storage, pool, clock());
    expect(reloaded.list()).toHaveLength(1);
    expect(reloaded.list()[0].manifest.id).toBe("acme.finance");
  });
});

describe("PluginStore · MCP 服务生命周期", () => {
  const weather = {
    key: "weather",
    name: "天气服务",
    url: "https://mcp.example.com/weather",
  };

  function mcpManifest(overrides: Record<string, unknown> = {}): Record<string, unknown> {
    return manifest({ schemaVersion: 2, mcpServers: [weather], ...overrides });
  }

  it("安装登记远程服务：稳定 id、插件来源、跟随启用", () => {
    const { store, mcp } = fresh();
    const result = store.install(mcpManifest());
    const id = pluginServerId("acme.finance", "weather");

    expect(result.serversAdded).toBe(1);
    expect(result.plugin.serverIds).toEqual([id]);
    expect(mcp.servers.get(id)).toMatchObject({
      name: "天气服务",
      transport: "http",
      url: weather.url,
      origin: "plugin",
      enabled: true,
    });
  });

  it("纯 MCP 包没有技能也能安装", () => {
    const { store, pool, mcp } = fresh();
    const result = store.install(mcpManifest({ skills: [] }));
    const id = pluginServerId("acme.finance", "weather");

    expect(result.added).toBe(0);
    expect(result.serversAdded).toBe(1);
    expect(result.plugin.skillIds).toEqual([]);
    expect(pool.list().filter((s) => s.pluginId)).toEqual([]);
    expect(mcp.servers.get(id)?.origin).toBe("plugin");
  });

  it("更新服务增改删，并保留用户在接口区补的请求头", () => {
    const { store, mcp } = fresh();
    const fx = { key: "fx", name: "汇率服务", url: "https://mcp.example.com/fx" };
    store.install(mcpManifest({ mcpServers: [weather, fx] }));
    const weatherId = pluginServerId("acme.finance", "weather");
    const fxId = pluginServerId("acme.finance", "fx");
    mcp.servers.get(weatherId)!.headers = { Authorization: "Bearer user" };

    const aqi = { key: "aqi", name: "空气服务", url: "https://mcp.example.com/aqi" };
    const result = store.install(
      mcpManifest({
        version: "1.1.0",
        mcpServers: [{ ...weather, name: "天气 v2", url: "https://mcp.example.com/v2" }, aqi],
      }),
    );

    expect(result.serversUpdated).toBe(1);
    expect(result.serversAdded).toBe(1);
    expect(result.serversRemoved).toBe(1);
    expect(mcp.servers.get(weatherId)).toMatchObject({
      name: "天气 v2",
      url: "https://mcp.example.com/v2",
      headers: { Authorization: "Bearer user" },
      origin: "plugin",
    });
    expect(mcp.servers.has(fxId)).toBe(false);
    expect(mcp.servers.has(pluginServerId("acme.finance", "aqi"))).toBe(true);
    expect(result.plugin.serverIds).toEqual([
      weatherId,
      pluginServerId("acme.finance", "aqi"),
    ]);
  });

  it("服务 id 被其它来源占用时整体失败，不写技能也不改服务", () => {
    const { store, pool, mcp } = fresh();
    const id = pluginServerId("acme.finance", "weather");
    mcp.port.add({
      id,
      name: "手填服务",
      transport: "http",
      url: "https://manual.example.com/mcp",
      origin: "manual",
    });

    expect(() => store.install(mcpManifest())).toThrow("MCP 服务 id 冲突");
    expect(store.list()).toEqual([]);
    expect(pool.list().filter((s) => s.pluginId)).toEqual([]);
    expect(mcp.servers.get(id)).toMatchObject({
      name: "手填服务",
      origin: "manual",
    });
  });

  it("启停同步服务启用位，卸载删除服务", () => {
    const { store, mcp } = fresh();
    store.install(mcpManifest());
    const id = pluginServerId("acme.finance", "weather");

    store.setEnabled("acme.finance", false);
    expect(mcp.servers.get(id)?.enabled).toBe(false);
    store.setEnabled("acme.finance", true);
    expect(mcp.servers.get(id)?.enabled).toBe(true);

    store.remove("acme.finance");
    expect(mcp.servers.has(id)).toBe(false);
    expect(store.list()).toEqual([]);
  });

  it("卸载不删用户已改成手填的服务", () => {
    const { store, mcp } = fresh();
    store.install(mcpManifest());
    const id = pluginServerId("acme.finance", "weather");
    const server = mcp.servers.get(id)!;
    mcp.servers.set(id, { ...server, origin: "manual" });

    store.remove("acme.finance");
    expect(mcp.servers.get(id)?.origin).toBe("manual");
  });

  it("旧记录没有 serverIds 或值损坏时按空数组读回", () => {
    const { storage, map } = makeStorage();
    const pool = new SkillPool(storage, clock());
    const mcp = fakeMcp();
    const store = new PluginStore(storage, pool, clock(), mcp.port);
    store.install(manifest());

    const data = JSON.parse(map.get(PLUGINS_KEY) as string) as {
      plugins: Record<string, unknown>[];
    };
    delete data.plugins[0].serverIds;
    map.set(PLUGINS_KEY, JSON.stringify(data));
    const reloaded = new PluginStore(storage, pool, clock(), fakeMcp().port);
    expect(reloaded.list()[0].serverIds).toEqual([]);

    data.plugins[0].serverIds = "坏值";
    map.set(PLUGINS_KEY, JSON.stringify(data));
    const again = new PluginStore(storage, pool, clock(), fakeMcp().port);
    expect(again.list()[0].serverIds).toEqual([]);
  });
});

describe("PluginStore · 更新预览与详情", () => {
  it("新插件预览：列出技能/服务与主机，且不写任何状态", () => {
    const { store, pool, map } = fresh();
    const preview = store.preview(v2Manifest());

    expect(preview.existing).toBeNull();
    expect(preview.skills.added).toEqual(["出行建议", "穿衣建议"]);
    expect(preview.skills.changed).toEqual([]);
    expect(preview.skills.unchanged).toEqual([]);
    expect(preview.skills.removed).toEqual([]);
    expect(preview.servers.added.map((s) => s.key)).toEqual(["weather", "alerts", "tide"]);
    expect(preview.servers.changed).toEqual([]);
    expect(preview.servers.removed).toEqual([]);
    expect(preview.hosts).toEqual(["mcp.example.com"]);
    expect(preview.conflicts).toEqual([]);
    expect(preview.limitReached).toBe(false);

    expect(store.list()).toEqual([]);
    expect(pool.list().filter((s) => s.pluginId)).toEqual([]);
    expect(map.get(PLUGINS_KEY)).toBeUndefined();
  });

  it("安装后原样再预览：全部不变；实际多台服务去重列主机", () => {
    const { store } = fresh();
    store.install(v2Manifest());
    const preview = store.preview(v2Manifest());

    expect(preview.existing?.manifest.id).toBe("acme.weather");
    expect(preview.skills.added).toEqual([]);
    expect(preview.skills.changed).toEqual([]);
    expect(preview.skills.unchanged).toEqual(["出行建议", "穿衣建议"]);
    expect(preview.skills.removed).toEqual([]);
    expect(preview.servers.added).toEqual([]);
    expect(preview.servers.changed).toEqual([]);
    expect(preview.servers.unchanged.map((s) => s.key)).toEqual(["weather", "alerts", "tide"]);
    expect(preview.servers.removed).toEqual([]);
    expect(preview.hosts).toEqual(["mcp.example.com"]);
  });

  it("更新预览：技能与服务各自算出新增/变更/移除/不变", () => {
    const { store } = fresh();
    store.install(v2Manifest());

    const next = v2Manifest({
      version: "1.1.0",
      skills: [
        { name: "出行建议", instructions: "结合天气出行。" },
        { name: "穿衣建议", instructions: "按体感温度穿衣。" },
        { name: "防晒建议", instructions: "看紫外线。" },
      ],
      mcpServers: [
        { key: "weather", name: "天气服务", url: "https://mcp.example.com/weather" },
        { key: "alerts", name: "预警服务", url: "https://mcp.example.com/alerts-v2" },
        { key: "uv", name: "紫外线服务", url: "https://mcp.example.com/uv" },
      ],
    });
    const preview = store.preview(next);

    expect(preview.skills.added).toEqual(["防晒建议"]);
    expect(preview.skills.changed).toEqual(["穿衣建议"]);
    expect(preview.skills.unchanged).toEqual(["出行建议"]);
    expect(preview.skills.removed).toEqual([]);
    expect(preview.servers.added.map((s) => s.key)).toEqual(["uv"]);
    expect(preview.servers.changed.map((s) => s.key)).toEqual(["alerts"]);
    expect(preview.servers.unchanged.map((s) => s.key)).toEqual(["weather"]);
    expect(preview.servers.removed).toEqual([{ key: "tide", name: "潮汐服务" }]);

    const dropped = store.preview(
      v2Manifest({ skills: [{ name: "出行建议", instructions: "结合天气出行。" }] }),
    );
    expect(dropped.skills.removed).toEqual(["穿衣建议"]);
  });

  it("差异按物化后的真实状态算：手改服务地址会显示为变更", () => {
    const { store, mcp } = fresh();
    store.install(v2Manifest());
    mcp.port.update(pluginServerId("acme.weather", "weather"), {
      url: "https://user-edited.example.com/weather",
    });

    const preview = store.preview(v2Manifest());
    expect(preview.servers.changed.map((s) => s.key)).toEqual(["weather"]);
    expect(preview.servers.unchanged.map((s) => s.key)).toEqual(["alerts", "tide"]);
  });

  it("冲突只进 conflicts，且安装仍会在写技能前失败", () => {
    const { store, mcp, pool } = fresh();
    const conflictId = pluginServerId("acme.weather", "weather");
    mcp.port.add({
      id: conflictId,
      name: "用户手填天气",
      transport: "http",
      url: "https://manual.example.com/mcp",
      origin: "manual",
    });

    const preview = store.preview(v2Manifest());
    expect(preview.conflicts).toEqual([{ id: conflictId, name: "用户手填天气" }]);
    expect(preview.servers.added.map((s) => s.key)).toEqual(["alerts", "tide"]);

    expect(() => store.install(v2Manifest())).toThrow(PluginManifestError);
    expect(pool.list().filter((s) => s.pluginId)).toEqual([]);
    expect(store.list()).toEqual([]);
  });

  it("新插件达到上限时 preview 标记 limitReached，更新不受限", () => {
    const { store } = fresh();
    for (let i = 0; i < MAX_PLUGINS; i += 1) {
      store.install(manifest({ id: `acme.p${i}`, skills: [{ name: `技能 ${i}`, instructions: "x" }] }));
    }

    expect(store.preview(manifest({ id: "acme.overflow" })).limitReached).toBe(true);
    expect(store.preview(manifest({ id: "acme.p0" })).limitReached).toBe(false);
  });

  it("详情读取真实技能与服务状态；停用同步为未启用", () => {
    const { store } = fresh();
    store.install(v2Manifest());
    store.setEnabled("acme.weather", false);

    const skills = store.skillsOf("acme.weather");
    expect(skills.map((s) => s.name)).toEqual(["出行建议", "穿衣建议"]);
    expect(skills.every((s) => !s.enabled)).toBe(true);
    expect(skills[0].description).toBe("");

    const servers = store.serversOf("acme.weather");
    expect(servers.map((s) => s.name)).toEqual(["天气服务", "预警服务", "潮汐服务"]);
    expect(servers[0].url).toBe("https://mcp.example.com/weather");
    expect(servers.every((s) => !s.enabled)).toBe(true);
  });

  it("服务被用户改成手工来源后，详情与移除预览都不再把它算作插件资产", () => {
    const { store, mcp } = fresh();
    store.install(v2Manifest());
    const id = pluginServerId("acme.weather", "tide");
    mcp.port.update(id, { origin: "manual" });

    expect(store.serversOf("acme.weather").map((s) => s.name)).not.toContain("潮汐服务");
    const preview = store.preview(
      v2Manifest({ mcpServers: [{ key: "weather", name: "天气服务", url: "https://mcp.example.com/weather" }] }),
    );
    expect(preview.servers.removed.map((s) => s.key)).toEqual(["alerts"]);
  });
});
