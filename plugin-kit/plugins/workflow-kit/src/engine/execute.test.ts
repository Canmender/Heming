import { beforeEach, describe, expect, it, vi } from "vitest";
import { executeWorkflow, type EngineDeps, type EngineEvent, type ExecuteOptions } from "./index.js";
import { nextScheduleRun } from "./schedule.js";
import {
  connect,
  item,
  items,
  makeNode,
  makeWorkflow,
  outputItems,
  registerFakeNode,
  registerFakeTrigger,
  resetNodeRegistry,
  runCount,
} from "./testSupport.js";
import type {
  HttpRequestOptions,
  HttpResponse,
  Item,
  NodeExecutionContext,
  SubWorkflowParams,
  SubWorkflowResult,
  UserCodeRunner,
  Workflow,
  WorkflowExecution,
} from "../types.js";

beforeEach(() => {
  resetNodeRegistry();
});

/** 通用假触发器：把手动触发数据原样作为输出（模拟「手动触发」节点）。 */
function registerTrigger(type = "fakeTrigger"): void {
  registerFakeTrigger(type, async (context: NodeExecutionContext) => context.getInputData(0));
}

function run(workflow: Workflow, options: Omit<ExecuteOptions, "workflow"> = {}) {
  return executeWorkflow({ workflow, ...options });
}

function makeChildExecution(overrides: Partial<WorkflowExecution> = {}): WorkflowExecution {
  return {
    id: "exec-child",
    workflowId: "wf-child",
    workflowName: "子流程",
    mode: "subworkflow",
    status: "success",
    startedAt: 0,
    runData: {},
    ...overrides,
  };
}

// ---------------------------------------------------------------------------
// 基本语义：顺序 / 分支 / 合并
// ---------------------------------------------------------------------------

describe("执行顺序与记录", () => {
  it("沿连接顺序执行，记录 source、数据与触发信息", async () => {
    registerTrigger();
    registerFakeNode("addStep", async (context: NodeExecutionContext) =>
      context.getInputData(0).map((entry) => ({
        json: { ...entry.json, step: Number(entry.json.step ?? 0) + 1 },
      })),
    );
    const workflow = makeWorkflow({
      nodes: [
        makeNode("t", "fakeTrigger", { position: { x: 0, y: 0 } }),
        makeNode("a", "addStep", { position: { x: 100, y: 0 } }),
        makeNode("b", "addStep", { position: { x: 200, y: 0 } }),
      ],
    });
    connect(workflow, "t", "a");
    connect(workflow, "a", "b");

    const execution = await run(workflow, { triggerData: [item({ n: 1 })] });

    expect(execution.status).toBe("success");
    expect(execution.triggerNodeId).toBe("t");
    expect(execution.triggerData).toEqual([item({ n: 1 })]);
    expect(Object.keys(execution.runData)).toEqual(["t", "a", "b"]);
    expect(execution.runData.t?.[0]?.source).toEqual([{}]);
    expect(execution.runData.a?.[0]?.source).toEqual([{ previousNode: "t" }]);
    expect(execution.runData.b?.[0]?.source).toEqual([{ previousNode: "a" }]);
    expect(execution.runData.b?.[0]?.data?.main[0]?.[0]?.json).toEqual({ n: 1, step: 2 });
    expect(execution.runData.b?.[0]?.itemsTotal).toBe(1);
    expect(execution.finishedAt).toBeGreaterThanOrEqual(execution.startedAt);
    expect(execution.durationMs).toBeGreaterThanOrEqual(0);
  });

  it("同一工作流同一输入的执行顺序确定（事件顺序可复现）", async () => {
    registerTrigger();
    registerFakeNode("pass", async (context) => context.getInputData(0));
    const workflow = makeWorkflow({
      nodes: [
        makeNode("t", "fakeTrigger"),
        makeNode("a", "pass", { position: { x: 100, y: 0 } }),
        makeNode("b", "pass", { position: { x: 200, y: 0 } }),
      ],
    });
    connect(workflow, "t", "a");
    connect(workflow, "a", "b");

    const orderOf = async (): Promise<string[]> => {
      const order: string[] = [];
      const execution = await run(workflow, {
        triggerData: [item()],
        onEvent: (event) => {
          if (event.type === "nodeStart") order.push(event.nodeId);
        },
      });
      expect(execution.status).toBe("success");
      return order;
    };

    expect(await orderOf()).toEqual(["t", "a", "b"]);
    expect(await orderOf()).toEqual(["t", "a", "b"]);
  });

  it("分支节点只调度有 items 的输出口", async () => {
    registerTrigger();
    registerFakeNode(
      "branch",
      async (context: NodeExecutionContext) => {
        const go = context.getInputData(0)[0]?.json.go === true;
        return go
          ? ([[item({ branch: "yes" })], []] as Item[][])
          : ([[], [item({ branch: "no" })]] as Item[][]);
      },
      { description: { outputs: 2 } },
    );
    registerFakeNode("pass", async (context) => context.getInputData(0));

    const workflow = makeWorkflow({
      nodes: [
        makeNode("t", "fakeTrigger"),
        makeNode("branch", "branch", { position: { x: 100, y: 0 } }),
        makeNode("yes", "pass", { position: { x: 200, y: -50 } }),
        makeNode("no", "pass", { position: { x: 200, y: 50 } }),
      ],
    });
    connect(workflow, "t", "branch");
    connect(workflow, "branch", "yes", 0);
    connect(workflow, "branch", "no", 1);

    const yesRun = await run(workflow, { triggerData: [item({ go: true })] });
    expect(yesRun.status).toBe("success");
    expect(runCount(yesRun, "yes")).toBe(1);
    expect(runCount(yesRun, "no")).toBe(0);

    const noRun = await run(workflow, { triggerData: [item({ go: false })] });
    expect(noRun.status).toBe("success");
    expect(runCount(noRun, "yes")).toBe(0);
    expect(runCount(noRun, "no")).toBe(1);
  });

  it("双输入节点等两个输入口都就绪后只运行一次，输入按上游画布位置拼接", async () => {
    registerTrigger();
    registerFakeNode("sourceA", async () => items({ from: "a", i: 1 }, { from: "a", i: 2 }));
    registerFakeNode("sourceB", async () => items({ from: "b", i: 1 }));
    registerFakeNode(
      "merger",
      async (context: NodeExecutionContext) => [
        {
          json: {
            first: context.getInputData(0).map((entry) => entry.json),
            second: context.getInputData(1).map((entry) => entry.json),
          },
        },
      ],
      { description: { inputs: 2 } },
    );

    const workflow = makeWorkflow({
      nodes: [
        makeNode("t", "fakeTrigger"),
        makeNode("a", "sourceA", { position: { x: 100, y: 0 } }),
        makeNode("b", "sourceB", { position: { x: 200, y: 0 } }),
        makeNode("merge", "merger", { position: { x: 300, y: 0 } }),
      ],
    });
    connect(workflow, "t", "a");
    connect(workflow, "t", "b");
    connect(workflow, "a", "merge", 0, 0);
    connect(workflow, "b", "merge", 0, 1);

    const execution = await run(workflow, { triggerData: [item({ seed: true })] });

    expect(execution.status).toBe("success");
    expect(runCount(execution, "merge")).toBe(1);
    expect(outputItems(execution, "merge")[0]?.json).toEqual({
      first: [
        { from: "a", i: 1 },
        { from: "a", i: 2 },
      ],
      second: [{ from: "b", i: 1 }],
    });
  });

  it("同一输入口的多根上游线按上游画布位置依次拼接（§5.2）", async () => {
    registerTrigger();
    registerFakeNode("sourceA", async () => items({ from: "a" }));
    registerFakeNode("sourceB", async () => items({ from: "b" }));
    const observed: Item[][] = [];
    registerFakeNode("collector", async (context: NodeExecutionContext) => {
      observed.push(context.getInputData(0));
      return context.getInputData(0);
    });

    const workflow = makeWorkflow({
      nodes: [
        makeNode("t", "fakeTrigger"),
        // B 在画布上更靠左，所以哪怕 A 先声明，拼接顺序也应是 B、A
        makeNode("b", "sourceB", { position: { x: 100, y: 0 } }),
        makeNode("a", "sourceA", { position: { x: 200, y: 0 } }),
        makeNode("collector", "collector", { position: { x: 300, y: 0 } }),
      ],
    });
    connect(workflow, "t", "a");
    connect(workflow, "t", "b");
    connect(workflow, "a", "collector", 0, 0);
    connect(workflow, "b", "collector", 0, 0);

    const execution = await run(workflow, { triggerData: [item()] });

    expect(execution.status).toBe("success");
    // collector 每条上游到达都会跑一次；最后一次应拿到「B 在前、A 在后」的拼接结果。
    const last = observed[observed.length - 1] ?? [];
    expect(last.map((entry) => entry.json.from)).toEqual(["b", "a"]);
  });
});

