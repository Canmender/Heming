import { create } from "zustand";
import {
  callInfohub,
  describeInfohubError,
  infohubBridgeStatus,
  infohubInfo,
  isInfohubAvailable,
  onInfohubBridgeEvent,
  probeInfohubBridge,
  readInfohubConfig,
  startInfohub,
  startInfohubBridge,
  stopInfohub,
  stopInfohubBridge,
  type InfohubAgendaResult,
  type InfohubBridgeConfig,
  type InfohubBridgeInfo,
  type InfohubBridgeStatus,
  type InfohubProbeResult,
  type InfohubStatus,
} from "./client.js";

/**
 * 信息中枢的共享运行态（d.46）。
 *
 * 页面、首页卡、命令面板和智能体工具都要知道「本机归档连没连、有哪些日程」，
 * 所以连接态不能只留在 InfohubPage 的 useState 里。
 *
 * 进程生命周期不变：`boot()` 只读 `info()`，**不启动**；只有 `connect()`
 * （用户点「连接」）才会拉起 Python 边车。
 *
 * d.96 起这里还托管**采集桥**（本机 MCP 端点）的运行态：它和归档边车是两条路
 * （一个给插件/智能体用、一个给页面读归档），互不阻塞，也都不自动拉起。
 */

export const AGENDA_DAYS = 14;
export const AGENDA_OVERDUE = 30;

export type InfohubBusy = "" | "connecting" | "status" | "agenda" | "rebuild";

/** 采集桥的忙碌态；与归档边车的 `busy` 分开，避免「启动采集桥」把归档刷新按钮也锁住。 */
export type InfohubBridgeBusy = "" | "refresh" | "start" | "stop" | "probe";

interface InfohubState {
  available: boolean;
  running: boolean;
  booted: boolean;
  info: InfohubBridgeInfo | null;
  status: InfohubStatus | null;
  agenda: InfohubAgendaResult | null;
  busy: InfohubBusy;
  error: string;
  /** 采集桥运行态（桌面端 IPC 产出；浏览器端恒为 null）。运行态不持久化。 */
  bridgeStatus: InfohubBridgeStatus | null;
  /** 采集桥忙碌态（启动/停止/刷新/探测），页面据此禁用按钮。 */
  bridgeBusy: InfohubBridgeBusy;
  /** 采集桥的 IPC 错误（与 `bridgeStatus.error` 互补：一个来自本次操作，一个来自主进程状态）。 */
  bridgeError: string;
  /** 浏览器端最近一次 `/health` 探测结果；桌面端为 null（桌面端读 IPC，不探测网络）。 */
  bridgeProbe: InfohubProbeResult | null;
  /** 最近一次探测完成时间（epoch ms）；null 表示还没探测过（页面显示「尚未检测」）。 */
  bridgeProbedAt: number | null;
  /** 只探测桥与运行态，不拉起进程。幂等。 */
  boot: () => Promise<void>;
  /** 用户显式连接：拉起进程后刷新统计与日程。 */
  connect: () => Promise<void>;
  refresh: () => Promise<void>;
  loadAgenda: () => Promise<void>;
  rebuildAgenda: () => Promise<void>;
  disconnect: () => Promise<void>;
  /** 页面已拿到最新 info（启动/复用）时同步过来。 */
  syncInfo: (info: InfohubBridgeInfo) => void;
  /** 进程已停止：清掉依赖连接的数据。 */
  markStopped: () => void;
  /** 读取采集桥状态；桌面端同时确保事件订阅只挂一次。 */
  refreshBridge: () => Promise<void>;
  /** 用户显式启动采集桥（绝不自动调用）。 */
  startBridge: (config?: InfohubBridgeConfig) => Promise<void>;
  /** 停止和鸣自己拉起的采集桥（外部进程不代关）。 */
  stopBridge: () => Promise<void>;
  /** 浏览器端探测本机 `/health`；桌面端退化为读 IPC 状态。 */
  probeBridge: () => Promise<void>;
  /** 清空采集桥运行态并退订事件（测试与页面彻底断开时用；日常卸载**不**退订）。 */
  resetBridge: () => void;
}

function messageOf(err: unknown): string {
  return describeInfohubError(err);
}

/**
 * 采集桥状态事件是 **store 级单例**（d.96）：
 * 页面卸载不丢订阅——用户切去别的页再回来，事件仍在流；重挂页面也不需要重新握手。
 * 真正退订只发生在 `resetBridge()`（测试隔离 / 彻底断开）。
 */
let bridgeEventOff: (() => void) | null = null;

function ensureBridgeEventSubscription(): void {
  if (bridgeEventOff || !isInfohubAvailable()) return;
  bridgeEventOff = onInfohubBridgeEvent((status) => {
    useInfohubStore.setState({ bridgeStatus: status, bridgeError: status.error ?? "" });
  });
}

