import { describe, it, expect, beforeEach, vi } from "vitest";
import { render, screen, fireEvent, within, act, waitFor } from "@testing-library/react";
import { PluginsPage } from "./PluginsPage.js";
import { PluginStore, PLUGINS_KEY, pluginServerId, type PluginMcpPort } from "../lib/plugins/index.js";
import { SkillPool, type StorageLike } from "../lib/skills/index.js";
import { McpRegistry, type McpServerConfig } from "../lib/mcp/index.js";
import { useUiStore } from "../store/ui.js";
import { useModuleStore } from "../lib/modules/store.js";

/**
 * 插件区 UI 用例：真实 PluginStore + SkillPool，只注入独立内存存储与 MCP 端口，
 * 用例之间零污染。
 *
 * d.67 起「技能 / MCP 服务」两个 Tab 内嵌完整视图（原技能区 / 接口区页面主体），
 * 所以这里也给页面注入独立的 SkillPool 与 McpRegistry——两个视图各自读自己的单例。
 */

// 技能 Tab 内嵌的技能视图会拉一次智能体名册：固定成内存名册，不依赖网络。
vi.mock("../lib/agentsApi.js", () => ({
  listAgents: vi.fn(async () => [{ id: "a1", name: "和鸣助手" }]),
}));

// 仓库 Tab 会拉云端目录并下载清单：固定成可控数据，不依赖网络。
vi.mock("../lib/plugins/catalogClient.js", async (importOriginal) => {
  const actual = await importOriginal<typeof import("../lib/plugins/catalogClient.js")>();
  return {
    ...actual,
    fetchPluginCatalog: vi.fn(async () => [
      {
        id: "acme.repo",
        name: "仓库插件",
        version: "1.0.0",
        schemaVersion: 3,
        description: "从仓库安装",
        author: "ACME",
        publishedAt: "2026-11-07T10:00:00.000Z",
        sha256: "b".repeat(64),
        size: 1024,
        permissions: { network: [], tools: "none", files: [] },
        contributions: { skills: 0, mcpServers: 0, commands: 0, toolPacks: 0 },
      },
    ]),
    downloadPluginManifest: vi.fn(async () =>
      JSON.stringify({
        schemaVersion: 3,
        id: "acme.repo",
        name: "仓库插件",
        version: "1.0.0",
        permissions: { network: [], tools: "read", files: [] },
        contributions: { skills: [{ name: "仓库技能", instructions: "从仓库装进来的技能。" }] },
      }),
    ),
  };
});

// 模块目录走服务端：固定成可控数据，不依赖网络。
vi.mock("../lib/modules/catalogClient.js", () => ({
  fetchModuleCatalog: vi.fn(async () => [
    {
      id: "staff",
      name: "幕僚",
      version: "1.0.0",
      description: "每天检查日程和任务。",
      author: "和鸣",
      engine: null,
    },
    {
      id: "infohub",
      name: "信息中枢",
      version: "1.0.0",
      description: "在本机浏览归档。",
      author: "和鸣",
      engine: "heming.infohub-engine",
    },
    {
      id: "automations",
      name: "自动化",
      version: "1.0.0",
      description: "定时同步归档。",
      author: "和鸣",
      engine: null,
    },
    {
      id: "workflows",
      name: "工作流",
      version: "1.0.0",
      description: "节点式自动化。",
      author: "和鸣",
      engine: null,
    },
  ]),
}));

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
let registry: McpRegistry;

beforeEach(() => {
  const storage = makeStorage();
  pool = new SkillPool(storage, () => T0);
  mcp = fakeMcp();
  store = new PluginStore(storage, pool, () => T0, mcp.port);
  // MCP Tab 现在渲染完整接口视图，需要一个真实的注册表（内存存储，不联网）。
  registry = new McpRegistry(makeStorage(), () => new Date(T0).toISOString());
  useUiStore.setState({ page: "home", pageView: null });
});

