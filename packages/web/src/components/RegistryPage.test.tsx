import { describe, it, expect, vi, afterEach } from "vitest";
import { render, screen, fireEvent, act, within } from "@testing-library/react";
import { RegistryPage } from "./RegistryPage.js";
import { createRegistryStore } from "../store/registry.js";
import { McpRegistry } from "../lib/mcp/store.js";
import type { StorageLike } from "../lib/memory/types.js";
import type { RegistryItem } from "../lib/registry/types.js";

function memStorage(): StorageLike {
  const map = new Map<string, string>();
  return {
    getItem: (k) => (map.has(k) ? (map.get(k) as string) : null),
    setItem: (k, v) => void map.set(k, v),
    removeItem: (k) => void map.delete(k),
  };
}

function item(name: string, patch: Partial<RegistryItem["server"]> = {}): RegistryItem {
  return {
    server: {
      name,
      title: name.split("/").pop() ?? name,
      description: "demo",
      version: "1.0.0",
      remotes: [{ type: "streamable-http", url: "https://mcp.example.com/mcp" }],
      ...patch,
    },
    _meta: { "io.modelcontextprotocol.registry/official": { status: "active", isLatest: true } },
  };
}

function response(body: unknown) {
  return { ok: true, status: 200, text: async () => JSON.stringify(body) };
}

function makeStore(
  items: RegistryItem[],
  fetchImpl = vi.fn(async (_url: string) => response({ servers: items })),
) {
  const mcp = new McpRegistry(memStorage());
  for (const s of [...mcp.servers()]) mcp.remove(s.id);
  const store = createRegistryStore({
    storage: memStorage(),
    fetchImpl: fetchImpl as never,
    mcp,
    refreshTools: async () => [],
  });
  return { store, mcp, fetchImpl };
}

afterEach(() => {
  vi.useRealTimers();
  vi.unstubAllGlobals();
});

