/**
 * d.59 · Electron 46（只有异步 safeStorage）的写路径回归。
 *
 * 验收点：
 * - **明文窗口不存在**：异步写调用返回时，磁盘上要么还没写、要么已是密文信封，绝不能先落一次明文；
 * - **写后立即读一致**：同步 `secureGetItem` 立刻能读到新值（写穿缓存），不等 IPC 落盘；
 * - **异步桥不可用降级**：加密失败/不可用时 fail-open 写明文，`plaintextKeys` 里如实可见；
 * - **旧同步桥兜底**：45 及更旧的桥（无异步 API）保持同步落盘语义，行为与迁移前一致；
 * - **批量分片**：>128 条时自动分成多个 IPC（主进程上限是安全边界，调用方不许撞线）。
 */
import { beforeEach, describe, expect, it, vi } from "vitest";
import {
  readSecureValueAsync,
  resetSecureStorageState,
  secureDecryptManyAsync,
  secureEncryptManyAsync,
  secureGetItem,
  secureSetItem,
  secureSetItemAsync,
  secureStorageStatus,
} from "./secureStorage.js";

function envelopeOf(cipher: string): string {
  return JSON.stringify({ __hemingEnc: "v1", data: cipher });
}

/** 46 桥：同步三件套被移除（返回 null），只有异步 API。 */
function asyncOnlyBridge(opts: { encryptFails?: boolean; asyncAvailable?: boolean } = {}) {
  const cached = new Map<string, string | null>();
  const calls = { encryptAsync: 0, decryptAsync: 0, encryptManyAsync: 0, decryptManyAsync: 0, syncEncrypt: 0 };
  const bridge = {
    available: false,
    mode: "async" as const,
    asyncAvailable: opts.asyncAvailable !== false,
    encrypt: () => {
      calls.syncEncrypt += 1;
      return null;
    },
    decrypt: () => null,
    encryptAsync: async (plain: string) => {
      calls.encryptAsync += 1;
      return opts.encryptFails ? null : `enc:${plain}`;
    },
    decryptAsync: async (cipher: string) => (cipher.startsWith("enc:") ? cipher.slice(4) : null),
    encryptManyAsync: async (plains: string[]) => {
      calls.encryptManyAsync += 1;
      return plains.map((plain) => (opts.encryptFails ? null : `enc:${plain}`));
    },
    decryptManyAsync: async (ciphers: string[]) => {
      calls.decryptManyAsync += 1;
      return ciphers.map((cipher) => (cipher.startsWith("enc:") ? cipher.slice(4) : null));
    },
    cachedRead: (key: string) => (cached.has(key) ? cached.get(key) : undefined),
    cacheSet: (key: string, plain: string) => void cached.set(key, plain),
    cacheDelete: (key: string) => void cached.delete(key),
  };
  (window as unknown as { __heming_secrets?: unknown }).__heming_secrets = bridge;
  return { bridge, calls, cached };
}

/** 45 及更旧：只有同步三件套（没有异步 API）。 */
function syncOnlyBridge() {
  const bridge = {
    available: true,
    mode: "sync" as const,
    encrypt: (plain: string) => `enc:${plain}`,
    decrypt: (cipher: string) => (cipher.startsWith("enc:") ? cipher.slice(4) : null),
  };
  (window as unknown as { __heming_secrets?: unknown }).__heming_secrets = bridge;
  return bridge;
}

const KEY = "heming.llmConfigs";

beforeEach(() => {
  resetSecureStorageState();
  window.localStorage.clear();
  delete (window as unknown as { __heming_secrets?: unknown }).__heming_secrets;
});