function renderPage() {
  return render(<PluginsPage plugins={store} skills={pool} mcp={registry} />);
}

function openInstall(): void {
  fireEvent.click(screen.getByRole("button", { name: "手动粘贴清单" }));
}

function installNow(): void {
  openInstall();
  fireEvent.change(screen.getByLabelText("插件清单 JSON"), {
    target: { value: JSON.stringify(manifest()) },
  });
  fireEvent.click(screen.getByRole("button", { name: "确认安装" }));
}

describe("PluginsPage · 云端安装弹窗（d.96）", () => {
  it("「从云端安装」直接列出云端插件库，选中后关闭弹窗并进入安装预览", async () => {
    renderPage();
    fireEvent.click(screen.getByRole("button", { name: "从插件仓库安装" }));
    const dialog = await screen.findByRole("dialog", { name: "云端插件库" });
    expect(await within(dialog).findByText("仓库插件")).toBeInTheDocument();
    expect(within(dialog).getByLabelText("搜索插件仓库")).toBeInTheDocument();

    fireEvent.click(within(dialog).getByRole("button", { name: "安装" }));
    // 下载完成后弹窗关闭，清单进同一个安装预览
    await waitFor(() => expect(screen.queryByRole("dialog", { name: "云端插件库" })).toBeNull());
    const textarea = (await screen.findByLabelText("插件清单 JSON")) as HTMLTextAreaElement;
    expect(textarea.value).toContain("acme.repo");
    expect(screen.getByRole("dialog", { name: "安装插件" })).toBeInTheDocument();
  });

  it("空插件页：列表上方仍给出「从云端安装」与「手动粘贴清单」两个入口", async () => {
    renderPage();
    expect(screen.getByText("还没有安装插件")).toBeInTheDocument();
    expect(screen.getByRole("button", { name: "从插件仓库安装" })).toBeInTheDocument();
    expect(screen.getByRole("button", { name: "手动粘贴清单" })).toBeInTheDocument();

    fireEvent.click(screen.getByRole("button", { name: "从插件仓库安装" }));
    expect(await screen.findByRole("dialog", { name: "云端插件库" })).toBeInTheDocument();
  });
});

describe("PluginsPage · 仓库 Tab（d.95）", () => {
  it("仓库 Tab 展示云端目录；点「安装」下载清单并打开同一个安装预览", async () => {
    renderPage();
    fireEvent.click(screen.getByRole("button", { name: "从插件仓库安装" }));
    expect(await screen.findByLabelText("搜索插件仓库")).toBeInTheDocument();
    expect(await screen.findByText("仓库插件")).toBeInTheDocument();

    fireEvent.click(screen.getByRole("button", { name: "安装" }));
    // 下载后的清单填进安装弹窗：与手动粘贴/选文件走同一条预览管线
    const textarea = await screen.findByLabelText("插件清单 JSON");
    await waitFor(() => expect((textarea as HTMLTextAreaElement).value).toContain("acme.repo"));
    expect(screen.getByRole("button", { name: "确认安装" })).toBeInTheDocument();
  });
});

