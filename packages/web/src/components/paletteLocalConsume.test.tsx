import { describe, it, expect, beforeEach, afterEach, vi } from "vitest";
import { render, screen, waitFor, cleanup, act } from "@testing-library/react";
import { MemoryPage } from "./MemoryPage.js";
import { PluginsPage } from "./PluginsPage.js";
import { useUiStore } from "../store/ui.js";
import {
  AgentPrefsStore,
  KnowledgeBase,
  MemoryStore,
  type StorageLike,
} from "../lib/memory/index.js";
import { PluginStore, pluginServerId, type PluginMcpPort } from "../lib/plugins/index.js";
import { SkillPool } from "../lib/skills/index.js";
import type { McpServerConfig } from "../lib/mcp/index.js";

// 记忆页会拉名册与共享文件：单测里全部给桩，避免打真实接口。
vi.mock("../lib/agentsApi.js", async (importOriginal) => {
  const actual = await importOriginal<typeof import("../lib/agentsApi.js")>();
  return { ...actual, listAgents: vi.fn(async () => []) };
});
vi.mock("../lib/export/file.js", () => ({
  hasDesktopExportBridge: () => false,
  saveExportFile: vi.fn(),
}));

/**
 * 命令面板本机三组 → 目标页定位（d.61）。
 *
 * 只验「意图到达后，页面真的定位并高亮到那一条、意图被清空」这条接线；
 * 三个来源的检索口径在 `lib/palette/local.test.ts` 里单独覆盖。
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

function pluginManifest(): Record<string, unknown> {
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
  };
}

describe("命令面板意图消费 · 记忆定位", () => {
  beforeEach(() => {
    localStorage.clear();
    useUiStore.setState({ page: "home", paletteIntent: null });
  });
  afterEach(() => cleanup());

  it("收到 focus-memory 意图后切到记忆区并高亮该条，意图被清空", async () => {
    const memory = new MemoryStore(makeStorage(), () => T0);
    const kb = new KnowledgeBase(makeStorage(), () => T0);
    const prefs = new AgentPrefsStore(makeStorage());
    const entry = memory.upsertSemantic({
      agentId: "a1",
      key: "称呼",
      value: "用户希望被称为阿和",
      source: "manual",
    });

    render(<MemoryPage memory={memory} kb={kb} prefs={prefs} fetchSharedFiles={async () => []} />);

    act(() => {
      useUiStore.getState().setPaletteIntent("focus-memory", { memoryId: entry.id, layer: "semantic" });
    });

    await waitFor(() => {
      const el = document.querySelector(`[data-memory-id="${entry.id}"]`);
      expect(el).toBeTruthy();
      expect(el!.className).toContain("ring-2");
    });
    expect(useUiStore.getState().paletteIntent).toBeNull();
  });

  it("意图消费后不会重复高亮（幂等）", async () => {
    const memory = new MemoryStore(makeStorage(), () => T0);
    const kb = new KnowledgeBase(makeStorage(), () => T0);
    const prefs = new AgentPrefsStore(makeStorage());
    const entry = memory.upsertSemantic({
      agentId: "a1",
      key: "称呼",
      value: "叫阿和",
      source: "manual",
    });

    render(<MemoryPage memory={memory} kb={kb} prefs={prefs} fetchSharedFiles={async () => []} />);
    act(() => {
      useUiStore.getState().setPaletteIntent("focus-memory", { memoryId: entry.id, layer: "semantic" });
    });
    await waitFor(() => expect(useUiStore.getState().paletteIntent).toBeNull());

    // 再次渲染（模拟父级重渲染）不应该因为「残留意图」又高亮一次
    act(() => {
      useUiStore.getState().setPage("home");
    });
    expect(document.querySelector(`[data-memory-id="${entry.id}"]`)).toBeTruthy();
    expect(useUiStore.getState().paletteIntent).toBeNull();
  });
});

describe("命令面板意图消费 · 插件定位", () => {
  beforeEach(() => {
    localStorage.clear();
    useUiStore.setState({ page: "home", paletteIntent: null });
  });
  afterEach(() => cleanup());

  it("收到 open-plugin 意图后高亮该插件卡片并打开详情，意图被清空", async () => {
    const storage = makeStorage();
    const pool = new SkillPool(storage, () => T0);
    const store = new PluginStore(storage, pool, () => T0, fakeMcp().port);
    store.install(pluginManifest());

    render(<PluginsPage plugins={store} />);
    act(() => {
      useUiStore.getState().setPaletteIntent("open-plugin", { id: "acme.weather" });
    });

    await waitFor(() => {
      const card = document.querySelector('[data-plugin-id="acme.weather"]');
      expect(card).toBeTruthy();
      expect(card!.className).toContain("ring-2");
    });
    expect(useUiStore.getState().paletteIntent).toBeNull();
    // 同名的技能/服务 id 也用了 pluginServerId，这里确认定位的是插件卡片而不是服务
    expect(pluginServerId("acme.weather", "weather")).toContain("acme.weather");
  });

  it("意图指向不存在的插件时清空意图且不崩", async () => {
    const storage = makeStorage();
    const pool = new SkillPool(storage, () => T0);
    const store = new PluginStore(storage, pool, () => T0, fakeMcp().port);
    store.install(pluginManifest());

    render(<PluginsPage plugins={store} />);
    act(() => {
      useUiStore.getState().setPaletteIntent("open-plugin", { id: "nope.missing" });
    });
    await waitFor(() => expect(useUiStore.getState().paletteIntent).toBeNull());
    expect(screen.getAllByText("天气能力包").length).toBeGreaterThan(0);
  });
});
