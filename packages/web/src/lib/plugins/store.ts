import { skillPool, type SkillPool, type StorageLike } from "../skills/index.js";
import { mcpRegistry, type McpServerConfig, type ServerOrigin } from "../mcp/index.js";
import {
  parsePluginManifest,
  PluginManifestError,
  type PluginManifest,
} from "./manifest.js";

/**
 * 已装插件的本机存储（`heming.plugins.v1`）。
 *
 * 插件是系统能力包，不是第二套技能/工具系统：
 * - 技能**物化进现有技能池**（`source: "imported"` + `pluginId`）；
 * - 远程 MCP 服务**登记进现有 MCP 注册表**（`origin: "plugin"`），连接、工具开关与 HITL 全沿用。
 * 本存储只记录「插件 → 技能 id / 服务 id」的归属与启用状态。
 */

export const PLUGINS_KEY = "heming.plugins.v1";
export const MAX_PLUGINS = 50;

/** 插件依赖的 MCP 注册表面：窄接口让单测不必真的碰 localStorage 与预置服务。 */
export interface PluginMcpPort {
  get(id: string): McpServerConfig | undefined;
  add(input: {
    id?: string;
    name: string;
    transport: "http";
    url?: string;
    enabled?: boolean;
    origin?: ServerOrigin;
  }): McpServerConfig;
  update(id: string, patch: Partial<Omit<McpServerConfig, "id" | "createdAt">>): McpServerConfig;
  remove(id: string): void;
}

export interface InstalledPlugin {
  manifest: PluginManifest;
  enabled: boolean;
  skillIds: string[];
  /** 本插件登记的服务 id（`plugin:<插件 id>:<key>`），卸载/停用按此收口。 */
  serverIds: string[];
  installedAt: string;
  updatedAt: string;
}

export interface InstallResult {
  plugin: InstalledPlugin;
  /** true = 首次安装；false = 覆盖更新 */
  created: boolean;
  added: number;
  updated: number;
  removed: number;
  serversAdded: number;
  serversUpdated: number;
  serversRemoved: number;
}

/** 更新预览：按「物化后的真实状态」算差异，与实际安装语义一致。 */
export interface PluginSkillDiff {
  added: string[];
  changed: string[];
  unchanged: string[];
  removed: string[];
}

export interface PluginServerDiffEntry {
  key: string;
  name: string;
}

export interface PluginServerDiff {
  added: PluginServerDiffEntry[];
  changed: PluginServerDiffEntry[];
  unchanged: PluginServerDiffEntry[];
  removed: PluginServerDiffEntry[];
}

export interface PluginServerConflict {
  id: string;
  name: string;
}

export interface PluginInstallPreview {
  manifest: PluginManifest;
  existing: InstalledPlugin | null;
  skills: PluginSkillDiff;
  servers: PluginServerDiff;
  /** 与手工/Registry 服务撞 id；非空时安装会被拒绝。 */
  conflicts: PluginServerConflict[];
  /** 网络访问主机（含端口），安装前展示。 */
  hosts: string[];
  /** 新插件且已达数量上限；更新不受影响。 */
  limitReached: boolean;
}

export interface PluginSkillInfo {
  id: string;
  name: string;
  description: string;
  enabled: boolean;
}

export interface PluginServerInfo {
  id: string;
  name: string;
  url: string;
  enabled: boolean;
}

/** 稳定的服务 id；`key` 不含冒号，工具键 `serverId::toolName` 的分隔不受影响。 */
export function pluginServerId(pluginId: string, key: string): string {
  return `plugin:${pluginId}:${key}`;
}

/** 从旧记录的服务 id 反推 key；异常 id 原样返回，只用于展示。 */
function serverKeyFromId(pluginId: string, id: string): string {
  const prefix = `plugin:${pluginId}:`;
  return id.startsWith(prefix) ? id.slice(prefix.length) : id;
}

function sameStringList(a: string[], b: string[]): boolean {
  return a.length === b.length && a.every((value, i) => value === b[i]);
}

function sameSkill(
  spec: PluginManifest["skills"][number],
  skill: { description: string; instructions: string; triggers: string[]; tags: string[] },
): boolean {
  return (
    spec.description === skill.description &&
    spec.instructions === skill.instructions &&
    sameStringList(spec.triggers, skill.triggers) &&
    sameStringList(spec.tags, skill.tags)
  );
}

interface PluginData {
  version: 1;
  plugins: InstalledPlugin[];
}

