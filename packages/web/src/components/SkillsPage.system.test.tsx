import { describe, it, expect, beforeEach, afterEach, vi } from "vitest";
import { render, screen, fireEvent, cleanup, within } from "@testing-library/react";
import { SkillsPage } from "./SkillsPage.js";
import { SkillPool } from "../lib/skills/index.js";
import { PluginStore, describeSystemPlugin, type PluginMcpPort } from "../lib/plugins/index.js";
import type { StorageLike } from "../lib/memory/types.js";
import type { McpServerConfig } from "../lib/mcp/index.js";
import { useUiStore } from "../store/ui.js";

/**
 * d.65 T3：技能区的「内置：系统能力」来源徽标。
 *
 * 1. 内置技能的来源徽标是**非按钮**（系统插件没有详情页可跳），文案为「内置：<系统能力名>」，
 *    名称来自 describeSystemPlugin().name，页面里不硬编码；
 * 2. 插件技能仍是可点的「插件：<名>」徽标（对比，确认没被一起改坏）。
 */

vi.mock("../lib/agentsApi.js", async (importOriginal) => {
  const actual = await importOriginal<typeof import("../lib/agentsApi.js")>();
  return { ...actual, listAgents: vi.fn(async () => []) };
});

const T0 = new Date("2026-11-01T08:00:00.000Z").getTime();

function makeStorage(): StorageLike {
  const map = new Map<string, string>();
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

let skills: SkillPool;
let plugins: PluginStore;

beforeEach(() => {
  localStorage.clear();
  // 技能区已并入插件区（d.67）：宿主页 = plugins，视图 = skills
  useUiStore.setState({ page: "plugins", pageView: "skills", paletteIntent: null });
  const storage = makeStorage();
  skills = new SkillPool(storage, () => T0);
  plugins = new PluginStore(storage, skills, () => T0, fakeMcp());
  plugins.install(weatherManifest());
});

afterEach(() => cleanup());

describe("技能区 · 系统来源徽标", () => {
  it("内置技能的来源徽标是「内置：<系统能力名>」且不可点（非按钮）", () => {
    const builtin = skills.list().find((s) => s.source === "builtin")!;
    const systemName = describeSystemPlugin().name;

    render(<SkillsPage skills={skills} plugins={plugins} />);
    fireEvent.click(screen.getByRole("tab", { name: "技能池" }));

    const row = screen.getByRole("row", { name: new RegExp(builtin.name) });
    const chip = within(row).getByText(`：${systemName}`, { exact: false }).closest(".ui-chip")!;
    expect(chip).toBeTruthy();
    expect(chip.textContent).toBe(`内置：${systemName}`);
    // 非按钮：来源徽标没有可点语义（系统插件没有详情页）
    expect(chip.tagName).not.toBe("BUTTON");
    expect(within(row).queryByRole("button", { name: new RegExp(systemName) })).toBeNull();
  });

  it("名称取自 describeSystemPlugin().name（不是页面硬编码的「系统能力」字面量）", () => {
    const systemName = describeSystemPlugin().name;
    expect(systemName.length).toBeGreaterThan(0);
    render(<SkillsPage skills={skills} plugins={plugins} />);
    fireEvent.click(screen.getByRole("tab", { name: "技能池" }));
    expect(screen.getAllByText(`：${systemName}`, { exact: false }).length).toBeGreaterThan(0);
  });

  it("插件技能仍是可点徽标（与系统徽标并存不混淆）", () => {
    render(<SkillsPage skills={skills} plugins={plugins} />);
    fireEvent.click(screen.getByRole("tab", { name: "技能池" }));

    const pluginChip = screen.getByRole("button", { name: "打开插件 天气能力包" });
    expect(pluginChip.textContent).toBe("插件：天气能力包");
    // 系统徽标不可点、插件徽标可点
    expect(screen.queryByRole("button", { name: /打开系统/ })).toBeNull();
  });
});
