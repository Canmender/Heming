import { describe, it, expect, beforeEach, afterEach, vi } from "vitest";
import { render, screen, within, fireEvent, cleanup } from "@testing-library/react";
import type { InstalledPlugin, PluginManifest } from "../../lib/plugins/index.js";
import { PluginStore } from "../../lib/plugins/index.js";
import { SkillPool, type StorageLike } from "../../lib/skills/index.js";
import { useUiStore } from "../../store/ui.js";
import { PluginDeclarativePage } from "./PluginDeclarativePage.js";

/**
 * 声明式插件页面（d.124 A 路径）用例。
 *
 * 数据链路尽量走真实 `PluginStore`：清单从 JSON 解析、页面块由 shared 的 v5 校验器
 * 收成契约形状——这样测的是「装进来的页面长什么样」，而不是测试自己手搓的对象。
 * 只有「坏块容错」一例直接注入被改坏的记录（正常解析器不可能产出非法块）。
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

function fakeMcpPort(): {
  get(id: string): undefined;
  add(): never;
  update(): never;
  remove(): void;
} {
  return {
    get: () => undefined,
    add: () => {
      throw new Error("声明式页面用例不涉及 MCP 登记");
    },
    update: () => {
      throw new Error("声明式页面用例不涉及 MCP 登记");
    },
    remove: () => {},
  };
}

/** v5 声明式插件清单：页面里把六种块都用上，尽量覆盖真实词表。 */
function pageManifest(overrides: Record<string, unknown> = {}): Record<string, unknown> {
  return {
    schemaVersion: 5,
    id: "acme.collector",
    name: "采集桥",
    version: "1.0.0",
    description: "本机采集服务的状态与用法",
    author: "Acme",
    engines: { heming: "d.100" },
    permissions: { network: [], tools: "read", files: [] },
    contributions: {
      page: {
        title: "采集桥",
        icon: "activity",
        summary: "本机采集服务状态与用法",
        blocks: [
          {
            type: "markdown",
            title: "怎么用",
            text: "先在设置里填来源，然后点「开始同步」。\n\n<script>alert(1)</script>",
          },
          { type: "stats", title: "状态", items: [{ label: "已采集", value: "128 条" }] },
          {
            type: "table",
            title: "来源",
            columns: ["来源", "状态"],
            rows: [["QQ", "就绪"]],
          },
          {
            type: "list",
            title: "待办",
            items: [{ title: "开始同步", description: "调用插件命令", badge: "命令" }],
          },
          {
            type: "actions",
            title: "快捷入口",
            items: [
              { label: "打开信息中枢", target: { kind: "page", page: "infohub" } },
              { label: "打开设置", target: { kind: "settings", card: "theme-mode" } },
              { label: "查看单元", target: { kind: "unit", unitId: "acme.collector" } },
              { label: "查看插件详情", target: { kind: "plugin" } },
            ],
          },
          { type: "contributions", kind: "skills" },
          { type: "contributions", kind: "mcpServers" },
        ],
      },
      skills: [{ name: "整理采集结果", instructions: "把采集结果整理成列表。" }],
    },
    ...overrides,
  };
}

let pool: SkillPool;
let store: PluginStore;

beforeEach(() => {
  localStorage.clear();
  sessionStorage.clear();
  // 技能池与插件存储必须共用同一份介质：安装事务会「读回技能键」校验写是否真的发生。
  const storage = makeStorage();
  pool = new SkillPool(storage, () => T0);
  store = new PluginStore(storage, pool, () => T0, fakeMcpPort());
  useUiStore.setState({ page: "home", paletteIntent: null, pageView: null });
});

afterEach(() => {
  cleanup();
  localStorage.clear();
  sessionStorage.clear();
});

/** 装一个带页面的声明式插件，返回安装记录（供「改坏块」用例基于真实记录改造）。 */
function installPagePlugin(): InstalledPlugin {
  store.install(JSON.stringify(pageManifest()));
  const plugin = store.get("acme.collector");
  if (!plugin) throw new Error("夹具安装失败");
  return plugin;
}

function renderPage(pluginId = "acme.collector") {
  return render(<PluginDeclarativePage pluginId={pluginId} plugins={store} />);
}

describe("PluginDeclarativePage · 页头", () => {
  it("显示页面标题、说明、声明式来源徽标与插件版本", () => {
    installPagePlugin();
    renderPage();

    expect(screen.getByRole("heading", { level: 1 })).toHaveTextContent("采集桥");
    expect(screen.getByText("本机采集服务状态与用法")).toBeInTheDocument();
    expect(screen.getByText("声明式插件")).toBeInTheDocument();
    expect(screen.getByText("v1.0.0")).toBeInTheDocument();
  });

  it("页面整页只读：不提供编辑清单的入口", () => {
    installPagePlugin();
    renderPage();

    expect(screen.queryByRole("textbox")).toBeNull();
    expect(screen.queryByRole("button", { name: /编辑/ })).toBeNull();
  });
});

