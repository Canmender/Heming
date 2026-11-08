import type { StorageLike } from "../memory/types.js";
import {
  hasSecureBridge,
  onSecureHydrated,
  secureStorageFor,
  secureStorageStatus,
  secureStorageHydrated,
} from "../secureStorage.js";
import type { McpServerConfig, McpTool, McpToolRef, McpTransport } from "./types.js";
import { DEFAULT_PRESET_SERVERS, presetServerId } from "./presets.js";

/** 存储键（带版本，便于将来迁移）。 */
export const MCP_SERVERS_KEY = "heming.mcp.servers.v1";
export const MCP_TOOLS_KEY = "heming.mcp.tools.v1";
/** 已启用的工具（`serverId::toolName`），**默认不启用**：工具可能有副作用，必须显式打开。 */
export const MCP_ENABLED_TOOLS_KEY = "heming.mcp.enabledTools.v1";
/**
 * 被用户删掉过的预置服务 id（`heming.mcp.removedPresets.v1`）。
 *
 * 为什么需要单独记：删掉最后一条服务后列表为空，如果不记这个，
 * 下次启动会被「存储为空 → 预置」的条件重新塞回来——用户就删不掉了。
 * 所以删除预置时在此记一笔，预置逻辑见到记录就跳过。
 */
export const MCP_REMOVED_PRESETS_KEY = "heming.mcp.removedPresets.v1";
/**
 * 用户明确关掉过的预置工具（`heming.mcp.userDisabled.v1`）：
 * `{ [serverId]: string[] }`。
 *
 * 存在的理由：预置服务会自动启用只读工具，但用户可能不想让模型看屏幕。
 * enabled 集合里「没有」既可能是从未启用、也可能是用户主动关掉——
 * 不额外记一份，就会被自动启用逻辑当成前者而重新打开，等于静默推翻用户的选择。
 */
export const MCP_USER_DISABLED_KEY = "heming.mcp.userDisabled.v1";

/** 浏览器/桌面共用的 localStorage 适配：配额与隐私模式都不抛。 */
function browserStorage(): StorageLike {
  return {
    getItem: (k) => {
      try {
        return window.localStorage.getItem(k);
      } catch {
        return null;
      }
    },
    setItem: (k, v) => {
      try {
        window.localStorage.setItem(k, v);
      } catch {
        /* 配额/隐私模式：只影响持久化，不影响本次会话 */
      }
    },
    removeItem: (k) => {
      try {
        window.localStorage.removeItem(k);
      } catch {
        /* 同上 */
      }
    },
  };
}

function defaultStorage(): StorageLike {
  // 只加密服务配置（里面有用户自填的请求头 token）；
  // 工具清单/启用状态不是凭据，直通 localStorage，避免无谓的 IPC。
  // 安全键的写入失败必须冒泡给 secure 层（配额耗尽要如实标成明文），
  // 其它键仍用吞错的 browserStorage，保持旧的容错行为。
  const base = browserStorage();
  return secureStorageFor(MCP_SERVERS_KEY, {
    getItem: (k) => base.getItem(k),
    setItem: (k, v) => window.localStorage.setItem(k, v),
    removeItem: (k) => base.removeItem(k),
  });
}

/** 工具唯一键：`serverId::toolName`。 */
export function toolKey(serverId: string, toolName: string): string {
  return `${serverId}::${toolName}`;
}

const TRANSPORTS: McpTransport[] = ["http", "stdio"];

