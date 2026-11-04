import { beforeEach, describe, expect, it } from "vitest";
import { createMemoryStorage } from "../memory/storage.js";
import { useNotificationStore } from "../../store/notifications.js";
import type { StorageLike } from "../memory/types.js";
import {
  MAX_STEPS,
  MAX_TASKS,
  TASKS_KEY,
  TASK_EXPORT_VERSION,
  TASK_STALE_MS,
  buildTaskJson,
  buildTaskReport,
  formatDuration,
  markStaleTasks,
  pruneTasks,
  readTasks,
  setTaskStorage,
  taskStats,
  taskForkNotice,
  taskTitle,
  useTaskStore,
  type TaskRecord,
} from "./store.js";

let storage: StorageLike;

beforeEach(() => {
  storage = createMemoryStorage();
  setTaskStorage(storage);
  useTaskStore.setState({ tasks: [] });
});

function makeTask(overrides: Partial<TaskRecord> = {}): TaskRecord {
  const now = 1_700_000_000_000;
  return {
    id: `t-${Math.random().toString(36).slice(2, 8)}`,
    conversationId: "c1",
    agentId: "a1",
    agentName: "和小鸣",
    title: "梳理模块依赖",
    prompt: "梳理 packages/web 的模块依赖",
    status: "running",
    createdAt: now,
    updatedAt: now,
    steps: [],
    ...overrides,
  };
}

describe("taskTitle / formatDuration", () => {
  it("取首个非空行并压平空白", () => {
    expect(taskTitle("  第一行  \n第二行")).toBe("第一行");
    expect(taskTitle("\n\n   ")).toBe("未命名任务");
  });

  it("超长标题按码点截断并加省略号", () => {
    const long = "任".repeat(80);
    const title = taskTitle(long);
    expect([...title]).toHaveLength(60);
    expect(title.endsWith("…")).toBe(true);
  });

  it("时长格式", () => {
    expect(formatDuration(12_000)).toBe("12 秒");
    expect(formatDuration(65_000)).toBe("1 分 5 秒");
    expect(formatDuration(3_900_000)).toBe("1 时 5 分");
    expect(formatDuration(-1)).toBe("—");
  });
});

describe("useTaskStore 生命周期", () => {
  it("建档 → 步骤开始/结束 → 收尾，并落盘可读回", () => {
    const id = useTaskStore.getState().create({
      conversationId: "c1",
      agentId: "a1",
      agentName: "和小鸣",
      prompt: "查一下构建失败的原因",
      now: 1000,
    });
    expect(useTaskStore.getState().tasks[0]).toMatchObject({
      id,
      title: "查一下构建失败的原因",
      status: "running",
      steps: [],
    });

    useTaskStore.getState().bindStream(id, "s1");
    useTaskStore.getState().stepStart(id, {
      id: "tool-1",
      name: "srv__search",
      args: '{"q":"build"}',
      now: 1100,
    });
    useTaskStore.getState().stepEnd(id, "tool-1", {
      status: "ok",
      result: "找到了",
      sources: [{ id: "wiki/build", title: "构建说明" }],
      now: 1200,
    });
    useTaskStore.getState().settle(id, { status: "done", result: "原因是缓存", now: 1300 });

    const task = useTaskStore.getState().tasks[0];
    expect(task.status).toBe("done");
    expect(task.streamId).toBe("s1");
    expect(task.result).toBe("原因是缓存");
    expect(task.endedAt).toBe(1300);
    expect(task.steps[0]).toMatchObject({ id: "tool-1", status: "ok", result: "找到了" });
    expect(task.steps[0].sources).toEqual([{ id: "wiki/build", title: "构建说明" }]);

    const restored = readTasks(storage);
    expect(restored).toHaveLength(1);
    expect(restored[0]).toMatchObject({ id, status: "done", result: "原因是缓存" });
  });

  it("settle 只对进行中生效：晚到的重复回调不覆盖已结束状态", () => {
    const id = useTaskStore.getState().create({
      conversationId: "c1",
      agentId: "a1",
      agentName: "和小鸣",
      prompt: "x",
      now: 1,
    });
    useTaskStore.getState().settle(id, { status: "done", result: "好", now: 2 });
    useTaskStore.getState().settle(id, { status: "failed", error: "晚了", now: 3 });
    expect(useTaskStore.getState().tasks[0]).toMatchObject({ status: "done", result: "好" });
    expect(useTaskStore.getState().tasks[0].error).toBeUndefined();
  });

  it("收尾时把仍「执行中」的步骤标成失败（流结束了不可能再有结果）", () => {
    const id = useTaskStore.getState().create({
      conversationId: "c1",
      agentId: "a1",
      agentName: "和小鸣",
      prompt: "x",
      now: 1,
    });
    useTaskStore.getState().stepStart(id, { id: "t1", name: "srv__x", args: "{}", now: 2 });
    useTaskStore.getState().settle(id, { status: "failed", error: "断线", now: 3 });
    expect(useTaskStore.getState().tasks[0].steps[0].status).toBe("error");
  });

  it("中断收尾把未完成步骤标为已拒绝（不是失败）", () => {
    const id = useTaskStore.getState().create({
      conversationId: "c1",
      agentId: "a1",
      agentName: "和小鸣",
      prompt: "x",
      now: 1,
    });
    useTaskStore.getState().stepStart(id, { id: "t1", name: "srv__x", args: "{}", now: 2 });
    useTaskStore.getState().settle(id, { status: "cancelled", now: 3 });
    expect(useTaskStore.getState().tasks[0].steps[0].status).toBe("denied");
  });

  it("reopen 把已结束任务拉回进行中并清掉终态字段", () => {
    const id = useTaskStore.getState().create({
      conversationId: "c1",
      agentId: "a1",
      agentName: "和小鸣",
      prompt: "x",
      now: 1,
    });
    useTaskStore.getState().settle(id, { status: "failed", error: "断线", now: 2 });
    useTaskStore.getState().reopen(id, 3);
    const task = useTaskStore.getState().tasks[0];
    expect(task.status).toBe("running");
    expect(task.error).toBeUndefined();
    expect(task.endedAt).toBeUndefined();
  });

  it("newest first + 删除/清空已结束", () => {
    const a = useTaskStore
      .getState()
      .create({ conversationId: "c1", agentId: "a1", agentName: "A", prompt: "旧", now: 1 });
    const b = useTaskStore
      .getState()
      .create({ conversationId: "c2", agentId: "a2", agentName: "B", prompt: "新", now: 2 });
    expect(useTaskStore.getState().tasks.map((t) => t.id)).toEqual([b, a]);

    useTaskStore.getState().settle(a, { status: "done", now: 3 });
    expect(useTaskStore.getState().clearFinished()).toBe(1);
    expect(useTaskStore.getState().tasks.map((t) => t.id)).toEqual([b]);

    useTaskStore.getState().remove(b);
    expect(useTaskStore.getState().tasks).toEqual([]);
    expect(readTasks(storage)).toEqual([]);
  });
});

