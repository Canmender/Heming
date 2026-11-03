import { describe, it, expect, beforeEach, afterEach, vi } from "vitest";
import { render, screen, within, cleanup } from "@testing-library/react";
import { InterfacesPage } from "./InterfacesPage.js";
import { McpRegistry, MCP_SERVERS_KEY, type McpServerConfig } from "../lib/mcp/index.js";
import { PluginStore, describeSystemPlugin, type PluginMcpPort } from "../lib/plugins/index.js";
import { SkillPool } from "../lib/skills/index.js";
import type { StorageLike } from "../lib/memory/types.js";
import { useUiStore } from "../store/ui.js";

/**
 * d.65 T3：接口区的「内置：系统能力」来源徽标。
 *
 * 1. `origin === "preset"` 的预置服务：来源徽标是**非按钮**的「内置：<系统能力名>」，
 *    名字取自 describeSystemPlugin().name；
 * 2. 手工/Registry 来源不变（不出系统徽标）；
 * 3. 插件来源仍是可点徽标（对比）。
 */

const T0 = new Date("2026-11-01T08:00:00.000Z").getTime();

function makeStorage(servers: Partial<McpServerConfig>[]): StorageLike {
  const map = new Map<string, string>();
  map.set(MCP_SERVERS_KEY, JSON.stringify(servers));
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

function server(over: Partial<McpServerConfig>): McpServerConfig {
  return {
    id: "svc",
    name: "服务",
    transport: "http",
    url: "https://mcp.example.com/mcp",
    enabled: true,
    createdAt: "2026-11-01T00:00:00.000Z",
    updatedAt: "2026-11-01T00:00:00.000Z",
    ...over,
  };
}

function fakeMcp(): PluginMcpPort {
  const servers = new Map<string, McpServerConfig>();
  return {
    get: (id) => servers.get(id),
    add: (input) => {
      const created = server({
        id: input.id ?? "fake",
        name: input.name,
        transport: input.transport as McpServerConfig["transport"],
        url: input.url,
        enabled: input.enabled !== false,
        origin: input.origin ?? "manual",
      });
      servers.set(created.id, created);
      return created;
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

let plugins: PluginStore;

beforeEach(() => {
  localStorage.clear();
  // 接口区已并入插件区（d.67）：宿主页 = plugins，视图 = interfaces（MCP Tab）
  useUiStore.setState({ page: "plugins", pageView: "interfaces", paletteIntent: null });
  const storage = makeStorage([]);
  const pool = new SkillPool(storage, () => T0);
  plugins = new PluginStore(storage, pool, () => T0, fakeMcp());
  plugins.install({
    schemaVersion: 2,
    id: "acme.weather",
    name: "天气能力包",
    version: "1.0.0",
    description: "出行天气建议",
    author: "Acme",
    skills: [{ name: "出行建议", instructions: "结合天气出行。" }],
    mcpServers: [],
  });
});

afterEach(() => cleanup());

describe("接口区 · 系统来源徽标", () => {
  it("预置服务的来源徽标是「内置：<系统能力名>」且不可点（非按钮）", () => {
    const systemName = describeSystemPlugin().name;
    const registry = new McpRegistry(
      makeStorage([
        server({ id: "preset-core", name: "预置服务", origin: "preset" }),
      ]),
      () => new Date(T0).toISOString(),
    );

    render(<InterfacesPage registry={registry} plugins={plugins} />);
    const card = screen.getByRole("region", { name: "MCP 服务 预置服务" });
    const chip = within(card).getByText(`：${systemName}`, { exact: false }).closest(".ui-chip")!;
    expect(chip.textContent).toBe(`内置：${systemName}`);
    expect(chip.tagName).not.toBe("BUTTON");
    expect(within(card).queryByRole("button", { name: new RegExp(systemName) })).toBeNull();
  });

  it("手工来源的服务不出系统徽标", () => {
    const registry = new McpRegistry(
      makeStorage([server({ id: "manual-check", name: "手工服务", origin: "manual" })]),
      () => new Date(T0).toISOString(),
    );

    render(<InterfacesPage registry={registry} plugins={plugins} />);
    const card = screen.getByRole("region", { name: "MCP 服务 手工服务" });
    expect(within(card).queryByText(/内置：/)).toBeNull();
  });

  it("插件来源的服务仍是可点插件徽标（对比，确认没被一起改坏）", () => {
    const registry = new McpRegistry(
      makeStorage([
        server({
          id: "plugin:acme.weather:weather",
          name: "天气服务",
          origin: "plugin",
        }),
      ]),
      () => new Date(T0).toISOString(),
    );

    render(<InterfacesPage registry={registry} plugins={plugins} />);
    const card = screen.getByRole("region", { name: "MCP 服务 天气服务" });
    const pluginChip = within(card).getByRole("button", { name: "打开插件 天气能力包" });
    expect(pluginChip.textContent).toBe("插件：天气能力包");
    // 插件来源不应同时出现系统徽标
    expect(within(card).queryByText(/内置：/)).toBeNull();
  });
});
