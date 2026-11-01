import { describe, it, expect, beforeEach, afterEach, vi } from "vitest";
import { renderHook } from "@testing-library/react";
import { AUTOMATION_TICK_MS, useAutomationScheduler } from "./scheduler.js";
import { useAutomationStore } from "./store.js";
import { DEFAULT_SYNC, type AutomationTask } from "./model.js";
import { useInfohubStore } from "../infohub/store.js";

/**
 * 调度器的约定：只在「桌面端 + 登录后 + 信息中枢已连接」时执行；
 * 错过的时刻只顺延不补跑；未连接时到点记为跳过，绝不拉起 Python。
 */

type Bridge = NonNullable<Window["__heming_infohub"]>;

function makeTask(overrides: Partial<AutomationTask> = {}): AutomationTask {
  return {
    id: "auto-1",
    name: "同步本机归档",
    kind: "infohub.sync",
    enabled: true,
    schedule: { type: "interval", minutes: 60 },
    sync: { ...DEFAULT_SYNC, sources: ["qq"] },
    createdAt: 1,
    updatedAt: 1,
    nextRunAt: Date.now() + 60_000,
    runCount: 0,
    ...overrides,
  };
}

function installBridge() {
  const call = vi.fn(async (method: string) => {
    if (method === "status") return {};
    if (method === "agenda") return { items: [], summary: { overdue: 0, today: 0, week: 0, total: 0 } };
    if (method === "sync") {
      return { reports: [{ source: "qq", added: 1, updated: 0, skipped: 0, errors: [] }], agenda: {}, kb: null };
    }
    return undefined;
  });
  const bridge = {
    info: vi.fn(async () => ({ running: true })),
    start: vi.fn(),
    call,
    stop: vi.fn(async () => true),
    pickHome: vi.fn(async () => null),
    pickPython: vi.fn(async () => null),
    onEvent: vi.fn(() => () => {}),
  } as unknown as Bridge;
  (window as unknown as { __heming_infohub?: Bridge }).__heming_infohub = bridge;
  return { bridge, call };
}

function resetStores() {
  useAutomationStore.setState({ tasks: [], runningId: null, runningSince: 0 });
  useInfohubStore.setState({
    available: false,
    running: false,
    booted: false,
    info: null,
    status: null,
    agenda: null,
    busy: "",
    error: "",
  });
}

describe("自动化调度器", () => {
  beforeEach(() => {
    vi.useFakeTimers();
    vi.setSystemTime(new Date(2026, 10, 1, 8, 0, 0));
    localStorage.clear();
    delete (window as unknown as { __heming_infohub?: unknown }).__heming_infohub;
    resetStores();
  });

  afterEach(() => {
    vi.useRealTimers();
    delete (window as unknown as { __heming_infohub?: unknown }).__heming_infohub;
  });

  it("浏览器端：到点也不动任务计划", async () => {
    const past = Date.now() - 60_000;
    useAutomationStore.setState({ tasks: [makeTask({ nextRunAt: past })] });

    const { unmount } = renderHook(() => useAutomationScheduler(true));
    await vi.advanceTimersByTimeAsync(AUTOMATION_TICK_MS * 3);

    const [task] = useAutomationStore.getState().tasks;
    expect(task.nextRunAt).toBe(past);
    expect(task.runCount).toBe(0);
    unmount();
  });

  it("启动探测未完成时不执行（不把「尚未探测」当「未连接」跑掉）", async () => {
    const { bridge } = installBridge();
    useAutomationStore.setState({ tasks: [makeTask()] });

    const { unmount } = renderHook(() => useAutomationScheduler(true));
    await vi.advanceTimersByTimeAsync(AUTOMATION_TICK_MS * 3);

    expect(bridge.call).not.toHaveBeenCalled();
    expect(useAutomationStore.getState().tasks[0].runCount).toBe(0);
    unmount();
  });

  it("已连接：到点执行一次并顺延下一次", async () => {
    const { call } = installBridge();
    useInfohubStore.setState({ available: true, booted: true, running: true });
    const due = Date.now() + 10_000;
    useAutomationStore.setState({ tasks: [makeTask({ nextRunAt: due })] });

    const { unmount } = renderHook(() => useAutomationScheduler(true));
    await vi.advanceTimersByTimeAsync(AUTOMATION_TICK_MS);

    const [task] = useAutomationStore.getState().tasks;
    expect(call).toHaveBeenCalledWith(
      "sync",
      { sources: ["qq"], full: false, archive: false },
      {},
    );
    expect(task.runCount).toBe(1);
    expect(task.lastStatus).toBe("ok");
    expect(task.nextRunAt).toBe(Date.now() + 60 * 60_000);
    expect(useAutomationStore.getState().runningId).toBeNull();
    unmount();
  });

  it("未连接：记为跳过并顺延，不拉起进程、不发请求", async () => {
    const { bridge } = installBridge();
    useInfohubStore.setState({ available: true, booted: true, running: false });
    useAutomationStore.setState({ tasks: [makeTask({ nextRunAt: Date.now() + 10_000 })] });

    const { unmount } = renderHook(() => useAutomationScheduler(true));
    await vi.advanceTimersByTimeAsync(AUTOMATION_TICK_MS);

    const [task] = useAutomationStore.getState().tasks;
    expect(task.lastStatus).toBe("skipped");
    expect(task.lastDetail).toContain("信息中枢未连接");
    expect(task.nextRunAt).toBeGreaterThan(Date.now());
    expect(bridge.start).not.toHaveBeenCalled();
    expect(bridge.call).not.toHaveBeenCalled();
    unmount();
  });

  it("启动前已到点的任务只顺延，不补跑", async () => {
    const { bridge } = installBridge();
    useInfohubStore.setState({ available: true, booted: true, running: true });
    useAutomationStore.setState({
      tasks: [makeTask({ nextRunAt: Date.now() - 3 * 60 * 60_000 })],
    });

    const { unmount } = renderHook(() => useAutomationScheduler(true));
    await vi.advanceTimersByTimeAsync(AUTOMATION_TICK_MS);

    const [task] = useAutomationStore.getState().tasks;
    expect(task.runCount).toBe(0);
    expect(task.lastRunAt).toBeUndefined();
    expect(task.nextRunAt).toBeGreaterThan(Date.now());
    expect(bridge.call).not.toHaveBeenCalled();
    unmount();
  });

  it("串行：已有任务在跑时不再抢占计划", async () => {
    installBridge();
    useInfohubStore.setState({ available: true, booted: true, running: true });
    useAutomationStore.setState({
      tasks: [makeTask({ nextRunAt: Date.now() + 10_000 })],
      runningId: "auto-busy",
      runningSince: Date.now(),
    });

    const { unmount } = renderHook(() => useAutomationScheduler(true));
    await vi.advanceTimersByTimeAsync(AUTOMATION_TICK_MS);

    expect(useAutomationStore.getState().tasks[0].runCount).toBe(0);
    expect(useAutomationStore.getState().runningId).toBe("auto-busy");
    unmount();
  });
});
