import { existsSync, readFileSync, readdirSync } from "node:fs";
import { resolve } from "node:path";
import { describe, expect, it } from "vitest";
import { parsePluginManifest, PluginStore, type PluginMcpPort } from "./index.js";
import { SkillPool } from "../skills/index.js";
import type { StorageLike } from "../memory/types.js";

/**
 * 仓库内自带插件包的守卫（d.85 / d.86）。
 *
 * 插件包是**声明式数据**，不会经过 TypeScript 检查；唯一校验点是安装时的
 * `parsePluginManifest`。这里在发布前先钉住：清单能通过校验、权限/贡献符合预期、
 * 不含代码与密钥、预览可安装且预览不写存储。
 *
 * 这些包**不随安装包分发**：发布脚本会把它们上传到云端插件目录，用户自行下载安装
 * （见 scripts/publish-plugin.mjs 与 docs/PLUGINS.md）。
 */

/**
 * 仓库根下的 `plugins/`：vitest 的 cwd 是 `packages/web`（根脚本与 --filter 都如此），
 * 用 cwd 解析而不是 `import.meta.url`——jsdom 环境下它不是 file: 协议。
 */
const PLUGIN_DIR_CANDIDATES = [
  resolve(process.cwd(), "../../plugins"),
  resolve(process.cwd(), "plugins"),
];
const PLUGINS_DIR = PLUGIN_DIR_CANDIDATES.find((dir) => existsSync(dir)) ?? PLUGIN_DIR_CANDIDATES[0];

function readPlugin(dir: string): { text: string; json: Record<string, unknown> } {
  const text = readFileSync(`${PLUGINS_DIR}/${dir}/plugin.json`, "utf8");
  return { text, json: JSON.parse(text) as Record<string, unknown> };
}

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

function previewPlugin(text: string) {
  const storage = memStorage();
  const skills = new SkillPool(storage, () => Date.parse("2026-11-07T00:00:00.000Z"));
  const store = new PluginStore(
    storage,
    skills,
    () => Date.parse("2026-11-07T00:00:00.000Z"),
    fakeMcpPort(),
  );
  return { store, skills, preview: store.preview(text) };
}

// `plugins/examples/` 是给 lint/文档用的示例，没有 plugin.json、也不是发布物：
// 这里只枚举「真的带清单的包目录」。
const BUNDLED = readdirSync(PLUGINS_DIR, { withFileTypes: true })
  .filter((entry) => entry.isDirectory() && existsSync(resolve(PLUGINS_DIR, entry.name, "plugin.json")))
  .map((entry) => entry.name)
  .sort();

describe("仓库自带插件包 · 目录与共性", () => {
  it("目录里每个包都能通过清单校验，且不含代码/密钥/请求头", () => {
    expect(BUNDLED.length).toBeGreaterThan(0);
    for (const dir of BUNDLED) {
      const { text, json } = readPlugin(dir);
      const manifest = parsePluginManifest(json);
      expect(manifest.id, dir).toBeTruthy();
      // 目录名与插件 id 的最后一段保持一致（infohub-collector → heming.infohub-collector）
      expect(manifest.id.endsWith(dir), dir).toBe(true);
      expect(manifest.schemaVersion, dir).toBeGreaterThanOrEqual(3);
      // 声明式红线：没有可执行物、没有密钥、没有请求头
      for (const banned of ["apiKey", "headers", "env", "command", "args", "scripts"]) {
        expect(text, `${dir} 不应出现 "${banned}"`).not.toContain(`"${banned}"`);
      }
      // 预览可装，且预览不写任何存储
      const { store, skills, preview } = previewPlugin(text);
      expect(preview.manifest.id, dir).toBe(manifest.id);
      expect(store.list()).toEqual([]);
      expect(skills.list().filter((s) => s.pluginId === manifest.id)).toEqual([]);
    }
  });
});

describe("plugins/infohub-collector · 采集桥（v3）", () => {
  it("声明一个本机回环 MCP 服务，风险上限 write", () => {
    const { text } = readPlugin("infohub-collector");
    const manifest = parsePluginManifest(JSON.parse(text));
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
    expect(manifest.contributions.llmPresets).toEqual([]);

    const { preview } = previewPlugin(text);
    expect(preview.skills.added.length).toBe(1);
    expect(preview.servers.added.map((s) => s.key)).toEqual(["infohub"]);
  });
});