// ---------------------------------------------------------------------------
// 重试与三种 onError
// ---------------------------------------------------------------------------

describe("节点级重试", () => {
  it("失败若干次后成功：只落一条成功记录，中间尝试不可见", async () => {
    registerTrigger();
    let attempts = 0;
    registerFakeNode("flaky", async () => {
      attempts += 1;
      if (attempts < 3) throw new Error(`第 ${attempts} 次失败`);
      return items({ ok: true });
    });
    registerFakeNode("after", async (context) => context.getInputData(0));

    const workflow = makeWorkflow({
      nodes: [
        makeNode("t", "fakeTrigger"),
        makeNode("flaky", "flaky", {
          position: { x: 100, y: 0 },
          retryOnFail: true,
          maxTries: 3,
          waitBetweenTries: 0,
        }),
        makeNode("after", "after", { position: { x: 200, y: 0 } }),
      ],
    });
    connect(workflow, "t", "flaky");
    connect(workflow, "flaky", "after");

    const execution = await run(workflow, { triggerData: [item()] });

    expect(attempts).toBe(3);
    expect(execution.status).toBe("success");
    expect(runCount(execution, "flaky")).toBe(1);
    expect(execution.runData.flaky?.[0]?.status).toBe("success");
    expect(runCount(execution, "after")).toBe(1);
  });

  it("重试耗尽 → stopWorkflow：只记最终错误，下游不执行", async () => {
    registerTrigger();
    let attempts = 0;
    registerFakeNode("alwaysFail", async () => {
      attempts += 1;
      throw new Error("总是失败");
    });
    registerFakeNode("after", async () => items({ ran: true }));

    const workflow = makeWorkflow({
      nodes: [
        makeNode("t", "fakeTrigger"),
        makeNode("bad", "alwaysFail", {
          position: { x: 100, y: 0 },
          retryOnFail: true,
          maxTries: 2,
          waitBetweenTries: 0,
        }),
        makeNode("after", "after", { position: { x: 200, y: 0 } }),
      ],
    });
    connect(workflow, "t", "bad");
    connect(workflow, "bad", "after");

    const execution = await run(workflow, { triggerData: [item()] });

    expect(attempts).toBe(2);
    expect(execution.status).toBe("error");
    expect(runCount(execution, "bad")).toBe(1);
    expect(execution.runData.bad?.[0]?.status).toBe("error");
    expect(execution.runData.bad?.[0]?.error?.message).toBe("总是失败");
    expect(runCount(execution, "after")).toBe(0);
    expect(execution.error?.nodeId).toBe("bad");
  });
});