describe("RegistryPage", () => {
  it("★ 浏览器里本地包标「需桌面版」——不隐藏、也不给一个点不动的按钮", async () => {
    const { store } = makeStore([
      item("io.github.a/remote"),
      item("io.github.a/local", {
        remotes: [],
        packages: [{ registryType: "npm", identifier: "some-pkg", version: "1.0.0" }],
      }),
    ]);
    render(<RegistryPage store={store} />);

    expect(await screen.findByText("remote")).toBeInTheDocument();
    expect(screen.getByText("local")).toBeInTheDocument();
    const row = screen.getByRole("region", { name: "Registry 服务 local" });
    const button = within(row).getByRole("button", { name: "安装 local" });
    expect(button).toBeDisabled();
    expect(button).toHaveTextContent("需桌面版");
    expect(within(row).getByText("本地包服务需要桌面版（浏览器无法拉起本机进程）")).toBeInTheDocument();
  });

  it("★ 桌面端缺运行时时标「缺运行时」并说清要装什么", async () => {
    vi.stubGlobal("__mcp_stdio", { request: async () => ({}), stop: async () => true });
    vi.stubGlobal("__heming_runtime", {
      probe: async () => ({ platform: "win32", npm: false, pypi: false, note: "本机未安装：Node.js、uv" }),
    });
    const { store } = makeStore([
      item("io.github.a/local", {
        remotes: [],
        packages: [{ registryType: "pypi", identifier: "mcp-server-fetch", version: "0.6.2" }],
      }),
    ]);
    render(<RegistryPage store={store} />);

    const row = await screen.findByRole("region", { name: "Registry 服务 local" });
    const button = within(row).getByRole("button", { name: "安装 local" });
    expect(button).toBeDisabled();
    expect(button).toHaveTextContent("缺运行时");
    expect(within(row).getByText(/本机未检测到 uv（uvx）/)).toBeInTheDocument();
    // 运行时状态直接写在页面上，用户不用点安装才知道缺什么
    expect(screen.getByText(/本机运行时：Node.js 未检测到 · uv 未检测到/)).toBeInTheDocument();
  });

  it("运行时齐备的桌面端：本地包按钮可点", async () => {
    vi.stubGlobal("__mcp_stdio", { request: async () => ({}), stop: async () => true });
    vi.stubGlobal("__heming_runtime", {
      probe: async () => ({ platform: "win32", npm: true, pypi: true, note: "齐备" }),
    });
    const { store } = makeStore([
      item("io.github.a/local", {
        remotes: [],
        packages: [{ registryType: "npm", identifier: "some-pkg", version: "1.0.0" }],
      }),
    ]);
    render(<RegistryPage store={store} />);

    const row = await screen.findByRole("region", { name: "Registry 服务 local" });
    expect(within(row).getByRole("button", { name: "安装 local" })).toBeEnabled();
    expect(screen.getByText(/本机运行时：Node.js 可用 · uv 可用/)).toBeInTheDocument();
  });

  it("★ 探测失败（IPC 坏了）不拦安装：探测是我们的问题，不该变成用户的障碍", async () => {
    vi.stubGlobal("__mcp_stdio", { request: async () => ({}), stop: async () => true });
    const { store } = makeStore([
      item("io.github.a/local", {
        remotes: [],
        packages: [{ registryType: "npm", identifier: "some-pkg", version: "1.0.0" }],
      }),
    ]);
    render(<RegistryPage store={store} />);

    const row = await screen.findByRole("region", { name: "Registry 服务 local" });
    expect(within(row).getByRole("button", { name: "安装 local" })).toBeEnabled();
    expect(screen.queryByText(/本机运行时：/)).not.toBeInTheDocument();
  });

  it("认不出的包类型仍然标「暂不支持」而不是隐藏", async () => {
    const { store } = makeStore([
      item("io.github.a/oci", {
        remotes: [],
        packages: [{ registryType: "oci", identifier: "oci://x/y", version: "1.0.0" } as never],
      }),
    ]);
    render(<RegistryPage store={store} />);

    const row = await screen.findByRole("region", { name: "Registry 服务 oci" });
    expect(within(row).getByRole("button", { name: "安装 oci" })).toHaveTextContent("暂不支持");
  });

  it("已安装的行不可再次安装", async () => {
    const { store, mcp } = makeStore([item("io.github.a/remote")]);
    mcp.add({
      id: "mcp-registry-existing",
      name: "remote",
      transport: "http",
      url: "https://mcp.example.com/mcp",
      enabled: true,
      origin: "registry",
      registryName: "io.github.a/remote",
    });

    render(<RegistryPage store={store} />);
    const button = await screen.findByRole("button", { name: "安装 remote" });
    expect(button).toBeDisabled();
    expect(button).toHaveTextContent("已安装");
  });

  it("搜索防抖 400ms：399ms 不发请求，400ms 才发", async () => {
    vi.useFakeTimers();
    const { store, fetchImpl } = makeStore([item("io.github.a/github")]);
    render(<RegistryPage store={store} />);

    await act(async () => {
      await vi.advanceTimersByTimeAsync(0);
    });
    expect(fetchImpl).toHaveBeenCalledTimes(1); // 首屏

    fireEvent.change(screen.getByLabelText("搜索 MCP 服务"), { target: { value: "github" } });
    await act(async () => {
      await vi.advanceTimersByTimeAsync(399);
    });
    expect(fetchImpl).toHaveBeenCalledTimes(1);

    await act(async () => {
      await vi.advanceTimersByTimeAsync(1);
    });
    expect(fetchImpl).toHaveBeenCalledTimes(2);
    expect(String(fetchImpl.mock.calls[1][0])).toContain("search=github");
  });

  it("请求失败且无缓存时显示错误与重试", async () => {
    const fetchImpl = vi.fn(async (_url: string) => ({ ok: false, status: 503, text: async () => "{}" }));
    const { store } = makeStore([], fetchImpl);
    render(<RegistryPage store={store} />);

    expect(await screen.findByRole("alert")).toHaveTextContent("503");
    expect(screen.getByRole("button", { name: "重试" })).toBeInTheDocument();
  });

  it("刷新进行中：按钮禁用并显示「刷新中…」", async () => {
    let resolveSecond: ((value: unknown) => void) | undefined;
    const fetchImpl = vi
      .fn()
      .mockResolvedValueOnce(response({ servers: [item("io.github.a/remote")] }))
      .mockImplementationOnce(
        () => new Promise((res) => {
          resolveSecond = res;
        }),
      );
    const { store } = makeStore([], fetchImpl as never);
    render(<RegistryPage store={store} />);

    expect(await screen.findByText("remote")).toBeInTheDocument();
    fireEvent.click(screen.getByRole("button", { name: "刷新" }));

    const busy = screen.getByRole("button", { name: "刷新中…" });
    expect(busy).toBeDisabled();

    await act(async () => {
      resolveSecond?.({ ok: true, status: 200, text: async () => JSON.stringify({ servers: [] }) });
    });
    expect(screen.getByRole("button", { name: "刷新" })).toBeEnabled();
  });
});
