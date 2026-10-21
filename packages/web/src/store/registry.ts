/**
 * Registry 发现页的状态与安装流。
 *
 * 设计口径（`docs/research/2026-10-22-registry-architecture.md` T08/T09 + d.25 本地包）：
 * - 离线是常态假设：`load()` **永不抛**，失败保留旧缓存并置 `stale`；
 * - 缓存 6 小时（`localStorage`，注入 `StorageLike` 以便单测）；
 * - 安装**永远走确认**，不受 HITL 档位影响（供应链决策 ≠ 工具执行）；
 * - 本地包（stdio）**先探测本机运行时再进确认**：跑不起来的包不该让用户填一遍表；
 * - 装完只登记配置并连接，**工具默认全部关闭**（现有 `McpRegistry` 已保证）。
 */

import { create, type StoreApi, type UseBoundStore } from "zustand";
import {
  fetchPage,
  search,
  REGISTRY_PAGE_SIZE,
  type FetchLike,
} from "../lib/registry/api.js";
import { registryServerId, toServerConfig } from "../lib/registry/map.js";
import {
  buildInstallPreview,
  sanitizeHeaders,
  type InstallDecision,
  type RegistryInstallPreview,
} from "../lib/registry/preview.js";
import {
  blockedReason,
  probeLocalRuntime,
  runtimeRequirementFor,
  type LocalRuntimeStatus,
} from "../lib/registry/runtime.js";
import type { InstallOption, RegistryEntry } from "../lib/registry/types.js";
import { mcpRegistry, type McpRegistry } from "../lib/mcp/store.js";
import { refreshServerTools } from "../lib/mcp/runtime.js";
import type { McpTool } from "../lib/mcp/types.js";
import type { StorageLike } from "../lib/memory/types.js";
import { useHitlStore } from "./hitl.js";

/** 缓存键（带版本，便于将来迁移）。 */
export const REGISTRY_CACHE_KEY = "heming.mcpRegistry.v1";
/** 缓存有效期：Registry 更新不频繁，但断网降级需要旧数据。 */
export const REGISTRY_CACHE_TTL_MS = 6 * 60 * 60 * 1000;

/** 一次安装的结果。失败时配置可能已保存（连接失败），所以错误文案必须说清楚。 */
export interface InstallResult {
  ok: boolean;
  /** 用户在确认卡上取消。 */
  canceled?: boolean;
  /** 成功时发现的工具数（工具仍默认关闭）。 */
  tools?: number;
  error?: string;
}

export interface RegistryStoreDeps {
  storage?: StorageLike;
  fetchImpl?: FetchLike;
  mcp?: McpRegistry;
  refreshTools?: (serverId: string, registry: McpRegistry) => Promise<McpTool[]>;
  now?: () => number;
  /** 安装确认。测试注入；默认走 HITL 的 pending 单槽 + 队列。 */
  confirmInstall?: (preview: RegistryInstallPreview) => Promise<InstallDecision>;
  /** 本机运行时探测。测试注入；默认走桌面端 `__heming_runtime.probe`。 */
  probeRuntime?: () => Promise<LocalRuntimeStatus | null>;
}

interface RegistryCache {
  savedAt: number;
  query: string;
  entries: RegistryEntry[];
  nextCursor?: string;
}

export interface RegistryState {
  entries: RegistryEntry[];
  nextCursor?: string;
  loading: boolean;
  loadingMore: boolean;
  /** 正在探测本机运行时。 */
  probingRuntime: boolean;
  error: string | null;
  /** 正在展示的是旧缓存（请求失败后的降级）。 */
  stale: boolean;
  query: string;
  loadedAt: number | null;
  /** 正在安装的条目 key（防重复点击）。 */
  installingKey: string | null;
  /** 已安装的 Registry 服务（`server.name`）。 */
  installedKeys: string[];
  /**
   * 本机运行时探测结果；`null` = 还没探或探测不了（浏览器 / IPC 失败）。
   * 只有本地包（stdio）装法会读它，远程装法与它无关。
   */
  runtime: LocalRuntimeStatus | null;
  /** 是否已经探过（避免每次点安装都发一次 IPC）。 */
  runtimeProbed: boolean;