describe("超时任务", () => {
  it("只有 running 且超时未刷新才置失败", () => {
    const stale = makeTask({ id: "old", updatedAt: 0 });
    const fresh = makeTask({ id: "new", updatedAt: TASK_STALE_MS });
    const done = makeTask({ id: "done", status: "done", updatedAt: 0 });
    const next = markStaleTasks([stale, fresh, done], TASK_STALE_MS + 1);
    expect(next[0].status).toBe("failed");
    expect(next[0].error).toContain("长时间无响应");
    expect(next[1]).toBe(fresh);
    expect(next[2]).toBe(done);
  });

  it("store.markStale 返回处理条数并落盘", () => {
    useTaskStore.setState({
      tasks: [
        makeTask({ id: "old", updatedAt: 0 }),
        makeTask({ id: "new", updatedAt: Date.now() }),
      ],
    });
    expect(useTaskStore.getState().markStale(TASK_STALE_MS + 1)).toBe(1);
    expect(useTaskStore.getState().tasks[0].status).toBe("failed");
  });
});

describe("pruneTasks 容量控制", () => {
  it("只保留最新 MAX_TASKS 条，且步骤只保留最新 MAX_STEPS 条", () => {
    const tasks = Array.from({ length: MAX_TASKS + 5 }, (_, i) =>
      makeTask({
        id: `t${i}`,
        createdAt: i,
        updatedAt: i,
        steps: Array.from({ length: MAX_STEPS + 3 }, (_, j) => ({
          id: `s${i}-${j}`,
          name: "n",
          args: "",
          status: "ok" as const,
          startedAt: j,
        })),
      }),
    );
    const { tasks: pruned } = pruneTasks(tasks);
    expect(pruned).toHaveLength(MAX_TASKS);
    expect(pruned[0].id).toBe(`t${MAX_TASKS + 4}`);
    expect(pruned[0].steps).toHaveLength(MAX_STEPS);
    expect(pruned[0].steps[0].id).toBe(`s${MAX_TASKS + 4}-3`);
  });

  it("超字节上限时淘汰最旧任务", () => {
    const tasks = Array.from({ length: 4 }, (_, i) =>
      makeTask({ id: `t${i}`, createdAt: i, prompt: "字".repeat(400) }),
    );
    const { tasks: pruned } = pruneTasks(tasks, 2500);
    expect(pruned.length).toBeLessThan(4);
    expect(pruned[0].id).toBe("t3");
  });

  /**
   * d.35 · P1-6：淘汰不再一刀切按创建时间。
   */
  it("条数超限时只摘已结束的，最早的 running 必须留下", () => {
    // 60 条已结束 + 1 条创建最早的 running = 61 条
    const ended = Array.from({ length: MAX_TASKS }, (_, i) =>
      makeTask({ id: `e${i}`, createdAt: 1_000 + i, status: "done" }),
    );
    const running = makeTask({ id: "run-old", createdAt: 1, status: "running" });

    const { tasks: pruned, droppedRunning } = pruneTasks([...ended, running]);

    expect(pruned).toHaveLength(MAX_TASKS);
    expect(pruned.some((t) => t.id === "run-old")).toBe(true); // 进行中仍在
    expect(pruned.some((t) => t.id === "e0")).toBe(false); // 最旧的已结束被摘
    expect(droppedRunning).toEqual([]); // 没动进行中 ⇒ 没有需要通知的
  });

  it("running 自己就超上限时摘最旧的，并放进 droppedRunning", () => {
    const tasks = Array.from({ length: MAX_TASKS + 1 }, (_, i) =>
      makeTask({ id: `r${i}`, createdAt: i, status: "running" }),
    );

    const { tasks: pruned, droppedRunning } = pruneTasks(tasks);

    expect(pruned).toHaveLength(MAX_TASKS);
    expect(pruned.some((t) => t.id === "r0")).toBe(false);
    expect(droppedRunning.map((t) => t.id)).toEqual(["r0"]);
  });

  it("字节超限时优先摘已结束的，进行中最后才动", () => {
    const running = makeTask({ id: "keep-run", createdAt: 9, status: "running", prompt: "字".repeat(400) });
    const ended = Array.from({ length: 3 }, (_, i) =>
      makeTask({ id: `old${i}`, createdAt: i, status: "done", prompt: "字".repeat(400) }),
    );

    const { tasks: pruned } = pruneTasks([running, ...ended], 2000);

    expect(pruned.some((t) => t.id === "keep-run")).toBe(true);
    expect(pruned.length).toBeLessThan(4);
  });

  it("被迫摘进行中时推一条通知（不静默丢）", () => {
    useNotificationStore.setState({ items: [] });
    // 先塞满 60 条 running，再 create 一条触发淘汰
    const full = Array.from({ length: MAX_TASKS }, (_, i) =>
      makeTask({ id: `r${i}`, createdAt: i, status: "running" }),
    );
    useTaskStore.setState({ tasks: full });

    useTaskStore.getState().create({
      conversationId: "c1",
      agentId: "a1",
      agentName: "和小鸣",
      prompt: "新任务",
      now: 10_000,
    });

    const notices = useNotificationStore.getState().items;
    const evicted = notices.filter((n) => n.key.startsWith("task-evicted:"));
    expect(evicted).toHaveLength(1);
    expect(evicted[0].title).toContain("任务记录被清理");
  });
});

