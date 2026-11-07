import { useEffect } from "react";
import { create } from "zustand";
import {
  callInfohub,
  describeInfohubError,
  isInfohubAvailable,
  readInfohubConfig,
  startInfohub,
  startInfohubBridge,
  type InfohubBridgeConfig,
  type InfohubBridgeInfo,
  type InfohubBridgeStatus,
  type InfohubConfig,
  type InfohubSyncResult,
} from "./client.js";
import {
  effectiveEnabled,
  pluginStore,
  PLUGINS_CHANGED_EVENT,
  type InstalledPlugin,
} from "../plugins/store.js";
import { useInfohubStore } from "./store.js";

/**
 * 装插件后自动采集（d.98）。
 *
 * 用户诉求是「和鸣里装了采集插件就自动开始采」，而 d.97 之前只有手动点「同步」。
 * 这里补的是**应用级后台动作**（和自动化模块同口径），不是模型工具调用：
 * - 只在桌面端真采集：浏览器端没有 IPC，绝不拉起任何进程（只把状态记为不可用）；
 * - 插件是开关：安装/启用即补一次，停用/卸载即停；用户还能在页面单独关掉自动采集；
 * - 每 30 分钟增量一次；上一轮没结束不开下一轮（`sync` 最长 30 分钟超时）；
 * - 只在本机：不写会话、不上传；localStorage 里只存「开关」，不存归档正文。
 *
 * 采集桥（HTTP MCP，127.0.0.1:8776）和归档边车（stdio）是两条路：前者让插件/智能体
 * 能连上，后者提供 `sync` 方法。两边的 `start` 在桌面端都是「同目标已在跑则复用」，
 * 所以每轮都调一遍等于「需要时才真正拉起」，不会反复 spawn。
 */

/** 采集插件 id（与 `plugins/infohub-collector/plugin.json` 的 id 逐字一致，改一边必须改另一边）。 */
export const COLLECTOR_PLUGIN_ID = "heming.infohub-collector";
/** 自动采集间隔：30 分钟一次增量采集（`sync` 只采集，不重扫日程/不导出知识库）。 */
export const AUTO_COLLECT_INTERVAL_MS = 30 * 60_000;
/** 偏好键：只存自动采集开关；归档正文、消息内容一律不进 localStorage。 */
export const AUTO_COLLECT_KEY = "heming.infohub.autoCollect.v1";

/** 最近一次采集的结论；`idle` = 还没跑过（或从未成功）。 */
export type AutoCollectRunStatus = "idle" | "ok" | "error";

/**
 * 自动采集的共享状态。
 *
 * 页面（信息中枢「自动采集」区块）按这里的字段接线：`pluginActive/enabled` 决定
 * 开关能不能用，`running/lastRunAt/lastStatus/lastMessage/nextRunAt` 决定状态行。
 */
export interface AutoCollectState {
  /** 采集插件存在且 MCP 服务贡献生效（用户没关总开关、没单独停用 mcpServers）。 */
  pluginActive: boolean;
  /** 用户偏好：自动采集是否开启（默认开启；关闭后仍可手动 `runNow("manual")`）。 */
  enabled: boolean;
  /** 正在跑一轮采集（防重入的观测位，页面据此禁用「立即采集」并显示进度）。 */
  running: boolean;
  /** 最近一次采集**尝试**完成的时间（epoch ms）；失败也记，避免立刻重试。 */
  lastRunAt: number | null;
  /** 最近一次采集结论。 */
  lastStatus: AutoCollectRunStatus;
  /** 给人看的一句话：本次摘要或失败原因（不存归档正文）。 */
  lastMessage: string;
  /** 下一次计划采集时间（epoch ms）；插件停用/自动采集关闭时为 null。 */
  nextRunAt: number | null;
  /** 重算 `pluginActive` 并重新读偏好（安装/启用/回前台/页面挂载时调用）。 */
  refresh: () => void;
  /** 写偏好；关闭时清掉 `nextRunAt`（页面据此显示「已停止」）。 */
  setEnabled: (enabled: boolean) => void;
  /**
   * 跑一轮采集（防重入：`running` 时为 no-op）。
   *
   * - `"install"`：安装/启用插件后立刻补一次（不等 30 分钟）；
   * - `"schedule"`：定时器到点，只有距上次采集满一个间隔才真跑；
   * - `"manual"`：页面「立即采集」——用户显式动作，关掉自动采集也照跑。
   */
  runNow: (reason?: AutoCollectReason) => Promise<void>;
}

