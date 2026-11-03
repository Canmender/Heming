import { skillPool, type SkillPool, type StorageLike } from "../skills/index.js";
import { mcpRegistry, type McpServerConfig, type ServerOrigin } from "../mcp/index.js";
import {
  parsePluginManifest,
  PluginManifestError,
  type PluginCommandSpec,
  type PluginManifest,
} from "./manifest.js";
import { pluginIdFromServerId } from "./permissions.js";
import { contentFingerprint, FINGERPRINT_PREFIX } from "./integrity.js";

// 目录（catalog）与命令面板都从插件侧反解服务归属，统一从本模块导出，
// 避免两处各写一份 `plugin:` 前缀解析而漂移。
export { pluginIdFromServerId } from "./permissions.js";

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
  /**
   * 安装时的清单**内容指纹**（`fnv1a64:…`，见 `integrity.ts`）。
   *
   * 只用来发现「同 id 同版本但内容被悄悄改过」，不是签名、不证明来源。
   * 旧版本应用留下的记录没有该字段，读取时补算并落盘（不视为损坏）。
   */
  fingerprint: string;
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

/**
 * 安装前的信任预览（d.66 覆盖保护）。
 *
 * 只看**清单内容**，不碰文件/网络：作者变了、或同版本内容变了，才是需要人
 * 显式确认的覆盖更新；首次安装与正常的版本升级沿用既有差异预览。
 */
export interface PluginTrustPreview {
  /** 本次清单的指纹。 */
  fingerprint: string;
  /** 已装版本的指纹；首次安装为 null。 */
  previousFingerprint: string | null;
  /** 同 id 同 version 但内容变了（最需要人看一眼的情况）。 */
  sameVersionContentChanged: boolean;
  authorChanged: boolean;
  previousAuthor: string | null;
  versionChanged: boolean;
  /** 需要用户在安装弹窗显式勾选「我已确认这次覆盖更新」才能继续。 */
  needsConfirm: boolean;
}

