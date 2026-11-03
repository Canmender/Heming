import { describe, it, expect, beforeEach, vi } from "vitest";
import { fireEvent, render, screen, within } from "@testing-library/react";
import { PluginsPage } from "../PluginsPage.js";
import {
  describeCapabilityCatalog,
  PluginStore,
  type CapabilityCatalog,
  type PluginMcpPort,
} from "../../lib/plugins/index.js";
import { SkillPool, type StorageLike } from "../../lib/skills/index.js";
import type { McpServerConfig } from "../../lib/mcp/index.js";
import { useUiStore } from "../../store/ui.js";
import type { AgentLite, McpRegistryPort } from "./viewModel.js";
import { describeCapabilityStats, describeSkillRows } from "./viewModel.js";

/**
 * 插件页统一能力中枢（d.64 · T2）用例。
 *
 * 数据源全部注入：真实 PluginStore + SkillPool（内存存储）、假 MCP 注册表与固定能力目录，
 * 断言「四个统计数、四个 Tab、权限摘要、v3 预览、v2 旧包提示、工具分组与 blocked 标注」。
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

/** v3 清单：技能 + MCP + 命令 + 权限齐全。 */
function v3Manifest(overrides: Record<string, unknown> = {}): Record<string, unknown> {
  return {
    schemaVersion: 3,
    id: "acme.report-kit",
    name: "报告工具箱",
    version: "1.0.0",
    description: "周报与大屏数据源",
    author: "ACME",
    permissions: {
      network: ["api.acme.com", "localhost:3000"],
      tools: "read",
      files: ["reports/"],
    },
    contributions: {
      skills: [
        {
          name: "周报",
          description: "生成周报",
          instructions: "按模板生成周报",
          triggers: ["周报", "report"],
          tags: [],
        },
      ],
      mcpServers: [
        { key: "report", name: "报告服务", url: "https://api.acme.com/mcp", description: "" },
      ],
      commands: [
        {
          id: "weekly-report",
          title: "生成周报",
          description: "打开周报技能",
          keywords: ["周报"],
          target: { kind: "skill", name: "周报" },
        },
      ],
    },
    ...overrides,
  };
}

/** v2 旧包：顶层 skills/mcpServers，无 permissions。 */
function v2Manifest(): Record<string, unknown> {
  return {
    schemaVersion: 2,
    id: "acme.weather",
    name: "天气能力包",
    version: "1.0.0",
    description: "天气服务",
    author: "Acme",
    skills: [{ name: "出行建议", instructions: "结合天气出行。" }],
    mcpServers: [
      { key: "weather", name: "天气服务", url: "https://mcp.example.com/weather" },
    ],
  };
}

/** 固定能力目录：内置 3（其中 1 个写工具）、MCP 1、插件 1、另有一个被拦下的写工具。 */
function fixedCatalog(): CapabilityCatalog {
  return {
    tools: [
      {
        name: "chart_render",
        description: "画图",
        ownerKind: "builtin",
        ownerId: "charts",
        ownerLabel: "内置",
        risk: "read",
        enabled: true,
        editable: false,
      },
      {
        name: "chart_export",
        description: "导出图表",
        ownerKind: "builtin",
        ownerId: "charts",
        ownerLabel: "内置",
        risk: "read",
        enabled: true,
        editable: false,
      },
      {
        name: "tone_apply",
        description: "语气改写",
        ownerKind: "builtin",
        ownerId: "tone",
        ownerLabel: "内置",
        risk: "write",
        enabled: true,
        editable: false,
      },
      {
        name: "weather_query",
        description: "查天气",
        ownerKind: "plugin",
        ownerId: "plugin:acme.report-kit:report",
        ownerLabel: "报告工具箱",
        pluginId: "acme.report-kit",
        serverId: "plugin:acme.report-kit:report",
        risk: "read",
        enabled: true,
        editable: true,
      },
      {
        name: "manual_echo",
        description: "手填服务",
        ownerKind: "mcp",
        ownerId: "mcp-manual",
        ownerLabel: "手填服务",
        serverId: "mcp-manual",
        risk: "read",
        enabled: false,
        editable: true,
      },
    ],
    counts: { builtin: 3, mcp: 1, plugin: 1, self: 0, enabled: 4 },
    blocked: [
      {
        name: "dangerous_write",
        ownerLabel: "报告工具箱",
        risk: "write",
        pluginId: "acme.report-kit",
      },
    ],
  };
}