export type AutoCollectReason = "manual" | "install" | "schedule";

/* ------------------------------------------------------------------ 偏好读写 */

function storageOrNull(): Storage | null {
  if (typeof window === "undefined") return null;
  try {
    return window.localStorage;
  } catch {
    return null;
  }
}

/**
 * 读自动采集偏好：默认开启。
 *
 * 脏值（旧格式、手改坏、隐私模式下读不出）一律回落默认开启——用户装插件的
 * 本意就是「自动采」，静默关掉比多采一次更难解释；坏数据不抛错、不删。
 */
export function readAutoCollectEnabled(storage: Storage | null = storageOrNull()): boolean {
  if (!storage) return true;
  try {
    const raw = storage.getItem(AUTO_COLLECT_KEY);
    if (!raw) return true;
    const parsed: unknown = JSON.parse(raw);
    if (parsed && typeof parsed === "object" && !Array.isArray(parsed)) {
      const enabled = (parsed as Record<string, unknown>).enabled;
      if (typeof enabled === "boolean") return enabled;
    }
    return true;
  } catch {
    return true;
  }
}

/** 写自动采集偏好。只存 `{ enabled }`：这里不是归档缓存，绝不落消息正文。 */
export function writeAutoCollectEnabled(
  enabled: boolean,
  storage: Storage | null = storageOrNull(),
): void {
  if (!storage) return;
  try {
    storage.setItem(AUTO_COLLECT_KEY, JSON.stringify({ enabled }));
  } catch {
    /* 配额/隐私模式写失败不影响本次会话；调用方以内存态为准 */
  }
}

/* -------------------------------------------------------------------- 纯函数 */

/**
 * 插件是否处于「会采集」状态：存在 + 总开关开 + `mcpServers` 贡献未被单独停用。
 *
 * 读口径与插件页一致（`effectiveEnabled`）：用户把技能或命令单独关掉不影响采集，
 * 但把 MCP 服务贡献停掉 = 插件不再提供采集端点，自动采集也必须停。
 */
export function collectorPluginActive(plugins: readonly InstalledPlugin[]): boolean {
  const plugin = plugins.find((item) => item.manifest.id === COLLECTOR_PLUGIN_ID);
  if (!plugin) return false;
  return effectiveEnabled(plugin, "mcpServers");
}

export interface ShouldCollectInput {
  now: number;
  lastRunAt: number | null;
  /** 采集间隔；默认 {@link AUTO_COLLECT_INTERVAL_MS}（测试可缩短）。 */
  intervalMs?: number;
  /** 强制（安装/手动）：不看间隔，立刻采。 */
  force?: boolean;
}

/**
 * 到点该不该采。
 *
 * 时钟回拨（`now < lastRunAt`）时判为「不该采」：宁可比上次多等一会儿，
 * 也不要在时间跳变后连着采两轮（`sync` 很贵，且会重复读库）。
 */
export function shouldCollectNow(input: ShouldCollectInput): boolean {
  if (input.force) return true;
  if (input.lastRunAt === null || !Number.isFinite(input.lastRunAt)) return true;
  const intervalMs = input.intervalMs ?? AUTO_COLLECT_INTERVAL_MS;
  const elapsed = input.now - input.lastRunAt;
  if (!Number.isFinite(elapsed) || elapsed < 0) return false;
  return elapsed >= Math.max(intervalMs, 1);
}

/** 相对时间（过去）：「刚刚 / N 分钟前 / N 小时前 / N 天前」。 */
export function formatAutoCollectAgo(now: number, at: number): string {
  const seconds = Math.max(0, Math.round((now - at) / 1000));
  if (seconds < 60) return "刚刚";
  const minutes = Math.round(seconds / 60);
  if (minutes < 60) return `${minutes} 分钟前`;
  const hours = Math.round(minutes / 60);
  if (hours < 24) return `${hours} 小时前`;
  return `${Math.round(hours / 24)} 天前`;
}

/** 相对时间（未来）：「即将开始 / 约 N 分钟后」。 */
export function formatAutoCollectIn(now: number, at: number): string {
  const minutes = Math.round((at - now) / 60_000);
  if (minutes <= 0) return "即将开始";
  return `约 ${minutes} 分钟后`;
}