describe("PluginsPage · 插件从云端安装", () => {
  it("原生页面不显示任何模块卡片；pageView=modules 只落到插件 Tab", () => {
    useModuleStore.getState().reset();
    renderPage();
    act(() => {
      useUiStore.getState().setPage("plugins", "modules");
    });
    expect(screen.getByRole("tab", { name: "插件" })).toHaveAttribute("aria-selected", "true");
    // 未安装的模块不再写死渲染
    for (const name of ["幕僚", "信息中枢", "自动化"]) {
      expect(screen.queryByRole("region", { name: `插件 ${name}` })).toBeNull();
    }
    expect(screen.getByRole("button", { name: "安装官方插件" })).toBeInTheDocument();
  });

  it("从云端安装插件：目录里的模块才出现；安装后可启停/删除", async () => {
    useModuleStore.getState().reset();
    renderPage();

    fireEvent.click(screen.getByRole("button", { name: "安装官方插件" }));
    const dialog = screen.getByRole("dialog", { name: "从云端安装插件" });
    // d.133：云端目录按插件分组——助理（幕僚/自动化/工作流）+ 信息
    expect(await within(dialog).findByText("助理")).toBeInTheDocument();
    expect(within(dialog).getByText("信息")).toBeInTheDocument();

    fireEvent.click(within(dialog).getByRole("button", { name: "安装插件 助理" }));
    // 安装是异步的（桌面端还要下载插件包）
    await waitFor(() => expect(useModuleStore.getState().installed.staff).toBe(true));
    expect(useModuleStore.getState().installed.automations).toBe(true);
    expect(useModuleStore.getState().installed.workflows).toBe(true);
    expect(useModuleStore.getState().enabled.staff).toBe(true);

    fireEvent.click(within(dialog).getByRole("button", { name: "关闭" }));
    const card = screen.getByRole("region", { name: "插件 助理" });
    expect(card).toHaveTextContent("这个插件带来");

    fireEvent.click(within(card).getByRole("switch", { name: "停用插件 助理" }));
    expect(useModuleStore.getState().enabled.staff).toBe(false);
    expect(useModuleStore.getState().enabled.workflows).toBe(false);

    fireEvent.click(within(card).getByRole("button", { name: "删除插件 助理" }));
    fireEvent.click(
      within(screen.getByRole("dialog", { name: "删除插件 助理" })).getByRole("button", {
        name: "删除",
      }),
    );
    await waitFor(() => expect(useModuleStore.getState().installed.staff).toBe(false));
    expect(useModuleStore.getState().installed.workflows).toBe(false);
    expect(screen.queryByRole("region", { name: "插件 助理" })).toBeNull();
    useModuleStore.getState().reset();
  });
});