describe("PluginDeclarativePage · 块渲染", () => {
  it("markdown 复用聊天渲染器且不解析原始 HTML", () => {
    installPagePlugin();
    const { container } = renderPage();

    expect(screen.getByText(/先在设置里填来源/)).toBeInTheDocument();
    // 清单里的 <script> 只能当数据：渲染树里不能出现 script 节点
    expect(container.querySelector("script")).toBeNull();
    expect(container.querySelector("img")).toBeNull();
  });

  it("stats 指标卡、table 只读表、list 列表按清单内容渲染", () => {
    installPagePlugin();
    renderPage();

    const stats = screen.getByLabelText("状态（指标）");
    expect(within(stats).getByText("已采集")).toBeInTheDocument();
    expect(within(stats).getByText("128 条")).toBeInTheDocument();

    const table = screen.getByLabelText("来源（表格）");
    expect(within(table).getByRole("table")).toBeInTheDocument();
    expect(within(table).getByRole("columnheader", { name: "来源" })).toBeInTheDocument();
    expect(within(table).getByRole("cell", { name: "QQ" })).toBeInTheDocument();
    expect(within(table).getByRole("cell", { name: "就绪" })).toBeInTheDocument();

    const list = screen.getByLabelText("待办（列表）");
    expect(within(list).getByText("开始同步")).toBeInTheDocument();
    expect(within(list).getByText("调用插件命令")).toBeInTheDocument();
    expect(within(list).getByText("命令")).toBeInTheDocument();
  });

  it("contributions 列出本插件该类贡献的名称与数量，空类给一句空态", () => {
    installPagePlugin();
    renderPage();

    const skills = screen.getByLabelText("技能（贡献）");
    expect(within(skills).getByText("整理采集结果")).toBeInTheDocument();
    expect(within(skills).getByText("1")).toBeInTheDocument();

    const servers = screen.getByLabelText("MCP 服务（贡献）");
    expect(within(servers).getByText("这个插件还没有声明该类贡献")).toBeInTheDocument();
  });

  it("坏块只丢自己：未知 type / 空指标块跳过，其余块照常渲染", () => {
    const installed = installPagePlugin();
    const page = installed.manifest.contributions.page;
    if (!page || page.kind !== "blocks") throw new Error("夹具必须是声明式页面");
    const broken: InstalledPlugin = {
      ...installed,
      manifest: {
        ...installed.manifest,
        contributions: {
          ...installed.manifest.contributions,
          page: {
            ...page,
            // 正常解析器产不出这些形状：模拟本机存储被旧版本/手工改坏
            blocks: [...page.blocks, { type: "mystery" }, null, { type: "stats", items: [] }],
          } as PluginManifest["contributions"]["page"],
        },
      },
    };
    const warn = vi.spyOn(console, "warn").mockImplementation(() => {});

    render(<PluginDeclarativePage pluginId="acme.collector" plugins={{ get: () => broken }} />);

    expect(screen.getByText(/先在设置里填来源/)).toBeInTheDocument();
    expect(screen.getByLabelText("来源（表格）")).toBeInTheDocument();
    expect(warn).toHaveBeenCalledTimes(3);
    warn.mockRestore();
  });
});

describe("PluginDeclarativePage · actions 跳转", () => {
  it("page 目标：直接切到该页面", () => {
    installPagePlugin();
    renderPage();

    fireEvent.click(screen.getByRole("button", { name: "打开信息中枢" }));
    expect(useUiStore.getState().page).toBe("infohub");
  });

  // d.136：定位目标从 "widgets" 换成仍在设置页的 "theme-mode"——「桌面小组件」卡已挪进
  // 插件详情，registry 里不再有它，清单校验会拒绝未知卡片 id（见 manifest.ts assertTargetUsable）。
  it("settings 目标：切设置页并投递定位卡片意图", () => {
    installPagePlugin();
    renderPage();

    fireEvent.click(screen.getByRole("button", { name: "打开设置" }));
    expect(useUiStore.getState().page).toBe("settings");
    expect(useUiStore.getState().paletteIntent).toMatchObject({
      kind: "focus-settings",
      data: { card: "theme-mode" },
    });
  });

  it("unit 目标：切插件页并复用 open-plugin 意图携带单元 id", () => {
    installPagePlugin();
    renderPage();

    fireEvent.click(screen.getByRole("button", { name: "查看单元" }));
    expect(useUiStore.getState().page).toBe("plugins");
    expect(useUiStore.getState().paletteIntent).toMatchObject({
      kind: "open-plugin",
      data: { id: "acme.collector" },
    });
  });

  it("plugin 目标：打开本插件详情意图", () => {
    installPagePlugin();
    renderPage();

    fireEvent.click(screen.getByRole("button", { name: "查看插件详情" }));
    expect(useUiStore.getState().page).toBe("plugins");
    expect(useUiStore.getState().paletteIntent).toMatchObject({
      kind: "open-plugin",
      data: { id: "acme.collector" },
    });
  });
});

describe("PluginDeclarativePage · 不可用状态", () => {
  it("插件没装：说明找不到并给回插件页的出口", () => {
    renderPage("acme.missing");

    expect(screen.getByLabelText("插件页面不可用")).toHaveTextContent("没有找到这个插件");
    fireEvent.click(screen.getByRole("button", { name: "去插件页" }));
    expect(useUiStore.getState().page).toBe("plugins");
  });

  it("旧插件没有声明页面：如实说明，不渲染空壳", () => {
    store.install(
      JSON.stringify({
        schemaVersion: 1,
        id: "acme.legacy",
        name: "老插件",
        version: "0.9.0",
        skills: [{ name: "老技能", instructions: "旧格式。" }],
      }),
    );
    renderPage("acme.legacy");

    expect(screen.getByLabelText("插件页面不可用")).toHaveTextContent("没有声明页面");
  });

  it("插件停用：页面不渲染，提示重新启用", () => {
    installPagePlugin();
    store.setEnabled("acme.collector", false);
    renderPage();

    expect(screen.getByLabelText("插件页面不可用")).toHaveTextContent("已停用");
  });
});
