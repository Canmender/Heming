import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import {
  createRegistryStore,
  REGISTRY_CACHE_TTL_MS,
  type RegistryStoreDeps,
} from "./registry.js";
import { McpRegistry } from "../lib/mcp/store.js";
import type { StorageLike } from "../lib/memory/types.js";
import type { RegistryEntry, RegistryItem } from "../lib/registry/types.js";

function memStorage(): StorageLike {
  const map = new Map<string, string>();
  return {
    getItem: (k) => (map.has(k) ? (map.get(k) as string) : null),
    setItem: (k, v) => void map.set(k, v),
    removeItem: (k) => void map.delete(k),
  };
}

function emptyMcp(): McpRegistry {
  const mcp = new McpRegistry(memStorage());
  for (const s of [...mcp.servers()]) mcp.remove(s.id);
  return mcp;
}

function item(
  name: string,
  patch: Partial<RegistryItem["server"]> = {},
  status = "active",
): RegistryItem {
  return {
    server: {
      name,
      title: name.split("/").pop() ?? name,
      description: "demo",
      version: "1.0.0",
      remotes: [{ type: "streamable-http", url: `https://${name.replace(/[/.]/g, "-")}.example.com/mcp` }],
      ...patch,
    },
    _meta: { "io.modelcontextprotocol.registry/official": { status, isLatest: true } },
  };
}

function response(body: unknown, ok = true, status = 200) {
  return { ok, status, text: async () => JSON.stringify(body) };
}

function server(entries: RegistryItem[], nextCursor?: string) {
  return response({ servers: entries, metadata: nextCursor ? { nextCursor } : {} });
}

function make(overrides: Partial<RegistryStoreDeps> = {}, fetchImpl = vi.fn()) {
  let clock = 1_000_000;
  const mcp = overrides.mcp ?? emptyMcp();
  const store = createRegistryStore({
    storage: memStorage(),
    fetchImpl: fetchImpl as unknown as RegistryStoreDeps["fetchImpl"],
    now: () => clock,
    mcp,
    refreshTools: async () => [],
    ...overrides,
  });
  return { store, mcp, advance: (ms: number) => (clock += ms), fetchImpl };
}

describe("Registry store：缓存与降级", () => {
  it("TTL 内第二次 load 直接用缓存，不再请求", async () => {
    const fetchImpl = vi.fn(async () => server([item("io.github.a/one")]));
    const { store, advance } = make({}, fetchImpl);

    await store.getState().load("");
    expect(fetchImpl).toHaveBeenCalledTimes(1);
    expect(store.getState().entries.map((e) => e.key)).toEqual(["io.github.a/one"]);

    advance(REGISTRY_CACHE_TTL_MS - 1);
    await store.getState().load("");
    expect(fetchImpl).toHaveBeenCalledTimes(1);
  });

  it("缓存过期后重新请求", async () => {
    const fetchImpl = vi.fn(async () => server([item("io.github.a/one")]));
    const { store, advance } = make({}, fetchImpl);

    await store.getState().load("");
    advance(REGISTRY_CACHE_TTL_MS + 1);
    await store.getState().load("");
    expect(fetchImpl).toHaveBeenCalledTimes(2);
  });

  it("请求失败：保留旧缓存并置 stale，不抛错", async () => {
    const fetchImpl = vi
      .fn()
      .mockResolvedValueOnce(server([item("io.github.a/one")]))
      .mockResolvedValueOnce(response({}, false, 503));
    const { store, advance } = make({}, fetchImpl);

    await store.getState().load("");
    advance(REGISTRY_CACHE_TTL_MS + 1);
    await expect(store.getState().load("")).resolves.toBeUndefined();

    expect(store.getState().entries.map((e) => e.key)).toEqual(["io.github.a/one"]);
    expect(store.getState().stale).toBe(true);
    expect(store.getState().error).toContain("503");
  });

  it("fetch 直接抛异常也归为错误（load 永不抛）", async () => {
    const fetchImpl = vi.fn(async () => {
      throw new Error("boom");
    });
    const { store } = make({}, fetchImpl);

    await expect(store.getState().load("")).resolves.toBeUndefined();
    expect(store.getState().error).toContain("boom");
    expect(store.getState().entries).toEqual([]);
    expect(store.getState().stale).toBe(false);
  });

  it("loadMore 追加并去重", async () => {
    const fetchImpl = vi
      .fn()
      .mockResolvedValueOnce(server([item("io.github.a/one")], "cursor-1"))
      .mockResolvedValueOnce(server([item("io.github.a/one"), item("io.github.a/two")]));
    const { store } = make({}, fetchImpl);

    await store.getState().load("");
    await store.getState().loadMore();
    expect(store.getState().entries.map((e) => e.key)).toEqual(["io.github.a/one", "io.github.a/two"]);
  });
});

