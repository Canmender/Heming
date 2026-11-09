/**
 * 调度器测试：用真实 Store（临时目录）+ 假 Runtime，验证 CONTRACT §4.4 的三条口径。
 *
 * 为什么用真实 store 而不是 mock 接口：
 * - 调度器的副作用（lastRunAt 顺延、失败通知）正是要验证的东西，mock 掉就只剩「调用了没有」；
 * - Store 是纯本机 JSON 文件，临时目录建一个很快，坏了也能整目录删掉；
 * - Runtime 反过来用假的：真实运行时会把引擎、节点库、表达式沙箱全拖进来，
 *   而这些与「什么时候该跑」无关。
 *
 * 时间全部用注入的 now()（业务代码里没有直接 Date.now()），所以「到点/未到点/错过」
 * 都是确定性判断，不依赖真实时钟。
 */

import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { createScheduler, MAX_RUNS_PER_TICK, SCHEDULER_INTERVAL_MS } from "./scheduler.js";
import { createStore, type Store } from "./storage.js";
import type { RunOptions, Runtime } from "./runtime.js";
import { createWorkflow } from "../model.js";
import { clearNodeRegistry, registerNodeType } from "../registry.js";
import { scheduleTrigger } from "../nodes/core/scheduleTrigger.js";
import type { NodeRunData, Workflow, WorkflowExecution, WorkflowNode } from "../types.js";

/** 固定的「现在」：2026-01-15 12:00 本地时间。所有断言都相对它。 */
const NOW = new Date(2026, 0, 15, 12, 0, 0, 0).getTime();
const SECOND = 1000;
const MINUTE = 60 * SECOND;
const DAY = 24 * 60 * MINUTE;

let dir: string;
let store: Store;

beforeEach(() => {
  // 调度器靠注册表识别「定时触发器」：这里用真实节点（参数语义就是最终线上行为）。
  clearNodeRegistry();
  registerNodeType(scheduleTrigger);
  dir = mkdtempSync(join(tmpdir(), "wf-scheduler-"));
  store = createStore(dir);
});

afterEach(() => {
  rmSync(dir, { recursive: true, force: true });
});

// ---------------------------------------------------------------------------
// 测试设施
// ---------------------------------------------------------------------------

interface RuntimeHarness {
  runtime: Runtime;
  calls: Array<{ workflow: Workflow; options?: RunOptions }>;
  active: Set<string>;
}

function successExecution(workflow: Workflow): WorkflowExecution {
  return {
    id: `exec-${workflow.id}-${Math.random().toString(36).slice(2, 6)}`,
    workflowId: workflow.id,
    workflowName: workflow.name,
    mode: "trigger",
    status: "success",
    startedAt: NOW,
    finishedAt: NOW + 5,
    durationMs: 5,
    runData: {},
  };
}

function failedExecution(workflow: Workflow, message: string): WorkflowExecution {
  const runData: NodeRunData = {
    startTime: NOW,
    executionTime: 3,
    executionIndex: 0,
    source: [{}],
    status: "error",
    itemsTotal: 0,
    error: { message, nodeName: "HTTP 请求", description: "检查凭据是否过期" },
  };
  return {
    id: `exec-${workflow.id}-fail`,
    workflowId: workflow.id,
    workflowName: workflow.name,
    mode: "trigger",
    status: "error",
    startedAt: NOW,
    finishedAt: NOW + 3,
    durationMs: 3,
    runData: { "node-http": [runData] },
    error: { message, nodeName: "HTTP 请求", description: "检查凭据是否过期" },
  };
}

