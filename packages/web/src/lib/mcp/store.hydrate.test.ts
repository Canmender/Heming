/**
 * d.59 · 启动时序（MCP 服务配置）：hydrate 完成后的补读、预置推迟与用户输入保护。
 *
 * 风险背景：Electron 46 没有同步桥兜底时，构造期 `readServers()` 对「缓存未命中的密文」
 * 只能拿到 null（异步补取是后台的）；此时若照旧 `seedDefaults()`，会用预置明文覆盖
 * 磁盘上的密文服务配置（请求头 token 一起丢）。所以构造期推迟预置，hydrate 后重新判断。
 */
import { beforeEach, describe, expect, it } from "vitest";
import {
  hydrateSecureStorage,
  resetSecureStorageState,
  secureStorageFor,
} from "../secureStorage.js";
import { McpRegistry } from "./store.js";
import { MCP_SERVERS_KEY } from "./store.js";
import type { StorageLike } from "../memory/types.js";

function memStorage(): StorageLike & { map: Map<string, string> } {
  const map = new Map<string, string>();
  return {
    map,
    getItem: (k) => map.get(k) ?? null,
    setItem: (k, v) => void map.set(k, v),
    removeItem: (k) => void map.delete(k),
  };
}

function envelopeOf(cipher: string): string {
  return JSON.stringify({ __hemingEnc: "v1", data: cipher });
}

function fakeAsyncBridge() {
  const cached = new Map<string, string | null>();
  let resolveReady!: (value: { available: boolean; hydrated: boolean; mode?: string | null }) => void;
  const ready = new Promise<{ available: boolean; hydrated: boolean; mode?: string | null }>(
    (resolve) => {
      resolveReady = resolve;
    },
  );
  const bridge = {
    available: false,
    mode: "async",
    asyncAvailable: true,
    ready,
    decrypt: () => null,
    encrypt: () => null,
    decryptAsync: async (cipher: string) => (cipher.startsWith("enc:") ? cipher.slice(4) : null),
    encryptAsync: async (plain: string) => `enc:${plain}`,
    cachedRead: (key: string) => (cached.has(key) ? cached.get(key) : undefined),
    cacheSet: (key: string, value: string) => void cached.set(key, value),
    cacheDelete: (key: string) => void cached.delete(key),
  };
  return { bridge, cached, resolveReady };
}

function installBridge(value: unknown): void {
  (window as unknown as { __heming_secrets?: unknown }).__heming_secrets = value;
}

function uninstallBridge(): void {
  delete (window as unknown as { __heming_secrets?: unknown }).__heming_secrets;
}

beforeEach(() => {
  resetSecureStorageState();
  localStorage.clear();
  uninstallBridge();
});

