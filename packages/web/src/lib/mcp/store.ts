import type { StorageLike } from "../memory/types.js";
import {
  hasSecureBridge,
  onSecureHydrated,
  secureStorageFor,
  secureStorageStatus,
  secureStorageHydrated,
} from "../secureStorage.js";
import type { McpServerConfig, McpTool, McpToolRef, McpTransport } from "./types.js";
import { SYSTEM_MCP_SERVERS, isSystemMcpServer, systemMcpServerId } from "./presets.js";

/** 存储键（带版本，便于将来迁移）。 */
export const MCP_SERVERS_KEY = "heming.mcp.servers.v1";
export const MCP_TOOLS_KEY = "heming.mcp.tools.v1";
/** 已启用的工具（`serverId::toolName`），**默认不启用**：工具可能有副作用，必须显式打开。 */
export const MCP_ENABLED_TOOLS_KEY = "heming.mcp.enabledTools.v1";
/**
 * 旧版本记录「用户删掉过的预置服务 id」的键。
 *
 * @deprecated 系统能力不可删除，新逻辑**不再读写**这个键；保留导出只是为了让
 * 尚未迁移的旧测试/旧调用还能通过类型检查（见 `removedPresetIds` / `restorePresets`）。
 * 那个键里的历史数据留着无害：不会再有预置逻辑去读它。
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

/**
 * 归一化单次请求超时（毫秒）：无效值一律当没填，有效值夹到 [2s, 600s]。
 *
 * 存的时候归一化，而不是等到调用时再夹：否则界面上显示 500ms、实际按 2s 走，
 * 用户永远对不上账。归一化规则与 `resolveTimeoutMs`（httpClient）保持一致。
 */
function normalizeTimeout(value: unknown): number | undefined {
  if (typeof value !== "number" || !Number.isFinite(value) || value <= 0) return undefined;
  return Math.min(600_000, Math.max(2_000, Math.round(value)));
}

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
    // 单次超时同样是白名单字段：不写会在重开应用后被丢掉，界面上的设置
    // 就变成了「这次生效、下次回到缺省」的幽灵设置。
    timeoutMs: normalizeTimeout(r.timeoutMs),
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
/**
 * 一台服务的连接状态（运行时，不落盘）。
 *
 * ★ 为什么不能只看「有没有缓存清单」：快照会落盘，服务第二天起不来时清单还在，
 * 界面就显示「已连接」，模型则拿到一份指向死进程的工具目录——问也问不出错，
 * 只会一直调失败。状态必须反映**最近一次连接尝试的结果**。
 */
