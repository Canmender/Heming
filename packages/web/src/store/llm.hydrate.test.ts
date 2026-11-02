/**
 * d.59 · 启动时序（LLM 连接）：hydrate 完成后补读 + 不覆盖用户输入。
 *
 * 背景：store 在模块 import 期读盘，而 safeStorage 的 hydrate 是异步的。Electron 46
 * 没有同步桥兜底时，首帧 `loadProfiles()` 只能拿到空表；hydrate 完成后必须补一次，
 * 但**用户在本进程里已经保存过的连接**绝不能被重读覆盖。
 */
import { beforeEach, describe, expect, it, vi } from "vitest";
import {
  hydrateSecureStorage,
  resetSecureStorageState,
} from "../lib/secureStorage.js";
import {
  resetLlmHydrationState,
  useLlmStore,
  type LlmProfile,
} from "./llm.js";

const KEY_CONFIGS = "heming.llmConfigs";

function profile(id: string, label = id): LlmProfile {
  return { id, label, provider: "openai", apiKey: "sk-test", model: "gpt-test" };
}

function envelopeOf(cipher: string): string {
  return JSON.stringify({ __hemingEnc: "v1", data: cipher });
}

/** 可控的「异步桥 + 预取」夹具：ready 由用例决定何时落定；cached 模拟 preload 填好的缓存。 */
function fakeAsyncBridge() {
  const cached = new Map<string, string | null>();
  let resolveReady!: (value: { available: boolean; hydrated: boolean; mode?: string | null }) => void;
  const ready = new Promise<{ available: boolean; hydrated: boolean; mode?: string | null }>(
    (resolve) => {
      resolveReady = resolve;
    },
  );
  const bridge = {
    available: false, // 纯异步环境：没有同步兜底
    mode: "async",
    asyncAvailable: true,
    ready,
    decrypt: () => null,
    encrypt: () => null,
    decryptAsync: async (cipher: string) => (cipher.startsWith("enc:") ? cipher.slice(4) : null),
    encryptAsync: async (plain: string) => `enc:${plain}`,
    cachedRead: (key: string) => (cached.has(key) ? cached.get(key) : undefined),
    cacheSet: (key: string, plain: string) => void cached.set(key, plain),
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
  resetLlmHydrationState();
  localStorage.clear();
  uninstallBridge();
  // 上一个用例可能留下连接：清空内存态，模拟「启动首帧读空」。
  useLlmStore.setState({ profiles: [] });
});

describe("LLM store · hydrate 后补读", () => {
  it("启动读空 → hydrate 完成后自动补全 profiles（不动 bindings/prompts）", async () => {
    const { bridge, cached, resolveReady } = fakeAsyncBridge();
    installBridge(bridge);
    const disk = profile("p-disk", "磁盘上的连接");
    localStorage.setItem(KEY_CONFIGS, envelopeOf("enc:placeholder"));
    cached.set(KEY_CONFIGS, JSON.stringify({ profiles: [disk] })); // preload 预取完成的形态

    const hydration = hydrateSecureStorage({ skipCleanup: true });
    expect(useLlmStore.getState().profiles).toEqual([]); // 首帧确实读到空
    resolveReady({ available: true, hydrated: true, mode: "async" });
    await hydration;

    expect(useLlmStore.getState().profiles).toEqual([disk]);
  });

  it("hydrate 前用户已保存连接 → 不被 hydrate 重读覆盖", async () => {
    const { bridge, cached, resolveReady } = fakeAsyncBridge();
    installBridge(bridge);
    localStorage.setItem(KEY_CONFIGS, envelopeOf("enc:placeholder"));
    cached.set(KEY_CONFIGS, JSON.stringify({ profiles: [profile("p-disk", "旧磁盘连接")] }));

    const hydration = hydrateSecureStorage({ skipCleanup: true });
    const user = profile("p-user", "用户刚保存的连接");
    useLlmStore.getState().addProfile(user); // hydrate 落定前的用户操作

    resolveReady({ available: true, hydrated: true, mode: "async" });
    await hydration;

    expect(useLlmStore.getState().profiles).toEqual([user]); // 用户输入优先
  });

  it("hydrate 前用户删过连接（内存非空）→ 同样不重读", async () => {
    const { bridge, cached, resolveReady } = fakeAsyncBridge();
    installBridge(bridge);
    localStorage.setItem(KEY_CONFIGS, envelopeOf("enc:placeholder"));
    cached.set(KEY_CONFIGS, JSON.stringify({ profiles: [profile("p-disk")] }));

    const hydration = hydrateSecureStorage({ skipCleanup: true });
    useLlmStore.getState().addProfile(profile("p-keep"));
    useLlmStore.getState().addProfile(profile("p-remove"));
    useLlmStore.getState().removeProfile("p-remove");

    resolveReady({ available: true, hydrated: true, mode: "async" });
    await hydration;

    expect(useLlmStore.getState().profiles.map((p) => p.id)).toEqual(["p-keep"]);
  });

  it("hydrate 失败 / 预取不可用：不抛错、不阻塞、不改内存", async () => {
    const { bridge, resolveReady } = fakeAsyncBridge();
    installBridge(bridge);
    useLlmStore.setState({ profiles: [profile("p-current")] });

    const hydration = hydrateSecureStorage({ skipCleanup: true });
    resolveReady({ available: false, hydrated: false, mode: "async" });
    await expect(hydration).resolves.toMatchObject({ done: true, hydrated: false });
    expect(useLlmStore.getState().profiles.map((p) => p.id)).toEqual(["p-current"]);
  });

  it("无桥（浏览器）：hydrate 后不清空内存、不抛错，读到的明文配置与原路径一致", async () => {
    const disk = profile("p-browser", "浏览器明文连接");
    localStorage.setItem(KEY_CONFIGS, JSON.stringify({ profiles: [disk] }));
    const inMemory = profile("p-mem", "内存里已有");
    useLlmStore.setState({ profiles: [inMemory] });

    const hydration = hydrateSecureStorage({ skipCleanup: true });
    await expect(hydration).resolves.toMatchObject({ done: true, hydrated: false });
    // 内存非空 → hydrate 不重读、不覆盖（规则 2）
    expect(useLlmStore.getState().profiles).toEqual([inMemory]);
    // 明文配置原样留在磁盘上（没有因为 hydrate 被改写）
    expect(localStorage.getItem(KEY_CONFIGS)).toBe(JSON.stringify({ profiles: [disk] }));
  });
});
