import { describe, it, expect, beforeEach, vi } from "vitest";
import { render, screen, fireEvent, waitFor, within, act } from "@testing-library/react";
import { InterfacesPage } from "./InterfacesPage.js";
import {
  McpRegistry,
  MCP_SERVERS_KEY,
  clientFor,
  refreshServerTools,
  type McpServerConfig,
} from "../lib/mcp/index.js";
import type { StorageLike } from "../lib/memory/types.js";

/**
 * 接口区 UI 用例：真实 McpRegistry（内存存储）+ 打桩的连接与调用，
 * 覆盖「登记服务 → 连接拉工具 → 授权 → 手动测试」这条主链路。
 */
vi.mock("../lib/mcp/index.js", async (importOriginal) => {
  const actual = await importOriginal<typeof import("../lib/mcp/index.js")>();
  return {
    ...actual,
    // 真实实现会 registry.setTools；打桩版也照做，保证 UI 能读到工具清单
    refreshServerTools: vi.fn(async (serverId: string, reg: McpRegistry) => {
      const tools = [
        { name: "echo", description: "回声工具" },
        { name: "sum", description: "求和" },
      ];
      reg.setTools(serverId, tools);
      return tools;
    }),
    clientFor: vi.fn(() => ({
      sessionId: "sess",
      initialize: async () => ({}),
      listTools: async () => [],
      callTool: async (_name: string, args: Record<string, unknown>) => ({
        text: `结果：${JSON.stringify(args)}`,
        isError: false,
        content: [],
      }),
    })),
    resetClient: vi.fn(),
  };
});

function memStorage(): StorageLike {
  const map = new Map<string, string>();
  return {
    getItem: (k) => (map.has(k) ? (map.get(k) as string) : null),
    setItem: (k, v) => void map.set(k, v),
    removeItem: (k) => void map.delete(k),
  };
}

/**
 * 造一个「已经有服务」的存储：首次使用会自动预置 Windows 桌面控制，
 * 这里的界面用例关心的是「在已有一条预置服务的基础上」的表现，
 * 故先种一条占位服务，让用例从稳定起点开始。
 */
function memStorageWithServer(
  server: Partial<McpServerConfig> = {},
): StorageLike {
  const map = new Map<string, string>();
  map.set(
    MCP_SERVERS_KEY,
    JSON.stringify([
      {
        id: "seed",
        name: "已存在的服务",
        transport: "http",
        url: "https://seed.example.com/mcp",
        enabled: true,
        createdAt: "2026-01-01T00:00:00.000Z",
        updatedAt: "2026-01-01T00:00:00.000Z",
        ...server,
      },
    ]),
  );
  return {
    getItem: (k) => (map.has(k) ? (map.get(k) as string) : null),
    setItem: (k, v) => void map.set(k, v),
    removeItem: (k) => void map.delete(k),
  };
}

let registry: McpRegistry;

beforeEach(() => {
  vi.restoreAllMocks();
  registry = new McpRegistry(memStorageWithServer());
});

function openForm() {
  fireEvent.click(screen.getByRole("button", { name: /添加 MCP 服务/ }));
}

