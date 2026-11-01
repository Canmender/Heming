import { create } from "zustand";
import { secureGetItem, secureSetItem } from "../lib/secureStorage.js";

/**
 * LLM 连接本机存储：Key 走系统安全存储（桌面端就地信封，见 lib/secureStorage.ts），
 * 绑定/提示词仍在普通 localStorage；三键都只写本机，绝不上传自有服务端
 *（红线见 lib/llmClient.ts——请求目标只随 profile.baseUrl）。
 */
export type LlmProvider = "openai" | "anthropic";

export interface LlmProfile {
  id: string;
  label: string;
  provider: LlmProvider;
  baseUrl?: string;
  apiKey: string;
  model: string;
  temperature?: number;
  /**
   * 出站脱敏（d.48，magpie 的 Privacy masking）：为真时，这条连接的每次请求在
   * **发给服务商之前**把凭据长相的内容换成占位符（见 lib/llmMask.ts）。
   * 只改出站副本：本机历史、E2E 明文、界面文本一律不动。缺省关。
   */
  mask?: boolean;
}

/**
 * 路由组的一个成员：一个既有连接，可选地换一个模型。
 *
 * 刻意只存 `profileId`——**Key 绝不被复制进路由组**（红线见 lib/llmClient.ts：
 * Key 只属于 profile，路由层拿到的永远是引用）。同服务商两个 Key 就是两个成员，
 * 这就是 magpie 的「账号池」，本仓不需要再发明 Account 实体。
 */
export interface RouteMember {
  profileId: string;
  /** 覆盖该连接的默认模型（同 Key 换模型走 failover）。 */
  model?: string;
}

/**
 * 选路档（d.48）：`order` = 声明顺序（magpie「In order」）；`cheap` = 醒着的候选里先问
 * 参考价便宜的。smart/usage/pace/weight/fast 那几档依赖「供应商窗口何时续期」这类
 * 本仓读不到的数据，不做近似——近似出来的选路比不选更难解释。
 */
export type RouteStrategy = "order" | "cheap";

/**
 * 候选链（magpie 的 routing group，docs/reference.md「Routing groups」）。
 */
export interface RouteGroup {
  id: string;
  label: string;
  members: RouteMember[];
  /**
   * 选路档（d.48）：`"order"` = 声明顺序（magpie「In order」，默认）；
   * `"cheap"` = 醒着的候选里先问**参考价更便宜**的那个。
   * 可选字段：老数据没它，读回按 order 走，行为与加这档之前逐字相同。
   */
  strategy?: RouteStrategy;
}

const KEY_CONFIGS = "heming.llmConfigs";
const KEY_BINDINGS = "heming.agentLlm";
const KEY_PROMPTS = "heming.agentPrompts";
/** 路由组不是凭据（只存 profileId 引用），与绑定/提示词同策略落普通 localStorage。 */
const KEY_ROUTES = "heming.llmRoutes.v1";

/** 智能体绑定指向路由组时的前缀（绑定值仍是字符串，老数据零迁移）。 */
export const ROUTE_PREFIX = "route.";

/** 由路由组 id 造绑定值。 */
export function routeRef(groupId: string): string {
  return `${ROUTE_PREFIX}${groupId}`;
}

/** 绑定值 → 路由组 id；不是路由组引用返回 null。 */
export function parseRouteRef(ref: string | undefined): string | null {
  return ref && ref.startsWith(ROUTE_PREFIX) ? ref.slice(ROUTE_PREFIX.length) : null;
}

function loadJson<T>(key: string, fallback: T, pick: (raw: unknown) => T): T {
  try {
    const raw = localStorage.getItem(key);
    if (!raw) return fallback;
    return pick(JSON.parse(raw));
  } catch {
    return fallback; // 损坏数据回退空（与 tokenUsage 同策略）
  }
}

function loadProfiles(): LlmProfile[] {
  try {
    // 只有 llmConfigs 是凭据（直连供应商的付费 Key），走系统安全存储；
    // 绑定与提示词留在普通 localStorage——它们不是凭据，没必要过 IPC。
    const raw = secureGetItem(KEY_CONFIGS);
    if (!raw) return [];
    const profiles = (JSON.parse(raw) as { profiles?: unknown }).profiles;
    return Array.isArray(profiles) ? (profiles as LlmProfile[]) : [];
  } catch {
    return []; // 损坏数据回退空（与 tokenUsage 同策略）
  }
}