/** 假运行时：默认成功，可注入延迟/失败；记录每次调用的参数。 */
function makeRuntime(
  handler: (workflow: Workflow, options?: RunOptions) => Promise<WorkflowExecution> = async (
    workflow,
  ) => successExecution(workflow),
): RuntimeHarness {
  const calls: Array<{ workflow: Workflow; options?: RunOptions }> = [];
  const active = new Set<string>();
  const runtime: Runtime = {
    async runWorkflow(workflow, options) {
      calls.push({ workflow, options });
      active.add(workflow.id);
      try {
        return await handler(workflow, options);
      } finally {
        active.delete(workflow.id);
      }
    },
    getLiveExecution: () => undefined,
    isRunning: (workflowId) => active.has(workflowId),
    stop: () => false,
  };
  return { runtime, calls, active };
}

let nodeSeq = 0;

function scheduleNode(intervalSeconds: number): WorkflowNode {
  nodeSeq += 1;
  return {
    id: `node-schedule-${nodeSeq}`,
    name: `定时触发 ${nodeSeq}`,
    type: "scheduleTrigger",
    position: { x: 0, y: 0 },
    parameters: { triggerInterval: "seconds", intervalCount: intervalSeconds },
  };
}

/** 造一条定时工作流并存进 store（active/lastRunAt 直接写，不经过 setActive 的真实时钟）。 */
function makeWorkflow(options: {
  id: string;
  name?: string;
  active?: boolean;
  lastRunAt?: number;
  intervalSeconds?: number;
  nodes?: WorkflowNode[];
}): Workflow {
  const workflow = createWorkflow({ id: options.id, name: options.name ?? "定时工作流", now: NOW - DAY });
  workflow.nodes = options.nodes ?? [scheduleNode(options.intervalSeconds ?? 60)];
  workflow.active = options.active ?? true;
  if (options.lastRunAt !== undefined) workflow.lastRunAt = options.lastRunAt;
  return store.saveWorkflow(workflow);
}

/** 一条明显到点的工作流：上次运行在 5 分钟前，间隔 60 秒。 */
function makeDueWorkflow(id: string, name?: string): Workflow {
  return makeWorkflow({ id, name, lastRunAt: NOW - 5 * MINUTE, intervalSeconds: 60 });
}

// ---------------------------------------------------------------------------
// 基础状态
// ---------------------------------------------------------------------------

describe("默认参数与状态", () => {
  it("默认 15 秒轮询、每个 tick 最多 5 条；未 start 时 running=false", () => {
    const { runtime } = makeRuntime();
    const scheduler = createScheduler(store, runtime);

    expect(SCHEDULER_INTERVAL_MS).toBe(15_000);
    expect(MAX_RUNS_PER_TICK).toBe(5);
    expect(scheduler.status()).toEqual({ running: false, intervalMs: 15_000, ticking: false });
    expect(scheduler.running).toBe(false);
  });

  it("start/stop 幂等：running 状态与 status() 一致", () => {
    const { runtime } = makeRuntime();
    const scheduler = createScheduler(store, runtime, { intervalMs: 60_000 });
    scheduler.start();
    scheduler.start();
    expect(scheduler.running).toBe(true);
    expect(scheduler.status().running).toBe(true);
    scheduler.stop();
    scheduler.stop();
    expect(scheduler.running).toBe(false);
    expect(scheduler.status().running).toBe(false);
  });
});

// ---------------------------------------------------------------------------
// 到点判断
// ---------------------------------------------------------------------------

