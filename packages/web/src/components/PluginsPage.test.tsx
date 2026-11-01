import { describe, it, expect, beforeEach } from "vitest";
import { render, screen, fireEvent, within } from "@testing-library/react";
import { PluginsPage } from "./PluginsPage.js";
import { PluginStore, pluginServerId, type PluginMcpPort } from "../lib/plugins/index.js";
import { SkillPool, type StorageLike } from "../lib/skills/index.js";
import type { McpServerConfig } from "../lib/mcp/index.js";
import { useUiStore } from "../store/ui.js";

/**
 * 插件区 UI 用例：真实 PluginStore + SkillPool，只注入独立内存存储与 MCP 端口，
 * 用例之间零污染。
 */

const T0 = new Date("2026-11-01T08:00:00.000Z").getTime();

function makeStorage(map: Map<string, string> = new Map()): StorageLike {
  return {
    getItem: (key) => (map.has(key) ? (map.get(key) as string) : null),
    setItem: (key, value) => {
      map.set(key, value);
    },
    removeItem: (key) => {
      map.delete(key);
    },
  };
}

function fakeMcp(): { port: PluginMcpPort; servers: Map<string, McpServerConfig> } {
  const servers = new Map<string, McpServerConfig>();
  return {
    servers,
    port: {
      get: (id) => servers.get(id),
      add: (input) => {
        const server: McpServerConfig = {
          id: input.id ?? "fake",
          name: input.name,
          transport: input.transport,
          url: input.url,
          enabled: input.enabled !== false,
          origin: input.origin ?? "manual",
          createdAt: "2026-11-01T00:00:00.000Z",
          updatedAt: "2026-11-01T00:00:00.000Z",
        };
        servers.set(server.id, server);
        return server;
      },
      update: (id, patch) => {
        const current = servers.get(id);
        if (!current) throw new Error("MCP 服务不存在");
        const next = { ...current, ...patch };
        servers.set(id, next);
        return next;
      },
      remove: (id) => {
        servers.delete(id);
      },
    },
  };
}

function v2Manifest(overrides: Record<string, unknown> = {}): Record<string, unknown> {
  return {
    schemaVersion: 2,
    id: "acme.weather",
    name: "天气能力包",
    version: "1.0.0",
    description: "出行天气建议与查询服务",
    author: "Acme",
    skills: [{ name: "出行建议", instructions: "结合天气出行。" }],
    mcpServers: [
      {
        key: "weather",
        name: "天气服务",
        url: "https://mcp.example.com/weather",
        description: "查询天气",
      },
    ],
    ...overrides,
  };
}

function manifest(overrides: Record<string, unknown> = {}): Record<string, unknown> {
  return {
    schemaVersion: 1,
    id: "acme.finance",
    name: "财务助手包",
    version: "1.0.0",
    description: "财报速读与现金流检查",
    author: "Acme",
    skills: [
      { name: "财报速读", instructions: "先看收入。" },
      { name: "现金流检查", instructions: "看经营现金流。" },
    ],
    ...overrides,
  };
}

let pool: SkillPool;
let store: PluginStore;
let mcp: ReturnType<typeof fakeMcp>;

beforeEach(() => {
  const storage = makeStorage();
  pool = new SkillPool(storage, () => T0);
  mcp = fakeMcp();
  store = new PluginStore(storage, pool, () => T0, mcp.port);
  useUiStore.setState({ page: "home" });
});

function renderPage() {
  return render(<PluginsPage plugins={store} />);
}

function openInstall(): void {
  fireEvent.click(screen.getByRole("button", { name: /安装插件/ }));
}

function installNow(): void {
  openInstall();
  fireEvent.change(screen.getByLabelText("插件清单 JSON"), {
    target: { value: JSON.stringify(manifest()) },
  });
  fireEvent.click(screen.getByRole("button", { name: "确认安装" }));
}

