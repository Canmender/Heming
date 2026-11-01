import { describe, it, expect, beforeEach, afterEach, vi } from "vitest";
import { runStaffNow } from "./manual.js";
import { useStaffStore } from "./store.js";
import { DEFAULT_STAFF_SETTINGS, normalizeSeen, taskKey, todayKey } from "./model.js";
import { releaseStaffRun, tryAcquireStaffRun } from "./lock.js";
import { useTaskStore, type TaskRecord } from "../tasks/store.js";
import { useInfohubStore } from "../infohub/store.js";
import { useNotificationStore } from "../../store/notifications.js";

/**
 * 手动运行与调度 tick 共用同一把锁：用户点「现在跑一次」时，
 * 必须立刻得到结果，且不会和后台巡检叠跑。
 */

function resetStores(): void {
  useStaffStore.setState({
    settings: {
      ...DEFAULT_STAFF_SETTINGS,
      enabled: true,
      sources: { ...DEFAULT_STAFF_SETTINGS.sources },
    },
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

function failedTask(now: number): TaskRecord {
  return {
    id: "t-9",
    conversationId: "c-9",
    agentId: "a-1",
    agentName: "和鸣",
    title: "抓取成绩单",
    prompt: "抓取成绩单",
    status: "failed",
    createdAt: now - 5 * 60_000,
    updatedAt: now - 60_000,
    endedAt: now - 60_000,
    error: "网络超时",
    steps: [],
  };
}

describe("幕僚手动运行", () => {
  beforeEach(() => {
    vi.useFakeTimers();
    vi.setSystemTime(new Date(2026, 10, 1, 9, 12, 0));
    localStorage.clear();
    delete (window as unknown as { __heming_infohub?: unknown }).__heming_infohub;
    resetStores();
  });

  afterEach(() => {
    vi.useRealTimers();
    delete (window as unknown as { __heming_infohub?: unknown }).__heming_infohub;
  });

  it("有失败任务时生成手动简报并落盘", async () => {
    const now = Date.now();
    useTaskStore.setState({ tasks: [failedTask(now)] });

    const result = await runStaffNow();
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.run.trigger).toBe("manual");
    expect(result.run.findings[0].title).toContain("抓取成绩单");

    const state = useStaffStore.getState();
    expect(state.runs).toHaveLength(1);
    expect(state.seen.tasks[taskKey({ taskId: "t-9", issue: "failed", updatedAt: now - 60_000 })]).toBe(
      result.run.startedAt,
    );
    expect(useNotificationStore.getState().items[0].kind).toBe("staff");
  });

  it("已有一份在跑时返回 busy，不排队也不生成第二份", async () => {
    expect(tryAcquireStaffRun()).toBe(true);
    try {
      const result = await runStaffNow();
      expect(result).toEqual({ ok: false, reason: "busy" });
      expect(useStaffStore.getState().runs).toHaveLength(0);
    } finally {
      releaseStaffRun();
    }
  });

  it("首次开启用 daily 触发：即使没有发现也留下记录并记今天", async () => {
    const result = await runStaffNow("daily");
    expect(result.ok).toBe(true);
    const state = useStaffStore.getState();
    expect(state.runs).toHaveLength(1);
    expect(state.runs[0].trigger).toBe("daily");
    expect(state.runs[0].findings).toHaveLength(0);
    expect(state.settings.lastDailyDate).toBe(todayKey(Date.now()));
    expect(useNotificationStore.getState().items).toHaveLength(0);
  });
});