describe("到点判断", () => {
  it("到点的工作流会被执行：mode=trigger、lastRunAt 推进到 now、成功不写通知", async () => {
    makeDueWorkflow("wf-due");
    const { runtime, calls } = makeRuntime();
    const scheduler = createScheduler(store, runtime, { now: () => NOW });

    await scheduler.tick();

    expect(calls).toHaveLength(1);
    expect(calls[0]?.workflow.id).toBe("wf-due");
    expect(calls[0]?.options?.mode).toBe("trigger");
    expect(store.getWorkflow("wf-due")?.lastRunAt).toBe(NOW);
    expect(store.listNotifications(5)).toHaveLength(0);
  });

  it("未到点不跑（间隔 60 秒，上次运行在 1 秒前）", async () => {
    makeWorkflow({ id: "wf-waiting", lastRunAt: NOW - SECOND, intervalSeconds: 60 });
    const { runtime, calls } = makeRuntime();
    const scheduler = createScheduler(store, runtime, { now: () => NOW });

    await scheduler.tick();

    expect(calls).toHaveLength(0);
    expect(store.getWorkflow("wf-waiting")?.lastRunAt).toBe(NOW - SECOND);
  });

  it("停用的工作流不跑（即使已经到点）", async () => {
    makeWorkflow({ id: "wf-inactive", active: false, lastRunAt: NOW - 5 * MINUTE, intervalSeconds: 60 });
    const { runtime, calls } = makeRuntime();
    const scheduler = createScheduler(store, runtime, { now: () => NOW });

    await scheduler.tick();

    expect(calls).toHaveLength(0);
  });

  it("不含定时触发器的工作流不跑（手动触发不算排期）", async () => {
    const manualNode: WorkflowNode = {
      id: "node-manual",
      name: "手动触发",
      type: "manualTrigger",
      position: { x: 0, y: 0 },
      parameters: {},
    };
    makeWorkflow({
      id: "wf-manual",
      lastRunAt: NOW - 5 * MINUTE,
      nodes: [manualNode],
    });
    const { runtime, calls } = makeRuntime();
    const scheduler = createScheduler(store, runtime, { now: () => NOW });

    await scheduler.tick();

    expect(calls).toHaveLength(0);
  });

  it("定时参数非法（不可排期）时跳过，不报错", async () => {
    const broken = scheduleNode(60);
    broken.parameters = { triggerInterval: "seconds", intervalCount: 999_999 };
    makeWorkflow({ id: "wf-broken", lastRunAt: NOW - 5 * MINUTE, nodes: [broken] });
    const { runtime, calls } = makeRuntime();
    const scheduler = createScheduler(store, runtime, { now: () => NOW });

    await expect(scheduler.tick()).resolves.toBeUndefined();
    expect(calls).toHaveLength(0);
  });

  it("多条到点时按到点时刻从早到晚执行，且一个 tick 最多跑 maxRunsPerTick 条", async () => {
    // 越早到点的 id 越靠前：a 错过 9 分钟、b 4 分钟、c 1 分钟
    makeWorkflow({ id: "wf-a", lastRunAt: NOW - 9 * MINUTE, intervalSeconds: 60 });
    makeWorkflow({ id: "wf-b", lastRunAt: NOW - 4 * MINUTE, intervalSeconds: 60 });
    makeWorkflow({ id: "wf-c", lastRunAt: NOW - 1 * MINUTE, intervalSeconds: 60 });
    const { runtime, calls } = makeRuntime();
    const scheduler = createScheduler(store, runtime, { now: () => NOW, maxRunsPerTick: 2 });

    await scheduler.tick();

    expect(calls.map((call) => call.workflow.id)).toEqual(["wf-a", "wf-b"]);
  });
});

// ---------------------------------------------------------------------------
// 串行
// ---------------------------------------------------------------------------

