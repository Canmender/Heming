import { create } from "zustand";
import { createDefaultStorage, readJson, writeJson } from "../lib/memory/storage.js";
import { setOverride, type ModelCapabilityOverride } from "../lib/modelCaps.js";
import {
  DEFAULT_GATEWAY,
  fetchGatewayCatalog,
  normalizeGatewayBaseUrl,
  type GatewayModel,
} from "../lib/magpieClient.js";

export { DEFAULT_GATEWAY } from "../lib/magpieClient.js";
export type { GatewayModel } from "../lib/magpieClient.js";
import type { GatewayConfig as BaseGatewayConfig } from "../lib/magpieClient.js";

/**
 * 网关配置来源（d.91）：
 * - `desktop`：桌面端内置 magpie 托管（地址是主进程反代，端口每次启动可能变，允许自动覆盖）；
 * - `manual`：用户手填（本机另一端口 / 远端已共享的 magpie），**永不被自动覆盖**。
 */
export interface GatewayConfig extends BaseGatewayConfig {
  source?: "desktop" | "manual";
}

/**
 * 模型层（d.89 起）：**和鸣不再直连各家模型供应商**。
 *
 * 一切模型能力都来自本机 magpie 网关（原生组件）：
 * - 用户只配一条「网关地址 + 网关 Key」（本机默认即 magpie 的默认值）；
 * - 模型目录由网关的 `GET /v1/models` 决定（magpie 负责订阅账号、多 Key、额度选路，
 *   所以这里列出的模型就是「用户已经能用的模型」）；
 * - 智能体绑定、候选链都绑定**模型**，不再绑定「连接/服务商」。
 *
 * 旧版本（d.88 及以前）在本机保存的模型连接（`heming.llmConfigs`，含安全存储里的 Key）、
 * 指向这些连接的绑定与候选链，按本轮决定**直接清除**（迁移只做一次，见 `migrateLegacy`）。
 */

/** 协议只剩 OpenAI 兼容（d.94）：magpie 网关对上游做翻译，和鸣不再有第二种协议。 */
export type LlmProvider = "openai";

/**
 * 供既有代码消费的「模型档案」：由网关目录**派生**，不落盘、不带用户 Key。
 *
 * 保留这个形状是为了不改动聊天/路由/用量那一层（它们按 profile 取模型与能力）；
 * `baseUrl` 固定为网关地址、`apiKey` 固定为网关 Key——真正的供应商 Key 不在和鸣这里。
 */
export interface LlmProfile {
  id: string;
  label: string;
  provider: LlmProvider;
  baseUrl?: string;
  apiKey: string;
  model: string;
  temperature?: number;
  /** 出站脱敏：对发往网关的请求生效（magpie 的 Privacy masking 语义）。 */
  mask?: boolean;
}

/** 路由组的一个成员：一个模型（同一网关下的不同模型之间也可以 failover）。 */
export interface RouteMember {
  /** 模型档案 id（`mp:<模型 id>`）。 */
  profileId: string;
  /** 覆盖档案里的模型（历史字段；模型档案本身已绑定模型，通常不用）。 */
  model?: string;
  /** 权重（`weight` 档用；缺省 1）。 */
  weight?: number;
}

/** 选路档（语义来自 magpie；数据全部来自本机网关目录与本地记账）。 */
export type RouteStrategy =
  | "order"
  | "smart"
  | "usage"
  | "pace"
  | "weight"
  | "fast"
  | "rotate";

export interface RouteGroup {
  id: string;
  label: string;
  members: RouteMember[];
  strategy?: RouteStrategy;
}

/** 模型档案 id 前缀：把模型 id 与「档案」隔开，绑定/候选链里一眼能看出是模型。 */
export const MODEL_PROFILE_PREFIX = "mp:";

export function modelProfileId(modelId: string): string {
  return `${MODEL_PROFILE_PREFIX}${modelId}`;
}

/** 档案 id → 模型 id；不是模型档案返回 null。 */
export function modelIdOfProfile(profileId: string | undefined): string | null {
  if (!profileId || !profileId.startsWith(MODEL_PROFILE_PREFIX)) return null;
  const modelId = profileId.slice(MODEL_PROFILE_PREFIX.length);
  return modelId || null;
}