describe("onError 三态", () => {
  it("stopWorkflow（默认）：整条执行置 error，保留已产生的记录", async () => {
    registerTrigger();
    registerFakeNode("good", async () => items({ ok: true }));
    registerFakeNode("bad", async () => {
      throw new Error("炸了");
    });
    registerFakeNode("after", async () => items({ ran: true }));

    const workflow = makeWorkflow({
      nodes: [
        makeNode("t", "fakeTrigger"),
        makeNode("good", "good", { position: { x: 100, y: 0 } }),
        makeNode("bad", "bad", { position: { x: 200, y: 0 } }),
        makeNode("after", "after", { position: { x: 300, y: 0 } }),
      ],
    });
    connect(workflow, "t", "good");
    connect(workflow, "good", "bad");
    connect(workflow, "bad", "after");

    const execution = await run(workflow, { triggerData: [item()] });

    expect(execution.status).toBe("error");
    expect(execution.error?.message).toBe("炸了");
    expect(runCount(execution, "good")).toBe(1);
    expect(runCount(execution, "bad")).toBe(1);
    expect(runCount(execution, "after")).toBe(0);
    // 已产生的 runData 保留（CONTRACT §5.5 stopWorkflow）
    expect(execution.runData.good?.[0]?.data?.main[0]?.[0]?.json).toEqual({ ok: true });
  });

  it("continueRegularOutput：输入原样透传给下游，执行继续", async () => {
    registerTrigger();
    registerFakeNode("bad", async () => {
      throw new Error("软失败");
    });
    registerFakeNode("after", async (context) => context.getInputData(0));

    const workflow = makeWorkflow({
      nodes: [
        makeNode("t", "fakeTrigger"),
        makeNode("bad", "bad", { position: { x: 100, y: 0 }, onError: "continueRegularOutput" }),
        makeNode("after", "after", { position: { x: 200, y: 0 } }),
      ],
    });
    connect(workflow, "t", "bad");
    connect(workflow, "bad", "after");

    const execution = await run(workflow, { triggerData: [item({ id: 9 })] });

    expect(execution.status).toBe("success");
    expect(runCount(execution, "bad")).toBe(1);
    expect(execution.runData.bad?.[0]?.status).toBe("error");
    expect(execution.runData.bad?.[0]?.error?.message).toBe("软失败");
    // 记录里保留透传输出，下游拿到的就是节点输入
    expect(outputItems(execution, "bad")[0]?.json).toEqual({ id: 9 });
    expect(outputItems(execution, "after")[0]?.json).toEqual({ id: 9 });
  });

  it("continueErrorOutput：错误项切到最后一个输出口，成功口为空", async () => {
    registerTrigger();
    registerFakeNode(
      "risky",
      async () => {
        throw new Error("boom");
      },
      { description: { outputs: 2 } },
    );
    registerFakeNode("okPath", async () => items({ ok: true }));
    registerFakeNode("errorPath", async (context) => context.getInputData(0));

    const workflow = makeWorkflow({
      nodes: [
        makeNode("t", "fakeTrigger"),
        makeNode("risky", "risky", { position: { x: 100, y: 0 }, onError: "continueErrorOutput" }),
        makeNode("okPath", "okPath", { position: { x: 200, y: -50 } }),
        makeNode("errorPath", "errorPath", { position: { x: 200, y: 50 } }),
      ],
    });
    connect(workflow, "t", "risky");
    connect(workflow, "risky", "okPath", 0);
    connect(workflow, "risky", "errorPath", 1);

    const execution = await run(workflow, { triggerData: [item({ id: 7 })] });

    expect(execution.status).toBe("success");
    expect(execution.runData.risky?.[0]?.status).toBe("error");
    expect(execution.runData.risky?.[0]?.data?.main[0]).toEqual([]);
    expect(execution.runData.risky?.[0]?.data?.main[1]?.[0]?.json).toEqual({
      id: 7,
      error: "boom",
    });
    expect(runCount(execution, "okPath")).toBe(0);
    expect(runCount(execution, "errorPath")).toBe(1);
    expect(outputItems(execution, "errorPath")[0]?.json).toEqual({ id: 7, error: "boom" });
    expect(outputItems(execution, "errorPath")[0]?.pairedItem).toEqual({ item: 0 });
  });
});

// ---------------------------------------------------------------------------
// 回环 / 预算 / 取消
// ---------------------------------------------------------------------------