describe("McpRegistry · hydrate 时序", () => {
  it("hydrate 未完成：不预置、不写盘；hydrate 后按磁盘补读", async () => {
    const base = memStorage();
    const storage = secureStorageFor(MCP_SERVERS_KEY, base);
    const { bridge, cached, resolveReady } = fakeAsyncBridge();
    installBridge(bridge);

    const reg = new McpRegistry(storage);
    expect(reg.servers()).toEqual([]); // 缓存未命中：空表
    expect(base.map.get(MCP_SERVERS_KEY)).toBeUndefined(); // 关键：没有用预置覆盖磁盘

    // 「磁盘上已有用户配置」：sync 桥不可用时，构造期只能读到空；
    // preload 预取完成后由缓存给出真实值（这里用 cached 模拟）。
    const disk = [
      {
        id: "real-server",
        name: "磁盘上的服务",
        transport: "http" as const,
        url: "https://real.test/mcp",
        enabled: true,
        createdAt: "2026-01-01T00:00:00.000Z",
        updatedAt: "2026-01-01T00:00:00.000Z",
      },
    ];
    base.map.set(MCP_SERVERS_KEY, envelopeOf("enc:placeholder"));
    // 主窗口 localStorage 指向同一份数据（真实应用里 defaultStorage 就是它）：
    // 不设的话全局单例在 hydrate 回调里会以为「没有配置」而补预置，写穿共享缓存。
    localStorage.setItem(MCP_SERVERS_KEY, envelopeOf("enc:placeholder"));
    cached.set(MCP_SERVERS_KEY, JSON.stringify(disk));

    const hydration = hydrateSecureStorage({ skipCleanup: true });
    resolveReady({ available: true, hydrated: true, mode: "async" });
    await hydration;
    reg.refreshAfterHydrate();

    expect(reg.servers().map((s) => s.id)).toEqual(["real-server"]);
    expect(base.map.get(MCP_SERVERS_KEY)).toBe(envelopeOf("enc:placeholder")); // 未被预置覆盖
  });

  it("hydrate 前用户已改服务 → 不被 hydrate 重读覆盖", async () => {
    const base = memStorage();
    const storage = secureStorageFor(MCP_SERVERS_KEY, base);
    const { bridge, cached, resolveReady } = fakeAsyncBridge();
    installBridge(bridge);

    const reg = new McpRegistry(storage);
    const mine = reg.add({ name: "用户新加的服务", transport: "http", url: "https://mine.test" });

    base.map.set(MCP_SERVERS_KEY, envelopeOf("enc:placeholder"));
    cached.set(
      MCP_SERVERS_KEY,
      JSON.stringify([
        {
          id: "old-server",
          name: "旧磁盘服务",
          transport: "http",
          url: "https://old.test",
          enabled: true,
          createdAt: "2026-01-01T00:00:00.000Z",
          updatedAt: "2026-01-01T00:00:00.000Z",
        },
      ]),
    );

    const hydration = hydrateSecureStorage({ skipCleanup: true });
    resolveReady({ available: true, hydrated: true, mode: "async" });
    await hydration;
    reg.refreshAfterHydrate();

    expect(reg.get(mine.id)?.name).toBe("用户新加的服务"); // 用户输入优先
    expect(reg.get("old-server")).toBeUndefined();
  });

  it("hydrate 后仍读不到（解不开）：不覆盖磁盘密文，只按空表展示", async () => {
    const base = memStorage();
    const storage = secureStorageFor(MCP_SERVERS_KEY, base);
    const { bridge, cached, resolveReady } = fakeAsyncBridge();
    installBridge(bridge);

    const reg = new McpRegistry(storage);
    const cipher = envelopeOf("enc:placeholder");
    base.map.set(MCP_SERVERS_KEY, cipher);
    // 主窗口 localStorage 与注入的 base 指向同一份数据（真实应用里 defaultStorage 就是它）
    localStorage.setItem(MCP_SERVERS_KEY, cipher);
    cached.set(MCP_SERVERS_KEY, null); // 预取报告「解不开」

    const hydration = hydrateSecureStorage({ skipCleanup: true });
    resolveReady({ available: true, hydrated: true, mode: "async" });
    await hydration;
    reg.refreshAfterHydrate();

    expect(reg.servers()).toEqual([]);
    expect(base.map.get(MCP_SERVERS_KEY)).toBe(cipher); // 一个字节没动
    expect(localStorage.getItem(MCP_SERVERS_KEY)).toBe(cipher);
  });

  it("hydrate 失败：不抛、读到空才补预置（首次安装的默认服务不丢）", async () => {
    const base = memStorage();
    const storage = secureStorageFor(MCP_SERVERS_KEY, base);
    const { bridge, resolveReady } = fakeAsyncBridge();
    installBridge(bridge);

    const reg = new McpRegistry(storage);
    const hydration = hydrateSecureStorage({ skipCleanup: true });
    resolveReady({ available: false, hydrated: false, mode: "async" });
    await expect(hydration).resolves.toMatchObject({ done: true });

    expect(() => reg.refreshAfterHydrate()).not.toThrow();
    expect(reg.servers().length).toBeGreaterThan(0); // 真的没配置 → 预置
  });

  it("无桥（浏览器）：构造期立即预置，行为与今天一致", async () => {
    const base = memStorage();
    const reg = new McpRegistry(secureStorageFor(MCP_SERVERS_KEY, base));
    expect(reg.servers().length).toBeGreaterThan(0);
    expect(base.map.get(MCP_SERVERS_KEY)).toBeTruthy();

    await hydrateSecureStorage({ skipCleanup: true });
    expect(reg.servers().length).toBeGreaterThan(0);
  });
});