const KEY_GATEWAY = "heming.magpie.v1";
const KEY_MODELS = "heming.magpie.models.v1";
const KEY_BINDINGS = "heming.agentLlm";
const KEY_PROMPTS = "heming.agentPrompts";
/** 候选链只存模型档案引用，与绑定/提示词同策略落普通 localStorage。 */
const KEY_ROUTES = "heming.llmRoutes.v1";
/** 旧版本的模型连接键（含安全存储里的供应商 Key）。 */
const KEY_LEGACY_CONFIGS = "heming.llmConfigs";
const KEY_LEGACY_HEALTH = "heming.llmHealth.v1";
/** 迁移只做一次：标记落盘后即使有旧键残留也不再清空用户的新绑定。 */
const KEY_MIGRATED = "heming.magpie.migrated.v1";
/** d.125：后台任务模型（归档/摘要等不抢主对话的任务用）。空串 = 未设置。 */
const KEY_BACKGROUND_MODEL = "heming.backgroundModel.v1";

/** 智能体绑定指向路由组时的前缀（绑定值仍是字符串，老数据零迁移）。 */
export const ROUTE_PREFIX = "route.";

export function routeRef(groupId: string): string {
  return `${ROUTE_PREFIX}${groupId}`;
}

export function parseRouteRef(ref: string | undefined): string | null {
  return ref && ref.startsWith(ROUTE_PREFIX) ? ref.slice(ROUTE_PREFIX.length) : null;
}

function loadJson<T>(key: string, fallback: T, pick: (raw: unknown) => T): T {
  try {
    return readJson(createDefaultStorage(), key, fallback, pick);
  } catch {
    return fallback;
  }
}

function loadRecord(key: string): Record<string, string> {
  return loadJson<Record<string, string>>(key, {}, (raw) =>
    raw && typeof raw === "object" && !Array.isArray(raw) ? (raw as Record<string, string>) : {},
  );
}

function loadGateway(): GatewayConfig {
  return loadJson<GatewayConfig>(KEY_GATEWAY, { ...DEFAULT_GATEWAY }, (raw) => {
    if (!raw || typeof raw !== "object") return { ...DEFAULT_GATEWAY };
    const obj = raw as Record<string, unknown>;
    const baseUrl =
      typeof obj.baseUrl === "string" && obj.baseUrl.trim()
        ? normalizeGatewayBaseUrl(obj.baseUrl)
        : DEFAULT_GATEWAY.baseUrl;
    const key = typeof obj.key === "string" && obj.key.trim() ? obj.key.trim() : DEFAULT_GATEWAY.key;
    const source =
      obj.source === "desktop" || obj.source === "manual"
        ? obj.source
        : baseUrl === DEFAULT_GATEWAY.baseUrl
          ? "desktop"
          : "manual";
    return { baseUrl, key, source } as GatewayConfig;
  });
}

function loadModels(): GatewayModel[] {
  return loadJson<GatewayModel[]>(KEY_MODELS, [], (raw) =>
    Array.isArray(raw)
      ? (raw as GatewayModel[]).filter(
          (m) => m && typeof m.id === "string" && typeof m.name === "string",
        )
      : [],
  );
}

function loadBackgroundModel(): string | null {
  return loadJson<string | null>(KEY_BACKGROUND_MODEL, null, (raw) =>
    typeof raw === "string" && raw.trim() ? raw.trim() : null,
  );
}

function loadRoutes(): RouteGroup[] {
  return loadJson<RouteGroup[]>(
    KEY_ROUTES,
    [],
    (raw) =>
      Array.isArray(raw)
        ? (raw as RouteGroup[]).filter(
            (g) => g && typeof g.id === "string" && Array.isArray(g.members),
          )
        : [],
  );
}

/**
 * 把网关目录映射成聊天/路由层用的模型档案。
 *
 * 同时把目录里的窗口/输出上限/视觉能力写进 `modelCaps` 的本机覆盖表——
 * 这样「能力判定」与网关实际提供的模型一致，而不是继续沿用旧的内置厂商价目/能力表。
 */
function profilesOf(gateway: GatewayConfig, models: GatewayModel[]): LlmProfile[] {
  return models.map((model) => ({
    id: modelProfileId(model.id),
    label: model.name,
    provider: "openai",
    baseUrl: gateway.baseUrl,
    apiKey: gateway.key,
    model: model.id,
  }));
}