export interface McpServerStatus {
  state: "connected" | "stale" | "error";
  /** 最近一次尝试的时间（ISO）。 */
  at: string;
  /** 失败原因（stale/error 时）。 */
  error?: string;
  /** 连上时发现的工具数。 */
  tools?: number;
}

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
  /** 每台服务最近一次连接结果（仅本进程内存；刷新页面即重置）。 */
  private readonly connectStatus = new Map<string, McpServerStatus>();

  constructor(storage: StorageLike = defaultStorage(), now: () => string = () => new Date().toISOString()) {
    this.storage = storage;
    this.now = now;
    this.serverList = this.readServers();
    this.toolMap = this.readTools();
    this.enabled = this.readEnabled();
    /*
     * 启动时序（d.59）：hydrate 未完成时 `readServers()` 可能只是「缓存未命中」的空表，
     * 与「真的没有服务」无法区分。Electron 46 没有同步桥兜底，此时若调用
     * `ensureSystemServers()`，会把系统能力写盘、覆盖磁盘上的密文配置
     * （用户请求头 token 一起丢）。所以这里推迟补齐，等 hydrate 完成后由
     * `refreshAfterHydrate()` 再调；浏览器（无桥）没有这个问题，行为不变。
     */
    if (secureStorageHydrated() || !hasSecureBridge()) {
      this.ensureSystemServers();
    }
  }

  /**
   * 确保两条系统能力始终在服务列表里（幂等；构造期与 hydrate 后都要调）。
   *
   * 与旧的「首次预置」有三点不同：
   * 1. 不再看「存储里是否已有服务」——用户配过私有服务，不等于不需要系统能力；
   * 2. 不受删除记录影响——系统能力本来就不可删除，没有「删过就跳过」这回事；
   * 3. 已经存在同 id 条目时**不重复插入**，只把「由定义表决定」的只读字段校正回来：
   *    名称 / 传输 / 地址 / 命令 / 参数 / 启用位 / 来源。请求头、超时、创建时间
   *    与工具授权一律保留——那是用户的数据（系统能力用不到请求头，但升级时覆盖
   *    等于把用户 token 永久丢掉）。
   *
   * 密文读不出来时（`undecryptableKeys`）直接跳过：此时内存列表可能是空表，
   * 落盘会把磁盘上的用户配置**永久覆盖**。宁可这一轮少显示系统能力，
   * 也不动密文——换回原账户还能恢复。
   */
  ensureSystemServers(): void {
    if (secureStorageStatus().undecryptableKeys.includes(MCP_SERVERS_KEY)) return;
    const at = this.now();
    let changed = false;
    for (const system of SYSTEM_MCP_SERVERS) {
      const id = systemMcpServerId(system.id);
      const idx = this.serverList.findIndex((s) => s.id === id);
      if (idx < 0) {
        this.serverList.push({
          id,
          name: system.name,
          transport: system.transport,
          url: system.url,
          command: system.command,
          args: system.args ? [...system.args] : undefined,
          // 系统能力始终参与对话：界面上没有「停用」入口，停用后模型能力会静默缺失。
          enabled: true,
          origin: "preset",
          createdAt: at,
          updatedAt: at,
        });
        changed = true;
        continue;
      }
      const current = this.serverList[idx];
      const next: McpServerConfig = {
        ...current,
        name: system.name,
        transport: system.transport,
        url: system.url,
        command: system.command,
        args: system.args ? [...system.args] : undefined,
        enabled: true,
        origin: "preset",
        updatedAt: at,
      };
      if (!this.sameSystemConfig(current, next)) {
        this.serverList[idx] = next;
        changed = true;
      }
    }
    if (changed) this.saveServers();
  }

  /**
   * 系统能力「由定义表决定」的字段是否已经与定义一致。
   *
   * 只比较这些字段：`headers` / `timeoutMs` / `createdAt` 属于用户数据，
   * 不参与比较，也就不会被校正逻辑顺手覆盖。
   */
  private sameSystemConfig(a: McpServerConfig, b: McpServerConfig): boolean {
    return (
      a.name === b.name &&
      a.transport === b.transport &&
      a.url === b.url &&
      a.command === b.command &&
      (a.args ?? []).join("\u0000") === (b.args ?? []).join("\u0000") &&
      a.enabled === b.enabled &&
      a.origin === b.origin
    );
  }

  /**
   * hydrate 完成后补一次读（启动门禁 `onSecureHydrated` 会调；测试可手动调）。
   *
   * 合并规则（与 `store/llm.ts` 同一套思路）：
   * 1. 用户已经改过服务列表（`serversMutated`）→ **不重读**，内存即最新（写路径已落盘）；
   * 2. 否则重读安全键，然后**无论读到什么都补一次系统能力**（幂等）。
   *
   * 任何情况下都不会删改磁盘上的密文：读不到时仍按空表展示，由 secure 层标记
   * `undecryptableKeys`（d.36 口径：密文留在原地，换回原账户还能恢复）。
   */
  refreshAfterHydrate(): void {
    if (this.serversMutated) {
      this.ensureSystemServers();
      return;
    }
    this.serverList = this.readServers();
    this.toolMap = this.readTools();
    this.enabled = this.readEnabled();
    this.ensureSystemServers();
  }

  /**
   * 重新读本机存储并重建内存态（安装事务回滚后必须调）。
   *
   * 照 `refreshAfterHydrate` 的读法重建三份内存数据，但**不**做启动时序判断，
   * 也**不**补系统能力——回滚场景要的是「存储是什么，内存就是什么」，
   * 顺带写盘会把刚恢复的快照又改掉。`serversMutated` 一并复位。
   */
  reload(): void {
    this.serverList = this.readServers();
    this.toolMap = this.readTools();
    this.enabled = this.readEnabled();
    this.serversMutated = false;
  }

  /**
   * 系统能力发现完工具后，把只读那批自动启用（见 `SystemMcpServer.safeTools`）。
   *
   * **用户关掉的不再打开**：enabled 是「已启用集合」，关掉的工具不在里面，
   * 只按 `has(key)` 判重会把它当成「从未配置」而重新启用——
   * 等于用户的选择被静默推翻。所以这里额外查 `readUserDisabled`：一旦用户
   * 明确关过某工具，就记下来，之后不再自动开（要恢复得他再手动勾一次）。
   */
  autoEnableSafeTools(serverId: string, tools: McpTool[]): string[] {
    // 非系统能力一律不自动启用：第三方服务的工具名可能与白名单撞名
    // （比如人家也有个叫 Screenshot 的），开错等于给了没预期的权限。
    if (!this.isSystem(serverId)) return [];
    // 按**服务 id**反查所属系统能力：不同能力的白名单不同
    // （Windows-MCP 是 Screenshot/Snapshot，Scrapling 是 make_request 那一批）。
    const system = SYSTEM_MCP_SERVERS.find((p) => systemMcpServerId(p.id) === serverId);
    const safe = new Set(system?.safeTools ?? []);
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

  /**
   * 该服务是否属于系统能力（界面走只读展示、存储层据此拒绝删除/改配置）。
   *
   * 只按固定 id 判定，不看列表里有没有：即使本轮因密文读不出还没补齐，
   * 也不能把系统能力当成用户服务而允许删改。
   */
  isSystem(serverId: string): boolean {
    return isSystemMcpServer(serverId);
  }

  /**
   * 系统能力列表（按定义表顺序，只返回当前确实在内存列表里的）。
   *
   * 顺序不依赖落盘顺序：用户服务先存在时，补齐的系统能力会追加在末尾；
   * 界面要稳定显示在上方，所以这里按定义表重排。返回拷贝，调用方改不到内部状态。
   */
  systemServers(): McpServerConfig[] {
    return SYSTEM_MCP_SERVERS.map((system) => systemMcpServerId(system.id))
      .map((id) => this.serverList.find((s) => s.id === id))
      .filter((s): s is McpServerConfig => !!s)
      .map((s) => ({
        ...s,
        args: s.args ? [...s.args] : undefined,
        headers: s.headers ? { ...s.headers } : undefined,
      }));
  }

  /** 该服务是否属于系统能力。@deprecated 旧名；新代码请用 `isSystem`。 */
  isPreset(serverId: string): boolean {
    return this.isSystem(serverId);
  }

  /**
   * 被用户删掉过的系统能力 id。
   *
   * @deprecated 系统能力不可删除，所以恒为空数组；保留只为兼容尚未迁移的旧测试。
   */
  removedPresetIds(): string[] {
    return [];
  }

  /**
   * 「恢复系统能力」。
   *
   * @deprecated 系统能力始终存在（由 `ensureSystemServers()` 负责），没有「恢复」这个动作；
   * 恒返回 0。保留只为兼容尚未迁移的旧测试，新代码不要调用。
   */
  restorePresets(): number {
    this.ensureSystemServers();
    return 0;
  }

  /**
   * 按定义 id 取一条系统能力。
   *
   * @deprecated 系统能力始终存在，调用前无需「补回」；这里只返回现有配置（不存在时 null）。
   * 保留只为兼容尚未迁移的旧测试。
   */
  restorePreset(systemId: string): McpServerConfig | null {
    const system = SYSTEM_MCP_SERVERS.find((p) => p.id === systemId);
    if (!system) return null;
    const current = this.serverList.find((s) => s.id === systemMcpServerId(system.id));
    if (!current) return null;
    return { ...current, args: current.args ? [...current.args] : undefined };
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
      ...(normalizeTimeout(input.timeoutMs) !== undefined
        ? { timeoutMs: normalizeTimeout(input.timeoutMs) }
        : {}),
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

  /**
   * 更新一台**用户添加的**服务。
   *
   * 系统能力的配置只读：命令、参数、地址都由定义表决定，改了也连不上，
   * 所以直接抛错——`update()` 的调用方都是界面保存动作，静默不生效更难排查。
   */
  update(id: string, patch: Partial<Omit<McpServerConfig, "id" | "createdAt">>): McpServerConfig {
    const idx = this.serverList.findIndex((s) => s.id === id);
    if (idx < 0) throw new Error("MCP 服务不存在");
    if (this.isSystem(id)) throw new Error("系统能力不可修改配置");
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

  /**
   * 删除一台**用户添加的**服务。
   *
   * 系统能力不可删除：返回 false，不改任何状态。选返回 false 而不是抛错，
   * 是因为删除入口本来就不会渲染系统能力，这里是纵深防御，界面无需 try/catch。
   */
  remove(id: string): boolean {
    if (this.isSystem(id)) return false;
    this.serverList = this.serverList.filter((s) => s.id !== id);
    this.serversMutated = true;
    delete this.toolMap[id];
    // 连接状态也要一起清：否则删掉再建同名服务时，界面会读到上一条的旧状态
    // （比如残留的 "已连接"），而且 connectStatus 会随删除不断膨胀。
    this.clearStatus(id);
    for (const key of [...this.enabled]) {
      if (key.startsWith(`${id}::`)) this.enabled.delete(key);
    }
    this.saveServers();
    this.saveTools();
    this.saveEnabled();
    return true;
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

  /** 记录一次连接结果（refreshServerTools 成功/失败时调用）。 */
  setStatus(serverId: string, status: Omit<McpServerStatus, "at"> & { at?: string }): void {
    this.connectStatus.set(serverId, { ...status, at: status.at ?? this.now() });
  }

  /** 最近一次连接结果；从没连过返回 undefined。 */
  status(serverId: string): McpServerStatus | undefined {
    return this.connectStatus.get(serverId);
  }

  /** 清掉状态（删除服务时）。 */
  clearStatus(serverId: string): void {
    this.connectStatus.delete(serverId);
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
    // 系统能力的只读工具：用户关掉时记一笔，之后自动启用逻辑不再打开它。
    // 再打开时撤掉记录，让「显式开启」优先于「曾被关过」。
    if (this.isSystem(serverId)) {
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