describe("异步写（默认路径）", () => {
  it("明文窗口不存在：调用返回时磁盘没有明文，最终落的是能解的信封", async () => {
    const { calls } = asyncOnlyBridge();
    secureSetItem(KEY, '{"a":1}');

    // 同步返回的那一刻：磁盘要么还没写，要么已是密文——绝不能是明文（d.36 fail-open 的旧行为）。
    expect(localStorage.getItem(KEY)).not.toBe('{"a":1}');
    // 也不许走同步桥（46 上没有同步能力，走它就是纯浪费 + 误导）
    expect(calls.syncEncrypt).toBe(0);

    await vi.waitFor(() => expect(localStorage.getItem(KEY)).toContain("__hemingEnc"));
    const raw = localStorage.getItem(KEY) as string;
    expect(raw).not.toContain('"a"'); // 明文键值不出现在磁盘
    expect(JSON.parse(raw)).toEqual({ __hemingEnc: "v1", data: 'enc:{"a":1}' });
  });

  it("写后立即读一致：不等 IPC 落盘，同步读已经拿到新值", async () => {
    asyncOnlyBridge();
    secureSetItem(KEY, '{"b":2}');
    expect(secureGetItem(KEY)).toBe('{"b":2}'); // 写穿缓存
    await vi.waitFor(() => expect(localStorage.getItem(KEY)).toContain("enc:"));
    expect(secureGetItem(KEY)).toBe('{"b":2}'); // 落盘后仍一致
  });

  it("secureSetItemAsync 明确 await 到落盘：返回后磁盘就是可解信封", async () => {
    asyncOnlyBridge();
    const result = await secureSetItemAsync(KEY, '{"c":3}');
    expect(result).toMatchObject({ ok: true, form: "envelope" });
    expect(localStorage.getItem(KEY)).toBe(envelopeOf('enc:{"c":3}'));
    await expect(readSecureValueAsync(KEY)).resolves.toMatchObject({
      kind: "envelope",
      value: '{"c":3}',
    });
    expect(secureGetItem(KEY)).toBe('{"c":3}');
  });

  it("加密失败（系统安全存储抖动）：fail-open 写明文，且在状态里可见（不谎报已加密）", async () => {
    asyncOnlyBridge({ encryptFails: true });
    secureSetItem(KEY, '{"d":4}');
    await vi.waitFor(() => expect(localStorage.getItem(KEY)).toBe('{"d":4}'));
    expect(secureStorageStatus().plaintextKeys).toContain(KEY);
    expect(secureGetItem(KEY)).toBe('{"d":4}'); // 读路径不受影响
  });

  it("异步桥存在但 reported 不可用：仍走明文 fail-open 并标记（不是静默降级）", async () => {
    asyncOnlyBridge({ asyncAvailable: false });
    secureSetItem(KEY, '{"e":5}');
    expect(localStorage.getItem(KEY)).toBe('{"e":5}');
    expect(secureStorageStatus().plaintextKeys).toContain(KEY);
  });
});

describe("旧同步桥兜底（Electron ≤45）", () => {
  it("无异步 API 时保持同步落盘：调用返回时磁盘已是信封", () => {
    syncOnlyBridge();
    secureSetItem(KEY, '{"f":6}');
    expect(localStorage.getItem(KEY)).toBe(envelopeOf('enc:{"f":6}'));
    expect(secureGetItem(KEY)).toBe('{"f":6}');
    expect(secureStorageStatus().plaintextKeys).not.toContain(KEY);
  });

  it("同步桥解不开的密文：读回 null，但磁盘数据原样保留并标记不可解", () => {
    const bridge = syncOnlyBridge();
    (bridge as unknown as { decrypt: () => null }).decrypt = () => null;
    localStorage.setItem(KEY, envelopeOf("other-device-cipher"));
    expect(secureGetItem(KEY)).toBe(null);
    expect(localStorage.getItem(KEY)).toBe(envelopeOf("other-device-cipher"));
    expect(secureStorageStatus().undecryptableKeys).toContain(KEY);
  });
});

describe("批量分片（E2E 热路径）", () => {
  it("超过单次 IPC 上限时按 128 条分批，顺序与长度保持", async () => {
    const { calls } = asyncOnlyBridge();
    const plains = Array.from({ length: 300 }, (_, i) => `p${i}`);
    const ciphers = await secureEncryptManyAsync(plains);
    expect(ciphers).toHaveLength(300);
    expect(calls.encryptManyAsync).toBe(3); // 128 + 128 + 44
    expect(ciphers[0]).toBe("enc:p0");
    expect(ciphers[299]).toBe("enc:p299");

    const back = await secureDecryptManyAsync(ciphers as string[]);
    expect(back).toEqual(plains);
    expect(calls.decryptManyAsync).toBe(3);
  });

  it("单条加密失败位置为 null（调用方 fail-open），其余条目照常返回", async () => {
    const bridge = asyncOnlyBridge();
    (bridge.bridge as unknown as { encryptManyAsync: (p: string[]) => Promise<Array<string | null>> }).encryptManyAsync =
      async (plains: string[]) => plains.map((plain) => (plain === "bad" ? null : `enc:${plain}`));
    const out = await secureEncryptManyAsync(["ok", "bad", "ok2"]);
    expect(out).toEqual(["enc:ok", null, "enc:ok2"]);
  });
});