/**
 * 状态行文案（给信息中枢页直接用，避免页面自己拼一套口径）。
 *
 * `options.available` 默认取当前运行时（`isInfohubAvailable()`）：浏览器端即使装了
 * 插件也只会显示「只在桌面端运行」，不会谎报「已开启」。
 */
export function formatAutoCollectStatus(
  state: Pick<AutoCollectState, "pluginActive" | "enabled" | "running" | "lastRunAt" | "lastStatus" | "lastMessage" | "nextRunAt">,
  options: { now?: number; available?: boolean } = {},
): string {
  const available = options.available ?? isInfohubAvailable();
  if (!available) return "自动采集只在和鸣桌面端运行";
  if (!state.pluginActive) return "未启用「信息采集中枢」插件，装好并启用后会自动采集";
  if (state.running) return "正在采集本机消息…";
  if (!state.enabled) {
    if (state.lastRunAt === null) return "自动采集已关闭";
    const now = options.now ?? Date.now();
    return `自动采集已关闭（上次采集：${formatAutoCollectAgo(now, state.lastRunAt)}）`;
  }
  if (state.lastStatus === "error") {
    return `上次自动采集失败：${state.lastMessage || "未知原因"}`;
  }
  if (state.lastRunAt === null) return "自动采集已开启，等待首次采集";
  const now = options.now ?? Date.now();
  const summary = state.lastMessage ? `（${state.lastMessage}）` : "";
  const next = state.nextRunAt !== null ? `；下次${formatAutoCollectIn(now, state.nextRunAt)}` : "";
  return `上次自动采集：${formatAutoCollectAgo(now, state.lastRunAt)}${summary}${next}`;
}

/** 来源中文名（与自动化模块同口径；未知来源原样显示）。 */
function sourceLabel(source: string): string {
  if (source === "qq") return "QQ";
  if (source === "wechat") return "微信";
  if (source === "voice") return "语音";
  return source || "未知";
}

/**
 * 本次采集结果摘要（人话、只带计数，不带任何消息正文）。
 *
 * 与自动化模块 `infohub.sync` 的详情同一口径：新增按来源列、错误只计数。
 */
export function summarizeSyncResult(result: InfohubSyncResult | null | undefined): string {
  const reports = Array.isArray(result?.reports) ? result.reports : [];
  const additions = reports
    .filter((report) => Number(report.added) > 0)
    .map((report) => `${sourceLabel(report.source)} 新增 ${Number(report.added)}`);
  const errors = reports.reduce((count, report) => count + (report.errors?.length ?? 0), 0);
  let text = `同步完成：${additions.join("，") || "无新增"}`;
  if (errors > 0) text += `；${errors} 个采集错误`;
  return text;
}

/* -------------------------------------------------------------------- 依赖注入 */

/**
 * 采集动作的依赖面。
 *
 * 默认实现直接调真实 client / 共享 store；测试可整体替换（无需 mock 模块、
 * 也无需 fake timers 等 30 分钟）——这是「可测」与「生产行为」之间唯一的缝。
 */
export interface AutoCollectDeps {
  /** 时钟（默认 `Date.now`）。 */
  now: () => number;
  /** 桌面端是否可用（默认 `isInfohubAvailable`）。 */
  available: () => boolean;
  /** 当前已装插件快照（默认 `pluginStore.list`）。 */
  plugins: () => InstalledPlugin[];
  /** 拉起/复用归档边车（默认 `startInfohub`）。 */
  start: (config: InfohubConfig) => Promise<InfohubBridgeInfo>;
  /** 把刚拿到的边车信息同步给共享运行态（默认 `useInfohubStore.syncInfo`）。 */
  adopt: (info: InfohubBridgeInfo) => void;
  /** 拉起/复用采集桥（默认 `startInfohubBridge`）。 */
  startBridge: (config: InfohubBridgeConfig) => Promise<InfohubBridgeStatus>;
  /** 增量采集（默认 `callInfohub("sync", {})`）。 */
  sync: (config: InfohubConfig) => Promise<InfohubSyncResult>;
  /** 采集成功后刷新共享统计与日程（默认 `useInfohubStore.refresh`）。 */
  refreshStats: () => Promise<void>;
  /** 采集间隔（默认 {@link AUTO_COLLECT_INTERVAL_MS}；测试可缩短）。 */
  intervalMs: number;
}