function loadRecord(key: string): Record<string, string> {
  return loadJson<Record<string, string>>(key, {}, (raw) =>
    raw && typeof raw === "object" && !Array.isArray(raw) ? (raw as Record<string, string>) : {},
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

const saveProfiles = (profiles: LlmProfile[]): void => {
  secureSetItem(KEY_CONFIGS, JSON.stringify({ profiles }));
};
const saveRecord = (key: string, value: Record<string, string>): void => {
  localStorage.setItem(key, JSON.stringify(value));
};
const saveRoutes = (routes: RouteGroup[]): void => {
  localStorage.setItem(KEY_ROUTES, JSON.stringify(routes));
};

/** 成员跟着被删的连接走；一个都不剩的组撤掉（剩一个仍保留——它就是那条链）。 */
function pruneRoutes(routes: RouteGroup[], profileId: string): RouteGroup[] {
  return routes
    .map((g) => ({ ...g, members: g.members.filter((m) => m.profileId !== profileId) }))
    .filter((g) => g.members.length > 0);
}

interface LlmState {
  profiles: LlmProfile[];
  bindings: Record<string, string>;
  prompts: Record<string, string>;
  routes: RouteGroup[];
  addProfile: (p: LlmProfile) => void;
  updateProfile: (id: string, patch: Partial<LlmProfile>) => void;
  removeProfile: (id: string) => void;
  setBinding: (agentId: string, profileId: string | null) => void;
  setPrompt: (agentId: string, text: string) => void;
  getProfile: (id: string) => LlmProfile | undefined;
  addRoute: (g: RouteGroup) => void;
  updateRoute: (id: string, patch: Partial<Omit<RouteGroup, "id">>) => void;
  removeRoute: (id: string) => void;
  getRoute: (id: string) => RouteGroup | undefined;
}

export const useLlmStore = create<LlmState>((set, get) => ({
  profiles: loadProfiles(),
  bindings: loadRecord(KEY_BINDINGS),
  prompts: loadRecord(KEY_PROMPTS),
  routes: loadRoutes(),
  addProfile(p) {
    const profiles = [...get().profiles, p];
    saveProfiles(profiles);
    set({ profiles });
  },
  updateProfile(id, patch) {
    const profiles = get().profiles.map((x) => (x.id === id ? { ...x, ...patch, id } : x));
    saveProfiles(profiles);
    set({ profiles });
  },
  removeProfile(id) {
    const profiles = get().profiles.filter((x) => x.id !== id);
    saveProfiles(profiles);
    // 删连接即解绑：已绑定该连接的智能体失联（契约由 LlmSettingsCard 提示）
    const bindings = Object.fromEntries(
      Object.entries(get().bindings).filter(([, pid]) => pid !== id),
    );
    saveRecord(KEY_BINDINGS, bindings);
    // 路由组同理：成员跟着删，一个不剩的组撤掉
    const routes = pruneRoutes(get().routes, id);
    saveRoutes(routes);
    set({ profiles, bindings, routes });
  },
  setBinding(agentId, profileId) {
    const bindings = { ...get().bindings };
    if (profileId === null) delete bindings[agentId];
    else bindings[agentId] = profileId;
    saveRecord(KEY_BINDINGS, bindings);
    set({ bindings });
  },
  setPrompt(agentId, text) {
    const prompts = { ...get().prompts, [agentId]: text };
    saveRecord(KEY_PROMPTS, prompts);
    set({ prompts });
  },
  getProfile(id) {
    return get().profiles.find((x) => x.id === id);
  },
  addRoute(g) {
    const routes = [...get().routes, g];
    saveRoutes(routes);
    set({ routes });
  },
  updateRoute(id, patch) {
    const routes = get().routes.map((g) => (g.id === id ? { ...g, ...patch, id } : g));
    saveRoutes(routes);
    set({ routes });
  },
  removeRoute(id) {
    const routes = get().routes.filter((g) => g.id !== id);
    saveRoutes(routes);
    // 绑定到这条链的智能体一并失联（与 removeProfile 同一契约）
    const bindings = Object.fromEntries(
      Object.entries(get().bindings).filter(([, ref]) => ref !== routeRef(id)),
    );
    saveRecord(KEY_BINDINGS, bindings);
    set({ routes, bindings });
  },
  getRoute(id) {
    return get().routes.find((g) => g.id === id);
  },
}));
