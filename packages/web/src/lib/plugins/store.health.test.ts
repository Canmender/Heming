import { describe, it, expect } from "vitest";
import { McpRegistry, MCP_SERVERS_KEY } from "../mcp/index.js";
import { SkillPool, SKILLS_KEY, type StorageLike } from "../skills/index.js";
import {
  contentFingerprint,
  parsePluginManifest,
  PublisherTrustStore,
} from "./index.js";
import {
  PLUGINS_KEY,
  PluginStore,
  inspectPluginHealth,
  pluginServerId,
  type InstalledPlugin,
} from "./store.js";

/**
 * 插件健康度与修复（d.113）。
 *
 * 背景：安装事务已经能保证「新操作不留半装态」，但**历史坏状态**只能看见不能修：
 * `invalidRecord`、悬空 skillIds/serverIds、被手改的 fingerprint、签名异常……
 * 这个文件钉住两件事：
 * 1. `inspectPluginHealth` 是纯函数，7 类 issue 的分级与文案可独立回归；
 * 2. `repairPlugin` 只修**记录**（重建引用/重算指纹/尝试恢复清单），不删用户数据，
 *    写失败整笔回滚并如实报告 remainingIssues。
 */

function makeStorage(
  map = new Map<string, string>(),
  throwing = new Set<string>(),
  failOnce = new Set<string>(),
): { storage: StorageLike; map: Map<string, string> } {
  return {
    map,
    storage: {
      getItem: (key) => (map.has(key) ? (map.get(key) as string) : null),
      setItem: (key, value) => {
        if (throwing.has(key)) throw new Error(`QuotaExceededError: ${key}`);
        if (failOnce.has(key)) {
          failOnce.delete(key);
          throw new Error(`QuotaExceededError(once): ${key}`);
        }
        map.set(key, value);
      },
      removeItem: (key) => {
        if (throwing.has(key)) throw new Error(`QuotaExceededError: ${key}`);
        map.delete(key);
      },
    },
  };
}

function clock(start = Date.UTC(2026, 10, 1)): () => number {
  let t = start;
  return () => (t += 1000);
}

function rawManifest(overrides: Record<string, unknown> = {}): Record<string, unknown> {
  return {
    schemaVersion: 3,
    id: "acme.health",
    name: "健康测试包",
    version: "1.0.0",
    permissions: { network: ["mcp.example.com"], tools: "read", files: [] },
    contributions: {
      skills: [{ name: "周报", instructions: "写周报。" }],
      mcpServers: [{ key: "report", name: "报告服务", url: "https://mcp.example.com/mcp" }],
    },
    ...overrides,
  };
}

function rawV5(overrides: Record<string, unknown> = {}): Record<string, unknown> {
  return {
    schemaVersion: 5,
    id: "acme.health5",
    name: "v5 健康包",
    version: "1.0.0",
    engines: { heming: "d.104" },
    permissions: { network: [], tools: "read", files: [] },
    contributions: { skills: [{ name: "v5 技能", instructions: "做点什么。" }] },
    ...overrides,
  };
}

function fresh(throwing = new Set<string>(), failOnce = new Set<string>()): {
  store: PluginStore;
  pool: SkillPool;
  mcp: McpRegistry;
  map: Map<string, string>;
  storage: StorageLike;
  publishers: PublisherTrustStore;
} {
  const { storage, map } = makeStorage(new Map(), throwing, failOnce);
  const pool = new SkillPool(storage, clock());
  const mcp = new McpRegistry(storage, () => new Date(Date.UTC(2026, 10, 1)).toISOString());
  const publishers = new PublisherTrustStore(storage);
  return {
    store: new PluginStore(storage, pool, clock(), mcp, publishers),
    pool,
    mcp,
    map,
    storage,
    publishers,
  };
}

/** 直接改存储里的插件记录（模拟历史遗留/手改存储）。 */
function mutateStoredPlugin(
  map: Map<string, string>,
  mutate: (plugin: Record<string, unknown>) => void,
): void {
  const data = JSON.parse(map.get(PLUGINS_KEY) as string) as {
    plugins: Array<Record<string, unknown>>;
  };
  mutate(data.plugins[0]);
  map.set(PLUGINS_KEY, JSON.stringify(data));
}