describe("回环与预算", () => {
  it("无限回环被执行次数上限兜住，不挂起", async () => {
    registerTrigger();
    registerFakeNode("loopA", async () => items({ a: true }));
    registerFakeNode("loopB", async () => items({ b: true }));

    const workflow = makeWorkflow({
      nodes: [
        makeNode("t", "fakeTrigger"),
        makeNode("a", "loopA", { position: { x: 100, y: 0 } }),
        makeNode("b", "loopB", { position: { x: 200, y: 0 } }),
      ],
    });
    connect(workflow, "t", "a");
    connect(workflow, "a", "b");
    connect(workflow, "b", "a");

    const execution = await run(workflow, { triggerData: [item()] });

    expect(execution.status).toBe("error");
    expect(execution.error?.message).toContain("执行次数超过上限");
    // 触发节点 1 次 + 循环节点共 500 次运行
    expect(runCount(execution, "a") + runCount(execution, "b")).toBe(499);
    expect(runCount(execution, "t")).toBe(1);
  });

  it("执行时长超限：按 maxExecutionMs 失败（假时钟）", async () => {
    registerTrigger();
    registerFakeNode("pass", async () => items());
    const workflow = makeWorkflow({
      nodes: [makeNode("t", "fakeTrigger"), makeNode("a", "pass", { position: { x: 100, y: 0 } })],
    });
    connect(workflow, "t", "a");

    let clock = 0;
    const execution = await run(workflow, {
      triggerData: [item()],
      deps: {
        // 每次读时间都跨过 11 分钟 → 必超 10 分钟上限
        now: () => {
          const value = clock;
          clock += 11 * 60 * 1000;
          return value;
        },
      },
    });

    expect(execution.status).toBe("error");
    expect(execution.error?.message).toContain("执行超时");
    expect(runCount(execution, "a")).toBe(0);
  });

  it("分别注入 now()：同一工作流两次执行的 startedAt 可预期", async () => {
    registerTrigger();
    const workflow = makeWorkflow({ nodes: [makeNode("t", "fakeTrigger")] });
    const first = await run(workflow, { triggerData: [item()], deps: { now: () => 1000 } });
    const second = await run(workflow, { triggerData: [item()], deps: { now: () => 2000 } });
    expect(first.startedAt).toBe(1000);
    expect(second.startedAt).toBe(2000);
    expect(first.durationMs).toBe(0);
  });
});

describe("取消", () => {
  it("已经取消的信号：不执行任何节点，状态 canceled", async () => {
    registerTrigger();
    registerFakeNode("pass", async () => items({ ran: true }));
    const workflow = makeWorkflow({
      nodes: [makeNode("t", "fakeTrigger"), makeNode("a", "pass", { position: { x: 100, y: 0 } })],
    });
    connect(workflow, "t", "a");

    const controller = new AbortController();
    controller.abort();
    const execution = await run(workflow, {
      triggerData: [item()],
      abortSignal: controller.signal,
    });

    expect(execution.status).toBe("canceled");
    expect(execution.error?.message).toContain("取消");
    expect(Object.keys(execution.runData)).toEqual([]);
  });

  it("节点等待中被取消：helpers.sleep 可中断，下游不再执行", async () => {
    registerTrigger();
    registerFakeNode("waiter", async (context: NodeExecutionContext) => {
      await context.helpers.sleep(500, context.abortSignal);
      return items({ woke: true });
    });
    registerFakeNode("after", async () => items({ ran: true }));

    const workflow = makeWorkflow({
      nodes: [
        makeNode("t", "fakeTrigger"),
        makeNode("wait", "waiter", { position: { x: 100, y: 0 } }),
        makeNode("after", "after", { position: { x: 200, y: 0 } }),
      ],
    });
    connect(workflow, "t", "wait");
    connect(workflow, "wait", "after");

    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), 10);
    try {
      const execution = await run(workflow, {
        triggerData: [item()],
        abortSignal: controller.signal,
      });
      expect(execution.status).toBe("canceled");
      expect(runCount(execution, "after")).toBe(0);
    } finally {
      clearTimeout(timer);
    }
  });

  it("执行中（节点完成后）取消：后续节点不再调度", async () => {
    registerTrigger();
    const controller = new AbortController();
    registerFakeNode("first", async () => {
      // 节点执行期间触发取消：主循环应在调度下游前看到 abort
      controller.abort();
      return items({ first: true });
    });
    registerFakeNode("after", async () => items({ ran: true }));

    const workflow = makeWorkflow({
      nodes: [
        makeNode("t", "fakeTrigger"),
        makeNode("first", "first", { position: { x: 100, y: 0 } }),
        makeNode("after", "after", { position: { x: 200, y: 0 } }),
      ],
    });
    connect(workflow, "t", "first");
    connect(workflow, "first", "after");

    const execution = await run(workflow, {
      triggerData: [item()],
      abortSignal: controller.signal,
    });

    expect(execution.status).toBe("canceled");
    expect(runCount(execution, "after")).toBe(0);
  });
});

// ---------------------------------------------------------------------------
// pinData / 部分执行 / executeOnce / alwaysOutputData
// ---------------------------------------------------------------------------

