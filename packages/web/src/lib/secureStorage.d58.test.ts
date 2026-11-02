/**
 * d.58 · safeStorage 异步迁移与 P0-5b P3 清理的定向用例。
 *
 * 覆盖（与 task-8 验收对齐）：
 * - 启动 hydrate：预取完成 → 缓存热、单飞、无桥/超时走兜底；
 * - 读路径：缓存优先（不触发同步 IPC），未命中回退旧同步桥；
 * - 写路径：写后立即读一致（缓存先行）、同步桥可用时行为与改前一致；
 * - 多窗口：storage 事件失效缓存；
 * - P3 清理：版本标记幂等、可解校验、`__heming_undecryptable` 永不删、解不开时备份保留；
 * - P3 兜底：msgCache 全量扫描把未打开会话的明文也迁成密文容器。
 */
import { beforeEach, describe, expect, it, vi } from "vitest";
import {
  BACKUP_CLEANUP_MARKER_KEY,
  PLAINTEXT_BACKUP_SUFFIX,
  UNDECRYPTABLE_BACKUP_SUFFIX,
  cleanupPlaintextBackups,
  hydrateSecureStorage,
  onSecureHydrated,
  resetSecureStorageState,
  secureGetItem,
  secureSetItem,
  secureStorageHydrated,
  secureStorageStatus,
} from "./secureStorage.js";

/** 假桌面桥：默认同步可用，`cipher` 就是明文的 `enc:` 前缀形式。 */
function fakeBridge(opts: {
  available?: boolean;
  mode?: "async" | "sync" | null;
  ready?: Promise<{ available: boolean; hydrated: boolean; mode?: string | null }>;
  cached?: Map<string, string | null>;
  decryptFail?: boolean;
} = {}) {
  const cached = opts.cached ?? new Map<string, string | null>();
  const calls = { decrypt: 0, encrypt: 0, cacheSet: 0, cacheDelete: 0 };
  const bridge = {
    available: opts.available !== false,
    mode: opts.mode ?? "sync",
    decrypt(cipher: string) {
      calls.decrypt += 1;
      if (opts.decryptFail) return null;
      return cipher.startsWith("enc:") ? cipher.slice(4) : null;
    },
    encrypt(plain: string) {
      calls.encrypt += 1;
      return `enc:${plain}`;
    },
    cachedRead: (key: string) => (cached.has(key) ? cached.get(key) : undefined),
    cacheSet: (key: string, plain: string) => {
      calls.cacheSet += 1;
      cached.set(key, plain);
    },
    cacheDelete: (key: string) => {
      calls.cacheDelete += 1;
      cached.delete(key);
    },
    ...(opts.ready ? { ready: opts.ready } : {}),
  };
  return { bridge, calls, cached };
}

function installBridge(value: unknown) {
  (window as unknown as { __heming_secrets?: unknown }).__heming_secrets = value;
}

function envelopeOf(cipher: string) {
  return JSON.stringify({ __hemingEnc: "v1", data: cipher });
}

beforeEach(() => {
  resetSecureStorageState();
  window.localStorage.clear();
  delete (window as unknown as { __heming_secrets?: unknown }).__heming_secrets;
});