describe("buildTaskReport · 失败原因说人话", () => {
  it("provider_error 原文翻成人话进 Markdown 报告（JSON 导出仍保留原文）", () => {
    const task = makeTask({
      status: "failed",
      error: 'provider_error: HTTP 429 {"error":{"message":"rate limit exceeded"}}',
    });
    const report = buildTaskReport(task);
    expect(report).toContain("## 失败原因");
    expect(report).toContain("HTTP 429");
    expect(report).not.toContain("rate_limit_error");
    expect(report).not.toContain("provider_error");
    // JSON 报告是排障用：原始 error 字段保留
    expect(JSON.stringify(buildTaskJson(task))).toContain("provider_error");
  });
});

describe("buildTaskReport", () => {
  it("包含目标/结果/步骤/来源，且同一记录输出稳定", () => {
    const task = makeTask({
      status: "done",
      createdAt: 1_700_000_000_000,
      endedAt: 1_700_000_065_000,
      result: "结论：先拆 mcp 桥",
      steps: [
        {
          id: "s1",
          name: "wiki__search",
          args: '{"q":"mcp"}',
          status: "ok",
          result: "命中 2 页",
          startedAt: 1_700_000_001_000,
          sources: [
            { id: "wiki/mcp", title: "MCP 说明" },
            { id: "wiki/mcp", title: "重复来源" },
          ],
        },
        {
          id: "s2",
          name: "srv__write",
          args: "{}",
          status: "denied",
          denyCause: "rule",
          startedAt: 1_700_000_002_000,
        },
      ],
    });
    const report = buildTaskReport(task);
    expect(report).toContain("# 任务：梳理模块依赖");
    expect(report).toContain("- 状态：已完成");
    expect(report).toContain("- 用时：1 分 5 秒");
    expect(report).toContain("## 目标");
    expect(report).toContain("## 结果");
    expect(report).toContain("结论：先拆 mcp 桥");
    expect(report).toContain("[已拒绝] srv__write");
    expect(report).toContain("命中记住的拒绝规则");
    expect(report).toContain("## 来源");
    expect(report).toContain("MCP 说明（wiki/mcp）");
    // 同一来源只出现一次
    expect(report.match(/MCP 说明/g)).toHaveLength(1);
    expect(report).toContain("仅保存在当前设备");
    expect(buildTaskReport(task)).toBe(report);
  });

  it("无结果/无工具时给明确占位，不输出空段", () => {
    const task = makeTask({ status: "failed", error: "断线", result: undefined });
    const report = buildTaskReport(task);
    expect(report).toContain("## 失败原因");
    expect(report).toContain("断线");
    expect(report).toContain("（无）");
    expect(report).toContain("（无工具调用）");
    expect(report).not.toContain("## 来源");
  });
});