/** 目录 → 能力覆盖（只覆盖目录明确给出的字段；未知保持内置缺省）。 */
function applyCapabilityOverrides(models: GatewayModel[]): void {
  for (const model of models) {
    const patch: ModelCapabilityOverride = {};
    if (model.contextWindow) patch.contextWindow = model.contextWindow;
    if (model.maxOutputTokens) patch.maxOutput = model.maxOutputTokens;
    if (model.vision) patch.supportsVision = true;
    if (model.reasoningLevels.length > 0) patch.supportsReasoning = true;
    if (Object.keys(patch).length > 0) setOverride("openai", model.id, patch);
  }
}

/**
 * 一次性清掉旧版模型连接体系（d.89 的产品决定：**直接清除**，不迁移 Key）。
 *
 * 清的范围：供应商连接（含安全存储里的 Key 与其备份键）、指向这些连接的绑定、
 * 候选链、按「连接×模型」记账的冷却。提示词与历史用量是用户内容，保留。
 */
export function clearLegacyModelConfig(): void {
  try {
    const storage = createDefaultStorage();
    for (const suffix of [
      "",
      ".__heming_undecryptable",
      ".__heming_plaintext_backup",
    ]) {
      storage.removeItem(`${KEY_LEGACY_CONFIGS}${suffix}`);
    }
    storage.removeItem(KEY_BINDINGS);
    storage.removeItem(KEY_ROUTES);
    storage.removeItem(KEY_LEGACY_HEALTH);
    storage.setItem(KEY_MIGRATED, new Date().toISOString());
  } catch {
    // 隐私模式/配额异常：清不掉也继续启动，下一次启动会再试（标记没落盘）
  }
}

function migrateLegacy(): void {
  const storage = createDefaultStorage();
  try {
    if (storage.getItem(KEY_MIGRATED)) return;
  } catch {
    return;
  }
  clearLegacyModelConfig();
}

let migrated = false;
function ensureMigrated(): void {
  if (migrated) return;
  migrated = true;
  migrateLegacy();
}

/** 测试隔离：允许用例重新执行一次迁移。 */
export function resetLlmMigrationState(): void {
  migrated = false;
}

/** 测试隔离：清掉 hydrate 补读标记（旧版；保留导出避免破坏既有测试导入）。 */
export function resetLlmHydrationState(): void {
  /* d.89 起没有需要 hydrate 的供应商 Key，函数保留为空实现以兼容既有导入。 */
}

export interface GatewayCatalogResult {
  models: GatewayModel[];
  version?: string;
}

interface LlmState {
  gateway: GatewayConfig;
  /** 网关目录缓存（离线也能展示上次的模型列表）。 */
  models: GatewayModel[];
  /** 最近一次成功读到的 magpie 版本（展示用）。 */
  gatewayVersion?: string;
  /**
   * 后台任务模型（d.125）：归档、摘要、议程提取这类后台任务用的模型 id。
   * `null` = 未设置（插件不会自动调用模型）；只存 id，模型目录变化后由 UI 判失效。
   */
  backgroundModel: string | null;
  /** 由目录派生的模型档案（不落盘）。 */
  profiles: LlmProfile[];
  bindings: Record<string, string>;
  prompts: Record<string, string>;
  routes: RouteGroup[];
  setGateway: (next: GatewayConfig) => void;
  /** 桌面端反代地址（d.91）：仅在用户没手动指定网关时自动采用，并持久化。 */
  adoptDesktopGateway: (baseUrl: string) => boolean;
  /** 从网关重新读目录；成功后同步模型档案与能力覆盖。 */
  refreshCatalog: () => Promise<GatewayCatalogResult>;
  /** 直接写入目录（测试与离线恢复用）。 */
  setModels: (models: GatewayModel[], version?: string) => void;
  /** 设置后台任务模型；传 null / 空串表示不设置。 */
  setBackgroundModel: (modelId: string | null) => void;
  setBinding: (agentId: string, profileId: string | null) => void;
  setPrompt: (agentId: string, text: string) => void;
  getProfile: (id: string) => LlmProfile | undefined;
  addRoute: (g: RouteGroup) => void;
  updateRoute: (id: string, patch: Partial<Omit<RouteGroup, "id">>) => void;
  removeRoute: (id: string) => void;
  getRoute: (id: string) => RouteGroup | undefined;
}

ensureMigrated();

const initialGateway = loadGateway();
const initialModels = loadModels();
applyCapabilityOverrides(initialModels);

