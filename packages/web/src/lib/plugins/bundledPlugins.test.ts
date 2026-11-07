import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";
import { parsePluginManifest, PluginStore, type PluginMcpPort } from "./index.js";
import { SkillPool } from "../skills/index.js";
import type { StorageLike } from "../memory/types.js";

/**
 * 仓库内自带的示例插件包守卫（d.84）。
 *
 * 插件包是**声明式数据**，不会经过 TypeScript 检查；它的唯一校验点是安装时的
 * `parsePluginManifest`。用一条用例把它钉在发布前：清单一旦被改坏（字段拼错、
 * 服务地址不是本机回环、命令指向不存在的页面），这里先红，而不是用户安装时才发现。
 */

const PLUGIN_PATH = "../../../../../plugins/infohub-collector/plugin.json";
const pluginText = readFileSync(fileURLToPath(new URL(PLUGIN_PATH, import.meta.url)), "utf8");

function memStorage(): StorageLike & { map: Map<string, string> } {
  const map = new Map<string, string>();
  return {
    map,
    getItem: (k) => (map.has(k) ? (map.get(k) as string) : null),
    setItem: (k, v) => void map.set(k, v),
    removeItem: (k) => void map.delete(k),
  };
}

/** 只需要「登记/查/更新/删」的窄 MCP 端口，够安装流程用。 */
function fakeMcpPort(): PluginMcpPort {
  const servers = new Map<string, never>();
  return {
    get: (id) => servers.get(id),
    add: (input) => {
      const server = {
        id: input.id ?? "fake",
        name: input.name,
        transport: input.transport,
        url: input.url,
        enabled: input.enabled !== false,
        origin: input.origin ?? "manual",
        createdAt: "2026-11-01T00:00:00.000Z",
        updatedAt: "2026-11-01T00:00:00.000Z",
      } as never;
      servers.set((server as { id: string }).id, server);
      return server;
    },
    update: () => {
      throw new Error("测试端口不支持 update");
    },
    remove: (id) => void servers.delete(id),
  };
}

describe("仓库自带插件包 · plugins/infohub-collector", () => {
  it("清单通过 v3 校验，并声明一个本机回环 MCP 服务", () => {
    const manifest = parsePluginManifest(JSON.parse(pluginText));
    expect(manifest.id).toBe("heming.infohub-collector");
    expect(manifest.schemaVersion).toBe(3);
    expect(manifest.contributions.mcpServers).toHaveLength(1);
    expect(manifest.contributions.mcpServers[0]).toMatchObject({
      key: "infohub",
      url: "http://127.0.0.1:8776/mcp",
    });
    // 采集会写本机归档 → 风险上限必须是 write（read 会把写工具挡在注入点外）
    expect(manifest.permissions.tools).toBe("write");
    expect(manifest.permissions.network).toEqual(["127.0.0.1:8776"]);
    expect(manifest.contributions.skills.length).toBeGreaterThan(0);
    expect(manifest.contributions.commands.length).toBeGreaterThan(0);
  });

  it("不含代码、命令、环境变量、请求头或密钥（声明式插件的红线）", () => {
    const raw = JSON.parse(pluginText) as Record<string, unknown>;
    const text = JSON.stringify(raw);
    for (const banned of ["apiKey", "headers", "env", "command", "args", "scripts"]) {
      expect(text).not.toContain(`"${banned}"`);
    }
  });

  it("可以被真实安装流程预览（技能物化 + 服务登记，不联网）", () => {
    const storage = memStorage();
    const skills = new SkillPool(storage, () => Date.parse("2026-11-07T00:00:00.000Z"));
    const store = new PluginStore(
      storage,
      skills,
      () => Date.parse("2026-11-07T00:00:00.000Z"),
      fakeMcpPort(),
    );
    const preview = store.preview(pluginText);
    expect(preview.manifest.id).toBe("heming.infohub-collector");
    expect(preview.skills.added.length).toBe(1);
    expect(preview.servers.added.map((s) => s.key)).toEqual(["infohub"]);
    // 预览不写任何存储
    expect(store.list()).toEqual([]);
    expect(skills.list().filter((s) => s.pluginId === "heming.infohub-collector")).toEqual([]);
  });
});
