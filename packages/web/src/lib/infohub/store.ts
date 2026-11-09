import { create } from "zustand";
import {
  callInfohub,
  describeInfohubError,
  detectedSourcesFromSummary,
  detectedSyncSources,
  detectInfohubSources,
  ensureInfohubEngine,
  infohubInfo,
  isInfohubAvailable,
  onInfohubEngineEvent,
  readAutoCollectPreference,
  readInfohubConfig,
  startInfohub,
  stopInfohub,
  supportsInfohubEngine,
  writeInfohubConfig,
  type InfohubAgendaResult,
  type InfohubBridgeInfo,
  type InfohubDetectedSources,
  type InfohubEngineProgress,
  type InfohubStatus,
  type InfohubSyncResult,
} from "./client.js";

/**
 * 信息中枢的共享运行态（d.46）。
 *
 * 页面、首页卡、命令面板和智能体工具都要知道「本机归档连没连、有哪些日程」，
 * 所以连接态不能只留在 InfohubPage 的 useState 里。
 *
 * 进程生命周期（d.115）：`boot()` 只读 `info()`；信息中枢模块生效后由
 * `ensureRunning()` 自动拉起边车，并自动完成一次目录识别后的首次采集。
 * 不再有「连接 / 断开」的用户入口——安装模块即运行，停用模块才下线。
 */

export const AGENDA_DAYS = 14;
export const AGENDA_OVERDUE = 30;

export type InfohubBusy = "" | "connecting" | "status" | "agenda" | "rebuild";

interface InfohubState {
  available: boolean;
  running: boolean;
  booted: boolean;
  info: InfohubBridgeInfo | null;
  status: InfohubStatus | null;
  agenda: InfohubAgendaResult | null;
  /** 最近一次自动识别结果（QQ / 微信目录）。 */
  detected: InfohubDetectedSources | null;
  /** 本轮连接是否已做过「首次自动采集」：保证只触发一次。 */
  autoCollected: boolean;
  /** 自动采集的进度/结果说明（页面与首页卡共用，不吞错误）。 */
  autoNote: string;
  busy: InfohubBusy;
  error: string;
  /** 只探测桥与运行态，不拉起进程。幂等。 */
  boot: () => Promise<void>;
  /** 拉起进程后刷新统计与日程。幂等：已运行时只补刷新。 */
  connect: () => Promise<void>;
  /**
   * 模块生效后的自动入口：探测 → 必要时拉起 → 刷新 → 空库时自动采集一次。
   * 不依赖任何页面挂载；重复调用不会重复启动或重复采集。
   */
  ensureRunning: () => Promise<void>;
  /** 归档为空且识别到来源时，自动识别 + 采集一次（每轮连接只跑一次）。 */
  autoCollectIfNeeded: () => Promise<void>;
  refresh: () => Promise<void>;
  loadAgenda: () => Promise<void>;
  rebuildAgenda: () => Promise<void>;
  /** 自动识别信息目录（不采集），并把结果写回状态。 */
  detect: () => Promise<InfohubDetectedSources | null>;
  disconnect: () => Promise<void>;
  /** 页面已拿到最新 info（启动/复用）时同步过来。 */
  syncInfo: (info: InfohubBridgeInfo) => void;
  /** 进程已停止：清掉依赖连接的数据。 */
  markStopped: () => void;
}

function messageOf(err: unknown): string {
  return describeInfohubError(err);
}

/**
 * 同一时刻只跑一次启动：App 与页面（或首页卡）可能同时调用 `ensureRunning()`，
 * 后到者必须等前一次结束，而不是看到「还没 running」就报启动失败。
 */
let connecting: Promise<void> | null = null;
/** 同一时刻只装一次引擎：两个窗口同时进入不会各下一份模块包。 */
let ensuringRun: Promise<void> | null = null;