  /** 拉第一页（或使用 TTL 内缓存）。**永不抛**。 */
  load: (query?: string, opts?: { force?: boolean }) => Promise<void>;
  /** 拉下一页并追加（按 key 去重）。 */
  loadMore: () => Promise<void>;
  setQuery: (query: string) => void;
  /**
   * 探测本机运行时（npm/pypi 装法的前置）。**永不抛**：拿不到就是 `runtime: null`。
   * 页面挂载时调一次，让「本机跑不了」在用户点安装之前就看得见。
   */
  probeRuntime: (force?: boolean) => Promise<void>;
  /** 从 MCP 注册表回填「已安装」，删除后也能同步。 */
  syncInstalled: () => void;
  isInstalled: (key: string) => boolean;
  /** 走确认通道 → 写配置 → 连接。 */
  install: (entry: RegistryEntry, option: InstallOption) => Promise<InstallResult>;
}

export type RegistryStore = UseBoundStore<StoreApi<RegistryState>>;

function defaultStorage(): StorageLike {
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
        /* 配额/隐私模式：只影响缓存，不影响本次会话 */
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

/** 读缓存。存储是用户可改的，逐字段校验，坏数据一律当没有。 */
function readCache(storage: StorageLike): RegistryCache | null {
  let raw: string | null;
  try {
    raw = storage.getItem(REGISTRY_CACHE_KEY);
  } catch {
    return null;
  }
  if (!raw) return null;
  try {
    const parsed = JSON.parse(raw) as unknown;
    if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) return null;
    const c = parsed as Record<string, unknown>;
    if (typeof c.savedAt !== "number" || !Number.isFinite(c.savedAt)) return null;
    if (typeof c.query !== "string") return null;
    if (!Array.isArray(c.entries)) return null;
    const entries = c.entries.filter((e): e is RegistryEntry => {
      if (!e || typeof e !== "object") return false;
      const x = e as Record<string, unknown>;
      return typeof x.key === "string" && typeof x.title === "string" && Array.isArray(x.options);
    });
    return {
      savedAt: c.savedAt,
      query: c.query,
      entries,
      nextCursor: typeof c.nextCursor === "string" ? c.nextCursor : undefined,
    };
  } catch {
    return null;
  }
}

function writeCache(storage: StorageLike, cache: RegistryCache): void {
  try {
    storage.setItem(REGISTRY_CACHE_KEY, JSON.stringify(cache));
  } catch {
    /* 存不下只影响下次启动，不影响本次 */
  }
}

/** 默认确认：复用 HITL 的单槽 + 队列（不新建确认 store）。 */
function hitlConfirm(preview: RegistryInstallPreview): Promise<InstallDecision> {
  return useHitlStore
    .getState()
    .enqueueRaw<InstallDecision>(
      { kind: "registry-install", payload: preview },
      { agentId: "registry", conversationId: "registry", streamId: "registry", agentName: "Registry" },
    )
    .then((d) => d ?? { approved: false });
}

