import { describe, it, expect, beforeEach, afterEach, vi } from "vitest";
import { renderHook } from "@testing-library/react";
import { STAFF_FIRST_TICK_MS, useStaffLoop } from "./loop.js";
import { useStaffStore } from "./store.js";
import {
  DEFAULT_STAFF_SETTINGS,
  normalizeSeen,
  taskKey,
  todayKey,
  type StaffSettings,
} from "./model.js";
import { releaseStaffRun, tryAcquireStaffRun } from "./lock.js";
import { useTaskStore } from "../tasks/store.js";
import { useInfohubStore } from "../infohub/store.js";
import { useNotificationStore } from "../../store/notifications.js";
import type { TaskRecord } from "../tasks/store.js";

/**
 * 常驻循环的约定：只在登录后、开关打开时巡检；晨报每天一次；
 * 任务异常只提醒一次；浏览器端不碰 InfoHub 桥，更不拉起进程。
 */

type Bridge = NonNullable<Window["__heming_infohub"]>;

function resetStores(): void {
  useStaffStore.setState({
    settings: { ...DEFAULT_STAFF_SETTINGS, sources: { ...DEFAULT_STAFF_SETTINGS.sources } },
    runs: [],
    seen: normalizeSeen(null),
  });
  useTaskStore.setState({ tasks: [] });
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
  useNotificationStore.setState({ items: [] });
}

function enable(overrides: Partial<StaffSettings> = {}): void {
  const current = useStaffStore.getState().settings;
  useStaffStore.setState({
    settings: {
      ...current,
      enabled: true,
      ...overrides,
      sources: { ...current.sources, ...(overrides.sources ?? {}) },
    },
  });
}

function stuckTask(now: number): TaskRecord {
  return {
    id: "t-1",
    conversationId: "c-1",
    agentId: "a-1",
    agentName: "和鸣",
    title: "整理周报",
    prompt: "整理周报",
    status: "running",
    createdAt: now - 20 * 60_000,
    updatedAt: now - 11 * 60_000,
    steps: [],
  };
}

describe("幕僚常驻循环", () => {
  beforeEach(() => {
    vi.useFakeTimers();
    vi.setSystemTime(new Date(2026, 10, 1, 8, 5, 0));
    localStorage.clear();
    delete (window as unknown as { __heming_infohub?: unknown }).__heming_infohub;
    resetStores();
  });

  afterEach(() => {
    vi.useRealTimers();
    delete (window as unknown as { __heming_infohub?: unknown }).__heming_infohub;
  });

  it("未登录不挂载时不动任何记录", async () => {
    enable();
    const { unmount } = renderHook(() => useStaffLoop(false));
    await vi.advanceTimersByTimeAsync(STAFF_FIRST_TICK_MS * 2);
    expect(useStaffStore.getState().runs).toHaveLength(0);
    unmount();
  });

  it("开关关闭：到点也不运行", async () => {
    const { unmount } = renderHook(() => useStaffLoop(true));
    await vi.advanceTimersByTimeAsync(STAFF_FIRST_TICK_MS);
    expect(useStaffStore.getState().runs).toHaveLength(0);
    unmount();
  });

  it("晨报到点跑一次，并把今天记为已跑", async () => {
    enable();
    const { unmount } = renderHook(() => useStaffLoop(true));
    await vi.advanceTimersByTimeAsync(STAFF_FIRST_TICK_MS);

    const state = useStaffStore.getState();
    expect(state.runs).toHaveLength(1);
    expect(state.runs[0].trigger).toBe("daily");
    expect(state.settings.lastDailyDate).toBe(todayKey(Date.now()));
    // 没有发现：只进历史，不打扰通知中心
    expect(useNotificationStore.getState().items).toHaveLength(0);

    await vi.advanceTimersByTimeAsync(60_000);
    expect(useStaffStore.getState().runs).toHaveLength(1);
    unmount();
  });

  it("任务卡住：生成一次任务简报、记账并推送站内通知", async () => {
    enable({ sources: { daily: false, agenda: false, task: true } });
    const now = Date.now();
    useTaskStore.setState({ tasks: [stuckTask(now)] });

    const { unmount } = renderHook(() => useStaffLoop(true));
    await vi.advanceTimersByTimeAsync(STAFF_FIRST_TICK_MS);

    const state = useStaffStore.getState();
    expect(state.runs).toHaveLength(1);
    expect(state.runs[0].trigger).toBe("task");
    expect(state.runs[0].findings[0].action).toMatchObject({
      kind: "open-task",
      targetId: "t-1",
      conversationId: "c-1",
    });
    expect(state.seen.tasks[taskKey({ taskId: "t-1", issue: "stuck", updatedAt: now - 11 * 60_000 })]).toBe(
      state.runs[0].startedAt,
    );
    const items = useNotificationStore.getState().items;
    expect(items).toHaveLength(1);
    expect(items[0].kind).toBe("staff");

    // 事实没变化：冷却 + 去重，下一拍不再重复提醒
    await vi.advanceTimersByTimeAsync(60_000);
    expect(useStaffStore.getState().runs).toHaveLength(1);
    unmount();
  });

  it("浏览器端：没有桥就不发请求、不拉起 InfoHub", async () => {
    enable({ sources: { daily: false, agenda: true, task: false } });
    const connect = vi.fn(async () => {});
    useInfohubStore.setState({ connect });

    const { unmount } = renderHook(() => useStaffLoop(true));
    await vi.advanceTimersByTimeAsync(STAFF_FIRST_TICK_MS);

    expect(connect).not.toHaveBeenCalled();
    expect(useInfohubStore.getState().running).toBe(false);
    expect((window as unknown as { __heming_infohub?: Bridge }).__heming_infohub).toBeUndefined();
    expect(useStaffStore.getState().runs).toHaveLength(0);
    unmount();
  });

  it("回到前台补一拍：不依赖定时器也能触发", async () => {
    enable();
    const { unmount } = renderHook(() => useStaffLoop(true));
    // 还没到首个定时 tick，只靠 visibilitychange
    document.dispatchEvent(new Event("visibilitychange"));
    await vi.advanceTimersByTimeAsync(0);
    expect(useStaffStore.getState().runs).toHaveLength(1);
    unmount();
  });

  it("在途运行时不重复抢占（手动运行占锁）", async () => {
    enable();
    expect(tryAcquireStaffRun()).toBe(true);
    try {
      const { unmount } = renderHook(() => useStaffLoop(true));
      await vi.advanceTimersByTimeAsync(STAFF_FIRST_TICK_MS);
      expect(useStaffStore.getState().runs).toHaveLength(0);
      unmount();
    } finally {
      releaseStaffRun();
    }
  });
});