function engineProgressNote(event: InfohubEngineProgress): string {
  const mb = (bytes: number) => (bytes / 1024 / 1024).toFixed(1);
  if (event.stage === "download") {
    return event.total > 0
      ? `正在下载信息中枢引擎：${mb(event.received)} / ${mb(event.total)} MB`
      : "正在下载信息中枢引擎…";
  }
  if (event.stage === "install") return "正在校验并安装信息中枢引擎…";
  if (event.stage === "done") return "信息中枢引擎已就绪";
  return "正在准备信息中枢引擎…";
}

export const useInfohubStore = create<InfohubState>((set, get) => ({
  available: false,
  running: false,
  booted: false,
  info: null,
  status: null,
  agenda: null,
  detected: null,
  autoCollected: false,
  autoNote: "",
  busy: "",
  error: "",

  boot: async () => {
    if (get().booted) return;
    if (!isInfohubAvailable()) {
      set({ booted: true, available: false });
      return;
    }
    set({ booted: true, available: true });
    try {
      const info = await infohubInfo();
      set({ info, running: Boolean(info.running) });
      if (info.running) await get().refresh();
    } catch (err) {
      set({ error: messageOf(err) });
    }
  },

  connect: async () => {
    if (!isInfohubAvailable()) {
      set({ available: false });
      return;
    }
    if (connecting) {
      await connecting;
      return;
    }
    if (get().running) {
      if (!get().status) await get().refresh();
      return;
    }
    set({
      available: true,
      busy: "connecting",
      error: "",
      autoCollected: false,
      autoNote: "",
    });
    const config = readInfohubConfig();
    connecting = (async () => {
      try {
        const info = await startInfohub(config);
        set({ info, running: Boolean(info.running) });
        // 主进程解析出的默认目录/解释器落盘：后续 status / sync 不必再猜。
        if (info.running && (info.home || info.python)) {
          writeInfohubConfig({
            home: info.home ?? config.home,
            python: info.python ?? config.python,
          });
        }
        await get().refresh();
      } catch (err) {
        set({ running: false, error: messageOf(err) });
      } finally {
        set({ busy: "" });
      }
    })();
    try {
      await connecting;
    } finally {
      connecting = null;
    }
  },

  ensureRunning: async () => {
    if (ensuringRun) return ensuringRun;
    const run = (async () => {
      await get().boot();
      if (!isInfohubAvailable()) return;
      // 引擎是选装模块：安装包里没有，第一次启用时按需下载官签名模块包。
      // 旧宿主没有这组通道，退回直接启动（开发态还能走仓库源码）。
      if (supportsInfohubEngine()) {
        let off = () => {};
        try {
          off = onInfohubEngineEvent((event) => set({ autoNote: engineProgressNote(event) }));
          const engine = await ensureInfohubEngine();
          if (!engine.installed) throw new Error("信息中枢引擎未就绪");
          set({ autoNote: "" });
        } catch (err) {
          const message = messageOf(err);
          // 下载/验签失败要停在这里：硬去 start 只会再多一条「引擎未安装」。
          set({ running: false, error: message, autoNote: `信息中枢引擎未就绪：${message}` });
          return;
        } finally {
          off();
        }
      }
      if (!get().running) await get().connect();
      if (!get().running) return;
      if (!get().status) await get().refresh();
      await get().autoCollectIfNeeded();
    })();
    ensuringRun = run;
    try {
      await run;
    } finally {
      if (ensuringRun === run) ensuringRun = null;
    }
  },

  autoCollectIfNeeded: async () => {
    const state = get();
    if (!state.running || !state.status || state.autoCollected) return;
    // 用户显式关过「自动采集」就尊重它；没设过则默认采集。
    if (readAutoCollectPreference() === false) return;
    // 已有归档数据 = 不是首次：自动采集只负责把空库填起来。
    if (state.status.hasDb && Number(state.status.stats?.messages ?? 0) > 0) return;
    const sources = detectedSyncSources(detectedSourcesFromSummary(state.status.config));
    if (sources.length === 0) {
      set({ autoNote: "自动采集已跳过：未识别到 QQ / 微信信息目录" });
      return;
    }
    // 先占位再跑：即便采集抛错，本轮连接也不会重复触发。
    set({
      autoCollected: true,
      autoNote: `自动采集中：${sources.map((s) => (s === "qq" ? "QQ" : "微信")).join(" / ")}…`,
    });
    try {
      const result = await callInfohub<InfohubSyncResult>(
        "sync",
        { sources, full: false, archive: false },
        readInfohubConfig(),
      );
      const reports = Array.isArray(result?.reports) ? result.reports : [];
      const errors = reports.flatMap((report) => report.errors ?? []);
      const added = reports.reduce((sum, report) => sum + (report.added ?? 0), 0);
      set({
        autoNote: errors.length
          ? `自动采集完成但有 ${errors.length} 个错误：${errors.slice(0, 2).join("；")}`
          : `自动采集完成：新增 ${added} 条消息`,
        ...(errors.length ? { error: errors.join("；") } : {}),
      });
      await get().refresh();
    } catch (err) {
      const message = messageOf(err);
      set({ error: message, autoNote: `自动采集失败：${message}` });
    }
  },

  refresh: async () => {
    if (!get().running) return;
    set({ busy: "status", error: "" });
    try {
      const config = readInfohubConfig();
      const status = await callInfohub<InfohubStatus>("status", {}, config);
      set({ status, detected: detectedSourcesFromSummary(status.config) });
      const agenda = await callInfohub<InfohubAgendaResult>(
        "agenda",
        { days: AGENDA_DAYS, overdue: AGENDA_OVERDUE },
        config,
      );
      set({ agenda });
    } catch (err) {
      set({ error: messageOf(err) });
    } finally {
      set({ busy: "" });
    }
  },

  loadAgenda: async () => {
    if (!get().running) return;
    set({ busy: "agenda", error: "" });
    try {
      const agenda = await callInfohub<InfohubAgendaResult>(
        "agenda",
        { days: AGENDA_DAYS, overdue: AGENDA_OVERDUE },
        readInfohubConfig(),
      );
      set({ agenda });
    } catch (err) {
      set({ error: messageOf(err) });
    } finally {
      set({ busy: "" });
    }
  },

  detect: async () => {
    if (!get().running) return null;
    try {
      const result = await detectInfohubSources(readInfohubConfig());
      const detected = result.sources ?? detectedSourcesFromSummary(result.summary);
      const status = get().status;
      set({
        detected,
        // summary 是最新口径：同步回 status.config，页面与首页卡读到同一份
        status: status ? { ...status, config: result.summary ?? status.config } : status,
        error: "",
      });
      return detected;
    } catch (err) {
      set({ error: messageOf(err) });
      return null;
    }
  },

  rebuildAgenda: async () => {
    if (!get().running) return;
    set({ busy: "rebuild", error: "" });
    try {
      const agenda = await callInfohub<InfohubAgendaResult>(
        "agenda",
        { days: AGENDA_DAYS, overdue: AGENDA_OVERDUE, rebuild: true },
        readInfohubConfig(),
      );
      set({ agenda });
    } catch (err) {
      set({ error: messageOf(err) });
    } finally {
      set({ busy: "" });
    }
  },

  disconnect: async () => {
    try {
      await stopInfohub();
    } catch {
      /* 进程可能已退出；断开仍应回到未连接态 */
    }
    get().markStopped();
  },

  syncInfo: (info) =>
    set({
      available: true,
      info,
      running: Boolean(info.running),
      ...(info.running
        ? {}
        : { status: null, agenda: null, autoCollected: false, autoNote: "" }),
      error: "",
    }),

  markStopped: () =>
    set({
      running: false,
      status: null,
      agenda: null,
      busy: "",
      error: "",
      autoCollected: false,
      autoNote: "",
    }),
}));

/** 当前是否可把归档工具交给智能体（桌面端 + 已连接）。 */
export function canUseInfohub(): boolean {
  return isInfohubAvailable() && useInfohubStore.getState().running;
}