describe("buildTaskJson", () => {
  it("导出带版本的结构化记录，步骤与去重来源齐全且输出稳定", () => {
    const task = makeTask({
      status: "done",
      streamId: "s1",
      result: "结论",
      endedAt: 1_700_000_002_500,
      steps: [
        {
          id: "s1",
          name: "wiki__search",
          args: '{"q":"mcp"}',
          status: "ok",
          result: "命中 2 页",
          startedAt: 1_700_000_001_000,
          endedAt: 1_700_000_002_000,
          sources: [
            { id: "wiki/mcp", title: "MCP 说明" },
            { id: "wiki/mcp", title: "重复来源" },
          ],
        },
        {
          id: "s2",
          name: "srv__write",
          args: "{}",
          status: "denied",
          denyCause: "rule",
          startedAt: 1_700_000_002_000,
        },
      ],
    });

    const raw = buildTaskJson(task);
    expect(buildTaskJson(task)).toBe(raw);

    const parsed = JSON.parse(raw) as {
      format: string;
      version: number;
      task: Record<string, unknown> & { steps: { id: string; sources?: unknown[] }[] };
      sources: { id: string; title: string }[];
    };
    expect(parsed.format).toBe("heming-task");
    expect(parsed.version).toBe(TASK_EXPORT_VERSION);
    expect(parsed.task).toMatchObject({
      id: task.id,
      conversationId: "c1",
      agentId: "a1",
      title: "梳理模块依赖",
      status: "done",
      result: "结论",
      endedAt: 1_700_000_002_500,
    });
    expect(parsed.task.steps.map((s) => s.id)).toEqual(["s1", "s2"]);
    expect(parsed.task.steps[1]).toMatchObject({ id: "s2", denyCause: "rule" });
    // 来源与 Markdown 报告同口径：同一 id 只出现一次
    expect(parsed.sources).toEqual([{ id: "wiki/mcp", title: "MCP 说明" }]);
  });

  it("缺省字段不输出，避免导出里出现一堆 undefined", () => {
    const parsed = JSON.parse(buildTaskJson(makeTask()));
    expect(parsed.task.streamId).toBeUndefined();
    expect(parsed.task.result).toBeUndefined();
    expect(parsed.task.error).toBeUndefined();
    expect(parsed.task.endedAt).toBeUndefined();
    expect(parsed.sources).toEqual([]);
  });
});

describe("taskStats / 水合", () => {
  it("统计状态、工具与去重来源", () => {
    const stats = taskStats([
      makeTask({
        status: "done",
        steps: [
          {
            id: "s1",
            name: "a",
            args: "",
            status: "ok",
            startedAt: 0,
            sources: [{ id: "wiki/x", title: "X" }],
          },
        ],
      }),
      makeTask({
        status: "failed",
        steps: [
          {
            id: "s2",
            name: "b",
            args: "",
            status: "ok",
            startedAt: 0,
            sources: [{ id: "wiki/x", title: "X" }],
          },
        ],
      }),
      makeTask({ status: "running" }),
    ]);
    expect(stats).toMatchObject({
      total: 3,
      running: 1,
      done: 1,
      failed: 1,
      cancelled: 0,
      tools: 2,
      sources: 1,
    });
  });

  it("损坏 JSON 回退空；结构不符的条目丢弃", () => {
    storage.setItem(TASKS_KEY, "坏 JSON");
    expect(readTasks(storage)).toEqual([]);

    storage.setItem(
      TASKS_KEY,
      JSON.stringify([
        { id: "ok", conversationId: "c1", agentId: "a1", prompt: "p", status: "done", createdAt: 1 },
        { id: 42, conversationId: "c1" },
      ]),
    );
    const list = readTasks(storage);
    expect(list).toHaveLength(1);
    expect(list[0]).toMatchObject({ id: "ok", title: "p", agentName: "a1" });
  });
});