describe("PluginsPage 插件", () => {
  it("空态与安装面板：没有清单时确认按钮禁用", () => {
    renderPage();

    expect(screen.getAllByRole("heading", { name: "插件" }).length).toBeGreaterThan(0);
    expect(screen.getByRole("region", { name: "暂无插件" })).toBeInTheDocument();
    expect(screen.getByText("还没有安装插件")).toBeInTheDocument();

    fireEvent.click(screen.getByRole("button", { name: "手动粘贴清单" }));
    const dialog = screen.getByRole("dialog", { name: "安装插件" });
    expect(within(dialog).getByLabelText("插件清单 JSON")).toBeInTheDocument();
    expect(within(dialog).getByRole("button", { name: "确认安装" })).toBeDisabled();
    expect(within(dialog).getByRole("button", { name: "取消" })).toBeInTheDocument();
  });

  it("粘贴清单后预览，确认安装写入技能池并显示插件卡", () => {
    renderPage();
    fireEvent.click(screen.getByRole("button", { name: "手动粘贴清单" }));
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
    fireEvent.click(screen.getByRole("button", { name: "手动粘贴清单" }));
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

    fireEvent.click(screen.getByRole("button", { name: "手动粘贴清单" }));
    fireEvent.change(screen.getByLabelText("插件清单 JSON"), {
      target: { value: JSON.stringify(manifest({ version: "1.1.0", skills: [{ name: "财报速读", instructions: "v2" }] })) },
    });
    const dialog = screen.getByRole("dialog", { name: "安装插件" });
    expect(within(dialog).getByText("将覆盖更新")).toBeInTheDocument();
    expect(within(dialog).getByText("~ 财报速读")).toBeInTheDocument();
    expect(within(dialog).getByText("- 现金流检查")).toBeInTheDocument();
    expect(within(dialog).getByText(/确认后将保留：在「MCP」Tab 补的请求头/)).toBeInTheDocument();

    fireEvent.click(within(dialog).getByRole("button", { name: "确认更新" }));
    expect(screen.getByRole("status")).toHaveTextContent(
      "已更新插件「财务助手包」：技能 +0/改1/删1，服务 +0/改0/删0",
    );
    expect(pool.list().filter((s) => s.pluginId)).toHaveLength(1);
    expect(screen.getByRole("region", { name: "插件 财务助手包" })).toHaveTextContent("v1.1.0");
  });

  it("v2 能力包：预览网络主机、服务标签与接口区入口", () => {
    renderPage();
    fireEvent.click(screen.getByRole("button", { name: "手动粘贴清单" }));
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
    expect(within(dialog).getByText(/安装后需到「MCP」Tab 连接/)).toBeInTheDocument();

    fireEvent.click(within(dialog).getByRole("button", { name: "确认安装" }));
    expect(screen.getByRole("status")).toHaveTextContent(
      "已安装插件「财务助手包」：新增 1 个技能、1 台 MCP 服务",
    );

    const card = screen.getByRole("region", { name: "插件 财务助手包" });
    expect(card).toHaveTextContent("1 台 MCP 服务");
    expect(card).toHaveTextContent("MCP · 天气服务");

    // d.67：接口区已并入本页「MCP」Tab，按钮变成切 Tab，不再跨页
    fireEvent.click(within(card).getByRole("button", { name: "查看插件 MCP 服务 财务助手包" }));
    expect(useUiStore.getState().page).toBe("home");
    expect(screen.getByRole("tab", { name: "MCP" })).toHaveAttribute("aria-selected", "true");

    // 切回「插件」Tab 继续卸载流程（切走即卸载，卡片要重新查）
    fireEvent.click(screen.getByRole("tab", { name: "插件" }));
    const cardAgain = screen.getByRole("region", { name: "插件 财务助手包" });
    fireEvent.click(within(cardAgain).getByRole("button", { name: "卸载插件 财务助手包" }));
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

  it("详情弹窗展示物化技能与服务，并可在页内切到 MCP Tab", () => {
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
    expect(within(dialog).getByText(/连接与工具授权在「MCP」Tab 进行/)).toBeInTheDocument();

    // d.67：不再跳接口区页，改为切到本页「MCP」Tab
    fireEvent.click(within(dialog).getByRole("button", { name: "查看 MCP 服务" }));
    expect(useUiStore.getState().page).toBe("home");
    expect(screen.getByRole("tab", { name: "MCP" })).toHaveAttribute("aria-selected", "true");
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

/* ------------------------------------------------ 导航合并（d.67） */

describe("PluginsPage 导航合并", () => {
  it("三个 Tab：技能与 MCP 渲染完整视图，页面级标题始终只有一个", () => {
    renderPage();
    expect(screen.getAllByRole("heading", { level: 1 })).toHaveLength(1);
    expect(screen.getByRole("heading", { level: 1 })).toHaveTextContent("插件");
    expect(screen.queryByRole("heading", { name: "技能区" })).toBeNull();

    fireEvent.click(screen.getByRole("tab", { name: "技能" }));
    expect(screen.getByRole("tab", { name: "技能" })).toHaveAttribute("aria-selected", "true");
    // 原技能区页的完整能力都在：智能体分配、技能池、搜索
    expect(screen.getByLabelText("搜索技能")).toBeInTheDocument();
    expect(screen.getByLabelText("选择智能体")).toBeInTheDocument();
    expect(screen.getByRole("tab", { name: "按智能体" })).toBeInTheDocument();
    expect(screen.getByRole("tab", { name: "技能池" })).toBeInTheDocument();
    // 嵌入后不再有自己的页面标题
    expect(screen.queryByRole("heading", { name: "技能区" })).toBeNull();
    expect(screen.getAllByRole("heading", { level: 1 })).toHaveLength(1);

    fireEvent.click(screen.getByRole("tab", { name: "MCP" }));
    expect(screen.getByRole("tab", { name: "MCP" })).toHaveAttribute("aria-selected", "true");
    // 原接口区页的完整能力都在：新增服务、Registry 发现、协议说明
    expect(screen.getByRole("button", { name: /添加 MCP 服务/ })).toBeInTheDocument();
    expect(screen.getByRole("button", { name: "从 Registry 发现" })).toBeInTheDocument();
    expect(screen.getByText(/MCP 协议 \d{4}-\d{2}-\d{2}/)).toBeInTheDocument();
    expect(screen.queryByRole("heading", { name: "接口区" })).toBeNull();
    expect(screen.getAllByRole("heading", { level: 1 })).toHaveLength(1);
  });

  it("消费一次性视图意图：旧 setPage(\"skills\") 落到技能 Tab，读完即清", () => {
    useUiStore.getState().setPage("skills");
    expect(useUiStore.getState().page).toBe("plugins");
    renderPage();
    expect(screen.getByRole("tab", { name: "技能" })).toHaveAttribute("aria-selected", "true");
    expect(useUiStore.getState().pageView).toBeNull();
  });

  it("消费一次性视图意图：旧 setPage(\"interfaces\") 落到 MCP Tab", () => {
    useUiStore.getState().setPage("interfaces");
    renderPage();
    expect(screen.getByRole("tab", { name: "MCP" })).toHaveAttribute("aria-selected", "true");
    expect(useUiStore.getState().pageView).toBeNull();
  });

  it("在「技能」Tab 新建技能后，顶部统计同帧 +1（d.68 自检：统计不再滞后）", () => {
    renderPage();
    fireEvent.click(screen.getByRole("tab", { name: "技能" }));
    const readSkillStat = () => {
      const text = screen.getByLabelText("统计 技能").textContent ?? "";
      const m = text.match(/([0-9]+)/);
      return m ? Number(m[1]) : NaN;
    };
    const before = readSkillStat();

    fireEvent.click(screen.getByRole("tab", { name: "技能池" }));
    fireEvent.click(screen.getByRole("button", { name: "新建技能" }));
    const dialog = screen.getByRole("dialog", { name: "新建技能" });
    fireEvent.change(within(dialog).getByLabelText("技能名称"), {
      target: { value: "统计刷新技能" },
    });
    fireEvent.change(within(dialog).getByLabelText("技能内容"), {
      target: { value: "自检：新建后统计卡应即时 +1。" },
    });
    fireEvent.click(within(dialog).getByRole("button", { name: "创建技能" }));

    expect(pool.list().some((skill) => skill.name === "统计刷新技能")).toBe(true);
    expect(readSkillStat()).toBe(before + 1);
  });
});

describe("PluginsPage · 插件列表筛选与安装定位（d.77）", () => {
  const weatherManifest = (): Record<string, unknown> => ({
    schemaVersion: 1,
    id: "acme.weather",
    name: "天气能力包",
    version: "1.0.0",
    description: "出行天气建议",
    author: "Acme",
    skills: [{ name: "出行建议", instructions: "结合天气出行。" }],
  });

  function installManifest(m: Record<string, unknown>): void {
    openInstall();
    fireEvent.change(screen.getByLabelText("插件清单 JSON"), {
      target: { value: JSON.stringify(m) },
    });
    fireEvent.click(screen.getByRole("button", { name: "确认安装" }));
  }

  function installTwo(): void {
    installNow(); // acme.finance：财务助手包（技能：财报速读 / 现金流检查）
    installManifest(weatherManifest());
  }

  it("按名称 / 技能名搜索，命中数写清楚；无结果给清除筛选的出口", () => {
    renderPage();
    installTwo();
    expect(screen.getByRole("region", { name: "插件 财务助手包" })).toBeInTheDocument();
    expect(screen.getByRole("region", { name: "插件 天气能力包" })).toBeInTheDocument();

    const search = screen.getByLabelText("搜索插件");
    fireEvent.change(search, { target: { value: "天气" } });
    expect(screen.getByRole("region", { name: "插件 天气能力包" })).toBeInTheDocument();
    expect(screen.queryByRole("region", { name: "插件 财务助手包" })).toBeNull();
    // d.105：列表改为四类来源统一单元，计数口径是「单元」而不是「插件」
    expect(screen.getByText(/^匹配 1 \/ 共 \d+ 个单元$/)).toBeInTheDocument();

    // 搜的是技能名，不只是插件名
    fireEvent.change(search, { target: { value: "现金流" } });
    expect(screen.getByRole("region", { name: "插件 财务助手包" })).toBeInTheDocument();
    expect(screen.queryByRole("region", { name: "插件 天气能力包" })).toBeNull();

    fireEvent.change(search, { target: { value: "不存在的包" } });
    expect(screen.getByRole("region", { name: "筛选无结果" })).toBeInTheDocument();
    expect(screen.getByText("没有匹配的能力单元")).toBeInTheDocument();

    fireEvent.click(screen.getByRole("button", { name: "清除筛选" }));
    expect(screen.getByRole("region", { name: "插件 财务助手包" })).toBeInTheDocument();
    expect(screen.getByRole("region", { name: "插件 天气能力包" })).toBeInTheDocument();
    expect(search).toHaveValue("");
  });

  it("状态筛选：只看已停用 / 已启用", () => {
    renderPage();
    installTwo();
    fireEvent.click(screen.getByRole("switch", { name: "启用插件 财务助手包" }));

    fireEvent.click(screen.getByRole("button", { name: "已停用" }));
    expect(screen.getByRole("region", { name: "插件 财务助手包" })).toBeInTheDocument();
    expect(screen.queryByRole("region", { name: "插件 天气能力包" })).toBeNull();

    fireEvent.click(screen.getByRole("button", { name: "已启用" }));
    expect(screen.queryByRole("region", { name: "插件 财务助手包" })).toBeNull();
    expect(screen.getByRole("region", { name: "插件 天气能力包" })).toBeInTheDocument();

    fireEvent.click(screen.getByRole("button", { name: "全部" }));
    expect(screen.getByRole("region", { name: "插件 财务助手包" })).toBeInTheDocument();
    expect(screen.getByRole("region", { name: "插件 天气能力包" })).toBeInTheDocument();
  });

  it("从仓库 Tab 安装后回到插件 Tab，并高亮新装的卡片", async () => {
    renderPage();
    fireEvent.click(screen.getByRole("button", { name: "从插件仓库安装" }));
    fireEvent.click(await screen.findByRole("button", { name: "安装" }));
    const textarea = await screen.findByLabelText("插件清单 JSON");
    await waitFor(() => expect((textarea as HTMLTextAreaElement).value).toContain("acme.repo"));
    fireEvent.click(screen.getByRole("button", { name: "确认安装" }));

    expect(screen.getByRole("tab", { name: "插件" })).toHaveAttribute("aria-selected", "true");
    const card = screen.getByRole("region", { name: "插件 仓库插件" });
    expect(card.className).toContain("ring-2");
    // 筛选栏出现后总数说清楚（安装前没有插件，不显示筛选栏）；d.105 起含系统/内置单元
    expect(screen.getByText(/^共 \d+ 个单元$/)).toBeInTheDocument();
  });

  it("详情里本包未声明的贡献类别：开关禁用并写明原因", () => {
    renderPage();
    installNow();
    fireEvent.click(screen.getByRole("button", { name: "查看插件详情 财务助手包" }));

    const dialog = screen.getByRole("dialog", { name: "插件详情 财务助手包" });
    // 服务 / 命令 / 工具束三类都没声明：三行都标「本包未声明」
    expect(within(dialog).getAllByText("本包未声明")).toHaveLength(3);
    for (const label of ["服务", "命令", "工具束"]) {
      expect(within(dialog).getByRole("switch", { name: `启用本插件的${label}` })).toBeDisabled();
    }
    // 声明过的类别仍可单独关
    expect(within(dialog).getByRole("switch", { name: "启用本插件的技能" })).toBeEnabled();
  });
});

/* ------------------------------------------------ 插件（并入插件 Tab，d.123） */

describe("PluginsPage · 插件（原桌面小组件 Tab）", () => {
  it("插件并入「插件」Tab 末尾，不再单独占 Tab；浏览器里给「仅桌面端可用」", () => {
    delete window.__heming_widgets;
    renderPage();
    // 不再有「桌面小组件」Tab，只剩三 Tab
    expect(screen.queryByRole("tab", { name: "桌面小组件" })).toBeNull();
    expect(screen.getByRole("tab", { name: "插件" })).toHaveAttribute("aria-selected", "true");
    // 内容直接出现在插件 Tab：有一段插件区域 + 它的浏览器降级提示
    const section = screen.getByRole("region", { name: "插件" });
    expect(within(section).getByRole("region", { name: "桌面小组件" })).toHaveTextContent(
      /插件需要桌面窗口能力/,
    );
    // 插件的安装入口（与声明式「安装插件」不是同一个按钮）
    expect(within(section).queryByRole("button", { name: /安装桌面小组件/ })).toBeNull();
  });
});

/* ------------------------------------------------ 插件健康与修复（d.113） */

describe("PluginsPage · 插件健康修复（d.113）", () => {
  it("broken 单元显示损坏徽标与「修复记录」；修复后摘掉悬空引用并进消息条", () => {
    store.install(manifest());
    const pluginId = "acme.finance";
    const installed = store.get(pluginId)!;
    // 制造损坏：记录声称的技能全部悬空（模拟被 LRU 淘汰/手工删除）
    for (const skillId of installed.skillIds) pool.remove(skillId);

    renderPage();

    expect(screen.getByLabelText("健康度 损坏")).toBeInTheDocument();
    // 诊断区同样列出问题（悬空技能）
    expect(screen.getByRole("region", { name: "能力单元诊断" })).toHaveTextContent(
      /技能引用悬空/,
    );
    fireEvent.click(screen.getByRole("button", { name: "修复记录 财务助手包" }));

    expect(screen.getByRole("status")).toHaveTextContent("财务助手包");
    expect(screen.getByRole("status")).toHaveTextContent("摘掉 2 条悬空引用");
    // 只摘记录里的悬空引用，不动技能池（技能本来就是测试里删掉的，修复不应复活血）
    expect(store.get(pluginId)!.skillIds).toEqual([]);
    expect(store.get(pluginId)!.serverIds).toEqual([]);
    expect(pool.list().filter((skill) => skill.pluginId === pluginId)).toEqual([]);
    expect(store.health(pluginId)!.level).not.toBe("broken");
  });

  it("修复写失败：消息条如实提示「修复失败」并回滚记录", () => {
    // 独立存储：安装完成后让 PLUGINS_KEY 的写入开始抛错（模拟配额满）
    const map = new Map<string, string>();
    let failPlugins = false;
    const storage: StorageLike = {
      getItem: (key) => (map.has(key) ? (map.get(key) as string) : null),
      setItem: (key, value) => {
        if (failPlugins && key === PLUGINS_KEY) throw new Error("QuotaExceededError");
        map.set(key, value);
      },
      removeItem: (key) => void map.delete(key),
    };
    const failingPool = new SkillPool(storage, () => T0);
    const failingMcp = fakeMcp();
    const failingStore = new PluginStore(storage, failingPool, () => T0, failingMcp.port);
    failingStore.install(manifest());
    const pluginId = "acme.finance";
    for (const skillId of failingStore.get(pluginId)!.skillIds) failingPool.remove(skillId);
    failPlugins = true;
    render(<PluginsPage plugins={failingStore} skills={failingPool} mcp={registry} />);

    fireEvent.click(screen.getByRole("button", { name: "修复记录 财务助手包" }));

    expect(screen.getByRole("status")).toHaveTextContent(/修复失败/);
    // 回滚后记录仍是修复前的悬空状态（没有半修）
    expect(failingStore.get(pluginId)!.skillIds).toHaveLength(2);
  });
});

/* ------------------------------------------------ 插件页面入口（d.124） */

describe("PluginsPage · 插件页面入口", () => {
  /** v5 声明式插件 + 一个页面（页面内容本身由 PluginDeclarativePage 的用例覆盖）。 */
  function pageManifest(): Record<string, unknown> {
    return {
      schemaVersion: 5,
      id: "acme.collector",
      name: "采集桥",
      version: "1.0.0",
      description: "本机采集服务状态与用法",
      author: "Acme",
      engines: { heming: "d.100" },
      permissions: { network: [], tools: "read", files: [] },
      contributions: {
        page: {
          title: "采集桥",
          icon: "activity",
          summary: "本机采集服务状态与用法",
          blocks: [{ type: "markdown", text: "本机采集服务状态。" }],
        },
        skills: [{ name: "整理采集结果", instructions: "把采集结果整理成列表。" }],
      },
    };
  }

  function installManifest(m: Record<string, unknown>): void {
    fireEvent.click(screen.getByRole("button", { name: "手动粘贴清单" }));
    fireEvent.change(screen.getByLabelText("插件清单 JSON"), {
      target: { value: JSON.stringify(m) },
    });
    fireEvent.click(screen.getByRole("button", { name: "确认安装" }));
  }

  it("卡片显示「页面 1」贡献行与「打开页面」，点击跳到 plugin:<id>", () => {
    renderPage();
    installManifest(pageManifest());

    const card = screen.getByRole("region", { name: "插件 采集桥" });
    expect(card).toHaveTextContent("页面 1");
    fireEvent.click(within(card).getByRole("button", { name: "打开插件页面 采集桥" }));
    expect(useUiStore.getState().page).toBe("plugin:acme.collector");
  });

  it("详情弹窗显示「页面」贡献行与「打开页面」，点击关闭弹窗并跳转", () => {
    renderPage();
    installManifest(pageManifest());
    fireEvent.click(screen.getByRole("button", { name: "查看插件详情 采集桥" }));

    const dialog = screen.getByRole("dialog", { name: "插件详情 采集桥" });
    expect(within(dialog).getByText("页面")).toBeInTheDocument();
    fireEvent.click(within(dialog).getByRole("button", { name: "打开插件页面" }));

    expect(useUiStore.getState().page).toBe("plugin:acme.collector");
    expect(screen.queryByRole("dialog", { name: "插件详情 采集桥" })).toBeNull();
  });

  it("没有声明页面的旧插件行为不变：没有页面贡献行，也没有打开页面入口", () => {
    renderPage();
    installNow();

    const card = screen.getByRole("region", { name: "插件 财务助手包" });
    expect(card).not.toHaveTextContent("页面 1");
    expect(within(card).queryByRole("button", { name: /打开插件页面/ })).toBeNull();
    expect(screen.queryByRole("button", { name: /打开插件页面/ })).toBeNull();
  });

  it("插件停用：页面入口不渲染（可用性由注册表统一判定）", () => {
    renderPage();
    installManifest(pageManifest());
    fireEvent.click(screen.getByRole("switch", { name: "启用插件 采集桥" }));

    const card = screen.getByRole("region", { name: "插件 采集桥" });
    // 停用是「现在不生效」，贡献行照常显示页面，但不给可点的入口
    expect(card).toHaveTextContent("页面 1");
    expect(within(card).queryByRole("button", { name: /打开插件页面/ })).toBeNull();
  });
});