export const useLlmStore = create<LlmState>((set, get) => ({
  gateway: initialGateway,
  models: initialModels,
  gatewayVersion: undefined,
  backgroundModel: loadBackgroundModel(),
  profiles: profilesOf(initialGateway, initialModels),
  bindings: loadRecord(KEY_BINDINGS),
  prompts: loadRecord(KEY_PROMPTS),
  routes: loadRoutes(),
  setGateway(next) {
    const gateway: GatewayConfig = {
      baseUrl: normalizeGatewayBaseUrl(next.baseUrl) || DEFAULT_GATEWAY.baseUrl,
      key: next.key.trim() || DEFAULT_GATEWAY.key,
      // 用户在表单里保存 = 手动指定；桌面端自动采用另走 adoptDesktopGateway。
      source: next.source ?? "manual",
    };
    writeJson(createDefaultStorage(), KEY_GATEWAY, gateway, 4 * 1024);
    // 网关变了：已有档案的地址/Key 立刻跟着换（模型列表下一次刷新再更新）
    set({ gateway, profiles: profilesOf(gateway, get().models) });
  },
  adoptDesktopGateway(baseUrl) {
    const current = get().gateway;
    const normalized = normalizeGatewayBaseUrl(baseUrl);
    if (!normalized) return false;
    // 手动指定过网关（例如远端 magpie）就不覆盖用户的决定。
    if (current.source === "manual") return false;
    if (current.baseUrl === normalized) return true;
    const gateway: GatewayConfig = { baseUrl: normalized, key: current.key, source: "desktop" };
    writeJson(createDefaultStorage(), KEY_GATEWAY, gateway, 4 * 1024);
    set({ gateway, profiles: profilesOf(gateway, get().models) });
    return true;
  },
  async refreshCatalog() {
    const catalog = await fetchGatewayCatalog(get().gateway);
    const models = catalog.models;
    writeJson(createDefaultStorage(), KEY_MODELS, models, 512 * 1024);
    applyCapabilityOverrides(models);
    set({
      models,
      gatewayVersion: catalog.version,
      profiles: profilesOf(get().gateway, models),
    });
    return catalog;
  },
  setModels(models, version) {
    applyCapabilityOverrides(models);
    writeJson(createDefaultStorage(), KEY_MODELS, models, 512 * 1024);
    set({
      models,
      gatewayVersion: version,
      profiles: profilesOf(get().gateway, models),
    });
  },
  setBackgroundModel(modelId) {
    const next = typeof modelId === "string" && modelId.trim() ? modelId.trim() : null;
    writeJson(createDefaultStorage(), KEY_BACKGROUND_MODEL, next, 512);
    set({ backgroundModel: next });
  },
  setBinding(agentId, profileId) {
    const bindings = { ...get().bindings };
    if (profileId === null) delete bindings[agentId];
    else bindings[agentId] = profileId;
    writeJson(createDefaultStorage(), KEY_BINDINGS, bindings, 256 * 1024);
    set({ bindings });
  },
  setPrompt(agentId, text) {
    const prompts = { ...get().prompts, [agentId]: text };
    writeJson(createDefaultStorage(), KEY_PROMPTS, prompts, 512 * 1024);
    set({ prompts });
  },
  getProfile(id) {
    return get().profiles.find((x) => x.id === id);
  },
  addRoute(g) {
    const routes = [...get().routes, g];
    writeJson(createDefaultStorage(), KEY_ROUTES, routes, 128 * 1024);
    set({ routes });
  },
  updateRoute(id, patch) {
    const routes = get().routes.map((g) => (g.id === id ? { ...g, ...patch, id } : g));
    writeJson(createDefaultStorage(), KEY_ROUTES, routes, 128 * 1024);
    set({ routes });
  },
  removeRoute(id) {
    const routes = get().routes.filter((g) => g.id !== id);
    writeJson(createDefaultStorage(), KEY_ROUTES, routes, 128 * 1024);
    const bindings = Object.fromEntries(
      Object.entries(get().bindings).filter(([, ref]) => ref !== routeRef(id)),
    );
    writeJson(createDefaultStorage(), KEY_BINDINGS, bindings, 256 * 1024);
    set({ routes, bindings });
  },
  getRoute(id) {
    return get().routes.find((g) => g.id === id);
  },
}));