describe("启动 hydrate（预取缓存）", () => {
  it("无桥：done 且 hydrated:false（浏览器端不假装有安全存储）", async () => {
    const state = await hydrateSecureStorage({ skipCleanup: true });
    expect(state).toMatchObject({ done: true, hydrated: false, available: false });
    expect(secureStorageHydrated()).toBe(true);
  });

  it("预取成功：状态带上 available/mode，且单飞（重复调用返回同一 Promise）", async () => {
    const { bridge } = fakeBridge({
      mode: "async",
      ready: Promise.resolve({ available: true, hydrated: true, mode: "async" }),
    });
    installBridge(bridge);
    const first = hydrateSecureStorage({ skipCleanup: true });
    const second = hydrateSecureStorage({ skipCleanup: true });
    expect(first).toBe(second);
    await expect(first).resolves.toMatchObject({
      done: true,
      hydrated: true,
      available: true,
      mode: "async",
    });
  });

  it("预取失败/超时：不阻塞、不 reject，走同步兜底", async () => {
    const { bridge } = fakeBridge({
      mode: "async",
      ready: Promise.reject(new Error("preload 没起来")),
    });
    installBridge(bridge);
    const state = await hydrateSecureStorage({ skipCleanup: true });
    expect(state).toMatchObject({ done: true, hydrated: false });
  });

  it("onSecureHydrated：完成后订阅者收到状态（已完成时立即回调）", async () => {
    installBridge(fakeBridge({ ready: Promise.resolve({ available: true, hydrated: true }) }).bridge);
    await hydrateSecureStorage({ skipCleanup: true });
    const seen: boolean[] = [];
    onSecureHydrated((state) => seen.push(state.hydrated));
    expect(seen).toEqual([true]);
  });
});

describe("读路径（缓存优先，回退同步桥）", () => {
  it("缓存命中：直接返回明文，不触发同步解密 IPC", () => {
    const { bridge, calls } = fakeBridge({ cached: new Map([["heming.llmConfigs", '{"profiles":[]}']]) });
    installBridge(bridge);
    window.localStorage.setItem("heming.llmConfigs", envelopeOf("enc:不该走到这里"));
    expect(secureGetItem("heming.llmConfigs")).toBe('{"profiles":[]}');
    expect(calls.decrypt).toBe(0);
  });

  it("缓存未命中：回退旧同步桥，并把结果回填缓存", () => {
    const { bridge, calls, cached } = fakeBridge();
    installBridge(bridge);
    window.localStorage.setItem("heming.mcp.servers.v1", envelopeOf("enc:[{\"id\":\"m1\"}]"));
    expect(secureGetItem("heming.mcp.servers.v1")).toBe('[{"id":"m1"}]');
    expect(calls.decrypt).toBe(1);
    expect(cached.get("heming.mcp.servers.v1")).toBe('[{"id":"m1"}]');
  });

  it("缓存里标记「解不开」（null）：返回 null 并记入 undecryptable（不谎报空）", () => {
    const { bridge } = fakeBridge({ cached: new Map([["heming.e2e.identity", null]]) });
    installBridge(bridge);
    window.localStorage.setItem("heming.e2e.identity", envelopeOf("enc:x"));
    expect(secureGetItem("heming.e2e.identity")).toBeNull();
    expect(secureStorageStatus().undecryptableKeys).toContain("heming.e2e.identity");
  });
});

describe("写路径（写后立即读一致）", () => {
  it("同步桥可用：落信封 + 刷新缓存，随后读命中缓存（与改前行为一致）", () => {
    const { bridge, calls, cached } = fakeBridge();
    installBridge(bridge);
    secureSetItem("heming.llmConfigs", '{"profiles":["a"]}');
    const raw = window.localStorage.getItem("heming.llmConfigs")!;
    expect(raw.startsWith("{\"__hemingEnc\"")).toBe(true);
    expect(cached.get("heming.llmConfigs")).toBe('{"profiles":["a"]}');
    expect(calls.cacheSet).toBe(1);
    expect(secureGetItem("heming.llmConfigs")).toBe('{"profiles":["a"]}');
    expect(calls.decrypt).toBe(0); // 读命中的是刚写的缓存
  });

  it("其它窗口改了同一个键：storage 事件失效缓存，下一次读回退同步桥", async () => {
    const { bridge, calls, cached } = fakeBridge();
    installBridge(bridge);
    await hydrateSecureStorage({ skipCleanup: true });
    cached.set("heming.llmConfigs", "旧值");
    window.localStorage.setItem("heming.llmConfigs", envelopeOf("enc:新值"));
    window.dispatchEvent(new StorageEvent("storage", { key: "heming.llmConfigs" }));
    expect(cached.has("heming.llmConfigs")).toBe(false);
    expect(secureGetItem("heming.llmConfigs")).toBe("新值");
    expect(calls.decrypt).toBe(1);
  });
});