function memoryStorage(): StorageLike {
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

function defaultStorage(): StorageLike {
  try {
    if (typeof localStorage !== "undefined" && localStorage) return localStorage;
  } catch {
    // 个别环境访问 localStorage 本身即抛错 → 退回内存
  }
  return memoryStorage();
}

function uniq(items: string[]): string[] {
  return [...new Set(items.filter(Boolean))];
}

function copyPlugin(plugin: InstalledPlugin): InstalledPlugin {
  return {
    ...plugin,
    manifest: {
      ...plugin.manifest,
      skills: plugin.manifest.skills.map((skill) => ({
        ...skill,
        triggers: [...skill.triggers],
        tags: [...skill.tags],
      })),
      mcpServers: plugin.manifest.mcpServers.map((server) => ({ ...server })),
    },
    skillIds: [...plugin.skillIds],
    serverIds: [...plugin.serverIds],
  };
}

export class PluginStore {
  private readonly storage: StorageLike;
  private readonly skills: SkillPool;
  private readonly now: () => number;
  private readonly mcp: PluginMcpPort;
  private data: PluginData;

  constructor(
    storage?: StorageLike,
    skills?: SkillPool,
    now?: () => number,
    mcp?: PluginMcpPort,
  ) {
    this.storage = storage ?? defaultStorage();
    this.skills = skills ?? skillPool;
    this.now = now ?? (() => Date.now());
    this.mcp = mcp ?? mcpRegistry;
    this.data = this.parse(this.read());
  }

  list(): InstalledPlugin[] {
    return this.data.plugins.map(copyPlugin);
  }

  get(id: string): InstalledPlugin | undefined {
    const found = this.data.plugins.find((p) => p.manifest.id === id);
    return found ? copyPlugin(found) : undefined;
  }

  /**
   * 只读预览：解析清单并对比**当前物化状态**，不写技能、不写服务、不落盘。
   *
   * 差异口径与 `install` 完全一致：按技能名匹配、按服务 key 匹配；
   * 服务 id 被非插件来源占用时只进 `conflicts`，不混进新增/变更。
   */
  preview(input: string | unknown): PluginInstallPreview {
    const manifest = parsePluginManifest(input);
    const existing = this.data.plugins.find((p) => p.manifest.id === manifest.id) ?? null;

    const owned = this.skills.list().filter((s) => s.pluginId === manifest.id);
    const byName = new Map(owned.map((s) => [s.name, s]));
    const skills: PluginSkillDiff = { added: [], changed: [], unchanged: [], removed: [] };
    for (const spec of manifest.skills) {
      const match = byName.get(spec.name);
      if (!match) skills.added.push(spec.name);
      else if (sameSkill(spec, match)) skills.unchanged.push(spec.name);
      else skills.changed.push(spec.name);
      byName.delete(spec.name);
    }
    for (const name of byName.keys()) skills.removed.push(name);

    const conflicts: PluginServerConflict[] = [];
    const servers: PluginServerDiff = { added: [], changed: [], unchanged: [], removed: [] };
    const nextIds = new Set<string>();
    for (const spec of manifest.mcpServers) {
      const id = pluginServerId(manifest.id, spec.key);
      nextIds.add(id);
      const current = this.mcp.get(id);
      if (current && current.origin !== "plugin") {
        conflicts.push({ id, name: current.name });
        continue;
      }
      const entry = { key: spec.key, name: spec.name };
      if (!current) servers.added.push(entry);
      else if (current.name !== spec.name || (current.url ?? "") !== spec.url) {
        servers.changed.push(entry);
      } else servers.unchanged.push(entry);
    }
    for (const oldId of existing?.serverIds ?? []) {
      if (nextIds.has(oldId)) continue;
      const current = this.mcp.get(oldId);
      if (!current || current.origin !== "plugin") continue;
      const key = serverKeyFromId(manifest.id, oldId);
      const oldName =
        existing?.manifest.mcpServers.find((server) => server.key === key)?.name ?? current.name;
      servers.removed.push({ key, name: oldName });
    }

    const hosts: string[] = [];
    for (const spec of manifest.mcpServers) {
      try {
        const { host } = new URL(spec.url);
        if (host && !hosts.includes(host)) hosts.push(host);
      } catch {
        // 清单已校验合法；这里只做展示
      }
    }

    return {
      manifest,
      existing: existing ? copyPlugin(existing) : null,
      skills,
      servers,
      conflicts,
      hosts,
      limitReached: !existing && this.data.plugins.length >= MAX_PLUGINS,
    };
  }

  /** 插件已物化的技能（真实启用位），供详情页展示。 */
  skillsOf(pluginId: string): PluginSkillInfo[] {
    const plugin = this.data.plugins.find((p) => p.manifest.id === pluginId);
    if (!plugin) return [];
    const out: PluginSkillInfo[] = [];
    for (const id of plugin.skillIds) {
      const skill = this.skills.get(id);
      if (skill) {
        out.push({
          id: skill.id,
          name: skill.name,
          description: skill.description,
          enabled: skill.enabled,
        });
      }
    }
    return out;
  }

  /** 插件登记且仍归插件所有的服务（真实启用位），供详情页展示。 */
  serversOf(pluginId: string): PluginServerInfo[] {
    const plugin = this.data.plugins.find((p) => p.manifest.id === pluginId);
    if (!plugin) return [];
    const out: PluginServerInfo[] = [];
    for (const id of plugin.serverIds) {
      const server = this.mcp.get(id);
      if (server && server.origin === "plugin") {
        out.push({
          id: server.id,
          name: server.name,
          url: server.url ?? "",
          enabled: server.enabled,
        });
      }
    }
    return out;
  }

  /**
   * 安装或更新。同一 `id` 再次安装视为更新：
   * 同名技能原地刷新、新增技能创建、清单里消失的技能删除；启用状态保留用户选择。
   * 清单不合法或数量超限时抛错，不落盘。
   */
  install(input: string | unknown): InstallResult {
    const manifest = parsePluginManifest(input);
    const index = this.data.plugins.findIndex((p) => p.manifest.id === manifest.id);
    if (index < 0 && this.data.plugins.length >= MAX_PLUGINS) {
      throw new PluginManifestError(
        `插件数量已达上限（${MAX_PLUGINS} 个），请先卸载不用的插件`,
      );
    }

    // 服务 id 冲突必须在写入技能之前查完：否则会把技能改了一半再失败。
    const nextServerIds = manifest.mcpServers.map((spec) =>
      pluginServerId(manifest.id, spec.key),
    );
    for (const id of nextServerIds) {
      const current = this.mcp.get(id);
      if (current && current.origin !== "plugin") {
        throw new PluginManifestError(
          `MCP 服务 id 冲突：${id} 已被其它来源的服务占用，请先在接口区删除或改名`,
        );
      }
    }

    const existing = index >= 0 ? this.data.plugins[index] : undefined;
    const enabled = existing?.enabled ?? true;
    const owned = this.skills.list().filter((s) => s.pluginId === manifest.id);
    const byName = new Map(owned.map((s) => [s.name, s]));
    const nextNames = new Set(manifest.skills.map((s) => s.name));

    let added = 0;
    let updated = 0;
    let removed = 0;
    const skillIds: string[] = [];
    const createdIds: string[] = [];

    for (const spec of manifest.skills) {
      const match = byName.get(spec.name);
      if (match) {
        this.skills.update(match.id, {
          description: spec.description,
          instructions: spec.instructions,
          triggers: [...spec.triggers],
          tags: [...spec.tags],
          version: manifest.version,
          source: "imported",
          enabled,
        });
        skillIds.push(match.id);
        updated += 1;
      } else {
        const created = this.skills.create({
          name: spec.name,
          description: spec.description,
          instructions: spec.instructions,
          triggers: [...spec.triggers],
          tags: [...spec.tags],
          enabled,
          version: manifest.version,
          source: "imported",
          pluginId: manifest.id,
        });
        skillIds.push(created.id);
        createdIds.push(created.id);
        added += 1;
      }
    }

    for (const skill of owned) {
      if (!nextNames.has(skill.name)) {
        this.skills.remove(skill.id);
        removed += 1;
      }
    }

    // 新技能追加给已有显式分配记录的智能体；无记录者由默认分配（内置 + 插件）覆盖。
    if (createdIds.length > 0) this.skills.assignToAllWithAssignments(createdIds);

    // 服务随包登记：只覆盖名称/地址/启用位，**保留用户在接口区补的请求头**
    // 与已启用的工具集合——那是用户配置，不属于清单。
    let serversAdded = 0;
    let serversUpdated = 0;
    let serversRemoved = 0;
    for (const spec of manifest.mcpServers) {
      const id = pluginServerId(manifest.id, spec.key);
      if (this.mcp.get(id)) {
        this.mcp.update(id, {
          name: spec.name,
          transport: "http",
          url: spec.url,
          enabled,
          origin: "plugin",
        });
        serversUpdated += 1;
      } else {
        this.mcp.add({
          id,
          name: spec.name,
          transport: "http",
          url: spec.url,
          enabled,
          origin: "plugin",
        });
        serversAdded += 1;
      }
    }

    const nextServerSet = new Set(nextServerIds);
    for (const oldId of existing?.serverIds ?? []) {
      if (nextServerSet.has(oldId)) continue;
      const current = this.mcp.get(oldId);
      if (current && current.origin === "plugin") {
        this.mcp.remove(oldId);
        serversRemoved += 1;
      }
    }

    const at = this.iso();
    const plugin: InstalledPlugin = {
      manifest,
      enabled,
      skillIds,
      serverIds: nextServerIds,
      installedAt: existing?.installedAt ?? at,
      updatedAt: at,
    };
    if (index >= 0) this.data.plugins[index] = plugin;
    else this.data.plugins.push(plugin);
    this.save();

    return {
      plugin: copyPlugin(plugin),
      created: !existing,
      added,
      updated,
      removed,
      serversAdded,
      serversUpdated,
      serversRemoved,
    };
  }

  /** 启停插件：同步其全部技能与 MCP 服务的启用位（数据、分配与请求头保留）。 */
  setEnabled(id: string, enabled: boolean): void {
    const plugin = this.data.plugins.find((p) => p.manifest.id === id);
    if (!plugin) throw new Error(`插件不存在：${id}`);
    plugin.enabled = enabled;
    plugin.updatedAt = this.iso();
    for (const skillId of plugin.skillIds) {
      // 技能可能已被用户在技能区单独删除；缺了就跳过，不让插件页卡死
      if (this.skills.get(skillId)) this.skills.setEnabled(skillId, enabled);
    }
    for (const serverId of plugin.serverIds) {
      const current = this.mcp.get(serverId);
      if (current && current.origin === "plugin") {
        this.mcp.update(serverId, { enabled });
      }
    }
    this.save();
  }

  /** 卸载插件：删除其全部技能（含使用统计与绑定）与 MCP 服务，再删记录。 */
  remove(id: string): void {
    const plugin = this.data.plugins.find((p) => p.manifest.id === id);
    if (!plugin) return;
    for (const skillId of plugin.skillIds) this.skills.remove(skillId);
    for (const serverId of plugin.serverIds) {
      const current = this.mcp.get(serverId);
      // 只删仍标记为插件来源的服务：用户若把它改成手填，视为用户资产。
      if (current && current.origin === "plugin") this.mcp.remove(serverId);
    }
    this.data.plugins = this.data.plugins.filter((p) => p.manifest.id !== id);
    this.save();
  }

  private iso(): string {
    return new Date(this.now()).toISOString();
  }

  private read(): string | null {
    try {
      return this.storage.getItem(PLUGINS_KEY);
    } catch {
      return null;
    }
  }

  private save(): void {
    try {
      this.storage.setItem(PLUGINS_KEY, JSON.stringify(this.data));
    } catch {
      // 写失败静默：配额/隐私模式下不影响本次会话的内存态
    }
  }

  private parse(raw: string | null): PluginData {
    if (!raw) return { version: 1, plugins: [] };
    try {
      const parsed: unknown = JSON.parse(raw);
      if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) {
        throw new Error("bad");
      }
      const list = (parsed as Record<string, unknown>).plugins;
      if (!Array.isArray(list)) throw new Error("bad");
      const plugins: InstalledPlugin[] = [];
      for (const item of list) {
        const plugin = this.coerce(item);
        if (plugin && !plugins.some((p) => p.manifest.id === plugin.manifest.id)) {
          plugins.push(plugin);
        }
      }
      return { version: 1, plugins };
    } catch {
      // 整体损坏视为空表；技能池里的插件技能仍可用，用户重装即可恢复归属
      return { version: 1, plugins: [] };
    }
  }

  private coerce(raw: unknown): InstalledPlugin | null {
    if (!raw || typeof raw !== "object" || Array.isArray(raw)) return null;
    const r = raw as Record<string, unknown>;
    let manifest: PluginManifest;
    try {
      manifest = parsePluginManifest(r.manifest);
    } catch {
      return null; // 单条损坏只丢这条插件，不影响其它插件
    }
    const at = this.iso();
    return {
      manifest,
      enabled: r.enabled !== false,
      skillIds: Array.isArray(r.skillIds)
        ? uniq(r.skillIds.filter((x): x is string => typeof x === "string"))
        : [],
      serverIds: Array.isArray(r.serverIds)
        ? uniq(r.serverIds.filter((x): x is string => typeof x === "string"))
        : [],
      installedAt: typeof r.installedAt === "string" ? r.installedAt : at,
      updatedAt: typeof r.updatedAt === "string" ? r.updatedAt : at,
    };
  }
}
