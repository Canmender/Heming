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

const BUNDLED = readdirSync(PLUGINS_DIR, { withFileTypes: true })
  .filter((entry) => entry.isDirectory())
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
      for (const banned of ["apiKey", "headers", "env", "command", "args", "scripts", "secret"]) {
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

/** 技能说明里必须逐个写清的 7 个工具（与采集桥 tools/list 一致）。 */
const INFOHUB_TOOLS = [
  "infohub_status",
  "infohub_sync",
  "infohub_archive_search",
  "infohub_archive_read",
  "infohub_archive_agenda",
  "infohub_conversations",
  "infohub_agenda_rebuild",
] as const;

/** 两个写操作：调用前必须先跟用户确认（HITL 按名字判写）。 */
const INFOHUB_WRITE_TOOLS = ["infohub_sync", "infohub_agenda_rebuild"] as const;

function loadInfohub() {
  const { text, json } = readPlugin("infohub-collector");
  return { text, manifest: parsePluginManifest(json) };
}

describe("plugins/infohub-collector · 信息采集中枢（v3）", () => {
  it("钉死插件身份与权限：同 id 更新、风险上限 write、只连本机回环", () => {
    const { manifest } = loadInfohub();
    // 同 id 才是「更新」而不是新增：id 不许跟着改名
    expect(manifest.id).toBe("heming.infohub-collector");
    expect(manifest.schemaVersion).toBe(3);
    expect(manifest.name).toBe("信息采集中枢");
    expect(manifest.version).toBe("1.0.0");
    expect(manifest.author).toBe("和鸣");
    expect(manifest.permissions).toEqual({
      network: ["127.0.0.1:8776"],
      tools: "write",
      files: [],
    });
    // 采集与补扫日程会写本机归档 → 上限必须是 write（read 会在注入点挡掉写工具）
    expect(manifest.permissions.tools).toBe("write");
    expect(manifest.contributions.llmPresets).toEqual([]);
  });

  it("声明 1 个本机 MCP 服务：key infohub，只走 127.0.0.1:8776", () => {
    const { manifest } = loadInfohub();
    expect(manifest.contributions.mcpServers).toHaveLength(1);
    expect(manifest.contributions.mcpServers[0]).toMatchObject({
      key: "infohub",
      name: "信息采集中枢（本机采集桥）",
      url: "http://127.0.0.1:8776/mcp",
    });
    expect(manifest.contributions.mcpServers[0].description).toContain("127.0.0.1");
  });

  it("声明 1 个技能与 3 条命令，命令全部跳到信息中枢页", () => {
    const { manifest } = loadInfohub();
    expect(manifest.contributions.skills).toHaveLength(1);
    const [skill] = manifest.contributions.skills;
    expect(skill.name).toBe("本机信息采集与归档查询");
    expect(skill.description.length).toBeGreaterThan(0);
    expect(skill.triggers.length).toBeGreaterThan(0);
    expect(skill.tags.length).toBeGreaterThan(0);

    expect(manifest.contributions.commands).toHaveLength(3);
    expect(manifest.contributions.commands.map((command) => command.id)).toEqual([
      "infohub-status",
      "infohub-collect",
      "infohub-agenda",
    ]);
    for (const command of manifest.contributions.commands) {
      expect(command.title.length).toBeGreaterThan(0);
      expect(command.keywords.length).toBeGreaterThan(0);
      expect(command.target).toEqual({ kind: "page", page: "infohub" });
    }
  });

  it("技能说明逐个写清 7 个工具的用途与边界", () => {
    const { manifest } = loadInfohub();
    const instructions = manifest.contributions.skills[0].instructions;
    for (const tool of INFOHUB_TOOLS) {
      expect(instructions, `技能说明应写明 ${tool}`).toContain(tool);
    }
    // 先看状态；先列会话再读消息
    expect(instructions).toContain("先看状态");
    expect(instructions).toContain("先列会话");
    // 引用与边界口径
    expect(instructions).toContain("来自本机归档");
    expect(instructions).toContain("当前会话");
    expect(instructions).toContain("启动采集桥");
    expect(instructions).toContain("不要编造");
  });

  it("两个写工具必须在说明里与「确认」同现", () => {
    const { manifest } = loadInfohub();
    const instructions = manifest.contributions.skills[0].instructions;
    for (const tool of INFOHUB_WRITE_TOOLS) {
      const line = instructions.split("\n").find((candidate) => candidate.includes(tool));
      expect(line, `技能说明应有一行讲 ${tool}`).toBeTruthy();
      expect(line, `${tool} 是写操作，同一行必须要求先确认`).toContain("确认");
      expect(instructions, `${tool} 必须被标成写操作`).toContain("写操作");
    }
  });

  it("描述与说明不承诺自动采集/自动启动，只承诺用户显式启动", () => {
    const { manifest } = loadInfohub();
    const instructions = manifest.contributions.skills[0].instructions;
    // 「一装就采」类承诺是误导：端点要用户自己点「启动采集桥」
    for (const promise of [/自动采集/, /自动启动/, /安装即启动/, /开箱即用/, /一装就自动/]) {
      expect(manifest.description).not.toMatch(promise);
      expect(instructions).not.toMatch(promise);
    }
    expect(manifest.description).toContain("启动采集桥");
    expect(instructions).toContain("手动启动");
  });

  it("预览可安装，且预览不写存储", () => {
    const { text } = readPlugin("infohub-collector");
    const { store, skills, preview } = previewPlugin(text);
    expect(preview.manifest.id).toBe("heming.infohub-collector");
    expect(preview.skills.added).toEqual(["本机信息采集与归档查询"]);
    expect(preview.servers.added.map((server) => server.key)).toEqual(["infohub"]);
    // 预览只是「看一眼」：用户确认之前不能落库
    expect(store.list()).toEqual([]);
    expect(skills.list().filter((skill) => skill.pluginId === preview.manifest.id)).toEqual([]);
  });
});