function coerceServer(raw: unknown, now: string): McpServerConfig | null {
  if (!raw || typeof raw !== "object") return null;
  const r = raw as Record<string, unknown>;
  if (typeof r.id !== "string" || !r.id) return null;
  if (typeof r.name !== "string" || !r.name) return null;
  const transport = TRANSPORTS.includes(r.transport as McpTransport)
    ? (r.transport as McpTransport)
    : "http";
  const headers: Record<string, string> = {};
  if (r.headers && typeof r.headers === "object") {
    for (const [k, v] of Object.entries(r.headers as Record<string, unknown>)) {
      if (typeof v === "string" && k) headers[k] = v;
    }
  }
  return {
    id: r.id,
    name: r.name,
    transport,
    url: typeof r.url === "string" ? r.url : undefined,
    command: typeof r.command === "string" ? r.command : undefined,
    args: Array.isArray(r.args) ? r.args.filter((a): a is string => typeof a === "string") : undefined,
    headers: Object.keys(headers).length ? headers : undefined,
    enabled: r.enabled !== false,
    // 来源与 Registry 名：缺省视为手填（兼容旧数据）。
    // ★ 这两个字段必须在这里显式透传——coerceServer 做的是字段白名单，
    //   不写就会**被直接丢掉**，Registry 装的服务会退化成「手填」而看不出是哪来的。
    origin: r.origin === "preset" || r.origin === "manual" || r.origin === "registry" || r.origin === "plugin"
      ? r.origin
      : "manual",
    registryName: typeof r.registryName === "string" && r.registryName ? r.registryName : undefined,
    // 本地包台账（d.25）：同样是白名单字段，不写就会被丢掉。
    registryType: typeof r.registryType === "string" && r.registryType ? r.registryType : undefined,
    registryVersion: typeof r.registryVersion === "string" && r.registryVersion ? r.registryVersion : undefined,
    createdAt: typeof r.createdAt === "string" ? r.createdAt : now,
    updatedAt: typeof r.updatedAt === "string" ? r.updatedAt : now,
  };
}

function coerceTool(raw: unknown): McpTool | null {
  if (!raw || typeof raw !== "object") return null;
  const r = raw as Record<string, unknown>;
  if (typeof r.name !== "string" || !r.name) return null;
  // annotations 必须原样带过：HITL 闸门靠它判只读/危险，
  // 读回时丢了这个字段，服务端明明声明了「只读」也会被当成 write 多问一次。
  const ann = r.annotations as Record<string, unknown> | undefined;
  return {
    name: r.name,
    description: typeof r.description === "string" ? r.description : undefined,
    inputSchema:
      r.inputSchema && typeof r.inputSchema === "object"
        ? (r.inputSchema as McpTool["inputSchema"])
        : undefined,
    ...(ann && typeof ann === "object"
      ? {
          annotations: {
            ...(typeof ann.readOnlyHint === "boolean" ? { readOnlyHint: ann.readOnlyHint } : {}),
            ...(typeof ann.destructiveHint === "boolean"
              ? { destructiveHint: ann.destructiveHint }
              : {}),
          },
        }
      : {}),
  };
}

/**
 * MCP 服务与工具的本地注册表（单一实例挂在 `mcpRegistry`）。
 *
 * 只做「配置 + 工具清单 + 启用开关」的持久化；**连接与调用**在 `httpClient.ts`，
 * 二者分离后本类可在 node 环境直接单测（注入内存 StorageLike）。
 */
export class McpRegistry {
  private readonly storage: StorageLike;
  private readonly now: () => string;
  private serverList: McpServerConfig[];
  private toolMap: Record<string, McpTool[]>;
  private enabled: Set<string>;
  /**
   * 启动时序（d.59）：用户在本进程里**已经改过服务列表**（新增/修改/删除）。
   * 一旦为真，hydrate 完成后不再重读安全键——内存就是最新值，重读会把用户刚改的冲掉。
   */
  private serversMutated = false;

  constructor(storage: StorageLike = defaultStorage(), now: () => string = () => new Date().toISOString()) {
    this.storage = storage;
    this.now = now;
    this.serverList = this.readServers();
    this.toolMap = this.readTools();
    this.enabled = this.readEnabled();
    /*
     * 启动时序（d.59）：hydrate 未完成时 `readServers()` 可能只是「缓存未命中」的空表，
     * 与「真的没有服务」无法区分。Electron 46 没有同步桥兜底，此时 `seedDefaults()`
     * 会把预置写盘、覆盖磁盘上的密文配置（用户请求头 token 一起丢）。
     * 所以这里推迟预置，等 hydrate 完成后由 `refreshAfterHydrate()` 重新判断。
     * 浏览器（无桥）没有这个问题，行为不变。
     */
    if (secureStorageHydrated() || !hasSecureBridge()) {
      this.seedDefaults();
    }
  }

