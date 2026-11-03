import { describe, it, expect, beforeEach, afterEach, vi } from "vitest";
import { render, screen, fireEvent, waitFor, cleanup, within } from "@testing-library/react";
import { InterfacesPage } from "./InterfacesPage.js";
import { McpRegistry, MCP_SERVERS_KEY, type McpServerConfig } from "../lib/mcp/index.js";
import { PluginStore, type PluginMcpPort } from "../lib/plugins/index.js";
import { SkillPool } from "../lib/skills/index.js";
import type { StorageLike } from "../lib/memory/types.js";
import { useUiStore } from "../store/ui.js";

/**
 * d.64 T3a：接口区的「插件来源」徽标与跳转。
 *
 * 1. origin=plugin 的服务行显示「插件：<插件名>」（不是裸 id），且旧的 `getByText("插件")`
 *    锚点仍然成立（徽标内层拆成了「插件」+「：名称」两个文本节点）；
 * 2. 点徽标 = 投 open-plugin 内存意图 + 切插件区；
 * 3. 预置 / 手工 / Registry 来源的服务不出插件徽标（来源口径不变）。
 */

const T0 = new Date("2026-11-01T08:00:00.000Z").getTime();

function makeStorage(servers: Partial<McpServerConfig>[] = []): StorageLike {
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
    mcpServers: [
      {
        key: "weather",
        name: "天气服务",
        url: "https://mcp.example.com/weather",
        description: "查询天气",
      },
    ],
  };
}

let plugins: PluginStore;

beforeEach(() => {
  localStorage.clear();
  useUiStore.setState({ page: "home", paletteIntent: null });
  const storage = makeStorage();
  const pool = new SkillPool(storage, () => T0);
  plugins = new PluginStore(storage, pool, () => T0, fakeMcp());
  plugins.install(weatherManifest());
});

afterEach(() => cleanup());

describe("接口区 · 插件来源徽标", () => {
  it("origin=plugin 的服务显示「插件：<插件名>」，且旧的「插件」文本锚点仍成立", () => {
    const registry = new McpRegistry(
      makeStorage([
        {
          id: "plugin:acme.weather:weather",
          name: "天气服务",
          transport: "http",
          url: "https://mcp.example.com/weather",
          enabled: true,
          origin: "plugin",
          createdAt: "2026-11-01T00:00:00.000Z",
          updatedAt: "2026-11-01T00:00:00.000Z",
        },
      ]),
      () => new Date(T0).toISOString(),
    );

    render(<InterfacesPage registry={registry} plugins={plugins} />);
    const card = screen.getByRole("region", { name: "MCP 服务 天气服务" });
    // 既有锚点：来源徽标里仍有一个文本恰好是「插件」
    expect(within(card).getByText("插件")).toBeInTheDocument();
    // 新增：完整文案带插件名，且不是裸 id
    const chip = within(card).getByRole("button", { name: "打开插件 天气能力包" });
    expect(chip.textContent).toBe("插件：天气能力包");
    expect(card.textContent).not.toContain("acme.weather");
  });

  it("点徽标 → 投 open-plugin 意图并切到插件区", async () => {
    const registry = new McpRegistry(
      makeStorage([
        {
          id: "plugin:acme.weather:weather",
          name: "天气服务",
          transport: "http",
          url: "https://mcp.example.com/weather",
          enabled: true,
          origin: "plugin",
          createdAt: "2026-11-01T00:00:00.000Z",
          updatedAt: "2026-11-01T00:00:00.000Z",
        },
      ]),
      () => new Date(T0).toISOString(),
    );

    render(<InterfacesPage registry={registry} plugins={plugins} />);
    fireEvent.click(screen.getByRole("button", { name: "打开插件 天气能力包" }));

    await waitFor(() => expect(useUiStore.getState().page).toBe("plugins"));
    expect(useUiStore.getState().paletteIntent).toMatchObject({
      kind: "open-plugin",
      data: { id: "acme.weather" },
    });
  });

  it("插件已卸载（查不到名字）时徽标降级为「未知插件」，不发跳转", async () => {
    const registry = new McpRegistry(
      makeStorage([
        {
          id: "plugin:gone.pack:svc",
          name: "孤儿服务",
          transport: "http",
          url: "https://mcp.example.com/orphan",
          enabled: true,
          origin: "plugin",
          createdAt: "2026-11-01T00:00:00.000Z",
          updatedAt: "2026-11-01T00:00:00.000Z",
        },
      ]),
      () => new Date(T0).toISOString(),
    );

    render(<InterfacesPage registry={registry} plugins={plugins} />);
    const card = screen.getByRole("region", { name: "MCP 服务 孤儿服务" });
    const chip = within(card).getByRole("button", { name: "打开插件 gone.pack" });
    expect(chip.textContent).toBe("插件：未知插件");

    // 点它仍然按 id 跳（插件页自己会提示找不到，避免「点了没反应」）
    fireEvent.click(chip);
    await waitFor(() => expect(useUiStore.getState().page).toBe("plugins"));
    expect(useUiStore.getState().paletteIntent).toMatchObject({
      kind: "open-plugin",
      data: { id: "gone.pack" },
    });
  });

  it("手工来源的服务不出插件徽标", () => {
    const registry = new McpRegistry(
      makeStorage([
        {
          id: "manual-check",
          name: "手工服务",
          transport: "http",
          url: "https://mcp.example.com/manual",
          enabled: true,
          origin: "manual",
          createdAt: "2026-11-01T00:00:00.000Z",
          updatedAt: "2026-11-01T00:00:00.000Z",
        },
      ]),
      () => new Date(T0).toISOString(),
    );

    render(<InterfacesPage registry={registry} plugins={plugins} />);
    const card = screen.getByRole("region", { name: "MCP 服务 手工服务" });
    expect(within(card).queryByText("插件")).toBeNull();
    expect(within(card).queryByRole("button", { name: /打开插件/ })).toBeNull();
  });
});