export function createRegistryStore(deps: RegistryStoreDeps = {}): RegistryStore {
  const storage = deps.storage ?? defaultStorage();
  const fetchImpl = deps.fetchImpl;
  const mcp = () => deps.mcp ?? mcpRegistry;
  const now = deps.now ?? (() => Date.now());
  const refresh = deps.refreshTools ?? refreshServerTools;
  const confirm = deps.confirmInstall ?? hitlConfirm;
  const probeRuntime = deps.probeRuntime ?? probeLocalRuntime;

  return create<RegistryState>((set, get) => ({
    entries: [],
    nextCursor: undefined,
    loading: false,
    loadingMore: false,
    probingRuntime: false,
    runtime: null,
    runtimeProbed: false,
    installedKeys: [],
    error: null,
    stale: false,
    query: "",
    loadedAt: null,
    installingKey: null,

    probeRuntime: async (force = false) => {
      if (get().probingRuntime) return;
      if (get().runtimeProbed && !force) return;
      set({ probingRuntime: true });
      // probeLocalRuntime 永不抛，这里再兜一层：注入的实现可能坏。
      let status: LocalRuntimeStatus | null = null;
      try {
        status = await probeRuntime();
      } catch {
        status = null;
      }
      set({ runtime: status, runtimeProbed: true, probingRuntime: false });
    },

    load: async (query, opts = {}) => {
      const q = (query ?? get().query).trim();
      if (q !== get().query) set({ query: q });

      const cached = readCache(storage);
      const cacheFresh =
        !!cached && cached.query === q && now() - cached.savedAt < REGISTRY_CACHE_TTL_MS;

      // TTL 内直接用缓存：断网时也不该先闪一下空白。
      if (!opts.force && cached && cacheFresh) {
        set({
          entries: cached.entries,
          nextCursor: cached.nextCursor,
          loadedAt: cached.savedAt,
          stale: false,
          error: null,
          loading: false,
        });
        get().syncInstalled();
        return;
      }

      set({ loading: true, error: null });
      let result;
      try {
        result = q
          ? await search(q, { fetchImpl })
          : await fetchPage(undefined, REGISTRY_PAGE_SIZE, { fetchImpl });
      } catch (err) {
        // 数据层已把错误归一成 `{ok:false}`；这里再兜一层，保证 load 永不抛。
        result = { ok: false as const, error: `无法连接 Registry：${(err as Error).message}` };
      }

      if (result.ok) {
        const savedAt = now();
        set({
          entries: result.value,
          nextCursor: result.nextCursor,
          loadedAt: savedAt,
          stale: false,
          error: null,
          loading: false,
        });
        writeCache(storage, { savedAt, query: q, entries: result.value, nextCursor: result.nextCursor });
        get().syncInstalled();
        return;
      }

      // 失败：保留旧数据。只有同一个查询的缓存才能当降级内容——
      // 把别的搜索词的结果显示出来，用户会以为搜索命中了。
      const fallback = cached && cached.query === q ? cached : null;
      const entries = fallback?.entries ?? get().entries;
      set({
        entries,
        nextCursor: fallback?.nextCursor ?? get().nextCursor,
        loadedAt: fallback?.savedAt ?? get().loadedAt,
        error: result.error,
        stale: entries.length > 0,
        loading: false,
      });
      get().syncInstalled();
    },

    loadMore: async () => {
      const { nextCursor, query, loadingMore } = get();
      if (!nextCursor || loadingMore) return;
      set({ loadingMore: true, error: null });
      const result = query
        ? await search(query, { fetchImpl, cursor: nextCursor })
        : await fetchPage(nextCursor, REGISTRY_PAGE_SIZE, { fetchImpl });
      if (!result.ok) {
        set({ loadingMore: false, error: result.error });
        return;
      }
      const seen = new Set(get().entries.map((e) => e.key));
      const merged = [...get().entries, ...result.value.filter((e) => !seen.has(e.key))];
      set({ entries: merged, nextCursor: result.nextCursor, loadingMore: false, error: null });
      get().syncInstalled();
    },

    setQuery: (query) => set({ query: query.trim() }),

    syncInstalled: () => {
      const servers = mcp().servers();
      const names = new Set(
        servers.map((s) => s.registryName).filter((n): n is string => typeof n === "string" && !!n),
      );
      const ids = new Set(servers.map((s) => s.id));
      for (const entry of get().entries) {
        // 旧配置可能没有 `registryName`（字段是后加的）：id 也能认出来。
        if (ids.has(registryServerId(entry.key))) names.add(entry.key);
      }
      set({ installedKeys: [...names] });
    },

    isInstalled: (key) => get().installedKeys.includes(key),

    install: async (entry, option) => {
      if (get().installingKey) return { ok: false, error: "正在安装另一个服务，请稍候" };
      if (get().isInstalled(entry.key)) return { ok: false, error: "该服务已安装" };

      // ★ 前置判定放在确认**之前**：跑不起来的包不该让用户填一遍表再告诉他失败。
      // 本地包必须先知道本机有没有 Node/uv（页面挂载时已探过一次，这里兜底——
      // 用户可能直接从别的入口调 install，或探测当时还没回来）。
      if (runtimeRequirementFor(option) && !get().runtimeProbed) await get().probeRuntime();
      const blocked = blockedReason(option, get().runtime);
      if (blocked) return { ok: false, error: blocked };

      const preview = buildInstallPreview(entry, option);
      set({ installingKey: entry.key });
      try {
        const decision = await confirm(preview);
        if (!decision?.approved) return { ok: false, canceled: true };

        const sanitized = sanitizeHeaders(preview.headerHints, decision.headers ?? {});
        if (sanitized.error) return { ok: false, error: sanitized.error };

        // 确认期间可能已被另一次安装写入：再查一次，避免同一服务两条配置。
        if (get().isInstalled(entry.key)) return { ok: false, error: "该服务已安装" };

        const config = toServerConfig(entry, option, () => new Date(now()).toISOString(), sanitized.headers);
        mcp().add(config);
        get().syncInstalled();

        try {
          const tools = await refresh(config.id, mcp());
          return { ok: true, tools: tools.length };
        } catch (err) {
          // 配置已落盘：保留，让用户在接口区重试或删除，而不是静默回滚。
          return {
            ok: false,
            error: `已保存配置，但连接失败：${(err as Error).message}。可在接口区重试或删除。`,
          };
        }
      } finally {
        set({ installingKey: null });
      }
    },
  }));
}

/** 全局单例（浏览器 localStorage）。测试请 `createRegistryStore(内存依赖)`。 */
export const useRegistryStore = createRegistryStore();
