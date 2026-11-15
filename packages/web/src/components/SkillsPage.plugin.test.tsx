import { describe, it, expect, beforeEach, afterEach } from "vitest";
import { render, screen, fireEvent, waitFor, cleanup, within } from "@testing-library/react";
import { SkillsPage } from "./SkillsPage.js";
import { PluginStore, type PluginMcpPort } from "../lib/plugins/index.js";
import { SkillPool } from "../lib/skills/index.js";
import type { StorageLike } from "../lib/memory/types.js";
import type { McpServerConfig } from "../lib/mcp/index.js";
import { useUiStore } from "../store/ui.js";

/**
 * d.64 T3a：技能区的「插件来源」徽标与跳转（d.148.4.95 单一列表版）。
 *
 * 锁三件事：
 * 1. 插件提供的技能在**本机技能列表卡片**上出现「插件：<插件名>」徽标（不是裸 pluginId）；
 * 2. 详情抽屉里同样带该徽标；
 * 3. 点徽标 = 投 open-plugin 内存意图 + 切插件区（不新增 IPC、不改分组逻辑）。
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

function fakeMcp(): PluginMcpPort {
  const servers = new Map<string, McpServerConfig>();
  return {
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
  };
}

/** v2 旧清单也能装（T1 已把 v1/v2 归一化到 contributions）。 */
function weatherManifest(): Record<string, unknown> {
  return {
    schemaVersion: 2,
    id: "acme.weather",
    name: "天气能力包",
    version: "1.0.0",
    description: "出行天气建议",
    author: "Acme",
    skills: [{ name: "出行建议", instructions: "结合天气出行。" }],
    mcpServers: [],
  };
}

let storage: StorageLike;
let pool: SkillPool;
let plugins: PluginStore;

beforeEach(() => {
  localStorage.clear();
  useUiStore.setState({ page: "home", paletteIntent: null });
  storage = makeStorage();
  pool = new SkillPool(storage, () => T0);
  plugins = new PluginStore(storage, pool, () => T0, fakeMcp());
  plugins.install(weatherManifest());
});

afterEach(() => cleanup());

describe("技能区 · 插件来源徽标", () => {
  it("插件提供的技能在本机列表卡片显示「插件：<插件名>」（不是裸 id）", async () => {
    render(<SkillsPage skills={pool} plugins={plugins} />);

    // 单一列表：默认就在「本机技能」，插件技能直接落在「已装技能」分组里。
    const card = await screen.findByRole("group", { name: "技能卡 出行建议" });
    const chip = within(card).getByRole("button", { name: "打开插件 天气能力包" });
    // 拆成两个文本节点：既有 getByText("插件") 锚点仍成立，完整文案是「插件：天气能力包」
    expect(chip.textContent).toBe("插件：天气能力包");
    expect(screen.queryByText(/acme\.weather/)).not.toBeInTheDocument();
  });

  it("详情抽屉里同样带「插件：<插件名>」徽标", async () => {
    render(<SkillsPage skills={pool} plugins={plugins} />);

    const card = await screen.findByRole("group", { name: "技能卡 出行建议" });
    fireEvent.click(within(card).getByRole("button", { name: "详情 出行建议" }));
    const drawer = await screen.findByRole("dialog", { name: "技能详情 出行建议" });
    // 抽屉打开时列表卡片里的徽标还在，所以要在抽屉内查找
    const chip = within(drawer).getByRole("button", { name: "打开插件 天气能力包" });
    expect(chip.textContent).toBe("插件：天气能力包");
  });

  it("点徽标 → 投 open-plugin 意图并切到插件区", async () => {
    render(<SkillsPage skills={pool} plugins={plugins} />);
    const card = await screen.findByRole("group", { name: "技能卡 出行建议" });
    fireEvent.click(within(card).getByRole("button", { name: "打开插件 天气能力包" }));

    await waitFor(() => expect(useUiStore.getState().page).toBe("plugins"));
    expect(useUiStore.getState().paletteIntent).toMatchObject({
      kind: "open-plugin",
      data: { id: "acme.weather" },
    });
  });

  it("内置/手工技能没有插件徽标（来源分类不受影响）", async () => {
    // 造一个不来自插件的技能：直接进技能池
    pool.create({
      name: "手工技能",
      description: "自己写的",
      instructions: "按步骤做。",
      triggers: [],
      tags: [],
      enabled: true,
      version: "1.0.0",
      source: "user",
    });
    render(<SkillsPage skills={pool} plugins={plugins} />);

    const manualCard = await screen.findByRole("group", { name: "技能卡 手工技能" });
    expect(within(manualCard).queryByRole("button", { name: /打开插件/ })).toBeNull();
    expect(within(manualCard).getByText(/自定义/)).toBeInTheDocument();

    // 对照：插件来源的技能卡片有徽标
    const pluginCard = screen.getByRole("group", { name: "技能卡 出行建议" });
    expect(
      within(pluginCard).getByRole("button", { name: "打开插件 天气能力包" }),
    ).toBeInTheDocument();
  });
});