describe("pinData 与部分执行", () => {
  it("pinData：不执行节点，直接用固定输出，并记一条成功记录", async () => {
    registerTrigger();
    const pinnedExecute = vi.fn(async () => items({ should: "not run" }));
    registerFakeNode("pinned", pinnedExecute);
    registerFakeNode("after", async (context) => context.getInputData(0));

    const workflow = makeWorkflow({
      nodes: [
        makeNode("t", "fakeTrigger"),
        makeNode("pinned", "pinned", {
          position: { x: 100, y: 0 },
          pinData: [item({ pinned: true })],
        }),
        makeNode("after", "after", { position: { x: 200, y: 0 } }),
      ],
    });
    connect(workflow, "t", "pinned");
    connect(workflow, "pinned", "after");

    const execution = await run(workflow, { triggerData: [item()] });

    expect(pinnedExecute).not.toHaveBeenCalled();
    expect(execution.status).toBe("success");
    expect(runCount(execution, "pinned")).toBe(1);
    expect(outputItems(execution, "pinned")[0]?.json).toEqual({ pinned: true });
    expect(outputItems(execution, "after")[0]?.json).toEqual({ pinned: true });
  });

  it("startNodeId：从指定节点开始并接收调用方给的输入，上游不执行", async () => {
    registerTrigger();
    registerFakeNode("pass", async (context) => context.getInputData(0));
    const workflow = makeWorkflow({
      nodes: [
        makeNode("t", "fakeTrigger"),
        makeNode("a", "pass", { position: { x: 100, y: 0 } }),
        makeNode("b", "pass", { position: { x: 200, y: 0 } }),
        makeNode("c", "pass", { position: { x: 300, y: 0 } }),
      ],
    });
    connect(workflow, "t", "a");
    connect(workflow, "a", "b");
    connect(workflow, "b", "c");

    const execution = await run(workflow, {
      startNodeId: "b",
      inputData: { main: [[item({ start: true })]] },
    });

    expect(execution.mode).toBe("partial");
    expect(Object.keys(execution.runData)).toEqual(["b", "c"]);
    expect(outputItems(execution, "b")[0]?.json).toEqual({ start: true });
    expect(runCount(execution, "c")).toBe(1);
  });

  it("destinationNodeId：目标节点完成后停止，不再调度下游", async () => {
    registerTrigger();
    registerFakeNode("pass", async (context) => context.getInputData(0));
    const workflow = makeWorkflow({
      nodes: [
        makeNode("t", "fakeTrigger"),
        makeNode("a", "pass", { position: { x: 100, y: 0 } }),
        makeNode("b", "pass", { position: { x: 200, y: 0 } }),
        makeNode("c", "pass", { position: { x: 300, y: 0 } }),
      ],
    });
    connect(workflow, "t", "a");
    connect(workflow, "a", "b");
    connect(workflow, "b", "c");

    const execution = await run(workflow, {
      startNodeId: "a",
      destinationNodeId: "b",
      inputData: { main: [[item({ start: true })]] },
    });

    expect(execution.status).toBe("success");
    expect(Object.keys(execution.runData)).toEqual(["a", "b"]);
    expect(runCount(execution, "c")).toBe(0);
  });

  it("部分执行起点/终点找不到时报结构化错误", async () => {
    registerTrigger();
    const workflow = makeWorkflow({ nodes: [makeNode("t", "fakeTrigger")] });
    const missingStart = await run(workflow, { startNodeId: "不存在" });
    expect(missingStart.status).toBe("error");
    expect(missingStart.error?.message).toContain("找不到部分执行的起点节点");

    const missingDest = await run(workflow, { destinationNodeId: "不存在" });
    expect(missingDest.status).toBe("error");
    expect(missingDest.error?.message).toContain("找不到部分执行的终点节点");
  });

  it("executeOnce：同一节点在回环里只运行一次", async () => {
    registerTrigger();
    registerFakeNode("once", async () => items({ once: true }));
    registerFakeNode("loop", async () => items({ loop: true }));
    const workflow = makeWorkflow({
      nodes: [
        makeNode("t", "fakeTrigger"),
        makeNode("a", "once", { position: { x: 100, y: 0 }, executeOnce: true }),
        makeNode("b", "loop", { position: { x: 200, y: 0 } }),
      ],
    });
    connect(workflow, "t", "a");
    connect(workflow, "a", "b");
    connect(workflow, "b", "a");

    const execution = await run(workflow, { triggerData: [item()] });

    expect(execution.status).toBe("success");
    expect(runCount(execution, "a")).toBe(1);
    expect(runCount(execution, "b")).toBe(1);
  });

  it("alwaysOutputData：没数据也塞一条空 item，让下游能跑", async () => {
    registerTrigger();
    registerFakeNode("empty", async () => []);
    registerFakeNode("after", async (context) => context.getInputData(0));
    const workflow = makeWorkflow({
      nodes: [
        makeNode("t", "fakeTrigger"),
        makeNode("empty", "empty", { position: { x: 100, y: 0 }, alwaysOutputData: true }),
        makeNode("after", "after", { position: { x: 200, y: 0 } }),
      ],
    });
    connect(workflow, "t", "empty");
    connect(workflow, "empty", "after");

    const execution = await run(workflow, { triggerData: [item()] });

    expect(execution.status).toBe("success");
    expect(outputItems(execution, "empty")).toEqual([item()]);
    expect(runCount(execution, "after")).toBe(1);
  });

  it("禁用的节点不执行，输入透传给下游", async () => {
    registerTrigger();
    const disabledExecute = vi.fn(async () => items({ ran: true }));
    registerFakeNode("disabledNode", disabledExecute);
    registerFakeNode("after", async (context) => context.getInputData(0));

    const workflow = makeWorkflow({
      nodes: [
        makeNode("t", "fakeTrigger"),
        makeNode("skip", "disabledNode", { position: { x: 100, y: 0 }, disabled: true }),
        makeNode("after", "after", { position: { x: 200, y: 0 } }),
      ],
    });
    connect(workflow, "t", "skip");
    connect(workflow, "skip", "after");

    const execution = await run(workflow, { triggerData: [item({ pass: true })] });

    expect(execution.status).toBe("success");
    expect(disabledExecute).not.toHaveBeenCalled();
    expect(runCount(execution, "skip")).toBe(0);
    expect(outputItems(execution, "after")[0]?.json).toEqual({ pass: true });
  });
});