function defaultDeps(): AutoCollectDeps {
  return {
    now: () => Date.now(),
    available: () => isInfohubAvailable(),
    plugins: () => pluginStore.list(),
    start: (config) => startInfohub(config),
    adopt: (info) => useInfohubStore.getState().syncInfo(info),
    startBridge: (config) => startInfohubBridge(config),
    sync: (config) => callInfohub<InfohubSyncResult>("sync", {}, config),
    refreshStats: () => useInfohubStore.getState().refresh(),
    intervalMs: AUTO_COLLECT_INTERVAL_MS,
  };
}

/**
 * 建一个自动采集 store（默认单例；测试可注入 deps 建独立实例）。
 *
 * 为什么把 deps 做成构造参数而不是模块级 mock：zustand store 是模块单例，
 * 测试若改单例的 deps 会串到别的用例；独立实例让每个用例有自己的时钟与调用记录。
 */
export function createAutoCollectStore(overrides: Partial<AutoCollectDeps> = {}) {
  const deps: AutoCollectDeps = { ...defaultDeps(), ...overrides };

  return create<AutoCollectState>((set, get) => ({
    // 初始状态直接按当前事实算，别留一个「假未启用」等调用方 refresh：
    // 页面首帧/事件处理里读到它时，插件可能早就装好了。
    pluginActive: collectorPluginActive(deps.plugins()),
    enabled: readAutoCollectEnabled(),
    running: false,
    lastRunAt: null,
    lastStatus: "idle",
    lastMessage: "",
    nextRunAt: null,

    refresh: () => {
      const pluginActive = collectorPluginActive(deps.plugins());
      const enabled = readAutoCollectEnabled();
      set((state) => ({
        pluginActive,
        enabled,
        // 插件停用/自动采集关闭时不再对外承诺「下一次」——页面据此显示已停止。
        nextRunAt: pluginActive && enabled ? state.nextRunAt : null,
      }));
    },

    setEnabled: (enabled) => {
      writeAutoCollectEnabled(enabled);
      const lastRunAt = get().lastRunAt;
      set({
        enabled,
        // 重新打开时按上次采集时间给出一个计划点（已过点则文案显示「即将开始」）。
        nextRunAt: enabled ? (lastRunAt === null ? null : lastRunAt + deps.intervalMs) : null,
      });
    },

    runNow: async (reason = "manual") => {
      const state = get();
      // 防重入：`sync` 可能跑很久（最长 30 分钟），上一轮没结束就不开下一轮。
      if (state.running) return;
      if (!state.pluginActive) {
        set({
          lastStatus: "idle",
          lastMessage: "未启用「信息采集中枢」插件，未采集本机消息",
        });
        return;
      }
      if (!state.enabled && reason !== "manual") return;
      if (!deps.available()) {
        set({ lastStatus: "idle", lastMessage: "自动采集只在和鸣桌面端运行" });
        return;
      }
      const startedAt = deps.now();
      if (
        reason === "schedule" &&
        !shouldCollectNow({
          now: startedAt,
          lastRunAt: state.lastRunAt,
          intervalMs: deps.intervalMs,
        })
      ) {
        return;
      }

      set({ running: true, lastMessage: "" });
      let bridgeError = "";
      try {
        const config = readInfohubConfig();
        // 采集桥失败只记录、不阻塞归档采集：插件连接可以下一轮再试，
        // 而归档 `sync` 走的是 stdio 边车，不依赖 8776 端点。
        try {
          await deps.startBridge(config);
        } catch (err) {
          bridgeError = describeInfohubError(err);
        }
        // 桌面端 start 在同目标已跑时直接复用，所以这里等价于「需要时才拉起」。
        const info = await deps.start(config);
        deps.adopt(info);
        const result = await deps.sync(config);
        const summary = summarizeSyncResult(result);
        const doneAt = deps.now();
        set({
          running: false,
          lastRunAt: doneAt,
          lastStatus: "ok",
          lastMessage: bridgeError ? `${summary}；采集桥启动失败：${bridgeError}` : summary,
          nextRunAt: doneAt + deps.intervalMs,
        });
        // `sync` 会写归档：刷新共享统计/日程，首页卡与工具不读旧数据。
        // 刷新失败不影响本次采集结论本身（归档已经写进去了）。
        try {
          await deps.refreshStats();
        } catch {
          /* 刷新失败沿用上一份缓存 */
        }
      } catch (err) {
        const failedAt = deps.now();
        set({
          running: false,
          // 失败也记时间：调度器据此等满一个间隔再试，失败不会变成重试风暴。
          lastRunAt: failedAt,
          lastStatus: "error",
          lastMessage: describeInfohubError(err),
          nextRunAt: failedAt + deps.intervalMs,
        });
      }
    },
  }));
}