describe("Registry store：安装流", () => {
  const entry: RegistryEntry = {
    key: "io.github.a/remote",
    title: "Remote",
    description: "",
    status: "active",
    options: [
      {
        kind: "http",
        label: "远程 · streamable-http",
        url: "https://remote.example.com/mcp",
        headerHints: [{ name: "Authorization", isRequired: true, isSecret: true }],
      },
    ],
  };

  it("确认后写入配置：origin=registry、带用户填的请求头、工具仍为 0", async () => {
    const mcp = emptyMcp();
    const refresh = vi.fn(async (id: string, reg: McpRegistry) => {
      const tools = [{ name: "do_thing", description: "写" }];
      reg.setTools(id, tools);
      return tools;
    });
    const { store } = make({
      mcp,
      refreshTools: refresh,
      confirmInstall: async () => ({ approved: true, headers: { Authorization: "Bearer t" } }),
    });

    const result = await store.getState().install(entry, entry.options[0]);
    expect(result).toEqual({ ok: true, tools: 1 });

    const saved = mcp.servers().find((s) => s.registryName === entry.key);
    expect(saved).toBeTruthy();
    expect(saved?.origin).toBe("registry");
    expect(saved?.headers).toEqual({ Authorization: "Bearer t" });
    // 安全默认：装完不等于授权，工具必须仍为 0
    expect(mcp.enabledTools()).toHaveLength(0);
    expect(refresh).toHaveBeenCalledTimes(1);
  });

  it("用户取消 → 不写配置", async () => {
    const mcp = emptyMcp();
    const { store } = make({ mcp, confirmInstall: async () => ({ approved: false }) });

    const result = await store.getState().install(entry, entry.options[0]);
    expect(result.canceled).toBe(true);
    expect(mcp.servers().find((s) => s.registryName === entry.key)).toBeUndefined();
  });

  it("必填请求头缺失 → 拒绝安装（不能靠 UI 禁用兜底）", async () => {
    const mcp = emptyMcp();
    const { store } = make({ mcp, confirmInstall: async () => ({ approved: true, headers: {} }) });

    const result = await store.getState().install(entry, entry.options[0]);
    expect(result.ok).toBe(false);
    expect(result.error).toContain("必填");
    expect(mcp.servers().find((s) => s.registryName === entry.key)).toBeUndefined();
  });

  it("连接失败 → 配置保留，错误说明可重试/删除", async () => {
    const mcp = emptyMcp();
    const { store } = make({
      mcp,
      refreshTools: async () => {
        throw new Error("401");
      },
      confirmInstall: async () => ({ approved: true, headers: { Authorization: "Bearer t" } }),
    });

    const result = await store.getState().install(entry, entry.options[0]);
    expect(result.ok).toBe(false);
    expect(result.error).toContain("已保存配置");
    expect(mcp.servers().find((s) => s.registryName === entry.key)).toBeTruthy();
  });

  it("已安装的条目不会重复写入", async () => {
    const mcp = emptyMcp();
    const { store } = make({
      mcp,
      confirmInstall: async () => ({ approved: true, headers: { Authorization: "Bearer t" } }),
    });

    await store.getState().install(entry, entry.options[0]);
    const again = await store.getState().install(entry, entry.options[0]);
    expect(again.ok).toBe(false);
    expect(again.error).toContain("已安装");
    expect(mcp.servers().filter((s) => s.registryName === entry.key)).toHaveLength(1);
  });
});

/* ================================================================== 本地包（stdio） */

