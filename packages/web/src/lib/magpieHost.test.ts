import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import {
  ensureDesktopGateway,
  getMagpieBridge,
  resolveDesktopGateway,
  type MagpieBridge,
  type MagpieHostStatus,
} from "./magpieHost.js";
import { DEFAULT_GATEWAY, useLlmStore } from "../store/llm.js";

/**
 * 桌面端内置 magpie 的渲染层封装（d.91）。
 *
 * 关注点：没有桥时优雅退化为「手动网关」；有桥时能取到反代地址、启动一次、
 * 刷新模型目录；用户手填过的网关永不被自动覆盖。
 */

const status = (overrides: Partial<MagpieHostStatus> = {}): MagpieHostStatus => ({
  available: true,
  running: true,
  port: 3425,
  version: "0.1.3246",
  proxyPort: 40123,
  ...overrides,
});

function fakeBridge(overrides: Partial<MagpieBridge> = {}): MagpieBridge {
  return {
    status: async () => status(),
    start: async () => ({ baseUrl: "http://127.0.0.1:40123/v1", status: status() }),
    stop: async () => status({ running: false }),
    gateway: async () => ({ baseUrl: "http://127.0.0.1:40123/v1", status: status() }),
    ...overrides,
  };
}

function installBridge(bridge: unknown): void {
  (window as unknown as { __heming_magpie?: unknown }).__heming_magpie = bridge;
}

function stubModelsFetch(): void {
  vi.stubGlobal(
    "fetch",
    vi.fn(async (input: string) => {
      if (String(input).endsWith("/api/hello")) {
        return new Response(JSON.stringify({ name: "magpie", version: "0.1.3246" }), { status: 200 });
      }
      return new Response(JSON.stringify({ data: [{ id: "deepseek/deepseek-chat", display_name: "DeepSeek Chat" }] }), {
        status: 200,
      });
    }),
  );
}

beforeEach(() => {
  localStorage.clear();
  delete (window as unknown as { __heming_magpie?: unknown }).__heming_magpie;
  vi.restoreAllMocks();
  useLlmStore.setState({
    gateway: { ...DEFAULT_GATEWAY, source: "desktop" },
    models: [],
    gatewayVersion: undefined,
    profiles: [],
    bindings: {},
    prompts: {},
    routes: [],
  });
});

afterEach(() => {
  vi.unstubAllGlobals();
  delete (window as unknown as { __heming_magpie?: unknown }).__heming_magpie;
});

describe("getMagpieBridge", () => {
  it("没有桥（浏览器）返回 null；形状不全也按没有处理", () => {
    expect(getMagpieBridge()).toBeNull();
    installBridge({ status: () => {} });
    expect(getMagpieBridge()).toBeNull();
    installBridge(fakeBridge());
    expect(getMagpieBridge()).not.toBeNull();
  });
});

describe("resolveDesktopGateway", () => {
  it("无桥：supported=false，不改任何状态", async () => {
    await expect(resolveDesktopGateway()).resolves.toEqual({ supported: false, baseUrl: null });
  });

  it("未安装二进制：给出可执行提示，不假装可用", async () => {
    const bridge = fakeBridge({
      status: async () => status({ available: false, running: false, lastError: null }),
    });
    const result = await resolveDesktopGateway(bridge);
    expect(result.baseUrl).toBeNull();
    expect(result.error).toMatch(/缺少二进制/);
  });

  it("运行中：直接取反代地址；未运行：先启动再取", async () => {
    const running = fakeBridge();
    await expect(resolveDesktopGateway(running)).resolves.toMatchObject({
      supported: true,
      baseUrl: "http://127.0.0.1:40123/v1",
      version: "0.1.3246",
    });

    const starts: string[] = [];
    const stopped = fakeBridge({
      status: async () => status({ running: false }),
      start: async () => {
        starts.push("start");
        return { baseUrl: "http://127.0.0.1:40123/v1", status: status() };
      },
    });
    await resolveDesktopGateway(stopped);
    expect(starts).toEqual(["start"]);
  });
});

describe("ensureDesktopGateway", () => {
  it("采用反代地址并刷新模型目录（source=desktop）", async () => {
    installBridge(fakeBridge());
    stubModelsFetch();
    const result = await ensureDesktopGateway();
    expect(result.supported).toBe(true);
    expect(result.adopted).toBe(true);
    expect(useLlmStore.getState().gateway.baseUrl).toBe("http://127.0.0.1:40123/v1");
    expect(useLlmStore.getState().profiles.map((p) => p.model)).toEqual(["deepseek/deepseek-chat"]);
  });

  it("用户手填过网关（manual）：照样刷新目录，但不覆盖地址", async () => {
    installBridge(fakeBridge());
    stubModelsFetch();
    useLlmStore.getState().setGateway({ baseUrl: "https://gw.example.com/v1", key: "k" });
    expect(useLlmStore.getState().gateway.source).toBe("manual");
    const result = await ensureDesktopGateway();
    expect(result.adopted).toBe(false);
    expect(useLlmStore.getState().gateway.baseUrl).toBe("https://gw.example.com/v1");
  });

  it("没有桥：返回 supported=false，静默不抛", async () => {
    await expect(ensureDesktopGateway()).resolves.toEqual({
      supported: false,
      baseUrl: null,
      adopted: false,
    });
  });
});
