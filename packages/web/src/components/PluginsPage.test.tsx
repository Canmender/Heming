import { describe, it, expect, beforeEach, vi } from "vitest";
import { render, screen, fireEvent, within } from "@testing-library/react";
import { PluginsPage } from "./PluginsPage.js";
import { PluginStore, pluginServerId, type PluginMcpPort } from "../lib/plugins/index.js";
import { SkillPool, type StorageLike } from "../lib/skills/index.js";
import { McpRegistry, type McpServerConfig } from "../lib/mcp/index.js";
import { useUiStore } from "../store/ui.js";

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

    // d.67：接口区已并入本页「MCP 服务」Tab，按钮变成切 Tab，不再跨页
    fireEvent.click(within(card).getByRole("button", { name: "查看插件接口 财务助手包" }));
    expect(useUiStore.getState().page).toBe("home");
    expect(screen.getByRole("tab", { name: "MCP 服务" })).toHaveAttribute("aria-selected", "true");

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
    expect(within(dialog).getByText(/连接与工具授权在接口区进行/)).toBeInTheDocument();

    // d.67：不再跳接口区页，改为切到本页「MCP 服务」Tab
    fireEvent.click(within(dialog).getByRole("button", { name: "查看接口" }));
    expect(useUiStore.getState().page).toBe("home");
    expect(screen.getByRole("tab", { name: "MCP 服务" })).toHaveAttribute("aria-selected", "true");
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
  it("四个 Tab：技能与 MCP 渲染完整视图，页面级标题始终只有一个", () => {
    renderPage();
    expect(screen.getAllByRole("heading", { level: 1 })).toHaveLength(1);
    expect(screen.getByRole("heading", { level: 1 })).toHaveTextContent("插件区");
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

    fireEvent.click(screen.getByRole("tab", { name: "MCP 服务" }));
    expect(screen.getByRole("tab", { name: "MCP 服务" })).toHaveAttribute("aria-selected", "true");
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
    expect(screen.getByRole("tab", { name: "MCP 服务" })).toHaveAttribute("aria-selected", "true");
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