// ---------------------------------------------------------------------------
// 依赖注入：子流程 / HTTP / 代码 / 静态数据
// ---------------------------------------------------------------------------

describe("依赖注入", () => {
  it("子流程节点通过 helpers.executeSubWorkflow 调用注入的执行器，父执行 id 传下去", async () => {
    registerTrigger();
    registerFakeNode("subCaller", async (context: NodeExecutionContext) => {
      const runner = context.helpers.executeSubWorkflow;
      if (!runner) throw new Error("没有注入 executeSubWorkflow");
      const result = await runner({
        workflowId: "wf-child",
        mode: "subworkflow",
        parentExecutionId: context.executionId,
        inputData: context.getInputData(0),
      });
      return result.output;
    });
    const executeSubWorkflow = vi.fn(
      async (_params: SubWorkflowParams): Promise<SubWorkflowResult> => ({
        execution: makeChildExecution(),
        output: items({ fromChild: true }),
      }),
    );
    const workflow = makeWorkflow({
      nodes: [makeNode("t", "fakeTrigger"), makeNode("sub", "subCaller", { position: { x: 100, y: 0 } })],
    });
    connect(workflow, "t", "sub");

    const execution = await run(workflow, {
      triggerData: [item({ q: 1 })],
      deps: { executeSubWorkflow },
    });

    expect(execution.status).toBe("success");
    expect(executeSubWorkflow).toHaveBeenCalledTimes(1);
    const params = executeSubWorkflow.mock.calls[0]?.[0];
    expect(params?.workflowId).toBe("wf-child");
    expect(params?.mode).toBe("subworkflow");
    expect(params?.parentExecutionId).toBe(execution.id);
    expect(params?.inputData[0]?.json).toEqual({ q: 1 });
    expect(outputItems(execution, "sub")[0]?.json).toEqual({ fromChild: true });
  });

  it("子流程失败按本节点失败处理（走 onError）", async () => {
    registerTrigger();
    registerFakeNode("subCaller", async (context: NodeExecutionContext) => {
      const runner = context.helpers.executeSubWorkflow;
      if (!runner) throw new Error("没有注入 executeSubWorkflow");
      const result = await runner({
        workflowId: "wf-child",
        mode: "subworkflow",
        parentExecutionId: context.executionId,
        inputData: context.getInputData(0),
      });
      return result.output;
    });
    const executeSubWorkflow = vi.fn(async (): Promise<SubWorkflowResult> => {
      throw new Error("子流程失败");
    });
    registerFakeNode("pass", async (context) => context.getInputData(0));
    const workflow = makeWorkflow({
      nodes: [
        makeNode("t", "fakeTrigger"),
        makeNode("sub", "subCaller", { position: { x: 100, y: 0 }, onError: "continueRegularOutput" }),
        makeNode("after", "pass", { position: { x: 200, y: 0 } }),
      ],
    });
    connect(workflow, "t", "sub");
    connect(workflow, "sub", "after");

    const execution = await run(workflow, {
      triggerData: [item()],
      deps: { executeSubWorkflow },
    });

    // 子流程失败 + continueRegularOutput → 父执行继续，记录节点失败
    expect(execution.status).toBe("success");
    expect(execution.runData.sub?.[0]?.status).toBe("error");
    expect(execution.runData.sub?.[0]?.error?.message).toContain("子流程失败");
  });

  it("helpers.httpRequest / helpers.runUserCode 原样透传", async () => {
    registerTrigger();
    const httpRequest = vi.fn(
      async (_options: HttpRequestOptions): Promise<HttpResponse> => ({
        statusCode: 200,
        headers: {},
        body: { ok: true },
      }),
    );
    const runUserCode: UserCodeRunner = async () => [{ json: { fromSandbox: true } }];
    registerFakeNode("httpLike", async (context: NodeExecutionContext) => {
      const response = await context.helpers.httpRequest({ method: "GET", url: "https://example.com" });
      return items({ status: response.statusCode });
    });
    registerFakeNode("codeLike", async (context: NodeExecutionContext) => {
      const runner = context.helpers.runUserCode;
      if (!runner) throw new Error("没有注入 runUserCode");
      const result = await runner({
        code: "return 1",
        mode: "runOnceForAllItems",
        items: context.getInputData(0),
      });
      return [{ json: { result } }];
    });
    const workflow = makeWorkflow({
      nodes: [
        makeNode("t", "fakeTrigger"),
        makeNode("http", "httpLike", { position: { x: 100, y: 0 } }),
        makeNode("code", "codeLike", { position: { x: 200, y: 0 } }),
      ],
    });
    connect(workflow, "t", "http");
    connect(workflow, "http", "code");

    const execution = await run(workflow, { triggerData: [item()], deps: { httpRequest, runUserCode } });

    expect(execution.status).toBe("success");
    expect(httpRequest).toHaveBeenCalledTimes(1);
    expect(outputItems(execution, "http")[0]?.json).toEqual({ status: 200 });
    expect(outputItems(execution, "code")[0]?.json).toEqual({
      result: [{ json: { fromSandbox: true } }],
    });
  });

  it("没有注入 HTTP 能力时给可读错误", async () => {
    registerTrigger();
    registerFakeNode("httpLike", async (context: NodeExecutionContext) => {
      const response = await context.helpers.httpRequest({ method: "GET", url: "https://example.com" });
      return items({ status: response.statusCode });
    });
    const workflow = makeWorkflow({
      nodes: [makeNode("t", "fakeTrigger"), makeNode("http", "httpLike", { position: { x: 100, y: 0 } })],
    });
    connect(workflow, "t", "http");

    const execution = await run(workflow, { triggerData: [item()] });
    expect(execution.status).toBe("error");
    expect(execution.error?.message).toContain("没有注入 HTTP 能力");
  });

  it("注入 StaticDataProvider 时静态数据跨执行保留", async () => {
    registerTrigger();
    const globalData: Record<string, unknown> = { count: 0 };
    registerFakeNode("counter", async (context: NodeExecutionContext) => {
      const data = context.getWorkflowStaticData("global");
      data.count = Number(data.count ?? 0) + 1;
      return items({ count: data.count });
    });
    const workflow = makeWorkflow({
      nodes: [makeNode("t", "fakeTrigger"), makeNode("c", "counter", { position: { x: 100, y: 0 } })],
    });
    connect(workflow, "t", "c");
    const deps: EngineDeps = {
      staticData: {
        getWorkflowStaticData: () => globalData,
        getNodeStaticData: () => ({}),
      },
    };

    const first = await run(workflow, { triggerData: [item()], deps });
    const second = await run(workflow, { triggerData: [item()], deps });

    expect(outputItems(first, "c")[0]?.json).toEqual({ count: 1 });
    expect(outputItems(second, "c")[0]?.json).toEqual({ count: 2 });
  });
});