/** 假 MCP 注册表：一个插件服务 + 一个手工服务 + 一个预置服务。 */
function fakeRegistry(): McpRegistryPort & { update: ReturnType<typeof vi.fn> } {
  const servers: McpServerConfig[] = [
    {
      id: "plugin:acme.report-kit:report",
      name: "报告服务",
      transport: "http",
      url: "https://api.acme.com/mcp",
      enabled: true,
      origin: "plugin",
      createdAt: "2026-11-01T00:00:00.000Z",
      updatedAt: "2026-11-01T00:00:00.000Z",
    },
    {
      id: "mcp-manual",
      name: "手填服务",
      transport: "http",
      url: "https://manual.example.com/mcp",
      enabled: false,
      origin: "manual",
      createdAt: "2026-11-01T00:00:00.000Z",
      updatedAt: "2026-11-01T00:00:00.000Z",
    },
    {
      id: "mcp-registry-demo",
      name: "Registry 演示服务",
      transport: "http",
      url: "https://registry.example.com/mcp",
      enabled: true,
      origin: "registry",
      createdAt: "2026-11-01T00:00:00.000Z",
      updatedAt: "2026-11-01T00:00:00.000Z",
    },
    {
      id: "mcp-windows-desktop",
      name: "Windows 桌面",
      transport: "http",
      url: "http://127.0.0.1:9999/mcp",
      enabled: true,
      origin: "preset",
      createdAt: "2026-11-01T00:00:00.000Z",
      updatedAt: "2026-11-01T00:00:00.000Z",
    },
  ];
  return {
    servers: () => servers,
    tools: (serverId) =>
      serverId === "plugin:acme.report-kit:report"
        ? [{ name: "weather_query", description: "查天气" }]
        : serverId === "mcp-manual"
          ? [{ name: "manual_echo" }]
          : [],
    isToolEnabled: () => true,
    hasDiscovered: (serverId) => serverId === "plugin:acme.report-kit:report",
    setToolEnabled: vi.fn(),
    update: vi.fn((id: string, patch: { enabled?: boolean }) => {
      const server = servers.find((item) => item.id === id);
      if (server && patch.enabled !== undefined) server.enabled = patch.enabled;
      return server;
    }),
    allTools: () =>
      servers.flatMap((server) =>
        server.id === "plugin:acme.report-kit:report"
          ? []
          : [],
      ),
  };
}

let pool: SkillPool;
let store: PluginStore;
let mcp: ReturnType<typeof fakeMcp>;
let registry: ReturnType<typeof fakeRegistry>;

beforeEach(() => {
  const storage = makeStorage();
  pool = new SkillPool(storage, () => T0);
  mcp = fakeMcp();
  store = new PluginStore(storage, pool, () => T0, mcp.port);
  registry = fakeRegistry();
  useUiStore.setState({ page: "home" });
});

function renderPage(agents: readonly AgentLite[] = []) {
  return render(
    <PluginsPage plugins={store} skills={pool} mcp={registry} catalog={fixedCatalog()} agents={agents} />,
  );
}

function installV3(manifest: Record<string, unknown> = v3Manifest()) {
  const result = store.install(JSON.stringify(manifest));
  return result;
}

function openInstall() {
  fireEvent.click(screen.getByRole("button", { name: /安装插件/ }));
  return screen.getByRole("dialog", { name: "安装插件" });
}

describe("插件页 · 能力统计", () => {
  it("四个统计卡数值分别来自插件存储 / 技能池 / 能力目录 / MCP 注册表", () => {
    installV3();
    renderPage();
    const expected = describeCapabilityStats({
      plugins: store,
      skills: pool,
      catalog: fixedCatalog(),
      mcp: registry,
    });
    expect(expected.plugins).toBe(1);
    expect(expected.tools).toBe(5);
    expect(expected.mcpServers).toBe(4);

    for (const [label, value] of [
      ["已装插件", expected.plugins],
      ["技能", expected.skills],
      ["工具", expected.tools],
      ["MCP 服务", expected.mcpServers],
    ] as const) {
      expect(screen.getByLabelText(`统计 ${label}`)).toHaveTextContent(String(value));
    }
  });
});