export interface PluginInstallPreview {
  manifest: PluginManifest;
  existing: InstalledPlugin | null;
  skills: PluginSkillDiff;
  servers: PluginServerDiff;
  /** 与手工/Registry 服务撞 id；非空时安装会被拒绝。 */
  conflicts: PluginServerConflict[];
  /** 网络访问主机（含端口），安装前展示；口径来自归一化后的 `permissions.network`。 */
  hosts: string[];
  /** 信任与覆盖保护提示（d.66）。 */
  trust: PluginTrustPreview;
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

/** 插件贡献计数（插件卡「贡献」行与安装弹窗摘要共用）。 */
export interface PluginContributionCounts {
  skills: number;
  servers: number;
  commands: number;
  /** 工具束数量（d.65 增补；老插件缺省 0）。 */
  toolPacks: number;
  /** 全部工具束里声明的工具名总数（按声明计，不代表已连接）。 */
  packTools: number;
}

/** 插件命令：命令面板用的执行入口（`id` 已加 `plugin:<插件 id>:` 前缀，全局唯一）。 */
export interface PluginCommandInfo {
  /** `plugin:<pluginId>:<commandId>`。 */
  id: string;
  pluginId: string;
  pluginName: string;
  title: string;
  description: string;
  keywords: string[];
  target: PluginCommandSpec["target"];
}

/** 稳定的服务 id；`key` 不含冒号，工具键 `serverId::toolName` 的分隔不受影响。 */
export function pluginServerId(pluginId: string, key: string): string {
  return `plugin:${pluginId}:${key}`;
}

/** 从旧记录的服务 id 反推 key；异常 id 原样返回，只用于展示。 */
function serverKeyFromId(pluginId: string, id: string): string {
  if (pluginIdFromServerId(id) === pluginId) {
    return id.slice(`plugin:${pluginId}:`.length);
  }
  return id;
}

function sameStringList(a: string[], b: string[]): boolean {
  return a.length === b.length && a.every((value, i) => value === b[i]);
}

function sameSkill(
  spec: PluginManifest["contributions"]["skills"][number],
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
  const { contributions, permissions } = plugin.manifest;
  return {
    ...plugin,
    manifest: {
      ...plugin.manifest,
      contributions: {
        skills: contributions.skills.map((skill) => ({
          ...skill,
          triggers: [...skill.triggers],
          tags: [...skill.tags],
        })),
        mcpServers: contributions.mcpServers.map((server) => ({ ...server })),
        commands: contributions.commands.map((command) => ({
          ...command,
          keywords: [...command.keywords],
          target: { ...command.target },
        })),
        toolPacks: contributions.toolPacks.map((pack) => ({ ...pack, tools: [...pack.tools] })),
      },
      permissions: {
        network: [...permissions.network],
        tools: permissions.tools,
        files: [...permissions.files],
      },
    },
    skillIds: [...plugin.skillIds],
    serverIds: [...plugin.serverIds],
  };
}

/**
 * 读回本机存储里的清单。
 *
 * 存的是**归一化后的 v3 形状**（`contributions` / `permissions`），但 `schemaVersion`
 * 保留原始值（v1/v2 包要能在界面上标「旧版清单」）。直接交给 `parsePluginManifest`
 * 会按旧版规则去找顶层 `skills`，必然解析失败；所以先按 v3 解析再把版本号还原。
 * 旧版本应用留下的记录（顶层 skills、无 contributions）仍走原来的旧版解析路径。
 */
function parseStoredManifest(raw: unknown): PluginManifest {
  if (raw && typeof raw === "object" && !Array.isArray(raw)) {
    const record = raw as Record<string, unknown>;
    if ("contributions" in record || "permissions" in record) {
      const version = record.schemaVersion;
      const parsed = parsePluginManifest({ ...record, schemaVersion: 3 });
      const legacy = version === 1 || version === 2;
      return legacy ? { ...parsed, schemaVersion: version } : parsed;
    }
  }
  return parsePluginManifest(raw);
}

export class PluginStore {
  private readonly storage: StorageLike;
  private readonly skills: SkillPool;
  private readonly now: () => number;
  private readonly mcp: PluginMcpPort;
  private data: PluginData;
  /** 读取时发现旧记录缺指纹 → 构造完成后补写一次（不视为错误）。 */
  private backfilledFingerprint = false;

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
    if (this.backfilledFingerprint) this.save();
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
    for (const spec of manifest.contributions.skills) {
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
    for (const spec of manifest.contributions.mcpServers) {
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
        existing?.manifest.contributions.mcpServers.find((server) => server.key === key)?.name ?? current.name;
      servers.removed.push({ key, name: oldName });
    }

    // 主机的「已声明」口径与解析期一致：v3 直接读 permissions.network，
    // v1/v2 归一化时已由服务 URL 推导并补全，这里不再二次推导，避免两套口径。
    const hosts = [...manifest.permissions.network];

    const fingerprint = contentFingerprint(manifest);
    const previousFingerprint = existing?.fingerprint || null;
    // 「同版本内容变了」只对同 id 同 version 有意义：正常升级的内容差异
    // 已经由技能/服务差异预览覆盖，再叠加一个红字只会制造噪声。
    const sameVersionContentChanged =
      existing != null &&
      existing.manifest.version === manifest.version &&
      previousFingerprint !== fingerprint;
    const authorChanged = existing != null && existing.manifest.author !== manifest.author;
    const trust: PluginTrustPreview = {
      fingerprint,
      previousFingerprint,
      sameVersionContentChanged,
      authorChanged,
      previousAuthor: existing ? existing.manifest.author : null,
      versionChanged: existing != null && existing.manifest.version !== manifest.version,
      needsConfirm: existing != null && (authorChanged || sameVersionContentChanged),
    };

    return {
      manifest,
      existing: existing ? copyPlugin(existing) : null,
      skills,
      servers,
      conflicts,
      hosts,
      trust,
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

  /** 贡献计数（技能 / 服务 / 命令 / 工具束·工具）：插件卡与安装弹窗的摘要都用它。 */
  contributionCounts(pluginId: string): PluginContributionCounts {
    const plugin = this.data.plugins.find((p) => p.manifest.id === pluginId);
    if (!plugin) return { skills: 0, servers: 0, commands: 0, toolPacks: 0, packTools: 0 };
    const { skills, mcpServers, commands, toolPacks } = plugin.manifest.contributions;
    return {
      skills: skills.length,
      servers: mcpServers.length,
      commands: commands.length,
      toolPacks: toolPacks.length,
      packTools: toolPacks.reduce((sum, pack) => sum + pack.tools.length, 0),
    };
  }

  /**
   * 命令面板用的插件命令。
   *
   * 只列**启用中**插件的命令：停用插件 = 它的技能/服务都不可用，
   * 命令若还能触发就是绕过停用语义（面板入口必须和执行面同口径）。
   */
  commands(): PluginCommandInfo[] {
    const out: PluginCommandInfo[] = [];
    for (const plugin of this.data.plugins) {
      if (!plugin.enabled) continue;
      for (const command of plugin.manifest.contributions.commands) {
        out.push({
          id: pluginServerId(plugin.manifest.id, command.id),
          pluginId: plugin.manifest.id,
          pluginName: plugin.manifest.name,
          title: command.title,
          description: command.description,
          keywords: [...command.keywords],
          target: { ...command.target },
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
    const nextServerIds = manifest.contributions.mcpServers.map((spec) =>
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
    const nextNames = new Set(manifest.contributions.skills.map((s) => s.name));

    let added = 0;
    let updated = 0;
    let removed = 0;
    const skillIds: string[] = [];
    const createdIds: string[] = [];

    for (const spec of manifest.contributions.skills) {
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
    for (const spec of manifest.contributions.mcpServers) {
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
      fingerprint: contentFingerprint(manifest),
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
      manifest = parseStoredManifest(r.manifest);
    } catch {
      return null; // 单条损坏只丢这条插件，不影响其它插件
    }
    const at = this.iso();
    // 指纹算法版本：只有 `fnv1a64b:` 前缀才算当前算法。旧前缀（含 d.64.2.23.0
    // 的 `fnv1a64:`）按新算法重算并落盘——否则算法升级会让所有已装插件在下次
    // 安装预览里假告警「内容与上次不同」。用户手工改过存储里的清单仍会被抓到：
    // 重算基于存储中的真实清单，改过的内容自然对不上安装记录里的清单。
    const rawFingerprint =
      typeof r.fingerprint === "string" && r.fingerprint.startsWith(FINGERPRINT_PREFIX)
        ? r.fingerprint
        : null;
    if (!rawFingerprint) this.backfilledFingerprint = true;
    return {
      manifest,
      enabled: r.enabled !== false,
      fingerprint: rawFingerprint ?? contentFingerprint(manifest),
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

/**
 * 模块级单例：插件记录只本机存储（`heming.plugins.v1`），
 * 技能物化到共用的 `skillPool`，与技能区/聊天路由同一份技能事实。
 *
 * ★ 单例放在 store 而不是 `index.ts`：能力目录（`catalog.ts`）也要读它，
 * 若从 `index.ts` 取会形成 index → catalog → index 的循环导入——
 * 循环在 ESM 里能跑，但初始化顺序一变 `pluginStore` 就可能是 undefined。
 */
export const pluginStore = new PluginStore();
