import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { act, renderHook } from "@testing-library/react";
import { createMemoryStorage } from "../memory/storage.js";
import { defaultWorkflowSettings, createWorkflow } from "./model.js";
import { setWorkflowStorage, useWorkflowStore } from "./store.js";
import { setWorkflowExecutionStorage, useWorkflowExecutionsStore } from "./executions.js";
import { setNotificationStorage, useNotificationStore } from "../../store/notifications.js";
import {
  MAX_RUNS_PER_TICK,
  WORKFLOW_TICK_MS,
  isScheduleWorkflow,
  nextWorkflowRun,
  pickDueWorkflows,
  postponeMissedRuns,
  useWorkflowScheduler,
} from "./scheduler.js";
import type { Workflow, WorkflowExecution } from "./types.js";

const { runMock } = vi.hoisted(() => ({ runMock: vi.fn() }));

vi.mock("./runtime.js", () => ({
  createWorkflowRuntime: () => ({ deps: {}, run: runMock }),
}));

const NOW = 1_700_000_000_000;
const MINUTE = 60_000;

function makeScheduleWorkflow(overrides: Partial<Workflow> = {}): Workflow {
  const base = createWorkflow({ name: "定时工作流", now: NOW });
  return {
    ...base,
    active: true,
    settings: defaultWorkflowSettings(),
    nodes: [
      {
        id: "trigger-1",
        name: "定时触发",
        type: "scheduleTrigger",
        position: { x: 0, y: 0 },
        parameters: { triggerInterval: "minutes", intervalCount: 1 },
      },
    ],
    ...overrides,
  };
}

function makeExecution(overrides: Partial<WorkflowExecution> = {}): WorkflowExecution {
  return {
    id: `exec-${Math.random().toString(36).slice(2, 8)}`,
    workflowId: "wf-1",
    workflowName: "定时工作流",
    mode: "trigger",
    status: "success",
    startedAt: NOW,
    finishedAt: NOW + 10,
    durationMs: 10,
    runData: {},
    ...overrides,
  };
}


beforeEach(() => {
  vi.useFakeTimers();
  vi.setSystemTime(NOW);
  const workflowStorage = createMemoryStorage();
  setWorkflowStorage(workflowStorage);
  setWorkflowExecutionStorage(createMemoryStorage());
  setNotificationStorage(createMemoryStorage());
  useWorkflowStore.setState({ workflows: [], selectedId: null });
  useWorkflowExecutionsStore.setState({ executions: [] });
  useNotificationStore.setState({ items: [] });
  runMock.mockReset();
  runMock.mockImplementation(async () => makeExecution());
});

afterEach(() => {
  vi.useRealTimers();
});

describe("isScheduleWorkflow / nextWorkflowRun", () => {
  it("识别启用中的定时触发器，忽略禁用节点与非定时节点", () => {
    expect(isScheduleWorkflow(makeScheduleWorkflow())).toBe(true);
    const disabled = makeScheduleWorkflow();
    const disabledNode = disabled.nodes[0];
    if (disabledNode) disabledNode.disabled = true;
    expect(isScheduleWorkflow(disabled)).toBe(false);
    expect(
      isScheduleWorkflow({
        nodes: [
          {
            id: "n1",
            name: "手动",
            type: "manualTrigger",
            position: { x: 0, y: 0 },
            parameters: {},
          },
        ],
      }),
    ).toBe(false);
  });

  it("下一次运行从 lastRunAt 起算；没有定时触发器返回 null", () => {
    const workflow = makeScheduleWorkflow({ lastRunAt: NOW });
    expect(nextWorkflowRun(workflow)?.getTime()).toBe(NOW + MINUTE);
    expect(
      nextWorkflowRun({
        nodes: [],
        createdAt: NOW,
        lastRunAt: undefined,
      }),
    ).toBeNull();
  });
});

describe("pickDueWorkflows", () => {
  it("只挑启用、含定时触发器且下一次已到点的，按到点时间排序", () => {
    const dueFirst = makeScheduleWorkflow({
      id: "wf-1",
      lastRunAt: NOW - 2 * MINUTE,
    });
    const dueSecond = makeScheduleWorkflow({
      id: "wf-2",
      lastRunAt: NOW - MINUTE,
    });
    const future = makeScheduleWorkflow({ id: "wf-3", lastRunAt: NOW - 10_000 });
    const inactive = makeScheduleWorkflow({ id: "wf-4", lastRunAt: NOW - 2 * MINUTE, active: false });
    const due = pickDueWorkflows([future, dueSecond, inactive, dueFirst], NOW);
    expect(due.map((workflow) => workflow.id)).toEqual(["wf-1", "wf-2"]);
  });
});