export const useInfohubStore = create<InfohubState>((set, get) => ({
  available: false,
  running: false,
  booted: false,
  info: null,
  status: null,
  agenda: null,
  busy: "",
  error: "",
  bridgeStatus: null,
  bridgeBusy: "",
  bridgeError: "",
  bridgeProbe: null,
  bridgeProbedAt: null,

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
    if (get().busy === "connecting") return;
    set({ available: true, busy: "connecting", error: "" });
    try {
      const info = await startInfohub(readInfohubConfig());
      set({ info, running: Boolean(info.running) });
      await get().refresh();
    } catch (err) {
      set({ running: false, error: messageOf(err) });
    } finally {
      set({ busy: "" });
    }
  },

  refresh: async () => {
    if (!get().running) return;
    set({ busy: "status", error: "" });
    try {
      const config = readInfohubConfig();
      const status = await callInfohub<InfohubStatus>("status", {}, config);
      set({ status });
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
      ...(info.running ? {} : { status: null, agenda: null }),
      error: "",
    }),

  markStopped: () =>
    set({ running: false, status: null, agenda: null, busy: "", error: "" }),

  refreshBridge: async () => {
    if (!isInfohubAvailable()) {
      // 浏览器端没有 IPC：把桌面侧运行态清空，探测结果由 probeBridge() 单独维护。
      set({ bridgeStatus: null, bridgeBusy: "", bridgeError: "" });
      return;
    }
    if (get().bridgeBusy === "start" || get().bridgeBusy === "stop") return;
    ensureBridgeEventSubscription();
    set({ bridgeBusy: "refresh", bridgeError: "" });
    try {
      const status = await infohubBridgeStatus();
      set({ bridgeStatus: status });
    } catch (err) {
      set({ bridgeError: messageOf(err) });
    } finally {
      set({ bridgeBusy: "" });
    }
  },

  startBridge: async (config = {}) => {
    if (!isInfohubAvailable()) {
      set({ bridgeError: "信息中枢仅桌面端可用" });
      return;
    }
    const busy = get().bridgeBusy;
    if (busy === "start" || busy === "stop") return;
    ensureBridgeEventSubscription();
    set({ bridgeBusy: "start", bridgeError: "" });
    try {
      const status = await startInfohubBridge(config);
      set({ bridgeStatus: status });
    } catch (err) {
      // 拉起失败是**用户操作**失败：错误留在 bridgeError，状态行显示「失败：<原因>」；
      // 桌面端 status.error 可能同时有更细的原因，页面按「本次错误优先」展示。
      set({ bridgeError: messageOf(err) });
    } finally {
      set({ bridgeBusy: "" });
    }
  },

  stopBridge: async () => {
    if (!isInfohubAvailable()) return;
    const busy = get().bridgeBusy;
    if (busy === "start" || busy === "stop") return;
    ensureBridgeEventSubscription();
    set({ bridgeBusy: "stop", bridgeError: "" });
    try {
      const stopped = await stopInfohubBridge();
      if (!stopped) {
        set({ bridgeError: "采集桥由外部进程运行，请在你启动它的窗口里关闭" });
      }
      const status = await infohubBridgeStatus();
      set({ bridgeStatus: status });
    } catch (err) {
      set({ bridgeError: messageOf(err) });
    } finally {
      set({ bridgeBusy: "" });
    }
  },

  probeBridge: async () => {
    if (isInfohubAvailable()) {
      // 桌面端有 IPC：直接读状态即可，不必走网络探测（也就不受 PNA/CORS 差异影响）。
      await get().refreshBridge();
      return;
    }
    set({ bridgeBusy: "probe", bridgeError: "" });
    try {
      const result = await probeInfohubBridge();
      set({
        bridgeProbe: result,
        bridgeProbedAt: Date.now(),
        bridgeError: result.ok ? "" : result.error ?? "",
      });
    } catch (err) {
      // probeInfohubBridge 承诺不抛；这里只是兜底，避免未来改动把异常漏进渲染。
      const error = messageOf(err);
      set({ bridgeProbe: { ok: false, error }, bridgeProbedAt: Date.now(), bridgeError: error });
    } finally {
      set({ bridgeBusy: "" });
    }
  },

  resetBridge: () => {
    bridgeEventOff?.();
    bridgeEventOff = null;
    set({
      bridgeStatus: null,
      bridgeBusy: "",
      bridgeError: "",
      bridgeProbe: null,
      bridgeProbedAt: null,
    });
  },
}));

/** 当前是否可把归档工具交给智能体（桌面端 + 已连接）。 */
export function canUseInfohub(): boolean {
  return isInfohubAvailable() && useInfohubStore.getState().running;
}
