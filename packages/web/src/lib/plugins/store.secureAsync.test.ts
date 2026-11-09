import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { MCP_SERVERS_KEY, McpRegistry } from "../mcp/index.js";
import { SKILLS_KEY, SkillPool } from "../skills/index.js";
import {
  flushSecureWrites,
  resetSecureStorageState,
  secureStorageFor,
} from "../secureStorage.js";
import type { StorageLike } from "../memory/types.js";
import { PLUGINS_KEY, PluginStore, pluginServerId } from "./store.js";

/**
 * 桌面版异步安全存储下的插件事务（d.119 真实缺陷回归）。
 *
 * 症状：desktop 上安装/启停带 MCP 服务的插件提示
 * 「保存失败：MCP 服务启用位写入失败：heming.mcp.servers.v1 读回与写入前相同」，
 * 插件装不上、开关一按住就弹错。
 *
 * 根因：`heming.mcp.servers.v1` 走 `secureStorageFor()`，桌面桥（46+）默认**异步加密落盘**
 * （`secureSetItem` 只排队，"写后立即读一致" 由 `pendingPlain` 保证）。而插件事务的读回
 * 校验直接读**原始 localStorage**——这一刻底层还是旧值 ⇒ 误判成写失败并整笔回滚。
 *
 * 这些用例用真实 `McpRegistry` + 异步桥桩把三条路径钉死：
 * 1. 安装带服务的插件不再误报；2. 启停不再误报；3. 真写失败回滚时，
 *    排队中的安全写必须被丢弃，否则迟到的写会把刚回滚的值又盖成新的。
 */

function makeStorage(): {
  storage: StorageLike;
  map: Map<string, string>;
  failKeys: Set<string>;
} {
  const map = new Map<string, string>();
  const failKeys = new Set<string>();
  return {
    map,
    failKeys,
    storage: {
      getItem: (key) => (map.has(key) ? (map.get(key) as string) : null),
      setItem: (key, value) => {
        if (failKeys.has(key)) throw new Error(`QuotaExceededError: ${key}`);
        map.set(key, value);
      },
      removeItem: (key) => {
        if (failKeys.has(key)) throw new Error(`QuotaExceededError: ${key}`);
        map.delete(key);
      },
    },
  };
}

function clock(start = Date.UTC(2026, 10, 9)): () => number {
  let t = start;
  return () => (t += 1000);
}

/** 模拟 preload 的异步安全存储桥（d.59 默认路径：有异步 API 就优先异步）。 */
function installAsyncBridge(): void {
  (window as unknown as { __heming_secrets?: unknown }).__heming_secrets = {
    // 46 起同步探测为 false：只有异步三件套可用
    available: false,
    asyncAvailable: true,
    mode: "async",
    encrypt: () => null,
    decrypt: () => null,
    encryptAsync: (plain: string) => Promise.resolve(`enc:${plain}`),
    decryptAsync: (cipher: string) =>
      Promise.resolve(cipher.startsWith("enc:") ? cipher.slice(4) : null),
    availableAsync: () => Promise.resolve(true),
  };
}

function removeBridge(): void {
  delete (window as unknown as { __heming_secrets?: unknown }).__heming_secrets;
}

function manifest(): Record<string, unknown> {
  return {
    schemaVersion: 3,
    id: "acme.secure",
    name: "安全存储测试包",
    version: "1.0.0",
    permissions: { network: ["mcp.example.com"], tools: "read", files: [] },
    contributions: {
      skills: [{ name: "周报", instructions: "写周报。" }],
      mcpServers: [{ key: "report", name: "报告服务", url: "https://mcp.example.com/mcp" }],
    },
  };
}

/** 生产同构：MCP 注册表写服务走安全存储（异步信封），插件记录/技能池走普通存储。 */
function fresh(): {
  store: PluginStore;
  mcp: McpRegistry;
  map: Map<string, string>;
  failKeys: Set<string>;
} {
  const { storage, map, failKeys } = makeStorage();
  const mcp = new McpRegistry(secureStorageFor(MCP_SERVERS_KEY, storage), () =>
    new Date(Date.UTC(2026, 10, 9)).toISOString(),
  );
  const pool = new SkillPool(storage, clock());
  return { store: new PluginStore(storage, pool, clock(), mcp), mcp, map, failKeys };
}

