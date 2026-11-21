import { describe, it, expect, beforeEach, afterEach, vi } from "vitest";
import { render, screen, fireEvent, cleanup } from "@testing-library/react";
import { SystemCapabilityStatus } from "./SystemCapabilityStatus.js";
import { McpRegistry, MCP_SERVERS_KEY, refreshServerTools } from "../../lib/mcp/index.js";
import type { McpServerConfig } from "../../lib/mcp/index.js";
import type { StorageLike } from "../../lib/memory/types.js";

/**
 * 系统能力状态条（d.149.4.95.11）。
 *
 * MCP 页签顶部的「系统能力」卡片区删掉后，连接态、工具数、重新连接与内置运行时提示
 * 由这个紧凑状态条承担；工具开关仍在下方「工具授权 → 系统能力」分组里。
 * 这里只测状态条的可见事实：状态文案、工具数、重新连接动作、运行时状态行。
 */

vi.mock("../../lib/mcp/index.js", async (importOriginal) => {
  const actual = await importOriginal<typeof import("../../lib/mcp/index.js")>();
  return {
    ...actual,
    // 真实实现会走 IPC 拉起服务；这里打桩成「发现一个工具 + 记一次成功连接」。
    refreshServerTools: vi.fn(async (serverId: string, reg: McpRegistry) => {
      const tools = [{ name: "echo", description: "回声工具" }];
      reg.setTools(serverId, tools);
      reg.setStatus(serverId, { state: "connected", tools: tools.length });
      return tools;
    }),
  };
});

const T0 = new Date("2026-11-01T08:00:00.000Z").getTime();

function memStorage(): StorageLike {
  const map = new Map<string, string>();
  return {
    getItem: (k) => (map.has(k) ? (map.get(k) as string) : null),
    setItem: (k, v) => void map.set(k, v),
    removeItem: (k) => void map.delete(k),
  };
}

function storageWith(servers: Partial<McpServerConfig>[]): StorageLike {
  const map = new Map<string, string>();
  map.set(MCP_SERVERS_KEY, JSON.stringify(servers));
  return {
    getItem: (k) => (map.has(k) ? (map.get(k) as string) : null),
    setItem: (k, v) => void map.set(k, v),
    removeItem: (k) => void map.delete(k),
  };
}

function freshRegistry(): McpRegistry {
  return new McpRegistry(storageWith([]), () => new Date(T0).toISOString());
}

/** 运行时桥的测试替身（结构与 `RuntimeBridgeApi` 一致）。 */
interface RuntimeBridgeStub {
  probe: ReturnType<typeof vi.fn>;
  status: ReturnType<typeof vi.fn>;
}

function setRuntimeBridge(bridge: RuntimeBridgeStub | undefined): void {
  const win = window as unknown as { __heming_runtime?: RuntimeBridgeStub };
  if (bridge) win.__heming_runtime = bridge;
  else delete win.__heming_runtime;
}

beforeEach(() => {
  localStorage.clear();
  vi.mocked(refreshServerTools).mockClear();
});

afterEach(() => {
  setRuntimeBridge(undefined);
  cleanup();
});