/** 纯函数夹具：默认无关健康问题，按用例覆盖字段。 */
function fixture(overrides: Partial<InstalledPlugin> = {}): InstalledPlugin {
  const manifest = parsePluginManifest(rawManifest());
  return {
    manifest,
    enabled: true,
    skillIds: [],
    serverIds: [],
    fingerprint: contentFingerprint(manifest),
    publisher: null,
    signature: null,
    disabledKinds: [],
    installedAt: "2026-11-01T00:00:00.000Z",
    updatedAt: "2026-11-01T00:00:00.000Z",
    ...overrides,
  };
}

const skillRefs = (ids: string[], pluginId = "acme.health") =>
  ids.map((id) => ({ id, pluginId }));
const serverRefs = (ids: string[]) => ids.map((id) => ({ id, origin: "plugin" as const }));

describe("PluginStore · v5 清单读回", () => {
  it("list() 的清单与落盘记录指纹一致（permissions.chat 不能漏拷）", () => {
    const { store } = fresh();
    store.install(rawV5());

    const listed = store.list()[0];
    // v5 归一化后 permissions 一定带 chat（缺省 false）；拷贝时漏掉它会让指纹漂移。
    expect(listed.manifest.permissions.chat).toBe(false);
    expect(listed.fingerprint).toBe(contentFingerprint(listed.manifest));

    const health = inspectPluginHealth(
      listed,
      listed.skillIds.map((id) => ({ id, pluginId: listed.manifest.id })),
      [],
      { appVersion: "d.121.3.47.0" },
    );
    expect(health.issues.map((issue) => issue.code)).not.toContain("fingerprint-mismatch");
    expect(health.level).toBe("ok");
  });
});