// ---------------------------------------------------------------------------
// 错误工作流
// ---------------------------------------------------------------------------

describe("错误工作流", () => {
  it("执行失败后以 mode=error 调子流程执行器，输入是错误上下文 items", async () => {
    registerTrigger();
    registerFakeNode("boom", async () => {
      throw new Error("节点炸了");
    });
    const executeSubWorkflow = vi.fn(
      async (_params: SubWorkflowParams): Promise<SubWorkflowResult> => ({
        execution: makeChildExecution({ id: "exec-error-wf", mode: "error", status: "success" }),
        output: [],
      }),
    );
    const workflow = makeWorkflow({
      settings: { errorWorkflowId: "wf-error" },
      nodes: [makeNode("t", "fakeTrigger"), makeNode("bad", "boom", { position: { x: 100, y: 0 } })],
    });
    connect(workflow, "t", "bad");

    const execution = await run(workflow, {
      triggerData: [item()],
      deps: { executeSubWorkflow },
    });

    expect(execution.status).toBe("error");
    expect(execution.error?.message).toBe("节点炸了");
    expect(executeSubWorkflow).toHaveBeenCalledTimes(1);
    const params = executeSubWorkflow.mock.calls[0]?.[0];
    expect(params?.workflowId).toBe("wf-error");
    expect(params?.mode).toBe("error");
    expect(params?.parentExecutionId).toBe(execution.id);
    const context = params?.inputData[0]?.json as {
      execution: { id: string; status: string };
      workflow: { id: string; name: string };
      error: { message: string };
    };
    expect(context.execution.id).toBe(execution.id);
    expect(context.execution.status).toBe("error");
    expect(context.workflow.id).toBe(workflow.id);
    expect(context.error.message).toBe("节点炸了");
  });

  it("错误工作流自己失败不覆盖原错误", async () => {
    registerTrigger();
    registerFakeNode("boom", async () => {
      throw new Error("原始错误");
    });
    const executeSubWorkflow = vi.fn(
      async (): Promise<SubWorkflowResult> => ({
        execution: makeChildExecution({ id: "exec-error-wf", mode: "error", status: "error" }),
        output: [],
      }),
    );
    const workflow = makeWorkflow({
      settings: { errorWorkflowId: "wf-error" },
      nodes: [makeNode("t", "fakeTrigger"), makeNode("bad", "boom", { position: { x: 100, y: 0 } })],
    });
    connect(workflow, "t", "bad");

    const execution = await run(workflow, {
      triggerData: [item()],
      deps: { executeSubWorkflow },
    });

    expect(execution.status).toBe("error");
    expect(execution.error?.message).toBe("原始错误");
    expect(executeSubWorkflow).toHaveBeenCalledTimes(1);
  });

  it("mode=error 的执行不再套娃触发错误工作流", async () => {
    registerTrigger();
    registerFakeNode("boom", async () => {
      throw new Error("错误工作流自己失败");
    });
    const executeSubWorkflow = vi.fn(async (): Promise<SubWorkflowResult> => ({
      execution: makeChildExecution(),
      output: [],
    }));
    const workflow = makeWorkflow({
      settings: { errorWorkflowId: "wf-error" },
      nodes: [makeNode("t", "fakeTrigger"), makeNode("bad", "boom", { position: { x: 100, y: 0 } })],
    });
    connect(workflow, "t", "bad");

    const execution = await run(workflow, {
      mode: "error",
      triggerData: [item()],
      deps: { executeSubWorkflow },
    });

    expect(execution.status).toBe("error");
    expect(executeSubWorkflow).not.toHaveBeenCalled();
  });
});

// ---------------------------------------------------------------------------
// 记录裁剪 / 事件 / 起点异常
// ---------------------------------------------------------------------------