  /**
   * 首次使用时预置默认服务（用户要求「默认接入」Windows 桌面控制）。
   *
   * 两条守卫，缺一不可：
   * 1. 只在**存储里完全没有 MCP 服务**时执行——用户已经配过就别插手；
   * 2. 跳过被用户**删过**的预置（见 MCP_REMOVED_PRESETS_KEY）——
   *    只靠条件 1 的话，删掉最后一条服务会让列表变空，下次启动又被塞回来，
   *    用户就永远删不掉它了。
   */
  private seedDefaults(): void {
    if (this.serverList.length > 0) return;
    // 键存在但解不开（keyring 重置 / 换系统账户 / 密文损坏）时 readServers 只能
    // 读出空表；此时若继续预置并落盘，会把用户原有服务与请求头**永久覆盖**。
    // 宁可这一轮显示空，也不动磁盘上的密文——升级回原账户还能恢复。
    if (secureStorageStatus().undecryptableKeys.includes(MCP_SERVERS_KEY)) return;
    const removed = this.readRemovedPresets();
    const at = this.now();
    let changed = false;
    for (const preset of DEFAULT_PRESET_SERVERS) {
      // 每条预置有各自的固定 id（删除记录、isPreset 判定都按 id 走）
      const id = presetServerId(preset.id);
      if (removed.has(id)) continue;
      this.serverList.push({
        id,
        name: preset.name,
        transport: preset.transport,
        url: preset.url,
        command: preset.command,
        args: preset.args ? [...preset.args] : undefined,
        enabled: true,
        createdAt: at,
        updatedAt: at,
      });
      changed = true;
    }
    if (changed) this.saveServers();
  }

  /**
   * hydrate 完成后补一次读（启动门禁 `onSecureHydrated` 会调；测试可手动调）。
   *
   * 合并规则（与 `store/llm.ts` 同一套思路）：
   * 1. 用户已经改过服务列表（`serversMutated`）→ **不重读**，内存即最新（写路径已落盘）；
   * 2. 否则重读安全键；读到空才补此前被推迟的预置（`seedDeferred`）。
   *
   * 任何情况下都不会删改磁盘上的密文：读不到时仍按空表展示，由 secure 层标记
   * `undecryptableKeys`（d.36 口径：密文留在原地，换回原账户还能恢复）。
   */
  refreshAfterHydrate(): void {
    if (this.serversMutated) return;
    this.serverList = this.readServers();
    this.toolMap = this.readTools();
    this.enabled = this.readEnabled();
    if (this.serverList.length === 0) this.seedDefaults();
  }

  /**
   * 重新读本机存储并重建内存态（安装事务回滚后必须调）。
   *
   * 照 `refreshAfterHydrate` 的读法重建三份内存数据，但**不**做启动时序判断、
   * 也**不**重放预置（`seedDefaults`）——回滚场景要的是「存储是什么，内存就是什么」，
   * 顺带写盘会把刚恢复的快照又改掉。`serversMutated` 一并复位。
   */
  reload(): void {
    this.serverList = this.readServers();
    this.toolMap = this.readTools();
    this.enabled = this.readEnabled();
    this.serversMutated = false;
  }

  private readRemovedPresets(): Set<string> {
    const raw = this.storage.getItem(MCP_REMOVED_PRESETS_KEY);
    if (!raw) return new Set();
    try {
      const parsed: unknown = JSON.parse(raw);
      return Array.isArray(parsed)
        ? new Set(parsed.filter((x): x is string => typeof x === "string"))
        : new Set();
    } catch {
      return new Set();
    }
  }

  private writeRemovedPresets(set: Set<string>): void {
    this.storage.setItem(MCP_REMOVED_PRESETS_KEY, JSON.stringify([...set]));
  }

  /**
   * 预置服务发现完工具后，把只读那批自动启用（见 McpPreset.safeTools）。
   *
   * **用户关掉的不再打开**：enabled 是「已启用集合」，关掉的工具不在里面，
   * 只按 `has(key)` 判重会把它当成「从未配置」而重新启用——
   * 等于用户的选择被静默推翻。所以这里额外查 `disabledPresets`：一旦用户
   * 明确关过某工具，就记下来，之后不再自动开（要恢复得他再手动勾一次）。
   */
  autoEnableSafeTools(serverId: string, tools: McpTool[]): string[] {
    // 非预置服务一律不自动启用：第三方服务的工具名可能与白名单撞名
    // （比如人家也有个叫 Screenshot 的），开错等于给了没预期的权限。
    if (!this.isPreset(serverId)) return [];
    // 按**服务 id**反查所属预设：不同预置的白名单不同
    // （Windows-MCP 是 Screenshot/Snapshot，Scrapling 是 make_request 那一批）。
    const preset = DEFAULT_PRESET_SERVERS.find((p) => presetServerId(p.id) === serverId);
    const safe = new Set(preset?.safeTools ?? []);
    if (!safe.size) return [];
    const userOff = this.readUserDisabled(serverId);
    const enabled: string[] = [];
    for (const tool of tools) {
      if (!safe.has(tool.name)) continue;
      const key = toolKey(serverId, tool.name);
      if (this.enabled.has(key) || userOff.has(tool.name)) continue;
      this.enabled.add(key);
      enabled.push(tool.name);
    }
    if (enabled.length) this.saveEnabled();
    return enabled;
  }