describe("SystemCapabilityStatus：状态条", () => {
  it("列出两条系统能力：标「随应用内置」、显示名称与未连接状态", () => {
    render(<SystemCapabilityStatus registry={freshRegistry()} />);

    const strip = screen.getByTestId("mcp-system-status");
    expect(strip).toHaveTextContent("随应用内置");
    expect(strip).toHaveTextContent("Windows 桌面控制");
    expect(strip).toHaveTextContent("网页抓取（Scrapling）");
    // 没连过 → 两条都是「未连接」+「未获取工具」
    expect(screen.getAllByText("未连接")).toHaveLength(2);
    expect(screen.getAllByText("未获取工具")).toHaveLength(2);
  });

  it("已发现过工具的服务显示「已连接」与工具数", () => {
    const registry = freshRegistry();
    const win = registry.systemServers()[0];
    registry.setTools(win.id, [{ name: "echo", description: "回声" }]);
    registry.setStatus(win.id, { state: "connected", tools: 1 });

    render(<SystemCapabilityStatus registry={registry} />);

    expect(screen.getByText("已连接")).toBeInTheDocument();
    expect(screen.getByText("1 个工具")).toBeInTheDocument();
  });

  it("点「重新连接」会刷新工具并更新为已连接", async () => {
    const registry = freshRegistry();
    render(<SystemCapabilityStatus registry={registry} />);

    fireEvent.click(screen.getByRole("button", { name: "重新连接 Windows 桌面控制" }));

    expect(await screen.findByText("已连接")).toBeInTheDocument();
    expect(refreshServerTools).toHaveBeenCalledWith("mcp-windows-desktop", registry);
  });

  it("重连成功后 registry 再变 stale，状态条跟着变，不永久显示绿灯（d.412 回归）", async () => {
    const registry = freshRegistry();
    const { rerender } = render(<SystemCapabilityStatus registry={registry} />);

    fireEvent.click(screen.getByRole("button", { name: "重新连接 Windows 桌面控制" }));
    expect(await screen.findByText("已连接")).toBeInTheDocument();

    // 之后别处记录服务死亡：本地 "ready" 不能再盖住 registry 的真实状态
    registry.setStatus("mcp-windows-desktop", { state: "stale", error: "进程已退出" } as never);
    rerender(<SystemCapabilityStatus registry={registry} />);
    expect(await screen.findByText("已断开（清单过期）")).toBeInTheDocument();
  });

  it("重新连接失败时显示错误文案，不假装已连接", async () => {
    vi.mocked(refreshServerTools).mockRejectedValueOnce(new Error("拉起进程失败"));
    const registry = freshRegistry();
    render(<SystemCapabilityStatus registry={registry} />);

    fireEvent.click(screen.getByRole("button", { name: "重新连接 Windows 桌面控制" }));

    const alert = await screen.findByRole("alert");
    expect(alert).toHaveTextContent("拉起进程失败");
    expect(screen.getAllByText("连接失败")).toHaveLength(1);
  });

  it("系统能力缺失（密文读不出）时给出恢复提示", () => {
    const empty = {
      systemServers: () => [],
      tools: () => [],
      status: () => undefined,
      hasDiscovered: () => false,
    } as unknown as McpRegistry;

    render(<SystemCapabilityStatus registry={empty} />);
    expect(screen.getByTestId("mcp-system-status")).toHaveTextContent("系统能力暂不可用");
  });

  it("内置运行时正常：状态行用弱化色", async () => {
    const note = "系统能力使用包内运行时，无需安装 Python 或 uv";
    setRuntimeBridge({
      probe: vi.fn(),
      status: vi.fn(async () => ({
        bundled: true,
        depsReady: true,
        python: "C:\\x\\python.exe",
        uv: null,
        runtimeDir: "C:\\x",
        note,
      })),
    });

    render(<SystemCapabilityStatus registry={freshRegistry()} />);
    const line = await screen.findByTestId("mcp-runtime-status");
    expect(line.textContent).toContain(note);
    expect(line.className).toContain("text-muted");
    expect(line.className).not.toContain("text-warn");
  });

  it("内置运行时缺失：警示色并提示重新安装和鸣", async () => {
    const note = "未找到包内运行时，已退回系统 uvx";
    setRuntimeBridge({
      probe: vi.fn(),
      status: vi.fn(async () => ({
        bundled: false,
        depsReady: false,
        python: null,
        uv: "C:\\Windows\\uv.exe",
        runtimeDir: "C:\\x",
        note,
      })),
    });

    render(<SystemCapabilityStatus registry={freshRegistry()} />);
    const line = await screen.findByTestId("mcp-runtime-status");
    expect(line.textContent).toContain(note);
    expect(line.textContent).toContain("重新安装和鸣");
    expect(line.className).toContain("text-warn");
  });

  it("没有运行时桥（浏览器）：不渲染状态行", () => {
    setRuntimeBridge(undefined);
    render(<SystemCapabilityStatus registry={freshRegistry()} />);
    expect(screen.queryByTestId("mcp-runtime-status")).toBeNull();
  });
});