describe("全局串行", () => {
  it("一条跑完才开始下一条（按到点顺序，不并发）", async () => {
    makeWorkflow({ id: "wf-first", lastRunAt: NOW - 9 * MINUTE, intervalSeconds: 60 });
    makeWorkflow({ id: "wf-second", lastRunAt: NOW - 4 * MINUTE, intervalSeconds: 60 });
    const events: string[] = [];
    const { runtime } = makeRuntime(async (workflow) => {
      events.push(`start:${workflow.id}`);
      await new Promise((resolve) => setTimeout(resolve, 5));
      events.push(`end:${workflow.id}`);
      return successExecution(workflow);
    });
    const scheduler = createScheduler(store, runtime, { now: () => NOW });

    await scheduler.tick();

    expect(events).toEqual(["start:wf-first", "end:wf-first", "start:wf-second", "end:wf-second"]);
  });

  it("ticking 期间再次 tick 直接返回（不堆积并发轮询）", async () => {
    makeDueWorkflow("wf-serial");
    let release = (): void => {};
    const gate = new Promise<void>((resolve) => {
      release = resolve;
    });
    const { runtime, calls } = makeRuntime(async (workflow) => {
      await gate;
      return successExecution(workflow);
    });
    const scheduler = createScheduler(store, runtime, { now: () => NOW });

    const first = scheduler.tick();
    expect(scheduler.status().ticking).toBe(true);
    // 第二轮在串行锁里应被忽略：既不加调用，也不改 lastTickAt
    const tickedAt = scheduler.status().lastTickAt;
    await scheduler.tick();
    expect(calls).toHaveLength(1);
    expect(scheduler.status().lastTickAt).toBe(tickedAt);

    release();
    await first;
    expect(scheduler.status().ticking).toBe(false);
  });
});

// ---------------------------------------------------------------------------
// 启动错过不补跑
// ---------------------------------------------------------------------------

describe("启动时错过不补跑", () => {
  it("启动把「已经到点」的 lastRunAt 推到 now，不立刻执行；未到点的不动", () => {
    makeWorkflow({ id: "wf-missed", lastRunAt: NOW - 7 * DAY, intervalSeconds: 60 });
    makeWorkflow({ id: "wf-future", lastRunAt: NOW - SECOND, intervalSeconds: 60 });
    const { runtime, calls } = makeRuntime();
    const scheduler = createScheduler(store, runtime, { now: () => NOW, intervalMs: 60_000 });

    scheduler.start();
    try {
      expect(calls).toHaveLength(0);
      expect(store.getWorkflow("wf-missed")?.lastRunAt).toBe(NOW);
      expect(store.getWorkflow("wf-future")?.lastRunAt).toBe(NOW - SECOND);
      expect(scheduler.status().running).toBe(true);
    } finally {
      scheduler.stop();
    }
  });

  it("启动后第一个 tick 也不会补跑（顺延后下一个周期未到）", async () => {
    makeWorkflow({ id: "wf-missed", lastRunAt: NOW - 7 * DAY, intervalSeconds: 60 });
    const { runtime, calls } = makeRuntime();
    const scheduler = createScheduler(store, runtime, { now: () => NOW, intervalMs: 60_000 });

    scheduler.start();
    try {
      await scheduler.tick();
      expect(calls).toHaveLength(0);
    } finally {
      scheduler.stop();
    }
  });
});

// ---------------------------------------------------------------------------
// 自动轮询
// ---------------------------------------------------------------------------

describe("自动轮询", () => {
  it("start 后由定时器触发 tick；stop 后不再轮询", async () => {
    makeDueWorkflow("wf-auto");
    const { runtime, calls } = makeRuntime();
    const clock = { value: NOW };
    const scheduler = createScheduler(store, runtime, {
      now: () => clock.value,
      intervalMs: 10,
    });

    vi.useFakeTimers();
    try {
      scheduler.start();
      // start 会把「已经到点」的 lastRunAt 顺延到 NOW；把时钟推过一个周期再让定时器 tick
      clock.value = NOW + 61 * SECOND;
      await vi.advanceTimersByTimeAsync(11);
      expect(scheduler.status().lastTickAt).toBe(NOW + 61 * SECOND);
      expect(calls).toHaveLength(1);
      expect(store.getWorkflow("wf-auto")?.lastRunAt).toBe(NOW + 61 * SECOND);

      scheduler.stop();
      clock.value = NOW + 5 * MINUTE;
      await vi.advanceTimersByTimeAsync(100);
      // 定时器已清掉：即使时间前进、工作流又到点，也不会有新的 tick
      expect(scheduler.status().lastTickAt).toBe(NOW + 61 * SECOND);
      expect(calls).toHaveLength(1);
    } finally {
      scheduler.stop();
      vi.useRealTimers();
    }
  });
});