  /** 读「用户明确关掉过」的只读工具（serverId + 工具名）。 */
  private readUserDisabled(serverId: string): Set<string> {
    const raw = this.storage.getItem(MCP_USER_DISABLED_KEY);
    if (!raw) return new Set();
    try {
      const parsed: unknown = JSON.parse(raw);
      const list =
        parsed && typeof parsed === "object" && !Array.isArray(parsed)
          ? ((parsed as Record<string, unknown>)[serverId] as unknown)
          : null;
      return Array.isArray(list)
        ? new Set(list.filter((x): x is string => typeof x === "string"))
        : new Set();
    } catch {
      return new Set();
    }
  }

  private writeUserDisabled(serverId: string, names: Set<string>): void {
    try {
      const raw = JSON.parse(this.storage.getItem(MCP_USER_DISABLED_KEY) ?? "{}") as Record<
        string,
        unknown
      >;
      if (names.size) raw[serverId] = [...names];
      else delete raw[serverId];
      this.storage.setItem(MCP_USER_DISABLED_KEY, JSON.stringify(raw));
    } catch {
      /* 存不下只影响「记住关掉」这件事，不影响本次生效 */
    }
  }

  /** 该服务是否属于预置（界面据此标注「默认接入」）。 */
  isPreset(serverId: string): boolean {
    return DEFAULT_PRESET_SERVERS.some((p) => presetServerId(p.id) === serverId);
  }

  /**
   * 被用户删掉过的预置服务 id（按预置顺序）。
   *
   * 界面据此决定要不要显示「恢复预置服务」：删过才显示，没删过不占地方。
   */
  removedPresetIds(): string[] {
    const removed = this.readRemovedPresets();
    return DEFAULT_PRESET_SERVERS.map((p) => presetServerId(p.id)).filter((id) => removed.has(id));
  }

  /**
   * 恢复预置服务（d.77）：把「用户删掉的预置」补回来。
   *
   * 为什么需要它：`remove()` 会把预置 id 记进 removedPresets，之后 `seedDefaults()`
   * 永不再补——初衷是「用户能真正删掉它」，但界面上没有回退路径，删错了就只能手填。
   * 这里给出显式的找回动作，语义是**可逆的删除**：
   * 1. 清掉这些 id 的删除记录（再删一次仍然记得住）；
   * 2. 只补**当前列表里确实没有**的预置，且**同名服务已存在时不覆盖**——
   *    用户手填了同名服务时，不能拿预置去顶掉他的配置；
   * 3. 不动其它服务的工具授权与请求头。
   *
   * @returns 本次真正补回的条数（已存在的不算）
   */
  restorePresets(): number {
    const removed = this.readRemovedPresets();
    const before = [...removed].sort().join(",");
    const at = this.now();
    let restored = 0;
    for (const preset of DEFAULT_PRESET_SERVERS) {
      const id = presetServerId(preset.id);
      removed.delete(id);
      const hasSameId = this.serverList.some((s) => s.id === id);
      const hasSameName = this.serverList.some((s) => s.name.trim() === preset.name.trim());
      if (hasSameId || hasSameName) continue;
      this.serverList = [
        ...this.serverList,
        {
          id,
          name: preset.name,
          transport: preset.transport,
          url: preset.url,
          command: preset.command,
          args: preset.args ? [...preset.args] : undefined,
          enabled: true,
          createdAt: at,
          updatedAt: at,
        },
      ];
      restored += 1;
    }
    if (restored > 0) {
      this.serversMutated = true;
      this.saveServers();
    }
    // 删除记录也要落盘：哪怕这次一条都没补（已被同名服务顶替），
    // 记录清掉才能让「以后再删一次」重新被记住。
    if ([...removed].sort().join(",") !== before) this.writeRemovedPresets(removed);
    return restored;
  }

