import { describe, expect, it } from "vitest";
import {
  applySaveDataPolicy,
  buildNodeRunData,
  countItems,
  createExecutionRecord,
  finalizeExecution,
  normalizeNodeResult,
  sanitizeOutputData,
  trimOutputDataForRecord,
} from "./runData.js";
import { item } from "./testSupport.js";
import { WORKFLOW_LIMITS, type NodeOutputData, type WorkflowSettings } from "../types.js";

function settings(overrides: Partial<WorkflowSettings> = {}): WorkflowSettings {
  return {
    timezone: "local",
    saveDataSuccessExecution: "all",
    saveDataErrorExecution: "all",
    saveManualExecutions: true,
    callerPolicy: "any",
    ...overrides,
  };
}

describe("normalizeNodeResult", () => {
  it("Item[] → 一个输出口", () => {
    const output = normalizeNodeResult([item({ a: 1 })]);
    expect(output.main).toHaveLength(1);
    expect(output.main[0]?.[0]?.json).toEqual({ a: 1 });
  });

  it("Item[][] → 多个输出口（契约 §5.3 的二维形状）", () => {
    const output = normalizeNodeResult([[item({ branch: "true" })], [item({ branch: "false" })]]);
    expect(output.main).toHaveLength(2);
    expect(output.main[0]?.[0]?.json).toEqual({ branch: "true" });
    expect(output.main[1]?.[0]?.json).toEqual({ branch: "false" });
  });

  it("{main} 原样，undefined → 空 main", () => {
    const raw: NodeOutputData = { main: [[item()]] };
    expect(normalizeNodeResult(raw)).toEqual(raw);
    expect(normalizeNodeResult(undefined)).toEqual({ main: [] });
  });

  it("sanitizeOutputData 把畸形输出口补成空数组", () => {
    expect(sanitizeOutputData({ main: [[item()], undefined as never] })).toEqual({
      main: [[item()], []],
    });
  });
});

describe("countItems", () => {
  it("累加所有输出口", () => {
    expect(countItems({ main: [[item(), item()], [item()]] })).toBe(3);
    expect(countItems(undefined)).toBe(0);
  });
});

describe("trimOutputDataForRecord", () => {
  it("每个输出口最多保留 maxItemsPerNodeRun 条", () => {
    const output: NodeOutputData = {
      main: [Array.from({ length: 5 }, () => item()), Array.from({ length: 2 }, () => item())],
    };
    const trimmed = trimOutputDataForRecord(output, 3);
    expect(trimmed?.main[0]).toHaveLength(3);
    expect(trimmed?.main[1]).toHaveLength(2);
  });

  it("默认上限来自 WORKFLOW_LIMITS", () => {
    const output: NodeOutputData = {
      main: [Array.from({ length: WORKFLOW_LIMITS.maxItemsPerNodeRun + 10 }, () => item())],
    };
    expect(trimOutputDataForRecord(output)?.main[0]).toHaveLength(
      WORKFLOW_LIMITS.maxItemsPerNodeRun,
    );
  });

  it("超大二进制丢掉内容并留说明，其余字段保留", () => {
    const big: NodeOutputData = {
      main: [
        [
          {
            json: { ok: true },
            binary: {
              file: {
                data: "A".repeat(WORKFLOW_LIMITS.maxBinaryBytes + 1),
                mimeType: "application/pdf",
                fileName: "合同.pdf",
              },
            },
          },
        ],
      ],
    };
    const trimmed = trimOutputDataForRecord(big);
    const binary = trimmed?.main[0]?.[0]?.binary?.file;
    expect(binary?.data).toBe("");
    expect(binary?.mimeType).toBe("application/pdf");
    expect(binary?.fileName).toContain("合同.pdf");
    expect(binary?.fileName).toContain("超过");
  });

  it("未超限的二进制原样保留", () => {
    const output: NodeOutputData = {
      main: [[{ json: {}, binary: { f: { data: "QUJD", mimeType: "text/plain" } } }]],
    };
    expect(trimOutputDataForRecord(output)?.main[0]?.[0]?.binary?.f?.data).toBe("QUJD");
  });
});

