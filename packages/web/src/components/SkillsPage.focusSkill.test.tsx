import { describe, it, expect, beforeEach, afterEach, vi } from "vitest";
import { render, screen, waitFor, cleanup, act } from "@testing-library/react";
import { SkillsPage } from "./SkillsPage.js";
import { SkillPool } from "../lib/skills/index.js";
import { PluginStore, type PluginMcpPort } from "../lib/plugins/index.js";
import type { StorageLike } from "../lib/memory/types.js";
import type { McpServerConfig } from "../lib/mcp/index.js";
import { useUiStore } from "../store/ui.js";

/**
 * d.64 T3b：技能区消费 `focus-skill` 意图（命令面板「插件命令」target=skill 的落点）。
 *
 * 1. 命中技能 id → 打开该技能的详情抽屉，并清空意图；
 * 2. 找不到（技能已删/名字对不上）→ 只停在技能区，不报错、不弹空抽屉，意图同样清空。
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

let skills: SkillPool;
let plugins: PluginStore;

beforeEach(() => {
  localStorage.clear();
  // 技能区已并入插件区（d.67）：宿主页 = plugins，视图 = skills
  useUiStore.setState({ page: "plugins", pageView: "skills", paletteIntent: null });
  const storage = makeStorage();
  skills = new SkillPool(storage, () => T0);
  plugins = new PluginStore(storage, skills, () => T0, fakeMcp());
});

afterEach(() => cleanup());

function createSkill(name = "出行建议") {
  return skills.create({
    name,
    description: "结合天气出行",
    instructions: "先查天气再给建议。",
    triggers: [],
    tags: [],
    enabled: true,
    version: "1.0.0",
    source: "user",
  });
}

describe("技能区 · 消费 focus-skill 意图", () => {
  it("命中技能 id → 打开详情抽屉并清空意图", async () => {
    const skill = createSkill();
    render(<SkillsPage skills={skills} plugins={plugins} />);

    act(() => {
      useUiStore.getState().setPaletteIntent("focus-skill", { id: skill.id });
    });

    expect(await screen.findByRole("dialog", { name: `技能详情 ${skill.name}` })).toBeInTheDocument();
    expect(useUiStore.getState().paletteIntent).toBeNull();
  });

  it("找不到技能 id → 只停在技能区：不弹抽屉、不报错、意图同样清空", async () => {
    createSkill();
    render(<SkillsPage skills={skills} plugins={plugins} />);

    act(() => {
      useUiStore.getState().setPaletteIntent("focus-skill", { id: "missing-skill-id" });
    });

    await waitFor(() => expect(useUiStore.getState().paletteIntent).toBeNull());
    expect(screen.queryByRole("dialog")).not.toBeInTheDocument();
    // 页面本身仍正常渲染（没错崩）
    expect(screen.getByRole("heading", { name: "技能区" })).toBeInTheDocument();
  });
});