describe("InterfacesPage", () => {
  it("渲染标题与已存在的服务（首次使用会预置，故此处用已配好的存储）", () => {
    render(<InterfacesPage registry={registry} />);
    expect(screen.getByRole("heading", { name: "接口区" })).toBeInTheDocument();
    expect(screen.getByRole("region", { name: "MCP 服务 已存在的服务" })).toBeInTheDocument();
  });

  it("插件来源的服务显示「插件」徽标", () => {
    registry.add({
      id: "plugin:acme.weather:weather",
      name: "天气服务",
      transport: "http",
      url: "https://mcp.example.com/weather",
      origin: "plugin",
    });
    render(<InterfacesPage registry={registry} />);
    const card = screen.getByRole("region", { name: "MCP 服务 天气服务" });
    expect(within(card).getByText("插件")).toBeInTheDocument();
  });

  it("一条服务都没有时才显示引导文案（删光后的状态）", () => {
    const empty = new McpRegistry(memStorage(), () => new Date().toISOString());
    // 把预置清掉，构造真正的零服务状态
    for (const s of [...empty.servers()]) empty.remove(s.id);
    render(<InterfacesPage registry={empty} />);
    expect(screen.getByText(/还没有 MCP 服务/)).toBeInTheDocument();
  });

  it("添加 HTTP 服务后出现在列表，并自动开始连接（无需手动点）", async () => {
    render(<InterfacesPage registry={registry} />);
    openForm();
    fireEvent.change(screen.getByLabelText("服务名称"), { target: { value: "本地工具" } });
    fireEvent.change(screen.getByLabelText("服务地址"), { target: { value: "https://mcp.example.com/mcp" } });
    fireEvent.click(screen.getByRole("button", { name: "保存服务" }));

    expect(screen.getByText("本地工具")).toBeInTheDocument();
    expect(screen.getByText("https://mcp.example.com/mcp")).toBeInTheDocument();
    // 保存后立刻自动连接，所以不会停在「未连接」——这正是要修掉的「每次都要手动点」
    const card = screen.getByRole("region", { name: "MCP 服务 本地工具" });
    expect(within(card).queryByText("未连接")).not.toBeInTheDocument();
    expect(registry.servers().map((s) => s.name)).toContain("本地工具");
  });

  it("地址不合法时给出错误、不写库", () => {
    render(<InterfacesPage registry={registry} />);
    openForm();
    fireEvent.change(screen.getByLabelText("服务名称"), { target: { value: "坏地址" } });
    fireEvent.change(screen.getByLabelText("服务地址"), { target: { value: "ftp://x" } });
    fireEvent.click(screen.getByRole("button", { name: "保存服务" }));

    expect(screen.getByRole("status")).toHaveTextContent(/http:\/\/ 或 https:\/\//);
    expect(registry.servers().map((s) => s.name)).not.toContain("坏地址");
  });

  it("连接后列出工具，勾选即授权；工具默认不启用", async () => {
    const added = registry.add({ name: "Demo", transport: "http", url: "https://x/mcp" });
    render(<InterfacesPage registry={registry} />);

    fireEvent.click(screen.getByRole("button", { name: "连接 Demo" }));
    await screen.findByText("echo");
    expect(screen.getByText("已连接")).toBeInTheDocument();
    expect(screen.getByText("2 个工具")).toBeInTheDocument();

    const toggle = screen.getByLabelText("启用工具 echo") as HTMLInputElement;
    expect(toggle.checked).toBe(false); // 默认关闭 = 默认不授权
    fireEvent.click(toggle);
    expect(registry.isToolEnabled(added.id, "echo")).toBe(true);
    expect(screen.getByText(/已授权 1 个工具/)).toBeInTheDocument();
  });

  it("手动测试调用：填 JSON 参数、展示结果", async () => {
    registry.add({ name: "Demo", transport: "http", url: "https://x/mcp" });
    registry.setTools(registry.servers()[0].id, [
      { name: "echo", description: "回声工具" },
    ]);
    render(<InterfacesPage registry={registry} />);

    fireEvent.click(screen.getByRole("button", { name: "测试 echo" }));
    fireEvent.change(screen.getByLabelText("测试参数"), { target: { value: '{"q":"hi"}' } });
    fireEvent.click(screen.getByRole("button", { name: "执行" }));

    await waitFor(() => expect(screen.getByRole("status")).toHaveTextContent(/结果：\{"q":"hi"\}/));
  });

  it("删除服务需二次确认：先弹确认框，取消不删", () => {
    registry.add({ name: "Demo", transport: "http", url: "https://x/mcp" });
    render(<InterfacesPage registry={registry} />);

    fireEvent.click(screen.getByRole("button", { name: "删除 Demo" }));
    expect(screen.getByRole("dialog", { name: "删除 MCP 服务" })).toBeInTheDocument();
    fireEvent.click(screen.getByRole("button", { name: "取消" }));
    expect(screen.queryByRole("dialog")).not.toBeInTheDocument();
    expect(registry.servers().some((s) => s.name === "Demo")).toBe(true);
  });

  it("确认删除后该条消失（其余服务不受影响）", () => {
    registry.add({ name: "Demo", transport: "http", url: "https://x/mcp" });
    render(<InterfacesPage registry={registry} />);
    fireEvent.click(screen.getByRole("button", { name: "删除 Demo" }));
    fireEvent.click(screen.getByRole("button", { name: "删除" }));
    expect(registry.servers().some((s) => s.name === "Demo")).toBe(false);
    expect(screen.queryByText("Demo")).not.toBeInTheDocument();
    // 预置/已有的服务还在，所以不是空态
    expect(screen.getByRole("region", { name: "MCP 服务 已存在的服务" })).toBeInTheDocument();
  });

  it("连接进行中：连接按钮禁用并显示「连接中…」", async () => {
    registry.add({ name: "Demo", transport: "http", url: "https://x/mcp" });
    let resolveTools: ((tools: unknown[]) => void) | undefined;
    vi.mocked(refreshServerTools).mockImplementationOnce(
      () => new Promise((res) => {
        resolveTools = res as (tools: unknown[]) => void;
      }),
    );
    render(<InterfacesPage registry={registry} />);

    fireEvent.click(screen.getByRole("button", { name: "连接 Demo" }));

    const busy = screen.getByRole("button", { name: "连接 Demo" });
    expect(busy).toBeDisabled();
    expect(busy).toHaveTextContent("连接中…");

    await act(async () => {
      resolveTools?.([]);
    });
    expect(screen.getByRole("button", { name: "连接 Demo" })).toBeEnabled();
  });

  it("执行工具进行中：按钮禁用并显示「执行中…」，完成后能再次执行", async () => {
    registry.add({ name: "Demo", transport: "http", url: "https://x/mcp" });
    const added = registry.servers()[0];
    registry.setTools(added.id, [{ name: "echo", description: "回声工具" }]);
    let resolveCall: ((value: unknown) => void) | undefined;
    vi.mocked(clientFor).mockReturnValueOnce({
      sessionId: "sess",
      initialize: async () => ({}),
      listTools: async () => [],
      callTool: () =>
        new Promise((res) => {
          resolveCall = res;
        }),
    } as never);
    render(<InterfacesPage registry={registry} />);

    fireEvent.click(screen.getByRole("button", { name: "测试 echo" }));
    fireEvent.click(screen.getByRole("button", { name: "执行" }));

    const busy = await screen.findByRole("button", { name: "执行中…" });
    expect(busy).toBeDisabled();

    await act(async () => {
      resolveCall?.({ text: "完成", isError: false, content: [] });
    });
    expect(await screen.findByRole("status")).toHaveTextContent("完成");
    expect(screen.getByRole("button", { name: "执行" })).toBeEnabled();
  });
});
