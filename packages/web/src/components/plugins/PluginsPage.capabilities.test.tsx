import { describe, it, expect, beforeEach, vi } from "vitest";
import { act, fireEvent, render, screen, within } from "@testing-library/react";
import { PluginsPage } from "../PluginsPage.js";
import {
  base64UrlEncode,
  describeCapabilityCatalog,
  PluginStore,
  PublisherTrustStore,
  type CapabilityCatalog,
  type CapabilitySnapshot,
  type PluginMcpPort,
  type PluginManifest,
  type SignatureCheck,
  type SystemPlugin,
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
/** 签名相关夹具：Ed25519 公钥 32B、签名 64B（内容真假由注入的 verify 决定）。 */
const PUB_KEY = base64UrlEncode(new Uint8Array(32).fill(7));
const OTHER_PUB_KEY = base64UrlEncode(new Uint8Array(32).fill(3));
const SIG_VALUE = base64UrlEncode(new Uint8Array(64).fill(9));
const FP = "sha256:0123456789abcdef";

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
      toolPacks: [
        {
          id: "report-tools",
          name: "报告工具",
          description: "周报要用的查询工具",
          tools: ["weather_query", "report_export"],
        },
      ],
    },
    ...overrides,
  };
}

/** 带签名的 v3 清单（发布者 acme；验签结果由注入的 verify 决定）。 */
function signedManifest(overrides: Record<string, unknown> = {}): Record<string, unknown> {
  return v3Manifest({
    publisher: { id: "acme", publicKey: PUB_KEY },
    signature: { alg: "ed25519", value: SIG_VALUE },
    ...overrides,
  });
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
        ownerKind: "system",
        ownerId: "charts",
        ownerLabel: "系统能力",
        risk: "read",
        enabled: true,
        editable: false,
      },
      {
        name: "chart_export",
        description: "导出图表",
        ownerKind: "system",
        ownerId: "charts",
        ownerLabel: "系统能力",
        risk: "read",
        enabled: true,
        editable: false,
      },
      {
        name: "tone_apply",
        description: "语气改写",
        ownerKind: "system",
        ownerId: "tone",
        ownerLabel: "系统能力",
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
    counts: { system: 3, mcp: 1, plugin: 1, self: 0, enabled: 4 },
    blocked: [
      {
        name: "dangerous_write",
        ownerLabel: "报告工具箱",
        risk: "write",
        pluginId: "acme.report-kit",
      },
    ],
    toolPacks: [
      {
        id: "report-tools",
        pluginId: "acme.report-kit",
        pluginName: "报告工具箱",
        name: "报告工具",
        description: "周报要用的查询工具",
        tools: ["weather_query", "manual_echo", "report_export"],
        matched: ["weather_query", "manual_echo"],
        unresolved: ["report_export"],
        entries: [
          {
            tool: "weather_query",
            serverId: "plugin:acme.report-kit:report",
            enabled: false,
            risk: "read",
          },
          { tool: "manual_echo", serverId: "mcp-manual", enabled: true, risk: "write" },
        ],
        enabled: true,
      },
    ],
  };
}

/** 固定系统插件（与 fixedCatalog 的内置工具数量对齐：3 个）。 */
function fixedSystem(): SystemPlugin {
  return {
    id: "heming.core",
    name: "系统能力",
    version: "1.0.0",
    description: "随应用内置的技能、预置服务与工具",
    pinned: true,
    uninstallable: false,
    enabled: true,
    contributions: {
      skills: [
        { id: "builtin:1", name: "通用问答", description: "", enabled: true },
        { id: "builtin:2", name: "总结", description: "", enabled: true },
      ],
      servers: [
        { id: "mcp-windows-desktop", name: "Windows 桌面", url: "http://127.0.0.1:9999/mcp", enabled: true, preset: true },
      ],
      tools: [
        { name: "chart_render", description: "画图", risk: "read" },
        { name: "chart_export", description: "导出图表", risk: "read" },
        { name: "tone_apply", description: "语气改写", risk: "write" },
      ],
      commands: [],
    },
    counts: { skills: 2, servers: 1, tools: 3, commands: 0 },
  };
}