describe("执行记录与事件", () => {
  it("saveDataSuccessExecution=none：成功执行不保存节点数据，但保留记录", async () => {
    registerTrigger();
    registerFakeNode("pass", async (context) => context.getInputData(0));
    const workflow = makeWorkflow({
      settings: { saveDataSuccessExecution: "none" },
      nodes: [makeNode("t", "fakeTrigger"), makeNode("a", "pass", { position: { x: 100, y: 0 } })],
    });
    connect(workflow, "t", "a");

    const execution = await run(workflow, { triggerData: [item({ keep: false })] });

    expect(execution.status).toBe("success");
    expect(Object.keys(execution.runData)).toEqual(["t", "a"]);
    expect(execution.runData.t?.[0]?.data).toBeUndefined();
    expect(execution.runData.a?.[0]?.data).toBeUndefined();
    expect(execution.runData.a?.[0]?.itemsTotal).toBe(1);
  });

  it("进度事件：executionStart → nodeStart/nodeFinish → executionFinish，executionIndex 全局递增", async () => {
    registerTrigger();
    registerFakeNode("pass", async (context) => context.getInputData(0));
    const workflow = makeWorkflow({
      nodes: [makeNode("t", "fakeTrigger"), makeNode("a", "pass", { position: { x: 100, y: 0 } })],
    });
    connect(workflow, "t", "a");

    const events: EngineEvent[] = [];
    const execution = await run(workflow, {
      triggerData: [item()],
      onEvent: (event) => events.push(event),
    });

    expect(events[0]?.type).toBe("executionStart");
    expect(events[events.length - 1]?.type).toBe("executionFinish");

    const starts = events.filter((event) => event.type === "nodeStart");
    const finishes = events.filter((event) => event.type === "nodeFinish");
    expect(starts.map((event) => event.nodeId)).toEqual(["t", "a"]);
    expect(finishes.map((event) => event.nodeId)).toEqual(["t", "a"]);
    expect(starts.map((event) => event.executionIndex)).toEqual([0, 1]);
    const firstFinish = finishes[0];
    expect(firstFinish?.status).toBe("success");
    expect(firstFinish?.itemsTotal).toBe(1);
    const finishEvent = events[events.length - 1];
    if (finishEvent?.type === "executionFinish") {
      expect(finishEvent.execution.id).toBe(execution.id);
      expect(finishEvent.execution.status).toBe("success");
    }
  });

  it("onEvent 回调抛错不影响执行", async () => {
    registerTrigger();
    registerFakeNode("pass", async (context) => context.getInputData(0));
    const workflow = makeWorkflow({
      nodes: [makeNode("t", "fakeTrigger"), makeNode("a", "pass", { position: { x: 100, y: 0 } })],
    });
    connect(workflow, "t", "a");

    const execution = await run(workflow, {
      triggerData: [item()],
      onEvent: () => {
        throw new Error("UI 挂了");
      },
    });

    expect(execution.status).toBe("success");
    expect(runCount(execution, "a")).toBe(1);
  });

  it("未知节点类型：结构化失败，不抛异常", async () => {
    registerTrigger();
    const workflow = makeWorkflow({
      nodes: [makeNode("t", "fakeTrigger"), makeNode("unknown", "不存在的类型", { position: { x: 100, y: 0 } })],
    });
    connect(workflow, "t", "unknown");

    const execution = await run(workflow, { triggerData: [item()] });

    expect(execution.status).toBe("error");
    expect(execution.error?.message).toContain("未知的节点类型");
    expect(execution.runData.unknown?.[0]?.status).toBe("error");
  });

  it("没有触发器且未指定起点：结构化失败并给出人话说明", async () => {
    registerFakeNode("pass", async () => items());
    const workflow = makeWorkflow({ nodes: [makeNode("a", "pass")] });

    const execution = await run(workflow);

    expect(execution.status).toBe("error");
    expect(execution.error?.message).toContain("没有触发器节点");
    expect(execution.error?.description).toContain("触发节点");
  });

  it("畸形工作流（未归一的导入数据）不抛异常，返回错误记录", async () => {
    // 故意漏掉 nodes/connections/settings：executeWorkflow 的兜底应把它收敛成执行记录
    const broken = { id: "wf-broken", name: "坏工作流" } as unknown as Workflow;
    const execution = await executeWorkflow({ workflow: broken });
    expect(execution.status).toBe("error");
    expect(execution.workflowId).toBe("wf-broken");
    expect(execution.error).toBeDefined();
  });

  it("表达式求值失败算该节点失败（带节点信息）", async () => {
    registerTrigger();
    registerFakeNode("pass", async (context) => context.getInputData(0));
    const workflow = makeWorkflow({
      nodes: [
        makeNode("t", "fakeTrigger"),
        makeNode("a", "pass", {
          position: { x: 100, y: 0 },
          parameters: { value: "{{ $json.missing.deep }}" },
        }),
      ],
    });
    connect(workflow, "t", "a");

    const execution = await run(workflow, { triggerData: [item()] });

    expect(execution.status).toBe("error");
    expect(execution.runData.a?.[0]?.status).toBe("error");
    expect(execution.runData.a?.[0]?.error?.nodeId).toBe("a");
  });
});

// ---------------------------------------------------------------------------
// 调度计算（引擎侧只暴露纯函数；调度循环在 wf-shell）
// ---------------------------------------------------------------------------

describe("nextScheduleRun 与执行引擎协作", () => {
  it("没有 schedule 触发器时返回 null（不会排期）", () => {
    registerTrigger();
    const workflow = makeWorkflow({ nodes: [makeNode("t", "fakeTrigger")] });
    expect(nextScheduleRun(workflow, new Date(0))).toBeNull();
  });
});