describe("插件页 · 四个 Tab", () => {
  it("默认插件 Tab；切换后 aria-selected 与面板同步", () => {
    renderPage();
    expect(screen.getByRole("tab", { name: "插件" })).toHaveAttribute("aria-selected", "true");
    expect(screen.getByRole("tab", { name: "技能" })).toHaveAttribute("aria-selected", "false");
    expect(screen.getByRole("tabpanel")).toHaveAttribute("id", "plugins-plugins-panel");

    fireEvent.click(screen.getByRole("tab", { name: "技能" }));
    expect(screen.getByRole("tab", { name: "技能" })).toHaveAttribute("aria-selected", "true");
    expect(screen.getByRole("tabpanel")).toHaveAttribute("id", "plugins-skills-panel");
    expect(screen.getByRole("table")).toBeInTheDocument();

    fireEvent.click(screen.getByRole("tab", { name: "工具" }));
    expect(screen.getByRole("tabpanel")).toHaveAttribute("id", "plugins-tools-panel");
    expect(screen.getByRole("region", { name: "工具分组 内置工具" })).toBeInTheDocument();

    fireEvent.click(screen.getByRole("tab", { name: "MCP 服务" }));
    expect(screen.getByRole("tabpanel")).toHaveAttribute("id", "plugins-mcp-panel");
    expect(screen.getByText("报告服务")).toBeInTheDocument();
  });
});

describe("插件页 · 贡献与权限", () => {
  it("插件卡展示贡献计数与权限摘要（主机数 / 风险上限）", () => {
    installV3();
    renderPage();
    const card = screen.getByRole("region", { name: "插件 报告工具箱" });
    expect(card).toHaveTextContent("贡献：技能 1 · 服务 1 · 命令 1");
    expect(card).toHaveTextContent("权限：主机 1 · 风险上限 只读");
  });

  it("停用的插件照常显示声明贡献", () => {
    installV3();
    store.setEnabled("acme.report-kit", false);
    renderPage();
    const card = screen.getByRole("region", { name: "插件 报告工具箱" });
    expect(card).toHaveTextContent("已停用");
    expect(card).toHaveTextContent("贡献：技能 1 · 服务 1 · 命令 1");
  });

  it("v2 旧包的权限摘要明说「未声明」，不假装受新权限约束", () => {
    store.install(JSON.stringify(v2Manifest()));
    renderPage();
    const card = screen.getByRole("region", { name: "插件 天气能力包" });
    expect(card).toHaveTextContent("权限：旧版清单：未声明权限");
  });
});

