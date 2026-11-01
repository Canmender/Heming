import { create } from "zustand";
import {
  callInfohub,
  describeInfohubError,
  infohubInfo,
  isInfohubAvailable,
  readInfohubConfig,
  startInfohub,
  stopInfohub,
  type InfohubAgendaResult,
  type InfohubBridgeInfo,
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
  busy: InfohubBusy;
  error: string;
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
}

function messageOf(err: unknown): string {
  return describeInfohubError(err);
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
}));

/** 当前是否可把归档工具交给智能体（桌面端 + 已连接）。 */
export function canUseInfohub(): boolean {
  return isInfohubAvailable() && useInfohubStore.getState().running;
}