describe("inspectPluginHealth · 7 类问题与分级", () => {
  it("全绿：引用都在、指纹一致、签名无异常 → ok", () => {
    const plugin = fixture({ skillIds: ["skill-1"], serverIds: ["plugin:acme.health:report"] });
    const health = inspectPluginHealth(
      plugin,
      skillRefs(["skill-1"]),
      serverRefs(["plugin:acme.health:report"]),
      { appVersion: "d.106.2.42.0" },
    );
    expect(health.level).toBe("ok");
    expect(health.issues).toEqual([]);
    expect(health.danglingSkills).toBe(0);
    expect(health.danglingServers).toBe(0);
  });

  it("dangling-skill：部分悬空降级、全部悬空算损坏", () => {
    const partial = fixture({ skillIds: ["skill-1", "skill-gone"] });
    const degraded = inspectPluginHealth(partial, skillRefs(["skill-1"]), [], {
      appVersion: "d.106.2.42.0",
    });
    expect(degraded.level).toBe("degraded");
    expect(degraded.danglingSkills).toBe(1);
    expect(degraded.issues.map((issue) => issue.code)).toContain("dangling-skill");
    expect(degraded.issues.find((issue) => issue.code === "dangling-skill")?.message).toContain(
      "skill-gone",
    );

    // 记录声称的贡献全部悬空 → 只能靠修复/重装，标 broken
    const allGone = fixture({ skillIds: ["skill-gone"] });
    const broken = inspectPluginHealth(allGone, [], [], { appVersion: "d.106.2.42.0" });
    expect(broken.level).toBe("broken");
    expect(broken.issues.find((issue) => issue.code === "dangling-skill")?.severity).toBe(
      "degraded",
    );
  });

  it("引用存在但归属不对（技能属别人 / 服务被改成手填）同样算悬空", () => {
    const plugin = fixture({ skillIds: ["skill-user"], serverIds: ["plugin:acme.health:manual"] });
    const health = inspectPluginHealth(
      plugin,
      [{ id: "skill-user" }],
      [{ id: "plugin:acme.health:manual", origin: "manual" }],
      { appVersion: "d.106.2.42.0" },
    );
    expect(health.danglingSkills).toBe(1);
    expect(health.danglingServers).toBe(1);
    expect(health.issues.filter((issue) => issue.code === "dangling-skill")).toHaveLength(1);
    expect(health.issues.filter((issue) => issue.code === "dangling-server")).toHaveLength(1);
  });

  it("fingerprint-mismatch：记录指纹与清单内容不一致 → degraded", () => {
    const plugin = fixture({ fingerprint: "fnv1a64b:0000000000000000" });
    const health = inspectPluginHealth(plugin, [], [], { appVersion: "d.106.2.42.0" });
    expect(health.level).toBe("degraded");
    expect(health.issues.map((issue) => issue.code)).toContain("fingerprint-mismatch");
  });

  it("签名：invalid 报 signature-invalid，unsupported 报 signature-unverified", () => {
    const invalid = fixture({ signature: { status: "invalid" } });
    expect(
      inspectPluginHealth(invalid, [], [], { appVersion: "d.106.2.42.0" }).issues.map(
        (issue) => issue.code,
      ),
    ).toContain("signature-invalid");

    const unsupported = fixture({ signature: { status: "unsupported" } });
    expect(
      inspectPluginHealth(unsupported, [], [], { appVersion: "d.106.2.42.0" }).issues.map(
        (issue) => issue.code,
      ),
    ).toContain("signature-unverified");
  });

  it("all-contributions-off：启用但贡献级全关才报；主动停用不报", () => {
    const off = fixture({ disabledKinds: ["skills", "mcpServers"] });
    const health = inspectPluginHealth(off, [], [], { appVersion: "d.106.2.42.0" });
    expect(health.issues.map((issue) => issue.code)).toContain("all-contributions-off");

    const disabledByUser = fixture({ enabled: false, disabledKinds: ["skills", "mcpServers"] });
    expect(
      inspectPluginHealth(disabledByUser, [], [], { appVersion: "d.106.2.42.0" }).issues.map(
        (issue) => issue.code,
      ),
    ).not.toContain("all-contributions-off");
  });

  it("incompatible：engines 不满足当前版本", () => {
    const manifest = parsePluginManifest(rawV5({ engines: { heming: "d.999" } }));
    const plugin = fixture({
      manifest,
      fingerprint: contentFingerprint(manifest),
      skillIds: [],
    });
    const health = inspectPluginHealth(plugin, [], [], { appVersion: "d.106.2.42.0" });
    expect(health.issues.map((issue) => issue.code)).toContain("incompatible");
    expect(health.level).toBe("degraded");
  });

  it("invalid-record：直接判损坏（即使引用都在）", () => {
    const plugin = fixture({
      skillIds: ["skill-1"],
      invalidRecord: true,
      invalidReason: "v5 清单记录损坏：engines 必填",
    });
    const health = inspectPluginHealth(plugin, skillRefs(["skill-1"]), [], {
      appVersion: "d.106.2.42.0",
    });
    expect(health.level).toBe("broken");
    expect(health.issues[0].code).toBe("invalid-record");
    expect(health.issues[0].message).toContain("engines 必填");
  });
});