describe("Registry store：本地包安装的运行时门槛", () => {
  const localEntry = (registryType: "npm" | "pypi"): RegistryEntry => ({
    key: `io.github.a/local-${registryType}`,
    title: "Local",
    description: "",
    status: "active",
    options: [
      registryType === "npm"
        ? {
            kind: "stdio",
            label: "npm · pkg@1.2.3",
            command: "npx",
            args: ["-y", "pkg@1.2.3"],
            registryType: "npm",
            version: "1.2.3",
          }
        : {
            kind: "stdio",
            label: "pypi · fetch==0.6.2",
            command: "uvx",
            args: ["mcp-server-fetch==0.6.2"],
            registryType: "pypi",
            version: "0.6.2",
          },
    ],
  });

  const ready = { platform: "win32", npm: true, pypi: true, note: "齐备" };

  // 本地包要在本机拉起进程：没有 stdio 桥就是浏览器，装不了是确定事实。
  // 这一组测的是「装了运行时能不能跑」，所以先把桌面环境假出来。
  beforeEach(() => {
    vi.stubGlobal("__mcp_stdio", { request: async () => ({}), stop: async () => true });
  });
  afterEach(() => {
    vi.unstubAllGlobals();
  });

  it("★ 缺运行时时**不进确认卡**：确认一次跑不起来的东西没有意义", async () => {
    const confirm = vi.fn(async () => ({ approved: true }));
    const { store } = make({
      mcp: emptyMcp(),
      confirmInstall: confirm,
      probeRuntime: async () => ({ platform: "win32", npm: false, pypi: true, note: "" }),
    });
    const local = localEntry("npm");

    const result = await store.getState().install(local, local.options[0]);
    expect(result.ok).toBe(false);
    expect(result.error).toContain("Node.js");
    expect(result.canceled).toBeUndefined();
    expect(confirm).not.toHaveBeenCalled();
  });

  it("探测只在需要时做一次，装第二个同类包不再探", async () => {
    const probe = vi.fn(async () => ready);
    const { store } = make({ mcp: emptyMcp(), probeRuntime: probe, confirmInstall: async () => ({ approved: true }) });
    const local = localEntry("npm");

    await store.getState().install(local, local.options[0]);
    await store.getState().install(local, local.options[0]).catch(() => {});
    expect(probe).toHaveBeenCalledTimes(1);
  });

  it("★ 本地包照样必须走确认（运行时齐备 ≠ 免确认）", async () => {
    const confirm = vi.fn(async () => ({ approved: false }));
    const mcp = emptyMcp();
    const { store } = make({ mcp, probeRuntime: async () => ready, confirmInstall: confirm });
    const local = localEntry("npm");

    const result = await store.getState().install(local, local.options[0]);
    expect(confirm).toHaveBeenCalledTimes(1);
    expect(result.canceled).toBe(true);
    expect(mcp.servers()).toHaveLength(0);
  });

  it("装成功后写入台账：registryType / registryVersion / 逻辑命令", async () => {
    const mcp = emptyMcp();
    const { store } = make({ mcp, probeRuntime: async () => ready, confirmInstall: async () => ({ approved: true }) });
    const local = localEntry("pypi");

    const result = await store.getState().install(local, local.options[0]);
    expect(result).toEqual({ ok: true, tools: 0 });
    const saved = mcp.servers().find((s) => s.registryName === local.key);
    expect(saved?.transport).toBe("stdio");
    expect(saved?.command).toBe("uvx");           // 逻辑命令：真实形态由桌面端翻译
    expect(saved?.args).toEqual(["mcp-server-fetch==0.6.2"]);
    expect(saved?.registryType).toBe("pypi");
    expect(saved?.registryVersion).toBe("0.6.2");
    // 安全默认：装完不等于授权
    expect(mcp.enabledTools()).toHaveLength(0);
  });

  it("探测不到运行时（浏览器 / IPC 失败）时不拦，交给启动阶段的准确错误", async () => {
    const mcp = emptyMcp();
    const { store } = make({
      mcp,
      probeRuntime: async () => null,
      confirmInstall: async () => ({ approved: true }),
    });
    const local = localEntry("npm");

    const result = await store.getState().install(local, local.options[0]);
    expect(result.ok).toBe(true);
  });

  it("probeRuntime 幂等且永不抛（桥坏了也只置 runtime=null）", async () => {
    const { store } = make({
      mcp: emptyMcp(),
      probeRuntime: async () => {
        throw new Error("通道未注册");
      },
    });

    await store.getState().probeRuntime();
    expect(store.getState().runtime).toBeNull();
    expect(store.getState().runtimeProbed).toBe(true);
    expect(store.getState().probingRuntime).toBe(false);
    // 已探过就不再探；force 才重探
    const before = store.getState().runtime;
    await store.getState().probeRuntime();
    expect(store.getState().runtime).toBe(before);
  });

  it("远程装法完全不碰运行时探测", async () => {
    const probe = vi.fn(async () => ready);
    const { store } = make({ mcp: emptyMcp(), probeRuntime: probe, confirmInstall: async () => ({ approved: true }) });
    const remote: RegistryEntry = {
      key: "io.github.a/remote",
      title: "Remote",
      description: "",
      status: "active",
      options: [{ kind: "http", label: "远程", url: "https://remote.example.com/mcp" }],
    };

    await store.getState().install(remote, remote.options[0]);
    expect(probe).not.toHaveBeenCalled();
  });
});