  private readServers(): McpServerConfig[] {
    const raw = this.storage.getItem(MCP_SERVERS_KEY);
    if (!raw) return [];
    try {
      const parsed: unknown = JSON.parse(raw);
      if (!Array.isArray(parsed)) return [];
      return parsed.map((x) => coerceServer(x, this.now())).filter((x): x is McpServerConfig => !!x);
    } catch {
      return [];
    }
  }

  private readTools(): Record<string, McpTool[]> {
    const raw = this.storage.getItem(MCP_TOOLS_KEY);
    if (!raw) return {};
    try {
      const parsed: unknown = JSON.parse(raw);
      if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) return {};
      const out: Record<string, McpTool[]> = {};
      for (const [serverId, list] of Object.entries(parsed as Record<string, unknown>)) {
        if (!Array.isArray(list)) continue;
        const tools = list.map(coerceTool).filter((t): t is McpTool => !!t);
        // 空清单也记下来：`if (tools.length)` 会让「连上了但一个工具都没有」
        // 与「还没连过」在读回后无法区分，界面会把前者显示成「未连接」，
        // 用户于是又得点一次连接——正好是自动连接想省掉的那一步。
        out[serverId] = tools;
      }
      return out;
    } catch {
      return {};
    }
  }

  private readEnabled(): Set<string> {
    const raw = this.storage.getItem(MCP_ENABLED_TOOLS_KEY);
    if (!raw) return new Set();
    try {
      const parsed: unknown = JSON.parse(raw);
      if (!Array.isArray(parsed)) return new Set();
      return new Set(parsed.filter((x): x is string => typeof x === "string"));
    } catch {
      return new Set();
    }
  }

  private saveServers(): void {
    this.storage.setItem(MCP_SERVERS_KEY, JSON.stringify(this.serverList));
  }

  private saveTools(): void {
    this.storage.setItem(MCP_TOOLS_KEY, JSON.stringify(this.toolMap));
  }

  private saveEnabled(): void {
    this.storage.setItem(MCP_ENABLED_TOOLS_KEY, JSON.stringify([...this.enabled]));
  }

  servers(): McpServerConfig[] {
    return this.serverList.map((s) => ({ ...s, headers: s.headers ? { ...s.headers } : undefined }));
  }

  get(id: string): McpServerConfig | undefined {
    return this.servers().find((s) => s.id === id);
  }

  add(
    input: Omit<McpServerConfig, "createdAt" | "updatedAt" | "id" | "enabled"> & {
      id?: string;
      enabled?: boolean;
    },
  ): McpServerConfig {
    const at = this.now();
    const name = input.name.trim();
    if (!name) throw new Error("请填写服务名称");
    // 协议名大小写不敏感（`HTTPS://…` 是合法 URL）：这里若用区分大小写的正则，
    // 插件清单能通过 `new URL` 校验、却在这里抛错——preview 说能装、装到一半失败（d.77 修复）。
    if (input.transport === "http" && !/^https?:\/\//i.test(input.url ?? "")) {
      throw new Error("HTTP 传输的地址必须以 http:// 或 https:// 开头");
    }
    if (input.transport === "stdio" && !(input.command ?? "").trim()) {
      throw new Error("stdio 传输需要填写启动命令");
    }
    const server: McpServerConfig = {
      id: input.id?.trim() || `mcp-${at}-${Math.random().toString(36).slice(2, 8)}`,
      name,
      transport: input.transport,
      url: input.url?.trim() || undefined,
      command: input.command?.trim() || undefined,
      args: input.args?.filter((a) => a.trim()),
      headers: input.headers,
      enabled: input.enabled !== false,
      // 来源字段必须显式带过：`add()` 是字段白名单，不写就会被丢掉，
      // Registry 装出来的服务会退化成「手填」，界面也就无法判「已安装」。
      // 缺省按「手填」定死，否则内存里 origin=undefined、重启后读回 manual，
      // 同一个服务在重启前后长得都不一样。
      origin: input.origin ?? "manual",
      registryName: input.registryName,
      registryType: input.registryType,
      registryVersion: input.registryVersion,
      createdAt: at,
      updatedAt: at,
    };
    this.serverList = [...this.serverList, server];
    this.serversMutated = true;
    this.saveServers();
    return { ...server };
  }

  update(id: string, patch: Partial<Omit<McpServerConfig, "id" | "createdAt">>): McpServerConfig {
    const idx = this.serverList.findIndex((s) => s.id === id);
    if (idx < 0) throw new Error("MCP 服务不存在");
    const next: McpServerConfig = {
      ...this.serverList[idx],
      ...patch,
      id,
      updatedAt: this.now(),
    };
    this.serverList = this.serverList.map((s, i) => (i === idx ? next : s));
    this.serversMutated = true;
    this.saveServers();
    return { ...next };
  }

  remove(id: string): void {
    this.serverList = this.serverList.filter((s) => s.id !== id);
    this.serversMutated = true;
    delete this.toolMap[id];
    for (const key of [...this.enabled]) {
      if (key.startsWith(`${id}::`)) this.enabled.delete(key);
    }
    // 删掉的是预置服务 → 记一笔，否则下次启动会因「列表为空」被重新预置
    if (this.isPreset(id)) {
      const removed = this.readRemovedPresets();
      removed.add(id);
      this.writeRemovedPresets(removed);
    }
    this.saveServers();
    this.saveTools();
    this.saveEnabled();
  }

  /** 缓存某台服务的最新工具清单（刷新时整表替换）。 */
  setTools(serverId: string, tools: McpTool[]): void {
    this.toolMap[serverId] = tools.map((t) => ({ ...t }));
    this.saveTools();
  }

  tools(serverId: string): McpTool[] {
    return (this.toolMap[serverId] ?? []).map((t) => ({ ...t }));
  }

  /**
   * 该服务是否**已经发现过工具**（哪怕清单是空的）。
   *
   * 界面据此区分「已连接但零工具」与「还没连过」：前者显示已连接，
   * 否则用户会以为要再点一次连接，而自动连接正是为了省掉这一步。
   */
  hasDiscovered(serverId: string): boolean {
    return Object.prototype.hasOwnProperty.call(this.toolMap, serverId);
  }

  /** 全部服务的工具（带服务名，便于展示与命名空间化）。 */
  allTools(): McpToolRef[] {
    const out: McpToolRef[] = [];
    for (const server of this.serverList) {
      for (const tool of this.toolMap[server.id] ?? []) {
        out.push({ serverId: server.id, serverName: server.name, tool: { ...tool } });
      }
    }
    return out;
  }

  isToolEnabled(serverId: string, toolName: string): boolean {
    return this.enabled.has(toolKey(serverId, toolName));
  }

  setToolEnabled(serverId: string, toolName: string, on: boolean): void {
    const key = toolKey(serverId, toolName);
    if (on) this.enabled.add(key);
    else this.enabled.delete(key);
    // 预置服务的只读工具：用户关掉时记一笔，之后自动启用逻辑不再打开它。
    // 再打开时撤掉记录，让「显式开启」优先于「曾被关过」。
    if (this.isPreset(serverId)) {
      const off = this.readUserDisabled(serverId);
      if (on) off.delete(toolName);
      else off.add(toolName);
      this.writeUserDisabled(serverId, off);
    }
    this.saveEnabled();
  }

  /** 只需要「启用的 + 所属服务也启用的」工具（注入给模型的那一份）。 */
  enabledTools(): McpToolRef[] {
    const activeServers = new Set(this.serverList.filter((s) => s.enabled).map((s) => s.id));
    return this.allTools().filter(
      (ref) => activeServers.has(ref.serverId) && this.enabled.has(toolKey(ref.serverId, ref.tool.name)),
    );
  }
}

/** 全局单例（浏览器 localStorage）。测试请自行 new McpRegistry(内存存储)。 */
export const mcpRegistry = new McpRegistry();

/**
 * 启动时序收口（d.59）：hydrate 完成后补读一次（不覆盖用户已改过的列表）。
 *
 * 注册在单例创建之后：`onSecureHydrated` 在「已完成」时会立即回调，此时单例必须已存在。
 */
onSecureHydrated(() => {
  mcpRegistry.refreshAfterHydrate();
});