describe("执行记录构建", () => {
  it("createExecutionRecord：初始状态 new、runData 为空对象、带上父执行与触发数据", () => {
    const execution = createExecutionRecord({
      workflow: { id: "wf-1", name: "测试" },
      mode: "manual",
      executionId: "exec-1",
      now: 1000,
      parentExecutionId: "exec-parent",
      triggerNodeId: "trigger",
      triggerData: [item({ x: 1 })],
    });
    expect(execution).toMatchObject({
      id: "exec-1",
      workflowId: "wf-1",
      workflowName: "测试",
      mode: "manual",
      status: "new",
      startedAt: 1000,
      parentExecutionId: "exec-parent",
      triggerNodeId: "trigger",
    });
    expect(execution.runData).toEqual({});
    expect(execution.triggerData).toHaveLength(1);
  });

  it("buildNodeRunData：source 记上游、itemsTotal 是截断前条数、data 已裁剪", () => {
    const output: NodeOutputData = {
      main: [Array.from({ length: WORKFLOW_LIMITS.maxItemsPerNodeRun + 5 }, () => item())],
    };
    const run = buildNodeRunData({
      startTime: 100,
      executionTime: 40,
      executionIndex: 7,
      sourceNodeId: "upstream",
      status: "success",
      output,
      itemsTotal: output.main[0]?.length ?? 0,
    });
    expect(run.source).toEqual([{ previousNode: "upstream" }]);
    expect(run.executionIndex).toBe(7);
    expect(run.executionTime).toBe(40);
    expect(run.itemsTotal).toBe(WORKFLOW_LIMITS.maxItemsPerNodeRun + 5);
    expect(run.data?.main[0]).toHaveLength(WORKFLOW_LIMITS.maxItemsPerNodeRun);
  });

  it("buildNodeRunData：起点节点 source 是 [{}]", () => {
    const run = buildNodeRunData({
      startTime: 0,
      executionTime: 0,
      executionIndex: 0,
      status: "error",
      itemsTotal: 0,
      error: { message: "失败" },
    });
    expect(run.source).toEqual([{}]);
    expect(run.data).toBeUndefined();
    expect(run.error?.message).toBe("失败");
  });

  it("finalizeExecution：写终态/结束时间/耗时/错误", () => {
    const execution = createExecutionRecord({
      workflow: { id: "wf-1", name: "测试" },
      mode: "manual",
      executionId: "exec-1",
      now: 1000,
    });
    finalizeExecution(execution, "error", 1600, { message: "炸了" });
    expect(execution.status).toBe("error");
    expect(execution.finishedAt).toBe(1600);
    expect(execution.durationMs).toBe(600);
    expect(execution.error?.message).toBe("炸了");
  });
});

describe("applySaveDataPolicy", () => {
  function executionWithRun() {
    const execution = createExecutionRecord({
      workflow: { id: "wf", name: "测试" },
      mode: "manual",
      executionId: "e",
      now: 0,
    });
    execution.runData.a = [
      buildNodeRunData({
        startTime: 0,
        executionTime: 1,
        executionIndex: 0,
        status: "success",
        output: { main: [[item({ a: 1 })]] },
        itemsTotal: 1,
      }),
    ];
    return execution;
  }

  it("成功执行 + 不保存数据：删 data、保留记录与错误", () => {
    const execution = executionWithRun();
    finalizeExecution(execution, "success", 1);
    applySaveDataPolicy(execution, settings({ saveDataSuccessExecution: "none" }));
    expect(execution.runData.a).toHaveLength(1);
    expect(execution.runData.a?.[0]?.data).toBeUndefined();
  });

  it("成功执行 + 保存数据：不动", () => {
    const execution = executionWithRun();
    finalizeExecution(execution, "success", 1);
    applySaveDataPolicy(execution, settings({ saveDataSuccessExecution: "all" }));
    expect(execution.runData.a?.[0]?.data).toBeDefined();
  });

  it("失败执行看 saveDataErrorExecution；取消按失败口径", () => {
    const failed = executionWithRun();
    finalizeExecution(failed, "error", 1, { message: "x" });
    applySaveDataPolicy(failed, settings({ saveDataErrorExecution: "none" }));
    expect(failed.runData.a?.[0]?.data).toBeUndefined();

    const canceled = executionWithRun();
    finalizeExecution(canceled, "canceled", 1, { message: "c" });
    applySaveDataPolicy(canceled, settings({ saveDataErrorExecution: "none" }));
    expect(canceled.runData.a?.[0]?.data).toBeUndefined();
  });
});