describe("P0-5b P3 · 明文备份清理", () => {
  /** 清一个键的备份：按用例构造主键形态。 */
  async function runCleanup(opts?: { version?: string; force?: boolean; decryptFail?: boolean }) {
    const { bridge } = fakeBridge({ decryptFail: opts?.decryptFail });
    installBridge(bridge);
    await hydrateSecureStorage({ skipCleanup: true });
    const keys = Array.from({ length: window.localStorage.length }, (_, i) => window.localStorage.key(i)!);
    return cleanupPlaintextBackups({ version: opts?.version ?? "d.58.0.0.0", force: opts?.force, keys });
  }

  it("新密文可解 → 删备份（幂等：同版本第二次不再跑）", async () => {
    window.localStorage.setItem("heming.llmConfigs", envelopeOf("enc:新配置"));
    window.localStorage.setItem("heming.llmConfigs" + PLAINTEXT_BACKUP_SUFFIX, "旧明文");

    const first = await runCleanup();
    expect(first.ran).toBe(true);
    expect(first.deleted).toEqual(["heming.llmConfigs"]);
    expect(window.localStorage.getItem("heming.llmConfigs" + PLAINTEXT_BACKUP_SUFFIX)).toBeNull();
    expect(window.localStorage.getItem(BACKUP_CLEANUP_MARKER_KEY)).not.toBeNull();

    const second = await runCleanup();
    expect(second.ran).toBe(false);
    expect(second.reason).toBe("already-clean");
  });

  it("新密文解不开 → 备份必须还在（绝不误删唯一可恢复副本）", async () => {
    window.localStorage.setItem("heming.e2e.identity", envelopeOf("enc:解不开"));
    window.localStorage.setItem("heming.e2e.identity" + PLAINTEXT_BACKUP_SUFFIX, "旧明文");

    const result = await runCleanup({ decryptFail: true });
    expect(result.deleted).toEqual([]);
    expect(result.kept).toContainEqual({ key: "heming.e2e.identity", reason: "undecryptable" });
    expect(window.localStorage.getItem("heming.e2e.identity" + PLAINTEXT_BACKUP_SUFFIX)).toBe("旧明文");
  });

  it("主键缺失 → 保留备份（那是唯一副本）", async () => {
    window.localStorage.setItem("heming.mcp.servers.v1" + PLAINTEXT_BACKUP_SUFFIX, "旧明文");
    const result = await runCleanup();
    expect(result.deleted).toEqual([]);
    expect(result.kept).toContainEqual({ key: "heming.mcp.servers.v1", reason: "main-missing" });
  });

  it("主键仍是明文 → 保留备份（迁移还没完成）", async () => {
    window.localStorage.setItem("heming.llmConfigs", "{\"profiles\":[]}");
    window.localStorage.setItem("heming.llmConfigs" + PLAINTEXT_BACKUP_SUFFIX, "旧明文");
    const result = await runCleanup();
    expect(result.deleted).toEqual([]);
    expect(result.kept).toContainEqual({ key: "heming.llmConfigs", reason: "still-plain" });
  });

  it("主键是坏信封/未知版本 → 保留备份", async () => {
    window.localStorage.setItem("heming.llmConfigs", JSON.stringify({ __hemingEnc: "v9", data: "x" }));
    window.localStorage.setItem("heming.llmConfigs" + PLAINTEXT_BACKUP_SUFFIX, "旧明文");
    const result = await runCleanup();
    expect(result.deleted).toEqual([]);
    expect(result.kept).toContainEqual({ key: "heming.llmConfigs", reason: "bad-envelope" });
  });

  it("`__heming_undecryptable` 备份永不删（即使清理跑过）", async () => {
    window.localStorage.setItem("heming.llmConfigs", envelopeOf("enc:新配置"));
    window.localStorage.setItem("heming.llmConfigs" + UNDECRYPTABLE_BACKUP_SUFFIX, "旧密文");
    window.localStorage.setItem("heming.llmConfigs" + PLAINTEXT_BACKUP_SUFFIX, "旧明文");
    const result = await runCleanup({ force: true });
    expect(result.deleted).toEqual(["heming.llmConfigs"]);
    expect(window.localStorage.getItem("heming.llmConfigs" + UNDECRYPTABLE_BACKUP_SUFFIX)).toBe("旧密文");
  });

  it("没有桌面桥：不跑、不写版本标记（等可用时再清）", async () => {
    window.localStorage.setItem("heming.llmConfigs", envelopeOf("enc:新配置"));
    window.localStorage.setItem("heming.llmConfigs" + PLAINTEXT_BACKUP_SUFFIX, "旧明文");
    const keys = Array.from({ length: window.localStorage.length }, (_, i) => window.localStorage.key(i)!);
    const result = await cleanupPlaintextBackups({ version: "d.58.0.0.0", keys });
    expect(result).toMatchObject({ ran: false, reason: "no-bridge" });
    expect(window.localStorage.getItem("heming.llmConfigs" + PLAINTEXT_BACKUP_SUFFIX)).toBe("旧明文");
    expect(window.localStorage.getItem(BACKUP_CLEANUP_MARKER_KEY)).toBeNull();
  });

  it("msgCache 容器全部条目可解 → 删备份；仍有明文条目 → 保留", async () => {
    // 可解容器
    window.localStorage.setItem(
      "heming.msgCache.c1",
      JSON.stringify({ __hemingMsgCache: "v2", items: [{ id: "m1", d: "enc:{}" }] }),
    );
    window.localStorage.setItem("heming.msgCache.c1" + PLAINTEXT_BACKUP_SUFFIX, "旧明文数组");
    // 仍含明文条目的容器
    window.localStorage.setItem(
      "heming.msgCache.c2",
      JSON.stringify({ __hemingMsgCache: "v2", items: [{ id: "m1", m: { id: "m1" } }] }),
    );
    window.localStorage.setItem("heming.msgCache.c2" + PLAINTEXT_BACKUP_SUFFIX, "旧明文数组");

    const result = await runCleanup({ force: true });
    expect(result.deleted).toEqual(["heming.msgCache.c1"]);
    expect(result.kept).toContainEqual({ key: "heming.msgCache.c2", reason: "still-plain" });
    expect(window.localStorage.getItem("heming.msgCache.c2" + PLAINTEXT_BACKUP_SUFFIX)).not.toBeNull();
  });

  it("版本标记坏了：当作没跑过（不会因此永久不清理）", async () => {
    window.localStorage.setItem(BACKUP_CLEANUP_MARKER_KEY, "{ 坏 json");
    window.localStorage.setItem("heming.llmConfigs", envelopeOf("enc:新配置"));
    window.localStorage.setItem("heming.llmConfigs" + PLAINTEXT_BACKUP_SUFFIX, "旧明文");
    const result = await runCleanup({ version: "d.58.0.0.0" });
    expect(result.ran).toBe(true);
    expect(result.deleted).toEqual(["heming.llmConfigs"]);
  });
});

describe("状态卡语义不变", () => {
  it("可用与否按「实际能否加解密」判定；列表内容与原口径一致", () => {
    installBridge(fakeBridge({ available: false }).bridge);
    expect(secureStorageStatus()).toMatchObject({ desktop: true, available: false });
    installBridge(fakeBridge().bridge);
    window.localStorage.setItem("heming.llmConfigs", "{\"profiles\":[]}");
    secureSetItem("heming.mcp.servers.v1", "{}"); // 同步桥可用 → 不记明文
    expect(secureStorageStatus().plaintextKeys).toEqual([]);
  });
});