/** 固定能力快照：统计卡读 byKind，插件页读 system。 */
function fixedCapabilities(catalog: CapabilityCatalog = fixedCatalog()): CapabilitySnapshot {
  const system = fixedSystem();
  return {
    descriptors: [],
    counts: {
      total: 0,
      enabled: 0,
      byKind: { skill: 6, tool: catalog.tools.length, mcp: 4, command: 0 },
      byOwner: { system: 0, plugin: 0, mcp: 0 },
      systemPlugin: {
        installed: 1,
        skills: system.counts.skills,
        tools: system.counts.tools,
        servers: system.counts.servers,
      },
    },
    system,
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
    isPreset: (id: string) => id === "mcp-windows-desktop",
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

let storage: StorageLike;
let publishers: PublisherTrustStore;
let pool: SkillPool;
let store: PluginStore;
let mcp: ReturnType<typeof fakeMcp>;
let registry: ReturnType<typeof fakeRegistry>;

beforeEach(() => {
  storage = makeStorage();
  pool = new SkillPool(storage, () => T0);
  mcp = fakeMcp();
  publishers = new PublisherTrustStore(storage);
  store = new PluginStore(storage, pool, () => T0, mcp.port, publishers);
  registry = fakeRegistry();
  useUiStore.setState({ page: "home" });
});

type RenderOverrides = {
  catalog?: CapabilityCatalog;
  capabilities?: CapabilitySnapshot;
  verify?: (manifest: PluginManifest) => Promise<SignatureCheck>;
  fingerprintOf?: (publicKey: string) => Promise<string>;
};

function renderPage(agents: readonly AgentLite[] = [], overrides: RenderOverrides = {}) {
  const catalog = overrides.catalog ?? fixedCatalog();
  const capabilities = overrides.capabilities ?? fixedCapabilities(catalog);
  return render(
    <PluginsPage
      plugins={store}
      skills={pool}
      mcp={registry}
      catalog={catalog}
      capabilities={capabilities}
      publishers={publishers}
      verify={overrides.verify ?? (async (manifest) => (manifest.signature ? { status: "valid" } : { status: "none" }))}
      fingerprintOf={overrides.fingerprintOf ?? (async () => FP)}
      agents={agents}
    />,
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
    const expected = describeCapabilityStats({ plugins: store, capabilities: fixedCapabilities() });
    expect(expected.system).toBe(1);
    expect(expected.plugins).toBe(1);
    expect(expected.skills).toBe(6);
    expect(expected.tools).toBe(5);
    expect(expected.mcpServers).toBe(4);

    // 插件卡是一句「系统 + 已装」，不是单独的已装数
    expect(screen.getByLabelText("统计 插件")).toHaveTextContent("1 + 1");
    for (const [label, value] of [
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
    expect(screen.getByRole("region", { name: "工具分组 系统能力" })).toBeInTheDocument();

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

    expect(screen.getByRole("region", { name: "工具分组 系统能力" })).toHaveTextContent("系统能力（3）");
    expect(screen.getByRole("region", { name: "工具分组 MCP 服务" })).toHaveTextContent("MCP 服务（1）");
    expect(screen.getByRole("region", { name: "工具分组 插件工具" })).toHaveTextContent(
      "插件工具（1）",
    );
    expect(screen.getAllByText("weather_query").length).toBeGreaterThan(0);
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


describe("插件页 · 系统能力卡（d.65）", () => {
  it("插件 Tab 顶部固定系统卡：名称/内置标记/贡献计数，且没有开关与卸载", () => {
    installV3();
    renderPage();
    const card = screen.getByTestId("system-plugin-card");
    expect(card).toHaveTextContent("系统能力");
    expect(card).toHaveTextContent("内置");
    expect(card).toHaveTextContent("技能 2");
    expect(card).toHaveTextContent("服务 1");
    expect(card).toHaveTextContent("工具 3");
    expect(card).toHaveTextContent("随应用内置，不可停用或卸载");
    // 只读：没有启用开关、没有卸载/停用按钮
    expect(within(card).queryByRole("switch")).toBeNull();
    expect(within(card).queryByRole("button")).toBeNull();
    expect(within(card).queryByRole("button", { name: /卸载/ })).toBeNull();
  });

  it("系统卡排在已装插件卡之前", () => {
    installV3();
    renderPage();
    const system = screen.getByTestId("system-plugin-card");
    const plugin = screen.getByRole("region", { name: "插件 报告工具箱" });
    // DOM 顺序：系统卡在前
    expect(system.compareDocumentPosition(plugin) & Node.DOCUMENT_POSITION_FOLLOWING).toBeTruthy();
  });
});

describe("插件页 · 工具束（d.65）", () => {
  it("工具 Tab 展示工具束：matched 工具 + unresolved 标注", () => {
    installV3();
    renderPage();
    fireEvent.click(screen.getByRole("tab", { name: "工具" }));

    const section = screen.getByRole("region", { name: "工具束" });
    expect(section).toHaveTextContent("报告工具箱");
    expect(section).toHaveTextContent("报告工具");
    expect(section).toHaveTextContent("已匹配 2/3");
    expect(section).toHaveTextContent("weather_query");
    expect(section).toHaveTextContent("report_export · 未连接/未提供");
  });

  it("插件停用时工具束仍展示归属，并标注「插件已停用」", () => {
    installV3();
    const catalog = fixedCatalog();
    catalog.toolPacks = catalog.toolPacks.map((pack) => ({ ...pack, enabled: false }));
    renderPage([], { catalog, capabilities: fixedCapabilities(catalog) });
    fireEvent.click(screen.getByRole("tab", { name: "工具" }));

    const section = screen.getByRole("region", { name: "工具束" });
    expect(section).toHaveTextContent("插件已停用");
    expect(section).toHaveTextContent("报告工具");
  });

  it("安装预览贡献行包含「工具束 1 · 工具 2」", () => {
    renderPage();
    const dialog = openInstall();
    fireEvent.change(within(dialog).getByLabelText("插件清单 JSON"), {
      target: { value: JSON.stringify(v3Manifest()) },
    });
    expect(within(dialog).getByText(/工具束 1 · 工具 2/)).toBeInTheDocument();
  });

  it("详情抽屉有「工具束」段：工具列表 + 在接口区管理跳转", () => {
    installV3();
    renderPage();
    fireEvent.click(screen.getByRole("button", { name: "查看插件详情 报告工具箱" }));
    const dialog = screen.getByRole("dialog", { name: "插件详情 报告工具箱" });
    const section = within(dialog).getByRole("region", { name: "插件工具束" });
    expect(section).toHaveTextContent("工具束（1）");
    expect(section).toHaveTextContent("报告工具");
    expect(section).toHaveTextContent("weather_query");
    expect(section).toHaveTextContent("report_export");
    expect(section).toHaveTextContent("未连接/未提供");

    const manageButtons = within(section).getAllByRole("button", { name: "在接口区管理" });
    expect(manageButtons.length).toBeGreaterThan(0);
    fireEvent.click(manageButtons[manageButtons.length - 1]!);
    expect(useUiStore.getState().page).toBe("interfaces");
  });
});


/* ------------------------------------------------- 安装信任（d.66 · §2.3） */

describe("插件页 · 安装信任行", () => {
  it("首次安装：显示内容指纹与「首次安装」，无覆盖勾选框", () => {
    renderPage();
    const dialog = openInstall();
    fireEvent.change(within(dialog).getByLabelText("插件清单 JSON"), {
      target: { value: JSON.stringify(v3Manifest()) },
    });
    expect(within(dialog).getByText(/内容指纹 fnv1a64b:/)).toBeInTheDocument();
    expect(within(dialog).getByText("首次安装")).toBeInTheDocument();
    expect(within(dialog).queryByLabelText("我已确认这次覆盖更新")).toBeNull();
  });

  it("更新且内容相同：显示「与上次相同」，不要求勾选", () => {
    renderPage();
    installV3();
    const dialog = openInstall();
    fireEvent.change(within(dialog).getByLabelText("插件清单 JSON"), {
      target: { value: JSON.stringify(v3Manifest()) },
    });
    expect(within(dialog).getByText("与上次相同")).toBeInTheDocument();
    expect(within(dialog).queryByLabelText("我已确认这次覆盖更新")).toBeNull();
    expect(within(dialog).getByRole("button", { name: "确认更新" })).toBeEnabled();
  });

  it("同版本内容变化：标红提示 + 未勾选时确认禁用，勾选后可更新", () => {
    renderPage();
    installV3();
    const changed = v3Manifest();
    (changed.contributions as { skills: { instructions: string }[] }).skills[0]!.instructions =
      "按新模板生成周报";
    const dialog = openInstall();
    fireEvent.change(within(dialog).getByLabelText("插件清单 JSON"), {
      target: { value: JSON.stringify(changed) },
    });

    expect(within(dialog).getByText("与上次不同")).toBeInTheDocument();
    const warning = within(dialog).getByText("版本未变，但内容有变化");
    expect(warning.className).toContain("text-[#b42318]");

    const confirm = within(dialog).getByRole("button", { name: "确认更新" });
    expect(confirm).toBeDisabled();
    expect(confirm).toHaveAttribute("aria-describedby", "plugin-trust-confirm-hint");

    const ack = within(dialog).getByLabelText("我已确认这次覆盖更新") as HTMLInputElement;
    expect(ack.checked).toBe(false);
    fireEvent.click(ack);
    expect(within(dialog).getByRole("button", { name: "确认更新" })).toBeEnabled();

    fireEvent.click(within(dialog).getByRole("button", { name: "确认更新" }));
    expect(screen.getByRole("status")).toHaveTextContent("已更新插件「报告工具箱」");
  });

  it("作者变化：标红「作者：旧 → 新」并同样要求勾选确认", () => {
    renderPage();
    installV3();
    const moved = v3Manifest({ author: "Evil Corp" });
    const dialog = openInstall();
    fireEvent.change(within(dialog).getByLabelText("插件清单 JSON"), {
      target: { value: JSON.stringify(moved) },
    });

    const author = within(dialog).getByText("作者：ACME → Evil Corp");
    expect(author.className).toContain("text-[#b42318]");
    expect(within(dialog).getByRole("button", { name: "确认更新" })).toBeDisabled();
  });
});

/* ------------------------------------------- 工具束逐个授权（d.66 · §3） */

describe("插件页 · 工具束逐个授权", () => {
  function openDetailToolPacks() {
    installV3();
    renderPage();
    fireEvent.click(screen.getByRole("button", { name: "查看插件详情 报告工具箱" }));
    const dialog = screen.getByRole("dialog", { name: "插件详情 报告工具箱" });
    return within(dialog).getByRole("region", { name: "插件工具束" });
  }

  it("本插件工具给 role=switch，非本插件工具只有「在接口区管理」", () => {
    const section = openDetailToolPacks();
    expect(section).toHaveTextContent("服务：报告服务");
    expect(section).toHaveTextContent("服务：手填服务");
    // 本插件工具：开关 aria-label 明确带工具名
    expect(
      within(section).getByRole("switch", { name: "启用工具 weather_query" }),
    ).toBeInTheDocument();
    // 非本插件工具（manual_echo 属于手填服务）不给开关
    expect(
      within(section).queryByRole("switch", { name: /manual_echo/ }),
    ).toBeNull();
    expect(within(section).getAllByRole("button", { name: "在接口区管理" }).length).toBeGreaterThan(0);
  });

  it("点击开关先弹逐个确认：风险与 HITL 说明，确认后才调用 setToolEnabled", () => {
    const section = openDetailToolPacks();
    fireEvent.click(within(section).getByRole("switch", { name: "启用工具 weather_query" }));

    const confirm = screen.getByRole("dialog", { name: "启用工具 weather_query" });
    expect(confirm).toHaveTextContent("风险：只读（read）");
    expect(confirm).toHaveTextContent("每次调用仍按 HITL 确认");
    expect(registry.setToolEnabled).not.toHaveBeenCalled();

    // 取消不写
    fireEvent.click(within(confirm).getByRole("button", { name: "取消" }));
    expect(registry.setToolEnabled).not.toHaveBeenCalled();

    // 再点开关 → 确认 → 写到接口区同源开关
    fireEvent.click(within(section).getByRole("switch", { name: "启用工具 weather_query" }));
    fireEvent.click(
      within(screen.getByRole("dialog", { name: "启用工具 weather_query" })).getByRole("button", {
        name: "启用",
      }),
    );
    expect(registry.setToolEnabled).toHaveBeenCalledWith(
      "plugin:acme.report-kit:report",
      "weather_query",
      true,
    );
  });

  it("未匹配工具显示「未连接/未提供」且开关禁用；无批量按钮", () => {
    const section = openDetailToolPacks();
    expect(section).toHaveTextContent("report_export");
    expect(section).toHaveTextContent("未连接/未提供");
    const unresolvedSwitch = within(section).getByRole("switch", {
      name: "启用工具 report_export",
    });
    expect(unresolvedSwitch).toBeDisabled();
    // 红线：没有「全部启用/全部停用」入口
    expect(within(section).queryByRole("button", { name: /全部/ })).toBeNull();
  });

  it("插件停用时本插件工具的开关禁用，并注明不可操作", () => {
    installV3();
    store.setEnabled("acme.report-kit", false);
    renderPage();
    fireEvent.click(screen.getByRole("button", { name: "查看插件详情 报告工具箱" }));
    const dialog = screen.getByRole("dialog", { name: "插件详情 报告工具箱" });
    const section = within(dialog).getByRole("region", { name: "插件工具束" });
    expect(section).toHaveTextContent("插件已停用");
    expect(within(section).getByRole("switch", { name: "启用工具 weather_query" })).toBeDisabled();
  });
});


/* --------------------------------------- 签名与发布者信任（d.67 · §1） */

describe("插件页 · 签名与发布者信任", () => {
  it("未签名清单：显示「未签名」，无发布者与信任勾选，可直接装", async () => {
    renderPage();
    const dialog = openInstall();
    fireEvent.change(within(dialog).getByLabelText("插件清单 JSON"), {
      target: { value: JSON.stringify(v3Manifest()) },
    });
    expect(await within(dialog).findByText("未签名")).toBeInTheDocument();
    expect(within(dialog).queryByText(/发布者：/)).toBeNull();
    expect(within(dialog).queryByLabelText(/我信任发布者/)).toBeNull();
    expect(within(dialog).getByRole("button", { name: "确认安装" })).toBeEnabled();
  });

  it("有效签名 + 首次信任：显示发布者指纹；未勾选禁用，勾选后安装并写入信任表", async () => {
    renderPage();
    const dialog = openInstall();
    fireEvent.change(within(dialog).getByLabelText("插件清单 JSON"), {
      target: { value: JSON.stringify(signedManifest()) },
    });

    expect(await within(dialog).findByText("有效")).toBeInTheDocument();
    expect(within(dialog).getByText(/发布者：acme · sha256:01234567…/)).toBeInTheDocument();

    const trustBox = within(dialog).getByLabelText("我信任发布者 acme 的公钥") as HTMLInputElement;
    expect(trustBox.checked).toBe(false);
    const confirm = within(dialog).getByRole("button", { name: "确认安装" });
    expect(confirm).toBeDisabled();
    expect(confirm).toHaveAttribute("aria-describedby", expect.stringContaining("plugin-install-requirements"));

    fireEvent.click(trustBox);
    expect(within(dialog).getByRole("button", { name: "确认安装" })).toBeEnabled();
    fireEvent.click(within(dialog).getByRole("button", { name: "确认安装" }));

    const installed = store.get("acme.report-kit")!;
    expect(installed.publisher).toEqual({ id: "acme", fingerprint: FP });
    expect(installed.signature).toEqual({ status: "valid", alg: "ed25519" });
    expect(publishers.get("acme")?.fingerprint).toBe(FP);
  });

  it("无效签名：红字拒绝安装，且没有任何绕过入口（信任勾选都不给）", async () => {
    renderPage([], {
      verify: async () => ({ status: "invalid", reason: "签名与清单内容不匹配" }),
    });
    const dialog = openInstall();
    fireEvent.change(within(dialog).getByLabelText("插件清单 JSON"), {
      target: { value: JSON.stringify(signedManifest()) },
    });

    expect(await within(dialog).findByText("无效")).toBeInTheDocument();
    expect(within(dialog).getByText("签名与清单内容不匹配，已拒绝安装。")).toBeInTheDocument();
    // 无效签名没有「可以信任的公钥结论」→ 不出现信任勾选，避免用户以为勾了就能装
    expect(within(dialog).queryByLabelText("我信任发布者 acme 的公钥")).toBeNull();
    expect(within(dialog).getByRole("button", { name: "确认安装" })).toBeDisabled();
    // 红线：没有「忽略/仍然安装」之类绕过入口
    expect(within(dialog).queryByRole("button", { name: /仍然安装|忽略|强制/ })).toBeNull();
    expect(store.list()).toEqual([]);
  });

  it("环境不支持：明说不代表验过、不算无效、不要求信任勾选，可直接装且不写信任表", async () => {
    renderPage([], {
      verify: async () => ({ status: "unsupported", reason: "当前环境不支持 WebCrypto" }),
      fingerprintOf: async () => {
        throw new Error("当前环境不支持 WebCrypto，无法计算公钥指纹");
      },
    });
    const dialog = openInstall();
    fireEvent.change(within(dialog).getByLabelText("插件清单 JSON"), {
      target: { value: JSON.stringify(signedManifest()) },
    });

    expect(await within(dialog).findByText("环境不支持")).toBeInTheDocument();
    expect(within(dialog).getByText(/当前环境不支持 WebCrypto/)).toBeInTheDocument();
    // 指纹算不出来不能把结论篡改成「无效」，也不能要求用户信任一个没有指纹的公钥
    expect(within(dialog).queryByText("无效")).toBeNull();
    expect(within(dialog).getByText(/指纹不可用/)).toBeInTheDocument();
    expect(within(dialog).queryByLabelText("我信任发布者 acme 的公钥")).toBeNull();

    fireEvent.click(within(dialog).getByRole("button", { name: "确认安装" }));
    expect(store.get("acme.report-kit")!.signature?.status).toBe("unsupported");
    expect(store.get("acme.report-kit")!.publisher).toBeNull();
    expect(publishers.get("acme")).toBeUndefined();
  });

  it("验签有效但指纹算不出来：仍显示有效、可装，只是不记录发布者信任", async () => {
    renderPage([], {
      verify: async () => ({ status: "valid" }),
      fingerprintOf: async () => {
        throw new Error("环境不支持指纹");
      },
    });
    const dialog = openInstall();
    fireEvent.change(within(dialog).getByLabelText("插件清单 JSON"), {
      target: { value: JSON.stringify(signedManifest()) },
    });

    expect(await within(dialog).findByText("有效")).toBeInTheDocument();
    expect(within(dialog).getByText(/指纹不可用/)).toBeInTheDocument();
    fireEvent.click(within(dialog).getByLabelText("我信任发布者 acme 的公钥"));
    fireEvent.click(within(dialog).getByRole("button", { name: "确认安装" }));
    expect(store.get("acme.report-kit")!.signature?.status).toBe("valid");
    expect(store.get("acme.report-kit")!.publisher).toBeNull();
    expect(publishers.get("acme")).toBeUndefined();
  });

  it("验签中：确认按钮禁用，完成后放行", async () => {
    let resolveCheck!: (check: SignatureCheck) => void;
    const pending = new Promise<SignatureCheck>((resolve) => {
      resolveCheck = resolve;
    });
    renderPage([], { verify: () => pending });
    const dialog = openInstall();
    fireEvent.change(within(dialog).getByLabelText("插件清单 JSON"), {
      target: { value: JSON.stringify(signedManifest()) },
    });

    expect(within(dialog).getByText("校验中…")).toBeInTheDocument();
    expect(within(dialog).getByRole("button", { name: "确认安装" })).toBeDisabled();

    await act(async () => {
      resolveCheck({ status: "valid" });
    });
    expect(await within(dialog).findByText("有效")).toBeInTheDocument();
    fireEvent.click(within(dialog).getByLabelText("我信任发布者 acme 的公钥"));
    expect(within(dialog).getByRole("button", { name: "确认安装" })).toBeEnabled();
  });

  it("同 id 公钥变更：红字提示换钥，核对勾选后才可装", async () => {
    publishers.remember({ id: "acme", publicKey: OTHER_PUB_KEY, fingerprint: "sha256:deadbeefdeadbeef" });
    renderPage();
    const dialog = openInstall();
    fireEvent.change(within(dialog).getByLabelText("插件清单 JSON"), {
      target: { value: JSON.stringify(signedManifest()) },
    });

    expect(await within(dialog).findByText("有效")).toBeInTheDocument();
    expect(within(dialog).getByText(/发布者公钥已变更/)).toBeInTheDocument();
    // 发布者已信任：不应再出现首次信任勾选
    expect(within(dialog).queryByLabelText(/我信任发布者/)).toBeNull();

    const ack = within(dialog).getByLabelText("我已核对发布者公钥变更");
    expect(within(dialog).getByRole("button", { name: "确认安装" })).toBeDisabled();
    fireEvent.click(ack);
    expect(within(dialog).getByRole("button", { name: "确认安装" })).toBeEnabled();
    fireEvent.click(within(dialog).getByRole("button", { name: "确认安装" }));
    expect(publishers.get("acme")?.fingerprint).toBe(FP);
  });
});

/* ----------------------------------------- 贡献级停用（d.67 · §2） */

describe("插件页 · 贡献级停用", () => {
  function openContributionSection() {
    installV3();
    renderPage();
    fireEvent.click(screen.getByRole("button", { name: "查看插件详情 报告工具箱" }));
    const dialog = screen.getByRole("dialog", { name: "插件详情 报告工具箱" });
    return within(dialog).getByRole("region", { name: "插件贡献" });
  }

  it("四类各一行开关；切换技能只写 disabledKinds 并作用到技能池", () => {
    const section = openContributionSection();
    for (const label of ["技能", "服务", "命令", "工具束"]) {
      expect(within(section).getByRole("switch", { name: `启用本插件的${label}` })).toBeInTheDocument();
    }
    // 红线：没有全选/全不选
    expect(within(section).queryByRole("button", { name: /全部/ })).toBeNull();

    fireEvent.click(within(section).getByRole("switch", { name: "启用本插件的技能" }));
    expect(store.get("acme.report-kit")!.disabledKinds).toEqual(["skills"]);
    expect(within(section).getByRole("switch", { name: "启用本插件的技能" })).toHaveAttribute(
      "aria-checked",
      "false",
    );
    expect(pool.list().filter((skill) => skill.pluginId).every((skill) => !skill.enabled)).toBe(true);
  });

  it("切换服务调用接口区同源开关（mcp.update）", () => {
    const section = openContributionSection();
    fireEvent.click(within(section).getByRole("switch", { name: "启用本插件的服务" }));
    expect(store.get("acme.report-kit")!.disabledKinds).toEqual(["mcpServers"]);
    // 真实写入口是 PluginStore 注入的 MCP 端口（与接口区同一份注册表）
    expect(mcp.servers.get("plugin:acme.report-kit:report")?.enabled).toBe(false);
  });

  it("主开关关闭时四类开关禁用并注明", () => {
    installV3();
    store.setEnabled("acme.report-kit", false);
    renderPage();
    fireEvent.click(screen.getByRole("button", { name: "查看插件详情 报告工具箱" }));
    const dialog = screen.getByRole("dialog", { name: "插件详情 报告工具箱" });
    const section = within(dialog).getByRole("region", { name: "插件贡献" });
    expect(section).toHaveTextContent("主开关已关闭");
    expect(within(section).getByRole("switch", { name: "启用本插件的技能" })).toBeDisabled();
  });

  it("部分停用：插件卡显示徽标并用 title 列出类别；全部启用或停用后不显示", () => {
    installV3();
    store.setKindEnabled("acme.report-kit", "skills", false);
    const first = renderPage();
    const badge = within(screen.getByRole("region", { name: "插件 报告工具箱" })).getByText("部分停用");
    expect(badge).toHaveAttribute("title", "已停用：技能");

    first.unmount();
    store.setEnabled("acme.report-kit", false);
    renderPage();
    expect(within(screen.getByRole("region", { name: "插件 报告工具箱" })).queryByText("部分停用")).toBeNull();
  });
});