const SERVER_ID = pluginServerId("acme.secure", "report");

/** 落盘后按桥的口径解出 MCP 服务表（验证「迟到的写」有没有盖掉回滚值）。 */
function storedServers(map: Map<string, string>): Array<{ id: string; enabled: boolean }> {
  const raw = map.get(MCP_SERVERS_KEY) ?? "";
  const parsed = JSON.parse(raw) as { __hemingEnc?: string; data?: string };
  const plain = parsed.data?.startsWith("enc:")
    ? parsed.data.slice(4)
    : (JSON.parse(raw) as Array<{ id: string; enabled: boolean }>);
  return typeof plain === "string"
    ? (JSON.parse(plain) as Array<{ id: string; enabled: boolean }>)
    : plain;
}

describe("插件事务 · 桌面异步安全存储", () => {
  beforeEach(() => {
    resetSecureStorageState();
    installAsyncBridge();
  });
  afterEach(() => {
    removeBridge();
    resetSecureStorageState();
  });

  it("安装带 MCP 服务的插件不应误报写失败（用户遇到的原始报错）", () => {
    const { store, mcp } = fresh();

    const result = store.install(JSON.stringify(manifest()));

    expect(result.plugin.manifest.id).toBe("acme.secure");
    expect(store.list()).toHaveLength(1);
    expect(mcp.get(SERVER_ID)?.origin).toBe("plugin");
    expect(mcp.get(SERVER_ID)?.enabled).toBe(true);
  });

  it("启停插件（写 MCP 服务启用位）不应误报「读回与写入前相同」", () => {
    const { store, mcp } = fresh();
    store.install(JSON.stringify(manifest()));

    const off = store.setEnabled("acme.secure", false);
    expect(off.ok).toBe(true);
    expect(mcp.get(SERVER_ID)?.enabled).toBe(false);

    const on = store.setEnabled("acme.secure", true);
    expect(on.ok).toBe(true);
    expect(mcp.get(SERVER_ID)?.enabled).toBe(true);
  });

  it("贡献级停用服务同样不误报（setKindEnabled）", () => {
    const { store, mcp } = fresh();
    store.install(JSON.stringify(manifest()));

    const result = store.setKindEnabled("acme.secure", "mcpServers", false);

    expect(result.ok).toBe(true);
    expect(mcp.get(SERVER_ID)?.enabled).toBe(false);
  });

  it("真写失败回滚时丢弃排队中的安全写：迟到的写不能盖掉已回滚的值", async () => {
    const { store, mcp, failKeys, map } = fresh();
    store.install(JSON.stringify(manifest()));
    expect(mcp.get(SERVER_ID)?.enabled).toBe(true);
    await flushSecureWrites();

    // 让「插件记录」这一步写失败：整笔事务必须回滚（技能/服务/记录都回到安装后状态）
    failKeys.add(PLUGINS_KEY);
    const result = store.setEnabled("acme.secure", false);
    failKeys.delete(PLUGINS_KEY);

    expect(result.ok).toBe(false);
    // 内存已回滚
    expect(mcp.get(SERVER_ID)?.enabled).toBe(true);

    // 排队中的加密写若没被丢弃，会在落盘时把 enabled=false 写回去（重启后开关「自己」关了）
    await flushSecureWrites();
    await Promise.resolve();
    expect(storedServers(map).find((s) => s.id === SERVER_ID)?.enabled).toBe(true);
    expect(store.get("acme.secure")?.enabled).toBe(true);
  });

  it("技能池写失败时同样回滚，且 MCP 服务保持回滚前状态", async () => {
    const { store, mcp, failKeys } = fresh();
    store.install(JSON.stringify(manifest()));

    failKeys.add(SKILLS_KEY);
    const result = store.setEnabled("acme.secure", false);
    failKeys.delete(SKILLS_KEY);

    expect(result.ok).toBe(false);
    await flushSecureWrites();
    expect(mcp.get(SERVER_ID)?.enabled).toBe(true);
  });
});