describe("PluginsPage 插件区", () => {
  it("空态与安装面板：没有清单时确认按钮禁用", () => {
    renderPage();

    expect(screen.getByRole("heading", { name: "插件区" })).toBeInTheDocument();
    expect(screen.getByRole("region", { name: "暂无插件" })).toBeInTheDocument();
    expect(screen.getByText("还没有安装插件")).toBeInTheDocument();

    fireEvent.click(screen.getByRole("button", { name: /安装插件/ }));
    const dialog = screen.getByRole("dialog", { name: "安装插件" });
    expect(within(dialog).getByLabelText("插件清单 JSON")).toBeInTheDocument();
    expect(within(dialog).getByRole("button", { name: "确认安装" })).toBeDisabled();
    expect(within(dialog).getByRole("button", { name: "取消" })).toBeInTheDocument();
  });

  it("粘贴清单后预览，确认安装写入技能池并显示插件卡", () => {
    renderPage();
    fireEvent.click(screen.getByRole("button", { name: /安装插件/ }));
    fireEvent.change(screen.getByLabelText("插件清单 JSON"), {
      target: { value: JSON.stringify(manifest()) },
    });

    const dialog = screen.getByRole("dialog", { name: "安装插件" });
    expect(within(dialog).getByText("财务助手包")).toBeInTheDocument();
    expect(within(dialog).getByText("新插件")).toBeInTheDocument();
    expect(within(dialog).getByText("财报速读")).toBeInTheDocument();

    fireEvent.click(within(dialog).getByRole("button", { name: "确认安装" }));

    expect(screen.queryByRole("dialog", { name: "安装插件" })).not.toBeInTheDocument();
    expect(screen.getByRole("status")).toHaveTextContent(
      "已安装插件「财务助手包」：新增 2 个技能、0 台 MCP 服务",
    );
    expect(screen.getByRole("region", { name: "插件 财务助手包" })).toBeInTheDocument();
    expect(screen.queryByRole("region", { name: "暂无插件" })).not.toBeInTheDocument();

    const skills = pool.list().filter((s) => s.pluginId === "acme.finance");
    expect(skills).toHaveLength(2);
  });

  it("非法清单给出中文错误，且不能确认", () => {
    renderPage();
    fireEvent.click(screen.getByRole("button", { name: /安装插件/ }));
    fireEvent.change(screen.getByLabelText("插件清单 JSON"), {
      target: { value: '{"schemaVersion":1,"id":"Bad ID"}' },
    });

    const dialog = screen.getByRole("dialog", { name: "安装插件" });
    expect(within(dialog).getByRole("alert")).toHaveTextContent("清单不合法");
    expect(within(dialog).getByRole("alert")).toHaveTextContent("插件 id");
    expect(within(dialog).getByRole("button", { name: "确认安装" })).toBeDisabled();
    expect(store.list()).toEqual([]);
  });

  it("启用开关同步插件与技能状态", () => {
    renderPage();
    installNow();

    const toggle = screen.getByRole("switch", { name: "启用插件 财务助手包" });
    expect(toggle).toHaveAttribute("aria-checked", "true");

    fireEvent.click(toggle);
    expect(toggle).toHaveAttribute("aria-checked", "false");
    expect(store.get("acme.finance")?.enabled).toBe(false);
    expect(screen.getByRole("status")).toHaveTextContent("已停用插件「财务助手包」");
    expect(pool.list().filter((s) => s.pluginId).every((s) => !s.enabled)).toBe(true);
  });

  it("卸载需二次确认，确认后插件与技能一并消失", () => {
    renderPage();
    installNow();

    fireEvent.click(screen.getByRole("button", { name: "卸载插件 财务助手包" }));
    const confirm = screen.getByRole("dialog", { name: "卸载插件" });
    expect(confirm).toHaveTextContent("2 个技能");
    fireEvent.click(within(confirm).getByRole("button", { name: "卸载" }));

    expect(screen.queryByRole("dialog", { name: "卸载插件" })).not.toBeInTheDocument();
    expect(screen.getByRole("region", { name: "暂无插件" })).toBeInTheDocument();
    expect(screen.getByRole("status")).toHaveTextContent("已卸载插件「财务助手包」");
    expect(store.list()).toEqual([]);
    expect(pool.list().filter((s) => s.pluginId)).toEqual([]);
  });

  it("同 id 再次安装走更新，预览提示覆盖", () => {
    renderPage();
    installNow();

    fireEvent.click(screen.getByRole("button", { name: /安装插件/ }));
    fireEvent.change(screen.getByLabelText("插件清单 JSON"), {
      target: { value: JSON.stringify(manifest({ version: "1.1.0", skills: [{ name: "财报速读", instructions: "v2" }] })) },
    });
    const dialog = screen.getByRole("dialog", { name: "安装插件" });
    expect(within(dialog).getByText("将覆盖更新")).toBeInTheDocument();
    expect(within(dialog).getByText("~ 财报速读")).toBeInTheDocument();
    expect(within(dialog).getByText("- 现金流检查")).toBeInTheDocument();
    expect(within(dialog).getByText(/确认后将保留：接口区补的请求头/)).toBeInTheDocument();

    fireEvent.click(within(dialog).getByRole("button", { name: "确认更新" }));
    expect(screen.getByRole("status")).toHaveTextContent(
      "已更新插件「财务助手包」：技能 +0/改1/删1，服务 +0/改0/删0",
    );
    expect(pool.list().filter((s) => s.pluginId)).toHaveLength(1);
    expect(screen.getByRole("region", { name: "插件 财务助手包" })).toHaveTextContent("v1.1.0");
  });

  it("v2 能力包：预览网络主机、服务标签与接口区入口", () => {
    renderPage();
    fireEvent.click(screen.getByRole("button", { name: /安装插件/ }));
    fireEvent.change(screen.getByLabelText("插件清单 JSON"), {
      target: {
        value: JSON.stringify(
          manifest({
            schemaVersion: 2,
            skills: [{ name: "出行建议", instructions: "结合天气。" }],
            mcpServers: [
              {
                key: "weather",
                name: "天气服务",
                url: "https://mcp.example.com/weather",
              },
            ],
          }),
        ),
      },
    });

    const dialog = screen.getByRole("dialog", { name: "安装插件" });
    expect(within(dialog).getByText("MCP · 天气服务")).toBeInTheDocument();
    expect(within(dialog).getByText(/网络访问：mcp\.example\.com/)).toBeInTheDocument();
    expect(within(dialog).getByText(/安装后需到接口区连接/)).toBeInTheDocument();

    fireEvent.click(within(dialog).getByRole("button", { name: "确认安装" }));
    expect(screen.getByRole("status")).toHaveTextContent(
      "已安装插件「财务助手包」：新增 1 个技能、1 台 MCP 服务",
    );

    const card = screen.getByRole("region", { name: "插件 财务助手包" });
    expect(card).toHaveTextContent("1 台 MCP 服务");
    expect(card).toHaveTextContent("MCP · 天气服务");

    fireEvent.click(within(card).getByRole("button", { name: "查看插件接口 财务助手包" }));
    expect(useUiStore.getState().page).toBe("interfaces");

    fireEvent.click(within(card).getByRole("button", { name: "卸载插件 财务助手包" }));
    const confirm = screen.getByRole("dialog", { name: "卸载插件" });
    expect(confirm).toHaveTextContent("1 台 MCP 服务");
  });

  it("更新预览遇到服务 id 冲突：点名冲突并阻断确认", () => {
    const id = pluginServerId("acme.weather", "weather");
    mcp.servers.set(id, {
      id,
      name: "手填天气",
      transport: "http",
      url: "https://manual.example.com/mcp",
      enabled: true,
      origin: "manual",
      createdAt: new Date(T0).toISOString(),
      updatedAt: new Date(T0).toISOString(),
    });

    renderPage();
    openInstall();
    fireEvent.change(screen.getByLabelText("插件清单 JSON"), {
      target: { value: JSON.stringify(v2Manifest()) },
    });

    const dialog = screen.getByRole("dialog", { name: "安装插件" });
    expect(within(dialog).getByRole("alert")).toHaveTextContent("MCP 服务 id 冲突");
    expect(within(dialog).getByRole("alert")).toHaveTextContent(id);
    expect(within(dialog).getByRole("button", { name: "确认安装" })).toBeDisabled();
    expect(store.list()).toEqual([]);
  });

  it("更新预览按 key 展示服务变更与新增", () => {
    renderPage();
    openInstall();
    fireEvent.change(screen.getByLabelText("插件清单 JSON"), {
      target: { value: JSON.stringify(v2Manifest()) },
    });
    fireEvent.click(screen.getByRole("button", { name: "确认安装" }));

    openInstall();
    fireEvent.change(screen.getByLabelText("插件清单 JSON"), {
      target: {
        value: JSON.stringify(
          v2Manifest({
            version: "1.1.0",
            mcpServers: [
              {
                key: "weather",
                name: "天气服务",
                url: "https://mcp.example.com/weather-v2",
              },
              {
                key: "alerts",
                name: "预警服务",
                url: "https://mcp.example.com/alerts",
              },
            ],
          }),
        ),
      },
    });

    const dialog = screen.getByRole("dialog", { name: "安装插件" });
    expect(within(dialog).getByText("~ 天气服务")).toBeInTheDocument();
    expect(within(dialog).getByText("+ 预警服务")).toBeInTheDocument();
    expect(within(dialog).getByText(/网络访问：mcp\.example\.com/)).toBeInTheDocument();
  });

  it("详情弹窗展示物化技能与服务，并可跳转接口区", () => {
    renderPage();
    openInstall();
    fireEvent.change(screen.getByLabelText("插件清单 JSON"), {
      target: { value: JSON.stringify(v2Manifest()) },
    });
    fireEvent.click(screen.getByRole("button", { name: "确认安装" }));

    const card = screen.getByRole("region", { name: "插件 天气能力包" });
    fireEvent.click(within(card).getByRole("button", { name: "查看插件详情 天气能力包" }));

    const dialog = screen.getByRole("dialog", { name: "插件详情 天气能力包" });
    expect(within(dialog).getByText("技能（1）")).toBeInTheDocument();
    expect(within(dialog).getByText("出行建议")).toBeInTheDocument();
    expect(within(dialog).getByText("MCP 服务（1）")).toBeInTheDocument();
    expect(within(dialog).getByText("天气服务")).toBeInTheDocument();
    expect(within(dialog).getByText("mcp.example.com")).toBeInTheDocument();
    expect(within(dialog).getByText(/连接与工具授权在接口区进行/)).toBeInTheDocument();

    fireEvent.click(within(dialog).getByRole("button", { name: "查看接口" }));
    expect(useUiStore.getState().page).toBe("interfaces");
    expect(screen.queryByRole("dialog", { name: "插件详情 天气能力包" })).not.toBeInTheDocument();
  });

  it("停用后详情里的技能与服务都显示已停用，卸载从详情进入二次确认", () => {
    renderPage();
    openInstall();
    fireEvent.change(screen.getByLabelText("插件清单 JSON"), {
      target: { value: JSON.stringify(v2Manifest()) },
    });
    fireEvent.click(screen.getByRole("button", { name: "确认安装" }));

    fireEvent.click(screen.getByRole("switch", { name: "启用插件 天气能力包" }));
    const card = screen.getByRole("region", { name: "插件 天气能力包" });
    fireEvent.click(within(card).getByRole("button", { name: "查看插件详情 天气能力包" }));

    const dialog = screen.getByRole("dialog", { name: "插件详情 天气能力包" });
    expect(within(dialog).getByRole("region", { name: "插件技能" })).toHaveTextContent("已停用");
    expect(within(dialog).getByRole("region", { name: "插件 MCP 服务" })).toHaveTextContent(
      "已停用",
    );

    fireEvent.click(within(dialog).getByRole("button", { name: "卸载插件" }));
    expect(screen.queryByRole("dialog", { name: "插件详情 天气能力包" })).not.toBeInTheDocument();
    expect(screen.getByRole("dialog", { name: "卸载插件" })).toHaveTextContent("1 台 MCP 服务");
  });
});