describe("插件页 · 安装预览（v3）", () => {
  it("解析成功后展示 schemaVersion、贡献计数与权限清单", () => {
    renderPage();
    const dialog = openInstall();
    fireEvent.change(within(dialog).getByLabelText("插件清单 JSON"), {
      target: { value: JSON.stringify(v3Manifest()) },
    });

    expect(within(dialog).getByText("schemaVersion 3")).toBeInTheDocument();
    expect(within(dialog).getByText(/贡献：技能 1 · 服务 1 · 命令 1/)).toBeInTheDocument();
    // 权限清单：网络主机 + 共 N 项、风险上限、文件根
    expect(within(dialog).getAllByText(/api\.acme\.com/).length).toBeGreaterThan(0);
    expect(within(dialog).getByText(/共 2 项/)).toBeInTheDocument();
    expect(within(dialog).getByText(/上限 只读（写工具不注入）/)).toBeInTheDocument();
    expect(within(dialog).getAllByText(/reports\//).length).toBeGreaterThan(0);
    // 命令也作为一个贡献徽标展示
    expect(within(dialog).getByText("命令 · 生成周报")).toBeInTheDocument();

    fireEvent.click(within(dialog).getByRole("button", { name: "确认安装" }));
    expect(screen.getByRole("status")).toHaveTextContent("已安装插件「报告工具箱」");
    const card = screen.getByRole("region", { name: "插件 报告工具箱" });
    expect(card).toHaveTextContent("权限：主机 1 · 风险上限 只读");
  });

  it("v2 旧包可安装，并标注「旧版清单（v2）：未声明权限」", () => {
    renderPage();
    const dialog = openInstall();
    fireEvent.change(within(dialog).getByLabelText("插件清单 JSON"), {
      target: { value: JSON.stringify(v2Manifest()) },
    });
    expect(within(dialog).getByText(/旧版清单（v2）：未声明权限/)).toBeInTheDocument();
    // 旧包的既有口径提示仍然保留
    expect(within(dialog).getByText(/网络访问：mcp\.example\.com/)).toBeInTheDocument();

    fireEvent.click(within(dialog).getByRole("button", { name: "确认安装" }));
    expect(screen.getByRole("status")).toHaveTextContent("已安装插件「天气能力包」");
  });
});

describe("插件页 · 工具目录", () => {
  it("按归属分组，数字列与分组标题正确", () => {
    installV3();
    renderPage();
    fireEvent.click(screen.getByRole("tab", { name: "工具" }));

    expect(screen.getByRole("region", { name: "工具分组 内置工具" })).toHaveTextContent("内置工具（3）");
    expect(screen.getByRole("region", { name: "工具分组 MCP 服务" })).toHaveTextContent("MCP 服务（1）");
    expect(screen.getByRole("region", { name: "工具分组 插件工具" })).toHaveTextContent(
      "插件工具（1）",
    );
    expect(screen.getByText("weather_query")).toBeInTheDocument();
  });

  it("被插件风险上限拦下的工具以只读行标注「插件声明 read，未注入」", () => {
    installV3();
    renderPage();
    fireEvent.click(screen.getByRole("tab", { name: "工具" }));

    const blocked = screen.getByRole("region", { name: "未注入的工具" });
    expect(blocked).toHaveTextContent("dangerous_write");
    expect(blocked).toHaveTextContent("插件声明 read，未注入");
    expect(within(blocked).getByText("未注入")).toBeInTheDocument();
    // 只读行没有开关
    expect(within(blocked).queryByRole("switch")).toBeNull();
  });
});

describe("插件页 · 技能面板", () => {
  it("列出统一技能行（来源/所属插件/触发词数/使用智能体），并可跳技能区", () => {
    const result = installV3();
    const skillId = result.plugin.skillIds[0]!;
    const agents: AgentLite[] = [{ id: "a1", name: "阿和" }];
    pool.assign("a1", skillId);

    renderPage(agents);
    fireEvent.click(screen.getByRole("tab", { name: "技能" }));

    const rows = describeSkillRows(pool, store, agents);
    const row = rows.find((item) => item.id === skillId)!;
    expect(row.sourceLabel).toBe("插件");
    expect(row.pluginName).toBe("报告工具箱");
    expect(row.agentCount).toBe(1);

    expect(screen.getByText("周报")).toBeInTheDocument();
    const table = screen.getByRole("table");
    expect(table).toHaveTextContent("报告工具箱");
    expect(table).toHaveTextContent("2");

    fireEvent.click(screen.getByRole("button", { name: "在技能区管理 周报" }));
    expect(useUiStore.getState().page).toBe("skills");
  });
});

describe("插件页 · MCP 服务面板", () => {
  it("列出来源与工具数，插件服务可跳详情，行内可跳接口区", () => {
    installV3();
    renderPage();
    fireEvent.click(screen.getByRole("tab", { name: "MCP 服务" }));

    const table = screen.getByRole("table");
    expect(table).toHaveTextContent("报告服务");
    expect(table).toHaveTextContent("插件 · 报告工具箱");
    expect(table).toHaveTextContent("Registry");
    expect(table).toHaveTextContent("预置");
    expect(table).toHaveTextContent("已连接");

    fireEvent.click(screen.getByRole("button", { name: "查看插件 报告工具箱" }));
    expect(screen.getByRole("dialog", { name: "插件详情 报告工具箱" })).toBeInTheDocument();
    fireEvent.click(screen.getByRole("button", { name: "关闭插件详情" }));

    fireEvent.click(screen.getByRole("tab", { name: "MCP 服务" }));
    fireEvent.click(screen.getByRole("button", { name: "在接口区管理 报告服务" }));
    expect(useUiStore.getState().page).toBe("interfaces");
  });
});

describe("插件页 · 详情权限/贡献段", () => {
  it("详情抽屉补「贡献」与「权限」两段", () => {
    installV3();
    renderPage();
    fireEvent.click(screen.getByRole("button", { name: "查看插件详情 报告工具箱" }));
    const dialog = screen.getByRole("dialog", { name: "插件详情 报告工具箱" });
    const contribution = within(dialog).getByRole("region", { name: "插件贡献" });
    expect(contribution).toHaveTextContent("贡献");
    expect(contribution).toHaveTextContent("技能 1 · 服务 1 · 命令 1");
    const permission = within(dialog).getByRole("region", { name: "插件权限" });
    expect(permission).toHaveTextContent("上限 只读（写工具不注入）");
    expect(permission).toHaveTextContent("api.acme.com");
  });
});

describe("插件页 · 目录与统计口径自测", () => {
  it("fixedCatalog 与真实 describeCapabilityCatalog 的形状一致（可被目录消费）", () => {
    const catalog = fixedCatalog();
    const viaReal = describeCapabilityCatalog({
      plugins: store,
      mcp: registry,
      providers: [],
    });
    // 真实目录在没有 provider/mcp 工具时为空，但形状字段必须齐全
    expect(Array.isArray(viaReal.tools)).toBe(true);
    expect(viaReal.counts).toHaveProperty("enabled");
    expect(catalog.tools).toHaveLength(5);
  });
});