describe("postponeMissedRuns", () => {
  it("启动前已到点的顺延到 now，不补跑；未到点的不动", () => {
    const missed = makeScheduleWorkflow({ id: "wf-missed", lastRunAt: NOW - 10 * MINUTE });
    const future = makeScheduleWorkflow({ id: "wf-future", lastRunAt: NOW - 10_000 });
    useWorkflowStore.setState({ workflows: [missed, future], selectedId: null });

    expect(postponeMissedRuns(NOW)).toBe(1);
    const state = useWorkflowStore.getState();
    expect(state.workflows.find((workflow) => workflow.id === "wf-missed")?.lastRunAt).toBe(NOW);
    expect(state.workflows.find((workflow) => workflow.id === "wf-future")?.lastRunAt).toBe(
      NOW - 10_000,
    );
    // 顺延之后不会再被立刻挑出来跑
    expect(pickDueWorkflows(state.listActive(), NOW)).toEqual([]);
  });

  it("只处理 active 的定时工作流", () => {
    const inactive = makeScheduleWorkflow({ id: "wf-off", lastRunAt: NOW - MINUTE, active: false });
    useWorkflowStore.setState({ workflows: [inactive], selectedId: null });
    expect(postponeMissedRuns(NOW)).toBe(0);
  });
});

describe("useWorkflowScheduler", () => {
  it("enabled=false 时完全不排期", async () => {
    useWorkflowStore.setState({
      workflows: [makeScheduleWorkflow({ lastRunAt: NOW - 2 * MINUTE })],
      selectedId: null,
    });
    renderHook(() => useWorkflowScheduler(false));
    await act(async () => {
      await vi.advanceTimersByTimeAsync(WORKFLOW_TICK_MS * 3);
    });
    expect(runMock).not.toHaveBeenCalled();
  });

  it("到点后串行执行并写 lastRunAt；同一 tick 不重复挑同一条", async () => {
    const workflow = makeScheduleWorkflow({ lastRunAt: NOW - 30_000 });
    useWorkflowStore.setState({ workflows: [workflow], selectedId: null });
    const { unmount } = renderHook(() => useWorkflowScheduler(true));

    // 挂载时先跑一次 step：next = lastRunAt+60s = NOW+30s，还没到
    await act(async () => {
      await vi.advanceTimersByTimeAsync(0);
    });
    expect(runMock).not.toHaveBeenCalled();

    // 过 30 秒到点，15s tick 会在 30s 时命中
    await act(async () => {
      await vi.advanceTimersByTimeAsync(31_000);
    });
    expect(runMock).toHaveBeenCalledTimes(1);
    expect(runMock.mock.calls[0]?.[1]).toEqual({ mode: "trigger" });
    expect(useWorkflowStore.getState().workflows[0]?.lastRunAt).toBe(NOW + 30_000);

    // 再过一个 tick 不会重复跑（lastRunAt 已推进到下一次之前）
    await act(async () => {
      await vi.advanceTimersByTimeAsync(WORKFLOW_TICK_MS);
    });
    expect(runMock).toHaveBeenCalledTimes(1);
    unmount();
  });

  it("执行失败推一条 automation 通知，标题带工作流名", async () => {
    runMock.mockImplementation(async () =>
      makeExecution({
        id: "exec-fail",
        status: "error",
        error: { message: "HTTP 请求失败：连接被拒绝" },
      }),
    );
    const workflow = makeScheduleWorkflow({ lastRunAt: NOW - 30_000 });
    useWorkflowStore.setState({ workflows: [workflow], selectedId: null });
    const { unmount } = renderHook(() => useWorkflowScheduler(true));
    await act(async () => {
      await vi.advanceTimersByTimeAsync(31_000);
    });
    const items = useNotificationStore.getState().items;
    expect(items).toHaveLength(1);
    expect(items[0]?.kind).toBe("workflow");
    expect(items[0]?.title).toContain("定时工作流");
    expect(items[0]?.body).toContain("连接被拒绝");
    unmount();
  });

  it("runtime.run 抛错时兜底推通知且不崩", async () => {
    runMock.mockImplementation(async () => {
      throw new Error("宿主异常");
    });
    const workflow = makeScheduleWorkflow({ lastRunAt: NOW - 30_000 });
    useWorkflowStore.setState({ workflows: [workflow], selectedId: null });
    const { unmount } = renderHook(() => useWorkflowScheduler(true));
    await act(async () => {
      await vi.advanceTimersByTimeAsync(31_000);
    });
    expect(useNotificationStore.getState().items[0]?.body).toContain("宿主异常");
    unmount();
  });

  it("多个同时到点的工作流在一个 tick 内串行跑，且不超过单 tick 上限", async () => {
    const workflows = Array.from({ length: MAX_RUNS_PER_TICK + 2 }, (_, index) =>
      makeScheduleWorkflow({
        id: `wf-${index}`,
        name: `工作流 ${index}`,
        lastRunAt: NOW - 2 * MINUTE,
      }),
    );
    useWorkflowStore.setState({ workflows, selectedId: null });
    // 启动顺延会把它们推到现在之后 → 先把 lastRunAt 改回过去，模拟运行中到点
    const { unmount } = renderHook(() => useWorkflowScheduler(true));
    useWorkflowStore.setState({
      workflows: useWorkflowStore
        .getState()
        .workflows.map((workflow) => ({ ...workflow, lastRunAt: NOW - 2 * MINUTE })),
    });
    await act(async () => {
      await vi.advanceTimersByTimeAsync(WORKFLOW_TICK_MS);
    });
    expect(runMock.mock.calls.length).toBeGreaterThanOrEqual(1);
    expect(runMock.mock.calls.length).toBeLessThanOrEqual(MAX_RUNS_PER_TICK);
    unmount();
  });
});