describe("repairPlugin · 只修记录，不删用户数据", () => {
  it("重建 skillIds：补回漏登的技能、摘掉悬空引用（技能本身不动）", () => {
    const { store, pool, map, storage, mcp, publishers } = fresh();
    store.install(rawManifest());
    const pluginId = "acme.health";
    const liveSkill = pool.list().find((skill) => skill.pluginId === pluginId)!;
    // 漏登：池里还有一条属于本插件的技能，但记录里没写
    const orphan = pool.create({
      name: "漏登技能",
      description: "",
      instructions: "x",
      triggers: [],
      tags: [],
      enabled: true,
      version: "1.0.0",
      source: "imported",
      pluginId,
    });
    mutateStoredPlugin(map, (plugin) => {
      plugin.skillIds = ["skill-gone"];
    });

    const reloaded = new PluginStore(storage, pool, clock(), mcp, publishers);
    const before = reloaded.health(pluginId)!;
    expect(before.danglingSkills).toBe(1);

    const result = reloaded.repairPlugin(pluginId);

    expect(result.ok).toBe(true);
    expect(result.repaired).toContain("skillIds");
    expect(result.dropped).toContain("skill:skill-gone");
    const repaired = reloaded.get(pluginId)!;
    expect(repaired.skillIds.sort()).toEqual([liveSkill.id, orphan.id].sort());
    // 技能池没有被删任何东西
    expect(pool.list().filter((skill) => skill.pluginId === pluginId)).toHaveLength(2);
    expect(result.remainingIssues).toEqual([]);
  });

  it("重建 serverIds：补回漏登插件服务、摘掉悬空引用（服务本身不动）", () => {
    const { store, map, storage, pool, mcp, publishers } = fresh();
    store.install(rawManifest());
    const pluginId = "acme.health";
    const reportId = pluginServerId(pluginId, "report");
    const orphanServer = mcp.add({
      id: pluginServerId(pluginId, "extra"),
      name: "漏登服务",
      transport: "http",
      url: "https://mcp.example.com/extra",
      origin: "plugin",
    });
    mutateStoredPlugin(map, (plugin) => {
      plugin.serverIds = ["plugin:acme.health:gone"];
    });

    const reloaded = new PluginStore(storage, pool, clock(), mcp, publishers);
    const result = reloaded.repairPlugin(pluginId);

    expect(result.ok).toBe(true);
    expect(result.repaired).toContain("serverIds");
    expect(result.dropped).toContain("server:plugin:acme.health:gone");
    expect(reloaded.get(pluginId)!.serverIds).toEqual([reportId, orphanServer.id]);
    expect(mcp.get(reportId)?.origin).toBe("plugin");
    expect(mcp.get(orphanServer.id)?.origin).toBe("plugin");
  });

  it("fingerprint 校正：按当前清单重算", () => {
    const { store, map, storage, pool, mcp, publishers } = fresh();
    store.install(rawManifest());
    mutateStoredPlugin(map, (plugin) => {
      plugin.fingerprint = "fnv1a64b:0000000000000000";
    });

    const reloaded = new PluginStore(storage, pool, clock(), mcp, publishers);
    expect(reloaded.health("acme.health")!.issues.map((issue) => issue.code)).toContain(
      "fingerprint-mismatch",
    );

    const result = reloaded.repairPlugin("acme.health");

    expect(result.ok).toBe(true);
    expect(result.repaired).toContain("fingerprint");
    expect(reloaded.get("acme.health")!.fingerprint).toBe(
      contentFingerprint(reloaded.get("acme.health")!.manifest),
    );
  });

  it("invalidRecord 不可修复：原始清单仍解析失败 → 保持损坏并说明原因", () => {
    const { store, map, storage, pool, mcp, publishers } = fresh();
    store.install(rawV5());
    const data = JSON.parse(map.get(PLUGINS_KEY) as string) as {
      plugins: Array<{ manifest: Record<string, unknown> }>;
    };
    delete data.plugins[0].manifest.engines;
    map.set(PLUGINS_KEY, JSON.stringify(data));

    const reloaded = new PluginStore(storage, pool, clock(), mcp, publishers);
    expect(reloaded.get("acme.health5")?.invalidRecord).toBe(true);

    const result = reloaded.repairPlugin("acme.health5");

    expect(result.ok).toBe(true);
    expect(result.repaired).not.toContain("manifest");
    expect(reloaded.get("acme.health5")?.invalidRecord).toBe(true);
    expect(result.remainingIssues.map((issue) => issue.code)).toContain("invalid-record");
    expect(result.health?.level).toBe("broken");
  });

  it("invalidRecord 可修复：存储里的原始清单被修好后清掉损坏标记", () => {
    const { store, map, storage, pool, mcp, publishers } = fresh();
    store.install(rawV5());
    const validManifest = JSON.parse(map.get(PLUGINS_KEY) as string).plugins[0].manifest;
    const data = JSON.parse(map.get(PLUGINS_KEY) as string) as {
      plugins: Array<{ manifest: Record<string, unknown> }>;
    };
    delete data.plugins[0].manifest.engines;
    map.set(PLUGINS_KEY, JSON.stringify(data));

    const reloaded = new PluginStore(storage, pool, clock(), mcp, publishers);
    expect(reloaded.get("acme.health5")?.invalidRecord).toBe(true);
    // 外部把原始清单修好（模拟 lint/手改修复）
    mutateStoredPlugin(map, (plugin) => {
      plugin.manifest = validManifest;
    });

    const result = reloaded.repairPlugin("acme.health5");

    expect(result.ok).toBe(true);
    expect(result.repaired).toContain("manifest");
    const repaired = reloaded.get("acme.health5")!;
    expect(repaired.invalidRecord).toBeUndefined();
    expect(repaired.manifest.engines).toEqual({ heming: "d.104" });
    expect(result.remainingIssues).toEqual([]);
    expect(result.health?.level).toBe("ok");
  });

  it("修复写失败：整笔回滚、repaired 为空，rollback 如实报告", () => {
    const throwing = new Set<string>();
    const failOnce = new Set<string>();
    const { store, map, storage, pool, mcp, publishers } = fresh(throwing, failOnce);
    store.install(rawManifest());
    mutateStoredPlugin(map, (plugin) => {
      plugin.skillIds = [];
      plugin.fingerprint = "fnv1a64b:0000000000000000";
    });

    const reloaded = new PluginStore(storage, pool, clock(), mcp, publishers);
    const before = new Map(map);
    failOnce.add(PLUGINS_KEY);

    const result = reloaded.repairPlugin("acme.health");

    expect(result.ok).toBe(false);
    expect(result.repaired).toEqual([]);
    expect(result.dropped).toEqual([]);
    expect(result.rollback?.ok).toBe(true);
    expect(map).toEqual(before);
    // reload 后仍是修复前的状态（没有半修）
    expect(reloaded.get("acme.health")!.skillIds).toEqual([]);
    expect(reloaded.health("acme.health")!.level).toBe("degraded");
  });

  it("持续写失败：rollback.ok=false 也算诚实（内存仍回到修复前）", () => {
    const throwing = new Set<string>();
    const { store, map, storage, pool, mcp, publishers } = fresh(throwing);
    store.install(rawManifest());
    mutateStoredPlugin(map, (plugin) => {
      plugin.skillIds = [];
    });
    const reloaded = new PluginStore(storage, pool, clock(), mcp, publishers);
    throwing.add(PLUGINS_KEY);

    const result = reloaded.repairPlugin("acme.health");

    expect(result.ok).toBe(false);
    expect(result.rollback?.ok).toBe(false);
    expect(result.rollback?.error).toContain(PLUGINS_KEY);
    expect(reloaded.get("acme.health")!.skillIds).toEqual([]);
  });

  it("插件不存在：明确报错且不写存储", () => {
    const { store, map } = fresh();
    const before = new Map(map);
    const result = store.repairPlugin("acme.missing");
    expect(result.ok).toBe(false);
    expect(result.error).toContain("插件不存在");
    expect(map).toEqual(before);
  });

  it("健康插件修复是 no-op：不写存储、repaired 为空", () => {
    const { store, map } = fresh();
    store.install(rawManifest());
    const before = new Map(map);

    const result = store.repairPlugin("acme.health");

    expect(result.ok).toBe(true);
    expect(result.repaired).toEqual([]);
    expect(result.dropped).toEqual([]);
    expect(map).toEqual(before);
  });
});

describe("健康度不误伤既有事务键", () => {
  it("health() 只读：调用前后存储逐字节不变", () => {
    const { store, map } = fresh();
    store.install(rawManifest());
    const before = new Map(map);
    store.health("acme.health");
    expect(map).toEqual(before);
    // 技能/服务键也在快照范围内
    expect(map.has(SKILLS_KEY)).toBe(true);
    expect(map.has(MCP_SERVERS_KEY)).toBe(true);
  });
});