describe("重跑 / 分叉：保留原任务（d.56）", () => {
  const now = 1_700_000_100_000;
  const step = { id: "s1", name: "srv__read", args: "{}", status: "ok" as const, startedAt: 1, endedAt: 2 };

  it("重跑新建任务；原任务的状态/步骤/结果/时间戳一个字都不变", () => {
    const origin = makeTask({
      id: "o1",
      status: "failed",
      streamId: "s-old",
      result: "半截结果",
      error: "断线",
      endedAt: 9,
      steps: [step],
    });
    useTaskStore.setState({ tasks: [origin] });
    const snapshot = JSON.stringify(origin);

    const newId = useTaskStore.getState().rerun("o1", now);

    expect(newId).toBeTruthy();
    const tasks = useTaskStore.getState().tasks;
    expect(tasks).toHaveLength(2);
    const created = tasks.find((t) => t.id === newId)!;
    // 继承目标/智能体/会话，但状态全新、没有分叉来源
    expect(created).toMatchObject({
      conversationId: "c1",
      agentId: "a1",
      agentName: "和小鸣",
      prompt: origin.prompt,
      status: "running",
      createdAt: now,
      steps: [],
    });
    expect(created.forkedFrom).toBeUndefined();
    // ★ 原任务不得被重跑改动（不 reopen、不追加步骤、不覆盖结果）
    expect(JSON.stringify(tasks.find((t) => t.id === "o1"))).toBe(snapshot);
  });

  it("分叉新建任务并记录来源；原任务不变", () => {
    const origin = makeTask({ id: "o2", status: "cancelled", streamId: "s1", steps: [step] });
    useTaskStore.setState({ tasks: [origin] });
    const snapshot = JSON.stringify(origin);

    const newId = useTaskStore.getState().forkFrom(
      "o2",
      { streamId: "s1", seq: 4, truncatedResults: 2 },
      now,
    )!;

    const created = useTaskStore.getState().tasks.find((t) => t.id === newId)!;
    expect(created.forkedFrom).toEqual({ streamId: "s1", seq: 4, truncatedResults: 2 });
    expect(created).toMatchObject({ status: "running", prompt: origin.prompt, agentId: "a1" });
    expect(JSON.stringify(useTaskStore.getState().tasks.find((t) => t.id === "o2"))).toBe(snapshot);
  });

  it("任务不存在时返回 null（不静默造一个任务）", () => {
    useTaskStore.setState({ tasks: [] });
    expect(useTaskStore.getState().rerun("missing", now)).toBeNull();
    expect(useTaskStore.getState().forkFrom("missing", { streamId: "s1", seq: 1 }, now)).toBeNull();
    expect(useTaskStore.getState().tasks).toEqual([]);
  });

  it("forkedFrom 落盘可水合：刷新后任务卡仍能说明来源与截断代价", () => {
    const origin = makeTask({ id: "o3", status: "cancelled", streamId: "s1" });
    useTaskStore.setState({ tasks: [origin] });
    useTaskStore.getState().forkFrom("o3", { streamId: "s1", seq: 4, truncatedResults: 1 }, now);

    const hydrated = readTasks(storage).find((t) => t.forkedFrom);
    expect(hydrated?.forkedFrom).toEqual({ streamId: "s1", seq: 4, truncatedResults: 1 });
    // 任务卡提示与分叉确认框同一份口径：重建 + 截断
    expect(taskForkNotice(hydrated!)).toContain("前缀由本机日志重建");
    expect(taskForkNotice(hydrated!)).toContain("结果不完整");
  });

  it("导出里带 forkedFrom；普通任务不带（不制造 undefined 字段）", () => {
    const forked = makeTask({ id: "o4", forkedFrom: { streamId: "s1", seq: 4 } });
    expect(JSON.parse(buildTaskJson(forked)).task.forkedFrom).toEqual({ streamId: "s1", seq: 4 });
    expect(JSON.parse(buildTaskJson(makeTask())).task.forkedFrom).toBeUndefined();
    expect(taskForkNotice(makeTask())).toBeNull();
  });
});
