/**
 * d.59 · 启动时序（E2E 身份）：hydrate 在途时不要生成「临时身份」。
 *
 * 风险背景：Electron 46 没有同步桥兜底。hydrate 未完成时 `secureGetItem` 对缓存未命中的
 * 密文只能返回 null（解密在后台异步补）；若此刻 `ensureIdentity()` 直接生成新身份并写盘，
 * 会覆盖磁盘上的真实身份——其他设备之后发来的消息永久解不开。
 *
 * 正确行为：有桥且 hydrate 在途 → 先等它落定（有上限、不挂住收发），再读一次；
 * 只有「等完仍没有」才走 d.36 的失败口径（备份旧密文后重建）。
 */
import { beforeEach, describe, expect, it } from "vitest";
import {
  hydrateSecureStorage,
  resetSecureStorageState,
} from "./secureStorage.js";
import { IDENTITY_KEY, exportOwnDeviceKeys } from "./e2eSession.js";

function envelopeOf(cipher: string): string {
  return JSON.stringify({ __hemingEnc: "v1", data: cipher });
}

function fakeAsyncBridge(opts: {
  ready: Promise<{ available: boolean; hydrated: boolean; mode?: string | null }>;
  decryptOk?: boolean;
}) {
  const cached = new Map<string, string | null>();
  const bridge = {
    available: false,
    mode: "async",
    asyncAvailable: true,
    ready: opts.ready,
    decrypt: () => null,
    encrypt: () => null,
    decryptAsync: async (cipher: string) =>
      opts.decryptOk === false || !cipher.startsWith("enc:") ? null : cipher.slice(4),
    encryptAsync: async (plain: string) => `enc:${plain}`,
    cachedRead: (key: string) => (cached.has(key) ? cached.get(key) : undefined),
    cacheSet: (key: string, plain: string) => void cached.set(key, plain),
    cacheDelete: (key: string) => void cached.delete(key),
  };
  return { bridge, cached };
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

/** 先生成一份「磁盘上已有的身份」（无桥环境，明文落盘，便于取原始 JSON）。 */
async function seedDiskIdentity(): Promise<string> {
  uninstallBridge();
  const keys = await exportOwnDeviceKeys();
  expect(keys.spk.pub.length).toBeGreaterThan(0);
  const raw = localStorage.getItem(IDENTITY_KEY);
  if (!raw) throw new Error("种子身份缺失");
  return raw;
}

/** 从身份 JSON 里取可用来比对同一套身份的公开字段（导出 API 不带 kid）。 */
function spkPubOf(identityJson: string): string {
  return (JSON.parse(identityJson) as { spk: { pub: string } }).spk.pub;
}

describe("E2E 身份 · hydrate 时序", () => {
  it("hydrate 在途 + 磁盘身份可解：沿用磁盘身份，不生成临时身份", async () => {
    const diskIdentity = await seedDiskIdentity();
    const spkPub = spkPubOf(diskIdentity);

    // 模拟「重启后进入 Electron 46 异步环境」：身份在磁盘上是信封形态
    let resolveReady!: (value: { available: boolean; hydrated: boolean; mode?: string | null }) => void;
    const ready = new Promise<{ available: boolean; hydrated: boolean; mode?: string | null }>(
      (resolve) => {
        resolveReady = resolve;
      },
    );
    const { bridge, cached } = fakeAsyncBridge({ ready });
    installBridge(bridge);
    localStorage.setItem(IDENTITY_KEY, envelopeOf(`enc:${diskIdentity}`));

    const hydration = hydrateSecureStorage({ skipCleanup: true });
    const pending = exportOwnDeviceKeys(); // 在 hydrate 落定前就被调用（App 首帧的常见路径）

    // preload 预取完成：缓存热 + ready 落定
    cached.set(IDENTITY_KEY, diskIdentity);
    resolveReady({ available: true, hydrated: true, mode: "async" });

    await hydration;
    const keys = await pending;
    expect(keys.spk.pub).toBe(spkPub);
    // 磁盘仍是信封（没有被新身份覆盖成明文）
    expect(localStorage.getItem(IDENTITY_KEY)).toBe(envelopeOf(`enc:${diskIdentity}`));
  });

  it("hydrate 失败（等完仍解不开）：不挂住、不抛错，按 d.36 备份旧密文后重建", async () => {
    const diskIdentity = await seedDiskIdentity();
    const { bridge } = fakeAsyncBridge({
      ready: Promise.reject(new Error("keyring 不可用")),
      decryptOk: false,
    });
    installBridge(bridge);
    const cipher = envelopeOf(`enc:${diskIdentity}`);
    localStorage.setItem(IDENTITY_KEY, cipher);

    const hydration = hydrateSecureStorage({ skipCleanup: true });
    const keys = await exportOwnDeviceKeys();

    await expect(hydration).resolves.toMatchObject({ done: true });
    expect(keys.spk.pub.length).toBeGreaterThan(0); // 应用仍可用（新身份）
    // 旧密文在覆盖前被原样备份（d.36 口径，换回原账户还能恢复）
    expect(localStorage.getItem(IDENTITY_KEY + ".__heming_undecryptable")).toBe(cipher);
  });

  it("没人调 hydrate（浏览器/单测）：不进入等待分支，行为与今天一致", async () => {
    const diskIdentity = await seedDiskIdentity();
    const spkPub = spkPubOf(diskIdentity);

    resetSecureStorageState();
    const keys = await exportOwnDeviceKeys();

    expect(keys.spk.pub).toBe(spkPub); // 明文身份原样读到，没有生成临时身份
    expect(localStorage.getItem(IDENTITY_KEY)).toBe(diskIdentity);
  });
});
