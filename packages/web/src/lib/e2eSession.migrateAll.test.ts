/**
 * P0-5b P3 · msgCache 明文全量扫描兜底（d.58）的定向用例。
 *
 * 读侧懒迁移只覆盖「打开过的会话」；本用例钉的是**没打开过的会话也会在启动后被迁**，
 * 且迁移幂等、加密失败保留明文（绝不丢消息）。
 */
import { beforeEach, describe, expect, it } from "vitest";
import {
  IDENTITY_KEY,
  migrateAllMsgCaches,
  resetMsgCacheLru,
  resetMsgCacheState,
  msgCache,
} from "./e2eSession.js";
import { PLAINTEXT_BACKUP_SUFFIX, resetSecureStorageState } from "./secureStorage.js";

const CACHE_PREFIX = "heming.msgCache.";

/** 假桌面桥：同步可用，密文 = `enc:` + 明文。 */
function fakeBridge(opts: { available?: boolean; encryptFails?: boolean } = {}) {
  return {
    available: opts.available !== false,
    encrypt: (plain: string) => (opts.encryptFails ? null : `enc:${plain}`),
    decrypt: (cipher: string) => (cipher.startsWith("enc:") ? cipher.slice(4) : null),
  };
}

function installBridge(value: unknown) {
  (window as unknown as { __heming_secrets?: unknown }).__heming_secrets = value;
}

/** 一条合法的最小缓存条目（形状与 `isCachedMsgLike` 对齐）。 */
function cachedMsg(id: string) {
  return { id, senderId: "peer", at: 1_700_000_000_000, plain: { kind: "text", text: `消息 ${id}` } };
}

function readShape(key: string): { kind: string; items?: Array<Record<string, unknown>> } {
  const raw = window.localStorage.getItem(key);
  if (!raw) return { kind: "empty" };
  const parsed = JSON.parse(raw) as { __hemingMsgCache?: string; items?: Array<Record<string, unknown>> };
  if (parsed.__hemingMsgCache === "v2") return { kind: "container", items: parsed.items ?? [] };
  if (Array.isArray(parsed)) return { kind: "plain" };
  return { kind: "other" };
}

beforeEach(() => {
  resetSecureStorageState();
  resetMsgCacheState();
  resetMsgCacheLru();
  window.localStorage.clear();
  delete (window as unknown as { __heming_secrets?: unknown }).__heming_secrets;
});

describe("msgCache 明文全量扫描迁移", () => {
  it("没打开过的会话也会迁成 v2 容器（逐条密文，id 保持明文）", () => {
    installBridge(fakeBridge());
    window.localStorage.setItem(
      CACHE_PREFIX + "c1",
      JSON.stringify([cachedMsg("m1"), cachedMsg("m2")]),
    );
    window.localStorage.setItem(CACHE_PREFIX + "c2", JSON.stringify([cachedMsg("m3")]));

    const summary = migrateAllMsgCaches();
    expect(summary.conversations).toBe(2);
    expect(summary.migrated).toBe(3);
    expect(summary.failed).toBe(0);
    expect(summary.remainingPlaintext).toBe(0);

    const shape = readShape(CACHE_PREFIX + "c1");
    expect(shape.kind).toBe("container");
    expect(shape.items?.every((item) => typeof item.d === "string")).toBe(true);
    expect(shape.items?.map((item) => item.id)).toEqual(["m1", "m2"]);
    // 迁移期明文备份保留（P3 清理阶段才删）
    expect(window.localStorage.getItem(CACHE_PREFIX + "c1" + PLAINTEXT_BACKUP_SUFFIX)).not.toBeNull();
    // 迁移后仍能按 id 取到解密后的消息（读路径没被破坏）
    expect(msgCache.get("c1", "m2")?.id).toBe("m2");
  });

  it("幂等：第二次运行不会二次加密，也不会再产生新备份", () => {
    installBridge(fakeBridge());
    window.localStorage.setItem(CACHE_PREFIX + "c1", JSON.stringify([cachedMsg("m1")]));
    migrateAllMsgCaches();
    const rawAfterFirst = window.localStorage.getItem(CACHE_PREFIX + "c1");

    const second = migrateAllMsgCaches();
    expect(second.migrated).toBe(0);
    expect(second.remainingPlaintext).toBe(0);
    expect(window.localStorage.getItem(CACHE_PREFIX + "c1")).toBe(rawAfterFirst);
  });

  it("加密失败：保留明文条目并统计 failed（fail-open，绝不丢消息）", () => {
    installBridge(fakeBridge({ encryptFails: true }));
    window.localStorage.setItem(CACHE_PREFIX + "c1", JSON.stringify([cachedMsg("m1")]));

    const summary = migrateAllMsgCaches();
    expect(summary.failed).toBe(1);
    expect(summary.migrated).toBe(0);
    expect(summary.remainingPlaintext).toBe(1);
    // 磁盘仍是明文数组（没有把消息写丢）
    expect(readShape(CACHE_PREFIX + "c1").kind).toBe("plain");
    expect(msgCache.get("c1", "m1")?.id).toBe("m1");
  });

  it("没有桌面桥（浏览器端）：不迁、不改磁盘", () => {
    const raw = JSON.stringify([cachedMsg("m1")]);
    window.localStorage.setItem(CACHE_PREFIX + "c1", raw);
    const summary = migrateAllMsgCaches();
    expect(summary).toMatchObject({ conversations: 0, migrated: 0, remainingPlaintext: 0 });
    expect(window.localStorage.getItem(CACHE_PREFIX + "c1")).toBe(raw);
  });

  it("辅助键（备份/LRU）不会被当成会话枚举", () => {
    installBridge(fakeBridge());
    window.localStorage.setItem(CACHE_PREFIX + "c1", JSON.stringify([cachedMsg("m1")]));
    window.localStorage.setItem(CACHE_PREFIX + "c1" + PLAINTEXT_BACKUP_SUFFIX, "旧明文数组");
    window.localStorage.setItem("heming.msgCache.lru.v1", JSON.stringify({ c1: 1 }));
    const summary = migrateAllMsgCaches();
    expect(summary.conversations).toBe(1);
  });

  it("身份键与全量扫描无关（只扫 msgCache 前缀）", () => {
    installBridge(fakeBridge());
    window.localStorage.setItem(IDENTITY_KEY, JSON.stringify({ kid: "device-1" }));
    expect(migrateAllMsgCaches()).toMatchObject({ conversations: 0, migrated: 0 });
    expect(window.localStorage.getItem(IDENTITY_KEY)).toContain("device-1");
  });
});
