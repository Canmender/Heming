import { describe, it, expect } from "vitest";
import { McpRegistry, MCP_SERVERS_KEY } from "../mcp/index.js";
import { SkillPool, SKILLS_KEY, type StorageLike } from "../skills/index.js";
import { contentFingerprint, PublisherTrustStore, PluginManifestError } from "./index.js";
import {
  INSTALL_WRITE_BUDGET_BYTES,
  PLUGIN_TXN_KEYS,
  PLUGINS_KEY,
  PluginInstallError,
  PluginStore,
  pluginServerId,
} from "./store.js";

/**
 * 安装事务（d.105 / 规格 §5.2）：plan → prepare/persist → 失败 rollback。
 *
 * 这些用例的存在理由：localStorage 没有真正事务，本仓此前的 `save()` 还会**吞**
 * 配额异常——用户看到「装好了」，重启后却是半装态。这里用「注入 StorageLike，
 * 让指定键的 setItem 抛错」把最难复现的那条路径（写失败 → 补偿 → 内存 reload）
 * 变成可回归的断言，并把「回滚失败必须如实报告」钉住。
 */

function makeStorage(
  map = new Map<string, string>(),
  throwing = new Set<string>(),
): { storage: StorageLike; map: Map<string, string> } {
  return {
    map,
    storage: {
      getItem: (key) => (map.has(key) ? (map.get(key) as string) : null),
      setItem: (key, value) => {
        if (throwing.has(key)) throw new Error(`QuotaExceededError: ${key}`);
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

/** v3 声明式包：1 技能 + 1 MCP 服务（v5 兼容性另有专门用例）。 */
function manifest(overrides: Record<string, unknown> = {}): Record<string, unknown> {
  return {
    schemaVersion: 3,
    id: "acme.txn",
    name: "事务测试包",
    version: "1.0.0",
    permissions: { network: ["mcp.example.com"], tools: "read", files: [] },
    contributions: {
      skills: [{ name: "周报", instructions: "写周报。" }],
      mcpServers: [{ key: "report", name: "报告服务", url: "https://mcp.example.com/mcp" }],
    },
    ...overrides,
  };
}

/** 改版本 + 改技能正文（保证内容指纹与 diff 都变）。 */
function upgrade(version: string, instructions = "写周报（新）。"): Record<string, unknown> {
  return manifest({
    version,
    contributions: {
      skills: [{ name: "周报", instructions }],
      mcpServers: [{ key: "report", name: "报告服务", url: "https://mcp.example.com/mcp" }],
    },
  });
}

/** v5 清单（engines 必填）：用于兼容性与存储回读。 */
function v5Manifest(overrides: Record<string, unknown> = {}): Record<string, unknown> {
  return {
    schemaVersion: 5,
    id: "acme.v5",
    name: "v5 包",
    version: "1.0.0",
    engines: { heming: "d.104" },
    permissions: { network: [], tools: "read", files: [] },
    contributions: {
      skills: [{ name: "v5 技能", instructions: "做点什么。" }],
    },
    ...overrides,
  };
}

function fresh(throwing = new Set<string>()): {
  store: PluginStore;
  pool: SkillPool;
  mcp: McpRegistry;
  map: Map<string, string>;
  storage: StorageLike;
  publishers: PublisherTrustStore;
} {
  const { storage, map } = makeStorage(new Map(), throwing);
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

describe("安装事务 · plan 是纯函数", () => {
  it("planInstall 不写任何存储；差异/体积/警告都算好", () => {
    const { store, map } = fresh();
    const before = new Map(map);

    const plan = store.planInstall(manifest());

    expect(map).toEqual(before); // 一个字节都没写
    expect(plan.mode).toBe("install");
    expect(plan.diff.skills.added).toEqual(["周报"]);
    expect(plan.diff.servers.added.map((entry) => entry.key)).toEqual(["report"]);
    expect(plan.writes.some((write) => write.key === PLUGINS_KEY && write.action === "create")).toBe(
      true,
    );
    expect(plan.writes.map((write) => write.key)).toContain(SKILLS_KEY);
    expect(plan.blocked).toEqual([]);
    expect(plan.engines.status).toBe("compatible");
    expect(plan.size.exceeded).toBe(false);
    expect(plan.size.keys).toEqual([...PLUGIN_TXN_KEYS]);
    // v1–v4 没有 engines：给一条「未标注兼容性」的非阻断提示。
    expect(plan.warnings.some((warning) => warning.includes("未标注兼容性"))).toBe(true);
  });

  it("applyPlan 落盘：技能物化、服务登记、previous/history/highestVersion 初始值", () => {
    const { store, pool, mcp } = fresh();
    const result = store.applyPlan(store.planInstall(manifest()));

    expect(result.applied).toBe("applied");
    expect(result.changed).toBe(true);
    expect(result.added).toBe(1);
    expect(result.serversAdded).toBe(1);
    const saved = store.get("acme.txn");
    expect(saved?.fingerprint).toBe(contentFingerprint(saved!.manifest));
    expect(saved?.history).toEqual([
      { version: "1.0.0", at: expect.any(String) },
    ]);
    expect(saved?.highestVersion).toBe("1.0.0");
    expect(saved?.previous).toBeUndefined();
    expect(pool.list().filter((skill) => skill.pluginId === "acme.txn")).toHaveLength(1);
    expect(mcp.get(pluginServerId("acme.txn", "report"))?.origin).toBe("plugin");
  });

  it("同清单重复 apply 幂等：changed=false，且不重写记录", () => {
    const { store, map } = fresh();
    store.applyPlan(store.planInstall(manifest()));
    const rawAfterInstall = map.get(PLUGINS_KEY);

    const again = store.applyPlan(store.planInstall(manifest()));

    expect(again.applied).toBe("applied");
    expect(again.changed).toBe(false);
    expect(map.get(PLUGINS_KEY)).toBe(rawAfterInstall);
  });
});

describe("安装事务 · 更新与回滚到上一版", () => {
  it("更新写入 previous（旧清单原样）、history（≤3）与 highestVersion", () => {
    const { store } = fresh();
    store.applyPlan(store.planInstall(manifest()));

    store.applyPlan(store.planInstall(upgrade("1.1.0")));
    const record = store.get("acme.txn")!;

    expect(record.manifest.version).toBe("1.1.0");
    expect(record.previous?.manifest.version).toBe("1.0.0");
    expect(record.previous?.manifest.contributions.skills[0].instructions).toBe("写周报。");
    expect(record.previous?.fingerprint).toBeTruthy();
    expect(record.history?.map((entry) => entry.version)).toEqual(["1.0.0", "1.1.0"]);
    expect(record.highestVersion).toBe("1.1.0");
  });

  it("history 最多 3 条：连续升级丢最旧", () => {
    const { store } = fresh();
    store.applyPlan(store.planInstall(manifest()));
    for (const version of ["1.1.0", "1.2.0", "1.3.0", "1.4.0"]) {
      store.applyPlan(store.planInstall(upgrade(version, `写周报 ${version}。`)));
    }
    const record = store.get("acme.txn")!;
    expect(record.history).toHaveLength(3);
    expect(record.history?.map((entry) => entry.version)).toEqual(["1.2.0", "1.3.0", "1.4.0"]);
  });

  it("rollbackToPrevious 用本机旧清单走同一 plan/apply，并交换 previous", () => {
    const { store, pool } = fresh();
    store.applyPlan(store.planInstall(manifest()));
    store.applyPlan(store.planInstall(upgrade("1.1.0")));
    expect(pool.list().find((skill) => skill.pluginId === "acme.txn")?.instructions).toBe(
      "写周报（新）。",
    );

    const rolled = store.rollbackToPrevious("acme.txn");

    expect(rolled.applied).toBe("applied");
    expect(rolled.mode).toBe("update");
    const record = store.get("acme.txn")!;
    expect(record.manifest.version).toBe("1.0.0");
    expect(record.previous?.manifest.version).toBe("1.1.0"); // 交换完成
    expect(pool.list().find((skill) => skill.pluginId === "acme.txn")?.instructions).toBe(
      "写周报。",
    );
    expect(record.highestVersion).toBe("1.1.0"); // 防降级水位不回退
  });

  it("没有 previous 时回滚给出明确错误", () => {
    const { store } = fresh();
    store.applyPlan(store.planInstall(manifest()));
    expect(() => store.rollbackToPrevious("acme.txn")).toThrow("没有保留上一版");
  });

  it("防降级：低于 highestVersion 的计划被 block，显式 allowDowngrade 才放行", () => {
    const { store } = fresh();
    store.applyPlan(store.planInstall(upgrade("1.1.0")));

    const blocked = store.planInstall(manifest());
    expect(blocked.blocked.map((item) => item.code)).toContain("downgrade");
    const refused = store.applyPlan(blocked);
    expect(refused.applied).toBe("failed");
    expect(refused.plugin).toBeNull();
    expect(store.get("acme.txn")?.manifest.version).toBe("1.1.0");

    const allowed = store.applyPlan(store.planInstall(manifest(), { allowDowngrade: true }));
    expect(allowed.applied).toBe("applied");
    expect(store.get("acme.txn")?.manifest.version).toBe("1.0.0");
    expect(store.get("acme.txn")?.highestVersion).toBe("1.1.0");
  });

  it("权限扩张必须重新确认：未确认不写存储，确认后才生效", () => {
    const { store, map } = fresh();
    store.applyPlan(store.planInstall(manifest()));
    const before = new Map(map);

    const expanded = manifest({
      version: "1.1.0",
      permissions: { network: ["mcp.example.com", "extra.example.com"], tools: "write", files: [] },
      contributions: {
        skills: [{ name: "周报", instructions: "写周报。" }],
        mcpServers: [{ key: "report", name: "报告服务", url: "https://mcp.example.com/mcp" }],
        commands: [{ id: "weekly", title: "生成周报", target: { kind: "plugin" } }],
      },
    });
    const plan = store.planInstall(expanded);

    expect(plan.permissionUpgrade.networkAdded).toEqual(["extra.example.com"]);
    expect(plan.permissionUpgrade.toolsWidened).toEqual({ from: "read", to: "write" });
    expect(plan.permissionUpgrade.newKinds).toEqual(["commands"]);
    expect(plan.permissionUpgrade.expands).toBe(true);
    expect(plan.needsConfirmation).toBe(true);

    const refused = store.applyPlan(plan);
    expect(refused.applied).toBe("failed");
    expect(refused.diagnostics.some((item) => item.code === "confirm")).toBe(true);
    expect(map).toEqual(before); // 拒绝时一个字节都不写
    expect(store.get("acme.txn")?.manifest.version).toBe("1.0.0");

    const confirmed = store.applyPlan(
      store.planInstall(expanded, { confirmPermissionExpansion: true }),
    );
    expect(confirmed.applied).toBe("applied");
    expect(store.get("acme.txn")?.manifest.version).toBe("1.1.0");
    expect(store.get("acme.txn")?.manifest.permissions.tools).toBe("write");
  });
});

describe("安装事务 · engines 与体积预检", () => {
  it("engines 不兼容：plan 标 reasons、apply 拒绝且不落盘", () => {
    const { store, map } = fresh();
    const plan = store.planInstall(v5Manifest({ engines: { heming: "d.999" } }));

    expect(plan.engines.status).toBe("needsNewerApp");
    expect(plan.blocked.map((item) => item.code)).toContain("engines");
    const result = store.applyPlan(plan);
    expect(result.applied).toBe("failed");
    expect(result.diagnostics.some((item) => item.code === "engines")).toBe(true);
    expect(store.list()).toEqual([]);
    expect(map.get(PLUGINS_KEY)).toBeUndefined();
  });

  it("engines 满足时 v5 安装成功，重开 store 仍读得回 engines", () => {
    const { store, storage, pool, mcp, publishers } = fresh();
    const plan = store.planInstall(v5Manifest(), { appVersion: "d.106.2.42.0" });
    expect(plan.blocked).toEqual([]);
    expect(plan.v5.engines.heming).toBe("d.104");

    expect(store.applyPlan(plan).applied).toBe("applied");
    expect(store.get("acme.v5")?.manifest.engines).toEqual({ heming: "d.104" });

    // 存储回读：v5 记录必须按 v5 规则重读（engines 不进 v4 的 strip 路径）。
    const reloaded = new PluginStore(storage, pool, clock(), mcp, publishers);
    expect(reloaded.get("acme.v5")?.manifest.engines).toEqual({ heming: "d.104" });
    expect(reloaded.list()).toHaveLength(1);
  });

  it("v5 更新后 previous 能随记录读回，并可直接回滚", () => {
    const { store, storage, pool, mcp, publishers } = fresh();
    const at = { appVersion: "d.106.2.42.0" };
    store.applyPlan(store.planInstall(v5Manifest(), at));
    store.applyPlan(
      store.planInstall(
        v5Manifest({
          version: "1.1.0",
          contributions: { skills: [{ name: "v5 技能", instructions: "新指令。" }] },
        }),
        at,
      ),
    );

    const reloaded = new PluginStore(storage, pool, clock(), mcp, publishers);
    const record = reloaded.get("acme.v5")!;
    expect(record.previous?.manifest.version).toBe("1.0.0");
    expect(record.previous?.manifest.engines).toEqual({ heming: "d.104" });

    const rolled = reloaded.rollbackToPrevious("acme.v5");
    expect(rolled.applied).toBe("applied");
    expect(reloaded.get("acme.v5")?.manifest.version).toBe("1.0.0");
  });

  it("plan 把 v5 的未知字段警告带出来（装前可见），不阻断安装", () => {
    const { store } = fresh();
    const plan = store.planInstall({ ...v5Manifest(), futureField: "x" }, { appVersion: "d.106.2.42.0" });

    expect(plan.warnings.some((warning) => warning.includes("已忽略未知字段 futureField"))).toBe(true);
    expect(plan.blocked).toEqual([]);
    expect(store.applyPlan(plan).applied).toBe("applied");
  });

  it("体积预检：受影响键已接近预算时直接拒绝，不进入写阶段", () => {
    const { store, map } = fresh();
    map.set(SKILLS_KEY, "x".repeat(INSTALL_WRITE_BUDGET_BYTES));
    const before = new Map(map);

    const plan = store.planInstall(manifest());

    expect(plan.size.currentBytes).toBeGreaterThanOrEqual(INSTALL_WRITE_BUDGET_BYTES);
    expect(plan.size.afterBytes).toBeGreaterThan(INSTALL_WRITE_BUDGET_BYTES);
    expect(plan.size.exceeded).toBe(true);
    expect(plan.size.suggestion).toContain("请先清理");
    expect(plan.blocked.map((item) => item.code)).toContain("size");

    const result = store.applyPlan(plan);
    expect(result.applied).toBe("failed");
    expect(map).toEqual(before);
    expect(store.list()).toEqual([]);
  });
});

describe("安装事务 · 写失败回滚与诚实报告", () => {
  it("技能键 setItem 抛错：整笔回滚 + 三个单例 reload + rollback.ok=false", () => {
    const throwing = new Set<string>([SKILLS_KEY]);
    const { store, pool, mcp, map } = fresh(throwing);
    const before = new Map(map);

    const result = store.applyPlan(store.planInstall(manifest()));

    expect(result.applied).toBe("failed");
    expect(result.changed).toBe(false);
    expect(result.plugin).toBeNull();
    expect(result.added).toBe(0);
    // 补偿写同样会失败（同一个键在抛），必须如实报告而不是谎报「已恢复」。
    expect(result.rollback?.ok).toBe(false);
    expect(result.rollback?.keys).toEqual([...PLUGIN_TXN_KEYS]);
    expect(result.rollback?.error).toContain(SKILLS_KEY);
    expect(result.diagnostics.some((item) => item.code === "apply-failed")).toBe(true);
    // 存储回到安装前
    expect(map).toEqual(before);
    // 内存 reload 生效：没有插件记录、没有插件技能、没有插件服务
    expect(store.list()).toEqual([]);
    expect(store.get("acme.txn")).toBeUndefined();
    expect(pool.list().filter((skill) => skill.pluginId === "acme.txn")).toEqual([]);
    expect(mcp.get(pluginServerId("acme.txn", "report"))).toBeUndefined();
  });

  it("插件记录键 setItem 抛错：技能/服务已写也要回滚，install() 抛 PluginInstallError", () => {
    const throwing = new Set<string>([PLUGINS_KEY]);
    const { store, pool, mcp, map } = fresh(throwing);
    const before = new Map(map);

    let caught: unknown;
    try {
      store.install(manifest());
    } catch (err) {
      caught = err;
    }

    expect(caught).toBeInstanceOf(PluginInstallError);
    const failure = caught as PluginInstallError;
    expect(failure.result.applied).toBe("failed");
    expect(failure.result.rollback?.ok).toBe(false);
    expect(failure.result.rollback?.error).toContain(PLUGINS_KEY);
    expect(failure.message).toContain("回滚未能完全恢复");
    // 先写的技能/服务被逐键恢复（键值逐字节等于安装前）
    expect(map).toEqual(before);
    expect(store.list()).toEqual([]);
    expect(pool.list().filter((skill) => skill.pluginId === "acme.txn")).toEqual([]);
    expect(mcp.get(pluginServerId("acme.txn", "report"))).toBeUndefined();
  });

  it("install() 的硬规则失败仍抛 PluginManifestError（旧入口语义不变）", () => {
    const { store } = fresh();
    const conflictId = pluginServerId("acme.txn", "report");
    store.install(manifest());
    // 手填同名服务制造 id 冲突
    const mcpPort = (store as unknown as { mcp: { get(id: string): unknown } }).mcp;
    expect(mcpPort.get(conflictId)).toBeTruthy();

    const { store: other, mcp: otherMcp } = fresh();
    otherMcp.add({
      id: conflictId,
      name: "手填服务",
      transport: "http",
      url: "https://manual.example.com/mcp",
      origin: "manual",
    });
    expect(() => other.install(manifest())).toThrow(PluginManifestError);
    expect(() => other.install(manifest())).toThrow("MCP 服务 id 冲突");
  });
});