/** 模块单例：App 层只挂一份，信息中枢页与插件事件读同一份状态。 */
export const useAutoCollectStore = createAutoCollectStore();

/* ------------------------------------------------------------------------ Hook */

/**
 * 自动采集循环（挂在 AppShell 登录后，切页不卸载）。
 *
 * `active` 由 App 组合：登录 + 信息中枢模块启用 + 桌面端。为 false 时**什么都不做**
 * （不挂定时器、不监听插件事件），浏览器端因此不会拉起任何进程。
 *
 * 何时采：
 * - 挂载：补一次（`shouldCollectNow` 保证 30 分钟内不重复，相当于「打开和鸣即增量采集」）；
 * - 插件安装/启用：立刻 `runNow("install")`；停用/卸载：停定时器 + 重算状态；
 * - 每 30 分钟：`runNow("schedule")`（上一轮没结束会被防重入挡掉）；
 * - 回前台：重算状态并补一拍（后台标签页定时器会被浏览器节流）。
 */
export function useAutoCollect(active: boolean): void {
  useEffect(() => {
    if (!active) return;

    useAutoCollectStore.getState().refresh();

    let cancelled = false;
    let timer: number | null = null;

    const tick = (reason: AutoCollectReason): void => {
      if (cancelled) return;
      void useAutoCollectStore.getState().runNow(reason);
    };

    const stopTimer = (): void => {
      if (timer === null) return;
      window.clearInterval(timer);
      timer = null;
    };

    const startTimer = (): void => {
      if (timer !== null) return;
      timer = window.setInterval(() => tick("schedule"), AUTO_COLLECT_INTERVAL_MS);
    };

    /** 定时器只在「插件生效 + 自动采集开 + 桌面端」三者同时成立时存在。 */
    const syncTimer = (): void => {
      const state = useAutoCollectStore.getState();
      if (state.pluginActive && state.enabled && isInfohubAvailable()) startTimer();
      else stopTimer();
    };

    const onPluginsChanged = (): void => {
      const wasActive = useAutoCollectStore.getState().pluginActive;
      useAutoCollectStore.getState().refresh();
      syncTimer();
      const activeNow = useAutoCollectStore.getState().pluginActive;
      // 只有「采集插件从不可用变为可用」（安装/启用）才立刻补一次；其它插件的增删、
      // 以及贡献级开关的微调不打扰采集节奏（事件是全局的，不给每个插件单独开一条通道）。
      if (!wasActive && activeNow) tick("install");
    };

    const onVisible = (): void => {
      if (document.visibilityState !== "visible") return;
      useAutoCollectStore.getState().refresh();
      syncTimer();
      // 补一拍；`shouldCollectNow` 保证距上次不满 30 分钟时不重复采。
      tick("schedule");
    };

    // 页面「自动采集」开关是外部动作（不是插件事件）：开回来时重启定时器并补一拍。
    const unsubscribe = useAutoCollectStore.subscribe((state, prev) => {
      if (state.enabled === prev.enabled && state.pluginActive === prev.pluginActive) return;
      syncTimer();
      if (!prev.enabled && state.enabled && state.pluginActive) tick("schedule");
    });

    syncTimer();
    // 启动补一次：应用可能刚打开、插件早就装好了（间隔未到会被 shouldCollectNow 拦掉）。
    tick("schedule");

    window.addEventListener(PLUGINS_CHANGED_EVENT, onPluginsChanged);
    document.addEventListener("visibilitychange", onVisible);

    return () => {
      cancelled = true;
      stopTimer();
      unsubscribe();
      window.removeEventListener(PLUGINS_CHANGED_EVENT, onPluginsChanged);
      document.removeEventListener("visibilitychange", onVisible);
    };
  }, [active]);
}
