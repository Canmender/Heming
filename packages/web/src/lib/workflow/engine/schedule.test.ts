import { beforeEach, describe, expect, it } from "vitest";
import { listScheduleTriggers, nextScheduleRun } from "./schedule.js";
import { makeNode, makeWorkflow, registerFakeNode, registerFakeTrigger, resetNodeRegistry } from "./testSupport.js";

/** 假定时触发器：按参数里的 `everyMs` 往后推。 */
function registerScheduleTrigger(type = "fakeScheduleTrigger"): void {
  registerFakeTrigger(
    type,
    async () => [],
    {
      description: { trigger: "schedule", isTrigger: true, inputs: 0 },
      getNextRun: (parameters, from) => {
        const everyMs = typeof parameters.everyMs === "number" ? parameters.everyMs : 60_000;
        return new Date(from.getTime() + everyMs);
      },
    },
  );
}

/** 假手动触发器（不是 schedule，不应参与计算）。 */
function registerManualTrigger(): void {
  registerFakeTrigger("fakeManualTrigger", async () => []);
}

describe("nextScheduleRun", () => {
  beforeEach(() => {
    resetNodeRegistry();
  });

  it("没有 schedule 触发器（只有手动触发器）→ null", () => {
    registerManualTrigger();
    const workflow = makeWorkflow({ nodes: [makeNode("t", "fakeManualTrigger")] });
    expect(nextScheduleRun(workflow, new Date(0))).toBeNull();
  });

  it("节点类型未注册 → null（不抛）", () => {
    const workflow = makeWorkflow({ nodes: [makeNode("t", "未注册触发器")] });
    expect(nextScheduleRun(workflow, new Date(0))).toBeNull();
  });

  it("按触发器 getNextRun 计算下一次", () => {
    registerScheduleTrigger();
    const workflow = makeWorkflow({
      nodes: [makeNode("t", "fakeScheduleTrigger", { parameters: { everyMs: 30_000 } })],
    });
    const from = new Date(2026, 0, 1, 9, 0, 0);
    expect(nextScheduleRun(workflow, from)?.getTime()).toBe(from.getTime() + 30_000);
  });

  it("多个 schedule 触发器取最左（x*10000+y），与 findTriggerNode 同口径", () => {
    registerScheduleTrigger();
    const workflow = makeWorkflow({
      nodes: [
        makeNode("right", "fakeScheduleTrigger", {
          position: { x: 400, y: 0 },
          parameters: { everyMs: 999 },
        }),
        makeNode("left", "fakeScheduleTrigger", {
          position: { x: 100, y: 0 },
          parameters: { everyMs: 1000 },
        }),
      ],
    });
    expect(listScheduleTriggers(workflow).map((node) => node.id)).toEqual(["left", "right"]);
    expect(nextScheduleRun(workflow, new Date(0))?.getTime()).toBe(1000);
  });

  it("禁用的触发器不算", () => {
    registerScheduleTrigger();
    const workflow = makeWorkflow({
      nodes: [
        makeNode("disabled", "fakeScheduleTrigger", {
          position: { x: 0, y: 0 },
          parameters: { everyMs: 500 },
          disabled: true,
        }),
        makeNode("enabled", "fakeScheduleTrigger", {
          position: { x: 100, y: 0 },
          parameters: { everyMs: 800 },
        }),
      ],
    });
    expect(nextScheduleRun(workflow, new Date(0))?.getTime()).toBe(800);
  });

  it("节点没有 getNextRun → null", () => {
    registerFakeTrigger("noNextRun", async () => [], {
      description: { trigger: "schedule", isTrigger: true, inputs: 0 },
    });
    const workflow = makeWorkflow({ nodes: [makeNode("t", "noNextRun")] });
    expect(nextScheduleRun(workflow, new Date(0))).toBeNull();
  });

  it("getNextRun 抛错或返回非法时间 → null（调度循环不能崩）", () => {
    registerFakeTrigger("brokenSchedule", async () => [], {
      description: { trigger: "schedule", isTrigger: true, inputs: 0 },
      getNextRun: () => {
        throw new Error("Cron 写错了");
      },
    });
    const broken = makeWorkflow({ nodes: [makeNode("t", "brokenSchedule")] });
    expect(nextScheduleRun(broken, new Date(0))).toBeNull();

    registerFakeTrigger("invalidSchedule", async () => [], {
      description: { trigger: "schedule", isTrigger: true, inputs: 0 },
      getNextRun: () => new Date(Number.NaN),
    });
    const invalid = makeWorkflow({ nodes: [makeNode("t", "invalidSchedule")] });
    expect(nextScheduleRun(invalid, new Date(0))).toBeNull();
  });

  it("getNextRun 返回 null 时透传 null", () => {
    registerFakeTrigger("nullSchedule", async () => [], {
      description: { trigger: "schedule", isTrigger: true, inputs: 0 },
      getNextRun: () => null,
    });
    const workflow = makeWorkflow({ nodes: [makeNode("t", "nullSchedule")] });
    expect(nextScheduleRun(workflow, new Date(0))).toBeNull();
  });

  it("普通非触发器节点即使注册了 getNextRun 也不算", () => {
    registerFakeNode("setLike", async () => [], {
      getNextRun: () => new Date(1234),
    });
    const workflow = makeWorkflow({ nodes: [makeNode("n", "setLike")] });
    expect(nextScheduleRun(workflow, new Date(0))).toBeNull();
  });
});