// ---------------------------------------------------------------------------
// 失败通知与容错
// ---------------------------------------------------------------------------

describe("失败通知与容错", () => {
  it("执行失败写通知（标题带工作流名与错误消息），onExecution 仍被调用", async () => {
    makeWorkflow({ id: "wf-fail", name: "日报同步", lastRunAt: NOW - 5 * MINUTE, intervalSeconds: 60 });
    const seen: Array<{ execution: WorkflowExecution; workflow: Workflow }> = [];
    const { runtime } = makeRuntime(async (workflow) => failedExecution(workflow, "节点炸了"));
    const scheduler = createScheduler(store, runtime, {
      now: () => NOW,
      onExecution: (execution, workflow) => seen.push({ execution, workflow }),
    });

    await scheduler.tick();

    const notifications = store.listNotifications(5);
    expect(notifications).toHaveLength(1);
    expect(notifications[0]?.title).toContain("日报同步");
    expect(notifications[0]?.title).toContain("失败");
    expect(notifications[0]?.title).toContain("节点炸了");
    expect(notifications[0]?.body).toContain("HTTP 请求");
    expect(notifications[0]?.workflowId).toBe("wf-fail");
    expect(seen).toHaveLength(1);
    expect(seen[0]?.workflow.id).toBe("wf-fail");
    expect(store.getWorkflow("wf-fail")?.lastRunAt).toBe(NOW);
  });

  it("runtime 直接抛错：不冒泡、写通知、lastRunAt 仍推进（避免每 15 秒刷屏重试）", async () => {
    makeDueWorkflow("wf-throw");
    const { runtime } = makeRuntime(async () => {
      throw new Error("引擎崩了");
    });
    const scheduler = createScheduler(store, runtime, { now: () => NOW });

    await expect(scheduler.tick()).resolves.toBeUndefined();

    const notifications = store.listNotifications(5);
    expect(notifications).toHaveLength(1);
    expect(notifications[0]?.title).toContain("引擎崩了");
    expect(notifications[0]?.workflowId).toBe("wf-throw");
    expect(store.getWorkflow("wf-throw")?.lastRunAt).toBe(NOW);
  });

  it("onExecution 回调抛错不影响调度（其余工作流照常跑）", async () => {
    makeWorkflow({ id: "wf-1", lastRunAt: NOW - 9 * MINUTE, intervalSeconds: 60 });
    makeWorkflow({ id: "wf-2", lastRunAt: NOW - 5 * MINUTE, intervalSeconds: 60 });
    const { runtime, calls } = makeRuntime();
    const errorSpy = vi.spyOn(console, "error").mockImplementation(() => {});
    try {
      const scheduler = createScheduler(store, runtime, {
        now: () => NOW,
        onExecution: () => {
          throw new Error("订阅方炸了");
        },
      });

      await expect(scheduler.tick()).resolves.toBeUndefined();
      expect(calls).toHaveLength(2);
    } finally {
      errorSpy.mockRestore();
    }
  });

  it("手动运行正在占用同一条工作流时跳过，且不把 lastRunAt 误记成已跑", async () => {
    const workflow = makeDueWorkflow("wf-busy");
    const runWorkflow = vi.fn(async (candidate: Workflow) => successExecution(candidate));
    const runtime: Runtime = {
      runWorkflow,
      getLiveExecution: () => undefined,
      isRunning: () => true,
      stop: () => false,
    };
    const scheduler = createScheduler(store, runtime, { now: () => NOW });

    await scheduler.tick();

    expect(runWorkflow).not.toHaveBeenCalled();
    expect(store.getWorkflow(workflow.id)?.lastRunAt).toBe(NOW - 5 * MINUTE);
  });
});
